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
 *
 * Note: we do NOT refuse stepping into unsupported air. The
 * end-of-tick gravity settle drops any unsupported ant to its
 * nearest support (with prev-snap to keep the renderer's interp
 * from flashing through midair). Refusing unsupported steps in
 * tryStep was previously trapping ants on tiny diagonal-supported
 * corners — they could see daylight in every direction but every
 * step was "unsupported", so they sat rotating their heads forever.
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
    // Stair-step: a 1-cell-tall obstacle is climbable. If the
    // cell directly above the destination is air AND the ant
    // currently has clearance above its head, lift the ant up
    // by one row instead of refusing the step. Without this,
    // a single grain on the surface forms an impassable wall.
    // Only climbs over GRAIN — soil walls still block (and
    // trigger hitSoil so the ant can dig them out instead).
    if (k === CELL_GRAIN && iy > 0) {
      const upK = world.cells[(iy - 1) * world.width + ix]!;
      const cy = y | 0;
      const headK = cy > 0 ? world.cells[(cy - 1) * world.width + (x | 0)]! : CELL_SOIL;
      if (upK !== CELL_SOIL && upK !== CELL_GRAIN
          && headK !== CELL_SOIL && headK !== CELL_GRAIN) {
        return { x: nx, y: ny - 1, hitSoil: false };
      }
    }
    return { x, y, hitSoil: k === CELL_SOIL };
  }
  return { x: nx, y: ny, hitSoil: false };
}

/**
 * Settle a single ant: extricate from any solid cell it's embedded in,
 * then fall AT MOST ONE cell if currently unsupported. Returns the
 * new iy.
 *
 * Single-cell gravity (vs the old iterative "fall until grounded")
 * means an ant that walks off a ledge takes N ticks to drop N
 * cells, so the renderer's per-tick interpolation shows a real
 * falling arc instead of teleporting them to the bottom in a
 * single frame.
 */
export function settle(world: World, ix: number, iy: number): number {
  // Extricate upward through solid cells.
  while (iy >= 0) {
    const k = world.cells[iy * world.width + ix]!;
    if (k !== CELL_SOIL && k !== CELL_GRAIN) break;
    iy--;
  }
  // Fall ONE cell if unsupported. Multiple ticks of falling produce
  // visible descent; staying transiently unsupported between ticks
  // is fine — the ant is mid-fall.
  if (iy + 1 < world.height && !isSupported(world, ix, iy)) {
    iy++;
  }
  return iy;
}
