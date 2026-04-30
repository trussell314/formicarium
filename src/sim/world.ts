// 2D vertical cross-section of the formicarium. Origin top-left, y grows down.
// Cells are AIR / SOIL / GRAIN. The ant farm "glass" is implicit — cells
// outside the grid are treated as solid in physics.

import type { RNG } from './rng';

export const CELL_AIR = 0;
export const CELL_SOIL = 1;
export const CELL_GRAIN = 2;

/** Mature plant height in cells, indexed by plant kind. Index 0 is
 *  unused (kind 0 = no plant). At 3 mm/cell (the same world scale
 *  as the founding shaft) the heights below are calibrated to real
 *  *P. barbatus* habitat vegetation:
 *    - grass clumps (fluffgrass, three-awn): ~30 cm = 100 cells
 *    - shrubs (creosote, brittlebush): ~1.2 m = 400 cells
 *    - trees (mesquite, palo verde): ~4.5 m = 1500 cells
 *  These exceed the visible above-surface band — a 1500-cell tree is
 *  ~36× the typical sky band — so the GL fragment shader naturally
 *  crops trunks at the top of the canvas. Trees read as continuing
 *  off-screen, which matches what an ant at the base of one would
 *  see. The Uint16 storage backs heights up to 65 535 cells (~196 m)
 *  with room to spare. */
export const PLANT_MAX_HEIGHT: ReadonlyArray<number> = [0, 100, 400, 1500];

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
  /** Per-column surface plant kind. 0 = none, 1 = grass, 2 = shrub,
   *  3 = small tree. The kind is immutable for the plant's life and
   *  determines its mature size cap and visual character. Plants
   *  live in the AIR cell(s) immediately above naturalSurface[col]
   *  and periodically drop seeds onto the surface around themselves
   *  — modelling the granivore food source: P. barbatus harvests
   *  seeds dropped by the surrounding desert vegetation (MacMahon,
   *  Mull & Crist 2000, "Harvester Ants and Their Role"). Plants
   *  die when buried by the colony's spoil mound. */
  readonly plant: Uint8Array;
  /** Per-column current plant height in cells. 0 when no plant is
   *  present; otherwise grows from a seedling height of 1 up to a
   *  kind-determined cap (PLANT_MAX_HEIGHT[kind]). Growth advances
   *  stochastically each tick. Uint16 (not Uint8) because mature
   *  trees are ~1500 cells tall at the world's 3 mm/cell scale —
   *  far above any reasonable byte-sized cap. The renderer crops
   *  visible plants at the canvas top. */
  readonly plantHeight: Uint16Array;
  /** Per-cell root marker. 0 = no root; 2 = shrub root; 3 = tree
   *  root (matches the plant kind that owns it). Roots block dig
   *  attempts in physics.digCell — *P. barbatus* nests route around
   *  woody taproots in the wild rather than chewing through them
   *  (Tschinkel 2006 *The Fire Ants* on harvester nest casts;
   *  MacMahon, Mull & Crist 2000 on root-soil interactions in
   *  desert harvester habitat). Grass roots (kind 1) aren't tracked
   *  — they're fine fibrous mats that ants ignore at this scale. */
  readonly root: Uint8Array;
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
  /** Feature toggle for the population-driven seed-clump rain.
   *  Non-zero enables the rain; zero disables it (used as the
   *  defensive default before sim-worker.ts initialises the world,
   *  and by tests that need a no-food environment). Previously this
   *  also acted as a hard rate cap (food supply was bounded at
   *  `foodCap × species.metabolism` per tick, max), but the rate
   *  cap was removed — supply now scales proportionally with live
   *  colony demand. The only throttle is the 150%-of-population
   *  standing-inventory hard stop in ant-rules. */
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
    this.plant = new Uint8Array(width);
    this.plantHeight = new Uint16Array(width);
    this.root = new Uint8Array(width * height);
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

    // Scatter surface vegetation. Plant density and the per-column
    // size-class roll are deterministic from the seeded RNG. We
    // suppress plants in a band around the founding shaft so the
    // colony's entrance reads visually clear — real ants clear
    // vegetation around the nest mound (Hölldobler & Wilson 1990
    // p. 411 on cleared discs around P. barbatus nests).
    const PLANT_DENSITY = 0.12;
    const NEST_CLEAR_HALF = Math.max(4, Math.floor(this.width * 0.04));
    for (let x = 0; x < this.width; x++) {
      const r = rng.next();
      const sizeRoll = rng.next();
      const ageRoll = rng.next();
      if (Math.abs(x - cx) < NEST_CLEAR_HALF) continue;
      if (r >= PLANT_DENSITY) continue;
      // Bias toward the smallest size class. Tall plants are rare.
      const kind = sizeRoll < 0.65 ? 1 : (sizeRoll < 0.92 ? 2 : 3);
      this.plant[x] = kind;
      // Initial height is uniform in [1, maxHeight] so the founding
      // landscape has plants at every life stage rather than a uniform
      // field of seedlings. With per-tick growth at the rate calibrated
      // for biological time compression, a tree maturing from seedling
      // would take days of wall time — initial random ages are the
      // only practical way for the world to look populated at t=0.
      const maxH = PLANT_MAX_HEIGHT[kind]!;
      let h = 1 + ((ageRoll * maxH) | 0);
      if (h > maxH) h = maxH;
      this.plantHeight[x] = h;
    }

    // Root systems for shrubs (kind 2) and trees (kind 3). Grass
    // roots (kind 1) are fine fibrous mats that don't impact digging
    // and aren't tracked. Patterns calibrated to 3 mm/cell scale:
    //   - shrub: ~30 cm taproot (10 cells) + a few short laterals
    //   - tree:  ~1 m  taproot (33 cells) + lateral feeder roots
    //            radiating from the trunk in the upper soil column
    //
    // The taproot drops vertically from the surface, with small
    // hash-driven lateral kinks every few cells so each plant's
    // root reads as an organic line rather than a ruler-straight
    // bar. We bias the kinks deterministically off the column +
    // depth so the layout is reproducible from the seed.
    const TREE_TAP_DEPTH = 33;
    const TREE_LATERAL_REACH = 6;
    const SHRUB_TAP_DEPTH = 10;
    const SHRUB_LATERAL_REACH = 2;
    const writeRoot = (rx: number, ry: number, kind: number): void => {
      if (rx < 0 || rx >= this.width || ry < 0 || ry >= this.height) return;
      const idx = ry * this.width + rx;
      if (this.cells[idx] !== CELL_SOIL) return;
      this.root[idx] = kind;
    };
    for (let x = 0; x < this.width; x++) {
      const kind = this.plant[x]!;
      if (kind < 2) continue;
      const baseY = this.naturalSurface[x]!;
      const tapDepth = kind === 3 ? TREE_TAP_DEPTH : SHRUB_TAP_DEPTH;
      const lateralReach = kind === 3 ? TREE_LATERAL_REACH : SHRUB_LATERAL_REACH;
      // Vertical taproot with deterministic kinks. Hash mixes column
      // x with depth so adjacent plants kink differently.
      let kinkX = x;
      for (let d = 0; d < tapDepth; d++) {
        const ry = baseY + d;
        if ((d > 0) && ((x * 31 + d * 7) & 7) === 0) {
          kinkX += ((x + d) & 1) === 0 ? 1 : -1;
        }
        writeRoot(kinkX, ry, kind);
      }
      // Lateral feeder roots near the surface.
      const lateralDepth = kind === 3 ? 2 : 1;
      for (const dir of [-1, 1] as const) {
        for (let i = 1; i <= lateralReach; i++) {
          const ry = baseY + lateralDepth + ((i * dir + x) & 1);
          writeRoot(x + dir * i, ry, kind);
        }
      }
      // Trees also get one or two deeper laterals branching off the
      // taproot, evoking the buttress / sinker root structure of
      // mature mesquite. Branch points hashed off x for variety.
      if (kind === 3) {
        const branchDepth = 8 + ((x * 17) & 7);
        const branchDir = (x & 1) === 0 ? 1 : -1;
        for (let i = 1; i <= 4; i++) {
          writeRoot(x + branchDir * i, baseY + branchDepth + ((i + x) & 1), kind);
        }
      }
    }
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
