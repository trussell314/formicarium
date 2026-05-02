// Nest-shape comparison across the time-scale dial.
//
// For each compression in {1, 10, 100, 1000}, builds a fresh founding
// colony with the same seed and runs `step()` until the nest reaches
// ~500 below-surface AIR cells (or hits a safety cap). Captures
// metrics + an ASCII cross-section so the shape can be eyeballed
// against real Pogonomyrmex barbatus nest morphology (Tschinkel 1998,
// 2004): vertical entrance shaft, discrete horizontal chambers
// stacked at increasing depth, chamber size growing with depth,
// total depth >> width.
//
// Excluded from default `npm test` (long; ~5–10 minutes). Run
// explicitly:
//   npx vitest run --config /dev/null tests/_nest-shape-comparison.test.ts \
//     --testTimeout=1800000

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_AIR, setTimeCompression, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

interface Sim {
  world: World;
  colony: Colony;
  rng: RNG;
  fields: Record<string, Pheromone>;
  particles: ParticleSystem;
}

function buildSim(seed: number, compression: number, w = 400, h = 250): Sim {
  setTimeCompression(compression);
  const rng = new RNG(seed);
  const world = new World(w, h);
  const surfaceRow = Math.floor(world.height * 0.17);
  const halfW = Math.max(6, Math.floor(world.width * 0.06));
  const depth = Math.max(4, Math.floor(world.height * 0.05));
  world.generate(rng, surfaceRow, halfW, depth);
  const colony = new Colony(1000);
  const cx = world.width >> 1;
  const cy = surfaceRow + depth;
  // Queen at the chamber bottom.
  colony.spawn(cx + 0.5, cy + 0.5, 0, rng, DEFAULT_PARAMS);
  colony.setState(0, STATE_QUEEN);
  colony.energy[0] = 1.0;
  // 25 starting workers scattered through the founding pocket so the
  // run doesn't have to wait for the egg→adult pipeline before any
  // digging happens. Bypassing claustral founding lets us focus on
  // excavation behaviour itself.
  for (let n = 0; n < 25; n++) {
    const x = cx + (rng.next() - 0.5) * (halfW * 1.6);
    const y = cy - rng.next() * (depth - 1);
    colony.spawn(x, y, rng.range(0, Math.PI * 2), rng, DEFAULT_PARAMS);
    // Default state for spawn is WANDER; energy starts mid so they
    // don't immediately starve.
    colony.energy[colony.count - 1] = 0.7;
  }
  const fields = {
    dig: new Pheromone(world.width, world.height, 0.10, 0.985),
    build: new Pheromone(world.width, world.height, 0.10, 0.985),
    trail: new Pheromone(world.width, world.height, 0.05, 0.992),
    alarm: new Pheromone(world.width, world.height, 0.20, 0.95),
    queen: new Pheromone(world.width, world.height, 1.00, 0.9995, true),
    brood: new Pheromone(world.width, world.height, 0.30, 0.998),
    necro: new Pheromone(world.width, world.height, 0.10, 0.99),
    noEntry: new Pheromone(world.width, world.height, 0.05, 0.985),
    granary: new Pheromone(world.width, world.height, 0.20, 0.998),
    trunk: new Pheromone(world.width, world.height, 0.05, 0.9995),
  };
  const particles = new ParticleSystem(2000);
  return { world, colony, rng, fields, particles };
}

function runStep(s: Sim): void {
  step(
    s.world, s.colony, s.fields.dig!, s.fields.build!,
    s.rng, DEFAULT_PARAMS, s.particles, HARVESTER,
    s.fields.trail, s.fields.alarm, s.fields.queen,
    s.fields.brood, s.fields.necro, s.fields.noEntry,
    s.fields.granary, s.fields.trunk,
  );
}

/** Below-surface AIR cells (excavated nest volume). */
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
  maxDepth: number;       // deepest below-surface AIR cell, in cells of depth
  meanDepth: number;
  width: number;          // horizontal span at widest point
  chambers: number;       // 8-connected components of below-surface AIR
  largestChamber: number;
  shaftCells: number;     // cells in single-column-wide passages
  // Aspect: depth / width. Real Pogo: 5–10× tall.
  aspect: number;
  // Chamber-size-by-depth: positive means deeper chambers larger
  // (real Pogo). Slope of cluster size vs depth.
  depthSizeSlope: number;
}

function computeMetrics(world: World, ticks: number): NestMetrics {
  const w = world.width;
  const h = world.height;
  const surf = world.naturalSurface;
  // Scan below-surface AIR cells.
  const isNest = new Uint8Array(w * h);
  let cells = 0;
  let minX = w, maxX = -1;
  let maxY = -1;
  let depthSum = 0;
  let depthCount = 0;
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
  // Connected components (8-connected) of nest cells.
  const visited = new Uint8Array(w * h);
  let chambers = 0;
  let largestChamber = 0;
  const chamberSizes: { size: number; meanY: number }[] = [];
  const stack: number[] = [];
  let shaftCells = 0;
  for (let i = 0; i < w * h; i++) {
    if (!isNest[i] || visited[i]) continue;
    chambers++;
    let size = 0;
    let ySum = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const py = (p / w) | 0;
      const px = p - py * w;
      size++;
      ySum += py;
      // 4-connect across cardinals + 4-connect diagonals
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
  // Count cells inside single-column shafts (cells where horizontal
  // neighbours are SOIL or out-of-bounds at both sides).
  for (let x = 0; x < w; x++) {
    const sy = surf[x]!;
    for (let y = sy; y < h; y++) {
      if (!isNest[y * w + x]) continue;
      const left = x === 0 ? 1 : (world.cells[y * w + (x - 1)]! !== CELL_AIR ? 1 : 0);
      const right = x === w - 1 ? 1 : (world.cells[y * w + (x + 1)]! !== CELL_AIR ? 1 : 0);
      if (left && right) shaftCells++;
    }
  }
  // Linear regression: chamber size vs mean-y. Positive slope → deeper
  // chambers larger.
  let depthSizeSlope = 0;
  if (chamberSizes.length >= 2) {
    const n = chamberSizes.length;
    const meanY = chamberSizes.reduce((s, c) => s + c.meanY, 0) / n;
    const meanS = chamberSizes.reduce((s, c) => s + c.size, 0) / n;
    let num = 0, den = 0;
    for (const c of chamberSizes) {
      num += (c.meanY - meanY) * (c.size - meanS);
      den += (c.meanY - meanY) ** 2;
    }
    depthSizeSlope = den === 0 ? 0 : num / den;
  }
  return {
    cells, ticks, maxDepth, meanDepth, width,
    chambers, largestChamber, shaftCells,
    aspect, depthSizeSlope,
  };
}

/** Render a downsampled ASCII cross-section for terminal display.
 *  Air below surface = '.', soil = '#', grain = '*', surface = '_'.
 *  Each output character covers stride×stride sim cells; uses
 *  majority-vote of the most "interesting" cell type. */
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
      // Sample center cell.
      const cx = ox * sx + (sx >> 1);
      const cy = oy * sy + (sy >> 1);
      const surf = world.naturalSurface[cx]!;
      const k = world.cells[cy * w + cx]!;
      if (cy < surf - 1) line += ' ';                        // sky
      else if (cy === surf && k !== CELL_AIR) line += '_';   // surface row
      else if (k === CELL_AIR) line += cy >= surf ? '.' : ' ';
      else if (k === 1 /*SOIL*/) line += '#';
      else line += '*';                                      // grain
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function runScenario(name: string, compression: number, target: number, capTicks: number): {
  metrics: NestMetrics;
  ascii: string;
} {
  const s = buildSim(7, compression);
  let cells = 0;
  let ticks = 0;
  let lastProgressTick = 0;
  // process.stderr.write bypasses vitest's per-test stdout buffer so
  // long scenarios surface progress in real time. Prefix with the
  // scenario name for clarity in the live tail.
  const log = (msg: string): void => { process.stderr.write(`[${name}] ${msg}\n`); };
  log(`start (compression=${compression}, target=${target}, cap=${capTicks})`);
  const t0 = Date.now();
  while (cells < target && ticks < capTicks) {
    runStep(s);
    ticks++;
    if (ticks % 5000 === 0) {
      cells = countNestCells(s.world);
      if (ticks - lastProgressTick >= 50000) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        log(`tick=${ticks} cells=${cells} (${dt}s wall)`);
        lastProgressTick = ticks;
      }
    }
  }
  cells = countNestCells(s.world);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const reachedTarget = cells >= target;
  log(`done: ticks=${ticks} cells=${cells} reachedTarget=${reachedTarget} wall=${dt}s`);
  const metrics = computeMetrics(s.world, ticks);
  const ascii = asciiMap(s.world);
  return { metrics, ascii };
}

describe('nest shape across compression', () => {
  it('compares 1× / 10× / 100× / 1000× scenarios at 500-cell target', () => {
    const TARGET = 300;
    // Fastest-first ordering. Caps sized so 1000× should reach 300
    // cells (reference run: 183 cells at tick 127k, so ~210k for 300),
    // 100× has a chance to reach 300 (~2M ticks expected if dig rate
    // scales with walkScale), and the slower scenarios produce
    // informative partial data.
    const SCENARIOS = [
      { name: '1000×', compression: 1000, cap:   400_000 },
      { name: '100×',  compression: 100,  cap: 2_500_000 },
      { name: '10×',   compression: 10,   cap: 1_500_000 },
      { name: '1×',    compression: 1,    cap: 1_000_000 },
    ];
    const results: { name: string; metrics: NestMetrics; ascii: string }[] = [];
    for (const sc of SCENARIOS) {
      const r = runScenario(sc.name, sc.compression, TARGET, sc.cap);
      results.push({ name: sc.name, ...r });
    }
    // Final report.
    console.log('\n========== summary ==========');
    console.log('| scenario | cells | ticks   | depth | width | aspect | chambers | largest | shaft | slope  |');
    console.log('|----------|------:|--------:|------:|------:|-------:|---------:|--------:|------:|-------:|');
    for (const r of results) {
      const m = r.metrics;
      console.log(
        `| ${r.name.padEnd(8)} | ${String(m.cells).padStart(5)} | ` +
        `${String(m.ticks).padStart(7)} | ${String(m.maxDepth).padStart(5)} | ` +
        `${String(m.width).padStart(5)} | ${m.aspect.toFixed(2).padStart(6)} | ` +
        `${String(m.chambers).padStart(8)} | ${String(m.largestChamber).padStart(7)} | ` +
        `${String(m.shaftCells).padStart(5)} | ${m.depthSizeSlope.toFixed(3).padStart(6)} |`
      );
    }
    for (const r of results) {
      console.log(`\n========== ${r.name} cross-section ==========`);
      console.log(r.ascii);
    }
    // No assertions — this is a comparison/observation harness.
    expect(results.length).toBe(4);
  });
});
