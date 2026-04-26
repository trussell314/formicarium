// Environment dynamics — physics, not behavior. Agents are clients of
// these primitives and cannot break them. Three separate concerns:
//
//   1. Ant kinematics: tryStep enforces "no-fly-through-solid";
//      settle (per ant) implements 1-cell-per-tick gravity for ants
//      that ended a tick unsupported.
//   2. Granular dynamics: placeGrain settles a single grain via the
//      Bak/Tang/Wiesenfeld 1987 sandpile cellular automaton — falls
//      straight down if there's air below, slides diagonally if a
//      lower-side neighbour is air. This makes angle-of-repose an
//      EMERGENT property of the cascade, not a hand-coded check.
//   3. Excavation primitive: digCell removes a soil cell and (if a
//      grain was sitting on top) cascades that grain.
//
// References:
//   Bak, P., Tang, C., Wiesenfeld, K. (1987). Self-organized
//     criticality: An explanation of the 1/f noise. Phys. Rev. Lett.
//     59: 381–384. (The canonical sandpile model.)

import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from './world';
import type { RNG } from './rng';

/**
 * An ant is supported if ANY cell in its 8-neighbourhood is solid.
 * Models tarsal-claw cling: real ants grip walls, floors, ceilings,
 * and overhangs. The free-fall in `settle` only fires when the ant
 * has no adjacent surface at all (e.g., walked off a ledge into open
 * space, or the substrate around it was dug away by a neighbour).
 */
export function isSupported(world: World, ix: number, iy: number): boolean {
  if (iy + 1 >= world.height) return true;
  const w = world.width;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = ix + dx;
      const ny = iy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= world.height) continue;
      const k = world.cells[ny * w + nx]!;
      if (k === CELL_SOIL || k === CELL_GRAIN) return true;
    }
  }
  return false;
}

export interface StepResult {
  x: number;
  y: number;
  hitSoil: boolean;
}

/**
 * Try to move from (x, y) by (dx, dy). Refuses solid (soil, grain).
 * Allows a 2-cell stair-step over grain — real ants cling and climb
 * with their legs; this is the 2D abstraction of that anatomy, not
 * an engineering heuristic. Soil walls still block (and trigger the
 * hitSoil flag so the agent layer can decide whether to dig).
 *
 * Tarsal-claw cling cuts both ways: if the SOURCE cell has no solid
 * 8-neighbour, the ant has no substrate to push against and cannot
 * generate locomotive force. The only motion available is gravity —
 * handled by `settle` at end-of-tick. Without this guard, an ant in
 * mid-air can steer horizontally (or upward) through pure heading
 * advection, producing the "hover and drift" failure mode the user
 * reported.
 */
export function tryStep(
  world: World, x: number, y: number, dx: number, dy: number,
): StepResult {
  const cx = x | 0;
  const cy = y | 0;
  if (!isSupported(world, cx, cy)) {
    // Free fall — locomotion is suppressed; settle handles vertical
    // motion. Returning the original position keeps this an env-level
    // primitive so the agent layer can't bypass it.
    return { x, y, hitSoil: false };
  }
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
  // GRAIN — try to climb up to 2 cells.
  // For an honest stair-step we need (a) the destination cell at
  // the lifted row to be air [upK] and (b) headroom above the ant's
  // origin so it can lift its body before stepping sideways. The
  // headroom check pairs the source row's headIy with the source
  // col cx — both pre-move. This is the geometric condition for
  // the body's diagonal sweep to clear both ceilings.
  const MAX_CLIMB = 2;
  for (let dh = 1; dh <= MAX_CLIMB; dh++) {
    const probeIy = iy - dh;
    const headIy = cy - dh;
    if (probeIy < 0 || headIy < 0) break;
    const upK = world.cells[probeIy * world.width + ix]!;
    const headK = world.cells[headIy * world.width + cx]!;
    if (upK === CELL_AIR && headK === CELL_AIR) {
      return { x: nx, y: ny - dh, hitSoil: false };
    }
    // Stop probing if either the lift-target column has soil above
    // the grain (no climb past it) or the source column does (no
    // headroom). Previously only upK==SOIL broke; a SOIL ceiling at
    // the source could leave the loop running an extra iteration.
    if (upK === CELL_SOIL || headK === CELL_SOIL) break;
  }
  return { x, y, hitSoil: false };
}

/**
 * One-cell-per-tick gravity for an ANT. Extricate from any solid
 * cell first (the cell may have just become solid under it), then
 * drop one row if unsupported. Walking off a ledge produces a
 * visible falling arc rather than a teleport to the floor.
 */
export function settle(world: World, ix: number, iy: number): number {
  while (iy >= 0 && iy < world.height) {
    const k = world.cells[iy * world.width + ix]!;
    if (k !== CELL_SOIL && k !== CELL_GRAIN) break;
    iy--;
  }
  if (iy < 0) iy = 0;
  if (iy + 1 < world.height && !isSupported(world, ix, iy)) iy++;
  return iy;
}

/**
 * Granular settling for a single GRAIN cell at (x, y). Falls straight
 * down through air, then slides diagonally to a lower-side air cell
 * if one exists. Repeats until stable or off-world. Returns the
 * final (x, y). Bak/Tang/Wiesenfeld sandpile cascade — angle-of-
 * repose is emergent, not a hardcoded check.
 *
 * Pre: cells[(x, y)] === CELL_GRAIN.
 */
export function settleGrain(world: World, x: number, y: number, rng: RNG): { x: number; y: number } {
  const w = world.width;
  const h = world.height;
  while (true) {
    if (y + 1 >= h) break;
    const belowIdx = (y + 1) * w + x;
    if (world.cells[belowIdx] === CELL_AIR) {
      world.cells[y * w + x] = CELL_AIR;
      world.cells[belowIdx] = CELL_GRAIN;
      y++;
      continue;
    }
    // Diagonal slide. A grain sitting on a sloped support slumps
    // sideways if the diagonal-down neighbour is air. This is what
    // makes the pile shape converge to angle-of-repose without an
    // explicit rule.
    const dl = x > 0 && world.cells[(y + 1) * w + x - 1] === CELL_AIR
      && world.cells[y * w + x - 1] === CELL_AIR;
    const dr = x < w - 1 && world.cells[(y + 1) * w + x + 1] === CELL_AIR
      && world.cells[y * w + x + 1] === CELL_AIR;
    if (!dl && !dr) break;
    let goLeft: boolean;
    if (dl && dr) goLeft = rng.next() < 0.5;
    else goLeft = dl;
    world.cells[y * w + x] = CELL_AIR;
    if (goLeft) {
      world.cells[(y + 1) * w + x - 1] = CELL_GRAIN;
      x -= 1;
    } else {
      world.cells[(y + 1) * w + x + 1] = CELL_GRAIN;
      x += 1;
    }
    y += 1;
  }
  return { x, y };
}

/**
 * Recompute world.mound[col] from cell state. Walks up from the
 * natural-surface row, counting consecutive GRAIN cells. Cheap
 * because mounds are short. Always call this on every column the
 * sandpile cascade touched (start AND end of any cross-column slide)
 * — otherwise mound[] drifts and the deposit search falls back to
 * stale data.
 */
export function recomputeMound(world: World, col: number): void {
  if (col < 0 || col >= world.width) return;
  const surfRow = world.naturalSurface[col]!;
  let m = 0;
  for (let yy = surfRow - 1; yy >= 0; yy--) {
    if (world.cells[yy * world.width + col] === CELL_GRAIN) m++;
    else break;
  }
  world.mound[col] = m;
}

/**
 * Place a grain at (x, y) (which must be air) and let it settle via
 * the sandpile rule. Returns the final cell or null if (x, y) wasn't
 * a valid air cell to seed from.
 *
 * Side effect: refreshes world.mound for both the seed column AND
 * the final column (the sandpile cascade can slide diagonally across
 * columns, so both ends of the path may have changed).
 */
export function placeGrain(world: World, x: number, y: number, rng: RNG): { x: number; y: number } | null {
  const idx = y * world.width + x;
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return null;
  if (world.cells[idx] !== CELL_AIR) return null;
  world.cells[idx] = CELL_GRAIN;
  const final = settleGrain(world, x, y, rng);
  recomputeMound(world, x);
  if (final.x !== x) recomputeMound(world, final.x);
  // Increment soil wear in the 8-neighbourhood of the final grain
  // position. Visualises construction halo: soil near active mounds
  // and tunnel mouths fades from dark to weathered over time.
  const w = world.width;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = final.y + dy;
    if (ny < 0 || ny >= world.height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = final.x + dx;
      if (nx < 0 || nx >= w) continue;
      if (dx === 0 && dy === 0) continue;
      const ni = ny * w + nx;
      if (world.cells[ni] !== CELL_SOIL) continue;
      const cur = world.soilWear[ni]!;
      if (cur < 255) world.soilWear[ni] = cur + 1;
    }
  }
  return final;
}

/**
 * Excavate a soil cell at (x, y). Returns true if successful, false
 * if the target wasn't soil. After the dig, any GRAIN cell sitting
 * directly above is destabilised and re-settled (it might fall into
 * the new void). This is the env enforcing physical consistency
 * across cell-state changes — agents don't have to know about it.
 */
export function digCell(world: World, x: number, y: number, rng: RNG): boolean {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return false;
  const idx = y * world.width + x;
  if (world.cells[idx] !== CELL_SOIL) return false;
  world.cells[idx] = CELL_AIR;
  // Stamp the tick so the renderer can briefly glow this cell as
  // "freshly excavated." renderer.ts:163 reads digTick — without
  // this write the highlight never appears.
  world.digTick[idx] = world.tick;
  // A grain directly above might fall into the void. If the
  // cascade slides it sideways, mound[] for both columns needs to
  // be refreshed; otherwise the deposit search uses stale heights.
  if (y > 0) {
    const aboveIdx = idx - world.width;
    if (world.cells[aboveIdx] === CELL_GRAIN) {
      const final = settleGrain(world, x, y - 1, rng);
      recomputeMound(world, x);
      if (final.x !== x) recomputeMound(world, final.x);
    }
  }
  return true;
}

/**
 * Pick up a deposited grain at (x, y). Returns true if successful,
 * false if the target wasn't grain. The cell becomes AIR; the
 * column's mound count is decremented (when the grain was above the
 * natural surface), and any grain that was sitting on top of this
 * one is re-settled.
 *
 * This is the Theraulaz/Bonabeau/Deneubourg 1998 construction-model
 * symmetric counterpart to digCell — real ants both deposit AND
 * pick up grain, and the balance between the two (plus pheromone
 * modulation) is what generates emergent walls and pillars in
 * termite/ant nest construction.
 */
export function pickGrain(world: World, x: number, y: number, rng: RNG): boolean {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return false;
  const idx = y * world.width + x;
  if (world.cells[idx] !== CELL_GRAIN) return false;
  world.cells[idx] = CELL_AIR;
  // Re-settle the grain directly above (it lost its support). If
  // the cascade slid the grain across columns, both columns need
  // a mound refresh — otherwise the deposit search uses stale data.
  let slideDest = -1;
  if (y > 0) {
    const aboveIdx = idx - world.width;
    if (world.cells[aboveIdx] === CELL_GRAIN) {
      const final = settleGrain(world, x, y - 1, rng);
      if (final.x !== x) slideDest = final.x;
    }
  }
  recomputeMound(world, x);
  if (slideDest >= 0) recomputeMound(world, slideDest);
  return true;
}
