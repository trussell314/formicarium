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

describe('above-ground spire erosion', () => {
  // Real ant mounds erode to angle-of-repose: a 1-cell-wide column
  // of consolidated SOIL standing in air can't bear its own weight
  // and topples. Verify the periodic erosion sweep demotes such
  // pillars to loose and cascades them sideways into a flatter pile.
  function spireWorld(): World {
    const w = new World(20, 25);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 15;
    for (let y = 15; y < 25; y++) {
      for (let x = 0; x < 20; x++) {
        const idx = w.index(x, y);
        w.cells[idx] = CELL_SOIL;
        w.grainHardness[idx] = 255;
      }
    }
    // Plant a 5-cell-tall consolidated pillar at column 10, rows 9..13
    // (above the surface), with AIR all around. Both lateral cells
    // at every row are AIR — the erosion rule's trigger condition.
    for (let y = 9; y <= 13; y++) {
      const idx = w.index(10, y);
      w.cells[idx] = CELL_SOIL;
      w.grainHardness[idx] = 255; // fully consolidated
    }
    w.initialSoilCells = w.countSoil();
    return w;
  }

  it('a 5-cell consolidated above-ground pillar topples', () => {
    const rng = new RNG(31);
    const w = spireWorld();
    const colony = new Colony(0);
    const f = fields(w);
    // Pre-condition: column 10 has 5 SOIL cells from rows 9..13 (above surface 15).
    let before = 0;
    for (let y = 9; y <= 13; y++) {
      if (w.cells[w.index(10, y)] === CELL_SOIL) before++;
    }
    expect(before).toBe(5);
    // Run 250 ticks (sweep fires every 100; 2-3 sweeps lets the
    // pillar fully cascade).
    for (let t = 0; t < 250; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // Post-condition: column 10 should have fewer SOIL cells in rows
    // 9..13 (some/all toppled). The grains should now be sitting on
    // the natural surface in adjacent columns.
    let after = 0;
    for (let y = 9; y <= 13; y++) {
      if (w.cells[w.index(10, y)] === CELL_SOIL) after++;
    }
    expect(after).toBeLessThan(before);
  });

  it('a wide mound is NOT eroded (lateral support)', () => {
    // Sanity check: a 5-cell-wide above-ground mound (whose middle
    // cells have lateral SOIL neighbours) must not lose mass to the
    // erosion sweep. Only the topmost edge cells could possibly
    // qualify — but only if they're 1-cell-wide at that row.
    const rng = new RNG(32);
    const w = new World(20, 25);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 15;
    for (let y = 15; y < 25; y++) {
      for (let x = 0; x < 20; x++) {
        const idx = w.index(x, y);
        w.cells[idx] = CELL_SOIL;
        w.grainHardness[idx] = 255;
      }
    }
    // 5-wide × 3-tall consolidated mound: cols 8..12, rows 12..14.
    for (let y = 12; y <= 14; y++) {
      for (let x = 8; x <= 12; x++) {
        const idx = w.index(x, y);
        w.cells[idx] = CELL_SOIL;
        w.grainHardness[idx] = 255;
      }
    }
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(0);
    const f = fields(w);
    // The middle column (10) has SOIL on both sides at every row —
    // erosion rule should leave it untouched. Run the sweep a few
    // times to be sure.
    for (let t = 0; t < 250; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    for (let y = 12; y <= 14; y++) {
      expect(w.cells[w.index(10, y)]).toBe(CELL_SOIL);
    }
  });
});
