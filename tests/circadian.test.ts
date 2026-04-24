// Circadian activity modulation — walkSpeed / digProb / turnNoise
// scale with daylight, bounded below by a baseline so ants still
// move minimally at night.

import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';
import { Colony } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

function sandbox(): { world: World; colony: Colony } {
  const world = new World(40, 30);
  world.cells.fill(CELL_AIR);
  for (let x = 0; x < 40; x++) world.cells[world.index(x, 20)] = CELL_SOIL;
  for (let x = 0; x < 40; x++) world.naturalSurface[x] = 20;
  return { world, colony: new Colony(2) };
}

function totalTravel(seed: number, dayDur: number, nightDur: number, offsetTicks: number): number {
  const rng = new RNG(seed);
  const { world, colony } = sandbox();
  colony.spawn(20.5, 19.5, 0, {
    walkSpeedCellsPerTick: 0.2,
    turnNoiseRadPerTick: 0.05,
    restThreshold: 9, // don't rest
  });
  // Advance tickCount so we start at the desired phase without
  // actually stepping.
  world.tickCount = offsetTicks;
  const startX = colony.posX[0]!;
  const startY = colony.posY[0]!;
  let moved = 0;
  for (let t = 0; t < 100; t++) {
    stepSimulation(world, colony, rng, 0.8, undefined, {
      dayDurationTicks: dayDur, nightDurationTicks: nightDur,
    });
    moved += Math.hypot(
      colony.posX[0]! - startX, colony.posY[0]! - startY,
    );
  }
  return moved;
}

describe('circadian modulation', () => {
  it('ants travel more during day ticks than night ticks', () => {
    // Day offset 0 (noon region), night offset after day ends.
    const dayTravel = totalTravel(1, 100, 100, 0);
    const nightTravel = totalTravel(1, 100, 100, 150);
    expect(dayTravel).toBeGreaterThan(nightTravel * 1.5);
  });

  it('no cycle passed → no modulation (full-speed always)', () => {
    const rng = new RNG(1);
    const { world, colony } = sandbox();
    colony.spawn(20.5, 19.5, 0, {
      walkSpeedCellsPerTick: 0.2, turnNoiseRadPerTick: 0,
      restThreshold: 9,
    });
    // Without a cycle, activity should be 1 → ant covers ~0.2 cells/tick.
    const startX = colony.posX[0]!;
    for (let t = 0; t < 50; t++) stepSimulation(world, colony, rng);
    const moved = Math.abs(colony.posX[0]! - startX);
    // 50 ticks × 0.2 cells = 10, minus some loss from wall bouncing.
    // We're generous here: just check it's clearly > night-speed.
    expect(moved).toBeGreaterThan(3);
  });
});
