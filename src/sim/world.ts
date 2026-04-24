// 2D world grid: vertical cross-section. Origin top-left; y grows downward.
//
// Cells are a single enum. Everything above the "natural surface" row
// (set at generate-time) is sky; below is soil (before excavation) or
// whatever the ants have carved. We store the natural surface per
// column so the renderer can distinguish sky-air from tunnel-air
// later, and so the grass band sits at a stable depth even when ants
// dig above it.

import { CONFIG } from '../config';
import type { RNG } from './rng';

export const CELL_AIR = 0;
export const CELL_SOIL = 1;
export const CELL_GRAIN = 2;
export const CELL_BOUNDARY = 3;

export type CellKind =
  | typeof CELL_AIR
  | typeof CELL_SOIL
  | typeof CELL_GRAIN
  | typeof CELL_BOUNDARY;

export class World {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  readonly grainAmount: Uint8Array;
  readonly surfaceMound: Uint16Array;
  readonly naturalSurface: Uint16Array; // per-column y of original surface
  readonly soilNoise: Uint8Array;       // per-cell 0..255 for render texture
  initialSoilCells = 0;
  tickCount = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint8Array(width * height);
    this.grainAmount = new Uint8Array(width * height);
    this.surfaceMound = new Uint16Array(width);
    this.naturalSurface = new Uint16Array(width);
    this.soilNoise = new Uint8Array(width * height);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): CellKind {
    if (!this.inBounds(x, y)) return CELL_BOUNDARY;
    return this.cells[y * this.width + x] as CellKind;
  }

  isAir(x: number, y: number): boolean {
    return this.get(x, y) === CELL_AIR;
  }

  isSolid(x: number, y: number): boolean {
    const k = this.get(x, y);
    return k === CELL_SOIL || k === CELL_GRAIN;
  }

  /**
   * Generate a world: air above a wavy surface line, soil below.
   * A small starter chamber is carved at world centre so the colony
   * has a room to spawn into (no embedded ants at t=0).
   */
  generate(rng: RNG): void {
    const surfaceBase = Math.floor(this.height * CONFIG.surfaceFraction);
    const amp1 = CONFIG.surfaceRoughness;
    const amp2 = Math.max(1, Math.floor(amp1 * 0.5));
    const phase = rng.range(0, Math.PI * 2);
    let soilCount = 0;

    for (let x = 0; x < this.width; x++) {
      const surface =
        surfaceBase +
        Math.round(Math.sin(x * 0.07 + phase) * amp1) +
        Math.round(Math.sin(x * 0.21 + phase * 1.7) * amp2);
      this.naturalSurface[x] = surface;
      for (let y = 0; y < this.height; y++) {
        if (y < surface) {
          this.cells[y * this.width + x] = CELL_AIR;
        } else {
          this.cells[y * this.width + x] = CELL_SOIL;
          soilCount++;
        }
      }
    }

    // Carve a starter chamber at world centre. Trapezoidal: wider at
    // the top, narrower at the bottom, so ants have a clear floor to
    // stand on.
    const cx = Math.floor(this.width / 2);
    const halfW = CONFIG.starterChamberHalfWidth;
    const depth = CONFIG.starterChamberDepth;
    for (let dx = -halfW; dx <= halfW; dx++) {
      const taper = 1 - Math.abs(dx) / (halfW + 1);
      const dDepth = Math.round(depth * taper);
      for (let dy = 1; dy <= dDepth; dy++) {
        const x = cx + dx;
        const y = surfaceBase + dy;
        if (this.inBounds(x, y) && this.cells[this.index(x, y)] === CELL_SOIL) {
          this.cells[this.index(x, y)] = CELL_AIR;
          soilCount--;
        }
      }
    }

    // Soil noise for render texture; deterministic from the rng.
    for (let i = 0; i < this.soilNoise.length; i++) {
      this.soilNoise[i] = (rng.next() * 256) | 0;
    }

    this.initialSoilCells = soilCount;
  }

  countSoil(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL_SOIL) n++;
    }
    return n;
  }

  countGrains(): number {
    let n = 0;
    for (let i = 0; i < this.grainAmount.length; i++) {
      n += this.grainAmount[i];
    }
    return n;
  }

  /** y of the topmost solid cell in column x, or `height` if none. */
  surfaceY(x: number): number {
    if (x < 0 || x >= this.width) return this.height;
    for (let y = 0; y < this.height; y++) {
      const k = this.cells[y * this.width + x];
      if (k === CELL_SOIL || k === CELL_GRAIN) return y;
    }
    return this.height;
  }
}
