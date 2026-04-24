// Scalar pheromone field: a grid-shaped Float32Array with diffusion
// and exponential evaporation per tick. Models stigmergic
// communication a la Deneubourg & Goss 1989 — ants deposit at cells
// they visit/dig; over time the field spreads and fades, giving
// other ants a gradient to follow.
//
// Ping-pong buffered so diffusion never samples mid-update state
// (CLAUDE.md invariant).

export class PheromoneField {
  readonly width: number;
  readonly height: number;
  /** Deposits add here. Reads happen here too (reads pre-step values). */
  current: Float32Array;
  /** Scratch buffer for the diffusion pass; swapped at the end of step(). */
  scratch: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.current = new Float32Array(width * height);
    this.scratch = new Float32Array(width * height);
  }

  deposit(x: number, y: number, amount: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.current[y * this.width + x]! += amount;
  }

  sample(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.current[y * this.width + x]!;
  }

  /**
   * Advance one tick: 5-tap diffusion (self + 4 cardinal neighbours)
   * followed by exponential evaporation. Boundaries clamp to self.
   *
   * @param diffuseFraction how much of each cell's value diffuses to
   *   each cardinal neighbour (total diffuse = 4×). 0 = no spread,
   *   typical ~0.05.
   * @param evaporation multiplier per tick (e.g. 0.98 = 2%
   *   decay/tick). Pheromone below `snap` is zeroed so the field
   *   stays sparse.
   */
  step(diffuseFraction: number, evaporation: number, snap = 1e-4): void {
    const w = this.width;
    const h = this.height;
    const src = this.current;
    const dst = this.scratch;
    const keep = 1 - 4 * diffuseFraction;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const self = src[idx]!;
        const up = y > 0 ? src[idx - w]! : self;
        const dn = y < h - 1 ? src[idx + w]! : self;
        const lt = x > 0 ? src[idx - 1]! : self;
        const rt = x < w - 1 ? src[idx + 1]! : self;
        let v = (keep * self + diffuseFraction * (up + dn + lt + rt)) * evaporation;
        if (v < snap) v = 0;
        dst[idx] = v;
      }
    }
    // Swap.
    this.current = dst;
    this.scratch = src;
  }

  clear(): void {
    this.current.fill(0);
    this.scratch.fill(0);
  }
}

/** Bundle of the fields a sim needs. Currently just one: dig recruitment. */
export interface PheromoneState {
  /** Deposited by digging ants; attracts WANDER ants to excavation. */
  dig: PheromoneField;
}

export function createPheromones(w: number, h: number): PheromoneState {
  return { dig: new PheromoneField(w, h) };
}
