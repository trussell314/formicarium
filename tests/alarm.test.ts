// Alarm pheromone tests. Hölldobler & Wilson 1990 Ch. 7. Verify:
//   1. A CARRY_FOOD ant bumping into soil above the surface deposits
//      alarm pheromone at its cell (stranded-forager case).
//   2. A CARRY ant bumping into soil below the surface deposits
//      alarm pheromone (trapped-worker case).
//   3. A WANDER ant standing in a strong alarm gradient biases its
//      heading toward the gradient (alarm overrides routine dig
//      pheromone routing).
//   4. The Sudd dig gate (neighbourSoil >= 2) is bypassed when local
//      alarm is high — i.e. a surface ant on flat ground can dig
//      down into a buried entrance.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_CARRY, STATE_CARRY_FOOD } from '../src/sim/colony';
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
};

function flatWorld(w = 40, h = 30, surf = 12): World {
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = surf;
  for (let y = surf; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = world.index(x, y);
      world.cells[idx] = CELL_SOIL;
      // Pristine substrate is consolidated under the unified model.
      world.grainHardness[idx] = 255;
    }
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
    trail: new Pheromone(w.width, w.height, 0.40, 0.999),
    alarm: new Pheromone(w.width, w.height, 0.50, 0.985),
  };
}

const TRAITS = {
  digProb: 0.5, pickProb: 0, stigmergy: 0.7, turnNoise: 0,
  restThreshold: 100,
};

describe('alarm pheromone', () => {
  it('CARRY_FOOD bumping into soil above the surface deposits alarm', () => {
    const rng = new RNG(1);
    const w = flatWorld();
    // Put an ant at the surface row -1 (above natural surface) heading
    // straight down into solid ground (no chamber, no entrance).
    const colony = new Colony(1);
    colony.spawn(20.5, 11.5, Math.PI / 2, rng, TRAITS);
    colony.state[0] = STATE_CARRY_FOOD;
    const f = fields(w);
    let totalAlarm = 0;
    for (let t = 0; t < 50; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET, f.trail, f.alarm);
    }
    for (let i = 0; i < f.alarm.current.length; i++) totalAlarm += f.alarm.current[i]!;
    expect(totalAlarm).toBeGreaterThan(0);
  });

  it('CARRY bumping into soil below the surface deposits alarm', () => {
    const rng = new RNG(2);
    const w = flatWorld();
    // Carve a 1-cell pocket so the ant has somewhere to stand
    // underground; the soil walls around it are what she bumps.
    w.cells[w.index(20, 14)] = CELL_AIR;
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(1);
    // Spawn underground in the pocket, in CARRY state heading sideways
    // into the soil wall.
    colony.spawn(20.5, 14.5, 0, rng, TRAITS);
    colony.state[0] = STATE_CARRY;
    const f = fields(w);
    let totalAlarm = 0;
    for (let t = 0; t < 50; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET, f.trail, f.alarm);
    }
    for (let i = 0; i < f.alarm.current.length; i++) totalAlarm += f.alarm.current[i]!;
    expect(totalAlarm).toBeGreaterThan(0);
  });

  it('Sudd dig gate is bypassed when local alarm is strong', () => {
    // Surface ant on flat ground (1 cardinal SOIL neighbour: the
    // ground below). Without alarm, neighbourSoil < 2 → no dig.
    // Pre-paint a strong alarm signal at the ant's cell and verify
    // that dig fires (cell below becomes AIR).
    const rng = new RNG(3);
    const w = flatWorld(40, 30, 12);
    // Carve an air pocket at the ant's standing cell so the ant
    // is in AIR with SOIL only directly below.
    w.cells[w.index(20, 11)] = CELL_AIR;
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(1);
    colony.spawn(20.5, 11.5, Math.PI / 2, rng, { ...TRAITS, digProb: 1.0 });
    const f = fields(w);
    // Saturate alarm at the ant's cell so the bypass + boost both fire.
    for (let k = 0; k < 30; k++) f.alarm.deposit(20, 11, 1.0);
    const startSoil = w.countSoil();
    for (let t = 0; t < 80; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET, f.trail, f.alarm);
      // Keep refreshing alarm so evaporation doesn't drop the field
      // below threshold during the test. The ant wanders sideways
      // each tick, so paint the alarm at the ant's *current* cell
      // rather than fixing it at (20, 11).
      const ax = colony.posX[0]! | 0;
      const ay = colony.posY[0]! | 0;
      f.alarm.deposit(ax, ay, 1.0);
    }
    // The exact dug cell depends on bounce direction. What matters
    // is that *some* surface-row soil cell got dug — which only the
    // alarm bypass would let happen for a flat-ground surface ant.
    expect(w.countSoil()).toBeLessThan(startSoil);
  });

  it('WANDER ant biases heading toward the alarm gradient', () => {
    // Pre-paint an alarm gradient running east; place a WANDER ant
    // facing west and run a few ticks. With strong alarm, the ant
    // should rotate toward the gradient (east). Movement is gated by
    // tryStep, so we just check the final position drift, not exact
    // heading.
    const rng = new RNG(4);
    const w = flatWorld(80, 30, 12);
    // Carve a flat tunnel underground so the ant can move freely.
    for (let y = 14; y <= 16; y++) {
      for (let x = 5; x < 75; x++) w.cells[w.index(x, y)] = CELL_AIR;
    }
    w.initialSoilCells = w.countSoil();
    const f = fields(w);
    // Strong alarm at the east end.
    for (let x = 50; x <= 70; x++) {
      for (let k = 0; k < 5; k++) f.alarm.deposit(x, 15, (x - 50) / 20);
    }
    const colony = new Colony(1);
    colony.spawn(20.5, 15.5, Math.PI, rng, TRAITS); // facing west
    const startX = colony.posX[0]!;
    let movedEast = false;
    for (let t = 0; t < 200; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET, f.trail, f.alarm);
      // Re-paint each tick so it doesn't fully evaporate.
      for (let x = 50; x <= 70; x++) f.alarm.deposit(x, 15, (x - 50) / 20 * 0.1);
      if (colony.posX[0]! > startX + 2) { movedEast = true; break; }
    }
    expect(movedEast).toBe(true);
  });
});
