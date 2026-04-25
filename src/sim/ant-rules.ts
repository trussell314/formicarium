// Per-tick agent behaviour. Two states:
//   WANDER — random walk with downward bias; on soil contact, dig with
//            probability `digProb` and transition to CARRY. On dig, the
//            cell becomes AIR and the ant slides into it.
//   CARRY  — head up to the natural surface and deposit a grain.
//            Deposit constraints (see depositGrain) keep grain ABOVE the
//            original surface and only on supported columns, so spoil
//            never piles up inside the chamber and never floats.
//
// No pheromones, no foraging, no day/night yet. The MVP target is
// "watch the chamber visibly grow", and every additional state is a new
// way for ants to get stuck not digging.

import { Colony, STATE_CARRY, STATE_WANDER, type AntState } from './colony';
import type { ParticleSystem } from './particles';
import { isSupported, settle, tryStep } from './physics';
import type { RNG } from './rng';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from './world';

export interface SimParams {
  /** Cells/tick walking speed. Sub-stepped so ants don't tunnel through soil. */
  walkSpeed: number;
  /** Per-tick std-dev of heading noise (radians). */
  turnNoise: number;
  /** P(dig) per soil contact. */
  digProb: number;
  /** Magnitude of the downward heading bias on WANDER ants in chamber air. */
  downBias: number;
  /** Magnitude of the upward heading bias on CARRY ants. */
  upBias: number;
}

export const DEFAULT_PARAMS: SimParams = {
  walkSpeed: 0.6,
  turnNoise: 0.25,
  digProb: 0.6,
  downBias: 0.15,
  upBias: 0.5,
};

const TWO_PI = Math.PI * 2;

function wrapAngle(a: number): number {
  if (a > Math.PI) return a - TWO_PI;
  if (a < -Math.PI) return a + TWO_PI;
  return a;
}

/** Pick a soil cell adjacent to (ix, iy) to excavate, preferring the
 *  heading direction. Returns null if no orthogonal neighbour is soil. */
function pickDigTarget(world: World, ix: number, iy: number, h: number): { x: number; y: number } | null {
  const hx = Math.cos(h);
  const hy = Math.sin(h);
  const prefer: [number, number] = Math.abs(hx) > Math.abs(hy)
    ? (hx > 0 ? [1, 0] : [-1, 0])
    : (hy > 0 ? [0, 1] : [0, -1]);
  const order: ReadonlyArray<readonly [number, number]> = [
    prefer,
    [0, 1], [1, 0], [-1, 0], [0, -1],
  ];
  for (const [dx, dy] of order) {
    const x = ix + dx;
    const y = iy + dy;
    if (!world.inBounds(x, y)) continue;
    if (world.cells[world.index(x, y)] === CELL_SOIL) return { x, y };
  }
  return null;
}

/**
 * Find a column close to `ix` where a fresh grain can sit on a solid
 * support, ABOVE the natural surface, with the ant currently within
 * arm's reach. Returns the placement cell, or null if none in radius.
 *
 * Two non-obvious constraints, both hard-learned:
 *   - cy must be at or above naturalSurface[col] - mound[col] - 1, never
 *     deeper. This is what keeps grain piling on top of the ground
 *     instead of dropping inside the chamber.
 *   - cells[cy + 1] must be solid. Without this, depositors on chamber
 *     columns place grain above the chamber air, and that grain hovers
 *     unsupported with no path back down.
 */
function depositGrain(
  world: World, ix: number, iy: number,
): { x: number; y: number } | null {
  const SEARCH_RADIUS = 64;
  const tryColumn = (cx: number): { x: number; y: number } | null => {
    if (cx < 0 || cx >= world.width) return null;
    const surfRow = world.naturalSurface[cx]!;
    const cy = surfRow - 1 - world.mound[cx]!;
    if (cy <= 0 || cy >= world.height) return null;
    if (world.cells[world.index(cx, cy)] !== CELL_AIR) return null;
    const below = world.cells[world.index(cx, cy + 1)];
    if (below !== CELL_SOIL && below !== CELL_GRAIN) return null;
    // Ant must be near (vertically) — within 3 cells.
    if (iy < cy - 3 || iy > cy + 3) return null;
    world.cells[world.index(cx, cy)] = CELL_GRAIN;
    world.mound[cx] = (world.mound[cx] ?? 0) + 1;
    return { x: cx, y: cy };
  };
  for (let r = 0; r <= SEARCH_RADIUS; r++) {
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

export function step(
  world: World,
  colony: Colony,
  rng: RNG,
  params: SimParams = DEFAULT_PARAMS,
  particles?: ParticleSystem,
): void {
  world.tick++;
  const { walkSpeed, turnNoise, digProb, downBias, upBias } = params;
  if (particles) particles.step();
  const subSteps = Math.max(2, Math.ceil(walkSpeed));
  const stepLen = walkSpeed / subSteps;

  for (let i = 0; i < colony.count; i++) {
    colony.prevX[i] = colony.posX[i]!;
    colony.prevY[i] = colony.posY[i]!;
    let h = colony.heading[i]!;
    const stateIn: AntState = colony.state[i] as AntState;
    const ix = colony.posX[i]! | 0;
    const iy = colony.posY[i]! | 0;
    const surfY = world.naturalSurface[ix]!;
    const belowSurface = iy >= surfY;

    // Heading update: state-specific bias + Gaussian noise.
    if (stateIn === STATE_WANDER) {
      // Downward bias keeps wanderers in the chamber, lightly. Real
      // ants are attracted to the substrate; this is the moral
      // equivalent without modelling thermotaxis.
      h += wrapAngle(Math.PI / 2 - h) * downBias;
    } else {
      // CARRY heads up to the surface to dump the grain. Lateral
      // bias toward the ORIGINAL dig column biases the ant to come
      // up over the work site, so spoil mounds form over the
      // actual excavation rather than scattering across the surface.
      const dx = colony.lastDigX[i]! - colony.posX[i]!;
      const want = Math.atan2(-1, Math.max(-2, Math.min(2, dx * 0.05)));
      h += wrapAngle(want - h) * upBias;
    }
    h += rng.gauss() * turnNoise;
    h = wrapAngle(h);
    colony.heading[i] = h;

    // Movement. Sub-stepped at <=1 cell per probe — the renderer's
    // own interpolation between prev and current handles the sub-tick
    // animation, but the sim still needs accurate soil-contact
    // detection.
    let nx = colony.posX[i]!;
    let ny = colony.posY[i]!;
    let hitSoil = false;
    for (let s = 0; s < subSteps; s++) {
      const dx = Math.cos(h) * stepLen;
      const dy = Math.sin(h) * stepLen;
      const r = tryStep(world, nx, ny, dx, dy);
      nx = r.x;
      ny = r.y;
      if (r.hitSoil) {
        hitSoil = true;
        // Bounce: rotate by 90-180 degrees so the ant doesn't keep
        // pressing into the same spot every tick.
        h = wrapAngle(h + Math.PI * (0.5 + rng.next() * 0.5));
        colony.heading[i] = h;
      }
    }
    colony.posX[i] = nx;
    colony.posY[i] = ny;

    const ax = nx | 0;
    const ay = ny | 0;

    // WANDER → DIG → CARRY transition.
    if (stateIn === STATE_WANDER && hitSoil && belowSurface) {
      if (rng.next() < digProb) {
        const target = pickDigTarget(world, ax, ay, h);
        if (target !== null) {
          const idx = world.index(target.x, target.y);
          world.cells[idx] = CELL_AIR;
          world.digTick[idx] = world.tick;
          colony.posX[i] = target.x + 0.5;
          colony.posY[i] = target.y + 0.5;
          colony.setState(i, STATE_CARRY);
          colony.lastDigX[i] = target.x;
          // Head straight up after digging.
          colony.heading[i] = -Math.PI / 2 + rng.range(-0.3, 0.3);
          // Spawn a small puff of dust so the dig is visible to the
          // user as a discrete event rather than just a tint change.
          if (particles) {
            for (let p = 0; p < 3; p++) {
              const a = rng.range(-Math.PI, 0);
              const sp = rng.range(0.05, 0.18);
              particles.spawn(
                target.x + 0.5,
                target.y + 0.3,
                Math.cos(a) * sp,
                Math.sin(a) * sp - 0.05,
                28 + (rng.next() * 16) | 0,
              );
            }
          }
        }
      }
    }

    // CARRY → maybe deposit.
    if (colony.state[i] === STATE_CARRY) {
      const cx = colony.posX[i]! | 0;
      const cy = colony.posY[i]! | 0;
      const dropped = depositGrain(world, cx, cy);
      if (dropped !== null) {
        colony.setState(i, STATE_WANDER);
        // Hop to the cell directly above the new grain, then head
        // back into the nest. Without this the ant would re-enter
        // the deposit search next tick and either re-deposit on
        // top of itself or get bounced off its own pile.
        const ny2 = Math.max(0, dropped.y - 1);
        colony.posY[i] = ny2 + 0.5;
        colony.heading[i] = Math.PI / 2 + rng.range(-0.3, 0.3);
      }
    }

    // End-of-tick settle: extricate + 1-cell gravity.
    const sx = colony.posX[i]! | 0;
    const sy = colony.posY[i]! | 0;
    const settled = settle(world, sx, sy);
    if (settled !== sy) {
      colony.posY[i] = settled + 0.5;
    }
  }

  // Silence unused-import warnings for symbols we re-export usability.
  void isSupported;
}
