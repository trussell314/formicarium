// Physics primitives shared between movement and gravity.
//
// A cell (ix, iy) is *supported* if the ant at that cell has something
// solid to stand on or cling to: cell directly below, either lateral
// neighbour, or either below-diagonal. World edges count as solid so
// ants at the bottom row are treated as grounded (they've hit the
// floor of the world).
//
// This is the contract that prevents flying ants. It is enforced in
// two places:
//   1. tryStep refuses to step into an unsupported cell (no walking
//      off a cliff into open air).
//   2. The end-of-tick gravity pass repeats until every ant is
//      either in a supported cell or at the world bottom.
//
// Both use this single predicate so they can never disagree.

import { CELL_GRAIN, CELL_SOIL, World } from './world';

export function isSupported(world: World, ix: number, iy: number): boolean {
  // Bottom of world always grounded.
  if (iy + 1 >= world.height) return true;
  const w = world.width;
  const below = world.cells[(iy + 1) * w + ix]!;
  if (below === CELL_SOIL || below === CELL_GRAIN) return true;
  if (ix > 0) {
    const l = world.cells[iy * w + (ix - 1)]!;
    if (l === CELL_SOIL || l === CELL_GRAIN) return true;
    const bl = world.cells[(iy + 1) * w + (ix - 1)]!;
    if (bl === CELL_SOIL || bl === CELL_GRAIN) return true;
  }
  if (ix < w - 1) {
    const r = world.cells[iy * w + (ix + 1)]!;
    if (r === CELL_SOIL || r === CELL_GRAIN) return true;
    const br = world.cells[(iy + 1) * w + (ix + 1)]!;
    if (br === CELL_SOIL || br === CELL_GRAIN) return true;
  }
  return false;
}

/**
 * Try to move an ant from (x, y) by (dx, dy). Returns the new
 * position (unchanged if the step is refused) plus whether the move
 * was blocked by soil — callers use that signal to decide whether to
 * dig.
 *
 * A step is refused if:
 *   - destination is out of bounds
 *   - destination cell is solid (SOIL or GRAIN)
 *   - destination cell is air but unsupported (no-fly rule)
 */
export function tryStep(
  world: World,
  x: number,
  y: number,
  dx: number,
  dy: number,
): { x: number; y: number; hitSoil: boolean } {
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || nx >= world.width || ny < 0 || ny >= world.height) {
    return { x, y, hitSoil: false };
  }
  const ix = nx | 0;
  const iy = ny | 0;
  const k = world.cells[iy * world.width + ix]!;
  if (k === CELL_SOIL || k === CELL_GRAIN) {
    return { x, y, hitSoil: k === CELL_SOIL };
  }
  if (!isSupported(world, ix, iy)) {
    return { x, y, hitSoil: false };
  }
  return { x: nx, y: ny, hitSoil: false };
}

/**
 * Settle a single ant: extricate from any solid cell it's embedded in,
 * then fall one cell at a time until supported. Returns the new iy.
 *
 * Callers apply this per-ant at the end of each tick so the final
 * state of every tick is physically valid (nothing embedded, nothing
 * floating).
 */
export function settle(world: World, ix: number, iy: number): number {
  // Extricate upward through solid cells.
  while (iy >= 0) {
    const k = world.cells[iy * world.width + ix]!;
    if (k !== CELL_SOIL && k !== CELL_GRAIN) break;
    iy--;
  }
  // Fall until grounded.
  while (iy + 1 < world.height && !isSupported(world, ix, iy)) {
    iy++;
  }
  return iy;
}
