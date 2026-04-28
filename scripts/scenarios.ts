// Behavioral scenarios. Builds a production-like sim (all 10
// pheromone fields, brood lifecycle, foraging, WASM-SIMD when
// available) and reports periodic metrics so we can spot
// pathologies without watching a live render.
//
// Usage: npx tsx scripts/scenarios.ts [scenario] [ticks]
//
// Scenarios:
//   default   280×140, 50 ants
//   tall      150×250, 50 ants  (matches user's recent screenshots)
//   wide      480×100, 50 ants
//   founding  280×140, 5 ants   (small-colony viability test)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Colony, STATE_DEAD, STATE_EGG, STATE_LARVA, STATE_QUEEN } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone, attachPheromoneWasm } from '../src/sim/pheromone';
import { initPheromoneWasm } from '../src/sim/pheromone-wasm';
import { ParticleSystem } from '../src/sim/particles';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { CELL_AIR, World } from '../src/sim/world';

const SCENARIO = process.argv[2] || 'default';
const TICKS = Number(process.argv[3] || 30_000);
const SEED = Number(process.env.SEED || 42);

const cfg = (() => {
  switch (SCENARIO) {
    case 'tall':     return { w: 150, h: 250, ants: 50 };
    case 'wide':     return { w: 480, h: 100, ants: 50 };
    case 'founding': return { w: 280, h: 140, ants: 5 };
    default:         return { w: 280, h: 140, ants: 50 };
  }
})();

// WASM kernel.
const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(resolve(here, '../src/wasm/pheromone.wasm'));
const rt = await initPheromoneWasm(async () => wasmBytes.buffer.slice(
  wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength,
));
if (rt) {
  rt.uploadCells(new Uint8Array(cfg.w * cfg.h));
  attachPheromoneWasm(rt);
}

const rng = new RNG(SEED);
const world = new World(cfg.w, cfg.h);
world.foodCap = Math.max(50, cfg.ants * 10);
const surf = Math.floor(cfg.h * 0.30);
const halfW = Math.max(6, Math.floor(cfg.w * 0.06));
const depth = Math.max(4, Math.floor(cfg.h * 0.05));
world.generate(rng, surf, halfW, depth);

const dig = new Pheromone(cfg.w, cfg.h, 0.24, 0.999);
const build = new Pheromone(cfg.w, cfg.h, 0.40, 0.9995);
const trail = new Pheromone(cfg.w, cfg.h, 0.40, 0.999);
const alarm = new Pheromone(cfg.w, cfg.h, 0.50, 0.985);
const queen = new Pheromone(cfg.w, cfg.h, 0.10, 0.999, true);
const brood = new Pheromone(cfg.w, cfg.h, 0.20, 0.999, true);
const necro = new Pheromone(cfg.w, cfg.h, 0.30, 0.99);
const noEntry = new Pheromone(cfg.w, cfg.h, 0.05, 0.995);
const granary = new Pheromone(cfg.w, cfg.h, 0.10, 0.999);
const trunk = new Pheromone(cfg.w, cfg.h, 0.20, 0.9995);
const particles = new ParticleSystem(64);

const colony = new Colony(HARVESTER.maxColonySize);
const cx = cfg.w >> 1;
const surfHere = world.naturalSurface[cx]!;
const queenY = surfHere + 13;
const qIdx = colony.spawn(cx + 0.5, queenY + 0.5, 0, rng, DEFAULT_PARAMS);
if (qIdx >= 0) {
  colony.state[qIdx] = STATE_QUEEN;
  colony.energy[qIdx] = HARVESTER.maxEnergy;
}
const isAir = (x: number, y: number) =>
  world.cells[world.index(x, y)] === CELL_AIR;
colony.spawnInRect(cx - 2, surfHere, cx + 2, surfHere + 13,
  Math.min(cfg.ants, 25), rng, isAir, DEFAULT_PARAMS);
const remain = cfg.ants - Math.min(cfg.ants, 25);
if (remain > 0) {
  colony.spawnInRect(cx - 20, surfHere - 1, cx + 20, surfHere - 1,
    remain, rng, isAir, DEFAULT_PARAMS);
}

const QUEEN = qIdx;
const HEADER = (
  'tick    alive Q E L wkrs[W C R F Cf N] avgE   minE   '
  + 'qX  qY    dug  grns  food  sprt  surf'
);
console.log(`# scenario=${SCENARIO} ${cfg.w}×${cfg.h} ants=${cfg.ants} seed=${SEED} ticks=${TICKS}`);
console.log(`# ${HEADER}`);

const surfaceFood = (): { food: number; sprt: number; surfMound: number } => {
  let food = 0, sprt = 0, mound = 0;
  for (let x = 0; x < cfg.w; x++) {
    const sy = world.naturalSurface[x]!;
    for (let y = sy - 6; y < sy; y++) {
      if (y < 0) continue;
      const idx = y * cfg.w + x;
      if (world.food[idx]! > 0) food++;
      if (world.sprout[idx]! > 0) sprt++;
      if (world.cells[idx] === 2 /* GRAIN */) mound++;
    }
  }
  return { food, sprt, surfMound: mound };
};

const measure = (): string => {
  let alive = 0, q = 0, eggs = 0, larvae = 0;
  let nW = 0, nC = 0, nR = 0, nF = 0, nCF = 0, nN = 0;
  let energySum = 0, energyMin = Infinity, energyDenom = 0;
  for (let i = 0; i < colony.count; i++) {
    const s = colony.state[i]!;
    if (s === STATE_DEAD) continue;
    alive++;
    if (s === STATE_QUEEN) { q++; continue; }
    if (s === STATE_EGG) { eggs++; continue; }
    if (s === STATE_LARVA) { larvae++; continue; }
    if (s === 0) nW++;
    else if (s === 1) nC++;
    else if (s === 2) nR++;
    else if (s === 3) nF++;
    else if (s === 4) nCF++;
    else if (s === 8) nN++;
    energySum += colony.energy[i]!;
    energyMin = Math.min(energyMin, colony.energy[i]!);
    energyDenom++;
  }
  const avgE = energyDenom > 0 ? (energySum / energyDenom) : 0;
  const dug = world.initialSoilCells - world.countSoil() - world.countGrains();
  const grns = world.countGrains();
  const sf = surfaceFood();
  const qx = QUEEN >= 0 && colony.state[QUEEN] !== STATE_DEAD ? colony.posX[QUEEN]! : -1;
  const qy = QUEEN >= 0 && colony.state[QUEEN] !== STATE_DEAD ? colony.posY[QUEEN]! : -1;
  return [
    String(world.tick).padStart(7),
    String(alive).padStart(5),
    String(q), String(eggs).padStart(2), String(larvae).padStart(2),
    `[${[nW, nC, nR, nF, nCF, nN].map(n => String(n).padStart(2)).join(' ')}]`,
    avgE.toFixed(2).padStart(5),
    energyMin === Infinity ? '   --' : energyMin.toFixed(2).padStart(5),
    qx.toFixed(0).padStart(3), qy.toFixed(0).padStart(4),
    String(dug).padStart(5),
    String(grns).padStart(5),
    String(sf.food).padStart(5),
    String(sf.sprt).padStart(5),
    String(sf.surfMound).padStart(5),
  ].join(' ');
};

const REPORT_EVERY = Math.max(1000, Math.floor(TICKS / 30));
console.log(measure());
// Cumulative state-transition counters. Sample every tick so we
// can see whether transient states (FORAGE, CARRY_FOOD) are
// firing at all even if they're invisible at sample boundaries.
let totalForageEntries = 0;
let totalCarryFoodEntries = 0;
let totalNecroEntries = 0;
const prevState = new Uint8Array(colony.capacity);
prevState.set(colony.state.slice(0, colony.capacity));
for (let t = 0; t < TICKS; t++) {
  step(world, colony, dig, build, rng, DEFAULT_PARAMS, particles, HARVESTER,
    trail, alarm, queen, brood, necro, noEntry, granary, trunk);
  // Detect transitions into transient states.
  for (let i = 0; i < colony.count; i++) {
    const s = colony.state[i]!;
    const p = prevState[i]!;
    if (s !== p) {
      if (s === 3 /* FORAGE */) totalForageEntries++;
      else if (s === 4 /* CARRY_FOOD */) totalCarryFoodEntries++;
      else if (s === 8 /* NECRO_CARRY */) totalNecroEntries++;
      prevState[i] = s;
    }
  }
  if ((t + 1) % REPORT_EVERY === 0) console.log(measure());
}
console.log(`# final ${measure()}`);
console.log(`# transitions: forage=${totalForageEntries} carry_food=${totalCarryFoodEntries} necro=${totalNecroEntries}`);
