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
import { CELLS_PER_CM } from '../scenario';
import {
  Colony,
  STATE_CARRY,
  STATE_REST,
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
import type { PheromoneState } from './pheromone';
import { celestialOf, type DayNightCycle } from '../day-night';

// Circadian modulation (many Formicinae are diurnal; Hölldobler &
// Wilson 1990). At low daylight, ants walk slower, turn less, and
// are much less likely to dig. Baseline minimum keeps them from
// freezing entirely.
const CIRCADIAN_NIGHT_ACTIVITY = 0.25;
function activityOf(daylight: number): number {
  // Smooth lerp from night baseline to full daytime activity.
  return CIRCADIAN_NIGHT_ACTIVITY + (1 - CIRCADIAN_NIGHT_ACTIVITY) * daylight;
}

/**
 * Dig-pheromone tuning. A dig event deposits a strong signal (1.0);
 * the field diffuses slowly and evaporates on a ~5 s timescale so
 * the gradient persists long enough for other ants to follow but
 * doesn't linger past the relevance of a particular worksite.
 */
const PHEROMONE_DEPOSIT_DIG = 1.0;
const PHEROMONE_DIFFUSE = 0.04;
const PHEROMONE_EVAP = 0.985;
const PHEROMONE_FOLLOW_STRENGTH = 0.35;

// All physical-distance constants below are expressed in cm; the
// resolved scenario's CELLS_PER_CM converts them to cells at the
// only place each is used. Hard-coding distances in cells makes
// behaviour silently break when the grid resolution changes
// (e.g. at CELLS_PER_CM=40 a 30-cell recall radius is only 0.75 cm,
// which trapped ants in the spawn chamber).
const REST_CROWD_RADIUS_CM = 0.5;
const REST_PROB_PER_TICK = 0.012;
const REST_DURATION_TICKS = 30;
const FORAGING_RECALL_DIST_CM = 1.5;
const FORAGING_RECALL_STRENGTH = 0.05;

// Thigmotaxis (wall-following). Ants preferentially walk along
// surfaces (Dussutour et al. 2005). We sample one cell out on each
// of the 8 compass directions; where solid is found, we bias the
// heading to run PARALLEL to that surface instead of either ramming
// it or flying off into open space.
const THIGMOTAXIS_PROBE_CM = 0.05;
const THIGMOTAXIS_STRENGTH = 0.12;

/**
 * Returns a heading adjustment (in radians) that pulls the ant
 * toward running alongside the nearest wall. 0 if no wall is close.
 * Works for any body orientation.
 */
function thigmotaxisBias(world: World, x: number, y: number, heading: number): number {
  // Check a ring of 8 sample points at probe radius; find the
  // closest solid direction.
  let wallAngle = NaN;
  let closest = Infinity;
  const probe = THIGMOTAXIS_PROBE_CM * CELLS_PER_CM;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const sx = x + Math.cos(a) * probe;
    const sy = y + Math.sin(a) * probe;
    const ix = sx | 0;
    const iy = sy | 0;
    if (!world.inBounds(ix, iy)) continue;
    const k2 = world.cells[world.index(ix, iy)];
    if (k2 === 1 /* SOIL */ || k2 === 2 /* GRAIN */) {
      // Distance weight = probe distance (we're just picking the
      // closest-angle match; use 1 here since all probes are same
      // radius).
      if (1 < closest) {
        closest = 1;
        wallAngle = a;
      }
    }
  }
  if (Number.isNaN(wallAngle)) return 0;
  // Two tangent directions run 90° from the wall normal. Pick the
  // one closer to the current heading so the ant doesn't U-turn.
  const t1 = wrapAngle(wallAngle + Math.PI / 2);
  const t2 = wrapAngle(wallAngle - Math.PI / 2);
  const d1 = Math.abs(wrapAngle(t1 - heading));
  const d2 = Math.abs(wrapAngle(t2 - heading));
  const tangent = d1 < d2 ? t1 : t2;
  return wrapAngle(tangent - heading) * THIGMOTAXIS_STRENGTH;
}

/**
 * Sample the pheromone gradient at (x, y) by central differences
 * on the current buffer; return a heading that points up the
 * gradient, weighted by magnitude. Returns NaN if the gradient is
 * effectively zero.
 */
function pheromoneGradientHeading(dig: { sample: (x: number, y: number) => number }, x: number, y: number): { angle: number; magnitude: number } {
  const ix = x | 0;
  const iy = y | 0;
  const dx = dig.sample(ix + 1, iy) - dig.sample(ix - 1, iy);
  const dy = dig.sample(ix, iy + 1) - dig.sample(ix, iy - 1);
  const mag = Math.hypot(dx, dy);
  if (mag < 1e-4) return { angle: 0, magnitude: 0 };
  return { angle: Math.atan2(dy, dx), magnitude: mag };
}

export function stepSimulation(
  world: World,
  colony: Colony,
  rng: RNG,
  slabThicknessCm = 0.8,
  pheromones?: PheromoneState,
  cycle?: DayNightCycle,
): void {
  world.tickCount++;

  // Circadian activity multiplier, 0..1 (actually clamped to
  // [CIRCADIAN_NIGHT_ACTIVITY, 1]). Applied to walkSpeed / dig
  // probability / turn noise so ants slow and quiet at night.
  const activity = cycle ? activityOf(celestialOf(world.tickCount, cycle).daylight) : 1;

  // Diffuse + evaporate pheromones (pre-step so ants sample the
  // decayed-but-not-yet-deposited state — the field represents the
  // recent past).
  if (pheromones) {
    pheromones.dig.step(PHEROMONE_DIFFUSE, PHEROMONE_EVAP);
  }

  for (let i = 0; i < colony.count; i++) {
    colony.prevX[i] = colony.posX[i];
    colony.prevY[i] = colony.posY[i];
    colony.prevZ[i] = colony.posZ[i];
    colony.prevHeading[i] = colony.heading[i];
  }

  for (let i = 0; i < colony.count; i++) {
    const state = colony.state[i];
    let h = colony.heading[i];
    const speed = colony.walkSpeedCellsPerTick[i]! * activity;
    const noise = colony.turnNoiseRadPerTick[i]! * activity;
    const digProb = colony.digProbPerSoilHit[i]! * activity;

    // REST: stay put; exit after REST_DURATION_TICKS.
    if (state === STATE_REST) {
      if (colony.stateTimer[i]! >= REST_DURATION_TICKS) {
        colony.setState(i, STATE_WANDER);
        // Kick heading to a fresh direction so we don't drop
        // straight back into the neighbours we were trying to
        // escape.
        colony.heading[i] = rng.range(0, Math.PI * 2);
      }
      continue;
    }

    // Response-threshold task allocation (Beshers & Fewell 2001).
    // Count neighbours within a small radius; compute
    // P(engage REST) = s² / (s² + θ²) · throttle.
    // Applies to WANDER ants only — a carrying ant powers through.
    if (state === STATE_WANDER) {
      let crowd = 0;
      const ax = colony.posX[i]!;
      const ay = colony.posY[i]!;
      const rCells = REST_CROWD_RADIUS_CM * CELLS_PER_CM;
      const rCells2 = rCells * rCells;
      for (let j = 0; j < colony.count; j++) {
        if (j === i) continue;
        const dx = colony.posX[j]! - ax;
        const dy = colony.posY[j]! - ay;
        if (dx * dx + dy * dy <= rCells2) {
          crowd++;
        }
      }
      if (crowd > 0) {
        const theta = colony.restThreshold[i]!;
        const s = crowd;
        const p = (s * s) / (s * s + theta * theta) * REST_PROB_PER_TICK;
        if (rng.next() < p) {
          colony.setState(i, STATE_REST);
          // Snap to a flat resting pose. Real ants don't sleep
          // standing on their gaster pointed at the sky — they
          // lower their bodies parallel to the substrate. We pick
          // whichever horizontal heading (0 or π) is closer to the
          // ant's current direction so the transition isn't jarring.
          const hh = colony.heading[i]!;
          colony.heading[i] = Math.abs(hh) < Math.PI / 2 ? 0 : Math.PI;
          continue;
        }
      }
    }

    // Heading update.
    // WANDER + pheromone: pull toward dig pheromone gradient
    // (stigmergy — Deneubourg & Goss 1989). Ants preferentially
    // join existing dig sites instead of exploring at random.
    if (state === STATE_WANDER && pheromones) {
      const g = pheromoneGradientHeading(pheromones.dig, colony.posX[i]!, colony.posY[i]!);
      if (g.magnitude > 0) {
        const bias = Math.min(0.5, g.magnitude) * PHEROMONE_FOLLOW_STRENGTH;
        const dh = wrapAngle(g.angle - h);
        h += dh * bias;
      }
    }
    // Above-surface return: WANDER ants whose y is above the
    // natural surface (i.e., walking on the grass / hunting in the
    // sky) get a STRONG heading bias toward straight-down. Surface
    // is foreign territory; the colony lives below ground. Without
    // this, ants surface to deposit grain and then wander on the
    // grass for hundreds of ticks before drifting back down,
    // burning the cycles that would otherwise be excavation.
    // 0.6 per tick almost-snaps the heading down within a few
    // ticks — fast enough that surface time is brief, slow enough
    // that the path looks like an arc, not a teleport.
    if (state === STATE_WANDER) {
      const ix = colony.posX[i]! | 0;
      const surfY = world.naturalSurface[ix]!;
      if (colony.posY[i]! < surfY) {
        const want = Math.PI / 2; // straight down
        const dh = wrapAngle(want - h);
        h += dh * 0.6;
      }
    }
    // Foraging-recall (longer-range, lateral): WANDER ants far from
    // their home spawn get a gentler nudge back toward home in
    // both x and y. Real foragers patrol around the nest, not
    // off into infinity.
    if (state === STATE_WANDER) {
      const hxV = colony.homeX[i]!;
      const hyV = colony.homeY[i]!;
      const mag = Math.hypot(hxV, hyV);
      const recallCells = FORAGING_RECALL_DIST_CM * CELLS_PER_CM;
      if (mag > recallCells) {
        const want = Math.atan2(hyV, hxV);
        const dh = wrapAngle(want - h);
        const k = Math.min(1, (mag - recallCells) / recallCells);
        h += dh * (FORAGING_RECALL_STRENGTH * k);
      }
    }
    // Thigmotaxis (Dussutour et al. 2005): ants prefer to walk along
    // walls rather than through open space. Applies to WANDER ants;
    // CARRY ants are already goal-directed by path integration.
    if (state === STATE_WANDER) {
      h += thigmotaxisBias(world, colony.posX[i]!, colony.posY[i]!, h);
    }
    if (state === STATE_CARRY) {
      // Carriers head UP to the surface to deposit excavation spoil
      // outside the nest (this is spoil disposal, not foraging
      // return — bringing dirt INTO the nest would defeat the
      // point). The home vector (used by the UI for "X cm from
      // home") still updates but doesn't drive heading.
      //
      // Lateral nudge toward home-x: an ant whose home is offset
      // horizontally biases its surface-heading toward that x so
      // grain piles cluster near the entrance instead of spreading
      // wherever the ant happened to be when it dug.
      const homeXAhead = Math.abs(colony.homeX[i]!) > 2 ? Math.sign(colony.homeX[i]!) * 0.6 : 0;
      const want = Math.atan2(-1, homeXAhead);
      const dh = wrapAngle(want - h);
      h += dh * CONFIG.carryUpBias;
    }
    h += rng.gauss() * noise;
    h = wrapAngle(h);
    colony.heading[i] = h;

    // Movement. Sub-stepped at ≤1 cell per check so we never skip
    // over a soil interface (the previous 2-half-step approach
    // missed soil contacts at any speed > 2 cells/tick: ants flew
    // through walls without registering a hit, so they couldn't
    // dig).
    let nx = colony.posX[i];
    let ny = colony.posY[i];
    let hitSoil = false;
    const subSteps = Math.max(2, Math.ceil(speed));
    const stepLen = speed / subSteps;
    for (let step = 0; step < subSteps; step++) {
      const dx = Math.cos(h) * stepLen;
      const dy = Math.sin(h) * stepLen;
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
          // Pheromone: deposit a strong dig signal at the dig site
          // so other WANDER ants can find it via gradient.
          if (pheromones) {
            pheromones.dig.deposit(target.x, target.y, PHEROMONE_DEPOSIT_DIG);
          }
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

  // Collision avoidance with z dimension.
  //
  // For each pair of ants closer than ~1 body length in xy:
  //   - if their z are close too (would actually touch), push
  //     them apart in z (they pass in depth).
  //   - additionally give each ant a small heading deflection away
  //     from the neighbour so they can also steer around in xy.
  // Plus a small per-tick z noise so ants don't settle into a
  // single plane. z is bounded to [0.05, slab-0.05] so ants don't
  // clip the glass.
  const zMax = Math.max(0.1, slabThicknessCm - 0.05);
  const zMin = 0.05;
  const collideRcells = 0.06 * CELLS_PER_CM; // 0.06 cm
  const collideRz = 0.3;                     // z radius in cm
  for (let i = 0; i < colony.count; i++) {
    // Spontaneous z drift.
    colony.posZ[i] += rng.gauss() * 0.015;
    if (colony.posZ[i]! < zMin) colony.posZ[i] = zMin;
    if (colony.posZ[i]! > zMax) colony.posZ[i] = zMax;
  }
  for (let i = 0; i < colony.count; i++) {
    const ix = colony.posX[i]!;
    const iy = colony.posY[i]!;
    const iz = colony.posZ[i]!;
    for (let j = i + 1; j < colony.count; j++) {
      const dx = colony.posX[j]! - ix;
      const dy = colony.posY[j]! - iy;
      const dz = colony.posZ[j]! - iz;
      const xyDist2 = dx * dx + dy * dy;
      if (xyDist2 > collideRcells * collideRcells) continue;
      if (Math.abs(dz) > collideRz) continue;
      // They're close in xy and close in z. Nudge z apart — the
      // side with the LARGER current z gets pushed more positive,
      // the smaller gets more negative. Symmetric total-z conserved.
      const sign = dz >= 0 ? 1 : -1;
      const push = 0.04;
      colony.posZ[j] = Math.min(zMax, Math.max(zMin, colony.posZ[j]! + sign * push));
      colony.posZ[i] = Math.min(zMax, Math.max(zMin, colony.posZ[i]! - sign * push));
      // Heading deflect in xy away from the other ant.
      const xyDist = Math.sqrt(xyDist2) + 1e-6;
      const away = Math.atan2(-dy / xyDist, -dx / xyDist);
      const steer = 0.06;
      colony.heading[i] = wrapAngle(
        colony.heading[i]! + wrapAngle(away - colony.heading[i]!) * steer,
      );
      colony.heading[j] = wrapAngle(
        colony.heading[j]! + wrapAngle((away + Math.PI) - colony.heading[j]!) * steer,
      );
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
