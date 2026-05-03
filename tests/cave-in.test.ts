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

describe('floating-island collapse', () => {
  // World: surface at row 8, soil from row 8 down to row 24 (bottom).
  // A 6×4 chamber carved out of rows 12-15 cols 4-9 leaves a clean
  // cavity. We place a small isolated SOIL chunk in the middle of
  // the cavity — it has no contact with the surrounding earth.
  // After the sweep runs (every 50 ticks), the chunk must be gone
  // from its floating position and resettled at the chamber floor.
  function chamberWorld(): World {
    const w = new World(20, 25);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 8;
    for (let y = 8; y < 25; y++) {
      for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    // Carve chamber: rows 12-15, cols 4-9 (4 rows × 6 cols of AIR).
    for (let y = 12; y <= 15; y++) {
      for (let x = 4; x <= 9; x++) w.cells[w.index(x, y)] = CELL_AIR;
    }
    w.initialSoilCells = w.countSoil();
    return w;
  }

  it('a single isolated SOIL cell floating in a chamber falls to the floor', () => {
    const rng = new RNG(7);
    const w = chamberWorld();
    // Place an isolated SOIL cell mid-air at (6, 13). Its 4-cardinal
    // neighbours (5,13), (7,13), (6,12), (6,14) are all AIR (chamber
    // interior), so it's a 1-cell connected component disjoint from
    // the chamber walls.
    w.cells[w.index(6, 13)] = CELL_SOIL;
    expect(w.cells[w.index(6, 13)]).toBe(CELL_SOIL);
    const colony = new Colony(0);
    const f = fields(w);
    // Run 60 ticks so the world.tick % 50 === 0 sweep fires.
    for (let t = 0; t < 60; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // The original mid-air cell must be AIR now.
    expect(w.cells[w.index(6, 13)]).toBe(CELL_AIR);
    // The grain should have landed at row 15 (chamber floor) somewhere
    // in the chamber, since settleGrain cascades down + diagonal.
    let landedY = -1;
    for (let y = 25 - 1; y >= 0; y--) {
      for (let x = 4; x <= 9; x++) {
        if (w.cells[w.index(x, y)] === CELL_GRAIN) { landedY = y; break; }
      }
      if (landedY !== -1) break;
    }
    expect(landedY).toBe(15);
  });

  it('an anchored SOIL block (touching the world edge) is left intact', () => {
    const rng = new RNG(8);
    const w = chamberWorld();
    // The chamber walls themselves form an anchored mass connected
    // to lateral / bottom edges. They must NOT collapse. Verify by
    // taking a snapshot of soil cells before and confirming none of
    // the original chamber-wall cells become AIR after the sweep.
    const before = w.cells.slice();
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 60; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    for (let i = 0; i < before.length; i++) {
      if (before[i] === CELL_SOIL) {
        // No anchored SOIL should have been demoted to AIR or GRAIN.
        expect(w.cells[i]).toBe(CELL_SOIL);
      }
    }
  });

  it('grain conservation holds across the collapse sweep', () => {
    const rng = new RNG(9);
    const w = chamberWorld();
    // Place 3 isolated SOIL cells floating in the chamber.
    w.cells[w.index(5, 13)] = CELL_SOIL;
    w.cells[w.index(7, 13)] = CELL_SOIL;
    w.cells[w.index(6, 14)] = CELL_SOIL;
    // Recapture initialSoilCells so the invariant tracks the
    // post-placement total (the test setup is not a normal seed).
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 60; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // After the collapse, total solid (SOIL + GRAIN) must equal the
    // initial — no cells were created or destroyed, only retyped.
    expect(w.countSoil() + w.countGrains()).toBe(w.initialSoilCells);
  });
});
