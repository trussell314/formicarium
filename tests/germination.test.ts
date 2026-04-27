// Seed germination tests. Tschinkel (1999): stored seeds in P. badius
// granaries occasionally sprout. Verify:
//   1. A stored seed (foodMoves > 0) eligible for germination eventually
//      becomes a sprout.
//   2. A surface-fallen seed (foodMoves === 0) does NOT germinate (it
//      hasn't been deposited into a granary; we treat the granary
//      as the only place worth modelling for this).
//   3. A sprout decays back to nothing after sproutLifetimeTicks.
//   4. A WANDER ant walking over a sprout cell removes it (high prob).

import { describe, expect, it } from 'vitest';
import { Colony, STATE_WANDER } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, World } from '../src/sim/world';

// High germination probability + short sweep interval so a few
// hundred ticks reliably produces germination events.
const FAST_GERM: AntSpecies = {
  ...HARVESTER,
  sproutProb: 0.5,
  germinationSweepInterval: 10,
  sproutLifetimeTicks: 200,
  // Disable everything else.
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
};

function emptyWorld(w: number, h: number): World {
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = 5;
  for (let y = 5; y < h; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = 1; // SOIL
  }
  // Carve a wide chamber so seeds can sit in AIR.
  for (let y = 5; y < 12; y++) {
    for (let x = 5; x <= 20; x++) world.cells[world.index(x, y)] = CELL_AIR;
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

function makeFields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

describe('seed germination', () => {
  it('a stored seed eventually sprouts', () => {
    const rng = new RNG(1);
    const w = emptyWorld(30, 20);
    const seedIdx = w.index(12, 8);
    w.food[seedIdx] = 1;
    w.foodMoves[seedIdx] = 5; // marks "stored" (deposited at least once)
    const c = new Colony(0); // no ants, just seed observation
    const { dig, build } = makeFields(w);
    let sprouted = false;
    for (let t = 0; t < 200; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_GERM);
      if (w.sprout[seedIdx]! > 0) { sprouted = true; break; }
    }
    expect(sprouted).toBe(true);
    // Seed marker cleared (it became a sprout).
    expect(w.food[seedIdx]).toBe(0);
  });

  it('a fresh surface seed does NOT sprout', () => {
    const rng = new RNG(2);
    const w = emptyWorld(30, 20);
    const seedIdx = w.index(12, 4); // above surface
    w.food[seedIdx] = 1;
    w.foodMoves[seedIdx] = 0; // brand new (just fell from sky)
    const c = new Colony(0);
    const { dig, build } = makeFields(w);
    for (let t = 0; t < 500; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_GERM);
    }
    expect(w.sprout[seedIdx]).toBe(0);
    expect(w.food[seedIdx]).toBe(1);
  });

  it('sprouts decay after sproutLifetimeTicks', () => {
    const rng = new RNG(3);
    const w = emptyWorld(30, 20);
    const idx = w.index(12, 8);
    // Seed an active sprout directly.
    w.sprout[idx] = 1;
    w.sproutTick[idx] = w.tick;
    const c = new Colony(0);
    const { dig, build } = makeFields(w);
    // Step well past the lifetime to give the decay sweep a chance.
    for (let t = 0; t < FAST_GERM.sproutLifetimeTicks + 200; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_GERM);
    }
    expect(w.sprout[idx]).toBe(0);
  });

  it('a WANDER ant walking over a sprout removes it', () => {
    const rng = new RNG(4);
    const w = emptyWorld(30, 20);
    const idx = w.index(12, 8);
    w.sprout[idx] = 1;
    w.sproutTick[idx] = w.tick;
    const c = new Colony(1);
    c.spawn(12.5, 8.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
    });
    expect(c.state[0]).toBe(STATE_WANDER);
    const { dig, build } = makeFields(w);
    let cleared = false;
    for (let t = 0; t < 100; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_GERM);
      if (w.sprout[idx] === 0) { cleared = true; break; }
    }
    expect(cleared).toBe(true);
  });
});
