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
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';

const TICKS_PER_CHECKPOINT = 30_000;
const NUM_CHECKPOINTS = 10; // 300k ticks — early-game / starvation-onset window
const LOG_PATH = process.env.MONITOR_LOG ?? '/tmp/lateral-monitor.log';
function log(line: string): void { fs.appendFileSync(LOG_PATH, line + '\n'); }

function buildClaustralWorld(seed: number) {
  const rng = new RNG(seed);
  const world = new World(280, 140);
  world.foodCap = 1;
  world.generate(rng, Math.floor(140 * 0.30), Math.max(6, Math.floor(280 * 0.06)), 7);
  const dig = new Pheromone(280, 140, 0.24, 0.999);
  const build = new Pheromone(280, 140, 0.40, 0.9995);
  const trail = new Pheromone(280, 140, 0.40, 0.999);
  const alarm = new Pheromone(280, 140, 0.50, 0.985);
  const queen = new Pheromone(280, 140, 0.10, 0.999, true);
  const brood = new Pheromone(280, 140, 0.20, 0.999, true);
  const necro = new Pheromone(280, 140, 0.30, 0.99);
  const noEntry = new Pheromone(280, 140, 0.05, 0.995);
  const granary = new Pheromone(280, 140, 0.10, 0.999);
  const trunk = new Pheromone(280, 140, 0.20, 0.9995);
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
  let grains = 0, foodCount = 0, soilCount = 0, corpses = 0;
  for (let i = 0; i < world.cells.length; i++) {
    const k = world.cells[i]!;
    if (k === CELL_SOIL) soilCount++;
    else if (k === CELL_GRAIN) grains++;
    if (world.food[i]! > 0) foodCount++;
    if (world.corpse[i]! > 0) corpses++;
  }
  const dug = world.initialSoilCells - soilCount;
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
  log(
    `\n${label} t=${world.tick.toLocaleString()}\n` +
    `  pop:    Q${queens} ${eggs}E ${larvae}L ${pupae}P workers=${alive} dead=${dead} (born=${world.totalBorn} died=${world.totalDied})\n` +
    `  states: W${wander} C${carry} R${rest} F${forage} Cf${carryFood} N${necro}\n` +
    `  energy: queen=${queenEnergy.toFixed(2)} workers=${meanWorkerE.toFixed(2)} larvae=${meanLarvaE.toFixed(2)} ` +
      `[C=${(cN > 0 ? cE / cN : 0).toFixed(2)} F=${(fN > 0 ? fE / fN : 0).toFixed(2)} Cf=${(cfN > 0 ? cfE / cfN : 0).toFixed(2)} W=${(wN > 0 ? wE / wN : 0).toFixed(2)}]\n` +
    `  nest:   dug=${dug} grains=${grains} food=${foodCount} corpses=${corpses} depth=${maxDepth}\n` +
    `  depth-hist (above|d1|d2|d3|d4|d5): ${depthBins.join('|')}\n` +
    `  food-near-worker: ${foodWithWorkerNearby}/${foodCount}\n` +
    `  stuck-CARRY (>=2000t): ${stuckCarry}/${carry}\n` +
    `  forage: returnRate=${world.foragerReturnRate.toFixed(3)} (~${returnsThisCp.toFixed(1)} new returns since last)`,
  );
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
          } else if (k === CELL_GRAIN) {
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
            else if (k === CELL_GRAIN) line += '#';
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
