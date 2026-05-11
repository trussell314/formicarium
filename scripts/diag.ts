// Long-horizon diag for headless sim verification.
//
// Run with: npx vite-node scripts/diag.ts
// Env vars: TICKS, WIDTH, HEIGHT, ANTS, DUMP_EVERY (every N ticks
// write a PPM image of the world to /tmp/formicarium-NNNN.ppm so
// you can flip through the evolution after the run).
//
// Structural metrics in the per-window log line:
//   perim:area  high = tunnel-like (lots of edges per dug cell),
//               low  = blob-like
//   tips        soil cells with exactly 1 air neighbour — count of
//               active tunnel fronts
//   bbox        smallest rectangle containing all dug cells
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import {
  Colony, STATE_CARRY, STATE_CARRY_FOOD, STATE_DEAD, STATE_EGG,
  STATE_FORAGE, STATE_QUEEN, STATE_REST, STATE_WANDER,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';

const SEED = Number(process.env.SEED ?? 0xc0ffee) | 0;
const TICKS = Number(process.env.TICKS ?? 60000) | 0;
const WIDTH = Number(process.env.WIDTH ?? 400) | 0;
const HEIGHT = Number(process.env.HEIGHT ?? 240) | 0;
const ANTS = Number(process.env.ANTS ?? 24) | 0;
const DUMP_EVERY = Number(process.env.DUMP_EVERY ?? 0) | 0;
const DUMP_DIR = process.env.DUMP_DIR ?? '/tmp';

/**
 * Write a binary P6 PPM snapshot of the world. Color scheme roughly
 * mirrors what the renderer paints:
 *   sky           — slate blue
 *   tunnel air    — pale loamy brown (lighter than soil so you can
 *                   tell at a glance what's been excavated)
 *   grass row     — green
 *   soil          — brown gradient by depth
 *   grain (mound) — sandy
 *   ant           — black 1-pixel dot
 * Open with any image viewer (preview, eog, feh, etc.) — most also
 * support stepping through a numbered sequence so you can scrub
 * through the evolution.
 */
// CRC32 table for the PNG chunk checksums.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/**
 * Write a minimal PNG (color type 2 = RGB, no alpha, no interlace).
 * `rgb` is width*height*3 bytes. Pure stdlib — uses zlib's deflate
 * for the IDAT body and a hand-rolled CRC32 for chunk checksums.
 */
function writePNG(path: string, width: number, height: number, rgb: Buffer): void {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // Filtered scanlines: prefix every row with a 0 (filter "None").
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    rgb.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(filtered);
  writeFileSync(path, Buffer.concat([
    sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Build the RGB pixel buffer (width*height*3 bytes). Used by both
 *  the PPM and PNG dumpers — color logic lives in one place. If
 *  pheromone fields are passed, blend a translucent cyan/magenta
 *  overlay on top of terrain (debug visualisation). */
function buildRGB(
  w: World, c: Colony,
  fields?: { dig: { current: Float32Array }; build: { current: Float32Array } },
): Buffer {
  const body = Buffer.alloc(w.width * w.height * 3);
  for (let y = 0; y < w.height; y++) {
    for (let x = 0; x < w.width; x++) {
      const idx = y * w.width + x;
      const k = w.cells[idx]!;
      const sy = w.naturalSurface[x]!;
      let r = 0, g = 0, b = 0;
      if (k === CELL_AIR) {
        if (y < sy) {
          const t = y / Math.max(1, w.height * 0.5);
          r = 22 + (70 - 22) * Math.min(1, t);
          g = 30 + (75 - 30) * Math.min(1, t);
          b = 50 + (96 - 50) * Math.min(1, t);
        } else {
          const depth = (y - sy) / Math.max(1, w.height - sy);
          const t = Math.min(1, depth * 1.4);
          r = 148 + (42 - 148) * t;
          g = 110 + (28 - 110) * t;
          b =  78 + (20 -  78) * t;
        }
      } else if (k === CELL_SOIL) {
        const depth = (y - sy) / Math.max(1, w.height - sy);
        const td = Math.min(1, depth);
        // Single soil palette — must mirror SOIL_TOP / SOIL_BOTTOM.
        r = 70 + (42 - 70) * td;
        g = 44 + (24 - 44) * td;
        b = 22 + (12 - 22) * td;
        if (depth > 0.55) {
          const f = (depth - 0.55) / 0.45;
          r *= 1 - 0.55 * f; g *= 1 - 0.55 * f; b *= 1 - 0.55 * f;
        }
      } else if (k === CELL_GRAIN) {
        // Lerp grain by per-cell move counter — must mirror
        // GRAIN_FRESH/GRAIN_WORN/MOVE_COLOUR_CAP in renderer.ts.
        const moves = w.grainMoves[idx]!;
        const t = Math.min(1, moves / 30);
        r = 110 + (220 - 110) * t;
        g = 70 + (168 - 70) * t;
        b = 38 + (100 - 38) * t;
      }
      // Food overlay — bright→dark green by foodMoves.
      if (w.food[idx]! > 0) {
        const moves = w.foodMoves[idx]!;
        const t = Math.min(1, moves / 30);
        r = 90 + (30 - 90) * t;
        g = 220 + (80 - 220) * t;
        b = 70 + (24 - 70) * t;
      }
      // Corpse marker — dim purplish-grey (mirror renderer).
      if (w.corpse[idx]! > 0) {
        r = 90; g = 70; b = 92;
      }
      const o = idx * 3;
      body[o] = Math.round(r) & 0xff;
      body[o + 1] = Math.round(g) & 0xff;
      body[o + 2] = Math.round(b) & 0xff;
    }
  }
  // Pheromone overlay (cyan dig, magenta build) — same compositing
  // as renderer.ts. Skipped for cells with negligible signal so the
  // brown terrain shows through where ants haven't worked.
  if (fields) {
    const dig = fields.dig.current;
    const build = fields.build.current;
    const CAP = 0.5;
    for (let i = 0; i < dig.length; i++) {
      const dv = Math.min(1, dig[i]! / CAP);
      const bv = Math.min(1, build[i]! / CAP);
      if (dv < 0.01 && bv < 0.01) continue;
      const o = i * 3;
      const ar = body[o]!, ag = body[o + 1]!, ab = body[o + 2]!;
      const aDig = dv * 0.55, aBuild = bv * 0.55;
      let nr = ar * (1 - aDig);
      let ng = ag * (1 - aDig) + 220 * aDig;
      let nb = ab * (1 - aDig) + 220 * aDig;
      nr = nr * (1 - aBuild) + 220 * aBuild;
      ng = ng * (1 - aBuild);
      nb = nb * (1 - aBuild) + 220 * aBuild;
      body[o] = nr | 0; body[o + 1] = ng | 0; body[o + 2] = nb | 0;
    }
  }
  // Overlay ants. Dead ants → already corpse markers (skip).
  // Eggs → cream-coloured pixel cluster at the cell.
  // Queen → larger dark amber blot covering a 2×2 area.
  // Workers → 1-pixel black dot.
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i];
    if (s === 5 /* DEAD */) continue;
    const ax = c.posX[i]! | 0;
    const ay = c.posY[i]! | 0;
    if (ax < 0 || ay < 0 || ax >= w.width || ay >= w.height) continue;
    if (s === 7 /* EGG */) {
      const o = (ay * w.width + ax) * 3;
      body[o] = 245; body[o + 1] = 230; body[o + 2] = 200;
      continue;
    }
    if (s === 6 /* QUEEN */) {
      // 2×2 indigo blot for the queen — mirrors renderer colour.
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const qx = ax + dx;
          const qy = ay + dy;
          if (qx < 0 || qy < 0 || qx >= w.width || qy >= w.height) continue;
          const o = (qy * w.width + qx) * 3;
          body[o] = 90; body[o + 1] = 60; body[o + 2] = 170;
        }
      }
      continue;
    }
    const o = (ay * w.width + ax) * 3;
    body[o] = 10; body[o + 1] = 5; body[o + 2] = 0;
  }
  return body;
}

function dumpPPM(
  path: string, w: World, c: Colony,
  fields?: { dig: { current: Float32Array }; build: { current: Float32Array } },
): void {
  const header = `P6\n${w.width} ${w.height}\n255\n`;
  writeFileSync(path, Buffer.concat([Buffer.from(header, 'ascii'), buildRGB(w, c, fields)]));
}

function dumpPNG(
  path: string, w: World, c: Colony,
  fields?: { dig: { current: Float32Array }; build: { current: Float32Array } },
): void {
  writePNG(path, w.width, w.height, buildRGB(w, c, fields));
}

const rng = new RNG(SEED);
const world = new World(WIDTH, HEIGHT);
const surfaceRow = Math.floor(HEIGHT * 0.30);
const halfW = Math.max(6, Math.floor(WIDTH * 0.06));
const depth = Math.max(4, Math.floor(HEIGHT * 0.05));
world.generate(rng, surfaceRow, halfW, depth);

const colony = new Colony(HARVESTER.maxColonySize);
const cx = world.width >> 1;
// Pinhole-pack + surface-scatter — mirrors main.ts. Must track the
// pinhole geometry in world.generate.
const SHAFT_DEPTH = 10;
const POCKET_HALF = 2;
const POCKET_HEIGHT = 4;
const PACK_DENSITY = 1;
const surfHere = world.naturalSurface[cx]!;
// Queen first, at pocket bottom. Mirrors main.ts.
const queenY = surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1;
const queenIdx = colony.spawn(cx + 0.5, queenY + 0.5, 0, rng, DEFAULT_PARAMS);
if (queenIdx >= 0) {
  colony.state[queenIdx] = STATE_QUEEN;
  colony.stateTicks[queenIdx] = 0;
  colony.energy[queenIdx] = HARVESTER.maxEnergy;
}
const pinholeCap = Math.min(
  ANTS,
  (SHAFT_DEPTH + (POCKET_HALF * 2 + 1) * POCKET_HEIGHT) * PACK_DENSITY,
);
const isAir = (x: number, y: number): boolean =>
  world.cells[world.index(x, y)] === 0;
const placedInPinhole = colony.spawnInRect(
  cx - POCKET_HALF, surfHere,
  cx + POCKET_HALF, surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1,
  pinholeCap, rng, isAir, DEFAULT_PARAMS,
);
const remaining = ANTS - placedInPinhole;
if (remaining > 0) {
  const TARGET_SCATTER_DENSITY = 1;
  const SCATTER_HALF = Math.max(
    20,
    Math.min(
      Math.floor((world.width - 1) / 2),
      Math.ceil(remaining / (2 * TARGET_SCATTER_DENSITY)),
    ),
  );
  let topRow = world.height;
  for (let x = Math.max(0, cx - SCATTER_HALF); x <= Math.min(world.width - 1, cx + SCATTER_HALF); x++) {
    if (world.naturalSurface[x]! < topRow) topRow = world.naturalSurface[x]!;
  }
  const scatterY = Math.max(0, topRow - 1);
  colony.spawnInRect(
    Math.max(0, cx - SCATTER_HALF), scatterY,
    Math.min(world.width - 1, cx + SCATTER_HALF), scatterY,
    remaining, rng, isAir, DEFAULT_PARAMS,
  );
}
// Seed worker age distribution (mirrors main.ts). Skip queens/eggs.
for (let i = 0; i < colony.count; i++) {
  if (colony.state[i] !== 0 /* STATE_WANDER */) continue;
  colony.age[i] = (rng.next() * HARVESTER.matureAge * 1.5) | 0;
}

const digField = new Pheromone(world.width, world.height, 0.24, 0.999);
const buildField = new Pheromone(world.width, world.height, 0.40, 0.9995);

let prevSoil = world.countSoil();
const WINDOW = 5000;
let windowDigs = 0;
// Snapshot of dig-direction counters at the start of each window
// so the diag can show per-window deltas (NEW digs that fired
// during this window, broken down by direction).
const prevDigsByDir = new Int32Array(4);

// ── Per-ant motion tracking ─────────────────────────────────
// Ring buffer of recent positions per ant. Each report window we
// compute motion distributions over multiple lookback windows
// (100/250/500/1000 ticks) so a stuck ant — one with low
// effective displacement over a long window — is immediately
// visible in the diag output.
const MAX_LOOKBACK = 1024;
const motionWindows = [100, 250, 500, 1000] as const;
const histX = new Float32Array(colony.capacity * MAX_LOOKBACK);
const histY = new Float32Array(colony.capacity * MAX_LOOKBACK);

function recordPositions(tick: number): void {
  const slot = tick % MAX_LOOKBACK;
  for (let i = 0; i < colony.count; i++) {
    histX[i * MAX_LOOKBACK + slot] = colony.posX[i]!;
    histY[i * MAX_LOOKBACK + slot] = colony.posY[i]!;
  }
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function reportMotion(tick: number): void {
  if (tick < motionWindows[motionWindows.length - 1]!) return;
  for (const W of motionWindows) {
    const cellMoves: number[] = [];
    const effDist: number[] = [];
    let stuck = 0;
    let aliveCount = 0;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i];
      // Skip non-mobile states. EGG/LARVA/QUEEN are stationary by
      // design and would dominate the "stuck" tail. DEAD ants don't
      // count.
      if (s === STATE_DEAD || s === STATE_EGG || s === 9 /* STATE_LARVA */ || s === STATE_QUEEN) continue;
      aliveCount++;
      let lastCx = -1, lastCy = -1;
      let moves = 0;
      let firstX = 0, firstY = 0, lastX = 0, lastY = 0;
      for (let dt = W - 1; dt >= 0; dt--) {
        const tickPast = tick - dt;
        const slot = tickPast % MAX_LOOKBACK;
        const px = histX[i * MAX_LOOKBACK + slot]!;
        const py = histY[i * MAX_LOOKBACK + slot]!;
        if (dt === W - 1) { firstX = px; firstY = py; }
        const cx2 = px | 0;
        const cy2 = py | 0;
        if (cx2 !== lastCx || cy2 !== lastCy) {
          if (lastCx !== -1) moves++;
          lastCx = cx2; lastCy = cy2;
        }
        lastX = px; lastY = py;
      }
      cellMoves.push(moves);
      const ed = Math.hypot(lastX - firstX, lastY - firstY);
      effDist.push(ed);
      if (ed < 1) stuck++;
    }
    const cmSorted = [...cellMoves].sort((a, b) => a - b);
    const edSorted = [...effDist].sort((a, b) => a - b);
    const fmt2 = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : 'n/a';
    console.log(
      `         motion[${String(W).padStart(4)}t] cellMoves: ` +
      `p5=${fmt2(pct(cmSorted, 0.05), 0)} ` +
      `p25=${fmt2(pct(cmSorted, 0.25), 0)} ` +
      `p50=${fmt2(pct(cmSorted, 0.50), 0)} ` +
      `p75=${fmt2(pct(cmSorted, 0.75), 0)} ` +
      `p95=${fmt2(pct(cmSorted, 0.95), 0)} ` +
      `max=${fmt2(pct(cmSorted, 1.0), 0)}` +
      `   effDist: ` +
      `p5=${fmt2(pct(edSorted, 0.05), 1)} ` +
      `p25=${fmt2(pct(edSorted, 0.25), 1)} ` +
      `p50=${fmt2(pct(edSorted, 0.50), 1)} ` +
      `p75=${fmt2(pct(edSorted, 0.75), 1)} ` +
      `p95=${fmt2(pct(edSorted, 0.95), 1)} ` +
      `max=${fmt2(pct(edSorted, 1.0), 1)}` +
      `   stuck<1cell=${stuck}/${aliveCount}`,
    );
  }
}

for (let t = 1; t <= TICKS; t++) {
  step(world, colony, digField, buildField, rng, DEFAULT_PARAMS);
  recordPositions(t);
  const s = world.countSoil();
  if (s < prevSoil) windowDigs += prevSoil - s;
  prevSoil = s;
  if (DUMP_EVERY > 0 && t % DUMP_EVERY === 0) {
    const stem = `${DUMP_DIR}/formicarium-${String(t).padStart(7, '0')}`;
    dumpPNG(stem + '.png', world, colony, { dig: digField, build: buildField });
    dumpPPM(stem + '.ppm', world, colony);
  }
  if (t % WINDOW === 0) {
    // Per-state population breakdown. The new states from foraging
    // and homeostasis (FORAGE, CARRY_FOOD, DEAD) need to be visible
    // in the diag — without this we can't distinguish a colony that
    // collapsed (everyone DEAD) from one stuck in a REST loop.
    let nW = 0, nC = 0, nR = 0, nF = 0, nCF = 0, nD = 0, nQ = 0, nE = 0;
    let stuckLive = 0, aliveCount = 0;
    let belowSurface = 0;
    let avgX = 0, avgY = 0;
    let energySum = 0;
    let energyMin = Infinity;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i];
      if (s === STATE_WANDER) nW++;
      else if (s === STATE_CARRY) nC++;
      else if (s === STATE_REST) nR++;
      else if (s === STATE_FORAGE) nF++;
      else if (s === STATE_CARRY_FOOD) nCF++;
      else if (s === STATE_DEAD) nD++;
      else if (s === STATE_QUEEN) nQ++;
      else if (s === STATE_EGG) nE++;
      if (s !== STATE_DEAD) {
        aliveCount++;
        avgX += colony.posX[i]!;
        avgY += colony.posY[i]!;
        const e = colony.energy[i]!;
        energySum += e;
        if (e < energyMin) energyMin = e;
        const dx = colony.posX[i]! - colony.prevX[i]!;
        const dy = colony.posY[i]! - colony.prevY[i]!;
        if (Math.hypot(dx, dy) < 0.01) stuckLive++;
      }
      const ix = colony.posX[i]! | 0;
      const iy = colony.posY[i]! | 0;
      if (iy >= world.naturalSurface[ix]!) belowSurface++;
    }
    if (aliveCount > 0) { avgX /= aliveCount; avgY /= aliveCount; }
    else { avgX = NaN; avgY = NaN; energyMin = NaN; }
    const energyAvg = aliveCount > 0 ? energySum / aliveCount : NaN;

    // World-state aggregates.
    const totalDug = world.initialSoilCells - world.countSoil();
    const grains = world.countGrains();
    let foodCount = 0, corpseCount = 0;
    for (let i = 0; i < world.food.length; i++) {
      if (world.food[i]! > 0) foodCount++;
      if (world.corpse[i]! > 0) corpseCount++;
    }
    // Grain conservation. dug = grain + grain_carriers + wearLost.
    // CARRY_FOOD ants carry SEEDS not grain, so they don't count
    // toward the grain budget — only STATE_CARRY does. wearLost
    // tracks traffic-erosion soil pulverised to dust (not grain).
    const liveGrainCarriers = nC;
    const conservationGap = totalDug - grains - liveGrainCarriers - world.wearLost;
    let maxMound = 0;
    for (let x = 0; x < world.width; x++) {
      if (world.mound[x]! > maxMound) maxMound = world.mound[x]!;
    }
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] === STATE_DEAD) continue;
      if (colony.posY[i]! < minY) minY = colony.posY[i]!;
      if (colony.posY[i]! > maxY) maxY = colony.posY[i]!;
    }
    if (!Number.isFinite(minY)) { minY = NaN; maxY = NaN; }
    let surfaceSoil = 0;
    for (let x = 0; x < world.width; x++) {
      const sy = world.naturalSurface[x]!;
      for (let y = sy; y < sy + 3 && y < world.height; y++) {
        if (world.cells[world.index(x, y)] === CELL_SOIL) surfaceSoil++;
      }
    }

    // Structural metrics over the dug region.
    let dugArea = 0, perim = 0, tips = 0;
    let maxDepth = 0;
    let bbMinX = Infinity, bbMaxX = -Infinity, bbMinY = Infinity, bbMaxY = -Infinity;
    for (let y = 1; y < world.height - 1; y++) {
      for (let x = 1; x < world.width - 1; x++) {
        const k = world.cells[y * world.width + x];
        if (k === CELL_AIR && y >= world.naturalSurface[x]!) {
          // Below-surface air cell — count it as dug
          dugArea++;
          const depth = y - world.naturalSurface[x]!;
          if (depth > maxDepth) maxDepth = depth;
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
    const fmt = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : 'n/a';
    // nestVol = AIR cells below the natural-surface line. Distinct
    // from `dug` (total cells that USED TO BE soil but are now non-
    // soil, including in-chamber GRAIN deposits): nestVol is the open
    // air space the colony has actually carved out and hasn't refilled
    // with grain. maxDepth is the deepest reach of any dug cell below
    // the surface — measures how far down the colony has tunnelled.
    console.log(
      `t=${String(t).padStart(7)}  dug/${WINDOW}=${String(windowDigs).padStart(4)}  ` +
      `dug=${totalDug} grain=${grains} food=${foodCount} corpse=${corpseCount}  ` +
      `W=${nW} C=${nC} R=${nR} F=${nF} CF=${nCF} D=${nD} Q=${nQ} E=${nE}  ` +
      `alive=${aliveCount} stuck=${stuckLive}/${aliveCount}  ` +
      `E[avg]=${fmt(energyAvg, 2)} E[min]=${fmt(energyMin, 2)}  ` +
      `below=${belowSurface}  y=${fmt(minY)}..${fmt(maxY)}  ` +
      `mound=${maxMound} surfSoil=${surfaceSoil}  ` +
      `cons[dug-grain-liveC]=${conservationGap}  ` +
      `nestVol=${dugArea} maxDepth=${maxDepth} ` +
      `p:nv=${perimRatio} tips=${tips} bbox=${bbW}x${bbH}`,
    );

    // 5×5 quintile population grid. Cells = world divided into 5
    // horizontal strips × 5 vertical strips. Each entry is the count
    // of LIVING ants in that region. Lets us see at a glance whether:
    //   - row 0 (top, sky): foragers above ground (expected: small
    //     count, scaling with the polyethism forager fraction)
    //   - rows ~1 (surface band): entrance traffic + surface mound
    //   - rows 2-4 (deep): chamber population, where age polyethism
    //     should bias nurses toward the bottom row
    //   - left/right columns: spread vs. concentration around the
    //     pinhole entrance (centre column)
    const Q = 5;
    const popGrid: number[][] = Array.from({ length: Q }, () => new Array<number>(Q).fill(0));
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] === STATE_DEAD) continue;
      const px = colony.posX[i]!;
      const py = colony.posY[i]!;
      const qx = Math.max(0, Math.min(Q - 1, Math.floor((px / world.width) * Q)));
      const qy = Math.max(0, Math.min(Q - 1, Math.floor((py / world.height) * Q)));
      popGrid[qy]![qx]!++;
    }
    const popLines: string[] = [];
    for (let qy = 0; qy < Q; qy++) {
      const row = popGrid[qy]!.map((n) => String(n).padStart(3)).join(' ');
      popLines.push(`  q${qy} ${row}`);
    }
    console.log(`         pop grid (rows = vertical quintile, top → deep):\n${popLines.join('\n')}`);

    // Dig-direction histogram. We're trying to bias dig outcomes
    // toward vertical extension (Tschinkel 2004 vertical galleries).
    // Show per-window deltas so we can see whether the dirBonus +
    // asymmetric-pheromone + below-geotaxis machinery is actually
    // producing more N+S digs than E+W digs.
    const dN = world.digsByDir[0]! - prevDigsByDir[0]!;
    const dS = world.digsByDir[1]! - prevDigsByDir[1]!;
    const dE = world.digsByDir[2]! - prevDigsByDir[2]!;
    const dW = world.digsByDir[3]! - prevDigsByDir[3]!;
    const dV = dN + dS;
    const dL = dE + dW;
    const dT = dV + dL;
    const vPct = dT > 0 ? Math.round((dV / dT) * 100) : 0;
    console.log(
      `         dig dirs (this window): N=${dN} S=${dS} E=${dE} W=${dW}  ` +
      `vertical=${dV} lateral=${dL}  vert%=${vPct}`,
    );
    prevDigsByDir.set(world.digsByDir);
    windowDigs = 0;
    reportMotion(t);
  }
}

// Always write a final snapshot so a headless invocation produces a
// visible artifact. PNG is the format the in-session viewer can
// render; PPM is portable to any image tool the user might have.
const finalStem = `${DUMP_DIR}/formicarium-final`;
dumpPNG(finalStem + '.png', world, colony, { dig: digField, build: buildField });
dumpPPM(finalStem + '.ppm', world, colony);
console.log(`final state: ${finalStem}.{png,ppm} (${world.width}x${world.height})`);
