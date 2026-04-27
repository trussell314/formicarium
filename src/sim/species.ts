// Species strategy. Each species supplies the parameters for its
// foraging cycle, food/diet model, and (later) any species-specific
// behaviour overrides. The default species we ship is the red
// harvester ant — Gordon's experimental subject in the task-
// allocation literature, and the species whose nest architecture
// Tschinkel mapped in detail. Granivory makes seeds the natural
// pickup item, which fits a discrete-cell sim.
//
// Adding a new species: implement AntSpecies (or extend a base) and
// pass it into `step()`. Behaviour outside the parameters here
// stays shared across species for now; species-specific behaviour
// hooks can be added if/when they're needed.

export interface AntSpecies {
  /** Scientific binomial. */
  readonly name: string;
  /** Common name used in the UI/HUD. */
  readonly commonName: string;
  /** Citation(s) backing the parameter values below. */
  readonly reference: string;

  // ── Foraging cycle ──────────────────────────────────────────────

  /** Per-tick probability that an underground WANDER ant initiates a
   *  forage trip (transitions to STATE_FORAGE). Steady-state forager
   *  fraction ≈ forageDuration · forageProb / (1 + forageDuration · forageProb). */
  readonly forageProb: number;
  /** Hard cap on FORAGE trip length. After this many ticks without
   *  finding food, the ant returns to WANDER. */
  readonly forageDuration: number;

  // ── Diet / food ────────────────────────────────────────────────

  /** Whether the species collects food items at all. Future species
   *  (e.g. army ants, leafcutters) may set this false and supply a
   *  different feeding model. */
  readonly granivorous: boolean;
  /** Expected number of new surface seeds per tick across the world.
   *  Modelled as a Poisson process — wind/plant fall/animal scat
   *  deposit seeds onto the natural surface. Crist & MacMahon
   *  (1992) measured wind-driven seed deposition rates of 0.1–10
   *  seeds/m²/day in arid grasslands; we pick a value that makes
   *  the cycle visible at sim speeds without flooding the surface. */
  readonly seedsPerTick: number;

  // ── Homeostasis / energy ───────────────────────────────────────

  /** Maximum energy an ant can store. Caps refill when feeding. */
  readonly maxEnergy: number;
  /** Per-tick basal-metabolism drain. Ant dies when energy reaches
   *  0, so 1 / metabolism is roughly the survival horizon for an
   *  ant that never feeds. Pogonomyrmex barbatus workers can survive
   *  ~3 weeks without food (Hölldobler & Wilson 1990, Ch. 13).
   *  At default speed=8 sub-steps × 30 fps × 3 wks ≈ 4.4 × 10^7 ticks,
   *  metabolism ~2e-8 — but that's invisibly slow for a viewer. We
   *  scale up so feeding pressure is observable on the timescale
   *  of a deploy session. */
  readonly metabolism: number;
  /** Energy gained from eating one food cell. */
  readonly foodValue: number;
  /** Energy threshold below which an ant will eat food on contact.
   *  Above this, ants prefer to leave food alone for the granary
   *  (or to be carried to a deposit site by CARRY_FOOD ants). */
  readonly hungerThreshold: number;

  // ── Age-based polyethism (Mersch, Crespi & Keller 2013) ────────

  /** Base strength of positive geotaxis for unladen WANDER ants below
   *  the natural surface — pulls them toward the chamber floor where
   *  fresh dig opportunities are. Weak (~0.1–0.2): just a bias on top
   *  of stigmergy, not a homing vector. Mersch's nurses bias deep
   *  (toward brood); we use the same mechanism without an explicit
   *  brood site. Modulated by ageFrac so nurses dive deep and
   *  foragers stay shallow (preparing to leave for surface trips). */
  readonly belowGeotaxis: number;
  /** Ticks until an ant reaches "mature" / forager age. ageFrac =
   *  min(1, age/matureAge) modulates below-surface geotaxis (decreases
   *  with age — nurses head deep, foragers stay near entrance) and
   *  forageProb (increases with age — old workers go outside, young
   *  workers stay inside). Mersch et al. tracked Camponotus fellah
   *  workers transitioning nurse → cleaner → forager over weeks; the
   *  matureAge here is the sim-tick analogue. */
  readonly matureAge: number;

  // ── Brood / population replenishment ───────────────────────────

  /** Ticks between egg-laying events for a healthy queen. Real
   *  Pogonomyrmex queens lay several eggs per day; we compress to
   *  the same time-scale as our 300×-aggressive metabolism so
   *  brood production keeps pace with worker mortality. */
  readonly eggLayInterval: number;
  /** Ticks for an egg to mature into a worker. Compresses the real
   *  egg → larva → pupa → adult ~3-4 week cycle into observation
   *  time. Hölldobler & Wilson (1990) Ch. 9 on caste development. */
  readonly eggMatureTicks: number;
  /** Hard cap on total colony size. Stops the queen from laying when
   *  reached so the SoA arrays don't blow past their capacity at
   *  long horizons. Real Pogonomyrmex barbatus mature colonies hold
   *  5,000-10,000 workers (Tschinkel 1998); this is bounded by what
   *  we can render and simulate without performance issues. */
  readonly maxColonySize: number;

  // ── Aging mortality ─────────────────────────────────────────────

  /** Ticks an adult worker lives before dying of old age. Real
   *  Pogonomyrmex barbatus workers average ~1 year in the wild
   *  (Hölldobler & Wilson 1990 Ch. 13). Compressed for observation:
   *  1M ticks ≈ 33 hours biological scaled to a few minutes of wall
   *  time at default sim speed. Without this, workers only died of
   *  starvation/entombment edge cases — population grows monotonically
   *  and user can't see colony turnover. */
  readonly workerLifespan: number;

  // ── Substrate / soil compaction ────────────────────────────────

  /** Cells deep at which the dig-rate compaction multiplier reaches
   *  its floor. Tschinkel (2004, J. Insect Sci. 4:21) measured soil
   *  bulk density increasing with depth in P. badius habitat: from
   *  ~1.2 g/cm³ at the surface to ~1.6 g/cm³ at 1m. Dig rate
   *  decreases roughly linearly with bulk density. At our 3 mm/cell
   *  scale, 1m = 333 cells, so the linear ramp covers 0..333 cells
   *  before flattening out. */
  readonly compactionDepth: number;
  /** Floor of the depth-dependent dig-rate multiplier — even at the
   *  bottom of the world, dig probability never drops below this
   *  fraction of the surface rate. Real Pogonomyrmex still digs at
   *  3m depth, just slower; we floor at 0.4 to keep deep extension
   *  always achievable. */
  readonly compactionFloor: number;

  // ── Activity phase ──────────────────────────────────────────────

  /** True if the species forages during the day (diurnal). Gordon
   *  (1991) reports P. barbatus is strictly diurnal: foraging halts
   *  at sunset, resumes at dawn. Setting this gates `forageProb` by
   *  the daylight curve in world.ts. False would mean a nocturnal
   *  species (e.g. some Camponotus); we don't ship one yet. */
  readonly diurnal: boolean;
}

/**
 * Pogonomyrmex barbatus — the red harvester ant. Granivorous;
 * Gordon's task-allocation work on this species (1989, 2010) is
 * the canonical reference for the patrol/forage cycle. Tschinkel
 * (2004, J. Insect Sci. 4:21) mapped Pogonomyrmex badius nest
 * architecture and identified discrete seed-storage chambers at
 * consistent depths — those granaries are what we expect to
 * emerge from the deposit/storage cycle here.
 */
// ── Sim ↔ biology time/length anchors ──────────────────────────
//
// 1 cell  ≈ 3 mm  (so one P. barbatus worker body — 6 mm,
//                  Hölldobler & Wilson 1990 — spans 2 cells)
// 1 tick  ≈ 120 ms biological time
//                  (calibrated from walkSpeed = 1.2 cells/tick
//                  × 3 mm/cell × 8.3 ticks/sec = 30 mm/sec, the real
//                  forager speed in Gordon 1989)
// →   1 second biological  ≈ 8.3 ticks
//     1 minute biological  ≈ 500 ticks
//     1 hour biological    ≈ 30,000 ticks
//     1 day biological     ≈ 720,000 ticks
//     1 week biological    ≈ 5 million ticks
//
// All cell-relative quantities (walkSpeed, COLLISION_RADIUS, pinhole
// geometry, default world dims, scatter band, pheromone diffuse rate)
// are sized so the physical-units description above remains correct.
// Pheromone half-life and per-tick probabilities are time-relative
// not space-relative, so they DON'T scale with cell size.

export const HARVESTER: AntSpecies = {
  name: 'Pogonomyrmex barbatus',
  commonName: 'red harvester ant',
  reference: 'Gordon (1989, 2010); Tschinkel (1998, 2004)',

  // ── Foraging cycle ────────────────────────────────────────────
  // Real Pogonomyrmex foragers leave the nest several times per day;
  // each trip lasts 10-30 minutes (Gordon 1991). Assuming 6 trips/day
  // averaged over forager-eligible workers, mean inter-trip = 4 hr =
  // 120k ticks → forageProb ~ 1 / (120000) per WANDER-eligible tick.
  // Round to 2e-5; with forageDuration 5000 the steady-state forager
  // fraction is ~9% of WANDER-eligible workers.
  forageProb: 2e-5,
  forageDuration: 5000,   // 10 min biological — middle of Gordon's range

  // ── Food / diet ───────────────────────────────────────────────
  granivorous: true,
  // Crist & MacMahon (1992) measured ~1 seed/m²/day in arid grasslands
  // for windblown deposition; on a 200-cell-wide world (1.2 m), real
  // rate ≈ 1.2 seeds/day = 1.4e-5 seeds/tick. Compress 100× for
  // observability without flooding the surface.
  seedsPerTick: 1.4e-3,

  // ── Homeostasis / energy ──────────────────────────────────────
  maxEnergy: 1.0,
  // Real Pogonomyrmex worker can survive ~3 weeks without food
  // (Hölldobler & Wilson 1990 Ch. 13). 3 weeks = 15M ticks. We
  // compress 10× for visibility — workers die in days of biological
  // time without trophallaxis or foraging access. metabolism =
  // 1 / 1.5M = 6.7e-7. (Original 2e-5 was 30× more aggressive,
  // collapsing colonies in hours.)
  metabolism: 6.7e-7,
  foodValue: 0.4,         // 1 seed restores ~40% — multiple seeds for full recovery
  hungerThreshold: 0.6,   // ants seek food below 60%

  // ── Age polyethism ───────────────────────────────────────────
  // Same magnitude as surface-funnel and CARRY upward geotaxis (0.35).
  // Earlier 0.15 was too weak to reliably bring WANDER ants to the
  // chamber floor — combined with surface-only/threshold deposit,
  // dig pheromone built up laterally and chambers spread into long
  // horizontal galleries (the inverse of Tschinkel 2004's vertical-
  // gallery architecture for Pogonomyrmex). Pre-brood era tried 0.35
  // and got REST overload + starvation; brood replenishment now
  // covers the mortality so the stronger pull is sustainable.
  belowGeotaxis: 0.35,
  // Real worker maturation (nurse → forager): ~3-4 weeks. Compress
  // to ~1 hour biological for observation = 30000 ticks.
  matureAge: 30000,

  // ── Brood / population ────────────────────────────────────────
  // A founding queen lays ~5-15 eggs/day (Tschinkel 1998; Hölldobler
  // & Wilson 1990 Ch. 5). Mature colony queens lay 100s/day. Take a
  // mid-founding rate: 1 egg every 2.4 hours biological = 72000 ticks.
  // Compress to 5000 ticks (~10 min) for observable colony growth.
  eggLayInterval: 5000,
  // Real egg → adult: ~4 weeks (~28M ticks). Compress to 50,000 ticks
  // (~100 min biological) for observability.
  eggMatureTicks: 50000,
  // Pogonomyrmex barbatus mature colonies hold 5,000-10,000 workers
  // (Tschinkel 1998). We cap lower to fit performance/render budget.
  maxColonySize: 1000,
  workerLifespan: 1_000_000,
  // 333 cells × 3 mm = 1 m, where Tschinkel measured bulk density
  // levelling off in P. badius soil profiles.
  compactionDepth: 333,
  compactionFloor: 0.4,
  // Gordon 1991: Pogonomyrmex barbatus is strictly diurnal. Foragers
  // stay underground from sunset to dawn; surface activity restarts
  // when ground temperature crosses ~25°C in the morning.
  diurnal: true,
};
