// Movement + gravity primitives. Two invariants:
//   1. No embedded ants: tryStep refuses to step into solid (SOIL or GRAIN).
//   2. No flying ants: end-of-tick settle drops unsupported ants by 1 cell.
// Stair-step lifts ants over short grain piles (otherwise a single grain
// on the surface forms an impassable wall and freezes traffic).

import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from './world';

export function isSupported(world: World, ix: number, iy: number): boolean {
  if (iy + 1 >= world.height) return true;
  const w = world.width;
  const idxBelow = (iy + 1) * w + ix;
  const below = world.cells[idxBelow]!;
  if (below === CELL_SOIL || below === CELL_GRAIN) return true;
  if (ix > 0) {
    const bl = world.cells[idxBelow - 1]!;
    if (bl === CELL_SOIL || bl === CELL_GRAIN) return true;
  }
  if (ix < w - 1) {
    const br = world.cells[idxBelow + 1]!;
    if (br === CELL_SOIL || br === CELL_GRAIN) return true;
  }
  return false;
}

export interface StepResult {
  x: number;
  y: number;
  hitSoil: boolean;
}

/**
 * Try to move from (x, y) by (dx, dy). Returns the new position (unchanged
 * if refused) and whether soil was hit (the dig logic uses this signal).
 *
 * Refused on: out-of-bounds, soil, or grain that's too tall to climb.
 * GRAIN within MAX_CLIMB cells of the destination triggers a stair-step
 * lift instead of a refusal.
 */
export function tryStep(
  world: World, x: number, y: number, dx: number, dy: number,
): StepResult {
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) {
    return { x, y, hitSoil: false };
  }
  const ix = nx | 0;
  const iy = ny | 0;
  const k = world.cells[iy * world.width + ix]!;
  if (k === CELL_AIR) return { x: nx, y: ny, hitSoil: false };
  if (k === CELL_SOIL) return { x, y, hitSoil: true };
  // CELL_GRAIN — try to climb.
  const MAX_CLIMB = 2;
  const cx = x | 0;
  const cy = y | 0;
  for (let dh = 1; dh <= MAX_CLIMB; dh++) {
    const probeIy = iy - dh;
    const headIy = cy - dh;
    if (probeIy < 0 || headIy < 0) break;
    const upK = world.cells[probeIy * world.width + ix]!;
    const headK = world.cells[headIy * world.width + cx]!;
    if (upK === CELL_AIR && headK === CELL_AIR) {
      return { x: nx, y: ny - dh, hitSoil: false };
    }
    if (upK === CELL_SOIL) break;
  }
  return { x, y, hitSoil: false };
}

/**
 * One-cell-per-tick gravity. Extricate from any solid the ant ended up
 * inside (e.g. dug cell that was just filled), then drop one row if
 * unsupported AND the ant didn't already climb upward this tick.
 *
 * The "didn't climb upward" caveat is critical. Without it, gravity
 * drops a cell each tick while movement only buys ~0.4 cells of
 * upward travel — net descent. CARRY ants stranded mid-chamber can't
 * climb to the surface and never deposit, freezing the colony in
 * permanent CARRY. Ants that DID move upward this tick are presumed
 * to be actively climbing or scrambling and aren't subjected to a
 * gravity tick that frame; the next stationary tick will catch them
 * if they end up unsupported.
 *
 * Walking off a ledge still produces visible falls: a horizontally-
 * moving ant won't have a negative dy and so gravity kicks in.
 */
export function settle(world: World, ix: number, iy: number, climbedUp: boolean): number {
  while (iy >= 0 && iy < world.height) {
    const k = world.cells[iy * world.width + ix]!;
    if (k !== CELL_SOIL && k !== CELL_GRAIN) break;
    iy--;
  }
  if (iy < 0) iy = 0;
  if (!climbedUp && iy + 1 < world.height && !isSupported(world, ix, iy)) iy++;
  return iy;
}
