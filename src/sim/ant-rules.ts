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
/** Threshold (sample-ticks) at which a wall is "old" enough to lob
 *  out laterally rather than dig past. With EXPOSURE_INTERVAL=8 and
 *  ~30 sim steps/frame, real-world seconds to threshold scale by the
 *  speed slider. Tuned for visible chamber-widening within the first
 *  thousand frames. */
const EXPOSURE_THRESHOLD = 90;

function pickDigTarget(world: World, ix: number, iy: number, h: number): { x: number; y: number } | null {
  const hx = Math.cos(h);
  const hy = Math.sin(h);
  const prefer: [number, number] = Math.abs(hx) > Math.abs(hy)
    ? (hx > 0 ? [1, 0] : [-1, 0])
    : (hy > 0 ? [0, 1] : [0, -1]);
  // Two routes to lateral preference:
  //   1. Shallow depth (≤6 cells below the original surface) — the
  //      classic Tschinkel "fan wider near the top" mechanic.
  //   2. High accumulated exposure on a candidate cell (SPEC §6.5 —
  //      walls that have been air-fronted for a long time are softer
  //      and more easily widened, modelling chamber lobbing.)
  const surf = world.naturalSurface[ix]!;
  const depthBelow = iy - surf;
  let lateral = depthBelow >= 0 && depthBelow < 6;
  if (!lateral) {
    // Check left/right exposure — if any lateral candidate is "old",
    // prefer it over straight ahead.
    const lIdx = world.index(Math.max(0, ix - 1), iy);
    const rIdx = world.index(Math.min(world.width - 1, ix + 1), iy);
    const exL = world.cells[lIdx] === CELL_SOIL ? world.exposure[lIdx]! : 0;
    const exR = world.cells[rIdx] === CELL_SOIL ? world.exposure[rIdx]! : 0;
    if (exL > EXPOSURE_THRESHOLD || exR > EXPOSURE_THRESHOLD) lateral = true;
  }
  const order: ReadonlyArray<readonly [number, number]> = lateral
    ? [prefer, [-1, 0], [1, 0], [0, 1], [0, -1]]
    : [prefer, [0, 1], [1, 0], [-1, 0], [0, -1]];
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
  world: World, ix: number, iy: number, rng: RNG, originX: number,
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
    // Distance-weighted acceptance with mound-height falloff:
    //   - Distance term: 1 / (1 + 0.06 * |cx - originX|) concentrates
    //     spoil over the work zone without losing the lateral spread
    //     when an immediate column is blocked.
    //   - Mound term: 1 / (1 + 0.04 * mound[cx]) discourages an ant
    //     from stacking on an already-tall pile; in real ant farms
    //     spoil disperses sideways rather than spiring straight up.
    //   - Beyond 24 cells the gates lift entirely (graceful fallback
    //     so we never pathologically refuse to deposit).
    const dist = Math.abs(cx - originX);
    const moundH = world.mound[cx]!;
    if (dist <= 24) {
      const p = (1 / (1 + 0.06 * dist)) * (1 / (1 + 0.04 * moundH));
      if (rng.next() > p) return null;
    }
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

/**
 * Sweep the soil cells whose exposure counter we want to advance: any
 * SOIL cell with at least one orthogonal AIR neighbour gains 1.
 * Sampled every EXPOSURE_INTERVAL ticks (not every tick) since the
 * field changes slowly and full-grid scans are cheap but not free.
 */
const EXPOSURE_INTERVAL = 8;
function tickExposure(world: World): void {
  if (world.tick % EXPOSURE_INTERVAL !== 0) return;
  const w = world.width;
  const h = world.height;
  const cells = world.cells;
  const expo = world.exposure;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (cells[i] !== CELL_SOIL) continue;
      const exposed =
        cells[i - 1] === CELL_AIR ||
        cells[i + 1] === CELL_AIR ||
        cells[i - w] === CELL_AIR ||
        cells[i + w] === CELL_AIR;
      if (exposed && expo[i]! < 0xffff) expo[i]!++;
    }
  }
}

export function step(
  world: World,
  colony: Colony,
  rng: RNG,
  params: SimParams = DEFAULT_PARAMS,
  particles?: ParticleSystem,
): void {
  world.tick++;
  tickExposure(world);
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
      // equivalent without modelling thermotaxis. We taper the bias
      // off once the ant is ~15 cells below the original surface so
      // deep chambers tend to widen laterally rather than turn into
      // monolithic vertical shafts (Tschinkel cross-section: shafts
      // narrow with depth, not the other way around).
      const depth = Math.max(0, iy - surfY);
      const dwBias = depth > 15 ? downBias * 0.25 : downBias;
      h += wrapAngle(Math.PI / 2 - h) * dwBias;
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
    // Loaded-ant penalty: CARRY ants haul a grain of substrate that
    // can be a substantial fraction of their body mass, and real
    // foragers measurably slow when laden. Trim 30% off both the
    // sub-step length and the substep count so the cost is real
    // without breaking soil-hit detection.
    const carryFactor = stateIn === STATE_CARRY ? 0.7 : 1.0;
    const localStepLen = stepLen * carryFactor;
    const localSubSteps = stateIn === STATE_CARRY
      ? Math.max(2, Math.ceil(subSteps * carryFactor))
      : subSteps;
    for (let s = 0; s < localSubSteps; s++) {
      const dx = Math.cos(h) * localStepLen;
      const dy = Math.sin(h) * localStepLen;
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
      const target = pickDigTarget(world, ax, ay, h);
      // Refuse to undermine grain: if the cell directly above the
      // dig target is a grain pile, this excavation would leave it
      // floating, which violates the "grain only sits on solid"
      // invariant. Detected here as a guard so we never produce a
      // hovering pile under any combination of biases.
      const undermines = target !== null && target.y > 0
        && world.cells[world.index(target.x, target.y - 1)] === CELL_GRAIN;
      if (target !== null && !undermines) {
        // Exposure scaling: walls that have been air-fronted for a
        // long time are softer (Tschinkel observations) — boost the
        // dig probability above the base value as exposure rises,
        // saturating at +50%. Cells freshly exposed dig at the base
        // rate. This produces visible chamber widening rates
        // accelerating once a wall is established.
        const tIdx = world.index(target.x, target.y);
        const expo = world.exposure[tIdx]!;
        // Two-stage exposure boost. Up to exposure=200 it ramps the
        // dig probability from 1× to 1.5× (the original "soft soil"
        // tier). Past exposure=600 (extremely old wall) it ramps a
        // second time up to 2.0×, modelling that very long-exposed
        // walls in real nests are abandoned and lobbed laterally.
        const stage1 = 0.5 * Math.min(1, expo / 200);
        const stage2 = expo > 200
          ? 0.5 * Math.min(1, (expo - 200) / 400) : 0;
        const expoBoost = 1 + stage1 + stage2;
        if (rng.next() < digProb * expoBoost) {
          world.cells[tIdx] = CELL_AIR;
          world.digTick[tIdx] = world.tick;
          world.exposure[tIdx] = 0;
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
      const dropped = depositGrain(world, cx, cy, rng, colony.lastDigX[i]!);
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

    // End-of-tick settle: extricate + 1-cell gravity. Pass whether
    // the ant moved UP this tick — that suppresses gravity for the
    // tick so climbers can actually reach the surface (without this,
    // CARRY ants get pulled down faster than they can ascend and
    // freeze in a permanent in-flight state).
    const sx = colony.posX[i]! | 0;
    const sy = colony.posY[i]! | 0;
    const climbedUp = colony.posY[i]! < colony.prevY[i]! - 0.05;
    const settled = settle(world, sx, sy, climbedUp);
    if (settled !== sy) {
      colony.posY[i] = settled + 0.5;
    }
  }

  // Pairwise repulsion. Ants in a real farm have body width — they
  // physically obstruct each other at tunnel choke points (Aguilar
  // et al. 2018 "clog control"). Without this they pass through one
  // another like ghosts, which kills the bottleneck dynamic that
  // makes nest excavation interesting. O(n²) is fine at the colony
  // sizes we run (<60 ants).
  const REPEL_R = 1.0;
  const REPEL_R2 = REPEL_R * REPEL_R;
  for (let i = 0; i < colony.count; i++) {
    for (let j = i + 1; j < colony.count; j++) {
      const dx = colony.posX[j]! - colony.posX[i]!;
      const dy = colony.posY[j]! - colony.posY[i]!;
      const d2 = dx * dx + dy * dy;
      if (d2 >= REPEL_R2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const overlap = REPEL_R - d;
      const ux = dx / d;
      const uy = dy / d;
      // Push half the overlap each way; refuse to push an ant into
      // a solid cell (re-validate target cell against world).
      const push = overlap * 0.5;
      const tryMove = (idx: number, mx: number, my: number) => {
        const nx = colony.posX[idx]! + mx;
        const ny = colony.posY[idx]! + my;
        if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) return;
        const k = world.cells[(ny | 0) * world.width + (nx | 0)]!;
        if (k === CELL_SOIL || k === CELL_GRAIN) return;
        colony.posX[idx] = nx;
        colony.posY[idx] = ny;
      };
      tryMove(i, -ux * push, -uy * push);
      tryMove(j,  ux * push,  uy * push);
    }
  }

  // Silence unused-import warnings for symbols we re-export usability.
  void isSupported;
}
