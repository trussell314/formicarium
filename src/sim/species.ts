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
};
