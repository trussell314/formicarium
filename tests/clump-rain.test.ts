// Population-driven clump rain. Each tick drops 110% of the live
// colony's metabolic demand (in seed-equivalent units), capped at
// 10× the original-population's worker metabolism. The rate is
// realised through an accumulator that fires one clump every time
// it crosses species.clumpSize.
//
// Verify:
//   1. Rate scales with population — a many-ant colony gets clearly
//      more food per unit time than a few-ant colony at the same
//      foodCap.
//   2. The cap kicks in at high pop — colonies far above foodCap
//      receive the SAME food rate as colonies at foodCap.
//   3. Non-granivorous species don't drop clumps.
//   4. foodCap = 0 disables the rain (defensive default before
//      main.ts initialises it).

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

function flatWorld(w = 80, h = 40, surf = 12): World {
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = surf;
  for (let y = surf; y < h; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = CELL_SOIL;
  }
  for (let y = 0; y < surf; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = CELL_AIR;
  }
  // Carve a small chamber for the spectator workers so they have AIR
  // cells to live in (otherwise they're embedded in soil and the
  // collision/movement passes get confused).
  for (let y = surf; y < surf + 5; y++) {
    for (let x = w / 2 - 5; x < w / 2 + 5; x++) {
      world.cells[world.index(x | 0, y)] = CELL_AIR;
    }
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

const SPECTATOR_TRAITS = {
  digProb: 0,
  pickProb: 0,
  stigmergy: 0,
  turnNoise: 0,
  restThreshold: 1e9,
};

// Inject N spectator workers into the small chamber. Spawn-arity is
// (x, y, heading, rng, traits). They keep their default WANDER state
// but the high restThreshold + zero traits keep them mostly still.
function seedWorkers(c: Colony, n: number, w: World): void {
  const rng = new RNG(99);
  const cx = w.width >> 1;
  const cy = w.naturalSurface[cx]! + 1;
  for (let k = 0; k < n; k++) {
    const idx = c.spawn(cx + 0.5, cy + 0.5, 0, rng, SPECTATOR_TRAITS);
    if (idx < 0) throw new Error(`colony capacity hit at k=${k}`);
  }
}

function countFood(w: World): number {
  let n = 0;
  for (let i = 0; i < w.food.length; i++) if (w.food[i]! > 0) n++;
  return n;
}

// Test species with small clumpSize so the accumulator fires
// quickly and we don't need millions of ticks to see effects.
const FAST: AntSpecies = {
  ...HARVESTER,
  clumpSize: 1,        // one seed per "clump"
  clumpRadius: 1,
  seedsPerTick: 0,
  // Disable everything that would consume food or change population.
  forageProb: 0,
  metabolism: 1e-3,    // bigger metabolism so accumulator fills fast
  larvaMetabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  eggLayInterval: 1e9,
  workerLifespan: 1e9,
};

describe('population-driven clump rain', () => {
  it('rate scales with population', () => {
    function run(workers: number): number {
      const rng = new RNG(1);
      const w = flatWorld();
      w.foodCap = 1_000_000; // effectively no cap
      const colony = new Colony(workers + 4);
      seedWorkers(colony, workers, w);
      const f = fields(w);
      for (let t = 0; t < 5_000; t++) {
        step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, FAST);
      }
      return countFood(w);
    }
    const small = run(2);
    const big = run(20);
    expect(big).toBeGreaterThan(small * 3);
  });

  it('cap saturates at world.foodCap workers', () => {
    function run(workers: number, foodCap: number): number {
      const rng = new RNG(2);
      const w = flatWorld();
      w.foodCap = foodCap;
      const colony = new Colony(workers + 4);
      seedWorkers(colony, workers, w);
      const f = fields(w);
      // 500 ticks rather than 5000 so we measure the supply RATE
      // before the population-aware saturation throttle (hard stop
      // at 1.5× population standing inventory) starts capping the
      // smaller colony at a different inventory plateau than the
      // larger one. In the early-supply window both colonies are
      // bounded by foodCap and produce the same rate.
      for (let t = 0; t < 500; t++) {
        step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, FAST);
      }
      return countFood(w);
    }
    const atCap = run(10, 10);
    const overCap = run(40, 10);
    // Both colonies are at or above foodCap; the cap dominates the
    // rate so the food count should be the same up to RNG-driven
    // surface-collision losses (each clump might spawn into an
    // already-occupied column and lose a seed).
    const ratio = overCap / Math.max(1, atCap);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.3);
  });

  it('non-granivorous species do not drop clumps', () => {
    const rng = new RNG(3);
    const w = flatWorld();
    w.foodCap = 100;
    const colony = new Colony(10);
    seedWorkers(colony, 5, w);
    const f = fields(w);
    const carnivore: AntSpecies = { ...FAST, granivorous: false };
    for (let t = 0; t < 5_000; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, carnivore);
    }
    expect(countFood(w)).toBe(0);
  });

  it('foodCap = 0 disables the rain', () => {
    const rng = new RNG(4);
    const w = flatWorld();
    // foodCap left at 0 (the World constructor default)
    const colony = new Colony(10);
    seedWorkers(colony, 5, w);
    const f = fields(w);
    for (let t = 0; t < 5_000; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, FAST);
    }
    expect(countFood(w)).toBe(0);
  });
});
