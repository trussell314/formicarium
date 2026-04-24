// Headless renderer. Dumps a single frame of the simulation to a PPM
// (P6) binary image using the same color logic as src/render/renderer.ts.
// Lets me visually sanity-check the render without a browser.
//
// Usage:
//   SEED=42 TICKS=1800 SCALE=3 DAYLIGHT=1 OUT=/tmp/frame.ppm \
//     npm run ppm
//
// Convert to PNG:
//   python3 -c "from PIL import Image; Image.open('/tmp/frame.ppm').save('/tmp/frame.png')"

import { writeFileSync } from 'node:fs';
import { CONFIG, RENDER } from '../src/config';
import {
  CELL_AIR,
  CELL_GRAIN,
  CELL_SOIL,
  World,
} from '../src/sim/world';
import { Colony, STATE_CARRY } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

const SEED = Number(process.env.SEED ?? 0xc0ffee) >>> 0;
const TICKS = Number(process.env.TICKS ?? 1800) | 0;
const SCALE = Math.max(1, Number(process.env.SCALE ?? 3) | 0);
const OUT = process.env.OUT ?? 'out.ppm';
const DAYLIGHT_OVERRIDE = process.env.DAYLIGHT !== undefined ? Number(process.env.DAYLIGHT) : null;

const rng = new RNG(SEED);
const world = new World(CONFIG.gridWidth, CONFIG.gridHeight);
world.generate(rng);

const colony = new Colony(CONFIG.antCount);
const surfaceY = Math.floor(world.height * CONFIG.surfaceFraction);
const cx = Math.floor(world.width / 2);
const halfW = CONFIG.starterChamberHalfWidth;
colony.spawnInRect(
  cx - halfW,
  surfaceY + 1,
  cx + halfW,
  surfaceY + CONFIG.starterChamberDepth,
  CONFIG.antCount,
  rng,
  (x, y) => world.isAir(x, y),
);

for (let t = 0; t < TICKS; t++) stepSimulation(world, colony, rng);

// Match renderer.ts.
const SOIL_TOP = hexToRgb(RENDER.soilTop);
const SOIL_BOT = hexToRgb(RENDER.soilBottom);
const SOIL_EDGE = hexToRgb(RENDER.soilEdge);
const TUNNEL_TOP = hexToRgb(RENDER.tunnelTop);
const TUNNEL_BOT = hexToRgb(RENDER.tunnelBottom);
const SKY_TOP_DAY = hexToRgb(RENDER.skyTopDay);
const SKY_BOT_DAY = hexToRgb(RENDER.skyBottomDay);
const SKY_TOP_NIGHT = hexToRgb(RENDER.skyTopNight);
const SKY_BOT_NIGHT = hexToRgb(RENDER.skyBottomNight);
const GRASS_TOP = hexToRgb(RENDER.grassTop);
const GRASS_ROOT = hexToRgb(RENDER.grassRoot);
const GRAIN = hexToRgb(RENDER.grainColor);
const ANT_BODY = hexToRgb(RENDER.antBody);
const ANT_HEAD = hexToRgb(RENDER.antHead);

const phase = (world.tickCount % CONFIG.dayLengthTicks) / CONFIG.dayLengthTicks;
const DAYLIGHT = DAYLIGHT_OVERRIDE !== null
  ? DAYLIGHT_OVERRIDE
  : 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
console.log(`tick=${world.tickCount}  daylight=${DAYLIGHT.toFixed(2)}  ants=${colony.count}`);

const w = world.width;
const h = world.height;
const surfEst = Math.max(1, Math.floor(h * CONFIG.surfaceFraction));
const skyRow: [number, number, number][] = [];
const tunRow: [number, number, number][] = [];
const soilRow: [number, number, number][] = [];
for (let y = 0; y < h; y++) {
  const skyT = Math.min(1, y / surfEst);
  const day = lerpRgb(SKY_TOP_DAY, SKY_BOT_DAY, skyT);
  const night = lerpRgb(SKY_TOP_NIGHT, SKY_BOT_NIGHT, skyT);
  skyRow.push(lerpRgb(night, day, DAYLIGHT));
  const tD = Math.min(1, Math.max(0, (y - surfEst) / Math.max(1, h - surfEst)));
  tunRow.push(lerpRgb(TUNNEL_TOP, TUNNEL_BOT, tD));
  const sT = y / Math.max(1, h - 1);
  soilRow.push(lerpRgb(SOIL_TOP, SOIL_BOT, sT));
}

const buf = new Uint8Array(w * h * 3);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const idx = y * w + x;
    const k = world.cells[idx];
    let r = 0, g = 0, b = 0;
    if (k === CELL_AIR) {
      const c = y <= world.naturalSurface[x]! ? skyRow[y]! : tunRow[y]!;
      [r, g, b] = c;
    } else if (k === CELL_SOIL) {
      const surfY = world.naturalSurface[x]! >= h ? h - 1 : world.naturalSurface[x]!;
      if (y === surfY) { [r, g, b] = GRASS_TOP; }
      else if (y === surfY + 1) { [r, g, b] = GRASS_ROOT; }
      else {
        let airN = 0;
        if (x > 0 && world.cells[idx - 1] === CELL_AIR) airN++;
        if (x < w - 1 && world.cells[idx + 1] === CELL_AIR) airN++;
        if (y > 0 && world.cells[idx - w] === CELL_AIR) airN++;
        if (y < h - 1 && world.cells[idx + w] === CELL_AIR) airN++;
        if (airN > 0) {
          const t = Math.min(1, airN * 0.4);
          const tR = tunRow[y]!;
          r = SOIL_EDGE[0] * (1 - t) + tR[0] * t;
          g = SOIL_EDGE[1] * (1 - t) + tR[1] * t;
          b = SOIL_EDGE[2] * (1 - t) + tR[2] * t;
        } else {
          [r, g, b] = soilRow[y]!;
        }
        const nf = 0.88 + (world.soilNoise[idx]! / 255) * 0.24;
        r *= nf; g *= nf; b *= nf;
      }
    } else if (k === CELL_GRAIN) {
      const amt = Math.min(8, world.grainAmount[idx]!);
      const t = amt / 8;
      const scale = 0.65 + 0.25 * t;
      r = GRAIN[0] * scale; g = GRAIN[1] * scale; b = GRAIN[2] * scale;
    }
    if (k !== CELL_AIR) {
      const dep = 1 - (y / h) * 0.18;
      r *= dep; g *= dep; b *= dep;
    }
    const o = idx * 3;
    buf[o] = Math.max(0, Math.min(255, r | 0));
    buf[o + 1] = Math.max(0, Math.min(255, g | 0));
    buf[o + 2] = Math.max(0, Math.min(255, b | 0));
  }
}

// Overlay ants as a tiny body+head. (PPM is grid-res so fine
// anatomy wouldn't render anyway; just verify they're at sensible
// positions.)
function plot(cx: number, cy: number, color: [number, number, number]): void {
  const ix = cx | 0;
  const iy = cy | 0;
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
  const o = (iy * w + ix) * 3;
  buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2];
}

for (let i = 0; i < colony.count; i++) {
  const ax = colony.posX[i]!;
  const ay = colony.posY[i]!;
  const head = ANT_HEAD;
  const body = ANT_BODY;
  plot(ax, ay, body);
  plot(ax - 1, ay, body);
  plot(ax, ay - 0.4, head);
  if (colony.state[i] === STATE_CARRY) {
    plot(ax + 1, ay, GRAIN);
  }
}

// Optional nearest-neighbour upscale.
let outW = w, outH = h, outBuf = buf;
if (SCALE > 1) {
  outW = w * SCALE; outH = h * SCALE;
  outBuf = new Uint8Array(outW * outH * 3);
  for (let y = 0; y < outH; y++) {
    const sy = (y / SCALE) | 0;
    for (let x = 0; x < outW; x++) {
      const sx = (x / SCALE) | 0;
      const s = (sy * w + sx) * 3;
      const d = (y * outW + x) * 3;
      outBuf[d] = buf[s]!; outBuf[d + 1] = buf[s + 1]!; outBuf[d + 2] = buf[s + 2]!;
    }
  }
}

const header = Buffer.from(`P6\n${outW} ${outH}\n255\n`, 'ascii');
writeFileSync(OUT, Buffer.concat([header, Buffer.from(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength)]));
console.log(`wrote ${OUT}  (${outW}x${outH}, seed=0x${SEED.toString(16)})`);
