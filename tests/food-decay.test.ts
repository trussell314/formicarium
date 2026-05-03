// Surface-food decay tests. Mirror of corpse decomposition: surface
// seeds rot / get eaten / weather away on a multi-day timescale,
// while seeds stored in granaries below the natural surface persist
// indefinitely (Tschinkel 1999, P. badius granary longevity).

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

// Quiet species — nothing else fires that could interfere with
// foodTick stamping or sweeps.
const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  larvaMetabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  eggLayInterval: 1e9,
  clumpInterval: 1e9,
};

const FOOD_LIFETIME_TICKS = 140_000;

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

// World: surface row at 8, soil from 8 to 19, sky 0..7. A wide
// below-ground chamber rows 12-15 cols 4-9 leaves a granary cavity
// for the second test.
function decayWorld(): World {
  const w = new World(20, 20);
  for (let x = 0; x < 20; x++) w.naturalSurface[x] = 8;
  for (let y = 8; y < 20; y++) {
    for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
  }
  for (let y = 12; y <= 15; y++) {
    for (let x = 4; x <= 9; x++) w.cells[w.index(x, y)] = CELL_AIR;
  }
  w.initialSoilCells = w.countSoil();
  return w;
}

describe('surface-food decay', () => {
  it('a surface seed older than FOOD_LIFETIME_TICKS clears', () => {
    const rng = new RNG(11);
    const w = decayWorld();
    // Place a seed at row 7 (one above the surface row 8).
    w.food[w.index(10, 7)] = 1;
    w.foodTick[w.index(10, 7)] = 0;
    w.tick = FOOD_LIFETIME_TICKS + 200;
    const colony = new Colony(0);
    const f = fields(w);
    // Step until the next sweep boundary fires (sweep is every 100
    // ticks). Two ticks of slop is enough.
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    expect(w.food[w.index(10, 7)]).toBe(0);
  });

  it('a granary seed (below natural surface) does NOT decay', () => {
    const rng = new RNG(12);
    const w = decayWorld();
    // Place a seed on the chamber floor (row 15, col 6) so the food-
    // gravity cascade leaves it in place — chamber bottom is row 15
    // with SOIL at row 16 directly below. Both are below the natural
    // surface (row 8), so the granary exemption applies.
    w.food[w.index(6, 15)] = 1;
    w.foodTick[w.index(6, 15)] = 0;
    w.tick = FOOD_LIFETIME_TICKS * 2;
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // Stored seed must still be there long after the surface lifetime.
    expect(w.food[w.index(6, 15)]).toBe(1);
  });

  it('a fresh surface seed (just placed) survives the next sweep', () => {
    const rng = new RNG(13);
    const w = decayWorld();
    w.food[w.index(10, 7)] = 1;
    w.foodTick[w.index(10, 7)] = 0;
    w.tick = 100; // first sweep boundary
    const colony = new Colony(0);
    const f = fields(w);
    // One step at tick=100 fires the sweep. Seed is "fresh" (foodTick=0,
    // age=100 ≪ lifetime), must persist.
    step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    expect(w.food[w.index(10, 7)]).toBe(1);
  });

  it('a surface seed with sentinel foodTick is lazy-initialised, not cleared', () => {
    // Backward-compat path for legacy saves and tests that set
    // food[idx]=1 directly without stamping foodTick. The sweep
    // sees foodTick === -1_000_000 (sentinel from World ctor) and
    // refreshes it to current tick instead of clearing.
    const rng = new RNG(14);
    const w = decayWorld();
    w.food[w.index(10, 7)] = 1;
    // foodTick already filled with sentinel by the constructor.
    // Set tick = lifetime + 99 so the single step() below advances to
    // a tick that lands on a sweep boundary (% 100 === 0).
    w.tick = FOOD_LIFETIME_TICKS + 99;
    const colony = new Colony(0);
    const f = fields(w);
    // Sweep fires at tick=lifetime+100; sentinel → lazy-init →
    // foodTick refreshed to current tick, food persists.
    step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    expect(w.food[w.index(10, 7)]).toBe(1);
    expect(w.foodTick[w.index(10, 7)]).toBeGreaterThan(-1_000_000);
  });
});
