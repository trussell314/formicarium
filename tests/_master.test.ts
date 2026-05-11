// Master long-running diagnostic. Default scenario, 1M ticks.
// Three nested observation tiers around each 50k-tick macro
// checkpoint:
//
//   MACRO   — every 50k ticks (20 total in a 1M run):
//     full colony snapshot — population, energy, nest
//     architecture, food, breach, pheromone peaks, anomaly
//     detection, "colony-need vs actual" mismatch report,
//     activity heatmap.
//
//   MEDIUM  — 20 samples at 500-tick spacing around each macro
//     (10 before + 10 after, ±5,000-tick window):
//     a curated set of tracked ants picked at the macro tick
//     (state-diverse + spatially-diverse) re-sampled at each
//     point. Gives short-horizon trajectory.
//
//   FINE    — 20 samples at 10-tick spacing around each macro
//     (10 before + 10 after, ±100-tick window):
//     the same tracked ants, finer cadence. Catches per-tick
//     dynamics — bouncing, oscillation, stuck-cycle artefacts.
//
// At end of run: an ASCII trend table summarising all 20 macro
// checkpoints in a single readable block — easy to spot
// long-horizon pathologies.
//
// Knobs (env vars):
//   MASTER_TICKS         total tick budget (default 1,000,000)
//   MASTER_MACRO         macro checkpoint interval (default 50,000)
//   MASTER_LOG           output path (default /tmp/master-test.log)
//   MASTER_SEED          RNG seed (default 0xc1ade57a1)
//
// Run with:
//   npx vitest run --config vitest.monitor.config.ts \
//     tests/_master.test.ts --testTimeout=7200000

import { describe, expect, it } from 'vitest';
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

const TOTAL_TICKS = parseInt(process.env.MASTER_TICKS ?? '1000000', 10);
const MACRO_INTERVAL = parseInt(process.env.MASTER_MACRO ?? '50000', 10);
const MEDIUM_HALF = 10;       // 10 samples on each side of macro
const MEDIUM_SPACING = 500;
const FINE_HALF = 10;          // 10 samples on each side of macro
const FINE_SPACING = 10;
const SEED = parseInt(process.env.MASTER_SEED ?? '0xc1ade57a1', 16);
const LOG_PATH = process.env.MASTER_LOG ?? '/tmp/master-test.log';

function log(line: string): void { fs.appendFileSync(LOG_PATH, line + '\n'); }

// ───────────────────────── world setup ─────────────────────────

function buildClaustralWorld(seed: number) {
  const rng = new RNG(seed);
  const W = 300, H = 400;
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
  const breachAlarm = new Pheromone(W, H, 0.50, 0.985);
  const entrance = new Pheromone(W, H, 0.50, 0.9999);
  const colony = new Colony(HARVESTER.maxColonySize);
  const cx = world.width >> 1;
  const SHAFT_DEPTH = 10, POCKET_HEIGHT = 4;
  const surfHere = world.naturalSurface[cx]!;
  const queenY = surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1;
  const qIdx = colony.spawn(cx + 0.5, queenY + 0.5, 0, rng, DEFAULT_PARAMS);
  if (qIdx >= 0) { colony.state[qIdx] = STATE_QUEEN; colony.energy[qIdx] = HARVESTER.maxEnergy; }
  return {
    rng, world, colony,
    dig, build, trail, alarm, queen, brood, necro, noEntry, granary, trunk,
    breachAlarm, entrance,
  };
}

type Sim = ReturnType<typeof buildClaustralWorld>;

// ───────────────────────── helpers ─────────────────────────

function stateName(s: number): string {
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
}

function shortStateName(s: number): string {
  switch (s) {
    case STATE_QUEEN: return 'Q';
    case STATE_WANDER: return 'W';
    case STATE_CARRY: return 'C';
    case STATE_REST: return 'R';
    case STATE_FORAGE: return 'F';
    case STATE_CARRY_FOOD: return 'Cf';
    case STATE_NECRO_CARRY: return 'N';
    case STATE_LARVA: return 'L';
    case STATE_PUPA: return 'P';
    case STATE_EGG: return 'E';
    case STATE_DEAD: return 'X';
    default: return '?';
  }
}

/** Spatial zone label for an (x, y) position in the world. Used to
 *  track ants by area. Quadrant of the surface plus depth band. */
function zoneOf(world: World, x: number, y: number): string {
  const ecx = world.width >> 1;
  const surf = x >= 0 && x < world.width ? world.naturalSurface[x]! : 0;
  const depth = y - surf;
  const horiz = x < ecx - 30 ? 'W' : x > ecx + 30 ? 'E' : 'C'; // West/Centre/East
  let band: string;
  if (depth < 0) band = 'sky';        // above surface
  else if (depth < 5) band = 'top';   // near surface
  else if (depth < 30) band = 'shaft';
  else if (depth < 80) band = 'mid';
  else band = 'deep';
  return `${horiz}-${band}`;
}

// ───────────────────────── ant sampling ─────────────────────────

/** Pick a curated set of ants for the current macro window:
 *  - one ant per state present (max 1 per state)
 *  - additional ants for spatial coverage so each occupied zone
 *    has at least one tracked ant (up to MAX_TOTAL)
 *  Adult (non-brood, non-dead) only; brood and corpses are summarised
 *  in the macro stats instead. */
function pickTrackedAnts(sim: Sim): number[] {
  const c = sim.colony;
  const w = sim.world;
  const MAX_TOTAL = 12;
  const byState: Map<number, number[]> = new Map();
  const byZone: Map<string, number[]> = new Map();
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA || s === STATE_PUPA) continue;
    const list = byState.get(s) ?? [];
    list.push(i);
    byState.set(s, list);
    const zone = zoneOf(w, c.posX[i]! | 0, c.posY[i]! | 0);
    const zList = byZone.get(zone) ?? [];
    zList.push(i);
    byZone.set(zone, zList);
  }
  const picked = new Set<number>();
  // Pass 1: one per state.
  for (const list of byState.values()) {
    if (picked.size >= MAX_TOTAL) break;
    if (list.length > 0) picked.add(list[0]!);
  }
  // Pass 2: add ants from zones not yet represented.
  const repZones = new Set<string>();
  for (const i of picked) {
    repZones.add(zoneOf(w, c.posX[i]! | 0, c.posY[i]! | 0));
  }
  for (const [zone, list] of byZone) {
    if (picked.size >= MAX_TOTAL) break;
    if (repZones.has(zone)) continue;
    for (const i of list) {
      if (!picked.has(i)) { picked.add(i); break; }
    }
    repZones.add(zone);
  }
  return Array.from(picked);
}

// ───────────────────────── per-ant sample ─────────────────────────

function antSampleLine(sim: Sim, i: number, tick: number): string {
  const c = sim.colony;
  const w = sim.world;
  const s = c.state[i]!;
  if (s === STATE_DEAD) {
    return `    #${String(i).padStart(3)} DEAD                                                          `;
  }
  const px = c.posX[i]!.toFixed(1).padStart(5);
  const py = c.posY[i]!.toFixed(1).padStart(5);
  const ix = c.posX[i]! | 0;
  const iy = c.posY[i]! | 0;
  const surf = ix >= 0 && ix < w.width ? w.naturalSurface[ix]! : 0;
  const depth = iy - surf;
  const e = c.energy[i]!.toFixed(2);
  const stuckTicks = c.stuckTicks[i]!;
  const cargo = c.carryMoves[i]!;
  return `    #${String(i).padStart(3)} ${stateName(s).padEnd(6)} t=${tick.toString().padStart(7)} @(${px},${py}) d${String(depth).padStart(3)} E=${e} cargo=${String(cargo).padStart(3)} stuck=${String(stuckTicks).padStart(3)} zone=${zoneOf(w, ix, iy)}`;
}

// ───────────────────────── macro snapshot ─────────────────────────

interface TrendRow {
  tick: number;
  alive: number;
  dead: number;
  born: number;
  eggs: number;
  larvae: number;
  pupae: number;
  meanWorkerE: number;
  meanLarvaE: number;
  food: number;
  surfaceFood: number;
  corpses: number;
  depth: number;
  chambers: number;
  galleries: number;
  returnRate: number;
  breachAlarmPeak: number;
  loose: number;
  consolidated: number;
  // Forage pipeline deltas since the previous macro. A low
  // discovery ratio (pickups/starts) indicates foragers can't
  // find food; a low delivery ratio (deliveries/pickups) means
  // they find it but lose it on the return trip.
  forageStarts: number;
  foragePickups: number;
  forageDeliveries: number;
  forageBails: number;
}

interface ForageBaseline {
  starts: number;
  pickups: number;
  deliveries: number;
  bails: number;
}

function macroSnapshot(
  sim: Sim,
  lastReturnRate: { v: number; t: number },
  forageBaseline: ForageBaseline,
  tracked: number[],
): TrendRow {
  const w = sim.world;
  const c = sim.colony;
  let queens = 0, eggs = 0, larvae = 0, pupae = 0, dead = 0;
  let wander = 0, carry = 0, rest = 0, forage = 0, carryFood = 0, necro = 0;
  let workerESum = 0, workerEN = 0;
  let larvaESum = 0, larvaEN = 0;
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD) { dead++; continue; }
    if (s === STATE_QUEEN) { queens++; continue; }
    if (s === STATE_EGG) { eggs++; continue; }
    if (s === STATE_LARVA) { larvae++; larvaESum += c.energy[i]!; larvaEN++; continue; }
    if (s === STATE_PUPA) { pupae++; continue; }
    workerESum += c.energy[i]!; workerEN++;
    if (s === STATE_WANDER) wander++;
    else if (s === STATE_CARRY) carry++;
    else if (s === STATE_REST) rest++;
    else if (s === STATE_FORAGE) forage++;
    else if (s === STATE_CARRY_FOOD) carryFood++;
    else if (s === STATE_NECRO_CARRY) necro++;
  }
  const alive = wander + carry + rest + forage + carryFood + necro;
  const meanWorkerE = workerEN > 0 ? workerESum / workerEN : 0;
  const meanLarvaE = larvaEN > 0 ? larvaESum / larvaEN : 0;
  // Cell counts.
  let foodCount = 0, surfaceFoodCount = 0, corpses = 0;
  let looseCount = 0, consolidatedCount = 0;
  let maxDepth = 0;
  for (let y = 0; y < w.height; y++) {
    for (let x = 0; x < w.width; x++) {
      const idx = y * w.width + x;
      const surf = w.naturalSurface[x]!;
      const k = w.cells[idx]!;
      if (k === CELL_AIR && y >= surf) {
        const d = y - surf;
        if (d > maxDepth) maxDepth = d;
      } else if (k === CELL_SOIL) {
        if (isLoose(w, idx)) looseCount++;
        else consolidatedCount++;
      }
      if (w.food[idx]! > 0) {
        foodCount++;
        if (y < surf) surfaceFoodCount++;
      }
      if (w.corpse[idx]! > 0) corpses++;
    }
  }
  // Architecture: chambers + galleries (same flood-fill as _monitor).
  const wW = w.width, wH = w.height;
  const SHAFT_WIDTH_MAX = 2;
  const cellKind = new Uint8Array(wW * wH);
  for (let y = 0; y < wH; y++) {
    let runStart = -1;
    for (let x = 0; x <= wW; x++) {
      const idx = y * wW + x;
      const isAir = x < wW
        && w.cells[idx]! === CELL_AIR
        && y >= w.naturalSurface[x]!;
      if (isAir && runStart < 0) runStart = x;
      if ((!isAir || x === wW) && runStart >= 0) {
        const runEnd = x - 1;
        const runWidth = runEnd - runStart + 1;
        const kind = runWidth <= SHAFT_WIDTH_MAX ? 1 : 2;
        for (let cx = runStart; cx <= runEnd; cx++) cellKind[y * wW + cx] = kind;
        runStart = -1;
      }
    }
  }
  const visited = new Uint8Array(wW * wH);
  const queue = new Int32Array(wW * wH);
  let chambers = 0, galleries = 0, stubs = 0, chamberMaxCells = 0;
  for (let kind = 1; kind <= 2; kind++) {
    for (let y = 0; y < wH; y++) {
      for (let x = 0; x < wW; x++) {
        const idx = y * wW + x;
        if (visited[idx] || cellKind[idx] !== kind) continue;
        let qH = 0, qT = 0;
        queue[qT++] = idx;
        visited[idx] = 1;
        let cells = 0;
        while (qH < qT) {
          const p = queue[qH++]!;
          const py = (p / wW) | 0;
          const px = p - py * wW;
          cells++;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= wW || ny >= wH) continue;
            const nIdx = ny * wW + nx;
            if (visited[nIdx] || cellKind[nIdx] !== kind) continue;
            visited[nIdx] = 1;
            queue[qT++] = nIdx;
          }
        }
        if (kind === 1) {
          if (cells >= 5) galleries++;
          else stubs++;
        } else {
          chambers++;
          if (cells > chamberMaxCells) chamberMaxCells = cells;
        }
      }
    }
  }
  // Pheromone peaks — for every field, find both the max value
  // AND the (x, y) location of the peak. The location annotation
  // lets us eyeball whether the peak makes sense given the
  // colony's geography (queen pheromone should peak near the
  // queen's chamber, granary near established granaries, etc.).
  // Full O(W·H) scan per field; 11 fields × 160k cells = ~2M
  // reads per macro, runs 20 times across a 1M-tick test —
  // still trivial relative to step() cost.
  const pheroFields: ReadonlyArray<readonly [string, Pheromone]> = [
    ['dig', sim.dig], ['build', sim.build], ['trail', sim.trail],
    ['alarm', sim.alarm], ['queen', sim.queen], ['brood', sim.brood],
    ['necro', sim.necro], ['noEntry', sim.noEntry],
    ['granary', sim.granary], ['trunk', sim.trunk],
    ['breachAlarm', sim.breachAlarm], ['entrance', sim.entrance],
  ];
  const pheroPeaks: Array<{ name: string; v: number; x: number; y: number }> = [];
  for (const [name, field] of pheroFields) {
    let pv = 0, pi = -1;
    const arr = field.current;
    for (let k = 0; k < arr.length; k++) {
      if (arr[k]! > pv) { pv = arr[k]!; pi = k; }
    }
    const py = pi >= 0 ? (pi / w.width) | 0 : -1;
    const px = pi >= 0 ? pi - py * w.width : -1;
    pheroPeaks.push({ name, v: pv, x: px, y: py });
  }
  const breachAlarmPeak = pheroPeaks.find((p) => p.name === 'breachAlarm')!.v;
  // Forage return-rate delta.
  const dt = w.tick - lastReturnRate.t;
  const returnsThisCp = dt > 0
    ? Math.max(0, w.foragerReturnRate - lastReturnRate.v * Math.pow(0.998, dt))
    : 0;
  lastReturnRate.v = w.foragerReturnRate;
  lastReturnRate.t = w.tick;
  // Forage pipeline deltas. Compute window-relative numbers so the
  // log shows actual activity in the last MACRO_INTERVAL ticks
  // rather than ever-growing cumulative totals.
  const dStarts = w.totalForageStarts - forageBaseline.starts;
  const dPickups = w.totalForagePickups - forageBaseline.pickups;
  const dDeliveries = w.totalForageDeliveries - forageBaseline.deliveries;
  const dBails = w.totalForageBails - forageBaseline.bails;
  forageBaseline.starts = w.totalForageStarts;
  forageBaseline.pickups = w.totalForagePickups;
  forageBaseline.deliveries = w.totalForageDeliveries;
  forageBaseline.bails = w.totalForageBails;
  // Discovery rate = how often a FORAGE trip results in a pickup.
  // Delivery rate = how often a pickup makes it home (deposit, not bail).
  const discoveryPct = dStarts > 0 ? (dPickups / dStarts) * 100 : 0;
  const deliveryPct = dPickups > 0 ? (dDeliveries / dPickups) * 100 : 0;
  // Activity heatmap — coarse 8×8 occupancy of adult workers.
  const heatmap: number[][] = [];
  const HM_W = 8, HM_H = 8;
  for (let y = 0; y < HM_H; y++) {
    const row: number[] = [];
    for (let x = 0; x < HM_W; x++) row.push(0);
    heatmap.push(row);
  }
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA || s === STATE_PUPA) continue;
    const ix = c.posX[i]! | 0;
    const iy = c.posY[i]! | 0;
    const hx = Math.min(HM_W - 1, Math.floor(ix * HM_W / w.width));
    const hy = Math.min(HM_H - 1, Math.floor(iy * HM_H / w.height));
    heatmap[hy]![hx]!++;
  }
  // Anomaly detection.
  const anomalies: string[] = [];
  let stuckCarry = 0, longRest = 0;
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_CARRY && c.stateTicks[i]! >= 1500) stuckCarry++;
    if (s === STATE_REST && c.stateTicks[i]! >= 4000) longRest++;
  }
  if (stuckCarry > 0) anomalies.push(`stuck-CARRY (>=1500t): ${stuckCarry}`);
  if (longRest > 0) anomalies.push(`long-REST (>=4000t): ${longRest}`);
  if (alive > 0 && meanWorkerE < 0.25) anomalies.push(`worker energy critical (mean=${meanWorkerE.toFixed(2)})`);
  if (alive > 5 && forage === 0 && surfaceFoodCount > 20) {
    anomalies.push(`forage demand UNMET — ${surfaceFoodCount} surface food, 0 foragers`);
  }
  if (corpses > 5 && necro === 0) {
    anomalies.push(`necrophoresis UNMET — ${corpses} corpses, 0 necro-carriers`);
  }
  // Forage pipeline anomalies. Need enough starts in the window to
  // have a meaningful ratio (else early-game sparse starts trigger
  // false alarms).
  if (dStarts >= 50 && discoveryPct < 5) {
    anomalies.push(`forage discovery low (${discoveryPct.toFixed(1)}%) — ${dStarts} starts, ${dPickups} pickups`);
  }
  if (dPickups >= 20 && deliveryPct < 30) {
    anomalies.push(`forage delivery low (${deliveryPct.toFixed(1)}%) — ${dPickups} pickups, ${dDeliveries} deliveries, ${dBails} bails`);
  }
  if (breachAlarmPeak > 0.5) {
    let respondersNear = 0;
    for (let i = 0; i < c.count; i++) {
      const s = c.state[i]!;
      if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA || s === STATE_PUPA) continue;
      const ix = c.posX[i]! | 0;
      const iy = c.posY[i]! | 0;
      if (sim.breachAlarm.sample(ix, iy) > 0.1) respondersNear++;
    }
    if (respondersNear === 0) anomalies.push(`breach UNMET — alarm peak ${breachAlarmPeak.toFixed(2)}, 0 responders`);
  }
  // ── log output ──
  log(`\n────── MACRO t=${w.tick.toLocaleString().padStart(8)} ──────`);
  log(`COLONY    Q${queens} alive=${alive} dead=${dead} born=${w.totalBorn} died=${w.totalDied}  E/L/P=${eggs}/${larvae}/${pupae}`);
  log(`STATES    W${wander} C${carry} R${rest} F${forage} Cf${carryFood} N${necro}`);
  log(`ENERGY    queen=${queens > 0 ? c.energy[indexOfQueen(c)]!.toFixed(2) : '—'} workers=${meanWorkerE.toFixed(2)} larvae=${meanLarvaE.toFixed(2)}`);
  log(`NEST      depth=${maxDepth} chambers=${chambers} (max ${chamberMaxCells}c) galleries=${galleries} stubs=${stubs} loose=${looseCount} wall=${consolidatedCount}`);
  log(`FOOD      total=${foodCount} surface=${surfaceFoodCount} corpses=${corpses}  returnRate=${w.foragerReturnRate.toFixed(2)} (Δ${returnsThisCp.toFixed(1)})`);
  log(`FORAGE    Δstarts=${dStarts} Δpickups=${dPickups} Δdeliveries=${dDeliveries} Δbails=${dBails}  discovery=${discoveryPct.toFixed(1)}% delivery=${deliveryPct.toFixed(1)}%`);
  log(`PHEROMONE peaks (value · (x,y) — eyeball whether the location matches the colony's current geography):`);
  for (const p of pheroPeaks) {
    const loc = p.v > 1e-6 ? `(${p.x.toString().padStart(3)},${p.y.toString().padStart(3)})` : '   —     ';
    log(`           ${p.name.padEnd(11)} ${p.v.toFixed(3).padStart(7)}  ${loc}`);
  }
  if (anomalies.length === 0) log(`ANOMALIES (none)`);
  else log(`ANOMALIES ${anomalies.join('; ')}`);
  log(`HEATMAP   (8×8 grid of adult-worker occupancy, '.' < 1, # >= 8)`);
  for (let y = 0; y < HM_H; y++) {
    let row = '          ';
    for (let x = 0; x < HM_W; x++) {
      const v = heatmap[y]![x]!;
      const ch = v === 0 ? '·' : v < 4 ? '.' : v < 8 ? 'o' : '#';
      row += ch;
    }
    log(row);
  }
  log(`TRACKED   (${tracked.length} ants picked: state-diverse + spatially-diverse)`);
  for (const i of tracked) {
    log(antSampleLine(sim, i, w.tick));
  }
  return {
    tick: w.tick,
    alive, dead, born: w.totalBorn,
    eggs, larvae, pupae,
    meanWorkerE, meanLarvaE,
    food: foodCount, surfaceFood: surfaceFoodCount, corpses,
    depth: maxDepth, chambers, galleries,
    returnRate: w.foragerReturnRate,
    breachAlarmPeak,
    loose: looseCount,
    consolidated: consolidatedCount,
    forageStarts: dStarts,
    foragePickups: dPickups,
    forageDeliveries: dDeliveries,
    forageBails: dBails,
  };
}

function indexOfQueen(c: Colony): number {
  for (let i = 0; i < c.count; i++) {
    if (c.state[i]! === STATE_QUEEN) return i;
  }
  return -1;
}

// ───────────────────────── medium / fine sample ─────────────────

function windowSample(
  sim: Sim, tracked: number[], label: 'M' | 'F', tick: number,
): void {
  const c = sim.colony;
  const w = sim.world;
  // Compact: one summary line, then one line per tracked ant.
  const states: number[] = new Array<number>(11).fill(0);
  let maxIdx = 0;
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s >= 0 && s < states.length) states[s] = (states[s] ?? 0) + 1;
    if (s !== STATE_DEAD) maxIdx = Math.max(maxIdx, i);
  }
  // Label order MUST match the state-constant indices in
  // colony.ts: WANDER=0, CARRY=1, REST=2, FORAGE=3, CARRY_FOOD=4,
  // DEAD=5, QUEEN=6, EGG=7, NECRO_CARRY=8, LARVA=9, PUPA=10.
  const summary = ['W', 'C', 'R', 'F', 'Cf', 'X', 'Q', 'E', 'N', 'L', 'P']
    .map((n, k) => `${n}${states[k]!}`)
    .filter((_, k) => states[k]! > 0)
    .join(' ');
  log(`  ${label} t=${tick.toString().padStart(7)} count=${maxIdx + 1} | ${summary}`);
  for (const i of tracked) {
    if (i >= c.count) continue;
    log(`    #${String(i).padStart(3)} ${shortStateName(c.state[i]!)} @(${c.posX[i]!.toFixed(1).padStart(5)},${c.posY[i]!.toFixed(1).padStart(5)}) ` +
      `E=${c.energy[i]!.toFixed(2)} cargo=${String(c.carryMoves[i]!).padStart(3)} stuck=${String(c.stuckTicks[i]!).padStart(3)} ` +
      `${zoneOf(w, c.posX[i]! | 0, c.posY[i]! | 0)}`);
  }
}

// ───────────────────────── trend table ─────────────────────────

function writeTrendTable(rows: TrendRow[]): void {
  log('\n══════════════════════════════ TRENDS (per-macro time series) ══════════════════════════════');
  log('     tick    Q   alive  dead   born  E/L/P     wE    lE    food  surf  corp  depth  chambers  galleries  retRate  breachPk    loose    wall   fStart  fPick  fDel  fBail');
  log('────────  ────  ─────  ────  ─────  ────────  ────  ────  ────  ────  ────  ─────  ────────  ─────────  ───────  ────────  ──────  ──────   ──────  ─────  ────  ─────');
  for (const r of rows) {
    log(
      `${r.tick.toLocaleString().padStart(8)}` +
      `  ${'1'.padStart(4)}` + // Q is always 1 alive in this scenario
      `  ${r.alive.toString().padStart(5)}` +
      `  ${r.dead.toString().padStart(4)}` +
      `  ${r.born.toString().padStart(5)}` +
      `  ${r.eggs}/${r.larvae}/${r.pupae}`.padEnd(10) +
      `  ${r.meanWorkerE.toFixed(2)}` +
      `  ${r.meanLarvaE.toFixed(2)}` +
      `  ${r.food.toString().padStart(4)}` +
      `  ${r.surfaceFood.toString().padStart(4)}` +
      `  ${r.corpses.toString().padStart(4)}` +
      `  ${r.depth.toString().padStart(5)}` +
      `  ${r.chambers.toString().padStart(8)}` +
      `  ${r.galleries.toString().padStart(9)}` +
      `  ${r.returnRate.toFixed(2).padStart(7)}` +
      `  ${r.breachAlarmPeak.toFixed(3).padStart(8)}` +
      `  ${r.loose.toString().padStart(6)}` +
      `  ${r.consolidated.toString().padStart(6)}` +
      `   ${r.forageStarts.toString().padStart(6)}` +
      `  ${r.foragePickups.toString().padStart(5)}` +
      `  ${r.forageDeliveries.toString().padStart(4)}` +
      `  ${r.forageBails.toString().padStart(5)}`,
    );
  }
}

// ───────────────────────── driver ─────────────────────────

describe('master long-running diagnostic', () => {
  it(`runs ${TOTAL_TICKS.toLocaleString()} ticks with macro/medium/fine triple-tier observation`, () => {
    fs.writeFileSync(LOG_PATH, '');
    log(`══════════════════════════════════════════════════════════════════════════════════════════`);
    log(` MASTER TEST  seed 0x${SEED.toString(16)}  world 300×400  ticks 0..${TOTAL_TICKS.toLocaleString()}`);
    log(`══════════════════════════════════════════════════════════════════════════════════════════`);
    log(`Macro every ${MACRO_INTERVAL.toLocaleString()} ticks (${Math.floor(TOTAL_TICKS / MACRO_INTERVAL)} total).`);
    log(`Around each macro: ${MEDIUM_HALF * 2} medium samples (±${MEDIUM_HALF * MEDIUM_SPACING / 1000}k, ${MEDIUM_SPACING}-tick spacing).`);
    log(`Around each macro: ${FINE_HALF * 2} fine samples (±${FINE_HALF * FINE_SPACING}, ${FINE_SPACING}-tick spacing).`);

    const sim = buildClaustralWorld(SEED);
    const lastReturnRate = { v: 0, t: 0 };
    const forageBaseline: ForageBaseline = { starts: 0, pickups: 0, deliveries: 0, bails: 0 };
    const trendRows: TrendRow[] = [];

    // Pre-compute all sample tick targets so the driver loop can
    // check each tick in O(1).
    type Sample = { tick: number; kind: 'macro' | 'medium' | 'fine'; macroIdx: number };
    const samples: Sample[] = [];
    const macroCount = Math.floor(TOTAL_TICKS / MACRO_INTERVAL);
    for (let m = 1; m <= macroCount; m++) {
      const macroTick = m * MACRO_INTERVAL;
      // Medium window: ±MEDIUM_HALF samples on each side, NOT
      // including the macro tick itself.
      for (let k = MEDIUM_HALF; k >= 1; k--) {
        const t = macroTick - k * MEDIUM_SPACING;
        if (t > 0 && t < TOTAL_TICKS) samples.push({ tick: t, kind: 'medium', macroIdx: m });
      }
      for (let k = 1; k <= MEDIUM_HALF; k++) {
        const t = macroTick + k * MEDIUM_SPACING;
        if (t > 0 && t < TOTAL_TICKS) samples.push({ tick: t, kind: 'medium', macroIdx: m });
      }
      // Fine window: ±FINE_HALF samples on each side.
      for (let k = FINE_HALF; k >= 1; k--) {
        const t = macroTick - k * FINE_SPACING;
        if (t > 0 && t < TOTAL_TICKS) samples.push({ tick: t, kind: 'fine', macroIdx: m });
      }
      for (let k = 1; k <= FINE_HALF; k++) {
        const t = macroTick + k * FINE_SPACING;
        if (t > 0 && t < TOTAL_TICKS) samples.push({ tick: t, kind: 'fine', macroIdx: m });
      }
      // Macro sample at the exact tick.
      samples.push({ tick: macroTick, kind: 'macro', macroIdx: m });
    }
    samples.sort((a, b) => a.tick - b.tick);

    // Drive the sim. Tracked-ant set is rebuilt at each macro and
    // re-used for the surrounding medium/fine windows that follow.
    let tracked: number[] = [];
    let lastMacroIdx = -1;
    let sampleIdx = 0;
    while (sim.world.tick < TOTAL_TICKS) {
      step(
        sim.world, sim.colony,
        sim.dig, sim.build,
        sim.rng, DEFAULT_PARAMS, undefined, HARVESTER,
        sim.trail, sim.alarm, sim.queen, sim.brood, sim.necro,
        sim.noEntry, sim.granary, sim.trunk,
        sim.breachAlarm, sim.entrance,
      );
      while (sampleIdx < samples.length && samples[sampleIdx]!.tick === sim.world.tick) {
        const s = samples[sampleIdx]!;
        if (s.kind === 'macro') {
          // Pick fresh tracked set BEFORE the macro snapshot so the
          // snapshot includes the picked ants.
          tracked = pickTrackedAnts(sim);
          const row = macroSnapshot(sim, lastReturnRate, forageBaseline, tracked);
          trendRows.push(row);
          lastMacroIdx = s.macroIdx;
        } else if (s.kind === 'medium') {
          // The medium samples that lie BEFORE a macro need a
          // tracked-set picked at the previous macro (or just-in-
          // time for the first run). For pre-first-macro samples
          // we pick fresh.
          if (lastMacroIdx !== s.macroIdx && tracked.length === 0) {
            tracked = pickTrackedAnts(sim);
          }
          windowSample(sim, tracked, 'M', sim.world.tick);
        } else {
          if (lastMacroIdx !== s.macroIdx && tracked.length === 0) {
            tracked = pickTrackedAnts(sim);
          }
          windowSample(sim, tracked, 'F', sim.world.tick);
        }
        sampleIdx++;
      }
    }

    writeTrendTable(trendRows);
    log(`\n══════════════════════════════════════════════════════════════════════════════════════════`);
    log(` run complete (final tick ${sim.world.tick.toLocaleString()})`);
    log(`══════════════════════════════════════════════════════════════════════════════════════════`);
    expect(trendRows.length).toBeGreaterThan(0);
  }, 7_200_000);
});
