// Depth (posZ) and 3D collision avoidance.

import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';
import { Colony } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { buildFromScenario, CELLS_PER_CM } from '../src/scenario';
import { RNG } from '../src/sim/rng';

function sandbox(): { world: World; colony: Colony; rng: RNG } {
  const rng = new RNG(1);
  const world = new World(64, 48);
  world.cells.fill(CELL_AIR);
  for (let x = 0; x < 64; x++) world.cells[world.index(x, 30)] = CELL_SOIL;
  for (let x = 0; x < 64; x++) world.naturalSurface[x] = 30;
  const colony = new Colony(8);
  return { world, colony, rng };
}

describe('depth dimension', () => {
  it('scenario resolver exposes slabThicknessCm with a sensible default', () => {
    const { resolved } = buildFromScenario({
      name: 't', ants: { worker: { count: 1 } },
    });
    expect(resolved.slabThicknessCm).toBeGreaterThan(0);
    expect(resolved.slabThicknessCm).toBeLessThanOrEqual(2);
  });

  it('ants spawn at varied z within the slab', () => {
    const { colony, resolved } = buildFromScenario({
      name: 't',
      seed: 7,
      slabThicknessCm: 1.0,
      ants: { worker: { count: 10 } },
    });
    const zs = new Set<number>();
    for (let i = 0; i < colony.count; i++) {
      const z = colony.posZ[i]!;
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(resolved.slabThicknessCm);
      zs.add(z);
    }
    // Expect at least half the ants to have distinct z values.
    expect(zs.size).toBeGreaterThanOrEqual(5);
  });

  it('stays in [zMin, zMax] across many ticks', () => {
    const { world, colony, rng } = sandbox();
    for (let i = 0; i < 5; i++) {
      colony.spawn(10 + i * 3, 29.5, 0, { posZ: 0.4 });
    }
    for (let t = 0; t < 200; t++) stepSimulation(world, colony, rng, 0.8);
    for (let i = 0; i < colony.count; i++) {
      expect(colony.posZ[i]).toBeGreaterThanOrEqual(0.04);
      expect(colony.posZ[i]).toBeLessThanOrEqual(0.81);
    }
  });

  it('close-together ants in z get separated by collision avoidance', () => {
    const { world, colony, rng } = sandbox();
    // Two ants at the exact same (x, y, z).
    colony.spawn(20.5, 29.5, 0, { posZ: 0.4 });
    colony.spawn(20.6, 29.5, Math.PI, { posZ: 0.4 });
    // Run a few ticks; their z separation should grow.
    for (let t = 0; t < 30; t++) stepSimulation(world, colony, rng, 0.8);
    const dz = Math.abs(colony.posZ[0]! - colony.posZ[1]!);
    expect(dz).toBeGreaterThan(0.08);
  });
});

void CELLS_PER_CM;
