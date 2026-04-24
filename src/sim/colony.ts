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
  /** Stable per-ant ID, equal to spawn index; never reused. */
  readonly id: Uint32Array;

  // Per-ant tunable behaviour, set at spawn time. Different castes
  // (workers, scouts, queens) can have different values.
  readonly walkSpeedCellsPerTick: Float32Array;
  readonly digProbPerSoilHit: Float32Array;
  readonly turnNoiseRadPerTick: Float32Array;
  /** 1 = winged (bypasses gravity), 0 = walking. */
  readonly winged: Uint8Array;

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
    this.id = new Uint32Array(capacity);
    this.walkSpeedCellsPerTick = new Float32Array(capacity);
    this.digProbPerSoilHit = new Float32Array(capacity);
    this.turnNoiseRadPerTick = new Float32Array(capacity);
    this.winged = new Uint8Array(capacity);
  }

  /** Defaults used when spawn() is called without a behaviour spec. */
  static readonly DEFAULT_BEHAVIOUR = {
    walkSpeedCellsPerTick: 0.08,
    digProbPerSoilHit: 0.035,
    turnNoiseRadPerTick: 0.15,
    winged: 0,
  };

  spawn(
    x: number,
    y: number,
    heading: number,
    behaviour?: Partial<{
      walkSpeedCellsPerTick: number;
      digProbPerSoilHit: number;
      turnNoiseRadPerTick: number;
      winged: number;
    }>,
  ): number | null {
    if (this.count >= this.capacity) return null;
    const i = this.count++;
    this.posX[i] = x;
    this.posY[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.heading[i] = heading;
    this.state[i] = STATE_WANDER;
    this.stateTimer[i] = 0;
    this.id[i] = i;
    this.walkSpeedCellsPerTick[i] =
      behaviour?.walkSpeedCellsPerTick ?? Colony.DEFAULT_BEHAVIOUR.walkSpeedCellsPerTick;
    this.digProbPerSoilHit[i] =
      behaviour?.digProbPerSoilHit ?? Colony.DEFAULT_BEHAVIOUR.digProbPerSoilHit;
    this.turnNoiseRadPerTick[i] =
      behaviour?.turnNoiseRadPerTick ?? Colony.DEFAULT_BEHAVIOUR.turnNoiseRadPerTick;
    this.winged[i] = behaviour?.winged ?? Colony.DEFAULT_BEHAVIOUR.winged;
    return i;
  }

  /**
   * Snapshot of ant `i` for debug / logging. Floats truncated to a
   * sensible precision. Cheap; allocates a small object.
   */
  inspect(i: number): {
    id: number;
    x: number;
    y: number;
    heading: number;
    state: AntState;
    stateTicks: number;
  } {
    return {
      id: this.id[i]!,
      x: Math.round(this.posX[i]! * 100) / 100,
      y: Math.round(this.posY[i]! * 100) / 100,
      heading: Math.round(this.heading[i]! * 100) / 100,
      state: this.state[i] as AntState,
      stateTicks: this.stateTimer[i]!,
    };
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
    behaviour?: Partial<{
      walkSpeedCellsPerTick: number;
      digProbPerSoilHit: number;
      turnNoiseRadPerTick: number;
      winged: number;
    }>,
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
      if (this.spawn(x, y, h, behaviour) === null) break;
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
