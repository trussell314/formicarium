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
import { CELL_GRAIN, CELL_SOIL, isLoose, World } from '../src/sim/world';
import { STATE_CARRY, STATE_DEAD } from '../src/sim/colony';

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

  it('no ant ends up embedded after a long run with floating-island collapses', () => {
    // 10k ticks at the standard sim seed exercises every code path
    // that mutates cells under ants — diel-seal, granary cascades,
    // floating-island collapse, dig/place/pick, settle. Original
    // 800-tick test passes even with embedding bugs because the
    // window is too short to hit the rare cascade-into-ant pattern;
    // the long run reproduces the user-observed "ants stuck in
    // soil" failure reliably and asserts none happen post-fix.
    const { rng, world, colony, dig, build } = makeSim(0xb00b1e5);
    for (let t = 0; t < 10000; t++) {
      step(world, colony, dig, build, rng, DEFAULT_PARAMS);
      for (let i = 0; i < colony.count; i++) {
        const sa = colony.state[i]!;
        if (sa === STATE_DEAD) continue;
        const ix = colony.posX[i]! | 0;
        const iy = colony.posY[i]! | 0;
        const k = world.cells[world.index(ix, iy)];
        if (k === CELL_SOIL || k === CELL_GRAIN) {
          throw new Error(
            `ant ${i} (state=${sa}) embedded at (${ix}, ${iy}) cell=${k} on tick ${t}`,
          );
        }
      }
    }
  });

  it('grain conservation: dug soil = carriers + wearLost (post-unification)', () => {
    const { rng, world, colony, dig, build } = makeSim(0xfeedface);
    for (let t = 0; t < 800; t++) step(world, colony, dig, build, rng, DEFAULT_PARAMS);
    let carriers = 0;
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] === STATE_CARRY) carriers++;
    }
    const dug = world.initialSoilCells - world.countSoil();
    // After SOIL/GRAIN unification countSoil() includes both
    // consolidated wall AND loose deposits, so the formula collapses:
    // a dug cell either rides on a carrier (in CARRY state) or got
    // pulverised into wearLost (traffic-driven shaft erosion,
    // Hölldobler & Wilson 1990). Redeposited grain becomes solid
    // again and shows up in countSoil().
    expect(dug).toBe(carriers + world.wearLost);
  });

  it('the chamber visibly grows over time', () => {
    const { rng, world, colony, dig, build } = makeSim(0xdeadbeef);
    const before = world.countSoil();
    // 30k ticks ≈ 1 hour biological at the calibrated tick rate
    // (1 tick ≈ 120 ms). With biology-scaled REST duration (1500
    // ticks) and reduced turnNoise (0.05) ants take longer to
    // generate dig contacts than with the old hand-tuned values.
    for (let t = 0; t < 30000; t++) step(world, colony, dig, build, rng, DEFAULT_PARAMS);
    const after = world.countSoil();
    // Test guards against a colony-wide stall, not against any
    // particular throughput rate.
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
    // Walk speed 1.2 cells/tick + gravity 1 cell = 2.2 cells max
    // plausible jump per tick. Anything larger means a teleport
    // that the renderer would visualise as a straight line through
    // midair. (Bound updated when sim resolution doubled — before
    // 3-mm cells, walkSpeed was 0.6 and the bound was 1.6.)
    expect(maxJump).toBeLessThanOrEqual(2.2);
  });

  it('every loose grain sits on a solid support (sandpile invariant)', () => {
    const { rng, world, colony, dig, build } = makeSim(0xabcd1234);
    for (let t = 0; t < 1500; t++) step(world, colony, dig, build, rng, DEFAULT_PARAMS);
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const idx = world.index(x, y);
        // Only loose cells need to sit on a support — consolidated
        // wall is anchored by hardness, not by gravity.
        if (!isLoose(world, idx)) continue;
        if (y + 1 >= world.height) continue;
        const below = world.cells[world.index(x, y + 1)];
        // Loose grains either rest on a solid cell (any hardness)
        // OR at the natural-surface horizon, where the surface
        // acts as structural bedrock and a grain in row (surface − 1)
        // does not cascade into an open entrance shaft below.
        const atSurface = (y + 1) === world.naturalSurface[x];
        expect(below === CELL_SOIL || atSurface).toBe(true);
      }
    }
  });
});
