// Pheromone fields. CPU-only implementation (SPEC §6.4 / Phase 3).
//
// Two scalar fields share the same grid as the world:
//   - dig pheromone (short-lived, drives stigmergic excavation)
//   - construction pheromone (longer-lived, biases grain deposition)
//
// Each tick: diffuse + evaporate. Agents deposit additively at integer cells.

import { SIM } from '../config';

export class PheromoneField {
  readonly width: number;
  readonly height: number;
  readonly evap: number;
  readonly diffuseFraction: number;

  // Two buffers for ping-ponging the diffusion pass.
  private current: Float32Array;
  private scratch: Float32Array;

  constructor(width: number, height: number, evap: number, diffuseFraction: number) {
    this.width = width;
    this.height = height;
    this.evap = evap;
    this.diffuseFraction = diffuseFraction;
    this.current = new Float32Array(width * height);
    this.scratch = new Float32Array(width * height);
  }

  get values(): Readonly<Float32Array> {
    return this.current;
  }

  sample(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.current[y * this.width + x];
  }

  deposit(x: number, y: number, amount: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.current[y * this.width + x] += amount;
  }

  clear(): void {
    this.current.fill(0);
    this.scratch.fill(0);
  }

  /**
   * Single diffusion + evaporation pass.
   *
   * 5-tap stencil: each cell gets (1 - diffuseFraction) of itself plus
   * diffuseFraction/4 from each cardinal neighbour, all multiplied by evap.
   *
   * Boundaries treat out-of-bounds as zero (open boundary); this is what
   * we want — pheromone "evaporates" off the edges of the world.
   */
  step(): void {
    const w = this.width;
    const h = this.height;
    const src = this.current;
    const dst = this.scratch;
    const f = this.diffuseFraction;
    const center = (1 - f) * this.evap;
    const side = (f * 0.25) * this.evap;

    for (let y = 0; y < h; y++) {
      const yw = y * w;
      const yUpW = y > 0 ? (y - 1) * w : -1;
      const yDnW = y < h - 1 ? (y + 1) * w : -1;
      for (let x = 0; x < w; x++) {
        const c = src[yw + x];
        const n = yUpW >= 0 ? src[yUpW + x] : 0;
        const s = yDnW >= 0 ? src[yDnW + x] : 0;
        const wv = x > 0 ? src[yw + x - 1] : 0;
        const e = x < w - 1 ? src[yw + x + 1] : 0;
        const v = center * c + side * (n + s + wv + e);
        // Snap microscopic values to zero — keeps the field genuinely sparse
        // and lets renderer's "is anything here?" early-out kick in.
        dst[yw + x] = v < 1e-4 ? 0 : v;
      }
    }
    // Swap buffers.
    this.current = dst;
    this.scratch = src;
  }
}

export interface FieldsState {
  dig: PheromoneField;
  construction: PheromoneField;
}

export function createFields(width: number, height: number): FieldsState {
  return {
    dig: new PheromoneField(width, height, SIM.digPheromoneEvap, SIM.digPheromoneDiffuse),
    construction: new PheromoneField(
      width,
      height,
      SIM.constructionPheromoneEvap,
      SIM.constructionPheromoneDiffuse,
    ),
  };
}
