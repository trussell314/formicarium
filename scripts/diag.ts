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
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';

const SEED = 0xc0ffee;
const TICKS = Number(process.env.TICKS ?? 60000) | 0;
const WIDTH = Number(process.env.WIDTH ?? 200) | 0;
const HEIGHT = Number(process.env.HEIGHT ?? 120) | 0;
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
        if (y === sy) {
          r = 50; g = 92; b = 36;
        } else {
          const depth = (y - sy) / Math.max(1, w.height - sy);
          const td = Math.min(1, depth);
          // Fresh (dark) and worn (lighter) endpoints — must mirror
          // src/render/renderer.ts SOIL_*_FRESH / SOIL_*_WORN.
          const fr = 70 + (42 - 70) * td;
          const fg = 44 + (24 - 44) * td;
          const fb = 22 + (12 - 22) * td;
          const wr = 128 + (88 - 128) * td;
          const wg = 84 + (54 - 84) * td;
          const wb = 46 + (28 - 46) * td;
          const wear = w.soilWear[idx]! / 255;
          r = fr + (wr - fr) * wear;
          g = fg + (wg - fg) * wear;
          b = fb + (wb - fb) * wear;
          if (depth > 0.55) {
            const f = (depth - 0.55) / 0.45;
            r *= 1 - 0.55 * f; g *= 1 - 0.55 * f; b *= 1 - 0.55 * f;
          }
        }
      } else if (k === CELL_GRAIN) {
        r = 185; g = 138; b = 78;
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
  // Overlay ants as 1-pixel black dots.
  for (let i = 0; i < c.count; i++) {
    const ax = c.posX[i]! | 0;
    const ay = c.posY[i]! | 0;
    if (ax < 0 || ay < 0 || ax >= w.width || ay >= w.height) continue;
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

const colony = new Colony(ANTS);
const cx = world.width >> 1;
// Pinhole-pack + surface-scatter — mirrors main.ts. Must track the
// pinhole geometry in world.generate.
const SHAFT_DEPTH = 5;
const POCKET_HALF = 1;
const POCKET_HEIGHT = 2;
const PACK_DENSITY = 4;
const surfHere = world.naturalSurface[cx]!;
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
  const SCATTER_HALF = 10;
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
const digField = new Pheromone(world.width, world.height, 0.12, 0.985);
const buildField = new Pheromone(world.width, world.height, 0.10, 0.997);

let prevSoil = world.countSoil();
const WINDOW = 5000;
let windowDigs = 0;
for (let t = 1; t <= TICKS; t++) {
  step(world, colony, digField, buildField, rng, DEFAULT_PARAMS);
  const s = world.countSoil();
  if (s < prevSoil) windowDigs += prevSoil - s;
  prevSoil = s;
  if (DUMP_EVERY > 0 && t % DUMP_EVERY === 0) {
    const stem = `${DUMP_DIR}/formicarium-${String(t).padStart(7, '0')}`;
    dumpPNG(stem + '.png', world, colony, { dig: digField, build: buildField });
    dumpPPM(stem + '.ppm', world, colony);
  }
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

// Always write a final snapshot so a headless invocation produces a
// visible artifact. PNG is the format the in-session viewer can
// render; PPM is portable to any image tool the user might have.
const finalStem = `${DUMP_DIR}/formicarium-final`;
dumpPNG(finalStem + '.png', world, colony, { dig: digField, build: buildField });
dumpPPM(finalStem + '.ppm', world, colony);
console.log(`final state: ${finalStem}.{png,ppm} (${world.width}x${world.height})`);
