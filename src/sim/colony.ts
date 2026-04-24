// Colony — struct-of-arrays storage of all live ants. SPEC §5.3.

import type { RNG } from './rng';
import { SIM } from '../config';

export const STATE_WANDER = 0;
export const STATE_DIG = 1;
export const STATE_CARRY = 2;
export const STATE_REST = 3;

export type AntState =
  | typeof STATE_WANDER
  | typeof STATE_DIG
  | typeof STATE_CARRY
  | typeof STATE_REST;

export class Colony {
  readonly capacity: number;
  count: number;

  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  readonly heading: Float32Array;
  readonly state: Uint8Array;
  readonly stateTimer: Uint16Array;
  readonly age: Uint16Array;
  // Decaying float counter; SPEC says Uint8Array but float lets us decay
  // smoothly per tick rather than per-N-ticks.
  readonly collisionCount: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.count = 0;
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.heading = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.stateTimer = new Uint16Array(capacity);
    this.age = new Uint16Array(capacity);
    this.collisionCount = new Float32Array(capacity);
  }

  spawn(x: number, y: number, headingRad: number): number | null {
    if (this.count >= this.capacity) return null;
    const i = this.count++;
    this.posX[i] = x;
    this.posY[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.heading[i] = headingRad;
    this.state[i] = STATE_WANDER;
    this.stateTimer[i] = 0;
    this.age[i] = 0;
    this.collisionCount[i] = 0;
    return i;
  }

  /**
   * Spawn `n` ants in a tight cluster around (cx, cy) with random headings.
   * Used for initial colony seeding and the "n" key burst.
   *
   * If `isAir` is supplied, the spawn position is rejected when it lands in
   * non-air (so ants never start embedded in soil); we retry along the
   * upward direction until we find air or run out of attempts.
   */
  spawnCluster(
    cx: number,
    cy: number,
    n: number,
    rng: RNG,
    radius = 4,
    isAir?: (x: number, y: number) => boolean,
  ): number {
    let added = 0;
    for (let k = 0; k < n; k++) {
      const r = rng.range(0, radius);
      const a = rng.range(0, Math.PI * 2);
      const x = cx + Math.cos(a) * r;
      let y = cy + Math.sin(a) * r;
      if (isAir) {
        let attempts = 0;
        while (!isAir(x | 0, y | 0) && attempts < 64) {
          y -= 1;
          attempts++;
        }
        if (!isAir(x | 0, y | 0)) continue;
      }
      const h = rng.range(0, Math.PI * 2);
      if (this.spawn(x, y, h) === null) break;
      added++;
    }
    return added;
  }

  setState(i: number, s: AntState): void {
    if (this.state[i] !== s) {
      this.state[i] = s;
      this.stateTimer[i] = 0;
    }
  }

  /**
   * Decays collision counters and ticks state timers and ages. Called once
   * per sim tick by the rules engine — kept here so all SoA bookkeeping
   * lives next to the storage.
   */
  endOfTickBookkeeping(): void {
    const decay = SIM.collisionDecayPerTick;
    for (let i = 0; i < this.count; i++) {
      const c = this.collisionCount[i] - decay;
      this.collisionCount[i] = c > 0 ? c : 0;
      // Saturating increment for stateTimer and age.
      if (this.stateTimer[i] < 0xfffe) this.stateTimer[i]++;
      if (this.age[i] < 0xfffe) this.age[i]++;
    }
  }
}
