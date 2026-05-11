// Food (seed) gravity. Seeds dropped on grain piles or chamber
// ceilings should fall when the supporting cell becomes AIR —
// otherwise they "float" mid-air, the same bug we hit with
// corpses earlier.

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';

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

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

describe('food gravity', () => {
  it('an orphaned floating seed settles down to the substrate within ~30 ticks', () => {
    const rng = new RNG(1);
    const w = new World(20, 20);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 12;
    for (let y = 12; y < 20; y++) {
      for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    w.initialSoilCells = w.countSoil();
    // Place a seed at row 5, with AIR all the way to natural surface
    // at row 12. The 30-tick gravity sweep walks it down through
    // empty space.
    w.food[w.index(10, 5)] = 1;
    w.foodMoves[w.index(10, 5)] = 7; // arbitrary non-zero so we can verify carry-over
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 300; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    let total = 0;
    for (let i = 0; i < w.food.length; i++) if (w.food[i]! > 0) total++;
    expect(total).toBe(1);
    expect(w.food[w.index(10, 5)]).toBe(0);
    expect(w.food[w.index(10, 11)]).toBe(1); // one row above the substrate
    expect(w.foodMoves[w.index(10, 11)]).toBe(7); // carry-over preserved
  });

  it('seed sitting on a grain pile follows the grain when it gets dug out', () => {
    // Two-row grain pile at column 10 above the surface, with a
    // seed on the very top. Remove the supporting grain (simulating
    // an ant pickup); after the next gravity sweep the seed must
    // follow.
    const rng = new RNG(2);
    const w = new World(20, 30);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 15;
    for (let y = 15; y < 30; y++) {
      for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    w.cells[w.index(10, 13)] = CELL_GRAIN;
    w.cells[w.index(10, 14)] = CELL_GRAIN;
    w.initialSoilCells = w.countSoil();
    w.food[w.index(10, 12)] = 1;
    // Now ants haul the supporting grain away.
    w.cells[w.index(10, 13)] = CELL_AIR;
    w.cells[w.index(10, 14)] = CELL_AIR;
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 90; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    expect(w.food[w.index(10, 12)]).toBe(0);
    expect(w.food[w.index(10, 14)]).toBe(1);
  });

  it('seed will not stack on top of an existing seed', () => {
    // Two seeds in the same column with AIR between. The lower
    // settles fine; the upper waits.
    const rng = new RNG(3);
    const w = new World(20, 20);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 12;
    for (let y = 12; y < 20; y++) {
      for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    w.initialSoilCells = w.countSoil();
    w.food[w.index(10, 5)] = 1;
    w.food[w.index(10, 9)] = 1;
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 300; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    let total = 0;
    for (let i = 0; i < w.food.length; i++) if (w.food[i]! > 0) total++;
    // Two seeds, no merging — bottom one at row 11, upper one at row 10.
    expect(total).toBe(2);
    expect(w.food[w.index(10, 11)]).toBe(1);
    expect(w.food[w.index(10, 10)]).toBe(1);
  });
});
