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
export const HARVESTER: AntSpecies = {
  name: 'Pogonomyrmex barbatus',
  commonName: 'red harvester ant',
  reference: 'Gordon (1989, 2010); Tschinkel (2004)',
  forageProb: 0.001,    // ~15% of colony in FORAGE at steady state
  forageDuration: 200,
  granivorous: true,
  seedsPerTick: 0.5,    // ~one new seed every 2 ticks across world
  maxEnergy: 1.0,
  // 1 / 2e-5 = 50,000-tick survival without food. At default 8x
  // sub-stepping, that's ~3 minutes of wall clock — slow enough
  // that a healthy fed colony rarely dies, fast enough that
  // entombed/cut-off ants die in plain view of a viewer. The
  // initial 5e-5 was too aggressive for the food-delivery
  // pipeline (forager → CARRY_FOOD → granary → consumer); the
  // colony was starving en masse before equilibrium.
  metabolism: 2e-5,
  foodValue: 0.6,       // one seed = ~60% of full
  hungerThreshold: 0.7, // ants feed when energy < 70%
  // Age-based polyethism. matureAge = ~half the survival horizon
  // (50k tick metabolism limit) so the nurse → forager transition
  // happens well within a typical observation session.
  belowGeotaxis: 0.15,
  matureAge: 15000,
};
