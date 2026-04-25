// 2D vertical cross-section of the formicarium. Origin top-left, y grows down.
// Cells are AIR / SOIL / GRAIN. The ant farm "glass" is implicit — cells
// outside the grid are treated as solid in physics.

import type { RNG } from './rng';

export const CELL_AIR = 0;
export const CELL_SOIL = 1;
export const CELL_GRAIN = 2;

export type CellKind = 0 | 1 | 2;

export class World {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  /** Per-column y of the original natural surface (top-most soil at t=0). */
  readonly naturalSurface: Uint16Array;
  /** Per-column count of grain cells stacked above the natural surface. */
  readonly mound: Uint16Array;
  /** Per-cell hash noise for renderer texture. Deterministic from rng. */
  readonly soilNoise: Uint8Array;
  /** Tick at which each cell was last carved (for "fresh dig" highlight). */
  readonly digTick: Int32Array;
  /**
   * Cumulative exposure: how many sample-ticks each soil cell has had
   * with at least one air neighbour. Drives chamber-widening: walls
   * exposed for a long time are more likely to be lobbed sideways
   * (Tschinkel) than freshly-fronted soil. Saturates at 0xffff so we
   * don't have to worry about Int32 wraparound on long runs.
   */
  readonly exposure: Uint16Array;
  initialSoilCells = 0;
  tick = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint8Array(width * height);
    this.naturalSurface = new Uint16Array(width);
    this.mound = new Uint16Array(width);
    this.soilNoise = new Uint8Array(width * height);
    this.digTick = new Int32Array(width * height);
    this.digTick.fill(-1_000_000);
    this.exposure = new Uint16Array(width * height);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /**
   * Generate a wavy soil surface and a small starter chamber at the centre.
   * The starter chamber is a trapezoid wider at top, so ants spawn into a
   * floor they can stand on.
   */
  generate(
    rng: RNG,
    surfaceRow: number,
    chamberHalfWidth: number,
    chamberDepth: number,
  ): void {
    const phase = rng.range(0, Math.PI * 2);
    const amp1 = Math.max(1, Math.floor(this.height * 0.015));
    const amp2 = Math.max(1, Math.floor(amp1 * 0.5));

    let soil = 0;
    for (let x = 0; x < this.width; x++) {
      const wave =
        Math.round(Math.sin(x * 0.07 + phase) * amp1) +
        Math.round(Math.sin(x * 0.21 + phase * 1.7) * amp2);
      const sy = Math.max(2, Math.min(this.height - 4, surfaceRow + wave));
      this.naturalSurface[x] = sy;
      for (let y = 0; y < this.height; y++) {
        if (y < sy) {
          this.cells[y * this.width + x] = CELL_AIR;
        } else {
          this.cells[y * this.width + x] = CELL_SOIL;
          soil++;
        }
      }
    }

    // Starter divot — a small circular pocket the colony has to break
    // out of. The legacy wide trapezoid gave ants too much pre-carved
    // real estate to lazily widen; this version forces tunnel
    // formation by giving them barely enough room to spawn into.
    // chamberHalfWidth / chamberDepth are repurposed as size hints.
    const cx = this.width >> 1;
    const divotRadius = Math.max(4, Math.min(chamberHalfWidth, chamberDepth + 3));
    const divotRadius2 = divotRadius * divotRadius;
    const surfHere = this.naturalSurface[cx]!;
    // Place the divot so most of it sits BELOW the surface line, with
    // just the topmost cell breaking through (so spawned ants are
    // already underground and have walls to dig).
    const centerY = surfHere + divotRadius;
    const x0 = Math.max(0, cx - divotRadius);
    const x1 = Math.min(this.width - 1, cx + divotRadius);
    const yLo = Math.max(0, surfHere);
    const yHi = Math.min(this.height - 1, centerY + divotRadius);
    for (let y = yLo; y <= yHi; y++) {
      for (let x = x0; x <= x1; x++) {
        const ddx = x - cx;
        const ddy = y - centerY;
        if (ddx * ddx + ddy * ddy > divotRadius2) continue;
        const idx = y * this.width + x;
        if (this.cells[idx] === CELL_SOIL) {
          this.cells[idx] = CELL_AIR;
          soil--;
        }
      }
    }
    void chamberDepth;

    for (let i = 0; i < this.soilNoise.length; i++) {
      this.soilNoise[i] = (rng.next() * 256) | 0;
    }
    this.initialSoilCells = soil;
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
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL_GRAIN) n++;
    }
    return n;
  }
}
