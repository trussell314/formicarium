import { buildFromScenario, CELLS_PER_CM } from '../src/scenario';
import { stepSimulation } from '../src/sim/ant-rules';
import { createPheromones } from '../src/sim/pheromone';
import { DEFAULT_SCENARIO } from '../src/scenarios/default';

// Use a fixed seed so I can show you the exact run.
const SEED = 0xc0ffee;
const { resolved, world, colony, rng } = buildFromScenario({ ...DEFAULT_SCENARIO, seed: SEED });
const ph = createPheromones(world.width, world.height);
const cyc = { dayDurationTicks: resolved.dayDurationTicks, nightDurationTicks: resolved.nightDurationTicks };
const foodEvery = Math.round(resolved.foodSpawnIntervalSec / resolved.secondsPerTick);

let prevSoil = world.countSoil();
let totalDigs = 0;
const window = 30000;
let windowDigs = 0;
let firstDigTick = -1;
let lastDigTick = -1;

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

  if (t % window === 0) {
    let states = [0, 0, 0, 0, 0];
    for (let i = 0; i < colony.count; i++) states[colony.state[i]]++;
    // How many of the original V-perimeter cells have been dug since t=0?
    let vDug = 0;
    for (const idx of vCellSet) if (world.cells[idx] !== 1) vDug++;
    let avgFromHome = 0;
    for (let i = 0; i < colony.count; i++) avgFromHome += Math.hypot(colony.homeX[i], colony.homeY[i]);
    avgFromHome /= colony.count;
    console.log(
      `t=${String(t).padStart(6)} digs/${window}=${String(windowDigs).padStart(4)}  total=${String(totalDigs).padStart(5)}  ` +
      `W${states[0]}/D${states[1]}/C${states[2]}/R${states[3]}/H${states[4]}  ` +
      `V-perim dug=${vDug}/${vCellSet.size}  avgHome=${(avgFromHome/CELLS_PER_CM).toFixed(2)}cm`,
    );
    windowDigs = 0;
  }
}

console.log(`first dig at tick ${firstDigTick}, last dig at tick ${lastDigTick}`);
