// 2D vertical cross-section of the formicarium. Origin top-left, y grows down.
// Cells are AIR / SOIL / GRAIN. The ant farm "glass" is implicit — cells
// outside the grid are treated as solid in physics.

import type { RNG } from './rng';

export const CELL_AIR = 0;
export const CELL_SOIL = 1;
export const CELL_GRAIN = 2;

export type CellKind = 0 | 1 | 2;

/** Ticks per biological day. 1 tick ≈ 120 ms (see species.ts);
 *  under the 100× time-compression convention, an in-sim "day"
 *  plays out at 100× real speed, so 1 day biological = 14.4 min
 *  biological = 7,200 ticks. The day/night cycle is a modulo of
 *  world.tick by this constant. */
export const DAY_TICKS = 7200;

/**
 * Daylight intensity in [0, 1] for a given tick. 0 at midnight,
 * 1 at noon, sinusoidal-clamped between them so the transitions
 * around dawn (~6 a.m. biological) and dusk (~6 p.m.) span ~3
 * biological hours each rather than flipping instantly. Used to
 * gate diurnal forager activity (Gordon 1991: P. barbatus stops
 * foraging at sunset, resumes at dawn) and to modulate sky colour
 * in the renderer.
 *
 * Convention: tick=0 is solar midnight. timeOfDay = (tick / DAY_TICKS)
 * mod 1 in [0, 1); 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 *
 *   daylight(t) = max(0, -cos(2π · t / DAY_TICKS))
 */
export function daylight(tick: number): number {
  const phase = (tick % DAY_TICKS) / DAY_TICKS;
  return Math.max(0, -Math.cos(phase * Math.PI * 2));
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  /** Per-column y of the original natural surface (top-most soil at t=0). */
  readonly naturalSurface: Uint16Array;
  /** Per-column count of grain cells stacked above the natural surface. */
  readonly mound: Uint16Array;
  /** Per-cell hash noise for renderer texture. Deterministic from rng. */
  readonly soilNoise: Uint8Array;
  /** Per-cell move counter for GRAIN cells. Set when an ant deposits
   *  a grain (carryMoves + 1) and transferred between cells when the
   *  sandpile cascade slides the grain. Renderer uses it to lerp the
   *  GRAIN colour from undisturbed dark to weathered light: a grain
   *  that has been picked up and re-deposited many times has been
   *  "worked over" and reads visually paler. Zero in non-grain cells. */
  readonly grainMoves: Uint8Array;
  /** Per-cell food (seed) presence. 0 = none, 1 = a seed sits here.
   *  Surface seeds spawn stochastically on intact natural-surface
   *  rows; foragers pick them up and CARRY_FOOD ants deposit them
   *  into below-surface chambers (granaries). */
  readonly food: Uint8Array;
  /** Per-cell food move counter (mirrors grainMoves but for seeds).
   *  Set when an ant deposits a food item; transferred when an
   *  already-deposited food is picked up and re-deposited. Renderer
   *  uses it to lerp food colour from bright green (no moves) to
   *  dark green (moved many times). */
  readonly foodMoves: Uint8Array;
  /** Per-cell corpse marker. 0 = none, 1 = an ant died here. The
   *  body is a draggable item: necrophoresis workers (future) pick
   *  it up and haul it to a midden chamber. Until then the cell
   *  just renders as a dark spot so the viewer can see where the
   *  colony lost workers. Multiple corpses in the same cell are
   *  collapsed to a single marker (we don't track count). */
  readonly corpse: Uint8Array;
  /** Per-cell sprout marker. 0 = none, 1 = a stored seed germinated
   *  in place. Tschinkel (1999, "Self-Organization in Biological
   *  Systems") observed that uneaten seeds in P. badius granaries
   *  occasionally sprout. Visually a sprout reads as a small green
   *  shoot rising from a granary cell; it persists for a while and
   *  then either decays naturally or gets cleared by an ant that
   *  walks through. */
  readonly sprout: Uint8Array;
  /** Tick at which each cell's sprout last germinated. Renderer
   *  uses (world.tick - sproutTick[idx]) for the age-driven visual
   *  ramp; the sim uses it for natural decay back to AIR after
   *  species.sproutLifetimeTicks. */
  readonly sproutTick: Int32Array;
  /** Tick at which each cell was last carved (for "fresh dig" highlight). */
  readonly digTick: Int32Array;
  initialSoilCells = 0;
  /** Soil cells dug by traffic-driven wear and pulverised to dust
   *  rather than carried as grain. Tracked so the grain-conservation
   *  invariant `dug = grain + liveCarriers + wearLost` continues to
   *  hold. See ant-rules.ts wear handler. */
  wearLost = 0;
  /** Cumulative count of eggs that have hatched into adult workers.
   *  Increments on each STATE_EGG → STATE_WANDER transition. Used by
   *  the HUD to surface lifecycle activity (vs. snapshot population). */
  totalBorn = 0;
  /** Cumulative count of ant deaths from any cause (worker
   *  starvation, queen death, future necrophoresis triggers).
   *  Increments on every transition INTO STATE_DEAD. */
  totalDied = 0;
  /** Cumulative count of successful Sudd contact-trigger digs by
   *  direction (north/south/east/west of the digger). Used by the
   *  diag to surface dig-direction histograms — without this we
   *  can't tell whether the dirBonus / asymmetric-pheromone /
   *  geotaxis bias machinery is actually producing more vertical
   *  digs than lateral digs, or whether some unrelated bottleneck
   *  is keeping the architecture horizontal. Order: [N, S, E, W]. */
  readonly digsByDir = new Int32Array(4);
  /** Hard cap on the population-driven seed-clump rate, expressed
   *  as a count of equivalent worker ants. Each tick the colony's
   *  metabolic demand is computed live; the food rate is set to
   *  deliver 1.10× that demand, but no higher than `foodCap`
   *  workers' worth of demand. Initialised in main.ts to 10× the
   *  starting population. The user-facing knob is the original
   *  population (?ants= URL param). */
  foodCap = 0;
  /** Running fractional-seed accumulator for the clump rain. Each
   *  tick adds the dynamic target rate; whenever the total exceeds
   *  the clump size, a clump fires and the accumulator is debited
   *  by clumpSize. Persisted across saves so a tab refresh doesn't
   *  reset the food schedule. */
  clumpAccum = 0;
  tick = 0;
  /** Cached count of cells with food[i] > 0. Refreshed by the food
   *  spawn logic every ~200 ticks; used to throttle drops once
   *  supply outstrips consumption (otherwise seeds pile up on the
   *  surface, sprout, and turn the world green). Drift between
   *  refreshes is fine — the throttle is soft, not exact. */
  foodCountCached = 0;
  foodCountTick = -1;
  /** Cached count of columns whose natural-surface row (or one of
   *  the four cells immediately below it) is AIR — i.e. there's
   *  some open access to below-ground at this column. Refreshed
   *  every ~100 ticks by the ant-rules step. Used to gate the
   *  stranded-drill recovery rule: surface workers only drill
   *  fresh shafts when the WHOLE entrance system is sealed,
   *  preventing the cosmetic "random pits all over the surface"
   *  behaviour seen at the start of a run when the founding
   *  pinhole was the only shaft. */
  openShaftCount = 0;
  openShaftTick = -1;
  /** Decaying counter of recent successful CARRY_FOOD → granary
   *  deposits, used to model the Greene & Gordon (2007, PNAS 104(19):
   *  7973–7976) forager-rate feedback. Returning foragers antennate
   *  outgoing-bound workers at the entrance; the rate of antennations
   *  regulates the rate of new forager departures. Greene & Gordon
   *  showed experimentally that adding fake "returner" stimulation
   *  raised forager outflow even with no actual food. We model it
   *  globally rather than locally because (a) the colony-level effect
   *  is what dominates the literature and (b) a permeable global
   *  scalar is much cheaper than a contact-pheromone field.
   *
   *  Each successful food deposit pulses by +1; decay per tick is
   *  multiplicative so the EMA half-life is around a biological
   *  minute. The forage-roll multiplier in ant-rules saturates so a
   *  busy colony doesn't blow past the per-tick base rate by orders
   *  of magnitude. */
  foragerReturnRate = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint8Array(width * height);
    this.naturalSurface = new Uint16Array(width);
    this.mound = new Uint16Array(width);
    this.soilNoise = new Uint8Array(width * height);
    this.grainMoves = new Uint8Array(width * height);
    this.food = new Uint8Array(width * height);
    this.foodMoves = new Uint8Array(width * height);
    this.corpse = new Uint8Array(width * height);
    this.sprout = new Uint8Array(width * height);
    this.sproutTick = new Int32Array(width * height);
    this.sproutTick.fill(-1_000_000);
    this.digTick = new Int32Array(width * height);
    this.digTick.fill(-1_000_000);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /**
   * Generate a wavy soil surface and a small starter chamber at the centre.
   * The starter chamber is a trapezoid wider at top, so ants spawn into a
   * floor they can stand on.
   */
  generate(
    rng: RNG,
    surfaceRow: number,
    chamberHalfWidth: number,
    chamberDepth: number,
  ): void {
    const phase = rng.range(0, Math.PI * 2);
    const amp1 = Math.max(1, Math.floor(this.height * 0.015));
    const amp2 = Math.max(1, Math.floor(amp1 * 0.5));

    let soil = 0;
    for (let x = 0; x < this.width; x++) {
      const wave =
        Math.round(Math.sin(x * 0.07 + phase) * amp1) +
        Math.round(Math.sin(x * 0.21 + phase * 1.7) * amp2);
      const sy = Math.max(2, Math.min(this.height - 4, surfaceRow + wave));
      this.naturalSurface[x] = sy;
      for (let y = 0; y < this.height; y++) {
        if (y < sy) {
          this.cells[y * this.width + x] = CELL_AIR;
        } else {
          this.cells[y * this.width + x] = CELL_SOIL;
          soil++;
        }
      }
    }

    // Starter pinhole — modelled on the founding shaft a claustral
    // queen would dig: a single-column vertical tunnel a few cells
    // deep, terminating in a tiny pocket where she'd seal herself
    // in to raise her first brood. This is what a brand-new colony
    // looks like in nature; nothing chamber-shaped is pre-carved.
    // Architecture has to emerge from the agents.
    //   Hölldobler, B., & Wilson, E. O. (1990). The Ants. Belknap.
    //   Ch. 5: claustral colony founding.
    // chamberHalfWidth/chamberDepth args remain in the signature for
    // backwards compatibility with existing tests but are ignored.
    // At 3 mm/cell: shaft is 30 mm deep, pocket is 15 mm wide × 12 mm
    // tall — matches a real claustral founding chamber (Hölldobler &
    // Wilson 1990 Ch. 5). All values scale with cell size; physical
    // dimensions stay constant.
    const SHAFT_DEPTH = 10;
    const POCKET_HALF = 2; // 5-cell-wide pocket at the bottom
    const POCKET_HEIGHT = 4;
    const cx = this.width >> 1;
    const surfHere = this.naturalSurface[cx]!;
    // Vertical shaft, 1 cell wide.
    const shaftBottom = Math.min(this.height - 1, surfHere + SHAFT_DEPTH - 1);
    for (let y = surfHere; y <= shaftBottom; y++) {
      const idx = y * this.width + cx;
      if (this.cells[idx] === CELL_SOIL) {
        this.cells[idx] = CELL_AIR;
        soil--;
      }
    }
    // Terminal pocket directly below the shaft.
    const pocketTop = shaftBottom + 1;
    const pocketBot = Math.min(this.height - 1, pocketTop + POCKET_HEIGHT - 1);
    const px0 = Math.max(0, cx - POCKET_HALF);
    const px1 = Math.min(this.width - 1, cx + POCKET_HALF);
    for (let y = pocketTop; y <= pocketBot; y++) {
      for (let x = px0; x <= px1; x++) {
        const idx = y * this.width + x;
        if (this.cells[idx] === CELL_SOIL) {
          this.cells[idx] = CELL_AIR;
          soil--;
        }
      }
    }
    void chamberHalfWidth;
    void chamberDepth;

    for (let i = 0; i < this.soilNoise.length; i++) {
      this.soilNoise[i] = (rng.next() * 256) | 0;
    }
    this.initialSoilCells = soil;
  }

  countSoil(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL_SOIL) n++;
    }
    return n;
  }

  countGrains(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL_GRAIN) n++;
    }
    return n;
  }
}
