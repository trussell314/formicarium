// Brood thermoregulation tests (Penick & Tschinkel 2008).
// Eggs migrate one cell per species.broodMigrateInterval toward
// a depth that varies with daylight: shallow at midnight, deep
// at noon. We verify:
//   1. An egg at noon drifts deeper over time, toward broodMaxDepth.
//   2. An egg at midnight drifts shallower over time, toward broodMinDepth.
//   3. An egg blocked by SOIL doesn't tunnel through it.
//   4. The migration is bounded — once at target, no further drift.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_EGG, STATE_LARVA, STATE_REST } from '../src/sim/colony';
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

/** Spawn a nurse-aged worker at the same cell as the brood. The
 *  brood-migration code requires a nurse within ~3 cells before it
 *  will move the brood — a real-world precondition (Hölldobler &
 *  Wilson 1990 ch. 9). Tests need a co-located nurse to exercise
 *  the migration path. */
function spawnNurse(c: Colony, x: number, y: number, rng: RNG): void {
  const idx = c.spawn(x, y, 0, rng, {
    digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
  });
  c.age[idx] = 0; // pure nurse
  c.energy[idx] = 1;
  // Stay put — without this the WANDER default walks the nurse out
  // of attendant range within a few ticks, the brood is then
  // unattended, gravity drops the egg to the chamber floor, and
  // the thermoreg drift never gets a chance to assert itself.
  // Real attendants don't wander away from a brood pile they're
  // tending; STATE_REST holds them on the brood.
  c.setState(idx, STATE_REST);
}

describe('brood thermoregulation', () => {
  it('an egg drifts deeper at noon', () => {
    const rng = new RNG(1);
    const w = deepChamberWorld();
    w.tick = DAY_TICKS / 2 - 1; // step() will increment to noon
    const c = new Colony(2);
    spawnEgg(c, 20.5, 12.5, rng);
    spawnNurse(c, 20.5, 12.5, rng);
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
    const c = new Colony(2);
    // Spawn deep so it has to climb up.
    spawnEgg(c, 20.5, 50.5, rng);
    spawnNurse(c, 20.5, 50.5, rng);
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
    const c = new Colony(2);
    spawnEgg(c, 20.5, 11.5, rng);
    spawnNurse(c, 20.5, 11.5, rng);
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
    const c = new Colony(2);
    spawnEgg(c, 20.5, 12.5, rng);
    spawnNurse(c, 20.5, 12.5, rng);
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    for (let t = 0; t < 1000; t++) {
      // Pin tick at noon every step (step() increments world.tick;
      // we revert it to keep daylight constant).
      w.tick = DAY_TICKS / 2 - 1;
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
      // Teleport the nurse to follow the egg — mimics a real nurse
      // picking the egg up and carrying it. Without this the nurse
      // stays at the spawn cell, the migrating egg drifts out of
      // attendant range, gravity kicks in, and the egg crashes to
      // the chamber bottom.
      c.posX[1] = c.posX[0]!;
      c.posY[1] = c.posY[0]!;
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
    const c = new Colony(2);
    const idx = c.spawn(20.5, 12.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
    });
    c.state[idx] = STATE_LARVA;
    c.stateTicks[idx] = 0;
    c.energy[idx] = 1;
    spawnNurse(c, 20.5, 12.5, rng);
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
    const c = new Colony(2);
    spawnEgg(c, 20.5, 33.5, rng);
    spawnNurse(c, 20.5, 33.5, rng);
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

  it('an egg with no nurse nearby does not migrate via thermoregulation', () => {
    // Real eggs cannot move themselves — they need a nurse worker
    // to physically carry them. Without a nurse-aged worker within
    // ~3 cells, the thermoreg migration step is gated off. Spawn
    // the egg on the chamber floor (world bottom row in this
    // setup) so the new gravity rule has nothing to do; any motion
    // here would have to come from thermoreg, which is exactly
    // what the test asserts is gated off.
    const rng = new RNG(7);
    const w = deepChamberWorld();
    w.tick = DAY_TICKS / 2 - 1; // noon — would normally drift down
    const c = new Colony(1);
    spawnEgg(c, 20.5, w.height - 0.5, rng);
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    const startY = c.posY[0]! | 0;
    for (let t = 0; t < 500; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_MIGRATE);
    }
    const endY = c.posY[0]! | 0;
    expect(endY).toBe(startY);
  });
});
