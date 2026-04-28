// REST → WANDER transition correctness. After the rest timer
// expires, the rest of that tick must treat the ant as WANDER —
// not skip every WANDER-only branch (foraging roll, collision-
// overload, stigmergy, dig). A previously-resting ant should be
// fully-active the moment her rest ends.

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_REST, STATE_WANDER,
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
  larvaMetabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  eggLayInterval: 1e9,
  clumpInterval: 1e9,
};

function flatWorld(): World {
  const w = new World(40, 30);
  for (let x = 0; x < 40; x++) w.naturalSurface[x] = 12;
  for (let y = 12; y < 30; y++) {
    for (let x = 0; x < 40; x++) w.cells[w.index(x, y)] = CELL_SOIL;
  }
  // Wide chamber.
  for (let y = 12; y < 22; y++) {
    for (let x = 5; x < 35; x++) w.cells[w.index(x, y)] = CELL_AIR;
  }
  w.initialSoilCells = w.countSoil();
  return w;
}

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

describe('REST exit transition', () => {
  it('exits to WANDER cleanly and the ant has STATE_WANDER on the very next tick', () => {
    const rng = new RNG(1);
    const w = flatWorld();
    const colony = new Colony(1);
    colony.spawn(20.5, 15.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
    });
    colony.state[0] = STATE_REST;
    colony.stateTicks[0] = 0;
    const f = fields(w);
    // Custom params with restDuration = 5 so we hit the exit fast.
    const params = { ...DEFAULT_PARAMS, restDuration: 5 };
    for (let t = 0; t < 5; t++) {
      step(w, colony, f.dig, f.build, rng, params, undefined, QUIET);
    }
    // After the 5th step, restDuration crossed, ant should be WANDER.
    expect(colony.state[0]).toBe(STATE_WANDER);
    expect(colony.collisionCount[0]).toBe(0);
  });

  it('on the rest-exit tick itself, the ant rolls WANDER-only behaviour (forage transition)', () => {
    // The bug: on the tick a REST ant's timer expires, her stateIn
    // local stays STATE_REST so all subsequent `stateIn ===
    // STATE_WANDER` branches (forage roll, collision overload,
    // stigmergy bias) skip her — she only does geotaxis + movement
    // that tick. This test pins the foraging-roll path: a below-
    // surface WANDER ant with high forageProb should transition
    // into FORAGE on the rest-exit tick.
    const rng = new RNG(2);
    const w = flatWorld();
    w.tick = 3600; // noon — daylight=1 so the diurnal gate doesn't suppress forage (DAY_TICKS = 7200)
    const colony = new Colony(1);
    colony.spawn(20.5, 15.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0, restThreshold: 100,
    });
    colony.state[0] = STATE_REST;
    colony.stateTicks[0] = 0;
    const f = fields(w);
    const params = { ...DEFAULT_PARAMS, restDuration: 1 };
    // Use a custom species with very high forageProb so ONE tick of
    // WANDER post-exit reliably rolls into FORAGE.
    const FORAGE_HEAVY: AntSpecies = { ...QUIET, forageProb: 0.99, matureAge: 1 };
    // Age the ant so polyethism's forageMult is at the high end.
    colony.age[0] = FORAGE_HEAVY.matureAge * 2;
    step(w, colony, f.dig, f.build, rng, params, undefined, FORAGE_HEAVY);
    // Without the fix: stateIn stayed STATE_REST → forage roll
    // skipped → ant exits as STATE_WANDER but doesn't transition
    // further. With the fix: stateIn=WANDER → roll fires → FORAGE.
    expect([3 /* STATE_FORAGE */, 0 /* STATE_WANDER */]).toContain(colony.state[0]);
    // The bug-free behaviour at forageProb=0.99 should produce
    // STATE_FORAGE almost certainly (1% miss). If the test ever
    // flakes by landing on STATE_WANDER, it's still a correctness
    // proof — without the fix it'd be 100% STATE_WANDER.
    // We assert the strict pass condition:
    expect(colony.state[0]).toBe(3); // STATE_FORAGE
  });
});
