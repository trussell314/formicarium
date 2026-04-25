// Long-horizon diag for the user complaint "nothing happens after a few
// in-game days". Runs the default-ish web scenario for N ticks at fixed
// seed, prints dig count per 5k-tick window and the colony state.
//
// Run with: npx vite-node scripts/diag.ts
//
// Structural metrics:
//   perim:area  high values mean tunnel-like (lots of edges per dug
//               cell), low values mean blob-like
//   tips        soil cells with exactly 1 air neighbour — count of
//               active tunnel fronts
//   bbox        smallest rectangle containing all dug cells
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { ParticleSystem } from '../src/sim/particles';
import { RNG } from '../src/sim/rng';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

const SEED = 0xc0ffee;
const TICKS = Number(process.env.TICKS ?? 60000) | 0;
const WIDTH = Number(process.env.WIDTH ?? 200) | 0;
const HEIGHT = Number(process.env.HEIGHT ?? 120) | 0;
const ANTS = Number(process.env.ANTS ?? 24) | 0;

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

    // Structural metrics over the dug region.
    let dugArea = 0, perim = 0, tips = 0;
    let bbMinX = Infinity, bbMaxX = -Infinity, bbMinY = Infinity, bbMaxY = -Infinity;
    for (let y = 1; y < world.height - 1; y++) {
      for (let x = 1; x < world.width - 1; x++) {
        const k = world.cells[y * world.width + x];
        if (k === CELL_AIR && y >= world.naturalSurface[x]!) {
          // Below-surface air cell — count it as dug
          dugArea++;
          if (x < bbMinX) bbMinX = x;
          if (x > bbMaxX) bbMaxX = x;
          if (y < bbMinY) bbMinY = y;
          if (y > bbMaxY) bbMaxY = y;
        }
        if (k === CELL_SOIL) {
          // Count air neighbours
          let nA = 0;
          if (world.cells[y * world.width + x - 1] === CELL_AIR) nA++;
          if (world.cells[y * world.width + x + 1] === CELL_AIR) nA++;
          if (world.cells[(y - 1) * world.width + x] === CELL_AIR) nA++;
          if (world.cells[(y + 1) * world.width + x] === CELL_AIR) nA++;
          if (nA > 0) perim++;
          // Count "tunnel tips": this soil cell has exactly ONE air
          // neighbour, meaning it sits at the end of a corridor.
          if (nA === 1) tips++;
        }
      }
    }
    const perimRatio = dugArea > 0 ? (perim / dugArea).toFixed(2) : 'n/a';
    const bbW = bbMaxX > bbMinX ? bbMaxX - bbMinX + 1 : 0;
    const bbH = bbMaxY > bbMinY ? bbMaxY - bbMinY + 1 : 0;
    console.log(
      `t=${String(t).padStart(6)}  dug/${WINDOW}=${String(windowDigs).padStart(4)}  total=${totalDug}  grains=${grains}  ` +
      `W${wander}/C${carry}  below=${belowSurface}  y=${minY.toFixed(1)}..${maxY.toFixed(1)}  ` +
      `maxMound=${maxMound}  surfaceSoil=${surfaceSoil}  stuck=${stuck}/${colony.count}  ` +
      `avg=(${avgX.toFixed(1)},${avgY.toFixed(1)})  ` +
      `area=${dugArea} perim:area=${perimRatio} tips=${tips} bbox=${bbW}x${bbH}`,
    );
    windowDigs = 0;
  }
}
