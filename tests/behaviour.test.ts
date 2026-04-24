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

  it('prev differs from current during normal locomotion (so the renderer has something to interpolate)', () => {
    // Regression guard for the "ants rotate and wiggle legs but don't
    // translate" bug. When an ant is freely walking (no gravity
    // correction), prev should be its pre-tick position — NOT the
    // post-tick position. Previously the end-of-tick snap fired
    // whenever total tick motion exceeded 1.5 cells, which meant
    // every locomotion tick snapped prev=current and killed
    // interpolation. The settle-only snap fixes it.
    const { world, colony, rng } = makeSim(0xdeadcafe);
    // Run a few ticks to let ants settle out of their spawn.
    for (let t = 0; t < 20; t++) stepSimulation(world, colony, rng);

    let distinctCount = 0;
    const trials = 50;
    for (let t = 0; t < trials; t++) {
      stepSimulation(world, colony, rng);
      for (let i = 0; i < colony.count; i++) {
        const dx = colony.posX[i]! - colony.prevX[i]!;
        const dy = colony.posY[i]! - colony.prevY[i]!;
        if (Math.hypot(dx, dy) > 0.05) distinctCount++;
      }
    }
    // Over 50 ticks × 10 ants = 500 samples; at least some should
    // have prev != current. If ALL are snapped, renderer sees no
    // motion.
    expect(distinctCount).toBeGreaterThan(100);
  });

  it('settle never teleports more than the movement cap without snapping prev', () => {
    // Gravity-drop semantics: when the end-of-tick settle pulls an
    // ant down by more than ~1 cell, prev must be snapped to the
    // post-settle position so the renderer doesn't lerp a
    // multi-cell flight through unsupported sky.
    const { world, colony, rng } = makeSim(0xabad1dea);
    for (let t = 0; t < 500; t++) {
      stepSimulation(world, colony, rng);
      for (let i = 0; i < colony.count; i++) {
        // If prev was snapped, prev == current — interp is a no-op.
        // If not snapped, current must be close to where the ant
        // actually walked (i.e. within a plausible single-tick walk
        // distance, caller-defined cap of 15 cells — well beyond any
        // realistic locomotion at the default speed).
        const dy = Math.abs(colony.posY[i]! - colony.prevY[i]!);
        const dx = Math.abs(colony.posX[i]! - colony.prevX[i]!);
        expect(Math.hypot(dx, dy)).toBeLessThan(15);
      }
    }
  });
});
