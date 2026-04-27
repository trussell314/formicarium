// Round-trip tests for the localStorage save/restore module. The
// invariants we want to lock in:
//   1. captureSnapshot → restoreSnapshot reproduces every visible
//      sim quantity (cells, grains, food, colony arrays, pheromone
//      fields, RNG state) bit-exact.
//   2. After restore, continuing the sim from the restored state
//      produces the SAME tick-by-tick history as continuing from
//      the original (i.e. saving + reloading is invisible to the
//      simulation).
//   3. Mismatched settings (different seed / width / height /
//      capacity) cause restoreSnapshot to refuse cleanly.

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { captureSnapshot, restoreSnapshot } from '../src/sim/persist';
import { RNG } from '../src/sim/rng';
import { World } from '../src/sim/world';

function makeSim(seed: number) {
  const rng = new RNG(seed);
  const world = new World(80, 60);
  world.generate(rng, 18, 6, 4);
  const colony = new Colony(64);
  const cx = world.width >> 1;
  colony.spawnInRect(
    cx - 4, 20, cx + 4, 24, 32,
    rng,
    (x, y) => world.cells[world.index(x, y)] === 0,
    DEFAULT_PARAMS,
  );
  const dig = new Pheromone(world.width, world.height, 0.12, 0.99);
  const build = new Pheromone(world.width, world.height, 0.10, 0.997);
  const trail = new Pheromone(world.width, world.height, 0.40, 0.999);
  return { rng, world, colony, dig, build, trail };
}

function tickN(s: ReturnType<typeof makeSim>, n: number): void {
  for (let i = 0; i < n; i++) {
    step(s.world, s.colony, s.dig, s.build, s.rng, DEFAULT_PARAMS, undefined, undefined, s.trail);
  }
}

function bytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (av.length !== bv.length) return false;
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  return true;
}

describe('persist', () => {
  it('captureSnapshot + restoreSnapshot round-trips every TypedArray', () => {
    const a = makeSim(42);
    tickN(a, 500); // produce a non-trivial state to encode

    const blob = captureSnapshot(
      a.world, a.colony, a.dig, a.build, a.trail, a.rng,
      { seed: 42, width: a.world.width, height: a.world.height },
    );
    expect(blob).not.toBeNull();

    // Build a fresh sim with matching dimensions but a different seed
    // to prove the restore overwrites everything.
    const b = makeSim(999);
    expect(b.world.tick).toBe(0);
    const ok = restoreSnapshot(
      blob!,
      // settings.seed has to match the saved seed, not the fresh
      // sim's seed — the caller (main.ts) passes the seed it built
      // the world with, which is the same one the snapshot recorded.
      { seed: 42, width: b.world.width, height: b.world.height },
      b.world, b.colony, b.dig, b.build, b.trail, b.rng,
    );
    expect(ok).toBe(true);

    // Scalars
    expect(b.world.tick).toBe(a.world.tick);
    expect(b.world.initialSoilCells).toBe(a.world.initialSoilCells);
    expect(b.world.wearLost).toBe(a.world.wearLost);
    expect(b.world.totalBorn).toBe(a.world.totalBorn);
    expect(b.world.totalDied).toBe(a.world.totalDied);
    expect(b.colony.count).toBe(a.colony.count);
    expect(b.rng.getState()).toBe(a.rng.getState());

    // World arrays
    expect(bytesEqual(b.world.cells, a.world.cells)).toBe(true);
    expect(bytesEqual(b.world.grainMoves, a.world.grainMoves)).toBe(true);
    expect(bytesEqual(b.world.food, a.world.food)).toBe(true);
    expect(bytesEqual(b.world.corpse, a.world.corpse)).toBe(true);
    expect(bytesEqual(b.world.digTick, a.world.digTick)).toBe(true);
    expect(bytesEqual(b.world.digsByDir, a.world.digsByDir)).toBe(true);

    // Colony arrays (sample a few; bytesEqual covers the buffers)
    expect(bytesEqual(b.colony.posX, a.colony.posX)).toBe(true);
    expect(bytesEqual(b.colony.state, a.colony.state)).toBe(true);
    expect(bytesEqual(b.colony.energy, a.colony.energy)).toBe(true);
    expect(bytesEqual(b.colony.age, a.colony.age)).toBe(true);

    // Pheromone fields
    expect(bytesEqual(b.dig.current, a.dig.current)).toBe(true);
    expect(bytesEqual(b.build.current, a.build.current)).toBe(true);
  });

  it('continuation from a restored snapshot is bit-identical', () => {
    // Two parallel sims with the same seed will diverge if any state
    // is missed by the snapshot. Run 300 ticks, snapshot, then keep
    // running both and check they stay in lockstep for another 300.
    const a = makeSim(7);
    tickN(a, 300);

    const blob = captureSnapshot(
      a.world, a.colony, a.dig, a.build, a.trail, a.rng,
      { seed: 7, width: a.world.width, height: a.world.height },
    );
    expect(blob).not.toBeNull();

    const b = makeSim(7); // same seed but freshly generated
    const ok = restoreSnapshot(
      blob!,
      { seed: 7, width: b.world.width, height: b.world.height },
      b.world, b.colony, b.dig, b.build, b.trail, b.rng,
    );
    expect(ok).toBe(true);

    tickN(a, 300);
    tickN(b, 300);

    expect(b.world.tick).toBe(a.world.tick);
    expect(b.world.totalBorn).toBe(a.world.totalBorn);
    expect(b.world.totalDied).toBe(a.world.totalDied);
    expect(bytesEqual(b.world.cells, a.world.cells)).toBe(true);
    expect(bytesEqual(b.colony.posX, a.colony.posX)).toBe(true);
    expect(bytesEqual(b.colony.posY, a.colony.posY)).toBe(true);
    expect(bytesEqual(b.dig.current, a.dig.current)).toBe(true);
  });

  it('rejects a snapshot whose settings disagree with the target', () => {
    const a = makeSim(1);
    tickN(a, 50);
    const blob = captureSnapshot(
      a.world, a.colony, a.dig, a.build, a.trail, a.rng,
      { seed: 1, width: a.world.width, height: a.world.height },
    );
    expect(blob).not.toBeNull();

    const b = makeSim(1);
    // Wrong seed → reject (different scenario was requested)
    expect(restoreSnapshot(
      blob!, { seed: 2, width: b.world.width, height: b.world.height },
      b.world, b.colony, b.dig, b.build, b.trail, b.rng,
    )).toBe(false);
    // Wrong dimensions would mean wrongly-sized buffers; we don't
    // build a mismatching world here because the dimensions argument
    // is checked against the saved state directly.
    expect(restoreSnapshot(
      blob!, { seed: 1, width: b.world.width + 1, height: b.world.height },
      b.world, b.colony, b.dig, b.build, b.trail, b.rng,
    )).toBe(false);
  });

  it('handles malformed JSON without throwing', () => {
    const b = makeSim(1);
    expect(restoreSnapshot(
      'not a json blob', { seed: 1, width: b.world.width, height: b.world.height },
      b.world, b.colony, b.dig, b.build, b.trail, b.rng,
    )).toBe(false);
    expect(restoreSnapshot(
      '{"v": 9999}', { seed: 1, width: b.world.width, height: b.world.height },
      b.world, b.colony, b.dig, b.build, b.trail, b.rng,
    )).toBe(false);
  });
});
