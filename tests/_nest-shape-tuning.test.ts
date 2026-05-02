// Nest-shape tuning comparison. Three independent runs at the same
// fixed compression (100×, the calibration baseline):
//
//   control   — existing parameters, baseline shape
//   lever1    — stronger below-surface geotaxis (0.35 → 0.75) to test
//               whether shaft-first excavation moves the aspect ratio
//               toward the real biology of 5–10× tall
//   lever2    — faster dig-pheromone decay (0.999 → 0.985) so workers
//               don't over-recruit to one dig front; they relocate,
//               which (in Khuong-style stigmergy) should produce
//               stratified chambers rather than one wide cluster
//
// Each scenario uses the same RNG seed, world size, and 10-worker
// scaffold so morphology differences come from the lever alone.
//
// Stop condition: 100 cells OR 5%-per-10k-tick stall.
//
// Excluded from default `npm test` (~3 min wall). Run explicitly:
//   npx vitest run --config /dev/null tests/_nest-shape-tuning.test.ts \
//     --testTimeout=600000

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER, type AntSpecies } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_AIR, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

type Mode = 'control' | 'lever1' | 'lever2';

interface Sim {
  world: World;
  colony: Colony;
  rng: RNG;
  fields: Record<string, Pheromone>;
  particles: ParticleSystem;
  species: AntSpecies;
}

function buildSim(mode: Mode, seed = 7): Sim {
  const w = 400, h = 250;
  const rng = new RNG(seed);
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

  // Lever 1: stronger below-surface geotaxis. Real P. barbatus drives
  // a vertical shaft 30+ cm before opening any chamber; ours doesn't
  // because the down-bias is too gentle.
  const species: AntSpecies = mode === 'lever1'
    ? { ...HARVESTER, belowGeotaxis: 0.75 }
    : HARVESTER;

  // Lever 2: faster dig-pheromone decay. Under Khuong stigmergy the
  // dig field recruits workers to active fronts; a long-lived field
  // keeps them piling onto one face, widening a single chamber. A
  // shorter half-life lets the field localise to truly active digs
  // and (in theory) stratifies excavation depth-wise.
  const digDecay = mode === 'lever2' ? 0.985 : 0.999;

  const fields = {
    dig: new Pheromone(w, h, 0.10, digDecay),
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
  return { world, colony, rng, fields, particles, species };
}

function runStep(s: Sim): void {
  step(
    s.world, s.colony, s.fields.dig!, s.fields.build!,
    s.rng, DEFAULT_PARAMS, s.particles, s.species,
    s.fields.trail, s.fields.alarm, s.fields.queen,
    s.fields.brood, s.fields.necro, s.fields.noEntry,
    s.fields.granary, s.fields.trunk,
  );
}

function countNestCells(world: World): number {
  let n = 0;
  for (let x = 0; x < world.width; x++) {
    const surf = world.naturalSurface[x]!;
    for (let y = surf; y < world.height; y++) {
      if (world.cells[y * world.width + x]! === CELL_AIR) n++;
    }
  }
  return n;
}

interface NestMetrics {
  cells: number;
  ticks: number;
  maxDepth: number;
  meanDepth: number;
  width: number;
  chambers: number;
  largestChamber: number;
  shaftCells: number;
  aspect: number;
  depthSizeSlope: number;
}

function computeMetrics(world: World, ticks: number): NestMetrics {
  const w = world.width, h = world.height;
  const surf = world.naturalSurface;
  const isNest = new Uint8Array(w * h);
  let cells = 0;
  let minX = w, maxX = -1, maxY = -1;
  let depthSum = 0, depthCount = 0;
  for (let x = 0; x < w; x++) {
    const sy = surf[x]!;
    for (let y = sy; y < h; y++) {
      if (world.cells[y * w + x]! === CELL_AIR) {
        isNest[y * w + x] = 1;
        cells++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        depthSum += (y - sy);
        depthCount++;
      }
    }
  }
  const surfMin = Math.min(...Array.from(surf));
  const maxDepth = Math.max(0, maxY - surfMin);
  const meanDepth = depthCount === 0 ? 0 : depthSum / depthCount;
  const width = maxX < minX ? 0 : (maxX - minX + 1);
  const aspect = width === 0 ? 0 : maxDepth / width;
  const visited = new Uint8Array(w * h);
  let chambers = 0;
  let largestChamber = 0;
  const chamberSizes: { size: number; meanY: number }[] = [];
  const stack: number[] = [];
  let shaftCells = 0;
  for (let i = 0; i < w * h; i++) {
    if (!isNest[i] || visited[i]) continue;
    chambers++;
    let size = 0, ySum = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const py = (p / w) | 0;
      const px = p - py * w;
      size++;
      ySum += py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni] || !isNest[ni]) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
    if (size > largestChamber) largestChamber = size;
    chamberSizes.push({ size, meanY: ySum / size });
  }
  for (let x = 0; x < w; x++) {
    const sy = surf[x]!;
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
  return { cells, ticks, maxDepth, meanDepth, width, chambers, largestChamber, shaftCells, aspect, depthSizeSlope };
}

function asciiMap(world: World, cols = 80, rows = 60): string {
  const w = world.width, h = world.height;
  const sx = Math.max(1, Math.floor(w / cols));
  const sy = Math.max(1, Math.floor(h / rows));
  const oCols = Math.floor(w / sx);
  const oRows = Math.floor(h / sy);
  const lines: string[] = [];
  for (let oy = 0; oy < oRows; oy++) {
    let line = '';
    for (let ox = 0; ox < oCols; ox++) {
      const cx = ox * sx + (sx >> 1);
      const cy = oy * sy + (sy >> 1);
      const surf = world.naturalSurface[cx]!;
      const k = world.cells[cy * w + cx]!;
      if (cy < surf - 1) line += ' ';
      else if (cy === surf && k !== CELL_AIR) line += '_';
      else if (k === CELL_AIR) line += cy >= surf ? '.' : ' ';
      else if (k === 1) line += '#';
      else line += '*';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function runScenario(name: string, mode: Mode, target: number, capTicks: number): {
  metrics: NestMetrics;
  ascii: string;
  exitReason: 'target' | 'stall' | 'cap';
} {
  const s = buildSim(mode);
  let cells = countNestCells(s.world);
  let ticks = 0;
  let prevCells = cells;
  let exitReason: 'target' | 'stall' | 'cap' = 'cap';
  const SNAPSHOT = 10_000;
  const STALL_GROWTH = 1.05;
  const log = (m: string): void => { process.stderr.write(`[${name}] ${m}\n`); };
  log(`start mode=${mode} target=${target} cap=${capTicks} init=${cells}`);
  const t0 = Date.now();
  while (ticks < capTicks) {
    runStep(s);
    ticks++;
    if (ticks % SNAPSHOT === 0) {
      cells = countNestCells(s.world);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const growth = ((cells / prevCells - 1) * 100).toFixed(1);
      log(`tick=${ticks} cells=${cells} (+${growth}%) (${dt}s wall)`);
      if (cells >= target) { exitReason = 'target'; break; }
      if (cells < prevCells * STALL_GROWTH) {
        log(`stall: ${prevCells} → ${cells}`);
        exitReason = 'stall';
        break;
      }
      prevCells = cells;
    }
  }
  cells = countNestCells(s.world);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  log(`done: ticks=${ticks} cells=${cells} reason=${exitReason} wall=${dt}s`);
  const metrics = computeMetrics(s.world, ticks);
  const ascii = asciiMap(s.world);
  return { metrics, ascii, exitReason };
}

describe('nest-shape tuning', () => {
  it('compares control vs lever1 (geotaxis) vs lever2 (dig decay)', () => {
    const TARGET = 100;
    const CAP = 500_000;
    const SCENARIOS: { name: string; mode: Mode }[] = [
      { name: 'control', mode: 'control' },
      { name: 'lever1',  mode: 'lever1' },
      { name: 'lever2',  mode: 'lever2' },
    ];
    const results: { name: string; metrics: NestMetrics; ascii: string; exitReason: string }[] = [];
    const dump = (name: string, m: NestMetrics, ascii: string, reason: string): void => {
      process.stderr.write(
        `\n========== [${name}] result (${reason}) ==========\n` +
        `cells=${m.cells} ticks=${m.ticks} maxDepth=${m.maxDepth} ` +
        `meanDepth=${m.meanDepth.toFixed(1)} width=${m.width} aspect=${m.aspect.toFixed(2)} ` +
        `chambers=${m.chambers} largest=${m.largestChamber} ` +
        `shaft=${m.shaftCells} depthSizeSlope=${m.depthSizeSlope.toFixed(3)}\n` +
        `${ascii}\n`,
      );
    };
    for (const sc of SCENARIOS) {
      const r = runScenario(sc.name, sc.mode, TARGET, CAP);
      results.push({ name: sc.name, ...r });
      dump(sc.name, r.metrics, r.ascii, r.exitReason);
    }
    process.stderr.write('\n========== summary ==========\n');
    process.stderr.write('| mode    | cells | ticks   | depth | width | aspect | chambers | largest | shaft | slope  | reason |\n');
    process.stderr.write('|---------|------:|--------:|------:|------:|-------:|---------:|--------:|------:|-------:|--------|\n');
    for (const r of results) {
      const m = r.metrics;
      process.stderr.write(
        `| ${r.name.padEnd(7)} | ${String(m.cells).padStart(5)} | ` +
        `${String(m.ticks).padStart(7)} | ${String(m.maxDepth).padStart(5)} | ` +
        `${String(m.width).padStart(5)} | ${m.aspect.toFixed(2).padStart(6)} | ` +
        `${String(m.chambers).padStart(8)} | ${String(m.largestChamber).padStart(7)} | ` +
        `${String(m.shaftCells).padStart(5)} | ${m.depthSizeSlope.toFixed(3).padStart(6)} | ` +
        `${r.exitReason.padEnd(6)} |\n`
      );
    }
    expect(results.length).toBe(3);
  });
});
