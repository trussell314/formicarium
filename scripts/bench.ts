// Performance bench. Builds a deterministic sim, warms up, then
// times N ticks and reports total / per-tick stats. Use as the
// baseline measurement for any optimization.
//
// Run with: npx tsx scripts/bench.ts
// Env vars:
//   TICKS         number of timed ticks (default 5000)
//   WARMUP        warmup ticks before timing (default 1000)
//   WIDTH/HEIGHT  world dimensions (default 480/270 — MEDIUM budget)
//   ANTS          starter colony (default 500)
//   SEED          rng seed (default 42)
//
// Repeatability is non-negotiable — the bench MUST be
// bit-identical across runs at the same seed so optimizations can
// be A/B compared. No Date.now(), no Math.random() outside RNG.
//
// Output: a tab-separated summary plus per-tick percentiles.

import {
  Colony, STATE_QUEEN,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { CELL_AIR, World } from '../src/sim/world';

const TICKS = Number(process.env.TICKS || 5000);
const WARMUP = Number(process.env.WARMUP || 1000);
const W = Number(process.env.WIDTH || 480);
const H = Number(process.env.HEIGHT || 270);
const ANTS = Number(process.env.ANTS || 500);
const SEED = Number(process.env.SEED || 42);

const rng = new RNG(SEED);
const world = new World(W, H);
world.foodCap = ANTS * 10;
const surfaceRow = Math.floor(H * 0.30);
world.generate(rng, surfaceRow, Math.max(6, Math.floor(W * 0.06)), Math.max(4, Math.floor(H * 0.05)));

// All ten pheromone fields with their main.ts default tuning.
const dig = new Pheromone(W, H, 0.24, 0.999);
const buildField = new Pheromone(W, H, 0.40, 0.9995);
const trail = new Pheromone(W, H, 0.40, 0.999);
const alarm = new Pheromone(W, H, 0.50, 0.985);
const queen = new Pheromone(W, H, 0.10, 0.999);
const brood = new Pheromone(W, H, 0.20, 0.999);
const necro = new Pheromone(W, H, 0.30, 0.99);
const noEntry = new Pheromone(W, H, 0.05, 0.995);
const granary = new Pheromone(W, H, 0.10, 0.999);
const trunk = new Pheromone(W, H, 0.20, 0.9995);

const colony = new Colony(HARVESTER.maxColonySize);
const cx = W >> 1;
const surfHere = world.naturalSurface[cx]!;
const queenIdx = colony.spawn(cx + 0.5, surfHere + 13.5, 0, rng, DEFAULT_PARAMS);
if (queenIdx >= 0) {
  colony.state[queenIdx] = STATE_QUEEN;
  colony.stateTicks[queenIdx] = 0;
  colony.energy[queenIdx] = HARVESTER.maxEnergy;
}
const isAir = (x: number, y: number): boolean =>
  world.cells[world.index(x, y)] === CELL_AIR;
colony.spawnInRect(cx - 12, surfHere - 1, cx + 12, surfHere - 1, ANTS, rng, isAir, DEFAULT_PARAMS);

function tickOnce() {
  step(
    world, colony, dig, buildField, rng, DEFAULT_PARAMS, undefined, HARVESTER,
    trail, alarm, queen, brood, necro, noEntry, granary, trunk,
  );
}

console.error(`bench: warmup=${WARMUP} ticks=${TICKS} world=${W}×${H} ants=${ANTS} seed=${SEED}`);
console.error(`bench: warming up...`);
for (let t = 0; t < WARMUP; t++) tickOnce();

const initialSoil = world.initialSoilCells;
const samples: number[] = new Array(TICKS);
const start = process.hrtime.bigint();
for (let t = 0; t < TICKS; t++) {
  const t0 = process.hrtime.bigint();
  tickOnce();
  const t1 = process.hrtime.bigint();
  samples[t] = Number(t1 - t0); // ns
}
const end = process.hrtime.bigint();
const totalNs = Number(end - start);
const totalMs = totalNs / 1_000_000;

samples.sort((a, b) => a - b);
const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]! / 1_000_000;

// Grain conservation invariant — fail loudly if any optimization
// silently broke it.
const dug = initialSoil - world.countSoil();
let carriers = 0;
for (let i = 0; i < colony.count; i++) {
  const s = colony.state[i];
  if (s === 1 /* CARRY */) carriers++;
}
const conserved = dug === world.countGrains() + carriers + world.wearLost;

console.log(`total_ms\t${totalMs.toFixed(2)}`);
console.log(`ticks\t${TICKS}`);
console.log(`ms_per_tick_mean\t${(totalMs / TICKS).toFixed(4)}`);
console.log(`ticks_per_sec\t${((TICKS * 1000) / totalMs).toFixed(0)}`);
console.log(`p50_ms\t${p(0.50).toFixed(4)}`);
console.log(`p95_ms\t${p(0.95).toFixed(4)}`);
console.log(`p99_ms\t${p(0.99).toFixed(4)}`);
console.log(`max_ms\t${(samples[samples.length - 1]! / 1_000_000).toFixed(4)}`);
console.log(`final_count\t${colony.count}`);
console.log(`final_tick\t${world.tick}`);
console.log(`final_dug\t${dug}`);
console.log(`final_grains\t${world.countGrains()}`);
console.log(`grain_conservation_ok\t${conserved}`);
if (!conserved) {
  console.error(`bench: GRAIN CONSERVATION FAILED — dug=${dug}, grains=${world.countGrains()}, carriers=${carriers}, wearLost=${world.wearLost}`);
  process.exit(2);
}
