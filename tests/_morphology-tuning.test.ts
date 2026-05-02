// Morphology tuning comparison. Three independent queen-only founding
// runs at the pinned 100× compression baseline, varying one
// pheromone-field calibration per scenario. Each runs to 500 nest
// cells (or 5 % stall) and dumps shape + ASCII so we can compare
// emergent nest morphology against real P. barbatus biology.
//
//   control  — baseline pheromone parameters
//   lever1   — slower build-pheromone decay (0.985 → 0.995); walls
//              persist longer, accumulating signal at chamber
//              boundaries faster (Khuong et al. 2016 mechanism for
//              chamber-cap stigmergy)
//   lever2   — sharpened queen-pheromone gradient (diffuse 1.00 →
//              0.30, decay 0.9995 → 0.998); creates discrete
//              iso-concentration bands at depth, the mechanism
//              Tschinkel 1998 invokes for stratified chambers in
//              P. badius/barbatus
//
// Excluded from default `npm test`. Run explicitly:
//   npx vitest run --config /dev/null tests/_morphology-tuning.test.ts \
//     --testTimeout=1800000

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
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
}

function buildSim(mode: Mode, seed = 7): Sim {
  const w = 400, h = 250;
  const rng = new RNG(seed);
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
  // Lever 1: slower build-pheromone decay so chamber-wall deposits
  // persist longer and accumulate signal faster at boundaries.
  const buildDecay = mode === 'lever1' ? 0.995 : 0.985;
  // Lever 2: sharpened queen-pheromone gradient so depth-stratified
  // iso-concentration bands form.
  const queenDiffuse = mode === 'lever2' ? 0.30 : 1.00;
  const queenDecay = mode === 'lever2' ? 0.998 : 0.9995;
  const fields = {
    dig: new Pheromone(w, h, 0.10, 0.999),
    build: new Pheromone(w, h, 0.10, buildDecay),
    trail: new Pheromone(w, h, 0.05, 0.992),
    alarm: new Pheromone(w, h, 0.20, 0.95),
    queen: new Pheromone(w, h, queenDiffuse, queenDecay, true),
    brood: new Pheromone(w, h, 0.30, 0.998),
    necro: new Pheromone(w, h, 0.10, 0.99),
    noEntry: new Pheromone(w, h, 0.05, 0.985),
    granary: new Pheromone(w, h, 0.20, 0.998),
    trunk: new Pheromone(w, h, 0.05, 0.9995),
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

function countNest(world: World): number {
  let n = 0;
  const w = world.width, h = world.height;
  for (let x = 0; x < w; x++) {
    const surf = world.naturalSurface[x]!;
    for (let y = surf; y < h; y++) {
      if (world.cells[y * w + x]! === CELL_AIR) n++;
    }
  }
  return n;
}

interface Shape {
  maxDepth: number; width: number; aspect: number;
  chambers: number; largestChamber: number;
  shaftCells: number; depthSizeSlope: number;
}

function computeShape(world: World): Shape {
  const w = world.width, h = world.height;
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
  return { maxDepth, width, aspect, chambers: chamberSizes.length, largestChamber, shaftCells, depthSizeSlope };
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
  shape: Shape; cells: number; ticks: number; ascii: string; reason: string;
} {
  const s = buildSim(mode);
  const log = (m: string): void => { process.stderr.write(`[${name}] ${m}\n`); };
  log(`start mode=${mode} target=${target} cap=${capTicks}`);
  const t0 = Date.now();
  let ticks = 0;
  let cells = countNest(s.world);
  let prevCells = cells;
  let reason = 'cap';
  const SNAP = 50_000;
  const STALL = 1.05;
  while (ticks < capTicks) {
    runStep(s);
    ticks++;
    if (ticks % SNAP === 0) {
      cells = countNest(s.world);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      log(`tick=${ticks} cells=${cells} (${dt}s wall)`);
      if (cells >= target) { reason = 'target'; break; }
      if (cells < prevCells * STALL) {
        log(`stall: ${prevCells} → ${cells}`);
        reason = 'stall';
        break;
      }
      prevCells = cells;
    }
  }
  cells = countNest(s.world);
  log(`done: ticks=${ticks} cells=${cells} reason=${reason}`);
  return { shape: computeShape(s.world), cells, ticks, ascii: asciiMap(s.world), reason };
}

describe('morphology tuning', () => {
  it('compares queen-only founding under control / lever1 / lever2', () => {
    const TARGET = 500;
    const CAP = 600_000;
    const SCENARIOS: { name: string; mode: Mode }[] = [
      { name: 'control', mode: 'control' },
      { name: 'lever1',  mode: 'lever1' },
      { name: 'lever2',  mode: 'lever2' },
    ];
    const results: { name: string; r: ReturnType<typeof runScenario> }[] = [];
    for (const sc of SCENARIOS) {
      const r = runScenario(sc.name, sc.mode, TARGET, CAP);
      results.push({ name: sc.name, r });
      const sh = r.shape;
      process.stderr.write(
        `\n========== [${sc.name}] result (${r.reason}) ==========\n` +
        `cells=${r.cells} ticks=${r.ticks} depth=${sh.maxDepth} ` +
        `width=${sh.width} aspect=${sh.aspect.toFixed(2)} ` +
        `chambers=${sh.chambers} largest=${sh.largestChamber} ` +
        `shaft=${sh.shaftCells} slope=${sh.depthSizeSlope.toFixed(3)}\n` +
        `${r.ascii}\n`,
      );
    }
    process.stderr.write('\n========== summary ==========\n');
    process.stderr.write('| mode    | cells | ticks   | depth | width | aspect | chambers | largest | shaft | slope  | reason |\n');
    process.stderr.write('|---------|------:|--------:|------:|------:|-------:|---------:|--------:|------:|-------:|--------|\n');
    for (const { name, r } of results) {
      const sh = r.shape;
      process.stderr.write(
        `| ${name.padEnd(7)} | ${String(r.cells).padStart(5)} | ` +
        `${String(r.ticks).padStart(7)} | ${String(sh.maxDepth).padStart(5)} | ` +
        `${String(sh.width).padStart(5)} | ${sh.aspect.toFixed(2).padStart(6)} | ` +
        `${String(sh.chambers).padStart(8)} | ${String(sh.largestChamber).padStart(7)} | ` +
        `${String(sh.shaftCells).padStart(5)} | ${sh.depthSizeSlope.toFixed(3).padStart(6)} | ` +
        `${r.reason.padEnd(6)} |\n`
      );
    }
    expect(results.length).toBe(3);
  });
});
