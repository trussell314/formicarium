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
   *  deposit seeds onto the natural surface. Default 0 for the
   *  clump-rain model below; species that prefer the older
   *  uniform-rain feel can set this nonzero. Both pathways can
   *  fire in the same tick. */
  readonly seedsPerTick: number;
  /** Ticks between clump-rain events. Each event drops `clumpSize`
   *  seeds clustered within `clumpRadius` cells of a randomly chosen
   *  surface column — modelling a plant fruiting at a particular
   *  location, or a windfall against a slope, rather than a uniform
   *  drizzle. The default values give ~10× the per-tick foraging
   *  capacity of the previous uniform rain, so the colony has
   *  comfortable headroom to grow without seeds being a survival
   *  pressure. Set very high to disable clump rain. */
  readonly clumpInterval: number;
  /** Seeds per clump event. */
  readonly clumpSize: number;
  /** 1-σ radius (cells) of the seed scatter around the clump centre.
   *  Drawn from a Gaussian so most seeds land in a tight pile and
   *  a few drift outward; this matches the visual "spilled handful"
   *  look the user asked for, rather than a hard ring. */
  readonly clumpRadius: number;

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
   *  time. Hölldobler & Wilson (1990) Ch. 9 on caste development.
   *  This is the EGG-only duration; total brood time is
   *  eggMatureTicks + larvaMatureTicks. */
  readonly eggMatureTicks: number;
  /** Ticks a larva spends being fed before becoming a mature
   *  worker. Larvae need trophallactic feeding from workers; if
   *  their energy runs out they die (Hölldobler & Wilson 1990
   *  Ch. 9). The larval period is ~2× the egg period in real
   *  Pogonomyrmex. */
  readonly larvaMatureTicks: number;
  /** Per-tick basal-metabolism drain for a larva. Higher than
   *  worker metabolism because larvae are growing tissue rapidly
   *  rather than maintaining mature soma. With no feeding, a
   *  full-energy larva starves before it can mature; trophallaxis
   *  from passing workers keeps the brood pile alive. */
  readonly larvaMetabolism: number;
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

  // ── Necrophoresis ───────────────────────────────────────────────

  /** Per-tick probability that a WANDER ant standing on or adjacent
   *  to a corpse cell picks the body up and switches to
   *  STATE_NECRO_CARRY. Wilson, Durlach & Roth (1958) showed the
   *  behaviour is contact-triggered by oleic acid on dead nestmates;
   *  not every passing worker reacts (lots of variation between
   *  species). We pick a value that produces visible cleanup of the
   *  corpse pool over a few biological hours without instantly
   *  emptying the nest. Set to 0 for species that don't midden
   *  (army ants, fungus growers handle waste differently). */
  readonly necrophoresisProb: number;
  /** Minimum ticks an ant must spend hauling a corpse before
   *  dropping it. The combination of stateTicks gate + above-surface
   *  drop logic produces middens 50-100 cells from the nest entrance.
   *  Below this many ticks the drop logic refuses, so corpses don't
   *  pile up at the doorstep. */
  readonly necroHaulMinTicks: number;

  // ── Trophallaxis (worker-worker food sharing) ──────────────────

  /** Energy transferred per tick of contact between a "well-fed"
   *  donor and a "hungry" recipient. Hölldobler & Wilson (1990
   *  Ch. 7) describe trophallaxis as the dominant nutritional
   *  pathway in many ant species: foragers fill the crop, return
   *  to the nest, and regurgitate small aliquots to nestmates
   *  through repeated brief contacts. Cassill & Tschinkel (1999)
   *  measured per-bout transfer of ~0.5–5% of crop volume in
   *  Solenopsis invicta. We pick a small fraction of maxEnergy so
   *  multiple contact-bouts are needed to fully refuel a hungry ant. */
  readonly trophallaxisAmount: number;
  /** Donor threshold: the higher-energy partner only gives if its
   *  own energy is above this fraction of maxEnergy. Below it,
   *  ants don't share — they can't afford to. */
  readonly trophallaxisDonorThreshold: number;
  /** Recipient threshold: the lower-energy partner only accepts if
   *  it's below this fraction of maxEnergy. Above it, satisfied
   *  ants don't beg. Setting recipientThreshold > donorThreshold
   *  would oscillate energy back and forth; we keep recipient ≤
   *  donor so each bout is monotonic. */
  readonly trophallaxisRecipientThreshold: number;

  // ── Brood thermoregulation ─────────────────────────────────────

  /** Target depth (cells below the natural surface) for brood at
   *  midnight, when the surface is coolest. Real ants move brood to
   *  shallower strata at night to capture residual warmth retained
   *  from the day. Penick & Tschinkel (2008) tracked this in
   *  Pogonomyrmex badius; we collapse the temperature gradient into
   *  a depth target without modelling the temperature field
   *  explicitly. */
  readonly broodMinDepth: number;
  /** Target depth (cells below the natural surface) for brood at
   *  noon, when the surface is hottest. The ants escape the surface
   *  heat by descending to cooler strata. The depth swings linearly
   *  between min and max as the daylight curve goes from 0 to 1. */
  readonly broodMaxDepth: number;
  /** How many ticks an egg waits between thermoregulatory migration
   *  steps. The egg moves at most one cell per interval, so a
   *  smaller interval means faster drift. We pick a value that
   *  produces visible motion over the day cycle without making
   *  brood positions twitchy. */
  readonly broodMigrateInterval: number;

  // ── Seed germination ───────────────────────────────────────────

  /** Per-stored-seed probability of germinating in one full sweep
   *  over the food field. Tschinkel (1999) observed that uneaten
   *  seeds in P. badius granaries sometimes sprout — the colony
   *  treats them as failed-to-eat and removes the sprout. The
   *  sweep runs once per germinationSweepInterval ticks, so the
   *  effective per-tick rate is sproutProb / sweepInterval. Set
   *  to 0 for non-granivorous species (no stored seeds). */
  readonly sproutProb: number;
  /** Ticks before a sprout decays naturally to nothing. Real
   *  sprouts in granaries last a day or two before drying up; we
   *  pick a value that lets a viewer see the sprout-then-fade
   *  cycle within a reasonable session. */
  readonly sproutLifetimeTicks: number;
  /** Ticks between full sweeps of the food field for germination
   *  rolls. A full O(W·H) sweep is amortised across the interval —
   *  at default 1000 ticks the per-tick cost is W·H/1000 ops. */
  readonly germinationSweepInterval: number;
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
  // Uniform per-tick seed rain disabled — replaced by the clump
  // pathway below. Set nonzero on a per-species override to re-enable
  // the older drizzle behaviour.
  seedsPerTick: 0,
  // Capacity check: clumpInterval=1000 × clumpSize=10 = 0.01 seeds/tick.
  // Over a 720,000-tick biological day that's 7,200 seeds × 0.4 energy
  // = 2,880 energy/day. Worker metabolism 6.7e-7 × 720k = 0.48
  // energy/ant/day → supports ~6,000 workers in steady state, well
  // beyond the maxColonySize=1000 cap. Counts as ~10× the per-ant
  // foraging headroom of the old uniform-rain values, so seed
  // availability stops being a survival pressure for any plausible
  // colony size. The user explicitly asked for "support a 10× population
  // growth (a setting to tweak later)" — these knobs are the setting.
  clumpInterval: 1000,
  clumpSize: 10,
  clumpRadius: 5,

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
  // Real egg → larva: ~1 week. We compress to 15,000 ticks (~30
  // min biological) so the user sees the egg→larva transition
  // within a typical session window.
  eggMatureTicks: 15000,
  // Real larva → adult: ~3 weeks. Compress to 35,000 ticks
  // (~70 min biological); total brood time = 50,000 ticks, same
  // as the pre-larva-stage value so colony-growth tests don't
  // regress.
  larvaMatureTicks: 35000,
  // Worker metabolism is 6.7e-7. Larvae burn ~15× faster (growing
  // animals); with maxEnergy 1.0 a full-fed larva starves in
  // ~100,000 ticks (~3 hr biological), well past larvaMatureTicks
  // so a larva that gets even occasional trophallaxis matures.
  // Neglected larvae starve.
  larvaMetabolism: 1e-5,
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
  // Wilson, Durlach & Roth 1958. P. barbatus is documented as a
  // necrophoretic species; the per-tick pickup probability isn't
  // measured directly but Hart & Ratnieks (2002) found that ~30% of
  // workers passing a corpse responded within a minute of contact.
  // Per-tick (120 ms biological) gives ~30% / 500 ticks ≈ 6e-4. We
  // pick 1e-3 to make cleanup visible at observation scales without
  // making it overwhelm dig/forage activity.
  necrophoresisProb: 1e-3,
  // Hauling lasts long enough to walk the body off the entrance.
  // 500 ticks × 1.2 cells/tick = ~600 cells max travel — far more
  // than the ant will actually walk above-surface, so the gate is
  // really about "got out of the chamber" plus a short surface walk.
  necroHaulMinTicks: 500,
  // Penick & Tschinkel (2008) measured P. badius brood depth diel
  // movement: brood found 5-30 cm below surface, with deeper
  // positions at midday. At 3 mm/cell that's 17-100 cells. We use
  // 4 cells (~12 mm, midnight) to 30 cells (~90 mm, noon) — slightly
  // compressed so the migration is visible at the default 60 cm
  // world height without brood pressing against the world floor.
  broodMinDepth: 4,
  broodMaxDepth: 30,
  // 600 ticks ≈ 72 sec biological at 1 tick = 120 ms. Eggs drift up
  // to 60 cells over a 12-hour daytime, which matches the ~30-cell
  // total swing between min and max depth (≥ enough motion to track
  // the target without overshooting).
  broodMigrateInterval: 600,
  // Cassill & Tschinkel (1999) measured per-bout trophallactic
  // transfers of 0.5-5% of the donor's crop in S. invicta. We use
  // 0.005 = 0.5% of maxEnergy per tick of contact, which sums over
  // a multi-tick neighbourhood encounter into a meaningful refill
  // (~0.05–0.10 over 10–20 ticks of close contact) without
  // overshooting the food-cell value.
  trophallaxisAmount: 0.005,
  // Donor must be ≥50% full; this matches "well-fed" in the
  // hunger-threshold scheme (hungerThreshold=0.6, donorThreshold=0.5
  // means donors aren't simultaneously seeking food themselves).
  trophallaxisDonorThreshold: 0.5,
  // Recipient must be below 40%. Together with donorThreshold the
  // pair "ant at 0.4 / ant at 0.5" is the boundary case — the donor
  // gives, recipient accepts, energy drifts toward the average.
  trophallaxisRecipientThreshold: 0.4,
  // Tschinkel (1999): granaries occasionally have a sprouted seed.
  // Real rate is rare — most stored seeds get eaten or removed
  // before germination. 5e-3 per stored seed per sweep, with
  // sweeps every 1000 ticks, gives ~5e-6/tick per seed — a few
  // sprouts per biological day in a busy granary.
  sproutProb: 5e-3,
  // 24 biological hours = 720,000 ticks; we pick 5,000 so a sprout
  // lives ~10 minutes biological before drying up. Long enough to
  // be visible across many frames, short enough that the granary
  // doesn't accumulate dead sprouts indefinitely.
  sproutLifetimeTicks: 5000,
  germinationSweepInterval: 1000,
};
