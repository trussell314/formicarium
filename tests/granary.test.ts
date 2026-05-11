// CARRY_FOOD granary-pheromone gating. Confirms the deposit
// decision tracks the granary gradient (Tschinkel 2004 P. badius
// consistent-depth caches via positive feedback) instead of
// dumping in the first chamber the ant walks into.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_CARRY_FOOD, STATE_WANDER } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

const TRAITS = {
  digProb: 0.10,
  pickProb: 0.02,
  stigmergy: 0.55,
  turnNoise: 0.05,
  restThreshold: 8.0,
};

// Quiet species: no eggs, no foraging, no metabolism etc — so the
// ONLY thing happening is the CARRY_FOOD ant moving and depositing.
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
    dig: new Pheromone(w.width, w.height, 0.12, 0.9986),
    build: new Pheromone(w.width, w.height, 0.10, 0.99995),
    granary: new Pheromone(w.width, w.height, 0.08, 0.997),
  };
}

// Two-chamber world: surface row 6, satellite chamber rows 8-10
// at cols 4-7, central chamber rows 8-10 at cols 12-15. The two
// chambers are NOT connected — separate cavities so an ant put
// in one stays there.
function twoChambers(): World {
  const w = new World(20, 14);
  for (let x = 0; x < 20; x++) w.naturalSurface[x] = 6;
  for (let y = 6; y < 14; y++) {
    for (let x = 0; x < 20; x++) w.cells[w.index(x, y)] = CELL_SOIL;
  }
  for (let y = 8; y <= 10; y++) {
    for (let x = 4; x <= 7; x++) w.cells[w.index(x, y)] = CELL_AIR;
    for (let x = 12; x <= 15; x++) w.cells[w.index(x, y)] = CELL_AIR;
  }
  w.initialSoilCells = w.countSoil();
  return w;
}

describe('CARRY_FOOD granary gating', () => {
  it('with NO granary field present, deposits at the first below-surface AIR cell (legacy fallback)', () => {
    // Backward-compat path — when the caller doesn't pass a
    // granaryField, we keep the old "deposit anywhere underground"
    // behaviour so existing tests and any code paths that don't
    // wire up the granary pheromone still work.
    const rng = new RNG(101);
    const w = twoChambers();
    const colony = new Colony(1);
    colony.spawn(5.5, 9.5, 0, rng, TRAITS);
    colony.setState(0, STATE_CARRY_FOOD);
    const f = fields(w);
    let deposited = false;
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (colony.state[0] === STATE_WANDER) { deposited = true; break; }
    }
    expect(deposited).toBe(true);
  });

  it('with EMPTY granary field, ant does NOT deposit on the first available chamber tick', () => {
    // Granary field present but everywhere-zero. Without the gate
    // the ant would deposit on the very first below-surface AIR
    // cell — i.e. the cell she starts on. With the gate she keeps
    // walking, looking for a cell where granary pheromone has
    // already accumulated. Confirms the deposit-gate path actually
    // runs when granaryField is supplied.
    const rng = new RNG(102);
    const w = twoChambers();
    const colony = new Colony(1);
    colony.spawn(5.5, 9.5, 0, rng, TRAITS);
    colony.setState(0, STATE_CARRY_FOOD);
    const f = fields(w);
    // Step a handful of ticks. She'll be in CARRY_FOOD throughout
    // this window — the gate refuses every cell, the stuck-bail
    // (60 ticks) hasn't fired, and the bootstrap timeout (1500)
    // is far away. If the gate were missing, she'd have flipped
    // to WANDER on tick 1.
    for (let t = 0; t < 40; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined, f.granary);
    }
    expect(colony.state[0]).toBe(STATE_CARRY_FOOD);
  });

  it('a cell already strong in granary pheromone immediately qualifies for deposit', () => {
    // Pre-stamp granary pheromone in the central chamber. An ant
    // dropped into that chamber as CARRY_FOOD should deposit on
    // the FIRST step (or close to it) without waiting for the
    // bootstrap timeout — the gradient is already there.
    const rng = new RNG(103);
    const w = twoChambers();
    const f = fields(w);
    // Saturate granary in central chamber. deposit() at 5.0 puts
    // local concentration well above the 0.5 threshold.
    for (let y = 8; y <= 10; y++) {
      for (let x = 12; x <= 15; x++) {
        f.granary.deposit(x, y, 5.0);
      }
    }
    const colony = new Colony(1);
    // Start ant in the central chamber so the heading-bias
    // doesn't have to fight with cross-chamber navigation.
    colony.spawn(13.5, 9.5, 0, rng, TRAITS);
    colony.setState(0, STATE_CARRY_FOOD);
    const f2 = fields(w);
    let depositTick = -1;
    for (let t = 0; t < 100; t++) {
      step(w, colony, f2.dig, f2.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined, f.granary);
      if (colony.state[0] === STATE_WANDER) { depositTick = t; break; }
    }
    expect(depositTick).toBeGreaterThanOrEqual(0);
    expect(depositTick).toBeLessThan(50);
  });
});
