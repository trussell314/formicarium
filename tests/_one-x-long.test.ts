// Diagnostic: run 1× compression alone for a long fixed tick budget,
// no stall detection. Just observe what shape emerges over biology
// time. Companion to _nest-shape-comparison.test.ts; same scaffold,
// same seed (7), same 10 starting workers + queen.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_AIR, setTimeCompression, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

describe('1× long-run', () => {
  it('runs 1× compression for a long fixed budget (no stall) to observe emergent shape', () => {
    setTimeCompression(1);
    const seed = 7;
    const rng = new RNG(seed);
    const w = 400, h = 250;
    const world = new World(w, h);
    const surfaceRow = Math.floor(h * 0.17);
    const halfW = Math.max(6, Math.floor(w * 0.06));
    const depth = Math.max(4, Math.floor(h * 0.05));
    world.generate(rng, surfaceRow, halfW, depth);
    const colony = new Colony(1000);
    const cx = w >> 1;
    const cy = surfaceRow + depth;
    colony.spawn(cx + 0.5, cy + 0.5, 0, rng, DEFAULT_PARAMS);
    colony.setState(0, STATE_QUEEN);
    colony.energy[0] = 1.0;
    for (let n = 0; n < 10; n++) {
      const x = cx + (rng.next() - 0.5) * (halfW * 1.6);
      const y = cy - rng.next() * (depth - 1);
      colony.spawn(x, y, rng.range(0, Math.PI * 2), rng, DEFAULT_PARAMS);
      colony.energy[colony.count - 1] = 0.7;
    }
    const fields = {
      dig: new Pheromone(w, h, 0.10, 0.985),
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
    function countNest(): number {
      let n = 0;
      for (let x = 0; x < w; x++) {
        const sy = world.naturalSurface[x]!;
        for (let y = sy; y < h; y++) {
          if (world.cells[y * w + x]! === CELL_AIR) n++;
        }
      }
      return n;
    }
    const log = (m: string): void => { process.stderr.write(`[1×-long] ${m}\n`); };
    const t0 = Date.now();
    const CAP = 400_000;
    const SNAPSHOT = 10_000;
    log(`start init=${countNest()} cap=${CAP}`);
    let cells = 0;
    let prevCells = countNest();
    for (let tick = 1; tick <= CAP; tick++) {
      step(
        world, colony, fields.dig!, fields.build!,
        rng, DEFAULT_PARAMS, particles, HARVESTER,
        fields.trail, fields.alarm, fields.queen,
        fields.brood, fields.necro, fields.noEntry,
        fields.granary, fields.trunk,
      );
      if (tick % SNAPSHOT === 0) {
        cells = countNest();
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const growth = ((cells / prevCells - 1) * 100).toFixed(1);
        // Count alive non-queen workers and their mean energy.
        let alive = 0, eSum = 0;
        for (let i = 0; i < colony.count; i++) {
          if (colony.state[i] !== 9 /* DEAD */ && colony.state[i] !== 2 /* QUEEN */) {
            alive++;
            eSum += colony.energy[i]!;
          }
        }
        const meanE = alive > 0 ? (eSum / alive).toFixed(2) : '—';
        log(`tick=${tick} cells=${cells} (+${growth}%) workers=${alive} meanE=${meanE} (${dt}s wall)`);
        prevCells = cells;
      }
    }
    // Final ASCII map.
    const sxr = 5, syr = 4;
    const oCols = Math.floor(w / sxr);
    const oRows = Math.floor(h / syr);
    const lines: string[] = [];
    for (let oy = 0; oy < oRows; oy++) {
      let line = '';
      for (let ox = 0; ox < oCols; ox++) {
        const cx2 = ox * sxr + (sxr >> 1);
        const cy2 = oy * syr + (syr >> 1);
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
    process.stderr.write(`\n========== 1×-long final shape ==========\n${lines.join('\n')}\n`);
    expect(cells).toBeGreaterThan(30);
  });
});
