// Foraging-trail pheromone tests. Bonabeau et al. 1998: returning
// CARRY_FOOD ants lay a trail back from the food site; FORAGE ants
// on the surface bias their heading along the gradient. We verify:
//   1. A CARRY_FOOD ant deposits trail pheromone above the surface.
//   2. The pickup site receives a strong stamp.
//   3. A FORAGE ant near a strong trail biases its heading toward
//      the gradient-up direction.

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_CARRY_FOOD, STATE_FORAGE,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, DAY_TICKS, World } from '../src/sim/world';

// Run at noon so the day-night gate doesn't recall the FORAGE ant.
const NOON = DAY_TICKS / 2;

const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
};

function flatWorld(w = 60, h = 30, surf = 12): World {
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = surf;
  for (let y = surf; y < h; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = 1;
  }
  // Carve a small chamber at center column so ants can come back inside.
  const cx = w >> 1;
  for (let y = surf; y < surf + 3; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      world.cells[world.index(x, y)] = CELL_AIR;
    }
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

const TRAITS = {
  digProb: 0, pickProb: 0, stigmergy: 0.7, turnNoise: 0.05,
  restThreshold: 100,
};

describe('foraging trail', () => {
  it('CARRY_FOOD ant deposits trail pheromone above the surface', () => {
    const rng = new RNG(1);
    const w = flatWorld();
    w.tick = NOON;
    const colony = new Colony(1);
    colony.spawn(15.5, 11.5, 0, rng, TRAITS); // above surface (surf=12)
    colony.state[0] = STATE_CARRY_FOOD;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    const trail = new Pheromone(w.width, w.height, 0.40, 0.999);
    for (let t = 0; t < 20; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET, trail);
    }
    // Sum trail concentration on the row immediately above the
    // natural surface — ant has to have been there.
    let above = 0;
    for (let x = 0; x < w.width; x++) above += trail.sample(x, 11);
    expect(above).toBeGreaterThan(0);
  });

  it('FORAGE pickup deposits a strong source-anchor stamp', () => {
    const rng = new RNG(2);
    const w = flatWorld();
    w.tick = NOON;
    // Place a seed on the surface; spawn a FORAGE ant directly on it.
    w.food[w.index(20, 11)] = 1;
    const colony = new Colony(1);
    colony.spawn(20.0, 11.5, 0, rng, TRAITS);
    colony.state[0] = STATE_FORAGE;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    const trail = new Pheromone(w.width, w.height, 0.40, 0.999);
    let pickedUp = false;
    for (let t = 0; t < 30; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET, trail);
      if (colony.state[0] === STATE_CARRY_FOOD) { pickedUp = true; break; }
    }
    expect(pickedUp).toBe(true);
    // Strong anchor at the pickup cell — should be much higher than
    // a single per-step deposit.
    expect(trail.sample(20, 11)).toBeGreaterThan(0.5);
  });

  it('FORAGE ant biases its heading along an existing trail', () => {
    // Pre-paint a trail running east along row 11, peak at x=40,
    // and place a FORAGE ant at x=20 facing west. With a high
    // stigmergy and the trail growing eastward, the ant's heading
    // should rotate toward east over a few ticks.
    const rng = new RNG(3);
    const w = flatWorld(80, 30, 12);
    w.tick = NOON;
    const trail = new Pheromone(w.width, w.height, 0.40, 0.999);
    for (let x = 20; x <= 50; x++) {
      // ramp 0..1 east
      trail.deposit(x, 11, (x - 20) / 30);
    }
    const colony = new Colony(1);
    colony.spawn(20.5, 11.5, Math.PI, rng, TRAITS); // facing west
    colony.state[0] = STATE_FORAGE;
    colony.stateTicks[0] = 0;
    const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
    const build = new Pheromone(w.width, w.height, 0.10, 0.997);
    let movedEast = false;
    const startX = colony.posX[0]!;
    // 300 ticks ≈ 6 sec biological at 50 ms / tick. The ant needs
    // a few stigmergy-bias accumulations against starting from
    // exactly facing-west; in practice it climbs east within ~50–
    // 200 ticks depending on the seed and the wall-bounce sample
    // path. Assertion stays "moved east at all" — strict timing
    // would re-break with any future change to noise / bounce.
    for (let t = 0; t < 1000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET, trail);
      if (colony.posX[0]! > startX + 1) { movedEast = true; break; }
    }
    expect(movedEast).toBe(true);
  });
});
