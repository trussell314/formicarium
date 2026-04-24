// 2D world grid: vertical cross-section. Origin top-left, y increases downward.
// SPEC §5.1.

import { SIM } from '../config';
import type { RNG } from './rng';

export const CELL_AIR = 0;
export const CELL_SOIL = 1;
export const CELL_BOUNDARY = 2;
export const CELL_GRAIN = 3;

export type CellKind = typeof CELL_AIR | typeof CELL_SOIL | typeof CELL_BOUNDARY | typeof CELL_GRAIN;

export class World {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  // Per-cell exposure-time counter — used by chamber-widening rule (SPEC §6.5).
  // Float because we decay it gently when no longer exposed.
  readonly exposure: Float32Array;
  // Per-cell grain count for grain piles.
  readonly grainAmount: Uint8Array;
  // Surface mound height tracking — index by column, value is how many grains
  // are deposited there.
  readonly surfaceMound: Uint16Array;
  // Initial soil cells, used for grain conservation invariant.
  initialSoilCells = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint8Array(width * height);
    this.exposure = new Float32Array(width * height);
    this.grainAmount = new Uint8Array(width * height);
    this.surfaceMound = new Uint16Array(width);
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

  set(x: number, y: number, kind: CellKind): void {
    if (!this.inBounds(x, y)) return;
    this.cells[y * this.width + x] = kind;
  }

  isPassable(x: number, y: number): boolean {
    const k = this.get(x, y);
    return k === CELL_AIR;
  }

  isSoil(x: number, y: number): boolean {
    return this.get(x, y) === CELL_SOIL;
  }

  /**
   * Initialize: air on top, soil below a wavy surface line.
   * Creates a tiny entry slot just below the surface so initial ants have
   * somewhere to start digging.
   */
  generate(rng: RNG): void {
    const surfaceBase = Math.floor(this.height * SIM.surfaceFraction);
    const wave1 = SIM.surfaceRoughness;
    const wave2 = Math.max(1, Math.floor(SIM.surfaceRoughness * 0.5));
    const phase = rng.range(0, Math.PI * 2);
    let soilCount = 0;
    for (let x = 0; x < this.width; x++) {
      const surface =
        surfaceBase +
        Math.round(Math.sin(x * 0.07 + phase) * wave1) +
        Math.round(Math.sin(x * 0.21 + phase * 1.7) * wave2);
      for (let y = 0; y < this.height; y++) {
        const idx = y * this.width + x;
        if (y < surface) {
          this.cells[idx] = CELL_AIR;
        } else {
          this.cells[idx] = CELL_SOIL;
          soilCount++;
        }
      }
    }
    // Carve a small starter divot in the middle so initial wandering ants
    // immediately encounter soil-air interfaces and start digging.
    const cx = Math.floor(this.width / 2);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = 0; dy <= 3; dy++) {
        const x = cx + dx;
        const y = surfaceBase + dy + 1;
        if (this.inBounds(x, y) && this.get(x, y) === CELL_SOIL) {
          this.cells[this.index(x, y)] = CELL_AIR;
          soilCount--;
        }
      }
    }
    // Set after the divot so the conservation invariant
    // (initialSoil === currentSoil + currentGrains + currentCarriers) holds
    // from t=0.
    this.initialSoilCells = soilCount;
  }

  /**
   * Counts soil cells currently in the grid. O(width*height) — only used in
   * tests and stats.
   */
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

  /**
   * Returns surface y at column x — the y of the top-most soil/grain cell.
   * Returns height if column is fully air.
   */
  surfaceY(x: number): number {
    if (x < 0 || x >= this.width) return this.height;
    for (let y = 0; y < this.height; y++) {
      const k = this.cells[y * this.width + x];
      if (k === CELL_SOIL || k === CELL_GRAIN) return y;
    }
    return this.height;
  }
}
