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
  /** Per-cell move counter for GRAIN cells. Set when an ant deposits
   *  a grain (carryMoves + 1) and transferred between cells when the
   *  sandpile cascade slides the grain. Renderer uses it to lerp the
   *  GRAIN colour from undisturbed dark to weathered light: a grain
   *  that has been picked up and re-deposited many times has been
   *  "worked over" and reads visually paler. Zero in non-grain cells. */
  readonly grainMoves: Uint8Array;
  /** Per-cell food (seed) presence. 0 = none, 1 = a seed sits here.
   *  Surface seeds spawn stochastically on intact natural-surface
   *  rows; foragers pick them up and CARRY_FOOD ants deposit them
   *  into below-surface chambers (granaries). */
  readonly food: Uint8Array;
  /** Per-cell food move counter (mirrors grainMoves but for seeds).
   *  Set when an ant deposits a food item; transferred when an
   *  already-deposited food is picked up and re-deposited. Renderer
   *  uses it to lerp food colour from bright green (no moves) to
   *  dark green (moved many times). */
  readonly foodMoves: Uint8Array;
  /** Per-cell corpse marker. 0 = none, 1 = an ant died here. The
   *  body is a draggable item: necrophoresis workers (future) pick
   *  it up and haul it to a midden chamber. Until then the cell
   *  just renders as a dark spot so the viewer can see where the
   *  colony lost workers. Multiple corpses in the same cell are
   *  collapsed to a single marker (we don't track count). */
  readonly corpse: Uint8Array;
  /** Tick at which each cell was last carved (for "fresh dig" highlight). */
  readonly digTick: Int32Array;
  initialSoilCells = 0;
  tick = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint8Array(width * height);
    this.naturalSurface = new Uint16Array(width);
    this.mound = new Uint16Array(width);
    this.soilNoise = new Uint8Array(width * height);
    this.grainMoves = new Uint8Array(width * height);
    this.food = new Uint8Array(width * height);
    this.foodMoves = new Uint8Array(width * height);
    this.corpse = new Uint8Array(width * height);
    this.digTick = new Int32Array(width * height);
    this.digTick.fill(-1_000_000);
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

    // Starter pinhole — modelled on the founding shaft a claustral
    // queen would dig: a single-column vertical tunnel a few cells
    // deep, terminating in a tiny pocket where she'd seal herself
    // in to raise her first brood. This is what a brand-new colony
    // looks like in nature; nothing chamber-shaped is pre-carved.
    // Architecture has to emerge from the agents.
    //   Hölldobler, B., & Wilson, E. O. (1990). The Ants. Belknap.
    //   Ch. 5: claustral colony founding.
    // chamberHalfWidth/chamberDepth args remain in the signature for
    // backwards compatibility with existing tests but are ignored.
    const SHAFT_DEPTH = 5;
    const POCKET_HALF = 1; // 3-cell-wide pocket at the bottom
    const POCKET_HEIGHT = 2;
    const cx = this.width >> 1;
    const surfHere = this.naturalSurface[cx]!;
    // Vertical shaft, 1 cell wide.
    const shaftBottom = Math.min(this.height - 1, surfHere + SHAFT_DEPTH - 1);
    for (let y = surfHere; y <= shaftBottom; y++) {
      const idx = y * this.width + cx;
      if (this.cells[idx] === CELL_SOIL) {
        this.cells[idx] = CELL_AIR;
        soil--;
      }
    }
    // Terminal pocket directly below the shaft.
    const pocketTop = shaftBottom + 1;
    const pocketBot = Math.min(this.height - 1, pocketTop + POCKET_HEIGHT - 1);
    const px0 = Math.max(0, cx - POCKET_HALF);
    const px1 = Math.min(this.width - 1, cx + POCKET_HALF);
    for (let y = pocketTop; y <= pocketBot; y++) {
      for (let x = px0; x <= px1; x++) {
        const idx = y * this.width + x;
        if (this.cells[idx] === CELL_SOIL) {
          this.cells[idx] = CELL_AIR;
          soil--;
        }
      }
    }
    void chamberHalfWidth;
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
