// Dig-spread diagnostic. Runs a queen-only founding colony to
// ~300k ticks and dumps a horizontal histogram of all excavated
// cells by column. Goal: confirm whether workers are digging at
// distant surface columns (the "disparate vertical shafts" the user
// observed) and pin down what fraction of dig effort lands at the
// founding-shaft column vs. elsewhere.
//
// Also tracks worker x-positions live so we can see where they're
// wandering. If workers stray far from the entrance, they'll dig
// at the surface there — the question is whether the straying is
// from forage trips, from above-surface wandering, or from some
// other mechanism.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_AIR, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

describe('dig-spread diagnostic', () => {
  it('queen-only — distribution of dug cells by world column', () => {
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
    const log = (m: string): void => { process.stderr.write(`[dig-spread] ${m}\n`); };

    const CAP = 300_000;
    log(`start cap=${CAP} entranceCol=${cx}`);
    const t0 = Date.now();
    for (let tick = 1; tick <= CAP; tick++) {
      step(
        world, colony, fields.dig!, fields.build!,
        rng, DEFAULT_PARAMS, particles, HARVESTER,
        fields.trail, fields.alarm, fields.queen,
        fields.brood, fields.necro, fields.noEntry,
        fields.granary, fields.trunk,
      );
      // At each 50k snapshot, log worker x-distribution.
      if (tick % 50_000 === 0) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        // Count workers (alive non-queen non-brood) by x-bin.
        let total = 0;
        let above = 0, below = 0;
        let xMin = w, xMax = -1, xSum = 0;
        for (let i = 0; i < colony.count; i++) {
          const s = colony.state[i];
          if (s !== 0 && s !== 1 && s !== 2 && s !== 3 && s !== 4 && s !== 8) continue;
          const x = colony.posX[i]! | 0;
          const y = colony.posY[i]! | 0;
          total++;
          if (y < world.naturalSurface[x]!) above++; else below++;
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
          xSum += x;
        }
        const meanX = total > 0 ? (xSum / total).toFixed(1) : '—';
        log(`tick=${tick} workers=${total} above=${above} below=${below} ` +
          `xRange=[${xMin},${xMax}] meanX=${meanX} (${dt}s wall)`);
      }
    }

    // Final dig-spread analysis.
    const COLS_PER_BIN = 10;
    const numBins = Math.ceil(w / COLS_PER_BIN);
    const cellsPerBin = new Int32Array(numBins);
    let totalCells = 0;
    for (let x = 0; x < w; x++) {
      const surf = world.naturalSurface[x]!;
      let colCells = 0;
      for (let y = surf; y < h; y++) {
        if (world.cells[y * w + x]! === CELL_AIR) colCells++;
      }
      cellsPerBin[Math.floor(x / COLS_PER_BIN)]! += colCells;
      totalCells += colCells;
    }
    process.stderr.write(`\n========== dig spread by column (10-cell bins) ==========\n`);
    process.stderr.write(`entrance column = ${cx}, total nest cells = ${totalCells}\n`);
    const maxBin = Math.max(...Array.from(cellsPerBin));
    for (let b = 0; b < numBins; b++) {
      const colStart = b * COLS_PER_BIN;
      const colEnd = colStart + COLS_PER_BIN - 1;
      const cells = cellsPerBin[b]!;
      if (cells === 0) continue;
      const barLen = Math.round((cells / maxBin) * 50);
      const bar = '#'.repeat(barLen);
      const marker = (cx >= colStart && cx <= colEnd) ? ' ← entrance' : '';
      process.stderr.write(`  cols ${String(colStart).padStart(3)}-${String(colEnd).padStart(3)}: ${String(cells).padStart(4)} ${bar}${marker}\n`);
    }
    expect(totalCells).toBeGreaterThan(30);
  });
});
