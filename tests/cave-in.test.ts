// Cave-in resistance. Above-ground spoil/food/corpses must NOT
// cascade through the natural-surface horizon into the dug nest
// below — real soil has cohesion + ants reinforce the surface
// boundary, so the surface acts as a one-way barrier.

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { settleGrain } from '../src/sim/physics';
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

// World: surface row at 12, all soil below, all sky above. A
// vertical entrance shaft at column 10 down to row 18 makes the
// natural-surface cell at column 10 AIR; everything to either side
// is intact soil. We then put the cave-in candidate (grain, food,
// or corpse) above the surface and verify it can't fall through.
function caveInWorld(): World {
  const world = new World(20, 25);
  for (let x = 0; x < 20; x++) world.naturalSurface[x] = 12;
  for (let y = 12; y < 25; y++) {
    for (let x = 0; x < 20; x++) world.cells[world.index(x, y)] = CELL_SOIL;
  }
  // Vertical shaft at column 10, rows 12..18 — surface dug out plus
  // a 6-cell shaft.
  for (let y = 12; y <= 18; y++) world.cells[world.index(10, y)] = CELL_AIR;
  world.initialSoilCells = world.countSoil();
  return world;
}

describe('cave-in resistance', () => {
  it('a grain placed above the buried entrance does not cascade through into the nest', () => {
    const rng = new RNG(1);
    const w = caveInWorld();
    // Drop a grain at row 5 (above the surface at row 12), in the
    // entrance column (10) where the surface cell is AIR.
    w.cells[w.index(10, 5)] = CELL_GRAIN;
    settleGrain(w, 10, 5, rng);
    // Find where the grain ended up.
    let restY = -1;
    for (let y = 0; y < 25; y++) {
      if (w.cells[w.index(10, y)] === CELL_GRAIN) { restY = y; break; }
    }
    // It should NOT be inside the nest (rows 12-18 are AIR shaft).
    // Its final resting row must be above the natural surface (row 12).
    expect(restY).toBeGreaterThanOrEqual(0);
    expect(restY).toBeLessThan(12);
  });

  it('food sitting above a buried entrance does not cascade through the surface', () => {
    const rng = new RNG(2);
    const w = caveInWorld();
    w.food[w.index(10, 5)] = 1;
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // The seed should have settled at row 11 (just above the
    // natural surface) at most — never below.
    let restY = -1;
    for (let y = 0; y < 25; y++) {
      if (w.food[w.index(10, y)]! > 0) { restY = y; break; }
    }
    expect(restY).toBeGreaterThanOrEqual(0);
    expect(restY).toBeLessThan(12);
  });

  it('corpse sitting above a buried entrance does not cascade through the surface', () => {
    const rng = new RNG(3);
    const w = caveInWorld();
    w.corpse[w.index(10, 5)] = 1;
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    let restY = -1;
    for (let y = 0; y < 25; y++) {
      if (w.corpse[w.index(10, y)]! > 0) { restY = y; break; }
    }
    expect(restY).toBeGreaterThanOrEqual(0);
    expect(restY).toBeLessThan(12);
  });

  it('a grain inside the nest still cascades freely (below-surface gravity preserved)', () => {
    // Verify the surface-barrier rule doesn't break legitimate
    // grain settling within the nest interior. Place a grain at
    // row 13 with AIR below it (rows 14-18); it should fall to
    // row 18 where the shaft ends in soil.
    const rng = new RNG(4);
    const w = caveInWorld();
    w.cells[w.index(10, 13)] = CELL_GRAIN;
    settleGrain(w, 10, 13, rng);
    let restY = -1;
    for (let y = 0; y < 25; y++) {
      if (w.cells[w.index(10, y)] === CELL_GRAIN) { restY = y; break; }
    }
    expect(restY).toBe(18); // bottom of the shaft, just above SOIL at row 19
  });
});

