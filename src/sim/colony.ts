// Colony — struct-of-arrays storage of all live ants.
//
// Kept minimal for the restart: position (+ previous for render
// interpolation), heading, state, and a state timer. No
// collision counters or agitation — at 10 ants those mechanics don't
// matter and just add noise to tests.

import type { RNG } from './rng';

export const STATE_WANDER = 0;
export const STATE_DIG = 1;
export const STATE_CARRY = 2;
export const STATE_REST = 3;

export type AntState = 0 | 1 | 2 | 3;

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
  }

  spawn(x: number, y: number, heading: number): number | null {
    if (this.count >= this.capacity) return null;
    const i = this.count++;
    this.posX[i] = x;
    this.posY[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.heading[i] = heading;
    this.state[i] = STATE_WANDER;
    this.stateTimer[i] = 0;
    return i;
  }

  /** Spawn n ants uniformly at random within air cells of a rectangle. */
  spawnInRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    n: number,
    rng: RNG,
    isAir: (x: number, y: number) => boolean,
  ): number {
    const candidates: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (isAir(x, y)) candidates.push(x, y);
      }
    }
    if (candidates.length === 0) return 0;
    const cellCount = candidates.length / 2;
    let added = 0;
    for (let k = 0; k < n; k++) {
      const pick = (rng.next() * cellCount) | 0;
      const x = candidates[pick * 2]! + 0.5;
      const y = candidates[pick * 2 + 1]! + 0.5;
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

  tickTimers(): void {
    for (let i = 0; i < this.count; i++) {
      if (this.stateTimer[i]! < 0xfffe) this.stateTimer[i]++;
    }
  }
}
