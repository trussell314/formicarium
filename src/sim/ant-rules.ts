// Per-tick agent rules. SPEC §6.

import { SIM } from '../config';
import {
  Colony,
  STATE_CARRY,
  STATE_DIG,
  STATE_REST,
  STATE_WANDER,
} from './colony';
import {
  CELL_AIR,
  CELL_GRAIN,
  CELL_SOIL,
  World,
} from './world';
import type { FieldsState } from './fields';
import type { RNG } from './rng';

const TWO_PI = Math.PI * 2;

function wrapAngle(a: number): number {
  if (a > Math.PI) return a - TWO_PI;
  if (a < -Math.PI) return a + TWO_PI;
  return a;
}

/**
 * Sample dig pheromone gradient as seen from (x, y) facing `heading`.
 * Returns a heading delta to bias the ant toward higher pheromone.
 *
 * Uses three taps: ahead, ahead-left, ahead-right. The gradient between
 * them controls turn direction. This is cheap and avoids a full O(N^2)
 * arc sample.
 */
function pheromoneTurnBias(
  field: { sample: (x: number, y: number) => number },
  x: number,
  y: number,
  heading: number,
  radius: number,
): number {
  const ax = x + Math.cos(heading) * radius;
  const ay = y + Math.sin(heading) * radius;
  const lh = heading - 0.6;
  const rh = heading + 0.6;
  const lx = x + Math.cos(lh) * radius;
  const ly = y + Math.sin(lh) * radius;
  const rx = x + Math.cos(rh) * radius;
  const ry = y + Math.sin(rh) * radius;

  const fa = field.sample(ax | 0, ay | 0);
  const fl = field.sample(lx | 0, ly | 0);
  const fr = field.sample(rx | 0, ry | 0);

  // If front cell is strongest, no bias.
  // Otherwise turn toward the stronger flank.
  const diff = fr - fl;
  // Magnitude of the turn scales with field magnitude relative to ahead.
  const total = fa + fl + fr + 1e-3;
  return (diff / total) * SIM.pheromoneFollowStrength;
}

/**
 * Find a soil neighbour to dig. Returns one of the 4-cardinal neighbours
 * picked by a weighted score: prefers neighbours in the heading direction,
 * with chamber-widening bias toward lateral neighbours when local exposure
 * is high.
 *
 * Returns null if the ant is not currently next to any soil.
 */
function pickDigTarget(
  world: World,
  x: number,
  y: number,
  heading: number,
  rng: RNG,
): { nx: number; ny: number } | null {
  const ix = x | 0;
  const iy = y | 0;

  // Candidate offsets and base directional weights (forward bias).
  const candidates: Array<{ dx: number; dy: number; w: number }> = [];
  const dirs = [
    { dx: 1, dy: 0, ang: 0 },
    { dx: -1, dy: 0, ang: Math.PI },
    { dx: 0, dy: 1, ang: Math.PI / 2 },
    { dx: 0, dy: -1, ang: -Math.PI / 2 },
  ];
  for (const d of dirs) {
    const nx = ix + d.dx;
    const ny = iy + d.dy;
    if (!world.inBounds(nx, ny)) continue;
    if (world.cells[world.index(nx, ny)] !== CELL_SOIL) continue;
    // Forward bias: alignment with heading in [0..1].
    const align = Math.cos(wrapAngle(d.ang - heading));
    let w = Math.max(0.1, 0.5 + 0.5 * align);

    // Chamber-widening: if this soil cell has high exposure, give a strong
    // boost when it is lateral (dy === 0).
    const exposure = world.exposure[world.index(nx, ny)];
    if (exposure > SIM.chamberExposureThreshold && d.dy === 0) {
      w += SIM.chamberLateralBias;
    }
    // Slight gravity preference for downward digging in fresh soil so shafts
    // form rather than purely horizontal scrapes.
    if (d.dy === 1 && exposure < SIM.chamberExposureThreshold) {
      w += 0.15;
    }
    candidates.push({ dx: d.dx, dy: d.dy, w });
  }
  if (candidates.length === 0) return null;

  let total = 0;
  for (const c of candidates) total += c.w;
  let r = rng.next() * total;
  for (const c of candidates) {
    r -= c.w;
    if (r <= 0) return { nx: ix + c.dx, ny: iy + c.dy };
  }
  const last = candidates[candidates.length - 1]!;
  return { nx: ix + last.dx, ny: iy + last.dy };
}

/**
 * Returns true if the cell at (ix, iy) is "exposed" — i.e., it is soil
 * and at least one neighbour is air. Used to update the exposure field.
 */
function isExposedSoil(world: World, ix: number, iy: number): boolean {
  if (world.cells[world.index(ix, iy)] !== CELL_SOIL) return false;
  if (world.get(ix - 1, iy) === CELL_AIR) return true;
  if (world.get(ix + 1, iy) === CELL_AIR) return true;
  if (world.get(ix, iy - 1) === CELL_AIR) return true;
  if (world.get(ix, iy + 1) === CELL_AIR) return true;
  return false;
}

/**
 * Update the exposure field for cells adjacent to (ix, iy). We only
 * touch cells in a 3x3 around the change site, so this is cheap to call
 * after every dig.
 */
function bumpExposureAround(world: World, ix: number, iy: number): void {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = ix + dx;
      const y = iy + dy;
      if (!world.inBounds(x, y)) continue;
      if (world.cells[world.index(x, y)] !== CELL_SOIL) continue;
      if (isExposedSoil(world, x, y)) {
        world.exposure[world.index(x, y)] += 1;
      }
    }
  }
}

/**
 * Per-tick global decay on the exposure field. We don't iterate every cell
 * every tick because that would cost width*height each frame — instead we
 * decay only the cells around recent agent positions. But we do a cheap
 * stochastic global sweep occasionally.
 */
function decayExposureLocal(world: World, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ix = (x + dx) | 0;
      const iy = (y + dy) | 0;
      if (!world.inBounds(ix, iy)) continue;
      const v = world.exposure[world.index(ix, iy)];
      if (v > 0) world.exposure[world.index(ix, iy)] = v * 0.999;
    }
  }
}

/**
 * Try to step an ant from (x, y) by (dx, dy). Returns the new (x, y)
 * (clamped to bounds and the soil/grain frontier) and reports whether
 * a collision-with-soil happened so the caller can decide to dig.
 */
function tryStep(
  world: World,
  x: number,
  y: number,
  dx: number,
  dy: number,
): { x: number; y: number; hitSoil: boolean } {
  const nx = x + dx;
  const ny = y + dy;
  // Out-of-bounds: stay put. (We used to clamp into the world here, but
  // that could land the ant inside a solid edge cell.)
  if (nx < 0 || nx >= world.width || ny < 0 || ny >= world.height) {
    return { x, y, hitSoil: false };
  }
  // Solid: stay put, mark hit.
  const k = world.cells[world.index(nx | 0, ny | 0)];
  if (k === CELL_SOIL || k === CELL_GRAIN) {
    return { x, y, hitSoil: k === CELL_SOIL };
  }
  return { x: nx, y: ny, hitSoil: false };
}

/**
 * Try to deposit a grain near the carrier's current cell. Returns the
 * (x, y) cell where the grain was placed, or null if no suitable cell
 * was found this tick (the ant should keep walking).
 *
 * Selection rule:
 *   - Look for an air cell at (cx, cy) such that the cell directly below
 *     is solid (CELL_SOIL or CELL_GRAIN) and the column's mound height is
 *     under the cap.
 *   - First check the ant's current cell, then a small radius around it.
 *   - If the column is in the air ABOVE the surface, prefer dropping at
 *     the air cell directly atop the surface to grow the entrance mound.
 */
function tryDepositGrain(
  world: World,
  fields: FieldsState,
  ix: number,
  iy: number,
  rng: RNG,
): { x: number; y: number } | null {
  // Drops only happen on top of the column's topmost solid cell — never
  // mid-tunnel. This keeps grain piles to the entrance mound and prevents
  // grain from being deposited under a chamber ceiling (which would embed
  // the carrier).
  //
  // We also require the ant to be near the surface (within a few cells of
  // the column's surfaceY), so a deep-tunnel carrier walks itself out
  // before dropping.
  const place = (x: number, y: number): { x: number; y: number } => {
    world.cells[world.index(x, y)] = CELL_GRAIN;
    world.grainAmount[world.index(x, y)]++;
    world.surfaceMound[x]++;
    fields.construction.deposit(x, y, SIM.constructionPheromoneDeposit);
    return { x, y };
  };
  const tryColumn = (cx: number): { x: number; y: number } | null => {
    if (cx < 0 || cx >= world.width) return null;
    if (world.surfaceMound[cx] >= SIM.grainPileMax) return null;
    const sy = world.surfaceY(cx);
    if (sy <= 0 || sy >= world.height) return null;
    const cy = sy - 1;
    if (world.cells[world.index(cx, cy)] !== CELL_AIR) return null;
    // Carrier must actually be near this column's surface — not far below
    // it inside a tunnel.
    if (iy > cy + 1) return null;
    return place(cx, cy);
  };

  // Try the ant's column first.
  const here = tryColumn(ix);
  if (here !== null) return here;

  // Then scan a small neighbourhood with random side preference.
  for (let r = 1; r <= SIM.grainPileGrowthRadius; r++) {
    const order = rng.bool(0.5) ? [-1, 1] : [1, -1];
    for (const sign of order) {
      const result = tryColumn(ix + sign * r);
      if (result !== null) return result;
    }
  }
  return null;
}

/**
 * Coarse pairwise ant-vs-ant collision detection. We bin ants by integer
 * cell and test only same-cell pairs. This is O(N) average for our densities
 * and avoids quadratic blow-up.
 */
function processAntCollisions(colony: Colony, world: World): void {
  const w = world.width;
  const bins = new Map<number, number[]>();
  for (let i = 0; i < colony.count; i++) {
    const ix = colony.posX[i] | 0;
    const iy = colony.posY[i] | 0;
    const key = iy * w + ix;
    let bin = bins.get(key);
    if (!bin) {
      bin = [];
      bins.set(key, bin);
    }
    bin.push(i);
  }
  for (const bin of bins.values()) {
    if (bin.length < 2) continue;
    for (let a = 0; a < bin.length; a++) {
      for (let b = a + 1; b < bin.length; b++) {
        const i = bin[a]!;
        const j = bin[b]!;
        const dx = colony.posX[j] - colony.posX[i];
        const dy = colony.posY[j] - colony.posY[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < SIM.antRadius * SIM.antRadius * 4) {
          colony.collisionCount[i] += 1;
          colony.collisionCount[j] += 1;
          // Bounce: rotate both headings by ~ pi/2 with random sign.
          colony.heading[i] = wrapAngle(colony.heading[i] + Math.PI);
          colony.heading[j] = wrapAngle(colony.heading[j] + Math.PI);
        }
      }
    }
  }
}

/**
 * Run one full simulation tick. SPEC §6.
 */
export function stepSimulation(
  world: World,
  colony: Colony,
  fields: FieldsState,
  rng: RNG,
): void {
  // 1) Snapshot prev positions for render interpolation.
  for (let i = 0; i < colony.count; i++) {
    colony.prevX[i] = colony.posX[i];
    colony.prevY[i] = colony.posY[i];
  }

  // 2) Diffuse + evaporate pheromone fields.
  fields.dig.step();
  fields.construction.step();

  // 3) Per-ant update.
  for (let i = 0; i < colony.count; i++) {
    const state = colony.state[i];
    const x = colony.posX[i];
    const y = colony.posY[i];

    // REST: just count down and stay put.
    if (state === STATE_REST) {
      if (colony.stateTimer[i] >= SIM.agitationRestTicks) {
        colony.setState(i, STATE_WANDER);
        // Reset collision count after rest so we don't loop straight back.
        colony.collisionCount[i] *= 0.2;
      }
      continue;
    }

    // Heading update — pheromone follow + downward bias + noise.
    let h = colony.heading[i];

    if (state === STATE_WANDER) {
      h += pheromoneTurnBias(fields.dig, x, y, h, SIM.digSensingRadius);
      // Downward bias for empty-handed wanderers (gravity/thermal metaphor).
      h += SIM.downwardBias * Math.sin(Math.PI / 2 - h) * 0.5;
    } else if (state === STATE_CARRY) {
      // Carrying: head up by nudging heading toward -pi/2.
      const dh = wrapAngle(-Math.PI / 2 - h);
      h += dh * SIM.surfaceUpBias;
    }

    // Random heading noise.
    h += rng.gauss() * SIM.turnNoiseRad * 0.4;
    h = wrapAngle(h);
    colony.heading[i] = h;

    // Excavating: dig immediately and skip movement this tick.
    if (state === STATE_DIG) {
      const target = pickDigTarget(world, x, y, h, rng);
      if (target === null) {
        colony.setState(i, STATE_WANDER);
        continue;
      }
      const idx = world.index(target.nx, target.ny);
      world.cells[idx] = CELL_AIR;
      world.exposure[idx] = 0;
      // Drop a dig pheromone marker near the freshly dug face.
      fields.dig.deposit(target.nx, target.ny, SIM.digPheromoneDeposit);
      // Update exposure on neighbours of the dug cell.
      bumpExposureAround(world, target.nx, target.ny);
      // Pick up the grain → CARRY.
      colony.setState(i, STATE_CARRY);
      // Step into the freshly excavated cell so we're not stuck overlapping
      // a soil neighbour.
      colony.posX[i] = target.nx + 0.5;
      colony.posY[i] = target.ny + 0.5;
      continue;
    }

    // Movement step. We move in two half-steps to reduce tunnelling.
    const speed = SIM.antSpeed;
    let nx = x;
    let ny = y;
    let hitSoil = false;

    for (let half = 0; half < 2; half++) {
      const dx = Math.cos(h) * speed * 0.5;
      const dy = Math.sin(h) * speed * 0.5;
      const r = tryStep(world, nx, ny, dx, dy);
      nx = r.x;
      ny = r.y;
      if (r.hitSoil) {
        hitSoil = true;
        // On hit, partially reflect heading along the cell normal — easier
        // in practice to flip a component than compute a true normal.
        const ix = (nx + Math.cos(h)) | 0;
        const iy = (ny + Math.sin(h)) | 0;
        if (world.get(ix, ny | 0) === CELL_SOIL) {
          h = wrapAngle(Math.PI - h); // flip x component
        } else if (world.get(nx | 0, iy) === CELL_SOIL) {
          h = -h; // flip y component
        } else {
          h = wrapAngle(h + Math.PI);
        }
        colony.heading[i] = h;
      }
    }
    colony.posX[i] = nx;
    colony.posY[i] = ny;

    // CARRY: try to drop grain. Conservation requires that we only
    // transition back to WANDER if we actually deposited a grain — otherwise
    // grains would silently vanish.
    if (state === STATE_CARRY) {
      const deposited = tryDepositGrain(world, fields, nx | 0, ny | 0, rng);
      if (deposited !== null) {
        colony.setState(i, STATE_WANDER);
        // Step the ant just above the new grain to avoid embedding.
        colony.posY[i] = Math.max(0, deposited.y - 0.5);
        // Head back down to dig again.
        colony.heading[i] = wrapAngle(rng.range(Math.PI * 0.2, Math.PI * 0.8));
      }
      continue;
    }

    // WANDER: maybe transition to DIG if we just hit soil.
    if (state === STATE_WANDER && hitSoil) {
      // Probability of digging scales with local pheromone (positive feedback)
      // and decreases when we're crowded / agitated.
      const p =
        SIM.digProbBase +
        SIM.digProbPheromone * Math.tanh(fields.dig.sample(nx | 0, ny | 0)) -
        SIM.digProbCollisionPenalty * Math.tanh(colony.collisionCount[i] * 0.3);
      if (rng.bool(Math.max(0, Math.min(1, p)))) {
        colony.setState(i, STATE_DIG);
      }
      // Either way, drop a tiny dig pheromone where we touched soil — even
      // failed digs leave a trace (an ant sniffed at the spot).
      fields.dig.deposit(nx | 0, ny | 0, SIM.digPheromoneDeposit * 0.15);
    }

    // Agitation: collisions over threshold → REST.
    if (colony.collisionCount[i] >= SIM.agitationThreshold) {
      colony.setState(i, STATE_REST);
    }

    // Cheap stochastic exposure-decay near this ant.
    if ((i & 7) === 0) {
      decayExposureLocal(world, x, y);
    }
  }

  // 4) Resolve agent-agent collisions.
  processAntCollisions(colony, world);

  // 5) Bookkeeping: decay collision counters, age ants, advance state timers.
  colony.endOfTickBookkeeping();
}

/**
 * Disturbance event — apply mouse-poke effects within radius. SPEC §6.7.
 */
export function applyDisturbance(
  world: World,
  colony: Colony,
  fields: FieldsState,
  cx: number,
  cy: number,
): void {
  const r = SIM.disturbanceRadius;
  const r2 = r * r;
  for (let i = 0; i < colony.count; i++) {
    const dx = colony.posX[i] - cx;
    const dy = colony.posY[i] - cy;
    if (dx * dx + dy * dy <= r2) {
      colony.collisionCount[i] += SIM.disturbanceCollisionBoost;
      // Kick heading away from the poke center.
      colony.heading[i] = wrapAngle(Math.atan2(dy, dx));
    }
  }
  // Boost dig pheromone in a small Gaussian — recruits diggers to the
  // poked area, like ants investigating a disturbance.
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const w = SIM.disturbanceDigPheromoneBoost * Math.exp(-d2 / (r * 0.6));
      fields.dig.deposit((cx + dx) | 0, (cy + dy) | 0, w);
    }
  }
  // Mark world variable as referenced (silences unused-arg lints in future).
  void world;
}
