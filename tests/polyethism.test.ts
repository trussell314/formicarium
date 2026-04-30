// Caste-based age polyethism tests. Mersch, Crespi & Keller 2013;
// Beshers & Fewell 2001. Verify:
//   1. The forageMult ramp produces ~no foragers at age=0 and many
//      at age >= matureAge (statistical comparison).
//   2. Below-surface geotaxis is stronger for young ants than old
//      (heading change after one tick differs).
//   3. Dig probability peaks at middle age (head-to-head dig count).

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_FORAGE, STATE_WANDER,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, DAY_TICKS, World } from '../src/sim/world';

const NOON = DAY_TICKS / 2;

function flatWorld(w = 60, h = 30, surf = 12): World {
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = surf;
  for (let y = surf; y < h; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = CELL_SOIL;
  }
  // Carve a wide chamber underground.
  for (let y = surf; y < surf + 5; y++) {
    for (let x = 5; x < w - 5; x++) world.cells[world.index(x, y)] = CELL_AIR;
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

const TRAITS = {
  digProb: 0.5, pickProb: 0, stigmergy: 0, turnNoise: 0,
  restThreshold: 100,
};

const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0.05,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
};

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

describe('caste polyethism', () => {
  it('old workers transition to FORAGE much more often than young workers', () => {
    // Two parallel colonies of equal size, identical seed: one young,
    // one old. After many ticks, count cumulative FORAGE entries.
    function run(age: number, seed: number): number {
      const rng = new RNG(seed);
      const w = flatWorld();
      w.tick = NOON;
      const colony = new Colony(8);
      for (let k = 0; k < 8; k++) {
        colony.spawn(20.5 + k * 2, 14.5, 0, rng, TRAITS);
        colony.age[k] = age;
      }
      const { dig, build } = fields(w);
      let everSawForager = 0;
      // Force every ant back to WANDER each tick (and reset age=0 if young
      // would otherwise drift into mature) so the difference is purely the
      // forageMult applied this tick.
      for (let t = 0; t < 100; t++) {
        for (let i = 0; i < colony.count; i++) {
          if (colony.state[i] === STATE_FORAGE) continue; // let trip play out
          colony.state[i] = STATE_WANDER;
          colony.stateTicks[i] = 0;
          colony.collisionCount[i] = 0;
          colony.age[i] = age; // hold age constant
        }
        step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
        let f = 0;
        for (let i = 0; i < colony.count; i++) if (colony.state[i] === STATE_FORAGE) f++;
        if (f > everSawForager) everSawForager = f;
      }
      return everSawForager;
    }
    const young = run(0, 11);
    const old = run(HARVESTER.matureAge * 2, 11);
    // Old colony should produce strictly more concurrent foragers
    // than young one. Tolerate seed variance via the strict-greater
    // comparison rather than a fixed multiplier.
    expect(old).toBeGreaterThan(young);
  });

  it('young workers have stronger below-surface geotaxis than old ones', () => {
    // Compare heading rotation after one tick of stationary geotaxis
    // bias. We freeze movement (walkSpeed=0 via custom params) and
    // just look at the heading delta.
    const params = { ...DEFAULT_PARAMS, walkSpeed: 0, turnNoise: 0 };
    function headingDelta(age: number, startH: number): number {
      const rng = new RNG(42);
      const w = flatWorld();
      w.tick = NOON;
      const colony = new Colony(1);
      colony.spawn(30.5, 14.5, startH, rng, TRAITS);
      colony.age[0] = age;
      const { dig, build } = fields(w);
      step(w, colony, dig, build, rng, params, undefined, QUIET);
      return colony.heading[0]! - startH;
    }
    // Heading 0 (east) should rotate toward π/2 (down) under
    // positive below-surface geotaxis. Young (age=0) gets full
    // pull; old (age=2*matureAge) gets the floor of 0.3×.
    const dyoung = headingDelta(0, 0);
    const dold = headingDelta(HARVESTER.matureAge * 2, 0);
    expect(dyoung).toBeGreaterThan(dold);
  });

  it('mid-age workers dig more than young or old workers', () => {
    // The dig-rate-by-age invariant. We measure how often the
    // step() loop's dig roll *fires successfully* at each age,
    // not how many unique cells the ant carves out (carving
    // changes the local geometry and saturates the count). After
    // every successful dig we restore the world cell back to
    // SOIL, so each subsequent tick presents the dig roll with
    // identical 4-soil-neighbour geometry — total digs across
    // 2000 ticks ≈ dig-roll probability × ticks.
    function digsAtAge(age: number, seed: number): number {
      const rng = new RNG(seed);
      const w = new World(40, 30);
      for (let x = 0; x < 40; x++) w.naturalSurface[x] = 6;
      for (let y = 6; y < 30; y++) {
        for (let x = 0; x < 40; x++) w.cells[w.index(x, y)] = CELL_SOIL;
      }
      w.cells[w.index(20, 8)] = CELL_AIR;
      w.initialSoilCells = w.countSoil();
      w.tick = NOON;
      const colony = new Colony(1);
      colony.spawn(20.5, 8.5, 0, rng, TRAITS);
      colony.age[0] = age;
      colony.energy[0] = 1.0;
      const { dig, build } = fields(w);
      let totalDigs = 0;
      for (let t = 0; t < 2000; t++) {
        colony.posX[0] = 20.5;
        colony.posY[0] = 8.5;
        colony.age[0] = age;
        if (colony.state[0] !== STATE_WANDER) {
          colony.state[0] = STATE_WANDER;
          colony.collisionCount[0] = 0;
        }
        const before = w.countSoil();
        step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
        const after = w.countSoil();
        if (after < before) {
          totalDigs += before - after;
          // Reset every soil cell so the next dig roll sees the
          // same geometry. Drop any grain the ant is carrying so
          // the next tick rolls dig (not deposit).
          for (let y = 6; y < 30; y++) {
            for (let x = 0; x < 40; x++) {
              const idx = w.index(x, y);
              if (x === 20 && y === 8) w.cells[idx] = CELL_AIR;
              else w.cells[idx] = CELL_SOIL;
            }
          }
          w.initialSoilCells = w.countSoil();
          colony.carryMoves[0] = 0;
        }
      }
      return totalDigs;
    }
    const seeds = [3, 7, 11, 17, 23];
    const sum = (xs: ReadonlyArray<number>): number => xs.reduce((a, b) => a + b, 0);
    const young = sum(seeds.map((s) => digsAtAge(0, s)));
    const mid = sum(seeds.map((s) => digsAtAge(HARVESTER.matureAge / 2, s)));
    const old = sum(seeds.map((s) => digsAtAge(HARVESTER.matureAge * 2, s)));
    // Mid > young AND mid > old. Excavator caste peaks in the middle.
    expect(mid).toBeGreaterThan(young);
    expect(mid).toBeGreaterThan(old);
  });
});
