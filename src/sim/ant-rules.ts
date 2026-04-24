// Per-tick ant behaviour.
//
// Scope is intentionally narrow for the 10-ant restart:
//
//   WANDER  — walk with small heading noise + very mild downward
//             drift (positive thermotaxis toward cooler earth).
//             If movement hits soil, roll digProbPerSoilHit; on
//             success, excavate that cell and pick up a grain.
//   DIG     — (transient, same tick) excavate soil → CARRY.
//   CARRY   — walk with an upward heading bias toward the surface.
//             If the ant is at a surface column it can deposit on,
//             do so and return to WANDER.
//   REST    — reserved; not currently used.
//
// The ant model is inspired by Sudd (1970) and Pasteels & Deneubourg
// (1987): contact-triggered digging with a small per-contact
// probability, and thigmotaxis (wall-following) implicit in the
// movement rule (ants can only step into supported cells, so they
// naturally hug walls).
//
// Every rule here has a dedicated test in tests/. The physics
// invariants (no flying, no embedding) are guaranteed by the shared
// settle() at the end of every tick; callers don't need to think
// about them.

import { CONFIG } from '../config';
import {
  Colony,
  STATE_CARRY,
  STATE_WANDER,
} from './colony';
import {
  CELL_AIR,
  CELL_GRAIN,
  CELL_SOIL,
  World,
} from './world';
import { isSupported, settle, tryStep } from './physics';
import type { RNG } from './rng';

const TWO_PI = Math.PI * 2;

function wrapAngle(a: number): number {
  if (a > Math.PI) return a - TWO_PI;
  if (a < -Math.PI) return a + TWO_PI;
  return a;
}

/**
 * Find a SOIL cell adjacent to (ix, iy) to excavate. Prefers the
 * cell the ant was heading toward; falls back to any orthogonal
 * solid neighbour. Returns null if no soil touches the ant.
 */
function pickDigTarget(world: World, ix: number, iy: number, heading: number): { x: number; y: number } | null {
  // Heading-aligned primary candidate.
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  const prefer = Math.abs(hx) > Math.abs(hy)
    ? (hx > 0 ? [1, 0] : [-1, 0])
    : (hy > 0 ? [0, 1] : [0, -1]);
  const order = [
    prefer,
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  for (const [dx, dy] of order) {
    const x = ix + dx!;
    const y = iy + dy!;
    if (!world.inBounds(x, y)) continue;
    if (world.cells[world.index(x, y)] === CELL_SOIL) return { x, y };
  }
  return null;
}

/**
 * Try to drop a grain at the surface near column ix. Respects the
 * angle-of-repose rule: a column may not be more than
 * grainAngleOfRepose cells taller than its shorter horizontal
 * neighbour. Returns the placement cell or null if no legal spot
 * exists within a small search radius.
 */
function tryDepositGrain(world: World, ix: number, iy: number): { x: number; y: number } | null {
  const tryColumn = (cx: number): { x: number; y: number } | null => {
    if (cx < 0 || cx >= world.width) return null;
    if (world.surfaceMound[cx]! >= CONFIG.grainPileMax) return null;
    // Angle of repose.
    const lm = cx > 0 ? world.surfaceMound[cx - 1]! : world.surfaceMound[cx]!;
    const rm = cx < world.width - 1 ? world.surfaceMound[cx + 1]! : world.surfaceMound[cx]!;
    const minN = lm < rm ? lm : rm;
    if (world.surfaceMound[cx]! >= minN + CONFIG.grainAngleOfRepose) return null;
    // Place on top of the column's current surface.
    const sy = world.surfaceY(cx);
    if (sy <= 0 || sy >= world.height) return null;
    const cy = sy - 1;
    if (world.cells[world.index(cx, cy)] !== CELL_AIR) return null;
    // Ant must be near the drop site (within 2 cells vertically).
    if (iy > cy + 2) return null;
    world.cells[world.index(cx, cy)] = CELL_GRAIN;
    world.grainAmount[world.index(cx, cy)]++;
    world.surfaceMound[cx]++;
    return { x: cx, y: cy };
  };
  // Search own column, then ±1, ±2.
  for (let r = 0; r <= 2; r++) {
    if (r === 0) {
      const here = tryColumn(ix);
      if (here !== null) return here;
    } else {
      const a = tryColumn(ix - r);
      if (a !== null) return a;
      const b = tryColumn(ix + r);
      if (b !== null) return b;
    }
  }
  return null;
}

/**
 * Advance one full simulation tick.
 *
 * Ordering within a tick:
 *   1. prev-pos snapshot (for render interpolation)
 *   2. heading update per ant (state-dependent bias + noise)
 *   3. movement step (half-step × 2 to reduce tunnelling)
 *   4. on-contact: maybe transition WANDER → DIG → CARRY
 *   5. on-carry: maybe deposit and transition CARRY → WANDER
 *   6. end-of-tick settle: extricate + iterative gravity
 *      + snap prev if the total tick motion was large (so the renderer
 *      doesn't interpolate through unsupported mid-tick space)
 */
export function stepSimulation(world: World, colony: Colony, rng: RNG): void {
  world.tickCount++;

  for (let i = 0; i < colony.count; i++) {
    colony.prevX[i] = colony.posX[i];
    colony.prevY[i] = colony.posY[i];
  }

  for (let i = 0; i < colony.count; i++) {
    const state = colony.state[i];
    let h = colony.heading[i];
    const speed = colony.walkSpeedCellsPerTick[i]!;
    const noise = colony.turnNoiseRadPerTick[i]!;
    const digProb = colony.digProbPerSoilHit[i]!;

    // Heading update.
    if (state === STATE_CARRY) {
      // Path integration (Wehner 1996): the home vector points from
      // the ant back toward its spawn point. Bias heading toward
      // that direction so carrying ants return home along an
      // efficient straight line instead of a random walk biased
      // upward. If the ant is very close to home (|home| < 2 cells)
      // the vector is noise-dominated — fall back to "head up"
      // which at least reaches the surface.
      const hxV = colony.homeX[i]!;
      const hyV = colony.homeY[i]!;
      const mag = Math.hypot(hxV, hyV);
      let want: number;
      if (mag > 2) {
        want = Math.atan2(hyV, hxV);
      } else {
        want = -Math.PI / 2;
      }
      const dh = wrapAngle(want - h);
      h += dh * CONFIG.carryUpBias;
    }
    h += rng.gauss() * noise;
    h = wrapAngle(h);
    colony.heading[i] = h;

    // Movement. Two half-steps; heading reflects on a hit so the ant
    // doesn't grind into the wall indefinitely.
    let nx = colony.posX[i];
    let ny = colony.posY[i];
    let hitSoil = false;
    for (let half = 0; half < 2; half++) {
      const dx = Math.cos(h) * speed * 0.5;
      const dy = Math.sin(h) * speed * 0.5;
      const r = tryStep(world, nx, ny, dx, dy);
      nx = r.x;
      ny = r.y;
      if (r.hitSoil) {
        hitSoil = true;
        h = wrapAngle(h + Math.PI * (0.5 + rng.next() * 0.5));
        colony.heading[i] = h;
      }
    }
    colony.posX[i] = nx;
    colony.posY[i] = ny;

    const ix = nx | 0;
    const iy = ny | 0;

    // WANDER + soil contact → maybe dig.
    if (state === STATE_WANDER && hitSoil) {
      if (rng.next() < digProb) {
        const target = pickDigTarget(world, ix, iy, h);
        if (target !== null) {
          world.cells[world.index(target.x, target.y)] = CELL_AIR;
          colony.setState(i, STATE_CARRY);
          // Step into the dug cell.
          colony.posX[i] = target.x + 0.5;
          colony.posY[i] = target.y + 0.5;
          // Head upward (carriers want to reach the surface).
          colony.heading[i] = -Math.PI / 2 + rng.range(-0.6, 0.6);
          // A CARRY ant's target is the nearest surface column, which
          // we don't pre-compute — leave target unset so the UI can
          // describe it generically ("heading up to deposit").
          colony.clearTarget(i);
        }
      }
    }

    // CARRY → maybe deposit.
    if (colony.state[i] === STATE_CARRY) {
      const deposited = tryDepositGrain(world, colony.posX[i]! | 0, colony.posY[i]! | 0);
      if (deposited !== null) {
        colony.setState(i, STATE_WANDER);
        colony.clearTarget(i);
        // Place ant above the new grain.
        const ny2 = deposited.y - 1;
        colony.posY[i] = (ny2 < 0 ? 0 : ny2) + 0.5;
        // Head back down into the nest.
        colony.heading[i] = Math.PI / 2 + rng.range(-0.6, 0.6);
      }
    }
  }

  // End-of-tick settle. Enforces the no-flying-ants invariant and
  // the no-embedded-ants invariant in one pass. Winged ants bypass
  // gravity but still get extricated from solid cells.
  //
  // Prev-snap policy: only snap prev=post-settle when SETTLE itself
  // moved the ant by more than a cell. Normal locomotion (even 10+
  // cells/tick at the scenario's current tick rate) leaves prev as
  // the pre-tick position so the renderer can smoothly interpolate
  // between ticks. The snap still prevents flight-through-air after
  // a rare gravity drop / grain-burial extrication.
  for (let i = 0; i < colony.count; i++) {
    const ix = colony.posX[i]! | 0;
    const preSettleY = colony.posY[i]!;
    let settledIy: number;
    if (colony.winged[i]) {
      // Winged: only extricate, don't fall.
      let iy = preSettleY | 0;
      while (iy >= 0) {
        const k = world.cells[world.index(ix, iy)];
        if (k !== 1 /* SOIL */ && k !== 2 /* GRAIN */) break;
        iy--;
      }
      settledIy = iy;
    } else {
      settledIy = settle(world, ix, preSettleY | 0);
    }
    colony.posY[i] = settledIy + 0.5;
    // Path-integration update: the home vector decays by the tick's
    // total displacement. `prev` was set at start of tick (still
    // the pre-tick position at this moment). Walking right by dx
    // means home is now dx more to the left, so homeX -= dx.
    const tickDx = colony.posX[i]! - colony.prevX[i]!;
    const tickDy = colony.posY[i]! - colony.prevY[i]!;
    colony.homeX[i] -= tickDx;
    colony.homeY[i] -= tickDy;
    // Snap prev=current if settle teleported the ant. This must run
    // AFTER the home-vector update so it reads the real tick motion.
    const settleDelta = Math.abs(colony.posY[i]! - preSettleY);
    if (settleDelta > 1.0) {
      colony.prevX[i] = colony.posX[i]!;
      colony.prevY[i] = colony.posY[i]!;
    }
  }

  colony.tickTimers();
  // Silence unused-import warnings if future code paths drop usage.
  void isSupported;
  void CELL_GRAIN;
}
