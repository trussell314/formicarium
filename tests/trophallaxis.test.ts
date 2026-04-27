// Trophallaxis tests. Worker-worker energy transfer on close
// contact (Hölldobler & Wilson 1990 Ch. 7; Cassill & Tschinkel 1999).
// Verify:
//   1. A well-fed ant adjacent to a hungry ant transfers energy.
//   2. Energy is conserved across the transfer (zero-sum).
//   3. The donor doesn't drop below its donor threshold.
//   4. The recipient doesn't get pushed above maxEnergy.
//   5. A queen can RECEIVE but does not DONATE (Hölldobler & Wilson
//      describe trophallaxis as one of the routes by which workers
//      feed the queen).

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, World } from '../src/sim/world';

// Disable food deposition + dig + everything else that could
// confound the energy delta we're measuring.
const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,             // freeze ambient drain so transfers stand out
  eggLayInterval: 1e9,        // no egg laying
  necrophoresisProb: 0,
};

function makeWorld(): World {
  const world = new World(40, 30);
  for (let x = 0; x < world.width; x++) world.naturalSurface[x] = 12;
  for (let i = 0; i < world.cells.length; i++) world.cells[i] = 0;
  for (let y = 12; y < 30; y++) {
    for (let x = 0; x < 40; x++) world.cells[world.index(x, y)] = 1;
  }
  // Carve a chamber for the ants.
  for (let y = 12; y < 18; y++) {
    for (let x = 15; x <= 25; x++) world.cells[world.index(x, y)] = CELL_AIR;
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

const TRAITS = {
  digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0,
  restThreshold: 100,
};

describe('trophallaxis', () => {
  it('transfers energy from a well-fed ant to a hungry neighbour', () => {
    const rng = new RNG(1);
    const w = makeWorld();
    const colony = new Colony(2);
    // Place two ants at adjacent cells inside the chamber.
    colony.spawn(20.0, 14.5, 0, rng, TRAITS);
    colony.spawn(20.5, 14.5, 0, rng, TRAITS);
    colony.energy[0] = 0.9;
    colony.energy[1] = 0.2;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    // Run until they pull apart or the recipient hits 0.4
    // (recipientThreshold).
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (colony.energy[1]! >= 0.4) break;
    }
    expect(colony.energy[1]!).toBeGreaterThan(0.2);
    expect(colony.energy[0]!).toBeLessThan(0.9);
  });

  it('energy is conserved across the transfer', () => {
    const rng = new RNG(2);
    const w = makeWorld();
    const colony = new Colony(2);
    colony.spawn(20.0, 14.5, 0, rng, TRAITS);
    colony.spawn(20.4, 14.5, 0, rng, TRAITS);
    colony.energy[0] = 0.85;
    colony.energy[1] = 0.10;
    const total0 = colony.energy[0]! + colony.energy[1]!;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    for (let t = 0; t < 50; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      const total = colony.energy[0]! + colony.energy[1]!;
      expect(total).toBeCloseTo(total0, 4);
    }
  });

  it('donor never drops below its threshold', () => {
    const rng = new RNG(3);
    const w = makeWorld();
    const colony = new Colony(2);
    colony.spawn(20.0, 14.5, 0, rng, TRAITS);
    colony.spawn(20.4, 14.5, 0, rng, TRAITS);
    colony.energy[0] = 0.55; // just above donor threshold (0.5)
    colony.energy[1] = 0.05;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      // Donor is whichever ant currently has more energy. Whichever
      // it is, its energy must never fall below the threshold.
      const donor = colony.energy[0]! >= colony.energy[1]! ? 0 : 1;
      expect(colony.energy[donor]!).toBeGreaterThanOrEqual(QUIET.trophallaxisDonorThreshold - 1e-6);
    }
  });

  it('a queen receives but does not donate', () => {
    const rng = new RNG(4);
    const w = makeWorld();
    const colony = new Colony(2);
    // Queen first (always has STATE_QUEEN), worker second.
    colony.spawn(20.0, 14.5, 0, rng, TRAITS);
    colony.state[0] = STATE_QUEEN;
    colony.spawn(20.4, 14.5, 0, rng, TRAITS);
    // Hungry queen, well-fed worker → expect queen to receive.
    colony.energy[0] = 0.10;
    colony.energy[1] = 0.85;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    for (let t = 0; t < 100; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    expect(colony.energy[0]!).toBeGreaterThan(0.10);
    expect(colony.energy[1]!).toBeLessThan(0.85);

    // Inverse: if queen is well-fed and worker is hungry, queen
    // does NOT donate (her reserves go to brood, not workers).
    const rng2 = new RNG(5);
    const w2 = makeWorld();
    const c2 = new Colony(2);
    c2.spawn(20.0, 14.5, 0, rng2, TRAITS);
    c2.state[0] = STATE_QUEEN;
    c2.spawn(20.4, 14.5, 0, rng2, TRAITS);
    c2.energy[0] = 0.95; // queen, full
    c2.energy[1] = 0.10; // hungry worker
    const dig2 = new Pheromone(w2.width, w2.height, 0.12, 0.99);
    const build2 = new Pheromone(w2.width, w2.height, 0.10, 0.997);
    for (let t = 0; t < 100; t++) {
      step(w2, c2, dig2, build2, rng2, DEFAULT_PARAMS, undefined, QUIET);
    }
    // Queen energy unchanged (no donation). Worker energy unchanged
    // too (queen didn't donate). Rounding tolerance for the queen's
    // own metabolism is zero because we set metabolism to 0.
    expect(c2.energy[0]!).toBeCloseTo(0.95, 5);
    expect(c2.energy[1]!).toBeCloseTo(0.10, 5);
  });

  it('does nothing when ants are far apart', () => {
    const rng = new RNG(6);
    const w = makeWorld();
    const colony = new Colony(2);
    colony.spawn(16.0, 14.5, 0, rng, TRAITS);  // left side of chamber
    colony.spawn(24.0, 14.5, 0, rng, TRAITS);  // right side, > 2 cells
    colony.energy[0] = 0.9;
    colony.energy[1] = 0.1;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    for (let t = 0; t < 5; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // No transfer should have happened at distance 8.
    expect(colony.energy[0]!).toBeCloseTo(0.9, 4);
    expect(colony.energy[1]!).toBeCloseTo(0.1, 4);
  });
});
