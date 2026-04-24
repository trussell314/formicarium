// Canvas 2D renderer.
//
// Composition per frame:
//   1. Terrain — ImageData at grid resolution, opaque, with day/night
//      sky gradient baked in and grass + tunnel + soil painted per
//      cell. Upscaled with bilinear smoothing so the grid doesn't
//      read as CGA pixels.
//   2. Sun/moon — disks drawn in screen space on an arc.
//   3. Ants — detailed sprites drawn in world space, one at a time.
//      Each ant has three body segments (head, thorax, gaster), two
//      antennae, and six legs animated in a tripod gait. At 10 ants
//      the per-frame cost is negligible.

import { CONFIG, RENDER } from '../config';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../sim/world';
import {
  Colony,
  STATE_CARRY,
  STATE_REST,
} from '../sim/colony';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

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

/** Daylight in [0,1] from a tick count. 0 = midnight, 1 = noon. */
export function daylightOf(tickCount: number): number {
  const phase = (tickCount % CONFIG.dayLengthTicks) / CONFIG.dayLengthTicks;
  return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly world: World;
  readonly offscreen: HTMLCanvasElement;
  readonly offCtx: CanvasRenderingContext2D;
  readonly imageData: ImageData;

  // Per-row gradient caches (day sky, night sky, tunnel, soil).
  private readonly skyRowDay: Uint8ClampedArray;
  private readonly skyRowNight: Uint8ClampedArray;
  private readonly tunnelRow: Uint8ClampedArray;
  private readonly soilRow: Uint8ClampedArray;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('no 2d ctx');
    this.ctx = ctx;
    this.world = world;

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = world.width;
    this.offscreen.height = world.height;
    const oc = this.offscreen.getContext('2d', { alpha: false });
    if (!oc) throw new Error('no offscreen ctx');
    this.offCtx = oc;
    this.imageData = oc.createImageData(world.width, world.height);

    this.skyRowDay = new Uint8ClampedArray(world.height * 3);
    this.skyRowNight = new Uint8ClampedArray(world.height * 3);
    this.tunnelRow = new Uint8ClampedArray(world.height * 3);
    this.soilRow = new Uint8ClampedArray(world.height * 3);

    const surfEst = Math.max(1, Math.floor(world.height * CONFIG.surfaceFraction));
    for (let y = 0; y < world.height; y++) {
      const skyT = Math.min(1, y / surfEst);
      const day = lerpRgb(SKY_TOP_DAY, SKY_BOT_DAY, skyT);
      const night = lerpRgb(SKY_TOP_NIGHT, SKY_BOT_NIGHT, skyT);
      this.skyRowDay[y * 3] = day[0];
      this.skyRowDay[y * 3 + 1] = day[1];
      this.skyRowDay[y * 3 + 2] = day[2];
      this.skyRowNight[y * 3] = night[0];
      this.skyRowNight[y * 3 + 1] = night[1];
      this.skyRowNight[y * 3 + 2] = night[2];
      const tD = Math.min(1, Math.max(0, (y - surfEst) / Math.max(1, world.height - surfEst)));
      const tun = lerpRgb(TUNNEL_TOP, TUNNEL_BOT, tD);
      this.tunnelRow[y * 3] = tun[0];
      this.tunnelRow[y * 3 + 1] = tun[1];
      this.tunnelRow[y * 3 + 2] = tun[2];
      const sT = y / Math.max(1, world.height - 1);
      const soil = lerpRgb(SOIL_TOP, SOIL_BOT, sT);
      this.soilRow[y * 3] = soil[0];
      this.soilRow[y * 3 + 1] = soil[1];
      this.soilRow[y * 3 + 2] = soil[2];
    }

    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
  }

  handleResize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  private paintGrid(daylight: number): void {
    const w = this.world.width;
    const h = this.world.height;
    const data = this.imageData.data;
    const cells = this.world.cells;
    const grain = this.world.grainAmount;
    const natural = this.world.naturalSurface;
    const noise = this.world.soilNoise;

    for (let y = 0; y < h; y++) {
      const ix3 = y * 3;
      // Blended sky colour for this row.
      const skyR = this.skyRowNight[ix3]! + (this.skyRowDay[ix3]! - this.skyRowNight[ix3]!) * daylight;
      const skyG = this.skyRowNight[ix3 + 1]! + (this.skyRowDay[ix3 + 1]! - this.skyRowNight[ix3 + 1]!) * daylight;
      const skyB = this.skyRowNight[ix3 + 2]! + (this.skyRowDay[ix3 + 2]! - this.skyRowNight[ix3 + 2]!) * daylight;
      const tunR = this.tunnelRow[ix3]!;
      const tunG = this.tunnelRow[ix3 + 1]!;
      const tunB = this.tunnelRow[ix3 + 2]!;
      const soilR = this.soilRow[ix3]!;
      const soilG = this.soilRow[ix3 + 1]!;
      const soilB = this.soilRow[ix3 + 2]!;

      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const k = cells[idx]!;
        const o = idx * 4;
        let r: number;
        let g: number;
        let b: number;
        if (k === CELL_AIR) {
          if (y <= natural[x]!) {
            r = skyR; g = skyG; b = skyB;
          } else {
            r = tunR; g = tunG; b = tunB;
          }
        } else if (k === CELL_SOIL) {
          const surfY = natural[x]! >= h ? h - 1 : natural[x]!;
          if (y === surfY) {
            r = GRASS_TOP[0]; g = GRASS_TOP[1]; b = GRASS_TOP[2];
          } else if (y === surfY + 1) {
            r = GRASS_ROOT[0]; g = GRASS_ROOT[1]; b = GRASS_ROOT[2];
          } else {
            // Edge tinting: soil cells next to any air lean toward
            // lighter soil-edge; interior cells use the base gradient.
            let airNeighbours = 0;
            if (x > 0 && cells[idx - 1] === CELL_AIR) airNeighbours++;
            if (x < w - 1 && cells[idx + 1] === CELL_AIR) airNeighbours++;
            if (y > 0 && cells[idx - w] === CELL_AIR) airNeighbours++;
            if (y < h - 1 && cells[idx + w] === CELL_AIR) airNeighbours++;
            if (airNeighbours > 0) {
              const t = Math.min(1, airNeighbours * 0.4);
              r = SOIL_EDGE[0] * (1 - t) + tunR * t;
              g = SOIL_EDGE[1] * (1 - t) + tunG * t;
              b = SOIL_EDGE[2] * (1 - t) + tunB * t;
            } else {
              r = soilR; g = soilG; b = soilB;
            }
            const nf = 0.88 + (noise[idx]! / 255) * 0.24;
            r *= nf; g *= nf; b *= nf;
          }
        } else if (k === CELL_GRAIN) {
          const amt = Math.min(8, grain[idx]!);
          const t = amt / 8;
          const scale = 0.65 + 0.25 * t;
          r = GRAIN[0] * scale; g = GRAIN[1] * scale; b = GRAIN[2] * scale;
        } else {
          r = 0; g = 0; b = 0;
        }
        // Depth shade on non-air cells.
        if (k !== CELL_AIR) {
          const dep = 1 - (y / h) * 0.18;
          r *= dep; g *= dep; b *= dep;
        }
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    this.offCtx.putImageData(this.imageData, 0, 0);
  }

  /**
   * Draw one ant in world-space. Called with the canvas already
   * scaled to "1 unit = 1 cell" in the ants layer.
   *
   * Anatomy: head + thorax + gaster (three ellipses along the body
   * axis), two antennae arcing forward-outward from the head, six
   * legs (tripod gait) sweeping in sync. Ant is ~3.6 cells long
   * nose-to-gaster, ~1.2 cells wide.
   */
  private drawAnt(cx: number, cy: number, heading: number, t: number, state: number): void {
    const ctx = this.ctx;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const perpX = -sin;
    const perpY = cos;

    // Reference points along the body axis. Body-frame offsets (forward-, right+).
    const pt = (forward: number, right: number): [number, number] =>
      [cx + cos * forward + perpX * right, cy + sin * forward + perpY * right];

    const head = pt(1.6, 0);
    const thorax = pt(0.2, 0);
    const gaster = pt(-1.3, 0);

    // Legs — 3 per side. Tripod gait: ipsilateral front + mid + rear
    // legs are in anti-phase (one group forward while the other is
    // back). Phase t is a wall-clock radian.
    const legPhase = (off: number) => Math.sin(t + off);
    const legY = (f: number, side: number, phase: number) => {
      const origin = pt(f, side * 0.35);
      // Foot: swings ± along body axis, placed out to the side.
      const swing = phase * 0.35;
      const foot = pt(f + swing, side * 1.2);
      return [origin, foot] as const;
    };

    // Draw gaster (abdomen — largest).
    ctx.fillStyle = RENDER.antBody;
    ctx.beginPath();
    ctx.ellipse(gaster[0], gaster[1], 0.85, 0.55, heading, 0, Math.PI * 2);
    ctx.fill();

    // Draw thorax.
    ctx.beginPath();
    ctx.ellipse(thorax[0], thorax[1], 0.55, 0.42, heading, 0, Math.PI * 2);
    ctx.fill();

    // Legs (under thorax) — draw before head so head covers the roots.
    ctx.strokeStyle = RENDER.antLeg;
    ctx.lineWidth = 0.16;
    ctx.lineCap = 'round';
    const pairs: Array<[number, number, number]> = [
      [ 0.4,  1, 0],
      [ 0.1, -1, Math.PI],
      [-0.2,  1, Math.PI],
      [-0.2, -1, 0],
      [ 0.1,  1, Math.PI],
      [ 0.4, -1, 0],
    ];
    for (const [f, s, off] of pairs) {
      const ph = legPhase(off);
      const [origin, foot] = legY(f, s, ph);
      ctx.beginPath();
      ctx.moveTo(origin[0], origin[1]);
      ctx.lineTo(foot[0], foot[1]);
      ctx.stroke();
    }

    // Antennae — curved forward from head.
    const wiggle = Math.sin(t * 1.4) * 0.1;
    const antL = pt(2.3, -0.45 + wiggle);
    const antR = pt(2.3,  0.45 - wiggle);
    ctx.strokeStyle = RENDER.antLeg;
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(head[0], head[1]);
    ctx.lineTo(antL[0], antL[1]);
    ctx.moveTo(head[0], head[1]);
    ctx.lineTo(antR[0], antR[1]);
    ctx.stroke();

    // Head (draw last so legs/antennae tuck under).
    ctx.fillStyle = RENDER.antHead;
    ctx.beginPath();
    ctx.ellipse(head[0], head[1], 0.5, 0.45, heading, 0, Math.PI * 2);
    ctx.fill();

    // Carried grain — small tan dot at mandibles.
    if (state === STATE_CARRY) {
      const jaw = pt(2.15, 0);
      ctx.fillStyle = RENDER.grainColor;
      ctx.beginPath();
      ctx.arc(jaw[0], jaw[1], 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // REST ants get a faint dim overlay (optional visual beat; we're
    // not currently using REST state but the hook is here).
    if (state === STATE_REST) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(thorax[0], thorax[1], 0.8, 0.6, heading, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private fitRect(): { dx: number; dy: number; dw: number; dh: number } {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const ww = this.world.width;
    const wh = this.world.height;
    const s = Math.max(cw / ww, ch / wh);
    const dw = ww * s;
    const dh = wh * s;
    return { dx: (cw - dw) * 0.5, dy: (ch - dh) * 0.5, dw, dh };
  }

  draw(colony: Colony, alpha: number): void {
    const ctx = this.ctx;
    const daylight = daylightOf(this.world.tickCount);
    this.paintGrid(daylight);

    const { dx, dy, dw, dh } = this.fitRect();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(this.offscreen, dx, dy, dw, dh);

    // Sun / moon — on an arc across the upper portion of the canvas.
    const phase = (this.world.tickCount % CONFIG.dayLengthTicks) / CONFIG.dayLengthTicks;
    const ang = phase * Math.PI * 2 - Math.PI / 2;
    const sunX = this.canvas.width * 0.5 + Math.sin(ang) * this.canvas.width * 0.45;
    const sunY = this.canvas.height * 0.35 - Math.cos(ang) * this.canvas.height * 0.25;
    const moonX = this.canvas.width * 0.5 - Math.sin(ang) * this.canvas.width * 0.45;
    const moonY = this.canvas.height * 0.35 + Math.cos(ang) * this.canvas.height * 0.25;
    const discR = Math.max(8, Math.min(this.canvas.width, this.canvas.height) * 0.025);
    if (daylight > 0.05) {
      ctx.globalAlpha = Math.min(1, daylight * 1.2);
      ctx.fillStyle = RENDER.sunColor;
      ctx.beginPath(); ctx.arc(sunX, sunY, discR, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (daylight < 0.95) {
      ctx.globalAlpha = Math.min(1, (1 - daylight) * 1.2);
      ctx.fillStyle = RENDER.moonColor;
      ctx.beginPath(); ctx.arc(moonX, moonY, discR * 0.85, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Ants — world-space coordinates scaled to canvas.
    const sx = dw / this.world.width;
    ctx.save();
    ctx.translate(dx, dy);
    ctx.scale(sx, sx);
    const gaitT = performance.now() * 0.012;
    for (let i = 0; i < colony.count; i++) {
      const px = colony.prevX[i]!;
      const py = colony.prevY[i]!;
      const nx = colony.posX[i]! * alpha + px * (1 - alpha);
      const ny = colony.posY[i]! * alpha + py * (1 - alpha);
      this.drawAnt(nx, ny, colony.heading[i]!, gaitT + i * 0.7, colony.state[i]!);
    }
    ctx.restore();
  }
}
