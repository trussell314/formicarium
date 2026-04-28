// Larva stage tests. Egg → Larva → Worker pipeline (Hölldobler &
// Wilson 1990 Ch. 9). Verify:
//   1. Egg matures into LARVA (not directly into WANDER) after
//      species.eggMatureTicks.
//   2. Larva matures into WANDER after species.larvaMatureTicks.
//   3. Larva drains energy and dies (STATE_DEAD + corpse marker)
//      when neglected.
//   4. Larva is a valid trophallaxis recipient — a passing worker
//      can feed it.
//   5. Larva does not act as trophallaxis donor.

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_DEAD, STATE_EGG, STATE_LARVA, STATE_WANDER,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, World } from '../src/sim/world';

function makeWorld(): World {
  const world = new World(40, 30);
  for (let x = 0; x < world.width; x++) world.naturalSurface[x] = 12;
  for (let y = 12; y < 30; y++) {
    for (let x = 0; x < 40; x++) world.cells[world.index(x, y)] = 1;
  }
  for (let y = 12; y < 18; y++) {
    for (let x = 15; x <= 25; x++) world.cells[world.index(x, y)] = CELL_AIR;
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

const TRAITS = {
  digProb: 0, pickProb: 0, stigmergy: 0, turnNoise: 0,
  restThreshold: 100,
};

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

describe('larva stage', () => {
  it('egg matures into LARVA after species.eggMatureTicks', () => {
    const rng = new RNG(1);
    const w = makeWorld();
    const colony = new Colony(2);
    colony.spawn(20, 14, 0, rng, TRAITS);
    colony.state[0] = STATE_EGG;
    colony.stateTicks[0] = 0;
    const fast: AntSpecies = { ...HARVESTER, eggMatureTicks: 50, larvaMatureTicks: 1000 };
    const { dig, build } = fields(w);
    for (let t = 0; t < 60; t++) step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
    expect(colony.state[0]).toBe(STATE_LARVA);
  });

  it('larva matures into WANDER after species.larvaMatureTicks', () => {
    const rng = new RNG(2);
    const w = makeWorld();
    const colony = new Colony(2);
    colony.spawn(20, 14, 0, rng, TRAITS);
    colony.state[0] = STATE_LARVA;
    colony.stateTicks[0] = 0;
    colony.energy[0] = 1.0;
    const fast: AntSpecies = {
      ...HARVESTER, eggMatureTicks: 9999, larvaMatureTicks: 50,
      pupaMatureTicks: 20,
      larvaMetabolism: 0,
    };
    const { dig, build } = fields(w);
    // Run long enough to clear larva → pupa → adult.
    for (let t = 0; t < 100; t++) step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
    expect(colony.state[0]).toBe(STATE_WANDER);
    // Slightly less than maxEnergy after a few adult-metabolism
    // ticks following maturation; close-to is fine.
    expect(colony.energy[0]!).toBeCloseTo(HARVESTER.maxEnergy, 3);
  });

  it('larva starves and dies when neglected', () => {
    const rng = new RNG(3);
    const w = makeWorld();
    const colony = new Colony(2);
    colony.spawn(20, 14, 0, rng, TRAITS);
    colony.state[0] = STATE_LARVA;
    colony.stateTicks[0] = 0;
    colony.energy[0] = 0.01; // almost empty
    const fast: AntSpecies = {
      ...HARVESTER,
      eggMatureTicks: 9999,
      larvaMatureTicks: 1_000_000,
      larvaMetabolism: 0.001, // empties almost-empty larva in 10 ticks
    };
    const { dig, build } = fields(w);
    let died = false;
    for (let t = 0; t < 100; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
      if (colony.state[0] === STATE_DEAD) { died = true; break; }
    }
    expect(died).toBe(true);
    // Corpse marker placed at the larva's cell.
    expect(w.corpse[w.index(20, 14)]).toBe(1);
    expect(w.totalDied).toBe(1);
  });

  it('larva accepts trophallaxis from a passing worker', () => {
    const rng = new RNG(4);
    const w = makeWorld();
    const colony = new Colony(2);
    // Larva at (20, 14). Worker at (20.4, 14.5) — within the 2-cell
    // trophallaxis pair gate.
    colony.spawn(20.0, 14.5, 0, rng, TRAITS);
    colony.state[0] = STATE_LARVA;
    colony.stateTicks[0] = 0;
    colony.energy[0] = 0.10;
    colony.spawn(20.4, 14.5, 0, rng, TRAITS);
    colony.energy[1] = 0.95; // well-fed worker donor
    const noStarve: AntSpecies = {
      ...HARVESTER,
      larvaMetabolism: 0,
      eggMatureTicks: 9999,
      larvaMatureTicks: 9999,
      forageProb: 0,
      seedsPerTick: 0,
      metabolism: 0,
    };
    const { dig, build } = fields(w);
    const startLarva = colony.energy[0]!;
    const startWorker = colony.energy[1]!;
    for (let t = 0; t < 50; t++) step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, noStarve);
    expect(colony.energy[0]!).toBeGreaterThan(startLarva);
    expect(colony.energy[1]!).toBeLessThan(startWorker);
  });

  it('larva does NOT act as donor (hungry worker, fed larva)', () => {
    const rng = new RNG(5);
    const w = makeWorld();
    const colony = new Colony(2);
    colony.spawn(20.0, 14.5, 0, rng, TRAITS);
    colony.state[0] = STATE_LARVA;
    colony.stateTicks[0] = 0;
    colony.energy[0] = 0.95; // larva mysteriously full
    colony.spawn(20.4, 14.5, 0, rng, TRAITS);
    colony.energy[1] = 0.10; // hungry worker
    const noStarve: AntSpecies = {
      ...HARVESTER,
      larvaMetabolism: 0,
      eggMatureTicks: 9999,
      larvaMatureTicks: 9999,
      forageProb: 0,
      seedsPerTick: 0,
      metabolism: 0,
    };
    const { dig, build } = fields(w);
    for (let t = 0; t < 50; t++) step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, noStarve);
    // Worker did NOT receive — larva can't donate. Energies unchanged.
    expect(colony.energy[0]!).toBeCloseTo(0.95, 5);
    expect(colony.energy[1]!).toBeCloseTo(0.10, 5);
  });
});
