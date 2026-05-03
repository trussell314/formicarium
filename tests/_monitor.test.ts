// Verification run after Fix I (long-CARRY bail) + Fix J (above-
// surface WANDER can roll FORAGE). Same diagnostics as the previous
// deep-monitor run so before/after comparison is direct.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
  Colony, STATE_DEAD, STATE_QUEEN, STATE_EGG, STATE_LARVA, STATE_PUPA,
  STATE_WANDER, STATE_CARRY, STATE_REST, STATE_FORAGE,
  STATE_CARRY_FOOD, STATE_NECRO_CARRY,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, isLoose, World } from '../src/sim/world';

const TICKS_PER_CHECKPOINT = process.env.MONITOR_TICKS
  ? parseInt(process.env.MONITOR_TICKS, 10)
  : 30_000;
const NUM_CHECKPOINTS = process.env.MONITOR_CHECKPOINTS
  ? parseInt(process.env.MONITOR_CHECKPOINTS, 10)
  : 10; // 300k ticks default — early-game / starvation-onset window
const LOG_PATH = process.env.MONITOR_LOG ?? '/tmp/lateral-monitor.log';
function log(line: string): void { fs.appendFileSync(LOG_PATH, line + '\n'); }

function buildClaustralWorld(seed: number) {
  const rng = new RNG(seed);
  // World height bumped from 140 → 400 (test #5 in the morphology
  // sequence). At 3 mm/cell that's 120 cm deep — the bottom end of
  // a real *P. barbatus* nest depth (Tschinkel 2004 measured 1-2 m
  // for established nests). The previous 140-cell (42 cm) world
  // cropped chambers to a young-nest depth where flat-pancake
  // morphology hasn't yet emerged. Width stays 280 (84 cm) so the
  // top-down footprint matches typical mature-nest mound diameter.
  const W = 400, H = 400;
  const world = new World(W, H);
  world.foodCap = 1;
  world.generate(rng, Math.floor(H * 0.10), Math.max(6, Math.floor(W * 0.06)), 7);
  const dig = new Pheromone(W, H, 0.24, 0.999);
  const build = new Pheromone(W, H, 0.40, 0.9995);
  const trail = new Pheromone(W, H, 0.40, 0.999);
  const alarm = new Pheromone(W, H, 0.50, 0.985);
  const queen = new Pheromone(W, H, 0.10, 0.999, true);
  const brood = new Pheromone(W, H, 0.20, 0.999, true);
  const necro = new Pheromone(W, H, 0.30, 0.99);
  const noEntry = new Pheromone(W, H, 0.05, 0.995);
  const granary = new Pheromone(W, H, 0.10, 0.999);
  const trunk = new Pheromone(W, H, 0.20, 0.9995);
  const colony = new Colony(HARVESTER.maxColonySize);
  const cx = world.width >> 1;
  const SHAFT_DEPTH = 10;
  const POCKET_HEIGHT = 4;
  const surfHere = world.naturalSurface[cx]!;
  const queenY = surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1;
  const qIdx = colony.spawn(cx + 0.5, queenY + 0.5, 0, rng, DEFAULT_PARAMS);
  if (qIdx >= 0) { colony.state[qIdx] = STATE_QUEEN; colony.energy[qIdx] = HARVESTER.maxEnergy; }
  return { rng, world, colony, dig, build, trail, alarm, queen, brood, necro, noEntry, granary, trunk };
}

function reportCheckpoint(world: World, c: Colony, label: string,
  carryStartTicks: Int32Array, lastReturnRate: { value: number; t: number }): void {
  let queens = 0, eggs = 0, larvae = 0, pupae = 0, dead = 0;
  let wander = 0, carry = 0, rest = 0, forage = 0, carryFood = 0, necro = 0;
  let workerEnergyN = 0, workerEnergySum = 0;
  let queenEnergy = 0;
  let larvaEnergyN = 0, larvaEnergySum = 0;
  let cE = 0, cN = 0, fE = 0, fN = 0, cfE = 0, cfN = 0, wE = 0, wN = 0;
  let stuckCarry = 0;
  const depthBins = [0, 0, 0, 0, 0, 0];
  let maxDepth = 0;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      if (world.cells[y * world.width + x]! === CELL_AIR && y >= world.naturalSurface[x]!) {
        const d = y - world.naturalSurface[x]!;
        if (d > maxDepth) maxDepth = d;
      }
    }
  }
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD) { dead++; continue; }
    if (s === STATE_QUEEN) { queens++; queenEnergy = c.energy[i]!; continue; }
    if (s === STATE_EGG) { eggs++; continue; }
    if (s === STATE_LARVA) { larvae++; larvaEnergySum += c.energy[i]!; larvaEnergyN++; continue; }
    if (s === STATE_PUPA) { pupae++; continue; }
    const e = c.energy[i]!;
    if (s === STATE_WANDER) { wander++; wE += e; wN++; }
    else if (s === STATE_CARRY) {
      carry++; cE += e; cN++;
      if (world.tick - carryStartTicks[i]! >= 2000) stuckCarry++;
    }
    else if (s === STATE_REST) rest++;
    else if (s === STATE_FORAGE) { forage++; fE += e; fN++; }
    else if (s === STATE_CARRY_FOOD) { carryFood++; cfE += e; cfN++; }
    else if (s === STATE_NECRO_CARRY) necro++;
    workerEnergySum += e;
    workerEnergyN++;
    const ix = c.posX[i]! | 0;
    const iy = c.posY[i]! | 0;
    if (ix >= 0 && ix < world.width) {
      const d = iy - world.naturalSurface[ix]!;
      if (d < 0) depthBins[0]!++;
      else if (maxDepth === 0) depthBins[1]!++;
      else {
        const bin = Math.min(5, Math.max(1, 1 + Math.floor((d / maxDepth) * 5)));
        depthBins[bin]!++;
      }
    }
  }
  const alive = wander + carry + rest + forage + carryFood + necro;
  const meanWorkerE = workerEnergyN > 0 ? workerEnergySum / workerEnergyN : 0;
  const meanLarvaE = larvaEnergyN > 0 ? larvaEnergySum / larvaEnergyN : 0;
  // Post-unification: every solid cell is CELL_SOIL; loose deposits
  // are the subset with hardness below the loose threshold. Total
  // soil here means consolidated wall (i.e. solid AND not loose).
  let grains = 0, foodCount = 0, soilCount = 0, corpses = 0;
  for (let i = 0; i < world.cells.length; i++) {
    const k = world.cells[i]!;
    if (k === CELL_SOIL) {
      if (isLoose(world, i)) grains++;
      else soilCount++;
    }
    if (world.food[i]! > 0) foodCount++;
    if (world.corpse[i]! > 0) corpses++;
  }
  // Below-surface AIR cells = current open nest volume (chambers +
  // tunnels). Tracks how big the nest cavity is right now.
  let nestVol = 0;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      if (world.cells[y * world.width + x]! !== CELL_AIR) continue;
      if (y < world.naturalSurface[x]!) continue;
      nestVol++;
    }
  }
  let foodWithWorkerNearby = 0;
  if (foodCount > 0) {
    for (let fi = 0; fi < world.food.length; fi++) {
      if (world.food[fi]! === 0) continue;
      const fy = (fi / world.width) | 0;
      const fx = fi - fy * world.width;
      let found = false;
      for (let i = 0; i < c.count && !found; i++) {
        const s = c.state[i]!;
        if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA || s === STATE_PUPA || s === STATE_QUEEN) continue;
        const dx = c.posX[i]! - fx;
        const dy = c.posY[i]! - fy;
        if (dx * dx + dy * dy <= 25) found = true;
      }
      if (found) foodWithWorkerNearby++;
    }
  }
  const dt = world.tick - lastReturnRate.t;
  const returnsThisCp = dt > 0
    ? Math.max(0, world.foragerReturnRate - lastReturnRate.value * Math.pow(0.998, dt))
    : 0;
  lastReturnRate.value = world.foragerReturnRate;
  lastReturnRate.t = world.tick;
  // Tunnel / chamber architecture. Real ant nests have a clear
  // shaft-and-chamber topology: narrow vertical galleries connect
  // pancake-shaped chambers stacked at intervals (Tschinkel 2004
  // J Insect Sci 4:21; Mikheyev & Tschinkel 2004). The earlier
  // analysis flood-filled every below-surface AIR cell as one
  // component, so a chamber with a shaft attached read as a single
  // tall L-shape — chambers always looked impossibly tall.
  //
  // The fix: classify each AIR cell first by its row-width (the
  // span of contiguous AIR cells in its row). Cells in rows of
  // width ≤ 2 are SHAFT cells; cells in rows of width ≥ 3 are
  // CHAMBER cells. Then flood-fill each set separately. A shaft
  // and a chamber sharing a boundary become two distinct
  // components even though they're physically connected.
  //
  // Real-nest references (3 mm/cell scale):
  //   chambers 17-50 cells wide × 7-17 cells tall (5-15 × 2-5 cm)
  //   galleries 100-700 cells long
  //   chambers : shafts ratio in mature nests 3-20×
  const wW = world.width, wH = world.height;
  const SHAFT_WIDTH_MAX = 2;
  // Per-cell classification: 0 = not air-below-surface, 1 = shaft,
  // 2 = chamber.
  const cellKind = new Uint8Array(wW * wH);
  for (let y = 0; y < wH; y++) {
    let runStart = -1;
    for (let x = 0; x <= wW; x++) {
      const idx = y * wW + x;
      const isAir = x < wW
        && world.cells[idx]! === CELL_AIR
        && y >= world.naturalSurface[x]!;
      if (isAir && runStart < 0) runStart = x;
      if ((!isAir || x === wW) && runStart >= 0) {
        const runEnd = x - 1;
        const runWidth = runEnd - runStart + 1;
        const kind = runWidth <= SHAFT_WIDTH_MAX ? 1 : 2;
        for (let cx = runStart; cx <= runEnd; cx++) {
          cellKind[y * wW + cx] = kind;
        }
        runStart = -1;
      }
    }
  }
  // Flood-fill each kind separately.
  const visited = new Uint8Array(wW * wH);
  const queue = new Int32Array(wW * wH);
  type Component = { cells: number; minY: number; maxY: number; minX: number; maxX: number };
  const shafts: Component[] = [];
  const chambers: Component[] = [];
  for (let kind = 1; kind <= 2; kind++) {
    for (let y = 0; y < wH; y++) {
      for (let x = 0; x < wW; x++) {
        const idx = y * wW + x;
        if (visited[idx] || cellKind[idx]! !== kind) continue;
        let head = 0, tail = 0;
        queue[tail++] = idx;
        visited[idx] = 1;
        let cells = 0, minY = y, maxY = y, minX = x, maxX = x;
        while (head < tail) {
          const p = queue[head++]!;
          const py = (p / wW) | 0;
          const px = p - py * wW;
          cells++;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= wW || ny >= wH) continue;
            const nIdx = ny * wW + nx;
            if (visited[nIdx] || cellKind[nIdx]! !== kind) continue;
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
        const comp: Component = { cells, minY, maxY, minX, maxX };
        if (kind === 1) shafts.push(comp);
        else chambers.push(comp);
      }
    }
  }
  // Stats. Distinguish "galleries" (real connecting tunnels, ≥5
  // cells) from "stubs" (1-4 cell exploratory pockets). The
  // earlier shaft count was misleading because it conflated real
  // gallery passages with tiny side-pockets that aren't usable
  // as connectors. Real young P. barbatus has ~3-10 galleries
  // and ~20-40 stubs; mature has ~5-30 galleries.
  const GALLERY_MIN_CELLS = 5;
  let galleryCount = 0, stubCount = 0;
  let galleryLenMax = 0;
  for (const s of shafts) {
    const len = s.maxY - s.minY + 1;
    if (s.cells >= GALLERY_MIN_CELLS) {
      galleryCount++;
      if (len > galleryLenMax) galleryLenMax = len;
    } else {
      stubCount++;
    }
  }
  const galleryLenCm = (galleryLenMax * 0.3).toFixed(1);
  let chamberCellsMax = 0, chamberWidthMax = 0, chamberHeightMax = 0;
  // Mean aspect ratio (height / width) — real chambers are flat
  // (h/w ≈ 0.2-0.4); a tall sim chamber would show h/w > 1.
  let aspectSum = 0, aspectN = 0;
  // 5-bin depth distribution of chamber cells.
  const archDepthBins = [0, 0, 0, 0, 0];
  const denom = Math.max(1, maxDepth);
  for (const ch of chambers) {
    const cw = ch.maxX - ch.minX + 1;
    const chh = ch.maxY - ch.minY + 1;
    if (ch.cells > chamberCellsMax) chamberCellsMax = ch.cells;
    if (cw > chamberWidthMax) chamberWidthMax = cw;
    if (chh > chamberHeightMax) chamberHeightMax = chh;
    aspectSum += chh / Math.max(1, cw);
    aspectN++;
    for (let py = ch.minY; py <= ch.maxY; py++) {
      const surf = world.naturalSurface[Math.floor((ch.minX + ch.maxX) / 2)]!;
      const d = py - surf;
      if (d < 0) continue;
      const bin = Math.min(4, Math.floor((d / denom) * 5));
      archDepthBins[bin]! += cw;
    }
  }
  const meanAspect = aspectN > 0 ? aspectSum / aspectN : 0;
  const chamberWidthCm = (chamberWidthMax * 0.3).toFixed(1);

  log(
    `\n${label} t=${world.tick.toLocaleString()}\n` +
    `  pop:    Q${queens} ${eggs}E ${larvae}L ${pupae}P workers=${alive} dead=${dead} (born=${world.totalBorn} died=${world.totalDied})\n` +
    `  states: W${wander} C${carry} R${rest} F${forage} Cf${carryFood} N${necro}\n` +
    `  energy: queen=${queenEnergy.toFixed(2)} workers=${meanWorkerE.toFixed(2)} larvae=${meanLarvaE.toFixed(2)} ` +
      `[C=${(cN > 0 ? cE / cN : 0).toFixed(2)} F=${(fN > 0 ? fE / fN : 0).toFixed(2)} Cf=${(cfN > 0 ? cfE / cfN : 0).toFixed(2)} W=${(wN > 0 ? wE / wN : 0).toFixed(2)}]\n` +
    `  nest:   cells=${nestVol} grains=${grains} food=${foodCount} corpses=${corpses} depth=${maxDepth}\n` +
    `  arch:   galleries=${galleryCount} (max ${galleryLenMax}c=${galleryLenCm}cm) ` +
      `stubs=${stubCount} chambers=${chambers.length} ` +
      `(max ${chamberCellsMax}c, ${chamberWidthMax}×${chamberHeightMax} = ${chamberWidthCm}×${(chamberHeightMax * 0.3).toFixed(1)}cm) ` +
      `mean h/w=${meanAspect.toFixed(2)}\n` +
    `  arch-ref: real *P. barbatus* — chambers 17-50c wide × 7-17c tall (h/w ≈ 0.2-0.4), galleries ~3-10 young / ~5-30 mature, gallery length 100-700c\n` +
    `  arch-depth (d0-d4): ${archDepthBins.join('|')}\n` +
    `  depth-hist (above|d1|d2|d3|d4|d5): ${depthBins.join('|')}\n` +
    `  food-near-worker: ${foodWithWorkerNearby}/${foodCount}\n` +
    `  stuck-CARRY (>=2000t): ${stuckCarry}/${carry}\n` +
    `  forage: returnRate=${world.foragerReturnRate.toFixed(3)} (~${returnsThisCp.toFixed(1)} new returns since last)`,
  );
}

/** Log a behaviour snapshot for ~10 spatially-distributed ants.
 *  Useful on short-slice runs to sanity-check that individuals are
 *  doing something sensible. Picks the queen, then the youngest /
 *  oldest worker, then 8 more spread by x-coordinate. */
function logAntWatch(world: World, c: Colony): void {
  const sample: number[] = [];
  // Always include the queen.
  for (let i = 0; i < c.count; i++) {
    if (c.state[i]! === STATE_QUEEN) { sample.push(i); break; }
  }
  // Youngest + oldest live worker.
  let youngest = -1, oldest = -1, youngestAge = Infinity, oldestAge = -Infinity;
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA || s === STATE_PUPA || s === STATE_QUEEN) continue;
    const a = c.age[i]!;
    if (a < youngestAge) { youngestAge = a; youngest = i; }
    if (a > oldestAge) { oldestAge = a; oldest = i; }
  }
  if (youngest >= 0 && !sample.includes(youngest)) sample.push(youngest);
  if (oldest >= 0 && !sample.includes(oldest)) sample.push(oldest);
  // Fill to ~10 by spatial spread on x.
  const workers: number[] = [];
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA || s === STATE_PUPA || s === STATE_QUEEN) continue;
    if (!sample.includes(i)) workers.push(i);
  }
  workers.sort((a, b) => c.posX[a]! - c.posX[b]!);
  const want = Math.min(10 - sample.length, workers.length);
  for (let k = 0; k < want; k++) {
    const idx = Math.floor((k + 0.5) * workers.length / want);
    sample.push(workers[idx]!);
  }
  const stateName = (s: number): string => {
    switch (s) {
      case STATE_QUEEN: return 'QUEEN';
      case STATE_WANDER: return 'WAND';
      case STATE_CARRY: return 'CARRY';
      case STATE_REST: return 'REST';
      case STATE_FORAGE: return 'FORAGE';
      case STATE_CARRY_FOOD: return 'CF';
      case STATE_NECRO_CARRY: return 'NECRO';
      case STATE_LARVA: return 'LARVA';
      case STATE_PUPA: return 'PUPA';
      case STATE_EGG: return 'EGG';
      case STATE_DEAD: return 'DEAD';
      default: return `?${s}`;
    }
  };
  log(`  ant-watch (n=${sample.length}, sampled by spatial spread):`);
  for (const i of sample) {
    const px = c.posX[i]!.toFixed(1).padStart(5);
    const py = c.posY[i]!.toFixed(1).padStart(5);
    const ix = c.posX[i]! | 0;
    const iy = c.posY[i]! | 0;
    const surf = ix >= 0 && ix < world.width ? world.naturalSurface[ix]! : 0;
    const depth = iy - surf;
    const aboveSurface = iy < surf;
    const cellAt = ix >= 0 && ix < world.width && iy >= 0 && iy < world.height
      ? world.cells[iy * world.width + ix]! : -1;
    const idxAt = ix >= 0 && ix < world.width && iy >= 0 && iy < world.height
      ? iy * world.width + ix : -1;
    const cellDesc = cellAt === CELL_AIR ? 'AIR'
      : cellAt === CELL_SOIL
        ? (idxAt >= 0 && isLoose(world, idxAt) ? 'GRAIN' : 'SOIL')
        : '?';
    const e = c.energy[i]!.toFixed(2);
    const a = c.age[i]!;
    log(`    #${String(i).padStart(3)} ${stateName(c.state[i]!).padEnd(6)} @(${px},${py}) ${aboveSurface ? 'above' : `d${depth}`} ${cellDesc} age=${a} E=${e}`);
  }
}

describe('claustral monitoring (post-IJ)', () => {
  it(`runs ${NUM_CHECKPOINTS * TICKS_PER_CHECKPOINT} ticks`, () => {
    fs.writeFileSync(LOG_PATH, '');
    const sim = buildClaustralWorld(0xc1ade57a1);
    const { rng, world, colony, dig, build, trail, alarm, queen, brood, necro, noEntry, granary, trunk } = sim;
    log(`=== claustral monitor (post lateral-chamber dig-pheromone fix): width=${world.width} height=${world.height} ants=0 ===`);
    const carryStartTicks = new Int32Array(HARVESTER.maxColonySize);
    const lastState = new Uint8Array(HARVESTER.maxColonySize);
    const lastReturnRate = { value: 0, t: 0 };
    reportCheckpoint(world, colony, 't=0       ', carryStartTicks, lastReturnRate);
    // Sample-ant watch is enabled by default for short-slice runs
    // (≤ 6 checkpoints) so individual behaviour can be sanity-
    // checked. Skipped on long runs to keep the log compact.
    const watchAnts = NUM_CHECKPOINTS <= 6 || process.env.MONITOR_WATCH === '1';
    if (watchAnts) logAntWatch(world, colony);
    for (let cp = 1; cp <= NUM_CHECKPOINTS; cp++) {
      const target = cp * TICKS_PER_CHECKPOINT;
      while (world.tick < target) {
        step(world, colony, dig, build, rng, DEFAULT_PARAMS, undefined, HARVESTER, trail, alarm, queen, brood, necro, noEntry, granary, trunk);
        for (let i = 0; i < colony.count; i++) {
          const s = colony.state[i]!;
          if (s !== lastState[i]!) {
            if (s === STATE_CARRY) carryStartTicks[i] = world.tick;
            lastState[i] = s;
          }
        }
      }
      reportCheckpoint(world, colony, `5min×${cp.toString().padStart(2)}`, carryStartTicks, lastReturnRate);
      if (watchAnts) logAntWatch(world, colony);
    }
    // ASCII nest dump — visualise the cross-section so chamber
    // formation is directly inspectable. Crops to the dug region
    // (vertical: surface-2 to deepest-cell+2, horizontal: leftmost
    // to rightmost dug column ±4). '.' = soil, ' ' = sky/air-above,
    // '#' = grain, ':' = food, '+' = corpse, ' ' = open air below
    // surface (chamber/tunnel).
    {
      let minX = world.width, maxX = -1, minY = world.height, maxY = -1;
      for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
          const idx = y * world.width + x;
          const k = world.cells[idx]!;
          const sy = world.naturalSurface[x]!;
          if (k === CELL_AIR && y >= sy) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          } else if (k === CELL_SOIL && isLoose(world, idx)) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= 0) {
        const x0 = Math.max(0, minX - 4);
        const x1 = Math.min(world.width - 1, maxX + 4);
        let surfMin = world.height;
        for (let xx = x0; xx <= x1; xx++) {
          const sy = world.naturalSurface[xx]!;
          if (sy < surfMin) surfMin = sy;
        }
        const y0 = Math.max(0, surfMin - 2);
        const y1 = Math.min(world.height - 1, maxY + 2);
        log(`\n=== nest cross-section (cols ${x0}-${x1}, rows ${y0}-${y1}) ===`);
        for (let y = y0; y <= y1; y++) {
          let line = `${y.toString().padStart(3)} `;
          for (let x = x0; x <= x1; x++) {
            const idx = y * world.width + x;
            const k = world.cells[idx]!;
            const sy = world.naturalSurface[x]!;
            if (world.corpse[idx]! > 0) line += '+';
            else if (world.food[idx]! > 0) line += ':';
            else if (k === CELL_SOIL && isLoose(world, idx)) line += '#';
            else if (k === CELL_SOIL) line += '.';
            else if (y < sy) line += ' ';
            else line += '·'; // open air below surface (chamber/tunnel)
          }
          log(line);
        }
      }
    }
    log(`\n=== run complete ===`);
    expect(world.tick).toBeGreaterThan(NUM_CHECKPOINTS * TICKS_PER_CHECKPOINT - 1);
  }, 1_800_000);
});
