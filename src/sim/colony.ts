// Struct-of-arrays agent storage. Per CLAUDE.md, never an array of class
// instances — parallel TypedArrays so iteration is hot-loop friendly and
// the renderer can sweep them as arrays.

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
  /** X column where the most recent dig happened, used by CARRY ants to
   *  bias their deposit search back toward the active work zone. */
  readonly lastDigX: Int16Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.heading = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.lastDigX = new Int16Array(capacity);
    this.stateTicks = new Int32Array(capacity);
  }

  spawn(x: number, y: number, heading: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.posX[i] = x;
    this.posY[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.heading[i] = heading;
    this.state[i] = STATE_WANDER;
    this.lastDigX[i] = x | 0;
    this.stateTicks[i] = 0;
    return i;
  }

  setState(i: number, s: AntState): void {
    this.state[i] = s;
    this.stateTicks[i] = 0;
  }

  /** Spawn `n` ants in random AIR cells inside the given inclusive rect. */
  spawnInRect(
    x0: number, y0: number, x1: number, y1: number,
    n: number, rng: RNG, isAir: (x: number, y: number) => boolean,
  ): number {
    let placed = 0;
    let tries = 0;
    while (placed < n && tries < n * 50) {
      tries++;
      const x = rng.range(x0, x1);
      const y = rng.range(y0, y1);
      if (!isAir(x | 0, y | 0)) continue;
      this.spawn(x, y, rng.range(0, Math.PI * 2));
      placed++;
    }
    return placed;
  }
}
