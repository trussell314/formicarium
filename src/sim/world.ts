// 2D vertical cross-section of the formicarium. Origin top-left, y grows down.
// Cells are AIR / SOIL. The ant farm "glass" is implicit — cells outside the
// grid are treated as solid in physics.
//
// Earlier the grid carried a third cell type CELL_GRAIN distinguishing loose
// ant-deposited spoil from pristine substrate. With the per-cell grainHardness
// field that role is subsumed: a cell with hardness < LOOSE_HARDNESS_THRESHOLD
// is "loose" (cascades under gravity, easy to pick up), and a cell at full
// hardness is "consolidated" (acts like the old pristine SOIL). Pristine soil
// is initialised with hardness = 255 by World.generate so the conservation
// invariant collapses to `initialSoilCells = countSoil() + carriers`.

import type { RNG } from './rng';

export const CELL_AIR = 0;
export const CELL_SOIL = 1;
/** @deprecated alias kept so legacy test fixtures can still set cells
 *  to "grain" without rewriting. Equivalent to CELL_SOIL (the unified
 *  solid type); use it only in test scaffolding where it documents
 *  intent ("place a loose grain here" → also set grainHardness = 0
 *  if the test relies on cascade behaviour). New production code
 *  should use CELL_SOIL with explicit hardness. */
export const CELL_GRAIN = 1;

/** Hardness below which a SOIL cell behaves as loose grain — cascades under
 *  gravity (settleGrain), is easily picked up by foragers, and the renderer
 *  paints it lighter. Above this threshold the cell is "consolidated" and
 *  acts as a structural wall: doesn't cascade, and digProb's hardFactor
 *  keeps pickup probability low. 64 chosen so a fresh deposit (hardness=0)
 *  needs about one tamping sweep (≥ +50/sweep) before it consolidates. */
export const LOOSE_HARDNESS_THRESHOLD = 64;

/** Per-cell helper. Returns true iff the cell at (x, y) is solid (i.e.
 *  cells === CELL_SOIL) AND its hardness has not yet consolidated. Used by
 *  cascade gating (settleGrain), the foraging-mound count, and tests. */
export function isLoose(world: World, idx: number): boolean {
  return world.cells[idx] === CELL_SOIL
    && world.grainHardness[idx]! < LOOSE_HARDNESS_THRESHOLD;
}

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
 *  Pinned at the calibration baseline. The variable-time-scale dial
 *  was removed because compressing all rates by a single factor
 *  doesn't preserve the co-evolved ratios in real biology
 *  (rest:day, behavior:lifespan, etc.) — different processes need
 *  different scaling treatments. Tune species.ts and behaviour code
 *  to make 100× match real biology rather than offering a knob that
 *  trades one set of inaccuracies for another. */
export const TIME_COMPRESSION = MACRO_BASELINE;

/** Diel-cycle-only compression. The day/night cycle's period in
 *  sim ticks. Decoupled from TIME_COMPRESSION (which governs
 *  lifespan + brood maturation) because the diel cycle has a
 *  different "right pace" than calendar biology: foragers move at
 *  micro-clock speed (30 mm/sec), so at the macro-bio 100×
 *  compression they barely complete one round-trip before the
 *  daylight window closes. At 20× the cycle period stretches to
 *  43200 ticks (~72 min at 1× wall, ~80 sec at typical 56×
 *  effective), giving ~10 round-trips per visible day — the
 *  user-observable rhythm Tschinkel/Gordon describe in real
 *  P. barbatus. The trade-off: a worker now lives ~65 sim-days
 *  (instead of 304) but the same number of wall-clock hours,
 *  because lifespan is anchored in ticks not sim-days. */
export const DIEL_COMPRESSION = 20;

/** Ticks per in-sim day. With DIEL_COMPRESSION = 20, a 24h
 *  biological day plays out in 43200 ticks. The day/night cycle
 *  is a modulo of world.tick by this. */
export const DAY_TICKS =
  (SECONDS_PER_DAY / DIEL_COMPRESSION) * TICKS_PER_SEC;

/** Macro-biological seconds advanced per tick. At 10 ticks/sec and
 *  100× compression, each tick advances 10 sec of the slow biological
 *  calendar (lifespan, foraging cadence, etc.). */
export const SECONDS_PER_TICK_BIO = TIME_COMPRESSION / TICKS_PER_SEC;

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

/** Per-tick macro-rate scale factor. Always 1 now that the time-
 *  compression dial is removed and TIME_COMPRESSION is pinned to
 *  the calibration baseline. Kept as a function (rather than inlined
 *  to 1 at every call site) so the macro/micro distinction stays
 *  legible in the code; if a future refactor reintroduces variable
 *  compression, the call sites are already in place. */
export function macroScale(): number {
  return 1;
}

/** Stub kept for tests that call it explicitly. The dial was
 *  removed; compression is now fixed at MACRO_BASELINE. */
export function setTimeCompression(_c: number): void {
  // intentionally no-op
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
  /** Per-cell GRAIN hardness, 0 (fresh) → 255 (set). Models real ant
   *  wall reinforcement: tamping (Tschinkel 2004), saliva / cement
   *  secretion (Hölldobler & Wilson 1990 Ch. 7), and time-based
   *  consolidation. A per-tick sweep increments grainHardness on
   *  GRAIN cells: +1 base, +1 per cardinal solid neighbour (the
   *  "tamping by context" — a grain wedged between solids hardens
   *  faster than a loose pile). pickGrain's pickup probability is
   *  scaled by (1 − hardness/255), so old hardened walls resist
   *  re-excavation while loose mound grains are easily reshuffled.
   *  Reset to 0 by placeGrain (fresh deposit) and by settleGrain
   *  cascades (a falling grain isn't set). Zero in non-grain cells. */
  readonly grainHardness: Uint8Array;
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
  /** Tick at which each cell's corpse was last deposited. The sim
   *  uses (world.tick - corpseTick[idx]) for natural decomposition:
   *  corpses older than CORPSE_LIFETIME_TICKS clear back to AIR via
   *  beetle / fungal / bacterial action, the way real ant-midden
   *  corpses break down on a ~weeks timescale. Without this,
   *  middens accumulate immortal corpse markers forever. */
  readonly corpseTick: Int32Array;
  /** Tick at which each cell's food (seed) was last placed. Mirrors
   *  corpseTick: surface seeds older than FOOD_LIFETIME_TICKS rot /
   *  get rained out / are eaten by birds and clear back to AIR via
   *  the food-decay sweep. Below-surface (granary) food is exempt —
   *  stored seeds in dry chambers last for years. Cascaded food
   *  preserves its tick (the seed fell, didn't restart aging). */
  readonly foodTick: Int32Array;
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

  /** Cumulative diagnostic counters for the forage pipeline. Each
   *  measures a distinct transition; the master test harness reads
   *  them as deltas across windows to separate discovery problems
   *  (low pickups despite many starts) from return-trip problems
   *  (low deliveries despite many pickups). Not used by sim logic. */
  totalForageStarts = 0;
  totalForagePickups = 0;
  totalForageDeliveries = 0;
  totalForageBails = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint8Array(width * height);
    this.naturalSurface = new Uint16Array(width);
    this.mound = new Uint16Array(width);
    this.soilNoise = new Uint8Array(width * height);
    this.grainMoves = new Uint8Array(width * height);
    this.grainHardness = new Uint8Array(width * height);
    this.food = new Uint8Array(width * height);
    this.foodMoves = new Uint8Array(width * height);
    this.corpse = new Uint8Array(width * height);
    this.sprout = new Uint8Array(width * height);
    this.sproutTick = new Int32Array(width * height);
    this.sproutTick.fill(-1_000_000);
    this.corpseTick = new Int32Array(width * height);
    this.corpseTick.fill(-1_000_000);
    this.foodTick = new Int32Array(width * height);
    this.foodTick.fill(-1_000_000);
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
    // 4-octave sum-of-sines surface noise. Each octave picks its own
    // frequency, phase, and amplitude weight from the RNG so the
    // wavelength PATTERN — not just the phase — varies with the seed.
    // Earlier versions used two hardcoded frequencies (0.07 and 0.21)
    // with only the phase seeded; every seed produced the same hill
    // wavelengths shifted, which read as "the same hills again."
    // Octave structure: f_k ∈ [base/2, 2·base] · 2^k, base ≈ 0.05;
    // amplitude weight 1/(k+1) so low-frequency hills dominate and
    // higher-frequency detail roughens the surface without dwarfing
    // the macro shape.
    const octaves = 4;
    const baseFreq = 0.05;
    const freqs: number[] = [];
    const phases: number[] = [];
    const weights: number[] = [];
    let weightSum = 0;
    for (let k = 0; k < octaves; k++) {
      // Random multiplier in [0.5, 2.0] gives ~2 octave spread;
      // multiplied by 2^k so successive octaves are higher-frequency.
      const fJitter = rng.range(0.5, 2.0);
      freqs.push(baseFreq * Math.pow(2, k) * fJitter);
      phases.push(rng.range(0, Math.PI * 2));
      const w = 1 / (k + 1);
      weights.push(w);
      weightSum += w;
    }
    const ampTotal = Math.max(2, Math.floor(this.height * 0.025));

    let soil = 0;
    for (let x = 0; x < this.width; x++) {
      let wave = 0;
      for (let k = 0; k < octaves; k++) {
        wave += Math.sin(x * freqs[k]! + phases[k]!) * weights[k]!;
      }
      // Scale by ampTotal/weightSum so the peak-to-peak roughly
      // tracks ampTotal regardless of how the random weights summed.
      const sy = Math.max(2, Math.min(this.height - 4,
        surfaceRow + Math.round((wave / weightSum) * ampTotal)));
      this.naturalSurface[x] = sy;
      for (let y = 0; y < this.height; y++) {
        const idx = y * this.width + x;
        if (y < sy) {
          this.cells[idx] = CELL_AIR;
        } else {
          this.cells[idx] = CELL_SOIL;
          // Pristine substrate is fully consolidated. Without this
          // every cell would read as "loose" (hardness=0 default
          // from the Uint8Array fill) and would cascade on the next
          // settleGrain pass, which would dump the entire world to
          // the bottom row.
          this.grainHardness[idx] = 255;
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

    // Pre-carved chamber stubs along the central shaft path. Real
    // Pogonomyrmex nests show stacked chambers at characteristic
    // depths (Tschinkel 2004 nest casts — ~30 cm intervals, several
    // chambers connected by short vertical shafts). Without
    // pre-carved hints, the dig logic tends to produce a single
    // deep pencil shaft because workers congregate at the deepest
    // cell and the force-down rule keeps deepening it. Pre-carving
    // tiny 3-wide × 1-tall pockets at fixed chamber depths gives
    // the colony a "blueprint": workers reaching a stub find it's
    // already AIR (no need to dig), can spread laterally, and
    // existing pheromone-driven recruitment (Khuong et al. 2016
    // build-field accumulation) widens the stubs into real
    // chambers via normal dig events nearby. Doesn't touch
    // cascade physics, so the embed invariant holds.
    const CHAMBER_INTERVAL = 25;
    const CHAMBER_HALF = 1; // 3-wide stub (cx-1, cx, cx+1)
    const firstStubY = pocketBot + CHAMBER_INTERVAL;
    for (let stubY = firstStubY; stubY < this.height - 4; stubY += CHAMBER_INTERVAL) {
      const sx0 = Math.max(0, cx - CHAMBER_HALF);
      const sx1 = Math.min(this.width - 1, cx + CHAMBER_HALF);
      for (let x = sx0; x <= sx1; x++) {
        const idx = stubY * this.width + x;
        if (this.cells[idx] === CELL_SOIL) {
          this.cells[idx] = CELL_AIR;
          soil--;
        }
      }
    }

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

  /** Total solid cells (consolidated wall + loose deposits). With the
   *  unified type the conservation invariant is simply
   *  `initialSoilCells === countSoil() + currentCarriers + wearLost`
   *  — a dug cell either rides on a carrier ant or is pulverised
   *  into wearLost; a deposited grain becomes solid again and shows
   *  up in countSoil. */
  countSoil(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL_SOIL) n++;
    }
    return n;
  }

  /** Solid cells whose hardness is below the loose threshold —
   *  cells the foragers (and the renderer) treat as "loose grain":
   *  fresh deposits that haven't yet tamped/saturated into the
   *  surrounding wall. Counted separately from total solid for
   *  HUD display and tests. */
  countGrains(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL_SOIL
          && this.grainHardness[i]! < LOOSE_HARDNESS_THRESHOLD) n++;
    }
    return n;
  }
}
