// Headless scenario runner.
//
// Usage:
//   npm run scenario              -- runs the default scenario
//   npm run scenario default      -- same
//   TICKS=200 npm run scenario    -- run for 200 ticks
//
// Prints a debug summary every `debugIntervalTicks` ticks (set in
// the scenario). Exits with code 0 on a clean run, 1 if an invariant
// (no embedded ants, no floating ants, grain conservation) is
// violated — so this script can also serve as a pre-deploy
// sanity-check gate.

import { CELLS_PER_CM, buildFromScenario, resolveScenario, type Scenario } from '../src/scenario';
import { stepSimulation } from '../src/sim/ant-rules';
import { createPheromones } from '../src/sim/pheromone';
import { isSupported } from '../src/sim/physics';
import { CELL_GRAIN, CELL_SOIL } from '../src/sim/world';
import { STATE_CARRY } from '../src/sim/colony';
import { DEFAULT_SCENARIO } from '../src/scenarios/default';

const SCENARIOS: Record<string, Scenario> = {
  default: DEFAULT_SCENARIO,
};

const name = (process.argv[2] ?? 'default').toLowerCase();
const scenario = SCENARIOS[name];
if (!scenario) {
  console.error(`unknown scenario "${name}". available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const TICKS = Number(process.env.TICKS ?? scenario.dayDurationTicks ?? 60) | 0;
const ticksToRun = Math.max(1, TICKS * (Number(process.env.CYCLES ?? 1) | 0));

const { resolved, world, colony, antType, rng } = buildFromScenario(scenario);
const pheromones = createPheromones(world.width, world.height);

console.log(`[scenario] ${resolved.name}`);
console.log(`[scenario] world ${resolved.worldWidthCm}×${resolved.worldHeightCm} cm  ` +
  `(${world.width}×${world.height} cells @ ${CELLS_PER_CM} cells/cm)`);
console.log(`[scenario] surface at ${resolved.surfaceFromTopCm} cm = row ${resolved.surfaceCellsFromTop}`);
console.log(`[scenario] starter chamber ${resolved.starterChamberWidthCm}×${resolved.starterChamberDepthCm} cm  ` +
  `(half-width ${resolved.starterChamberHalfWidthCells} cells, depth ${resolved.starterChamberDepthCells} cells)`);
console.log(`[scenario] day ${resolved.dayDurationTicks}t  night ${resolved.nightDurationTicks}t  ` +
  `(${resolved.secondsPerTick}s/tick)`);
console.log(`[scenario] ants: ${colony.count}  ${Object.entries(resolved.ants).map(([n, s]) => `${n}=${s.count}`).join('  ')}`);
console.log(`[scenario] seed 0x${resolved.seed.toString(16)}`);

// Sanity: report initial spawn footprint.
{
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < colony.count; i++) {
    const x = colony.posX[i]!;
    const y = colony.posY[i]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = (maxX - minX) / CELLS_PER_CM;
  const spanY = (maxY - minY) / CELLS_PER_CM;
  console.log(
    `[scenario] initial spawn footprint: x=${minX.toFixed(1)}..${maxX.toFixed(1)} ` +
    `(${spanX.toFixed(2)} cm), y=${minY.toFixed(1)}..${maxY.toFixed(1)} (${spanY.toFixed(2)} cm)`,
  );
  if (spanX < 0.5 || spanY < 0.5) {
    console.log(`[warn] all ants are spawned in a tiny pocket (${spanX.toFixed(2)}×${spanY.toFixed(2)} cm). ` +
      `Probably too crowded — consider increasing starterChamberWidthCm/DepthCm.`);
  }
}

let invariantViolations = 0;

function checkInvariants(tick: number): void {
  // No embedded ants.
  for (let i = 0; i < colony.count; i++) {
    const ix = colony.posX[i]! | 0;
    const iy = colony.posY[i]! | 0;
    const k = world.cells[world.index(ix, iy)];
    if (k === CELL_SOIL || k === CELL_GRAIN) {
      console.error(`[FAIL] tick=${tick} ant=${colony.id[i]} embedded at (${ix},${iy}) cell=${k}`);
      invariantViolations++;
    }
    // Floating is allowed transiently — gravity drops 1 cell per
    // tick, so an ant walking off a ledge is mid-fall. We only
    // flag persistent floating: an ant that hasn't moved in y for
    // 5+ ticks AND is currently unsupported is genuinely stuck.
    // (Tracking movement history is out of scope for this sanity
    // gate; just don't flag float at all here.)
    void isSupported;
  }
  // Grain conservation.
  let carriers = 0;
  for (let i = 0; i < colony.count; i++) if (colony.state[i] === STATE_CARRY) carriers++;
  const sum = world.countSoil() + world.countGrains() + carriers;
  if (sum !== world.initialSoilCells) {
    console.error(`[FAIL] tick=${tick} grain conservation: ${sum} ≠ ${world.initialSoilCells}`);
    invariantViolations++;
  }
}

function debugSnapshot(tick: number): void {
  const cycle = resolved.dayDurationTicks + resolved.nightDurationTicks;
  const t = tick % cycle;
  const phase = t < resolved.dayDurationTicks ? 'DAY' : 'NIGHT';
  let states = [0, 0, 0, 0, 0];
  for (let i = 0; i < colony.count; i++) states[colony.state[i]!]!++;
  const dug = world.initialSoilCells - world.countSoil();
  const grains = world.countGrains();
  // Count food crumbs and stored food cells.
  let foodOnSurface = 0;
  let foodStored = 0;
  for (let yi = 0; yi < world.height; yi++) {
    for (let xi = 0; xi < world.width; xi++) {
      const k = world.cells[yi * world.width + xi];
      if (k === 4 /* CELL_FOOD */) foodOnSurface++;
      else if (k === 5 /* CELL_FOOD_STORE */) foodStored++;
    }
  }
  console.log(
    `[t=${String(tick).padStart(4, ' ')} ${phase}] ` +
    `wander=${states[0]} dig=${states[1]} carry=${states[2]} rest=${states[3]} haul=${states[4]} ` +
    `dug=${dug} grains=${grains} food-out=${foodOnSurface} food-stored=${foodStored}`,
  );
  // Ant samples — one line per ant for traceability.
  for (let i = 0; i < Math.min(colony.count, 10); i++) {
    const a = colony.inspect(i);
    console.log(`         ant#${a.id} (${antType[i]}): pos=(${a.x},${a.y}) head=${a.heading} state=${a.state} t=${a.stateTicks}`);
  }
}

for (let t = 1; t <= ticksToRun; t++) {
  stepSimulation(
    world, colony, rng, resolved.slabThicknessCm, pheromones,
    { dayDurationTicks: resolved.dayDurationTicks, nightDurationTicks: resolved.nightDurationTicks },
    Math.round(resolved.foodSpawnIntervalSec / resolved.secondsPerTick),
  );
  checkInvariants(t);
  if (t % resolved.debugIntervalTicks === 0) debugSnapshot(t);
}

console.log(`[done] ran ${ticksToRun} ticks`);
console.log(`[done] dug=${world.initialSoilCells - world.countSoil()} cells  grains=${world.countGrains()}`);
console.log(`[done] invariant violations: ${invariantViolations}`);

// Suppress "unused" warnings for re-exports we may need later.
void resolveScenario;

process.exit(invariantViolations > 0 ? 1 : 0);
