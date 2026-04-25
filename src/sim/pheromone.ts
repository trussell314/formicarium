// Pheromone field — environment, not agent. A scalar Float32 per cell
// that diffuses to neighbours and evaporates each tick. Agents read
// it (gradient sampling) and write it (deposit on dig / on grain
// placement). The dynamics are the standard reaction-diffusion model
// used for ant stigmergy:
//
//   Grassé, P-P. (1959). La reconstruction du nid et les
//     coordinations inter-individuelles chez Bellicositermes...
//   Bonabeau, E., Theraulaz, G., Deneubourg, J-L., Aron, S. and
//     Camazine, S. (1997). Self-organization in social insects.
//     Trends Ecol. Evol. 12: 188–193.
//   Deneubourg, J-L., Goss, S. (1989). Collective patterns and
//     decision-making. Ethol. Ecol. Evol. 1: 295–311.
//
// The 5-point stencil is the discretised heat equation on a regular
// grid; evaporation models the volatile chemical's degradation. The
// ping-pong of two arrays is the standard way to avoid sampling and
// writing the same texture in one pass.

export class Pheromone {
  readonly width: number;
  readonly height: number;
  /** Current concentration field. Read by agents and by step(). */
  current: Float32Array;
  /** Scratch buffer written by step(); swapped with current at end. */
  private scratch: Float32Array;
  /** Fraction of each cell's value that diffuses to its 4-neighbours
   *  in one tick. 0.10–0.20 is the typical literature range. */
  readonly diffuse: number;
  /** Multiplier applied per cell per tick. evap ∈ (0, 1). 0.99 gives
   *  a half-life of ~69 ticks. */
  readonly evaporate: number;

  constructor(width: number, height: number, diffuse: number, evaporate: number) {
    this.width = width;
    this.height = height;
    this.current = new Float32Array(width * height);
    this.scratch = new Float32Array(width * height);
    this.diffuse = diffuse;
    this.evaporate = evaporate;
  }

  /**
   * Advance one tick: 5-point diffusion + multiplicative evaporation.
   * Edge cells just evaporate (no diffusion partner outside the
   * grid). Sub-1e-6 values clamp to zero to keep sparse regions
   * sparse and avoid denormal-float drag.
   */
  step(): void {
    const w = this.width;
    const h = this.height;
    const src = this.current;
    const dst = this.scratch;
    const f = this.diffuse;
    const f4 = f * 0.25;
    const e = this.evaporate;
    // Interior
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const c = src[i]!;
        const sum = src[i - 1]! + src[i + 1]! + src[i - w]! + src[i + w]!;
        const v = ((1 - f) * c + f4 * sum) * e;
        dst[i] = v < 1e-6 ? 0 : v;
      }
    }
    // Edges: pure evaporation (lossy boundary, simplest)
    for (let x = 0; x < w; x++) {
      const top = src[x]! * e;
      const bot = src[(h - 1) * w + x]! * e;
      dst[x] = top < 1e-6 ? 0 : top;
      dst[(h - 1) * w + x] = bot < 1e-6 ? 0 : bot;
    }
    for (let y = 1; y < h - 1; y++) {
      const left = src[y * w]! * e;
      const right = src[y * w + w - 1]! * e;
      dst[y * w] = left < 1e-6 ? 0 : left;
      dst[y * w + w - 1] = right < 1e-6 ? 0 : right;
    }
    // Swap
    this.current = dst;
    this.scratch = src;
  }

  /** Add `amount` to the cell at (x, y). No-op for out-of-bounds. */
  deposit(x: number, y: number, amount: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.current[y * this.width + x]! += amount;
  }

  /** Concentration at integer (x, y). Zero outside the grid. */
  sample(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.current[y * this.width + x]!;
  }

  /**
   * Gradient at (x, y) by central differences. Returns the vector
   * pointing UP the gradient (so an ant heading toward this vector
   * climbs the concentration). At the grid edge the missing
   * neighbour is treated as zero.
   */
  gradient(x: number, y: number): { dx: number; dy: number } {
    const xL = this.sample(x - 1, y);
    const xR = this.sample(x + 1, y);
    const yU = this.sample(x, y - 1);
    const yD = this.sample(x, y + 1);
    return { dx: xR - xL, dy: yD - yU };
  }
}
