// End-to-end behavioural tests. Build a small world, run many ticks, and
// assert observable invariants:
//   - No ant ever embedded in solid at end of tick
//   - Initial soil = current soil + grains in world (grain conservation,
//     give or take ants currently in CARRY)
//   - The chamber actually grows over time

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';
import { STATE_CARRY } from '../src/sim/colony';

function makeSim(seed: number) {
  const rng = new RNG(seed);
  const world = new World(120, 80);
  world.generate(rng, 24, 8, 5);
  const colony = new Colony(20);
  const cx = world.width >> 1;
  colony.spawnInRect(
    cx - 6, 25, cx + 6, 28, 20,
    rng,
    (x, y) => world.cells[world.index(x, y)] === 0,
    DEFAULT_PARAMS,
  );
  const dig = new Pheromone(world.width, world.height, 0.12, 0.992);
  const build = new Pheromone(world.width, world.height, 0.10, 0.997);
  return { rng, world, colony, dig, build };
}

describe('sim invariants', () => {
  it('no ant is ever embedded in solid at end of tick', () => {
    const { rng, world, colony, dig, build } = makeSim(0xc0ffee);
    for (let t = 0; t < 800; t++) {
      step(world, colony, dig, build, rng, DEFAULT_PARAMS);
      for (let i = 0; i < colony.count; i++) {
        const ix = colony.posX[i]! | 0;
        const iy = colony.posY[i]! | 0;
        const k = world.cells[world.index(ix, iy)];
        expect(k).not.toBe(CELL_SOIL);
        expect(k).not.toBe(CELL_GRAIN);
      }
    }
  });

  it('grain conservation: dug soil = grains in world + carriers', () => {
    const { rng, world, colony, dig, build } = makeSim(0xfeedface);
    for (let t = 0; t < 800; t++) step(world, colony, dig, build, rng, DEFAULT_PARAMS);
    let carriers = 0;
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] === STATE_CARRY) carriers++;
    }
    const dug = world.initialSoilCells - world.countSoil();
    const grainsInWorld = world.countGrains();
    expect(dug).toBe(grainsInWorld + carriers);
  });

  it('the chamber visibly grows over time', () => {
    const { rng, world, colony, dig, build } = makeSim(0xdeadbeef);
    const before = world.countSoil();
    for (let t = 0; t < 1500; t++) step(world, colony, dig, build, rng, DEFAULT_PARAMS);
    const after = world.countSoil();
    // With Sudd's per-contact dig probability (0.10) the rate is
    // realistic-low: ~20 cells in 1500 ticks for this seed/colony
    // size. The screensaver runs orders of magnitude longer so the
    // visible chamber grows steadily over wall-clock minutes. Test
    // just guards against a colony-wide stall (zero excavation).
    expect(before - after).toBeGreaterThan(10);
  });

  it('every grain sits on a solid support (sandpile invariant)', () => {
    const { rng, world, colony, dig, build } = makeSim(0xabcd1234);
    for (let t = 0; t < 1500; t++) step(world, colony, dig, build, rng, DEFAULT_PARAMS);
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (world.cells[world.index(x, y)] !== CELL_GRAIN) continue;
        // Cell directly below must be solid OR we're at the world
        // floor. Grains placed above ground may later cascade into
        // voids dug under them — they're still supported (just by
        // a deeper layer).
        if (y + 1 >= world.height) continue;
        const below = world.cells[world.index(x, y + 1)];
        expect(below === CELL_SOIL || below === CELL_GRAIN).toBe(true);
      }
    }
  });
});
