// Agent storage. Pure SoA — nothing here decides anything; that's
// ant-rules.ts. Per CLAUDE.md, never an array of class instances.
//
// State is just the position, heading, and a two-state machine:
// WANDER (looking around / picking dig sites) vs CARRY (transporting
// excavated material to the surface). Anything more elaborate has
// historically been a vector for deadlocks.

import type { RNG } from './rng';

export const STATE_WANDER = 0;
export const STATE_CARRY = 1;
/** Brief stationary withdrawal triggered by collision overload. The
 *  third state in the Aguilar et al. 2018 / Aina et al. 2023
 *  "agitation" model: ants in a crowded zone briefly withdraw,
 *  freeing the choke point and dispersing the work crew. */
export const STATE_REST = 2;
/** Foraging trip — leave the nest, walk on the surface looking for
 *  food, then return to WANDER. See species.ts for cited species
 *  defaults. The cycle is what keeps ant population from pooling
 *  indefinitely at construction fronts (Gordon 1989; Hölldobler &
 *  Wilson 1990, Ch. 8). */
export const STATE_FORAGE = 3;
/** Carrying a food item (e.g. a seed for a granivore species) back
 *  toward the nest. Mirror of STATE_CARRY but with opposite geotaxis
 *  sign — food goes DOWN into the nest, grain goes UP onto the mound. */
export const STATE_CARRY_FOOD = 4;
/** Ant has died (energy hit zero or external cause). The ant is
 *  skipped in all behavioural processing; its position stays put
 *  and a corpse marker is written to world.corpse[idx] at death,
 *  so necrophoresis workers can later drag the body to a midden. */
export const STATE_DEAD = 5;
/** Reproductive caste. The queen sits at her chamber, doesn't move
 *  (or moves very little), and periodically lays eggs while she has
 *  energy. Without continuous brood production, worker mortality
 *  drains the colony to extinction within a few hundred thousand
 *  ticks at default settings — see Hölldobler & Wilson 1990 Ch. 5
 *  on claustral founding and colony growth. */
export const STATE_QUEEN = 6;
/** Brood. Stationary, doesn't eat, doesn't move. After
 *  species.eggMatureTicks the egg transitions to STATE_WANDER and
 *  becomes a fully-functioning worker. Real brood progresses
 *  egg → larva → pupa → adult over weeks; we collapse those stages
 *  into a single maturity counter. */
export const STATE_EGG = 7;
/** Hauling a nestmate corpse to a midden ("refuse pile"). Wilson,
 *  Durlach & Roth (1958, "Chemical releaser of necrophoric behavior
 *  in ants"): workers respond to oleic acid on dead bodies by
 *  picking them up and dropping them outside the nest. The state
 *  drives the ant up out of the chamber, randomwalks on the
 *  surface to drift away from the entrance, then drops the body
 *  on intact ground — the visible midden is what remains. */
export const STATE_NECRO_CARRY = 8;

export type AntState = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export class Colony {
  count = 0;
  readonly capacity: number;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  readonly heading: Float32Array;
  readonly state: Uint8Array;
  readonly stateTicks: Int32Array;
  /**
   * Per-ant response thresholds and behavioural traits, sampled once
   * at spawn from a Gaussian around the colony mean. Beshers, S. N.
   * & Fewell, J. H. (2001). Models of division of labor in social
   * insects. Annu. Rev. Entomol. 46: 413–440. Heterogeneity is the
   * standard mechanism for emergent task allocation: identical
   * agents can't differentiate roles, but a population with
   * variable thresholds will self-organise into specialised cohorts.
   */
  readonly digProb: Float32Array;
  readonly pickProb: Float32Array;
  readonly stigmergy: Float32Array;
  readonly turnNoise: Float32Array;
  /** Per-ant collision threshold (number of recent collisions before
   *  the ant withdraws into REST). Aguilar 2018; Aina 2023. */
  readonly restThreshold: Float32Array;
  /** Decaying collision counter — incremented each tick by overlap
   *  count, multiplied by COLLISION_DECAY each tick. When it
   *  crosses `restThreshold`, the ant enters REST. */
  readonly collisionCount: Float32Array;
  /** Move-count of the grain currently being carried by this ant.
   *  Set on dig (= 0, fresh excavation) or pickup (= grain's stored
   *  count). On deposit, the carried grain's stored count becomes
   *  carryMoves + 1 (this deposit is another move). Zero when the
   *  ant isn't carrying. Renderer doesn't read this; it's just
   *  state for the per-grain wear visualisation that lives on the
   *  GRAIN cell itself. */
  readonly carryMoves: Uint8Array;
  /** Per-ant energy reserve in [0, species.maxEnergy]. Drains at
   *  species.metabolism per tick; refills by species.foodValue when
   *  the ant walks over a food cell. Ant transitions to STATE_DEAD
   *  when energy reaches zero. Models basal metabolism + food-as-fuel
   *  so the colony has a real reason to forage and store granaries. */
  readonly energy: Float32Array;
  /** Per-ant age in ticks since spawn. Drives age-based polyethism
   *  (Mersch, Crespi & Keller 2013) — younger ants bias toward
   *  deeper nest work, older ants bias toward foraging. Frozen
   *  on death. */
  readonly age: Int32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.heading = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.stateTicks = new Int32Array(capacity);
    this.digProb = new Float32Array(capacity);
    this.pickProb = new Float32Array(capacity);
    this.stigmergy = new Float32Array(capacity);
    this.turnNoise = new Float32Array(capacity);
    this.restThreshold = new Float32Array(capacity);
    this.collisionCount = new Float32Array(capacity);
    this.carryMoves = new Uint8Array(capacity);
    this.energy = new Float32Array(capacity);
    this.age = new Int32Array(capacity);
  }

  /**
   * Sample a per-ant value from N(mean, sigma·mean), clamped to a
   * floor of mean·0.2 (so no zero or negative trait values). The
   * sigma is RELATIVE to the mean — what matters biologically is
   * coefficient of variation, not absolute spread.
   */
  private trait(rng: RNG, mean: number, sigma: number): number {
    const v = mean + rng.gauss() * sigma * mean;
    return Math.max(mean * 0.2, v);
  }

  spawn(
    x: number, y: number, heading: number, rng: RNG,
    means: { digProb: number; pickProb: number; stigmergy: number; turnNoise: number; restThreshold: number },
    sigma = 0.3,
  ): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.posX[i] = x;
    this.posY[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.heading[i] = heading;
    this.state[i] = STATE_WANDER;
    this.stateTicks[i] = 0;
    this.digProb[i] = this.trait(rng, means.digProb, sigma);
    this.pickProb[i] = this.trait(rng, means.pickProb, sigma);
    this.stigmergy[i] = this.trait(rng, means.stigmergy, sigma);
    this.turnNoise[i] = this.trait(rng, means.turnNoise, sigma);
    this.restThreshold[i] = this.trait(rng, means.restThreshold, sigma);
    this.collisionCount[i] = 0;
    // Spawn at full energy. Random sub-threshold variation isn't
    // useful here — the population's energy distribution becomes
    // heterogeneous on its own as some ants find food faster than
    // others.
    this.energy[i] = 1.0;
    this.age[i] = 0;
    return i;
  }

  setState(i: number, s: AntState): void {
    this.state[i] = s;
    this.stateTicks[i] = 0;
  }

  /** Spawn `n` ants at random AIR positions inside an inclusive rect. */
  spawnInRect(
    x0: number, y0: number, x1: number, y1: number,
    n: number, rng: RNG, isAir: (x: number, y: number) => boolean,
    means: { digProb: number; pickProb: number; stigmergy: number; turnNoise: number; restThreshold: number },
  ): number {
    let placed = 0;
    let tries = 0;
    while (placed < n && tries < n * 50) {
      tries++;
      const x = rng.range(x0, x1);
      const y = rng.range(y0, y1);
      if (!isAir(x | 0, y | 0)) continue;
      this.spawn(x, y, rng.range(0, Math.PI * 2), rng, means);
      placed++;
    }
    return placed;
  }
}
