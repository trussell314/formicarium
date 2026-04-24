// Behavioural integration tests.
//
// These tests set up a small world + small colony and run the real
// stepSimulation for many ticks, asserting observable invariants:
//
//   - No ant is ever in a CELL_SOIL or CELL_GRAIN cell at end of tick
//     (no embedded ants).
//   - No ant is ever floating (unsupported, not at world bottom).
//   - Grain conservation: removed soil == grains on ground + carrying.
//   - Grain piles respect the angle-of-repose config.
//   - Render interpolation is safe: |pos - prev| <= movement cap at
//     end of every tick, so renderer can lerp between prev and pos
//     without ever passing through unsupported space.
//
// These are the ONLY place invariant violations should be caught.
// Everything else is a unit test for a specific function.

import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';
import { Colony, STATE_CARRY } from '../src/sim/colony';
import { isSupported } from '../src/sim/physics';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

function makeSim(seed: number): { world: World; colony: Colony; rng: RNG } {
  const rng = new RNG(seed);
  const world = new World(CONFIG.gridWidth, CONFIG.gridHeight);
  world.generate(rng);
  const colony = new Colony(CONFIG.antCount);
  const surfaceY = Math.floor(world.height * CONFIG.surfaceFraction);
  const cx = Math.floor(world.width / 2);
  const halfW = CONFIG.starterChamberHalfWidth;
  colony.spawnInRect(
    cx - halfW,
    surfaceY + 1,
    cx + halfW,
    surfaceY + CONFIG.starterChamberDepth,
    CONFIG.antCount,
    rng,
    (x, y) => world.isAir(x, y),
  );
  return { world, colony, rng };
}

describe('behavioural invariants — 10-ant colony', () => {
  it('no ant is ever embedded in solid at end of tick', () => {
    const { world, colony, rng } = makeSim(0xc0ffee);
    for (let t = 0; t < 1000; t++) {
      stepSimulation(world, colony, rng);
      for (let i = 0; i < colony.count; i++) {
        const ix = colony.posX[i]! | 0;
        const iy = colony.posY[i]! | 0;
        const k = world.cells[world.index(ix, iy)];
        expect(k).not.toBe(CELL_SOIL);
        expect(k).not.toBe(CELL_GRAIN);
      }
    }
  });

  it('no ant is ever floating — every ant is supported or at world bottom', () => {
    const { world, colony, rng } = makeSim(0xdeadbeef);
    for (let t = 0; t < 1000; t++) {
      stepSimulation(world, colony, rng);
      for (let i = 0; i < colony.count; i++) {
        const ix = colony.posX[i]! | 0;
        const iy = colony.posY[i]! | 0;
        expect(isSupported(world, ix, iy)).toBe(true);
      }
    }
  });

  it('grain conservation holds across the whole run', () => {
    const { world, colony, rng } = makeSim(0x1badf00d);
    const initial = world.initialSoilCells;
    for (let t = 0; t < 1000; t++) {
      stepSimulation(world, colony, rng);
      if (t % 100 === 99) {
        let carriers = 0;
        for (let i = 0; i < colony.count; i++) {
          if (colony.state[i] === STATE_CARRY) carriers++;
        }
        const soil = world.countSoil();
        const grains = world.countGrains();
        expect(soil + grains + carriers).toBe(initial);
      }
    }
  });

  it('grain piles never violate angle-of-repose', () => {
    const { world, colony, rng } = makeSim(0xfeedface);
    for (let t = 0; t < 2000; t++) stepSimulation(world, colony, rng);
    for (let x = 1; x < world.width - 1; x++) {
      const mid = world.surfaceMound[x]!;
      const left = world.surfaceMound[x - 1]!;
      const right = world.surfaceMound[x + 1]!;
      const minN = Math.min(left, right);
      if (mid > 0 && minN > 0) {
        expect(mid - minN).toBeLessThanOrEqual(CONFIG.grainAngleOfRepose + 1);
      }
    }
  });

  it('prev-pos is always within movement cap of current pos (safe for render interp)', () => {
    const { world, colony, rng } = makeSim(0xabad1dea);
    for (let t = 0; t < 500; t++) {
      stepSimulation(world, colony, rng);
      for (let i = 0; i < colony.count; i++) {
        const dx = Math.abs(colony.posX[i]! - colony.prevX[i]!);
        const dy = Math.abs(colony.posY[i]! - colony.prevY[i]!);
        // Either tiny step (movement) or prev was snapped to current.
        expect(Math.max(dx, dy)).toBeLessThanOrEqual(1.5);
      }
    }
  });
});
