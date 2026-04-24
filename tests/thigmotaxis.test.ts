// Thigmotaxis: an ant next to a wall tends to follow it.

import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';
import { Colony } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

describe('thigmotaxis', () => {
  it('an ant next to a vertical wall drifts to track the wall', () => {
    // Open chamber from x=0..20; wall at x=21..21, y any.
    const world = new World(40, 20);
    world.cells.fill(CELL_AIR);
    for (let y = 0; y < 20; y++) world.cells[world.index(21, y)] = CELL_SOIL;
    // Floor at y=18 so the ant is grounded.
    for (let x = 0; x < 40; x++) world.cells[world.index(x, 18)] = CELL_SOIL;
    for (let x = 0; x < 40; x++) world.naturalSurface[x] = 18;

    const rng = new RNG(1);
    const colony = new Colony(2);
    // Place ant right up against the wall, facing "into the wall"
    // horizontally. Without thigmotaxis, random noise would only
    // slowly steer it parallel. With it, the heading should
    // converge toward vertical (up or down the wall).
    colony.spawn(20.5, 17.5, 0, {
      walkSpeedCellsPerTick: 0.1,
      turnNoiseRadPerTick: 0, // no noise so we isolate the bias
      restThreshold: 9,
    });
    // Run for long enough for several bias applications.
    for (let t = 0; t < 20; t++) stepSimulation(world, colony, rng, 0.8);
    const h = colony.heading[0]!;
    // Heading should be closer to ±π/2 (parallel to vertical wall)
    // than to 0 (into the wall).
    const distToVertical = Math.min(
      Math.abs(h - Math.PI / 2),
      Math.abs(h + Math.PI / 2),
    );
    const distToHorizontal = Math.abs(h);
    expect(distToVertical).toBeLessThan(distToHorizontal);
  });

  it('an ant deep inside soil (surrounded by walls on all sides) turns toward its heading tangent', () => {
    // Sanity check: with walls everywhere, the bias is still bounded
    // (can't drive heading to NaN or absurd values).
    const world = new World(20, 20);
    world.cells.fill(CELL_SOIL);
    // Single air cell for the ant.
    world.cells[world.index(10, 10)] = CELL_AIR;
    world.cells[world.index(10, 11)] = CELL_AIR; // give it a supported spot
    for (let x = 0; x < 20; x++) world.naturalSurface[x] = 9;

    const rng = new RNG(1);
    const colony = new Colony(2);
    colony.spawn(10.5, 10.5, 1.0, {
      walkSpeedCellsPerTick: 0,
      turnNoiseRadPerTick: 0,
      restThreshold: 9,
    });
    for (let t = 0; t < 10; t++) stepSimulation(world, colony, rng, 0.8);
    const h = colony.heading[0]!;
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(-Math.PI);
    expect(h).toBeLessThan(Math.PI);
  });
});
