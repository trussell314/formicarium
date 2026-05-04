// Stuck-CARRY bail-out. When a CARRY or CARRY_FOOD ant has been
// jammed against a wall for ~60 ticks, she drops her cargo at an
// adjacent AIR cell and transitions to WANDER, freeing her to
// participate in digging instead of perpetually re-emitting alarm
// pheromone and pulling responders into a permanent REST cluster.

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_CARRY, STATE_CARRY_FOOD, STATE_WANDER,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
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

const TRAITS = {
  digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
};

describe('stuck-CARRY bail-out', () => {
  it('a CARRY worker permanently jammed against soil drops her grain and becomes WANDER', () => {
    const rng = new RNG(1);
    const w = new World(10, 20);
    for (let x = 0; x < 10; x++) w.naturalSurface[x] = 5;
    // Solid soil except for a 1-cell pocket at (5, 10).
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 10; x++) {
        const idx = w.index(x, y);
        w.cells[idx] = CELL_SOIL;
        w.grainHardness[idx] = 255;
      }
    }
    w.cells[w.index(5, 10)] = CELL_AIR;
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(1);
    colony.spawn(5.5, 10.5, 0, rng, TRAITS);
    colony.state[0] = STATE_CARRY;
    colony.carryMoves[0] = 3;
    const f = fields(w);
    let bailed = false;
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (colony.state[0] === STATE_WANDER) { bailed = true; break; }
    }
    expect(bailed).toBe(true);
    expect(colony.carryMoves[0]).toBe(0);
    expect(colony.stuckTicks[0]).toBe(0);
  });

  it('a CARRY_FOOD ant entombed in a 1-cell air pocket bails out and deposits her food', () => {
    // Surround a single AIR cell with SOIL on all four cardinals so
    // the ant truly cannot move. Leave one diagonal AIR cell so the
    // drop logic can place the food cargo there.
    const rng = new RNG(2);
    const w = new World(10, 20);
    for (let x = 0; x < 10; x++) w.naturalSurface[x] = 8;
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 10; x++) {
        const idx = w.index(x, y);
        w.cells[idx] = CELL_SOIL;
        w.grainHardness[idx] = 255;
      }
    }
    // Pocket at (5, 7) — above the natural surface.
    w.cells[w.index(5, 7)] = CELL_AIR;
    // Diagonal drop target.
    w.cells[w.index(4, 6)] = CELL_AIR;
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(1);
    colony.spawn(5.5, 7.5, Math.PI / 2, rng, TRAITS);
    colony.state[0] = STATE_CARRY_FOOD;
    colony.carryMoves[0] = 1;
    const f = fields(w);
    let bailed = false;
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (colony.state[0] === STATE_WANDER) { bailed = true; break; }
    }
    expect(bailed).toBe(true);
    expect(colony.carryMoves[0]).toBe(0);
    // Food cargo deposited somewhere — the bail-out tries 8 cardinal/
    // diagonal neighbours and uses the first AIR cell. Specific
    // landing column depends on which pocket cell the ant happened
    // to be standing in when the give-up timer fired.
    let foodCount = 0;
    for (let i = 0; i < w.food.length; i++) if (w.food[i]! > 0) foodCount++;
    expect(foodCount).toBe(1);
  });

  it('a CARRY worker that does make progress does NOT bail out', () => {
    // Two ants in a wide-open chamber; they can move freely. Stuck
    // counter should never accumulate enough to trigger the bail.
    const rng = new RNG(3);
    const w = new World(40, 30);
    for (let x = 0; x < 40; x++) w.naturalSurface[x] = 15;
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 40; x++) {
        w.cells[w.index(x, y)] = y < 15 ? CELL_AIR : CELL_SOIL;
      }
    }
    // Carve a wide chamber.
    for (let y = 15; y < 22; y++) {
      for (let x = 5; x < 35; x++) w.cells[w.index(x, y)] = CELL_AIR;
    }
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(1);
    colony.spawn(20.5, 18.5, 0, rng, TRAITS);
    colony.state[0] = STATE_CARRY;
    colony.carryMoves[0] = 2;
    const f = fields(w);
    for (let t = 0; t < 100; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // Stuck counter never crossed the threshold — ant is still CARRY.
    expect(colony.stuckTicks[0]).toBeLessThan(60);
    expect(colony.state[0]).toBe(STATE_CARRY);
  });
});
