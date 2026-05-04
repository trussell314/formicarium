// Top-of-tunnel observation. The user reports new workers loitering
// at the top of the shaft without doing useful work in the t=85k-100k
// window. Run the default scenario; from t=85,000, snapshot every
// 500 ticks until t=100,000 (30 checkpoints). For each snapshot,
// focus on workers within ±10 columns of the entrance shaft and
// within 15 rows below the natural surface — log per-state counts
// and dump a few sample ants with full per-individual state so we
// can see what they're "thinking".

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

const SEED = 0xc1ade57a1;
const START_TICK = 85_000;
const END_TICK = 100_000;
const SNAPSHOT_INTERVAL = 500;
const COLUMN_RADIUS = 10;   // ±10 columns from entrance
const DEPTH_BELOW_SURF = 15; // rows below natural surface to inspect
const LOG_PATH = process.env.OBS_LOG ?? '/tmp/top-of-tunnel.log';
function log(line: string): void { fs.appendFileSync(LOG_PATH, line + '\n'); }

function buildClaustralWorld(seed: number) {
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

function cellTag(world: World, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return 'OOB';
  const idx = y * world.width + x;
  const k = world.cells[idx]!;
  if (k === CELL_AIR) {
    const surf = world.naturalSurface[x]!;
    return y < surf ? 'sky' : 'air';
  }
  if (k === CELL_SOIL) {
    return isLoose(world, idx) ? 'grain' : 'SOIL';
  }
  return '?';
}

function snapshotTopOfTunnel(world: World, c: Colony, sim: ReturnType<typeof buildClaustralWorld>): void {
  const ecx = world.width >> 1;
  const surf = world.naturalSurface[ecx]!;
  const minX = ecx - COLUMN_RADIUS;
  const maxX = ecx + COLUMN_RADIUS;
  const minY = surf - 2; // include the row just above surface (mound)
  const maxY = surf + DEPTH_BELOW_SURF;
  const counts: Record<string, number> = {};
  const sampled: number[] = [];
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i]!;
    if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA
        || s === STATE_PUPA || s === STATE_QUEEN) continue;
    const ix = c.posX[i]! | 0;
    const iy = c.posY[i]! | 0;
    if (ix < minX || ix > maxX || iy < minY || iy > maxY) continue;
    const name = stateName(s);
    counts[name] = (counts[name] ?? 0) + 1;
    sampled.push(i);
  }
  const total = sampled.length;
  const stateLine = Object.entries(counts)
    .map(([n, v]) => `${n}=${v}`)
    .join(' ');
  log(`\nt=${world.tick.toLocaleString().padStart(8)} [top-of-tunnel n=${total}] ${stateLine || '(empty)'}`);
  // Sample up to 6 ants for full inspection — bias toward the most
  // interesting (CARRY first, then anything else).
  const ranked = sampled.slice().sort((a, b) => {
    const sa = c.state[a]!, sb = c.state[b]!;
    const order = (s: number): number => s === STATE_CARRY ? 0
      : s === STATE_CARRY_FOOD ? 1
      : s === STATE_FORAGE ? 2
      : s === STATE_WANDER ? 3
      : s === STATE_REST ? 4 : 5;
    return order(sa) - order(sb);
  });
  const sample = ranked.slice(0, 6);
  for (const i of sample) {
    const ix = c.posX[i]! | 0;
    const iy = c.posY[i]! | 0;
    const dCenter = ix - ecx;
    const depth = iy - surf;
    const px = c.posX[i]!.toFixed(1).padStart(5);
    const py = c.posY[i]!.toFixed(1).padStart(5);
    const head = ((c.heading[i]! * 180 / Math.PI) | 0).toString().padStart(4);
    const e = c.energy[i]!.toFixed(2);
    const stateTicks = c.stateTicks[i]!;
    const stuckTicks = c.stuckTicks[i]!;
    const carryMoves = c.carryMoves[i]!;
    // 8-neighbourhood cell tags.
    const nbrs: string[] = [];
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      nbrs.push(cellTag(world, ix + dx, iy + dy));
    }
    // Pheromones at the ant's cell.
    const dig = sim.dig.sample(ix, iy);
    const build = sim.build.sample(ix, iy);
    const trail = sim.trail.sample(ix, iy);
    const alarm = sim.alarm.sample(ix, iy);
    const queen = sim.queen.sample(ix, iy);
    const brood = sim.brood.sample(ix, iy);
    const granary = sim.granary.sample(ix, iy);
    const trunk = sim.trunk.sample(ix, iy);
    log(`  #${String(i).padStart(3)} ${stateName(c.state[i]!).padEnd(6)} @(${px},${py}) ` +
      `dx=${dCenter.toString().padStart(3)} d${depth.toString().padStart(2)} ` +
      `h=${head}° E=${e} cellAt=${cellTag(world, ix, iy).padEnd(5)} ` +
      `st=${stateTicks.toString().padStart(4)} stuck=${stuckTicks.toString().padStart(3)} ` +
      `cargo=${carryMoves.toString().padStart(3)}`);
    log(`         nbrs(N,W,E,S,NW,NE,SW,SE)=[${nbrs.join(',')}]`);
    log(`         pher: dig=${dig.toFixed(3)} build=${build.toFixed(3)} ` +
      `trail=${trail.toFixed(3)} alarm=${alarm.toFixed(3)} ` +
      `queen=${queen.toFixed(3)} brood=${brood.toFixed(3)} ` +
      `granary=${granary.toFixed(3)} trunk=${trunk.toFixed(3)}`);
  }
}

describe('top-of-tunnel observation', () => {
  it(`runs default scenario, snapshots top-of-tunnel every ${SNAPSHOT_INTERVAL} ticks from t=${START_TICK} to t=${END_TICK}`, () => {
    fs.writeFileSync(LOG_PATH, '');
    log(`=== top-of-tunnel observation, seed 0x${SEED.toString(16)}, world 400×400 ===`);
    log(`Window: t=${START_TICK}..${END_TICK}, snapshot every ${SNAPSHOT_INTERVAL} ticks`);
    log(`Region: column ${(0x190 >> 1) - COLUMN_RADIUS}..${(0x190 >> 1) + COLUMN_RADIUS}, ` +
      `surface±${DEPTH_BELOW_SURF}`);
    const sim = buildClaustralWorld(SEED);
    const { rng, world, colony, dig, build, trail, alarm, queen, brood, necro, noEntry, granary, trunk } = sim;
    // Fast-forward to start tick.
    while (world.tick < START_TICK) {
      step(world, colony, dig, build, rng, DEFAULT_PARAMS, undefined, HARVESTER,
        trail, alarm, queen, brood, necro, noEntry, granary, trunk);
    }
    // Snapshot loop.
    let nextSnap = START_TICK;
    snapshotTopOfTunnel(world, colony, sim);
    while (world.tick < END_TICK) {
      step(world, colony, dig, build, rng, DEFAULT_PARAMS, undefined, HARVESTER,
        trail, alarm, queen, brood, necro, noEntry, granary, trunk);
      if (world.tick >= nextSnap + SNAPSHOT_INTERVAL) {
        nextSnap = world.tick;
        snapshotTopOfTunnel(world, colony, sim);
      }
    }
    log(`\n=== run complete (final tick ${world.tick}) ===`);
    expect(world.tick).toBeGreaterThan(END_TICK - 1);
  }, 1_800_000);
});
