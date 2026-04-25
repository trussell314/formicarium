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
import { isSupported } from '../src/sim/physics';
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
  const dig = new Pheromone(world.width, world.height, 0.12, 0.985);
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
    // With Sudd's per-contact dig probability (0.10) AND collision-
    // REST throttling in a packed test world (20 ants in 120×80),
    // net dig rate is realistic-low. Test guards against a colony-
    // wide stall, not against any particular throughput.
    expect(before - after).toBeGreaterThan(0);
  });

  // ── Bug-replication tests (don't fix anything until these clearly
  //    name the failure). ────────────────────────────────────────────
  //
  // User reports: ants visibly suspended in midair, "hover back and
  // forth horizontally for a while before disappearing." Their
  // screenshot circles ants surrounded by empty chamber air — no
  // adjacent solid in any direction. The deployed code has 8-cell
  // isSupported and deterministic 1-cell-per-tick gravity, so any
  // ant in such a position SHOULD fall every tick.

  it('REPRO: no ant hovers (unsupported but not falling) for many ticks', () => {
    // True hover = unsupported AND posY didn't decrease meaningfully
    // for a sustained window. A correctly-falling ant will have a
    // strictly increasing iy over time. The user sees ants that
    // STAY at the same Y for many frames — only that pattern fails
    // here. Falling-mid-tick is correct behaviour and doesn't trip
    // this test.
    const HOVER_TICKS = 30;  // ~1 sec at 30 Hz
    const { rng, world, colony, dig, build } = makeSim(0xfeedbeef);
    const lastY = new Float32Array(colony.count);
    const hoverAge = new Int32Array(colony.count);
    for (let i = 0; i < colony.count; i++) lastY[i] = colony.posY[i]!;
    let firstFail: string | null = null;
    for (let t = 0; t < 3000 && firstFail === null; t++) {
      step(world, colony, dig, build, rng, DEFAULT_PARAMS);
      for (let i = 0; i < colony.count && firstFail === null; i++) {
        const ix = colony.posX[i]! | 0;
        const iy = colony.posY[i]! | 0;
        const supported = isSupported(world, ix, iy);
        const droppedSinceLast = colony.posY[i]! > lastY[i]! + 0.5;
        if (!supported && !droppedSinceLast) {
          hoverAge[i]!++;
        } else {
          hoverAge[i] = 0;
          lastY[i] = colony.posY[i]!;
        }
        if (hoverAge[i]! >= HOVER_TICKS) {
          const cells: string[] = [];
          for (let dy = -1; dy <= 1; dy++) {
            const row: string[] = [];
            for (let dx = -1; dx <= 1; dx++) {
              const xx = ix + dx;
              const yy = iy + dy;
              if (xx < 0 || yy < 0 || xx >= world.width || yy >= world.height) row.push('?');
              else if (dx === 0 && dy === 0) row.push('A');
              else row.push(String(world.cells[yy * world.width + xx]));
            }
            cells.push(row.join(''));
          }
          firstFail =
            `t=${t} ant#${i} state=${colony.state[i]} ` +
            `hovered for ${hoverAge[i]} ticks at ` +
            `pos=(${colony.posX[i]!.toFixed(2)},${colony.posY[i]!.toFixed(2)}) ` +
            `cells=[${cells.join('|')}] (3x3, A=ant, 0=AIR, 1=SOIL, 2=GRAIN)`;
        }
      }
    }
    expect(firstFail).toBeNull();
  });

  it('REPRO: after a dig, prevY/prevX reflect a position that is also reachable from final', () => {
    // Renderer interpolates from prev → pos using `alpha`. If a dig
    // teleports the ant a few cells (target.x + 0.5, target.y + 0.5)
    // without updating prev, the rendered straight-line path passes
    // through air the ant never actually occupied. With multiple
    // sub-stepped sim ticks per render frame, that path can land
    // inside the chamber and read as "floating mid-air."
    //
    // Test: build a world with a single soil pillar inside a chamber.
    // Spawn an ant adjacent to it with downward heading. Step. If
    // a dig fired, assert that |posY - prevY| <= walkSpeed + 1 (the
    // 1 cell allowance is for the gravity step in settle).
    const rng = new RNG(0xface);
    const world = new World(40, 30);
    world.cells.fill(0);
    for (let x = 0; x < 40; x++) world.naturalSurface[x] = 5;
    // Floor.
    for (let x = 0; x < 40; x++) world.cells[world.index(x, 28)] = CELL_SOIL;
    // Lone soil pillar at (20, 20) — ant adjacent at (19, 20)
    // should be able to dig it. Floor below the ant at y=21..27 is
    // air; the ant stands on the floor row at y=28.
    world.cells[world.index(20, 20)] = CELL_SOIL;
    world.initialSoilCells = world.countSoil();

    const colony = new Colony(1);
    colony.spawnInRect(19, 20, 19, 20, 1, rng,
      (x, y) => world.cells[world.index(x, y)] === 0,
      DEFAULT_PARAMS);
    const dig = new Pheromone(world.width, world.height, 0.12, 0.985);
    const build = new Pheromone(world.width, world.height, 0.10, 0.997);

    let maxJump = 0;
    for (let t = 0; t < 200; t++) {
      step(world, colony, dig, build, rng, DEFAULT_PARAMS);
      const dx = colony.posX[0]! - colony.prevX[0]!;
      const dy = colony.posY[0]! - colony.prevY[0]!;
      const jump = Math.hypot(dx, dy);
      if (jump > maxJump) maxJump = jump;
    }
    // Walk speed 0.6 + gravity 1 = 1.6 max plausible per tick.
    // Anything larger means a teleport that the renderer would
    // visualise as a straight line through midair.
    expect(maxJump).toBeLessThanOrEqual(1.6);
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
