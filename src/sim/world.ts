// 2D vertical cross-section of the formicarium. Origin top-left, y grows down.
// Cells are AIR / SOIL / GRAIN. The ant farm "glass" is implicit — cells
// outside the grid are treated as solid in physics.

import type { RNG } from './rng';

export const CELL_AIR = 0;
export const CELL_SOIL = 1;
export const CELL_GRAIN = 2;

/** Mature plant height in cells, indexed by plant kind. Index 0 is
 *  unused (kind 0 = no plant). Calibrated for visual recognisability
 *  rather than strict real-scale: the sky band above the natural
 *  surface is ~12–30 cells, and at literal 3 mm/cell desert plant
 *  heights (~100/400/1500) every kind read as identical "tall column
 *  going off-screen". These reduced caps keep grass / shrub / tree
 *  visually distinguishable inside the sky band:
 *    - grass tufts at  ~12 mm (4 cells) — visibly small clumps
 *    - shrubs    at  ~42 mm (14 cells) — bushy, fits below crop
 *    - trees     at ~180 mm (60 cells) — tall trunks that crop at
 *                  the canvas top in the typical sky band
 *  Trees still drop trunk silhouettes off-screen as expected at
 *  smaller world-heights. Uint16 storage retains room for any
 *  future per-species overrides. */
export const PLANT_MAX_HEIGHT: ReadonlyArray<number> = [0, 4, 14, 60];

export type CellKind = 0 | 1 | 2;

// ── Scale anchors ────────────────────────────────────────────────
// Two physical anchors and one design knob; everything time- or
// length-related derives from these.
//
//   length: 1 cell = CELL_MM mm
//   time:   1 tick = 1/TICKS_PER_SEC sec biological (micro)
//                  ≈ TIME_COMPRESSION × that in macro-biological
//                    time (drives day-night, lifespan, etc.)
//
// Walk speed and pheromone half-lives are 1× anchors (see species.ts);
// slow biological events (egg→adult, lifespan, foraging probability)
// run TIME_COMPRESSION× faster than real biology.

/** Edge length of one grid cell, in millimetres. P. barbatus worker
 *  body length is ~6 mm, so a worker spans 2 cells. */
export const CELL_MM = 3;

/** Wall-clock and micro-biological tick rate at 1× simulation speed. */
export const TICKS_PER_SEC = 10;

/** Wall-clock (and micro-biological) duration of one tick in ms. */
export const TICK_MS = 1000 / TICKS_PER_SEC;

/** Biological seconds per real day. */
export const SECONDS_PER_DAY = 86400;

/** Calibration baseline for macro-bio rates. The constants in
 *  species.ts are tuned at this compression value; the runtime scale
 *  factor for any per-tick macro rate is `TIME_COMPRESSION /
 *  MACRO_BASELINE`. Don't change without retuning species.ts. */
export const MACRO_BASELINE = 100;

/** How many seconds of macro-biological time pass per real-world
 *  second of wall-clock at 1× speed. Slow biological processes
 *  (lifespan, egg→adult, diel cycle) advance at this multiple.
 *  Mutable at runtime via `setTimeCompression()`. ES module live
 *  binding propagates the new value to all importers — do not cache
 *  the value into a local `const`. */
export let TIME_COMPRESSION = 100;

/** Ticks per in-sim day. Derived: a 24 h biological day, compressed
 *  TIME_COMPRESSION×, runs at TICKS_PER_SEC ticks/sec wall-clock.
 *  Updated alongside TIME_COMPRESSION. The day/night cycle is a
 *  modulo of world.tick by this. */
export let DAY_TICKS = (SECONDS_PER_DAY / TIME_COMPRESSION) * TICKS_PER_SEC;

/** Macro-biological seconds advanced per tick. With TICKS_PER_SEC=10
 *  and TIME_COMPRESSION=100, each tick advances 10 sec of the slow
 *  biological calendar (lifespan, foraging cadence, etc.). */
export let SECONDS_PER_TICK_BIO = TIME_COMPRESSION / TICKS_PER_SEC;

/** Hard ceiling on effective walk speed in cells/tick. Below this
 *  cap, the time-compression dial scales walk speed so foragers
 *  cover the same biological distance per bio-second at any
 *  compression. Above the cap (compression > ~10× the calibrated
 *  base walkSpeed), trips are still bounded — there's a "broken
 *  zone" at very high compression where biological reach starts to
 *  shrink — but the cap keeps the per-tick substep budget bounded.
 *  Each substep is one tryStep + a handful of pheromone ops; cap×
 *  substeps × num-ants is the per-tick cost. */
export const WALK_SPEED_CAP = 10;

/** Per-tick macro-rate scale factor. Multiply Bernoulli probabilities,
 *  per-tick energy drains, and per-tick rate counts by this. Divide
 *  interval thresholds by this. Returns 1 at the baseline (no scaling
 *  needed, behaviour matches species.ts as written). */
export function macroScale(): number {
  return TIME_COMPRESSION / MACRO_BASELINE;
}

/** Adjust the time-compression dial. Floors at 1× (real biology;
 *  never expand time below realtime) and caps at 10000× (above which
 *  several Bernoulli rates saturate even with rng.events()). Updates
 *  DAY_TICKS and SECONDS_PER_TICK_BIO in lockstep. */
export function setTimeCompression(c: number): void {
  const clamped = Math.max(1, Math.min(10000, c));
  TIME_COMPRESSION = clamped;
  DAY_TICKS = (SECONDS_PER_DAY / TIME_COMPRESSION) * TICKS_PER_SEC;
  SECONDS_PER_TICK_BIO = TIME_COMPRESSION / TICKS_PER_SEC;
}

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
  /** Per-column BACKGROUND plant kind. Same encoding as `plant`
   *  but represents a separate visual layer painted behind the
   *  foreground plants with atmospheric-perspective haze. The
   *  background layer is sparser (every 5+ columns) and drawn with
   *  wider/taller silhouettes so it reads as a distant skyline of
   *  trees behind the cross-section. Background plants don't drop
   *  seeds and don't have roots — pure visual depth cue. */
  readonly bgPlant: Uint8Array;
  /** Per-column current background plant height. Always at full
   *  maturity (random within the kind's max) since these don't
   *  grow over time — they're decoration, not sim state. */
  readonly bgPlantHeight: Uint16Array;
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
    this.bgPlant = new Uint8Array(width);
    this.bgPlantHeight = new Uint16Array(width);
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

    // Background plant skyline. A sparser scatter of mature trees /
    // shrubs painted *behind* the foreground plants for atmospheric
    // depth (Tschinkel 2004 nest-site photos show *P. barbatus*
    // colonies at the foot of mesquite stands — the trees frame the
    // mound). These are visual decoration only: no roots, no seed
    // drops, no growth. Heights are biased toward the upper half of
    // the kind's range so the silhouette reads as imposing.
    const BG_PLANT_DENSITY = 0.10;
    for (let x = 0; x < this.width; x++) {
      const r = rng.next();
      const sizeRoll = rng.next();
      const ageRoll = rng.next();
      // Don't strip the background near the entrance — distant
      // trees frame the nest from behind regardless of foreground
      // clearing.
      if (r >= BG_PLANT_DENSITY) continue;
      // Bias toward trees (the dominant background silhouette).
      const kind = sizeRoll < 0.20 ? 1 : (sizeRoll < 0.50 ? 2 : 3);
      this.bgPlant[x] = kind;
      const maxH = PLANT_MAX_HEIGHT[kind]!;
      // Mature heights — at least 60% of max so background reads
      // as established vegetation, not seedlings.
      const h = Math.max(1, ((0.60 + 0.40 * ageRoll) * maxH) | 0);
      this.bgPlantHeight[x] = h;
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
