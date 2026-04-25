// Long-horizon diag for the user complaint "nothing happens after a few
// in-game days". Runs the default-ish web scenario for N ticks at fixed
// seed, prints dig count per 5k-tick window and the colony state.
//
// Run with: npx vite-node scripts/diag.ts
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { ParticleSystem } from '../src/sim/particles';
import { RNG } from '../src/sim/rng';
import { CELL_SOIL, World } from '../src/sim/world';

const SEED = 0xc0ffee;
const TICKS = Number(process.env.TICKS ?? 60000) | 0;
const WIDTH = 200;
const HEIGHT = 120;
const ANTS = 24;

const rng = new RNG(SEED);
const world = new World(WIDTH, HEIGHT);
const surfaceRow = Math.floor(HEIGHT * 0.30);
const halfW = Math.max(6, Math.floor(WIDTH * 0.06));
const depth = Math.max(4, Math.floor(HEIGHT * 0.05));
world.generate(rng, surfaceRow, halfW, depth);

const colony = new Colony(ANTS);
const cx = world.width >> 1;
colony.spawnInRect(
  cx - halfW + 1, surfaceRow + 1, cx + halfW - 1, surfaceRow + depth,
  ANTS, rng, (x, y) => world.cells[world.index(x, y)] === 0,
);
const particles = new ParticleSystem(256);

let prevSoil = world.countSoil();
const WINDOW = 5000;
let windowDigs = 0;
for (let t = 1; t <= TICKS; t++) {
  step(world, colony, rng, DEFAULT_PARAMS, particles);
  const s = world.countSoil();
  if (s < prevSoil) windowDigs += prevSoil - s;
  prevSoil = s;
  if (t % WINDOW === 0) {
    let avgX = 0, avgY = 0;
    let stuck = 0;
    let wander = 0, carry = 0;
    let belowSurface = 0;
    for (let i = 0; i < colony.count; i++) {
      avgX += colony.posX[i]!;
      avgY += colony.posY[i]!;
      const dx = colony.posX[i]! - colony.prevX[i]!;
      const dy = colony.posY[i]! - colony.prevY[i]!;
      if (Math.hypot(dx, dy) < 0.01) stuck++;
      if (colony.state[i] === 0) wander++; else carry++;
      const ix = colony.posX[i]! | 0;
      const iy = colony.posY[i]! | 0;
      if (iy >= world.naturalSurface[ix]!) belowSurface++;
    }
    avgX /= colony.count;
    avgY /= colony.count;
    let surfaceSoil = 0;
    for (let x = 0; x < world.width; x++) {
      const sy = world.naturalSurface[x]!;
      // Count soil cells right around the natural surface; if these are
      // all dug, ants have to climb out through grain mounds to deposit.
      for (let y = sy; y < sy + 3 && y < world.height; y++) {
        if (world.cells[world.index(x, y)] === CELL_SOIL) surfaceSoil++;
      }
    }
    const totalDug = world.initialSoilCells - world.countSoil();
    const grains = world.countGrains();
    let maxMound = 0;
    for (let x = 0; x < world.width; x++) {
      if (world.mound[x]! > maxMound) maxMound = world.mound[x]!;
    }
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < colony.count; i++) {
      if (colony.posY[i]! < minY) minY = colony.posY[i]!;
      if (colony.posY[i]! > maxY) maxY = colony.posY[i]!;
    }
    console.log(
      `t=${String(t).padStart(6)}  dug/${WINDOW}=${String(windowDigs).padStart(4)}  total=${totalDug}  grains=${grains}  ` +
      `W${wander}/C${carry}  below=${belowSurface}  y=${minY.toFixed(1)}..${maxY.toFixed(1)}  ` +
      `maxMound=${maxMound}  surfaceSoil=${surfaceSoil}  stuck=${stuck}/${colony.count}  ` +
      `avg=(${avgX.toFixed(1)},${avgY.toFixed(1)})`,
    );
    windowDigs = 0;
  }
}
