// Food + foraging behaviour. A WANDER ant on the surface that
// encounters a CELL_FOOD cell picks it up, transitions to HAUL,
// heads home, and deposits CELL_FOOD_STORE in the nest.

import { describe, expect, it } from 'vitest';
import {
  CELL_AIR,
  CELL_FOOD,
  CELL_FOOD_STORE,
  CELL_SOIL,
  World,
} from '../src/sim/world';
import { Colony, STATE_HAUL, STATE_WANDER } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

function sandbox(): { world: World; colony: Colony; rng: RNG } {
  const rng = new RNG(1);
  const world = new World(40, 30);
  // Surface at row 10. Soil below.
  world.cells.fill(CELL_AIR);
  for (let x = 0; x < 40; x++) world.naturalSurface[x] = 10;
  for (let x = 0; x < 40; x++) {
    for (let y = 10; y < 30; y++) world.cells[world.index(x, y)] = CELL_SOIL;
  }
  // Carve a small chamber so HAUL ants have somewhere to deposit.
  for (let y = 11; y < 20; y++) for (let x = 18; x < 22; x++) world.cells[world.index(x, y)] = CELL_AIR;
  world.initialSoilCells = world.countSoil();
  const colony = new Colony(4);
  return { world, colony, rng };
}

describe('food + foraging', () => {
  it('a WANDER ant entering a CELL_FOOD cell transitions to HAUL', () => {
    const { world, colony, rng } = sandbox();
    // Place food at (5, 9), one row above the surface.
    world.cells[world.index(5, 9)] = CELL_FOOD;
    // Spawn ant just to the left of the food, heading right.
    colony.spawn(4.0, 9.5, 0, {
      walkSpeedCellsPerTick: 0.5,
      turnNoiseRadPerTick: 0,
      restThreshold: 9,
    });
    // Bias the ant toward the food (override above-surface
    // go-down rule by giving it a head-start).
    for (let t = 0; t < 30 && colony.state[0] !== STATE_HAUL; t++) {
      stepSimulation(world, colony, rng, 0.8, undefined, undefined, 0);
    }
    expect(colony.state[0]).toBe(STATE_HAUL);
    expect(world.cells[world.index(5, 9)]).toBe(CELL_AIR); // food consumed
  });

  it('a HAUL ant near home deposits CELL_FOOD_STORE and returns to WANDER', () => {
    const { world, colony, rng } = sandbox();
    // Spawn an ant inside the chamber (this is "home" — homeX/Y are 0)
    // already in HAUL state.
    colony.spawn(20, 15, 0, { walkSpeedCellsPerTick: 0.05, turnNoiseRadPerTick: 0 });
    colony.setState(0, STATE_HAUL);
    colony.homeX[0] = 0;
    colony.homeY[0] = 0;
    // Run until the ant drops the food.
    let storedAt: { x: number; y: number } | null = null;
    for (let t = 0; t < 60 && colony.state[0] !== STATE_WANDER; t++) {
      stepSimulation(world, colony, rng, 0.8, undefined, undefined, 0);
      // Find a CELL_FOOD_STORE cell.
      for (let yi = 0; yi < world.height && !storedAt; yi++) {
        for (let xi = 0; xi < world.width; xi++) {
          if (world.cells[yi * world.width + xi] === CELL_FOOD_STORE) {
            storedAt = { x: xi, y: yi };
            break;
          }
        }
      }
    }
    expect(colony.state[0]).toBe(STATE_WANDER);
    expect(storedAt).not.toBeNull();
    // Stored food must be in the chamber (below natural surface).
    expect(storedAt!.y).toBeGreaterThanOrEqual(world.naturalSurface[storedAt!.x]!);
  });
});
