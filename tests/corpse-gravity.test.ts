// Corpses must (a) drop onto the substrate rather than the carrier
// ant's row, and (b) settle when their supporting cell becomes AIR.
// Without these, the midden ends up as floating squares above the
// surface — visible bug in the user's screenshot at t=2,132,816.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_NECRO_CARRY, STATE_WANDER } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';

const FAST_NECRO: AntSpecies = {
  ...HARVESTER,
  necrophoresisProb: 1.0,
  necroHaulMinTicks: 0,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  sproutProb: 0,
  larvaMetabolism: 0,
  eggLayInterval: 1e9,
};

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

describe('corpse settling', () => {
  it('a NECRO_CARRY ant drops the corpse on the substrate, not high in the sky', () => {
    // World: flat surface at row 12. The NECRO_CARRY ant starts at
    // a high row (3) above ground; once she drops, the body should
    // settle just above the natural surface (row 11), NOT at her
    // body row (3) or any cell that's floating in mid-air.
    const rng = new RNG(1);
    const w = new World(40, 30);
    for (let x = 0; x < 40; x++) w.naturalSurface[x] = 12;
    for (let y = 12; y < 30; y++) {
      for (let x = 0; x < 40; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    w.initialSoilCells = w.countSoil();

    const colony = new Colony(1);
    colony.spawn(20.5, 3.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
    });
    colony.state[0] = STATE_NECRO_CARRY;
    colony.stateTicks[0] = 100;
    const f = fields(w);

    let dropped = false;
    for (let t = 0; t < 500; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, FAST_NECRO);
      if (colony.state[0] === STATE_WANDER) { dropped = true; break; }
    }
    expect(dropped).toBe(true);
    // Find the corpse cell.
    let droppedY = -1, droppedX = -1;
    for (let i = 0; i < w.corpse.length; i++) {
      if (w.corpse[i]! > 0) {
        droppedY = (i / w.width) | 0;
        droppedX = i - droppedY * w.width;
        break;
      }
    }
    expect(droppedY).toBe(11); // exactly one row above the natural surface
    // And no cell with row < 11 has a corpse — the body isn't floating.
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < w.width; x++) {
        expect(w.corpse[w.index(x, y)]).toBe(0);
      }
    }
    void droppedX;
  });

  it('grain underneath an existing corpse: when ants pick up the supporting grain, the corpse falls one row per gravity sweep', () => {
    // Stamp a corpse on top of a grain pile, then digest the grain
    // away. After the next gravity sweep the corpse must follow.
    const rng = new RNG(11);
    const w = new World(20, 30);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 15;
    for (let y = 15; y < 30; y++) {
      for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    // Two-row grain pile at column 10 above the surface, with a
    // corpse on the very top.
    w.cells[w.index(10, 13)] = CELL_GRAIN;
    w.cells[w.index(10, 14)] = CELL_GRAIN;
    w.initialSoilCells = w.countSoil();
    w.corpse[w.index(10, 12)] = 1;
    // Now remove the supporting grain (simulating an ant pickup).
    w.cells[w.index(10, 13)] = CELL_AIR;
    w.cells[w.index(10, 14)] = CELL_AIR;

    const colony = new Colony(0);
    const f = fields(w);
    // Run 60 ticks — two gravity sweeps (every 30) × 1 cell per
    // sweep is enough for the corpse to walk from row 12 to row 14.
    for (let t = 0; t < 60; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, FAST_NECRO);
    }
    expect(w.corpse[w.index(10, 12)]).toBe(0);
    expect(w.corpse[w.index(10, 14)]).toBe(1);
  });

  it('an orphaned floating corpse settles down to the substrate within ~30 ticks', () => {
    // Stamp a corpse at row 5 with AIR all the way to natural surface
    // at row 12. The 30-tick gravity sweep should walk it down.
    const rng = new RNG(2);
    const w = new World(20, 20);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 12;
    for (let y = 12; y < 20; y++) {
      for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    w.initialSoilCells = w.countSoil();
    w.corpse[w.index(10, 5)] = 1;

    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 300; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, FAST_NECRO);
    }
    // Corpse total still 1 (mass-conserving).
    let total = 0;
    for (let i = 0; i < w.corpse.length; i++) total += w.corpse[i]!;
    expect(total).toBe(1);
    // And the cell at the original (floating) row is now empty.
    expect(w.corpse[w.index(10, 5)]).toBe(0);
    // Body sits at row 11 (just above natural surface).
    expect(w.corpse[w.index(10, 11)]).toBe(1);
  });

  it('a stack of corpses doesn\'t merge — each one keeps its slot', () => {
    // Stamp 3 corpses at rows 2, 5, 9 in the same column with empty
    // air between them. The gravity sweep should compress them down
    // to consecutive rows just above the substrate without losing any.
    const rng = new RNG(3);
    const w = new World(20, 20);
    for (let x = 0; x < 20; x++) w.naturalSurface[x] = 12;
    for (let y = 12; y < 20; y++) {
      for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
    }
    w.initialSoilCells = w.countSoil();
    w.corpse[w.index(10, 2)] = 1;
    w.corpse[w.index(10, 5)] = 1;
    w.corpse[w.index(10, 9)] = 1;

    const colony = new Colony(0);
    const f = fields(w);
    for (let t = 0; t < 500; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, FAST_NECRO);
    }
    let total = 0;
    for (let i = 0; i < w.corpse.length; i++) total += w.corpse[i]!;
    expect(total).toBe(3);
    // Stack of 3 ends up at rows 11, 10, 9 — bottom-up settled.
    expect(w.corpse[w.index(10, 11)]).toBe(1);
    expect(w.corpse[w.index(10, 10)]).toBe(1);
    expect(w.corpse[w.index(10, 9)]).toBe(1);
  });
});
