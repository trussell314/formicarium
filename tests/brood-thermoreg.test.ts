// Brood thermoregulation tests (Penick & Tschinkel 2008).
// Eggs migrate one cell per species.broodMigrateInterval toward
// a depth that varies with daylight: shallow at midnight, deep
// at noon. We verify:
//   1. An egg at noon drifts deeper over time, toward broodMaxDepth.
//   2. An egg at midnight drifts shallower over time, toward broodMinDepth.
//   3. An egg blocked by SOIL doesn't tunnel through it.
//   4. The migration is bounded — once at target, no further drift.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_EGG, STATE_LARVA } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, DAY_TICKS, World } from '../src/sim/world';

// Faster migration so a small tick budget produces visible motion.
const FAST_MIGRATE: AntSpecies = {
  ...HARVESTER,
  broodMigrateInterval: 1,   // every tick — for testing only
  // Disable everything that would interfere with a single-egg sim.
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
};

function deepChamberWorld(): World {
  // 40-cell-wide × 80-cell-tall world with surface at row 10 and
  // a 3-cell-wide vertical chamber down column 19..21. Brood
  // migration requires "chamber" cells (lateral non-SOIL neighbour
  // present) — a 1-cell-wide shaft would be rejected as the
  // entrance tunnel, so the test geometry uses a wider corridor
  // to validate the depth-tracking behaviour proper.
  const world = new World(40, 80);
  for (let x = 0; x < 40; x++) world.naturalSurface[x] = 10;
  for (let y = 10; y < 80; y++) {
    for (let x = 0; x < 40; x++) world.cells[world.index(x, y)] = 1; // SOIL
  }
  for (let y = 10; y < 80; y++) {
    for (let x = 19; x <= 21; x++) world.cells[world.index(x, y)] = CELL_AIR;
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

function spawnEgg(c: Colony, x: number, y: number, rng: RNG): void {
  const idx = c.spawn(x, y, 0, rng, {
    digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
  });
  c.state[idx] = STATE_EGG;
  c.stateTicks[idx] = 0;
}

describe('brood thermoregulation', () => {
  it('an egg drifts deeper at noon', () => {
    const rng = new RNG(1);
    const w = deepChamberWorld();
    w.tick = DAY_TICKS / 2 - 1; // step() will increment to noon
    const c = new Colony(1);
    spawnEgg(c, 20.5, 12.5, rng);
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    const startY = c.posY[0]! | 0;
    for (let t = 0; t < 100; t++) step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
    const endY = c.posY[0]! | 0;
    expect(endY).toBeGreaterThan(startY);
  });

  it('an egg drifts shallower at midnight', () => {
    const rng = new RNG(2);
    const w = deepChamberWorld();
    w.tick = -1; // step() bumps to 0 (midnight)
    const c = new Colony(1);
    // Spawn deep so it has to climb up.
    spawnEgg(c, 20.5, 50.5, rng);
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    const startY = c.posY[0]! | 0;
    for (let t = 0; t < 100; t++) step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
    const endY = c.posY[0]! | 0;
    expect(endY).toBeLessThan(startY);
  });

  it('an egg does not tunnel through soil', () => {
    const rng = new RNG(3);
    // Block the path: AIR at y=11, SOIL at y=12, then AIR below (
    // unreachable). Egg at y=11 wants to descend at noon but can't.
    const world = new World(40, 80);
    for (let x = 0; x < 40; x++) world.naturalSurface[x] = 10;
    for (let y = 10; y < 80; y++) {
      for (let x = 0; x < 40; x++) world.cells[world.index(x, y)] = 1;
    }
    world.cells[world.index(20, 11)] = CELL_AIR;
    world.tick = DAY_TICKS / 2 - 1;
    const c = new Colony(1);
    spawnEgg(c, 20.5, 11.5, rng);
    const dig = new Pheromone(world.width, world.height, 0.12, 0.99);
    const build = new Pheromone(world.width, world.height, 0.10, 0.997);
    for (let t = 0; t < 100; t++) step(world, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
    expect(c.posY[0]! | 0).toBe(11);  // didn't move into soil
  });

  it('does not overshoot the target', () => {
    const rng = new RNG(4);
    const w = deepChamberWorld();
    // Hold time at noon so the target stays at broodMaxDepth.
    // Step many migrations and check the egg parks at the target,
    // never going deeper than maxDepth (within 1 cell of rounding).
    w.tick = DAY_TICKS / 2 - 1;
    const c = new Colony(1);
    spawnEgg(c, 20.5, 12.5, rng);
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    for (let t = 0; t < 1000; t++) {
      // Pin tick at noon every step (step() increments world.tick;
      // we revert it to keep daylight constant).
      w.tick = DAY_TICKS / 2 - 1;
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
    }
    const finalDepth = (c.posY[0]! | 0) - 10; // surface row = 10
    expect(finalDepth).toBeLessThanOrEqual(FAST_MIGRATE.broodMaxDepth + 1);
    expect(finalDepth).toBeGreaterThanOrEqual(FAST_MIGRATE.broodMaxDepth - 1);
  });

  it('a larva tracks the diel depth target the same way an egg does', () => {
    // Same noon-deepens / midnight-shallows behaviour applies to
    // larvae. Penick & Tschinkel 2008 actually focused on larva
    // movement; the egg test covers the shared migration path
    // but a larva-specific test locks in that the LARVA state
    // dispatch also runs the migration.
    const rng = new RNG(101);
    const w = deepChamberWorld();
    w.tick = DAY_TICKS / 2 - 1; // step() bumps to noon
    const c = new Colony(1);
    const idx = c.spawn(20.5, 12.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
    });
    c.state[idx] = STATE_LARVA;
    c.stateTicks[idx] = 0;
    c.energy[idx] = 1;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    const startY = c.posY[0]! | 0;
    for (let t = 0; t < 200; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
    }
    const endY = c.posY[0]! | 0;
    expect(endY).toBeGreaterThan(startY);
  });

  it('an egg in a 1-cell-wide entrance shaft will not migrate up the shaft', () => {
    // Real brood stays in chambers, not in connecting tunnels.
    // World: solid soil with a 1-cell-wide vertical shaft from
    // surface to row 30 and a 3-cell-wide pocket at the bottom
    // (rows 30-33 × cols 19-21). Spawn an egg in the pocket bottom
    // (row 33). Run at midnight so the daylight target is
    // broodMinDepth — which the egg should approach from below
    // BUT not by climbing through the 1-wide shaft. It can move
    // up within the pocket but stops at the pocket ceiling.
    const rng = new RNG(5);
    const w = new World(40, 60);
    for (let x = 0; x < 40; x++) w.naturalSurface[x] = 10;
    for (let y = 10; y < 60; y++) {
      for (let x = 0; x < 40; x++) w.cells[w.index(x, y)] = 1;
    }
    // Shaft: column 20, rows 10..29.
    for (let y = 10; y < 30; y++) w.cells[w.index(20, y)] = CELL_AIR;
    // Pocket: rows 30..33, cols 19..21.
    for (let y = 30; y <= 33; y++) {
      for (let x = 19; x <= 21; x++) w.cells[w.index(x, y)] = CELL_AIR;
    }
    w.initialSoilCells = w.countSoil();
    w.tick = -1; // step() bumps to 0 (midnight, lowest target)
    const c = new Colony(1);
    spawnEgg(c, 20.5, 33.5, rng);
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    for (let t = 0; t < 200; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
    }
    // Egg cannot climb above row 30 — that's the top of the pocket;
    // any cell at row 29 is in the 1-wide shaft and is rejected by
    // the chamber-only filter.
    expect(c.posY[0]! | 0).toBeGreaterThanOrEqual(30);
  });
});
