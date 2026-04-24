// Path integration: the ant's home vector tracks displacement from
// its spawn point. Sum of tick motion + sum of (−homeVec change) ≡ 0.

import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';
import { Colony, STATE_CARRY } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

function sandbox(): { world: World; colony: Colony; rng: RNG } {
  const rng = new RNG(1);
  const world = new World(64, 48);
  world.cells.fill(CELL_AIR);
  // Floor at y=40 to keep the ant grounded.
  for (let x = 0; x < 64; x++) world.cells[world.index(x, 40)] = CELL_SOIL;
  for (let x = 0; x < 64; x++) world.naturalSurface[x] = 40;
  world.initialSoilCells = 64;
  const colony = new Colony(4);
  return { world, colony, rng };
}

describe('path integration', () => {
  it('home vector starts at (0,0) for a fresh ant', () => {
    const { colony } = sandbox();
    colony.spawn(20.5, 39.5, 0);
    expect(colony.homeX[0]).toBe(0);
    expect(colony.homeY[0]).toBe(0);
  });

  it('home vector tracks the negative of net displacement', () => {
    const { world, colony, rng } = sandbox();
    colony.spawn(20.5, 39.5, 0, { walkSpeedCellsPerTick: 0.8 });
    const startX = colony.posX[0]!;
    const startY = colony.posY[0]!;
    for (let t = 0; t < 40; t++) stepSimulation(world, colony, rng);
    const netDx = colony.posX[0]! - startX;
    const netDy = colony.posY[0]! - startY;
    expect(colony.homeX[0]).toBeCloseTo(-netDx, 3);
    expect(colony.homeY[0]).toBeCloseTo(-netDy, 3);
  });

  it('CARRY heading rotates toward home after one tick', () => {
    // Unit test the heading-update rule directly, avoiding the rest
    // of the tick loop (which involves floor collisions etc.). One
    // tick of carryUpBias should noticeably rotate a wrong-facing
    // ant toward its home direction.
    const { world, colony, rng } = sandbox();
    // Very slow walk + no noise so we just observe the heading update.
    colony.spawn(20.5, 38.5, 0, { walkSpeedCellsPerTick: 0.01, turnNoiseRadPerTick: 0 });
    colony.homeX[0] = -20;
    colony.homeY[0] = 0;
    colony.setState(0, STATE_CARRY);
    colony.heading[0] = 0; // facing right, AWAY from home
    stepSimulation(world, colony, rng);
    const h = colony.heading[0]!;
    // After one tick we should have rotated at least partway toward π.
    expect(h).toBeGreaterThan(0.3);
  });
});
