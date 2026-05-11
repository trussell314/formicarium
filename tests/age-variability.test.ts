// Worker age-related mortality. Real *Pogonomyrmex barbatus*
// cohorts die over a ~30% window around the mean lifespan
// (Gordon 2010 *Ant Encounters* Ch. 4). Verify:
//   1. Workers below 0.7 × lifespan never die of age in 200 ticks.
//   2. A cohort all spawned at age = 0.9 × lifespan dies over a
//      window — neither all-at-once nor all-survive.
//   3. By age = 1.5 × lifespan essentially all of the cohort is dead.

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_DEAD, STATE_QUEEN, STATE_WANDER,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

// Short-lifespan species for testing — full HARVESTER lifespan is
// 2.6 M ticks which would make the cohort-die-off tests run for
// minutes. 1000 ticks is enough to exercise the probabilistic
// mortality curve while keeping per-test runtime under a second.
const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  clumpSize: 0,
  workerLifespan: 1000,
};

function chamberWorld(): World {
  const world = new World(40, 30);
  for (let x = 0; x < 40; x++) world.naturalSurface[x] = 12;
  for (let y = 12; y < 30; y++) {
    for (let x = 0; x < 40; x++) world.cells[world.index(x, y)] = CELL_SOIL;
  }
  for (let y = 12; y < 18; y++) {
    for (let x = 5; x <= 35; x++) world.cells[world.index(x, y)] = CELL_AIR;
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

function spawnCohort(c: Colony, n: number, age: number, rng: RNG): void {
  for (let k = 0; k < n; k++) {
    const idx = c.spawn(15.5 + (k % 20), 14.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
    });
    c.state[idx] = STATE_WANDER;
    c.age[idx] = age;
    c.energy[idx] = 1;
  }
}

function countAlive(c: Colony): number {
  let alive = 0;
  for (let i = 0; i < c.count; i++) {
    if (c.state[i] !== STATE_DEAD && c.state[i] !== STATE_QUEEN) alive++;
  }
  return alive;
}

describe('worker age variability', () => {
  it('young workers do not die of age', () => {
    const rng = new RNG(1);
    const w = chamberWorld();
    const c = new Colony(50);
    spawnCohort(c, 50, (QUIET.workerLifespan * 0.5) | 0, rng);
    const { dig, build } = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    expect(countAlive(c)).toBe(50);
  });

  it('a cohort of old workers dies gradually, not all at once', () => {
    // 100 workers all spawned at age 0.95 × lifespan. After enough
    // ticks (a fraction of lifespan), some have died and some are
    // still alive — that's the whole point of age variability.
    const rng = new RNG(2);
    const w = chamberWorld();
    const c = new Colony(100);
    spawnCohort(c, 100, (QUIET.workerLifespan * 0.95) | 0, rng);
    const { dig, build } = fields(w);
    // Run for ~5% of lifespan worth of ticks. With pDie peak ~5/L
    // around ageFrac=1.0, expected deaths in this window = ~25%.
    const window = (QUIET.workerLifespan * 0.05) | 0;
    for (let t = 0; t < window; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    const alive = countAlive(c);
    expect(alive).toBeGreaterThan(0);
    expect(alive).toBeLessThan(100);
  });

  it('by age 1.5 × lifespan essentially all of the cohort is dead', () => {
    const rng = new RNG(3);
    const w = chamberWorld();
    const c = new Colony(100);
    // Spawn at 0.7L (mortality threshold) and run until ageFrac=1.5.
    spawnCohort(c, 100, (QUIET.workerLifespan * 0.7) | 0, rng);
    const { dig, build } = fields(w);
    const window = (QUIET.workerLifespan * 0.8) | 0;
    for (let t = 0; t < window; t++) {
      step(w, c, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    expect(countAlive(c)).toBeLessThan(5);
  });
});
