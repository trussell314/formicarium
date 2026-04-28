// Queen pheromone tests. Hölldobler & Wilson 1990 Ch. 7 on caste
// recognition substances. Verify:
//   1. The queen emits at her cell each tick — local concentration
//      grows during a sustained run.
//   2. A young (nurse-aged) WANDER worker placed near a strong queen
//      gradient drifts up-gradient toward the queen.
//   3. An old (forager-aged) WANDER worker does NOT bias toward the
//      queen — she has other jobs.
//   4. With queenField undefined, the simulation runs without
//      crashing (the field is opt-in, not required).

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN, STATE_WANDER } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, World } from '../src/sim/world';

const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  larvaMetabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  eggLayInterval: 1e9,
};

function chamberWorld(): World {
  // 60×40 with a wide chamber underground at y=15..22.
  const w = new World(60, 40);
  for (let x = 0; x < 60; x++) w.naturalSurface[x] = 14;
  for (let y = 14; y < 40; y++) {
    for (let x = 0; x < 60; x++) w.cells[w.index(x, y)] = 1;
  }
  for (let y = 14; y < 23; y++) {
    for (let x = 5; x < 55; x++) w.cells[w.index(x, y)] = CELL_AIR;
  }
  w.initialSoilCells = w.countSoil();
  return w;
}

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
    queen: new Pheromone(w.width, w.height, 0.10, 0.9999),
  };
}

const NURSE_TRAITS = {
  digProb: 0, pickProb: 0, stigmergy: 0.7, turnNoise: 0.05, restThreshold: 100,
};

describe('queen pheromone', () => {
  it('queen emits per tick — concentration accumulates at her cell', () => {
    const rng = new RNG(1);
    const w = chamberWorld();
    const colony = new Colony(2);
    colony.spawn(30.5, 18.5, 0, rng, NURSE_TRAITS);
    colony.state[0] = STATE_QUEEN;
    colony.energy[0] = HARVESTER.maxEnergy;
    const f = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET, undefined, undefined, f.queen);
    }
    // Concentration at the queen's cell should be well above zero
    // after a sustained emission run.
    expect(f.queen.sample(30, 18)).toBeGreaterThan(0.5);
  });

  it('a young (nurse-age) worker rotates her heading toward a queen-east gradient', () => {
    // Place a steep gradient running east through row 18, and a
    // nurse facing west at the gradient's local maximum. After one
    // tick of step() the bias should have rotated her heading toward
    // east (away from facing-west). We test heading delta directly
    // because spatial drift in 80 ticks depends on bouncing off
    // chamber walls and isn't a clean signal.
    const rng = new RNG(2);
    const w = chamberWorld();
    const f = fields(w);
    for (let x = 10; x <= 50; x++) {
      for (let k = 0; k < 50; k++) {
        f.queen.deposit(x, 18, (x - 10) / 40);
      }
    }
    const colony = new Colony(1);
    // Facing west (heading π), so the east-pointing gradient is
    // 180° away. Any nurse-bias rotates her heading away from π.
    colony.spawn(20.5, 18.5, Math.PI, rng, NURSE_TRAITS);
    colony.age[0] = 0; // pure nurse
    const headingStart = colony.heading[0]!;
    // One tick. Don't go further — we want to isolate the per-tick
    // bias effect from movement and bouncing.
    step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET, undefined, undefined, f.queen);
    const headingNurse = colony.heading[0]!;
    expect(Math.abs(headingNurse - headingStart)).toBeGreaterThan(0.1);
  });

  it('an old (forager-age) worker does NOT rotate toward the queen gradient', () => {
    // Same setup as the nurse test, but with an aged-out worker.
    // The queen-bias gate (ageFrac < 0.5) returns false so heading
    // stays near her starting value — only the small turnNoise +
    // geotaxis perturb it. Compare to the nurse delta to confirm
    // the field is the only thing pulling her around.
    //
    // Pad the colony to >= 30 workers so the small-colony override
    // (which forces queen attendance regardless of age in tiny
    // colonies) doesn't fire. We test the AGE gate in isolation.
    const rng = new RNG(3);
    const w = chamberWorld();
    const f = fields(w);
    for (let x = 10; x <= 50; x++) {
      for (let k = 0; k < 50; k++) {
        f.queen.deposit(x, 18, (x - 10) / 40);
      }
    }
    const colony = new Colony(40);
    colony.spawn(20.5, 18.5, Math.PI, rng, { ...NURSE_TRAITS, turnNoise: 0 });
    colony.age[0] = HARVESTER.matureAge * 2; // ageFrac saturates at 1
    // Pad with 35 dummy WANDER workers so aliveWorkers >= 30. They
    // sit out of the gradient (column 5, far from the deposit) so
    // they don't perturb the test ant.
    for (let k = 0; k < 35; k++) {
      colony.spawn(5.5, 18.5, 0, rng, NURSE_TRAITS);
    }
    const headingStart = colony.heading[0]!;
    step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET, undefined, undefined, f.queen);
    const headingForager = colony.heading[0]!;
    // Heading change should be small — only the deterministic
    // geotaxis bias (which is symmetric on the chamber row) and
    // bounce-off-soil events. With turnNoise=0 there's no random
    // walk component.
    expect(Math.abs(headingForager - headingStart)).toBeLessThan(0.5);
  });

  it('runs cleanly with queenField left undefined', () => {
    const rng = new RNG(4);
    const w = chamberWorld();
    const f = fields(w);
    const colony = new Colony(2);
    colony.spawn(30.5, 18.5, 0, rng, NURSE_TRAITS);
    colony.state[0] = STATE_QUEEN;
    colony.spawn(20.5, 18.5, 0, rng, NURSE_TRAITS);
    for (let t = 0; t < 50; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    // No crash, queen still alive (metabolism = 0).
    expect(colony.state[0]).toBe(STATE_QUEEN);
    expect(colony.state[1]).toBe(STATE_WANDER);
  });
});
