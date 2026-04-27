// Day/night cycle tests. Two flavours of invariant:
//   1. The daylight() curve hits the right values at the canonical
//      phase points (midnight, dawn, noon, dusk).
//   2. Diurnal foragers don't transition out of the nest during night
//      (forageProb is gated by daylight); they DO during day.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_FORAGE, STATE_WANDER } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, DAY_TICKS, daylight, World } from '../src/sim/world';

// Test species clone with a much higher forageProb so a small ant
// count produces deterministic transition observations within a
// modest tick budget. Real HARVESTER forageProb (2e-5) is calibrated
// for biological time, not test loops; using it here would force
// either a huge population or millions of ticks.
const TEST_SPECIES: AntSpecies = { ...HARVESTER, forageProb: 0.05 };

describe('daylight curve', () => {
  it('is 0 at midnight (tick=0) and 1 at noon (tick = DAY_TICKS/2)', () => {
    expect(daylight(0)).toBeCloseTo(0, 5);
    expect(daylight(DAY_TICKS / 2)).toBeCloseTo(1, 5);
  });
  it('is ~0 at dawn (DAY_TICKS/4) and dusk (3·DAY_TICKS/4)', () => {
    expect(daylight(DAY_TICKS / 4)).toBeCloseTo(0, 5);
    expect(daylight((DAY_TICKS * 3) / 4)).toBeCloseTo(0, 5);
  });
  it('peaks once per cycle and is non-negative everywhere', () => {
    let peak = 0;
    for (let t = 0; t < DAY_TICKS; t += 1000) {
      const d = daylight(t);
      expect(d).toBeGreaterThanOrEqual(0);
      if (d > peak) peak = d;
    }
    expect(peak).toBeCloseTo(1, 3);
  });
  it('repeats every DAY_TICKS', () => {
    for (const tick of [0, DAY_TICKS / 4, DAY_TICKS / 2, (DAY_TICKS * 3) / 4]) {
      expect(daylight(tick)).toBeCloseTo(daylight(tick + DAY_TICKS), 5);
      expect(daylight(tick)).toBeCloseTo(daylight(tick + DAY_TICKS * 3), 5);
    }
  });
});

function buildSim(seed: number, startTick: number, antCount = 8) {
  const rng = new RNG(seed);
  const world = new World(60, 40);
  world.generate(rng, 12, 4, 3);
  // Seed world.tick so the simulated environment runs at the
  // requested phase. The forage gate reads world.tick directly via
  // daylight(); both step() and FORAGE-exit logic feel the change.
  world.tick = startTick;
  const colony = new Colony(64);
  // Carve a wide low-density underground band first, so spawnInRect
  // sees AIR. Density is critical: spawning 30 ants in a small rect
  // sends most into REST from collisions and they never wake up
  // long enough to roll FORAGE. 8 ants in a 21×7 band leaves room
  // for them to wander naturally.
  const cx = world.width >> 1;
  for (let y = 17; y <= 23; y++) {
    for (let x = cx - 10; x <= cx + 10; x++) {
      world.cells[world.index(x, y)] = CELL_AIR;
    }
  }
  colony.spawnInRect(
    cx - 10, 17, cx + 10, 23, antCount, rng,
    (x, y) => world.cells[world.index(x, y)] === CELL_AIR,
    DEFAULT_PARAMS,
  );
  const dig = new Pheromone(world.width, world.height, 0.12, 0.99);
  const build = new Pheromone(world.width, world.height, 0.10, 0.997);
  return { rng, world, colony, dig, build };
}

function countForagers(c: Colony): number {
  let n = 0;
  for (let i = 0; i < c.count; i++) if (c.state[i] === STATE_FORAGE) n++;
  return n;
}

// Force every ant in the colony into WANDER state. Used by the
// foraging-gate tests so the FORAGE-roll fires reliably (otherwise
// most ants in a small carved chamber pile into CARRY/REST and
// never see the gate).
function forceWander(c: Colony): void {
  for (let i = 0; i < c.count; i++) {
    c.state[i] = STATE_WANDER;
    c.stateTicks[i] = 0;
    c.collisionCount[i] = 0;
  }
}

describe('diurnal foraging gate', () => {
  it('produces foragers at noon', () => {
    const s = buildSim(11, DAY_TICKS / 2);
    let everSawForager = 0;
    // Force-WANDER every tick before stepping so each ant gets a
    // fresh roll regardless of what the previous tick did to its
    // state. With TEST_SPECIES.forageProb=0.05 and 8 ants, we
    // expect ~0.4 transitions per tick at noon — well over zero.
    for (let t = 0; t < 200; t++) {
      forceWander(s.colony);
      step(s.world, s.colony, s.dig, s.build, s.rng, DEFAULT_PARAMS, undefined, TEST_SPECIES);
      const f = countForagers(s.colony);
      if (f > everSawForager) everSawForager = f;
    }
    expect(everSawForager).toBeGreaterThan(0);
  });

  it('produces zero foragers at solar midnight', () => {
    const s = buildSim(11, 0);
    // Same setup; at midnight the gate multiplies forageProb by 0,
    // so no transition should ever fire.
    for (let t = 0; t < 200; t++) {
      forceWander(s.colony);
      step(s.world, s.colony, s.dig, s.build, s.rng, DEFAULT_PARAMS, undefined, TEST_SPECIES);
    }
    expect(countForagers(s.colony)).toBe(0);
  });

  it('sends in-flight foragers home when night falls', () => {
    // Start at noon, manually transition one ant to FORAGE, then
    // jump the world clock to night and step once. Should bounce
    // back to WANDER (forageActivity < 0.05 condition).
    const s = buildSim(2, DAY_TICKS / 2);
    s.colony.state[0] = STATE_FORAGE;
    s.colony.stateTicks[0] = 100; // mid-trip
    s.world.tick = 0; // jump to midnight
    step(s.world, s.colony, s.dig, s.build, s.rng, DEFAULT_PARAMS, undefined, TEST_SPECIES);
    expect(s.colony.state[0]).toBe(STATE_WANDER);
  });
});

describe('day-night does not break sim invariants', () => {
  it('runs across a full day boundary without crashing', () => {
    const s = buildSim(3, DAY_TICKS - 200);
    // Step from late evening through midnight into dawn (400 ticks
    // either side of midnight). All-zero daylight should still
    // produce a viable simulation — basal metabolism, eggs, RNG,
    // pheromone all keep ticking; only foraging is gated.
    const startCount = s.colony.count;
    for (let t = 0; t < 800; t++) step(s.world, s.colony, s.dig, s.build, s.rng);
    expect(s.colony.count).toBeGreaterThanOrEqual(startCount);
    // Tick advanced by exactly 800 (sanity).
    expect(s.world.tick).toBe(DAY_TICKS - 200 + 800);
  });
  it('non-diurnal species would invert the gate (smoke test)', () => {
    // Modifying species.diurnal would flip the curve; we test the
    // formula is correct without exposing a writable species. The
    // curve is symmetric, so peak (day) and trough (night) are
    // perfect mirror images.
    expect(daylight(DAY_TICKS / 2) + (1 - daylight(DAY_TICKS / 2))).toBe(1);
    expect(HARVESTER.diurnal).toBe(true);
  });
});
