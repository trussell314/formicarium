import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';
import { Colony, STATE_REST, STATE_WANDER } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

function sandbox(): { world: World; colony: Colony; rng: RNG } {
  const rng = new RNG(1);
  const world = new World(40, 30);
  world.cells.fill(CELL_AIR);
  for (let x = 0; x < 40; x++) world.cells[world.index(x, 20)] = CELL_SOIL;
  for (let x = 0; x < 40; x++) world.naturalSurface[x] = 20;
  const colony = new Colony(12);
  return { world, colony, rng };
}

describe('task allocation — REST via Beshers & Fewell thresholds', () => {
  it('isolated ants do not rest', () => {
    // Single ant, no crowding, never should transition to REST.
    const { world, colony, rng } = sandbox();
    colony.spawn(20.5, 19.5, 0, { restThreshold: 3 });
    for (let t = 0; t < 500; t++) stepSimulation(world, colony, rng, 0.8);
    expect(colony.state[0]).not.toBe(STATE_REST);
  });

  it('a tight cluster produces REST transitions', () => {
    // 10 ants in a tiny cluster — high crowding triggers REST.
    const { world, colony, rng } = sandbox();
    for (let i = 0; i < 10; i++) {
      const x = 20.5 + (i % 3) * 0.3;
      const y = 19.5 + ((i / 3) | 0) * 0.3;
      colony.spawn(x, y, 0, {
        restThreshold: 2,
        walkSpeedCellsPerTick: 0.05,
        turnNoiseRadPerTick: 0,
      });
    }
    let sawRest = false;
    for (let t = 0; t < 500; t++) {
      stepSimulation(world, colony, rng, 0.8);
      for (let i = 0; i < colony.count; i++) {
        if (colony.state[i] === STATE_REST) sawRest = true;
      }
    }
    expect(sawRest).toBe(true);
  });

  it('REST ants return to WANDER after REST_DURATION_TICKS', () => {
    const { world, colony, rng } = sandbox();
    colony.spawn(20.5, 19.5, 0);
    colony.setState(0, STATE_REST);
    // Exactly REST_DURATION_TICKS = 50 in the module.
    for (let t = 0; t < 60; t++) stepSimulation(world, colony, rng, 0.8);
    expect(colony.state[0]).toBe(STATE_WANDER);
  });

  it('lower restThreshold → ant is more likely to rest under crowd', () => {
    // Two identical crowded scenarios, but one ant has threshold 1.5
    // and the other 5. The low-threshold ant should spend more
    // total ticks in REST.
    const run = (threshold: number): number => {
      const { world, colony, rng } = sandbox();
      // Victim ant at index 0.
      colony.spawn(20.5, 19.5, 0, { restThreshold: threshold, walkSpeedCellsPerTick: 0.05 });
      // Crowd around it.
      for (let i = 0; i < 8; i++) {
        colony.spawn(20.5 + (i % 3) * 0.4, 19.5 + 0.1, 0, {
          restThreshold: 5, walkSpeedCellsPerTick: 0.05,
        });
      }
      let restTicks = 0;
      for (let t = 0; t < 500; t++) {
        stepSimulation(world, colony, rng, 0.8);
        if (colony.state[0] === STATE_REST) restTicks++;
      }
      return restTicks;
    };
    const low = run(1.5);
    const high = run(5);
    expect(low).toBeGreaterThan(high);
  });
});
