// 3-scenario comparison: CARRY_FOOD deposit-gate + stuck-bail variants.
// Each scenario builds an identical claustral world (same seed) and
// runs 200k ticks recording forage / energy / mortality metrics
// every 50k. The 500k observation showed forageReturnRate stuck at
// zero for the entire run — workers in CARRY_FOOD never close a
// successful round trip, the colony slowly starves, and the death
// wave starts ~t=400k. This harness isolates whether the granary
// deposit-gate is the cause and which fix recovers the loop.
//
// Scenarios:
//   A current   — granary gate + stuck-bail does NOT count return
//   B count-bail — granary gate + stuck-bail INCREMENTS return-rate
//   C no-gate    — gate disabled (legacy "deposit anywhere underground")
//
// Run with:
//   npx vitest run --config vitest.monitor.config.ts \
//     tests/_carry-food-compare.test.ts --testTimeout=1800000

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  Colony, STATE_DEAD, STATE_QUEEN, STATE_EGG, STATE_LARVA, STATE_PUPA,
  STATE_WANDER, STATE_CARRY, STATE_REST, STATE_FORAGE,
  STATE_CARRY_FOOD, STATE_NECRO_CARRY,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step, type SimParams } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { World } from '../src/sim/world';

const TICKS_PER_CHECKPOINT = 50_000;
const NUM_CHECKPOINTS = parseInt(process.env.COMPARE_CHECKPOINTS ?? '8', 10); // 400k default
const LOG_PATH = process.env.COMPARE_LOG ?? '/tmp/carry-food-compare.log';
function log(line: string): void { fs.appendFileSync(LOG_PATH, line + '\n'); }

interface Scenario {
  label: string;
  params: SimParams;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    label: 'A current   (granary-gate, bail does not count)',
    params: { ...DEFAULT_PARAMS },
  },
  {
    label: 'B count-bail (granary-gate, bail counts as return)',
    params: { ...DEFAULT_PARAMS, stuckBailCountsReturn: true },
  },
  {
    label: 'C no-gate    (legacy: deposit anywhere underground)',
    params: { ...DEFAULT_PARAMS, carryFoodDepositGate: 'always' },
  },
];

interface Checkpoint {
  tick: number;
  alive: number;
  dead: number;
  born: number;
  eggs: number;
  larvae: number;
  pupae: number;
  carryFood: number;
  forage: number;
  carry: number;
  meanWorkerE: number;
  meanLarvaE: number;
  food: number;
  corpses: number;
  returnRate: number;
  returnsThisCp: number;
}

function buildWorld(seed: number) {
  const rng = new RNG(seed);
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
  const SHAFT_DEPTH = 10, POCKET_HEIGHT = 4;
  const surfHere = world.naturalSurface[cx]!;
  const queenY = surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1;
  const qIdx = colony.spawn(cx + 0.5, queenY + 0.5, 0, rng, DEFAULT_PARAMS);
  if (qIdx >= 0) { colony.state[qIdx] = STATE_QUEEN; colony.energy[qIdx] = HARVESTER.maxEnergy; }
  return { rng, world, colony, dig, build, trail, alarm, queen, brood, necro, noEntry, granary, trunk };
}

function snapshot(world: World, c: Colony, lastReturn: { v: number; t: number }): Checkpoint {
  let alive = 0, dead = 0, eggs = 0, larvae = 0, pupae = 0;
  let carry = 0, carryFood = 0, forage = 0;
  let workerESum = 0, workerEN = 0;
  let larvaESum = 0, larvaEN = 0;
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD) { dead++; continue; }
    if (s === STATE_QUEEN) continue;
    if (s === STATE_EGG) { eggs++; continue; }
    if (s === STATE_LARVA) { larvae++; larvaESum += c.energy[i]!; larvaEN++; continue; }
    if (s === STATE_PUPA) { pupae++; continue; }
    alive++;
    workerESum += c.energy[i]!;
    workerEN++;
    if (s === STATE_CARRY) carry++;
    else if (s === STATE_CARRY_FOOD) carryFood++;
    else if (s === STATE_FORAGE) forage++;
    else if (s === STATE_WANDER || s === STATE_REST || s === STATE_NECRO_CARRY) {
      // counted in alive only
    }
  }
  let foodCount = 0, corpses = 0;
  for (let i = 0; i < world.food.length; i++) {
    if (world.food[i]! > 0) foodCount++;
    if (world.corpse[i]! > 0) corpses++;
  }
  const dt = world.tick - lastReturn.t;
  const returnsThisCp = dt > 0
    ? Math.max(0, world.foragerReturnRate - lastReturn.v * Math.pow(0.998, dt))
    : 0;
  lastReturn.v = world.foragerReturnRate;
  lastReturn.t = world.tick;
  return {
    tick: world.tick,
    alive, dead, born: world.totalBorn,
    eggs, larvae, pupae,
    carryFood, forage, carry,
    meanWorkerE: workerEN > 0 ? workerESum / workerEN : 0,
    meanLarvaE: larvaEN > 0 ? larvaESum / larvaEN : 0,
    food: foodCount, corpses,
    returnRate: world.foragerReturnRate,
    returnsThisCp,
  };
}

function fmt(c: Checkpoint): string {
  return `t=${c.tick.toString().padStart(7)} ` +
    `alive=${c.alive.toString().padStart(3)} dead=${c.dead.toString().padStart(2)} ` +
    `(born=${c.born.toString().padStart(3)}) ` +
    `E/L/P=${c.eggs}/${c.larvae}/${c.pupae} ` +
    `Cf=${c.carryFood.toString().padStart(2)} F=${c.forage.toString().padStart(2)} ` +
    `C=${c.carry.toString().padStart(2)} ` +
    `wE=${c.meanWorkerE.toFixed(2)} lE=${c.meanLarvaE.toFixed(2)} ` +
    `food=${c.food.toString().padStart(3)} corpses=${c.corpses.toString().padStart(2)} ` +
    `retRate=${c.returnRate.toFixed(2)} (~${c.returnsThisCp.toFixed(1)})`;
}

describe('CARRY_FOOD scenario comparison', () => {
  it(`runs ${NUM_CHECKPOINTS * TICKS_PER_CHECKPOINT} ticks across ${SCENARIOS.length} scenarios`, () => {
    fs.writeFileSync(LOG_PATH, '');
    log(`=== CARRY_FOOD A/B/C comparison — 200k ticks each, seed 0xc1ade57a1, world 400×400 ===\n`);
    const results: { label: string; rows: Checkpoint[] }[] = [];
    for (const scenario of SCENARIOS) {
      log(`\n--- ${scenario.label} ---`);
      const { rng, world, colony, dig, build, trail, alarm, queen, brood, necro, noEntry, granary, trunk } = buildWorld(0xc1ade57a1);
      const lastReturn = { v: 0, t: 0 };
      const rows: Checkpoint[] = [];
      for (let cp = 1; cp <= NUM_CHECKPOINTS; cp++) {
        const target = cp * TICKS_PER_CHECKPOINT;
        while (world.tick < target) {
          step(world, colony, dig, build, rng, scenario.params, undefined, HARVESTER,
            trail, alarm, queen, brood, necro, noEntry, granary, trunk);
        }
        const cpData = snapshot(world, colony, lastReturn);
        rows.push(cpData);
        log(`  ${fmt(cpData)}`);
      }
      results.push({ label: scenario.label, rows });
    }
    // Side-by-side summary at final checkpoint.
    log(`\n=== Final-state summary (t=${NUM_CHECKPOINTS * TICKS_PER_CHECKPOINT}) ===`);
    log(`scenario`.padEnd(58) + ' ' + 'alive  dead  born   wE    lE   food  retRate');
    for (const r of results) {
      const final = r.rows[r.rows.length - 1]!;
      log(r.label.padEnd(58) + ' ' +
        final.alive.toString().padStart(5) + ' ' +
        final.dead.toString().padStart(5) + ' ' +
        final.born.toString().padStart(5) + '  ' +
        final.meanWorkerE.toFixed(2) + '  ' +
        final.meanLarvaE.toFixed(2) + '  ' +
        final.food.toString().padStart(4) + '  ' +
        final.returnRate.toFixed(2));
    }
    log(`\n=== run complete ===`);
    expect(results.length).toBe(SCENARIOS.length);
  }, 1_800_000);
});
