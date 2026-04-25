import { appendFileSync, writeFileSync } from 'fs';
import { buildFromScenario, CELLS_PER_CM } from '../src/scenario';
import { stepSimulation } from '../src/sim/ant-rules';
import { createPheromones } from '../src/sim/pheromone';
import { DEFAULT_SCENARIO } from '../src/scenarios/default';

// Synchronous append writer — Node's stdout/stderr is block-buffered
// when piped, which means progress lines don't appear until exit.
// We write to a side-channel file via fs (sync, unbuffered) so a
// tail -F watcher can stream lines in near real-time.
const OUT = process.env.DIAG_OUT ?? '/tmp/diag-stream.log';
writeFileSync(OUT, '');
const log = (s: string) => { appendFileSync(OUT, s + '\n'); console.log(s); };

// Use a fixed seed so I can show you the exact run.
const SEED = 0xc0ffee;
const { resolved, world, colony, rng } = buildFromScenario({ ...DEFAULT_SCENARIO, seed: SEED });
const ph = createPheromones(world.width, world.height);
const cyc = { dayDurationTicks: resolved.dayDurationTicks, nightDurationTicks: resolved.nightDurationTicks };
// Override food cadence at the env level so I can A/B test it.
// FOOD_EVERY_TICKS=0 disables food entirely.
const envFood = process.env.FOOD_EVERY_TICKS;
const foodEvery = envFood !== undefined
  ? (envFood === '0' ? 0 : Number(envFood))
  : Math.round(resolved.foodSpawnIntervalSec / resolved.secondsPerTick);

let prevSoil = world.countSoil();
let totalDigs = 0;
const window = 30000;
let windowDigs = 0;
let firstDigTick = -1;
let lastDigTick = -1;
// Track HAUL transitions so I can see whether ants ever pick up
// food and ever finish a haul. State changes don't have a built-in
// counter — observe by sampling state[i] each tick and counting
// edges into / out of HAUL.
const STATE_HAUL_VAL = 4;
let totalHaulPickups = 0;
let totalHaulDeposits = 0;
const prevState = new Uint8Array(colony.count);
for (let i = 0; i < colony.count; i++) prevState[i] = colony.state[i];

// Snapshot of original chamber boundary cells so we know which
// soil cells were the V's perimeter at t=0.
const initialV: Array<{ x: number; y: number }> = [];
{
  const cx = world.width >> 1;
  const halfW = resolved.starterChamberHalfWidthCells;
  for (let dx = -halfW - 2; dx <= halfW + 2; dx++) {
    const x = cx + dx;
    if (x < 0 || x >= world.width) continue;
    for (let y = 0; y < world.height; y++) {
      if (world.cells[y * world.width + x] === 1 /* SOIL */) {
        // Is this cell adjacent to the chamber air? If so it's V wall.
        const idx = y * world.width + x;
        const nbAir =
          (y > 0 && world.cells[idx - world.width] === 0) ||
          (y < world.height - 1 && world.cells[idx + world.width] === 0) ||
          (x > 0 && world.cells[idx - 1] === 0) ||
          (x < world.width - 1 && world.cells[idx + 1] === 0);
        if (nbAir) initialV.push({ x, y });
        break; // only need top-most soil; that's the chamber lip
      }
    }
  }
}
const vCellSet = new Set(initialV.map(c => c.y * world.width + c.x));

for (let t = 1; t <= 300000; t++) {
  stepSimulation(world, colony, rng, resolved.slabThicknessCm, ph, cyc, foodEvery);
  const s = world.countSoil();
  if (s < prevSoil) {
    totalDigs += prevSoil - s;
    windowDigs += prevSoil - s;
    if (firstDigTick < 0) firstDigTick = t;
    lastDigTick = t;
  }
  prevSoil = s;
  for (let i = 0; i < colony.count; i++) {
    const cur = colony.state[i];
    const prv = prevState[i];
    if (cur === STATE_HAUL_VAL && prv !== STATE_HAUL_VAL) totalHaulPickups++;
    if (prv === STATE_HAUL_VAL && cur !== STATE_HAUL_VAL) totalHaulDeposits++;
    prevState[i] = cur;
  }

  if (t % window === 0) {
    let states = [0, 0, 0, 0, 0];
    let belowSurface = 0;
    let wanderBelow = 0;
    for (let i = 0; i < colony.count; i++) {
      states[colony.state[i]]++;
      const ix = colony.posX[i] | 0;
      const iy = colony.posY[i] | 0;
      const sy = world.naturalSurface[ix];
      if (iy >= sy) {
        belowSurface++;
        if (colony.state[i] === 0 /* WANDER */) wanderBelow++;
      }
    }
    let vDug = 0;
    for (const idx of vCellSet) if (world.cells[idx] !== 1) vDug++;
    let avgFromHome = 0;
    for (let i = 0; i < colony.count; i++) avgFromHome += Math.hypot(colony.homeX[i], colony.homeY[i]);
    avgFromHome /= colony.count;
    let foodOnSurf = 0, foodStored = 0;
    for (let yi = 0; yi < world.height; yi++) {
      for (let xi = 0; xi < world.width; xi++) {
        const k = world.cells[yi * world.width + xi];
        if (k === 4) foodOnSurf++;
        else if (k === 5) foodStored++;
      }
    }
    log(
      `t=${String(t).padStart(6)} digs/${window}=${String(windowDigs).padStart(4)}  total=${String(totalDigs).padStart(5)}  ` +
      `W${states[0]}/D${states[1]}/C${states[2]}/R${states[3]}/H${states[4]}  ` +
      `below=${belowSurface} wB=${wanderBelow}  ` +
      `V-perim=${vDug}/${vCellSet.size}  avgHome=${(avgFromHome/CELLS_PER_CM).toFixed(2)}cm  ` +
      `food=${foodOnSurf}/${foodStored}  haul-in/out=${totalHaulPickups}/${totalHaulDeposits}`,
    );
    windowDigs = 0;
  }
}

log(`first dig at tick ${firstDigTick}, last dig at tick ${lastDigTick}`);
