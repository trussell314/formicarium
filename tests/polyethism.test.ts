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
    // Three parallel colonies at different ages. Run them long
    // enough for a clear dig differential. We don't tightly bound
    // the values — only the ordering matters.
    function digsAtAge(age: number, seed: number): number {
      const rng = new RNG(seed);
      const w = flatWorld(40, 30, 6);
      w.tick = NOON;
      // Ant deep in chamber so it has soil to dig.
      const colony = new Colony(1);
      colony.spawn(20.5, 8.5, 0, rng, TRAITS);
      colony.age[0] = age;
      colony.energy[0] = 1.0;
      const { dig, build } = fields(w);
      const startSoil = w.countSoil();
      for (let t = 0; t < 2000; t++) {
        // Hold age, keep ant in WANDER so dig roll keeps firing.
        colony.age[0] = age;
        if (colony.state[0] !== STATE_WANDER) {
          colony.state[0] = STATE_WANDER;
          colony.collisionCount[0] = 0;
        }
        step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      }
      return startSoil - w.countSoil();
    }
    const young = digsAtAge(0, 7);
    const mid = digsAtAge(HARVESTER.matureAge / 2, 7);
    const old = digsAtAge(HARVESTER.matureAge * 2, 7);
    // Mid > young AND mid > old. Excavator caste peaks in the middle.
    expect(mid).toBeGreaterThan(young);
    expect(mid).toBeGreaterThan(old);
  });
});
