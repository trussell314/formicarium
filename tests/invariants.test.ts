import { describe, expect, it } from 'vitest';
import { CELL_SOIL, World } from '../src/sim/world';
import { Colony } from '../src/sim/colony';
import { createFields } from '../src/sim/fields';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

/**
 * Long-running invariants for the simulation. SPEC §10.1.
 *
 * Grain conservation: every soil cell that disappears must reappear as a
 * grain on the surface or be in transit (carried by an ant). Since
 * carriers always come from a successful dig (which transitions WANDER →
 * DIG → CARRY in two ticks), and DIG transitions in zero ticks of carry,
 * the strict invariant is:
 *
 *   (soil cells removed) === (grain cells deposited) + (ants in CARRY state)
 */
describe('simulation invariants', () => {
  function makeSim(seed: number, antCount = 50, ticks = 200): {
    world: World; colony: Colony; fields: ReturnType<typeof createFields>;
  } {
    const rng = new RNG(seed);
    const world = new World(64, 48);
    world.generate(rng);
    const colony = new Colony(antCount * 2);
    const fields = createFields(world.width, world.height);
    const surfaceY = Math.floor(world.height * 0.18);
    const isAir = (x: number, y: number): boolean => world.isPassable(x, y);
    colony.spawnCluster(world.width / 2, surfaceY + 4, antCount, rng, 4, isAir);
    for (let t = 0; t < ticks; t++) {
      stepSimulation(world, colony, fields, rng);
    }
    return { world, colony, fields };
  }

  it('is deterministic for a fixed seed', () => {
    const a = makeSim(7, 30, 80);
    const b = makeSim(7, 30, 80);
    // Same final positions and states.
    expect(a.colony.count).toBe(b.colony.count);
    for (let i = 0; i < a.colony.count; i++) {
      expect(a.colony.posX[i]).toBe(b.colony.posX[i]);
      expect(a.colony.posY[i]).toBe(b.colony.posY[i]);
      expect(a.colony.state[i]).toBe(b.colony.state[i]);
    }
    // Same final soil count.
    expect(a.world.countSoil()).toBe(b.world.countSoil());
  });

  it('grain is conserved (dug = grains + carriers)', () => {
    const { world, colony } = makeSim(13, 40, 300);
    const removed = world.initialSoilCells - world.countSoil();
    const grains = world.countGrains();
    let carrying = 0;
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] === 2 /* STATE_CARRY */) carrying++;
    }
    expect(removed).toBe(grains + carrying);
  });

  it('no ant ends up embedded in soil', () => {
    const { world, colony } = makeSim(21, 50, 250);
    let embedded = 0;
    for (let i = 0; i < colony.count; i++) {
      const ix = colony.posX[i] | 0;
      const iy = colony.posY[i] | 0;
      if (ix < 0 || ix >= world.width || iy < 0 || iy >= world.height) continue;
      if (world.cells[iy * world.width + ix] === CELL_SOIL) embedded++;
    }
    expect(embedded).toBe(0);
  });

  it('agent count remains stable (no spurious births/deaths)', () => {
    const rng = new RNG(99);
    const world = new World(48, 32);
    world.generate(rng);
    const colony = new Colony(50);
    const fields = createFields(world.width, world.height);
    colony.spawnCluster(24, 8, 25, rng, 3, (x, y) => world.isPassable(x, y));
    const initial = colony.count;
    for (let t = 0; t < 100; t++) {
      stepSimulation(world, colony, fields, rng);
    }
    expect(colony.count).toBe(initial);
  });

  it('digs at least some soil over a reasonable run', () => {
    // Sanity: with positive feedback enabled, ants should excavate.
    const { world } = makeSim(33, 60, 500);
    const removed = world.initialSoilCells - world.countSoil();
    expect(removed).toBeGreaterThan(5);
  });
});
