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

export type AntState = 0 | 1;

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
    means: { digProb: number; pickProb: number; stigmergy: number; turnNoise: number },
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
    means: { digProb: number; pickProb: number; stigmergy: number; turnNoise: number },
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
