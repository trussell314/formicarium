// Queen-only founding-colony milestone test. Starts with ONLY the
// founding queen (no seeded workers) and runs until the nest reaches
// 500 below-surface AIR cells. Records the tick count at each
// 100/200/300/400/500-cell milestone so we can see how long claustral
// founding takes to produce a usable workforce + nest.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_AIR, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

describe('queen-only founding milestones', () => {
  it('records ticks at 100/200/300/400/500-cell nest milestones', () => {
    const seed = 7;
    const rng = new RNG(seed);
    const w = 400, h = 250;
    const world = new World(w, h);
    const surfaceRow = Math.floor(h * 0.17);
    const halfW = Math.max(6, Math.floor(w * 0.06));
    const depth = Math.max(4, Math.floor(h * 0.05));
    world.generate(rng, surfaceRow, halfW, depth);
    const colony = new Colony(2000);
    const cx = w >> 1;
    const cy = surfaceRow + depth;
    colony.spawn(cx + 0.5, cy + 0.5, 0, rng, DEFAULT_PARAMS);
    colony.setState(0, STATE_QUEEN);
    colony.energy[0] = 1.0;
    // No seeded workers — pure claustral founding.
    const fields = {
      dig: new Pheromone(w, h, 0.10, 0.999),
      build: new Pheromone(w, h, 0.10, 0.985),
      trail: new Pheromone(w, h, 0.05, 0.992),
      alarm: new Pheromone(w, h, 0.20, 0.95),
      queen: new Pheromone(w, h, 1.00, 0.9995, true),
      brood: new Pheromone(w, h, 0.30, 0.998),
      necro: new Pheromone(w, h, 0.10, 0.99),
      noEntry: new Pheromone(w, h, 0.05, 0.985),
      granary: new Pheromone(w, h, 0.20, 0.998),
      trunk: new Pheromone(w, h, 0.05, 0.9995),
    };
    const particles = new ParticleSystem(2000);
    function countNestCells(): number {
      let n = 0;
      for (let x = 0; x < w; x++) {
        const surf = world.naturalSurface[x]!;
        for (let y = surf; y < h; y++) {
          if (world.cells[y * w + x]! === CELL_AIR) n++;
        }
      }
      return n;
    }
    function aliveWorkers(): number {
      let n = 0;
      for (let i = 0; i < colony.count; i++) {
        const s = colony.state[i];
        // Worker = not DEAD(5), QUEEN(6), EGG(7), LARVA(9), PUPA(10).
        if (s !== 5 && s !== 6 && s !== 7 && s !== 9 && s !== 10) n++;
      }
      return n;
    }
    function computeShape(): {
      maxDepth: number; width: number; aspect: number;
      chambers: number; largestChamber: number; depthSizeSlope: number;
      shaftCells: number;
    } {
      const isNest = new Uint8Array(w * h);
      let minX = w, maxX = -1, maxY = -1;
      for (let x = 0; x < w; x++) {
        const sy = world.naturalSurface[x]!;
        for (let y = sy; y < h; y++) {
          if (world.cells[y * w + x]! === CELL_AIR) {
            isNest[y * w + x] = 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      const surfMin = Math.min(...Array.from(world.naturalSurface));
      const maxDepth = Math.max(0, maxY - surfMin);
      const width = maxX < minX ? 0 : (maxX - minX + 1);
      const aspect = width === 0 ? 0 : maxDepth / width;
      const visited = new Uint8Array(w * h);
      const chamberSizes: { size: number; meanY: number }[] = [];
      const stack: number[] = [];
      let largestChamber = 0;
      for (let i = 0; i < w * h; i++) {
        if (!isNest[i] || visited[i]) continue;
        let size = 0, ySum = 0;
        stack.push(i); visited[i] = 1;
        while (stack.length) {
          const p = stack.pop()!;
          const py = (p / w) | 0;
          const px = p - py * w;
          size++;
          ySum += py;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (visited[ni] || !isNest[ni]) continue;
            visited[ni] = 1;
            stack.push(ni);
          }
        }
        if (size > largestChamber) largestChamber = size;
        chamberSizes.push({ size, meanY: ySum / size });
      }
      let shaftCells = 0;
      for (let x = 0; x < w; x++) {
        const sy = world.naturalSurface[x]!;
        for (let y = sy; y < h; y++) {
          if (!isNest[y * w + x]) continue;
          const left = x === 0 ? 1 : (world.cells[y * w + (x - 1)]! !== CELL_AIR ? 1 : 0);
          const right = x === w - 1 ? 1 : (world.cells[y * w + (x + 1)]! !== CELL_AIR ? 1 : 0);
          if (left && right) shaftCells++;
        }
      }
      let depthSizeSlope = 0;
      if (chamberSizes.length >= 2) {
        const meanY = chamberSizes.reduce((s, c) => s + c.meanY, 0) / chamberSizes.length;
        const meanS = chamberSizes.reduce((s, c) => s + c.size, 0) / chamberSizes.length;
        let num = 0, den = 0;
        for (const c of chamberSizes) {
          num += (c.meanY - meanY) * (c.size - meanS);
          den += (c.meanY - meanY) ** 2;
        }
        depthSizeSlope = den === 0 ? 0 : num / den;
      }
      return { maxDepth, width, aspect, chambers: chamberSizes.length, largestChamber, depthSizeSlope, shaftCells };
    }
    function asciiMap(cols = 80, rows = 60): string {
      const sx = Math.max(1, Math.floor(w / cols));
      const sy = Math.max(1, Math.floor(h / rows));
      const oCols = Math.floor(w / sx);
      const oRows = Math.floor(h / sy);
      const lines: string[] = [];
      for (let oy = 0; oy < oRows; oy++) {
        let line = '';
        for (let ox = 0; ox < oCols; ox++) {
          const cx2 = ox * sx + (sx >> 1);
          const cy2 = oy * sy + (sy >> 1);
          const surf = world.naturalSurface[cx2]!;
          const k = world.cells[cy2 * w + cx2]!;
          if (cy2 < surf - 1) line += ' ';
          else if (cy2 === surf && k !== CELL_AIR) line += '_';
          else if (k === CELL_AIR) line += cy2 >= surf ? '.' : ' ';
          else if (k === 1) line += '#';
          else line += '*';
        }
        lines.push(line);
      }
      return lines.join('\n');
    }
    const log = (m: string): void => { process.stderr.write(`[queen-only] ${m}\n`); };
    const milestones = [100, 200, 300, 400, 500];
    const milestoneTicks: Record<number, number> = {};
    const SNAPSHOT = 50_000;
    const CAP = 5_000_000;
    log(`start init=${countNestCells()}, target milestones=${milestones.join(',')}`);
    const t0 = Date.now();
    let ticks = 0;
    while (ticks < CAP) {
      step(
        world, colony, fields.dig!, fields.build!,
        rng, DEFAULT_PARAMS, particles, HARVESTER,
        fields.trail, fields.alarm, fields.queen,
        fields.brood, fields.necro, fields.noEntry,
        fields.granary, fields.trunk,
      );
      ticks++;
      // Check milestones at every tick (cheap — countNestCells is O(W·H)
      // but only fires on snapshot ticks for logging; for milestone
      // detection we want exact tick counts so we recheck whenever a
      // dig might have happened. Compromise: recheck only at snapshot
      // boundaries and when remaining milestones could be hit. Less
      // exact but good enough for "how long".)
      if (ticks % SNAPSHOT === 0) {
        const cells = countNestCells();
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const aw = aliveWorkers();
        log(`tick=${ticks} cells=${cells} workers=${aw} (${dt}s wall)`);
        for (const m of milestones) {
          if (cells >= m && milestoneTicks[m] === undefined) {
            milestoneTicks[m] = ticks;
            const sh = computeShape();
            log(`MILESTONE ${m} cells reached at tick ≤ ${ticks}`);
            log(
              `  shape: depth=${sh.maxDepth} width=${sh.width} aspect=${sh.aspect.toFixed(2)} ` +
              `chambers=${sh.chambers} largest=${sh.largestChamber} ` +
              `shaft=${sh.shaftCells} slope=${sh.depthSizeSlope.toFixed(3)}`
            );
            process.stderr.write(`\n========== shape at ${m}-cell milestone ==========\n${asciiMap()}\n\n`);
          }
        }
        if (cells >= 500) break;
      }
    }
    log('\n========== summary ==========');
    log(`final cells: ${countNestCells()}`);
    log(`final ticks: ${ticks}`);
    for (const m of milestones) {
      const t = milestoneTicks[m];
      log(`milestone ${m}: ${t === undefined ? 'NOT REACHED' : `tick ≤ ${t}`}`);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
