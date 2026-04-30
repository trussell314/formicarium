// Surface plants. P. barbatus colonies live in landscapes dotted
// with seed-bearing plants (MacMahon, Mull & Crist 2000). We model
// plants as a per-column Uint8 with size class 1..3; they drop
// seeds nearby and die when buried by the spoil mound.
//
// Verify:
//   1. world.generate produces some plants and zero plants in the
//      cleared band around the founding shaft.
//   2. A planted column drops food onto a nearby surface cell over
//      enough ticks to clear the per-tick Bernoulli rate.
//   3. A plant whose surface cell becomes non-AIR (mound) is
//      cleared on the next visit.
//   4. A column with no plant never drops a plant-sourced seed.

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import {
  CELL_AIR, CELL_GRAIN, CELL_SOIL, DAY_TICKS, PLANT_MAX_HEIGHT, World,
} from '../src/sim/world';

const NOON = DAY_TICKS / 2;

const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  // Disable the population-driven clump rain — we want to watch
  // plant drops in isolation.
  clumpSize: 0,
};

function flatWorld(w = 60, h = 30, surf = 12): World {
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = surf;
  for (let y = surf; y < h; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = CELL_SOIL;
  }
  for (let y = 0; y < surf; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = CELL_AIR;
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

describe('surface plants', () => {
  it('world.generate scatters plants but clears a band around the shaft', () => {
    const rng = new RNG(7);
    const w = new World(280, 140);
    w.generate(rng, 40, 12, 6);
    let total = 0;
    for (let x = 0; x < w.width; x++) if (w.plant[x]! > 0) total++;
    expect(total).toBeGreaterThan(5);
    // Cleared band around the founding shaft. The width matches
    // the constant in world.ts (4% of width, min 4).
    const cx = w.width >> 1;
    const clearHalf = Math.max(4, Math.floor(w.width * 0.04));
    for (let x = cx - clearHalf + 1; x < cx + clearHalf; x++) {
      expect(w.plant[x]!).toBe(0);
    }
  });

  it('a planted column drops food on a nearby surface cell', () => {
    const rng = new RNG(11);
    const w = flatWorld(80, 30, 12);
    w.tick = NOON;
    // One plant at column 40. With PLANT_SEED_RATE=0.005 and
    // width=80 the plant fires once every ~16,000 ticks on average,
    // so 60,000 ticks gives ~3-4 expected drops.
    w.plant[40] = 1;
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    let totalFood = 0;
    for (let t = 0; t < 60000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      // Count any food in the surface row neighborhood. Drops fall
      // onto cells immediately above naturalSurface in [38..42].
      let f = 0;
      for (let dx = -2; dx <= 2; dx++) {
        const cx = 40 + dx;
        const idx = (12 - 1) * w.width + cx;
        if (w.food[idx]! > 0) f++;
      }
      totalFood = Math.max(totalFood, f);
    }
    expect(totalFood).toBeGreaterThan(0);
  });

  it('a buried plant gets cleared when its drop turn comes up', () => {
    // Force the plant column to be picked by exhausting RNG until
    // the drop roll fires on it. Easier: set up a single column
    // world (width=1) so plantPickCol always selects the only
    // column. Width=1 isn't safe (other invariants assume width≥
    // some minimum), so we instead pick a wider world and just
    // run for many ticks — eventually some drop selects the
    // buried plant column.
    const rng = new RNG(13);
    const w = flatWorld(40, 30, 12);
    w.tick = NOON;
    w.plant[20] = 1;
    // Bury the plant: place a GRAIN above naturalSurface[20].
    w.cells[(12 - 1) * w.width + 20] = CELL_GRAIN;
    w.mound[20] = 1;
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    let cleared = false;
    for (let t = 0; t < 20000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (w.plant[20]! === 0) { cleared = true; break; }
    }
    expect(cleared).toBe(true);
  });

  it('seedling plants grow over time toward their kind cap', () => {
    // Plant a tree (kind=3, mature height 8) at column 20 with
    // seedling height 1. After enough ticks the height should
    // increase but never exceed the cap.
    const rng = new RNG(19);
    const w = flatWorld(40, 40, 16);
    w.tick = NOON;
    w.plant[20] = 3;
    w.plantHeight[20] = 1;
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    let grew = false;
    for (let t = 0; t < 30000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (w.plantHeight[20]! > 1) grew = true;
      // Hard cap honoured even on a long run.
      expect(w.plantHeight[20]!).toBeLessThanOrEqual(PLANT_MAX_HEIGHT[3]!);
    }
    expect(grew).toBe(true);
  });

  it('mature plants do not grow past their kind cap', () => {
    // A grass (kind=1, max 2) seeded at its mature height stays put.
    const rng = new RNG(23);
    const w = flatWorld(40, 30, 12);
    w.tick = NOON;
    w.plant[10] = 1;
    w.plantHeight[10] = PLANT_MAX_HEIGHT[1]!;
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    for (let t = 0; t < 5000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    expect(w.plantHeight[10]!).toBe(PLANT_MAX_HEIGHT[1]!);
  });

  it('saturated trunk-trail clears plants, food, and sprouts', () => {
    // *P. barbatus* foragers maintain bare-earth trails by physically
    // pushing aside any debris in their path. Stamp a strong trunk
    // pheromone over a planted column and run a few ticks; the
    // plant, any food, and any sprout there should be cleared while
    // off-trail neighbours are untouched.
    const rng = new RNG(43);
    const w = flatWorld(80, 30, 12);
    w.tick = 0;
    // Plant + food + sprout at column 40.
    w.plant[40] = 1;
    w.plantHeight[40] = 2;
    w.food[(12 - 1) * w.width + 40] = 1;
    w.sprout[(12 - 1) * w.width + 40] = 1;
    // Off-trail control at column 60.
    w.plant[60] = 1;
    w.plantHeight[60] = 2;
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    const trail = new Pheromone(w.width, w.height, 0.40, 0.999);
    const alarm = new Pheromone(w.width, w.height, 0.50, 0.985);
    const queen = new Pheromone(w.width, w.height, 0.10, 0.999, true);
    const brood = new Pheromone(w.width, w.height, 0.20, 0.999, true);
    const necro = new Pheromone(w.width, w.height, 0.30, 0.99);
    const noEntry = new Pheromone(w.width, w.height, 0.05, 0.995);
    const granary = new Pheromone(w.width, w.height, 0.10, 0.999);
    const trunk = new Pheromone(w.width, w.height, 0.20, 0.9995);
    // Saturate trunk pheromone above the surface at column 40.
    for (let k = 0; k < 40; k++) trunk.deposit(40, 11, 1.0);
    // Run enough ticks for the periodic sweep (every 64 ticks) to fire.
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET,
        trail, alarm, queen, brood, necro, noEntry, granary, trunk);
    }
    expect(w.plant[40]!).toBe(0);
    expect(w.food[(12 - 1) * w.width + 40]!).toBe(0);
    expect(w.sprout[(12 - 1) * w.width + 40]!).toBe(0);
    // Off-trail plant unaffected.
    expect(w.plant[60]!).toBe(1);
  });

  it('a column with no plant never drops a plant-sourced seed', () => {
    // Same setup as above but with NO plants. Run for the same
    // duration as the drop test; food count must remain zero.
    const rng = new RNG(17);
    const w = flatWorld(80, 30, 12);
    w.tick = NOON;
    // No plants at all.
    for (let x = 0; x < w.width; x++) w.plant[x] = 0;
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    for (let t = 0; t < 60000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    let total = 0;
    for (let i = 0; i < w.food.length; i++) if (w.food[i]! > 0) total++;
    expect(total).toBe(0);
  });
});
