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

import { RENDER } from '../config';
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

export interface DayNightCycle {
  dayDurationTicks: number;
  nightDurationTicks: number;
}

/**
 * Returns the celestial state at a given tick.
 *
 *   daylight    — sky brightness, [0..1]. 0 = full night, 1 = noon.
 *   sunPhase    — fraction through the day cycle, [0..1]. Used to
 *                  position the sun's arc.
 *   moonPhase   — fraction through the night cycle, [0..1].
 *   sunUp       — true when the sun is the visible body.
 */
export function celestialOf(tickCount: number, cycle: DayNightCycle): {
  daylight: number;
  sunPhase: number;
  moonPhase: number;
  sunUp: boolean;
} {
  const day = cycle.dayDurationTicks;
  const night = cycle.nightDurationTicks;
  const total = day + night;
  const t = ((tickCount % total) + total) % total;
  if (t < day) {
    const f = day === 0 ? 0 : t / day;
    return {
      daylight: Math.sin(f * Math.PI),
      sunPhase: f,
      moonPhase: 0,
      sunUp: true,
    };
  }
  const f = night === 0 ? 0 : (t - day) / night;
  return {
    daylight: 0,
    sunPhase: 0,
    moonPhase: f,
    sunUp: false,
  };
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly world: World;
  readonly offscreen: HTMLCanvasElement;
  readonly offCtx: CanvasRenderingContext2D;
  readonly imageData: ImageData;
  readonly cycle: DayNightCycle;
  readonly surfaceCellsFromTop: number;
  readonly cellsPerCm: number;

  // Per-row gradient caches (day sky, night sky, tunnel, soil).
  private readonly skyRowDay: Uint8ClampedArray;
  private readonly skyRowNight: Uint8ClampedArray;
  private readonly tunnelRow: Uint8ClampedArray;
  private readonly soilRow: Uint8ClampedArray;

  constructor(
    canvas: HTMLCanvasElement,
    world: World,
    cycle: DayNightCycle,
    surfaceCellsFromTop: number,
    cellsPerCm: number,
  ) {
    this.canvas = canvas;
    this.cycle = cycle;
    this.surfaceCellsFromTop = surfaceCellsFromTop;
    this.cellsPerCm = cellsPerCm;
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

    const surfEst = Math.max(1, this.surfaceCellsFromTop);
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
   * Draw one ant in world-space. The ants layer is pre-scaled so
   * 1 unit = 1 cell. Anatomy is expressed as fractions of body
   * length along the body axis (forward + / back −) and perpendicular
   * (right + / left −), then scaled by bodyLengthCells, so real-world
   * body size is preserved when CELLS_PER_CM changes.
   *
   * The sprite includes: segmented body (head / thorax / petiole /
   * gaster), six 2-segment legs in a tripod gait, two elbowed
   * antennae, mandibles at the front, and soft highlights on the
   * thorax and gaster to give a glossy-chitin look. A thin outline
   * stroke around the body helps each ant read clearly against the
   * tunnel tan.
   */
  private drawAnt(
    cx: number, cy: number, heading: number, t: number, state: number,
    bodyLengthCells: number, selected: boolean,
  ): void {
    const ctx = this.ctx;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const perpX = -sin;
    const perpY = cos;
    const L = bodyLengthCells;

    const pt = (forward: number, right: number): [number, number] =>
      [cx + cos * forward * L + perpX * right * L, cy + sin * forward * L + perpY * right * L];

    // Anchor points (fractions of body length).
    const nose = pt(0.50, 0);
    const head = pt(0.36, 0);
    const mandibleL = pt(0.48, -0.04);
    const mandibleR = pt(0.48,  0.04);
    const thorax = pt(0.10, 0);
    const petiole = pt(-0.08, 0);
    const gaster = pt(-0.30, 0);

    // Tripod-gait leg phases. Front-left + mid-right + rear-left
    // are in phase; the other three are anti-phase.
    const swing = (off: number) => Math.sin(t + off);
    const drawLeg = (
      shoulderF: number, shoulderR: number,
      reachF: number, reachR: number,
      off: number, sign: number,
    ) => {
      const ph = swing(off);
      const shoulder = pt(shoulderF, shoulderR * sign);
      // Knee: outward from body, partway to foot.
      const knee = pt(
        shoulderF + reachF * 0.4 + ph * 0.03,
        (shoulderR + reachR * 0.55 + 0.04) * sign,
      );
      const foot = pt(
        shoulderF + reachF + ph * 0.08,
        (shoulderR + reachR) * sign,
      );
      ctx.beginPath();
      ctx.moveTo(shoulder[0], shoulder[1]);
      ctx.lineTo(knee[0], knee[1]);
      ctx.lineTo(foot[0], foot[1]);
      ctx.stroke();
    };

    ctx.strokeStyle = RENDER.antLeg;
    ctx.lineWidth = Math.max(0.04 * L, 0.5);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Six legs. Tripod A: front-left, mid-right, rear-left (phase 0).
    //          Tripod B: the other three (phase π).
    drawLeg( 0.14,  0.07,  0.08,  0.16, 0,        -1); // front L
    drawLeg( 0.02,  0.07,  0.04,  0.22, Math.PI,   1); // mid R
    drawLeg(-0.10,  0.07, -0.02,  0.18, 0,        -1); // rear L
    drawLeg( 0.14,  0.07,  0.08,  0.16, Math.PI,   1); // front R
    drawLeg( 0.02,  0.07,  0.04,  0.22, 0,        -1); // mid L
    drawLeg(-0.10,  0.07, -0.02,  0.18, Math.PI,   1); // rear R

    // Body segments. Gaster first (rearmost).
    ctx.fillStyle = RENDER.antBody;
    ctx.beginPath();
    ctx.ellipse(gaster[0], gaster[1], 0.22 * L, 0.15 * L, heading, 0, Math.PI * 2);
    ctx.fill();
    // Petiole (narrow waist): small circle connecting thorax→gaster.
    ctx.beginPath();
    ctx.arc(petiole[0], petiole[1], 0.055 * L, 0, Math.PI * 2);
    ctx.fill();
    // Thorax.
    ctx.beginPath();
    ctx.ellipse(thorax[0], thorax[1], 0.12 * L, 0.10 * L, heading, 0, Math.PI * 2);
    ctx.fill();

    // Gloss highlights — small lighter ellipses on the upper (−perp)
    // side of thorax and gaster. Gives a subtle 3D chitin feel.
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    const gHighlight = pt(-0.25, -0.08);
    ctx.beginPath();
    ctx.ellipse(gHighlight[0], gHighlight[1], 0.11 * L, 0.04 * L, heading, 0, Math.PI * 2);
    ctx.fill();
    const tHighlight = pt(0.12, -0.05);
    ctx.beginPath();
    ctx.ellipse(tHighlight[0], tHighlight[1], 0.06 * L, 0.025 * L, heading, 0, Math.PI * 2);
    ctx.fill();

    // Antennae — elbowed, each with a scape (from head to elbow) and
    // a funiculus (from elbow to tip). Slight per-frame wobble.
    const antWob = Math.sin(t * 1.6) * 0.04;
    const drawAntenna = (sign: number) => {
      const base = pt(0.40, 0.05 * sign);
      const elbow = pt(0.48, (0.14 + antWob) * sign);
      const tip = pt(0.62, (0.10 - antWob * 0.5) * sign);
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.lineTo(elbow[0], elbow[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.stroke();
    };
    ctx.strokeStyle = RENDER.antLeg;
    ctx.lineWidth = Math.max(0.03 * L, 0.4);
    drawAntenna(-1);
    drawAntenna(1);

    // Mandibles — two short curves converging at the nose.
    ctx.beginPath();
    ctx.moveTo(mandibleL[0], mandibleL[1]);
    ctx.lineTo(nose[0], nose[1]);
    ctx.moveTo(mandibleR[0], mandibleR[1]);
    ctx.lineTo(nose[0], nose[1]);
    ctx.stroke();

    // Head — drawn last so antennae bases tuck under.
    ctx.fillStyle = RENDER.antHead;
    ctx.beginPath();
    ctx.ellipse(head[0], head[1], 0.11 * L, 0.11 * L, heading, 0, Math.PI * 2);
    ctx.fill();

    // Tiny eye highlights on head.
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    const eyeL = pt(0.40, -0.05);
    const eyeR = pt(0.40,  0.05);
    ctx.beginPath();
    ctx.arc(eyeL[0], eyeL[1], 0.012 * L, 0, Math.PI * 2);
    ctx.arc(eyeR[0], eyeR[1], 0.012 * L, 0, Math.PI * 2);
    ctx.fill();

    // Carried grain — small tan bead at the mandibles.
    if (state === STATE_CARRY) {
      const jaw = pt(0.56, 0);
      ctx.fillStyle = RENDER.grainColor;
      ctx.beginPath();
      ctx.arc(jaw[0], jaw[1], 0.08 * L, 0, Math.PI * 2);
      ctx.fill();
    }

    // Selection ring.
    if (selected) {
      ctx.strokeStyle = 'rgba(255,240,120,0.95)';
      ctx.lineWidth = Math.max(0.04 * L, 0.8);
      ctx.beginPath();
      ctx.arc(cx, cy, 0.5 * L, 0, Math.PI * 2);
      ctx.stroke();
    }

    // REST ants get a faint dim overlay.
    if (state === STATE_REST) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(thorax[0], thorax[1], 0.22 * L, 0.18 * L, heading, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Draw a crescent moon at (mx, my) with disc radius r. The lit side
   * faces (sx, sy) — the conceptual sun position. Implemented as the
   * moon disk minus an offset "shadow" disk in the same colour as
   * the surrounding sky, so the result is a crescent whose horns
   * point away from the sun.
   */
  private drawCrescentMoon(mx: number, my: number, r: number, sx: number, sy: number): void {
    const ctx = this.ctx;
    // Direction unit vector from moon → sun.
    let dx = sx - mx;
    let dy = sy - my;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // Shadow disk is offset AWAY from the sun by ~0.5 r so a thin
    // crescent shows on the lit side.
    const offset = r * 0.55;
    const shadowX = mx - dx * offset;
    const shadowY = my - dy * offset;
    // Bright disk first.
    ctx.fillStyle = RENDER.moonColor;
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.fill();
    // Cut out by drawing a sky-coloured disk on top.
    ctx.fillStyle = this.skyColorAt(shadowY);
    ctx.beginPath();
    ctx.arc(shadowX, shadowY, r * 0.96, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Sky colour at a given canvas-pixel y, blending day/night by the
   * current tick's daylight factor. Used by the crescent moon's
   * shadow disk so it matches the sky behind it.
   */
  private skyColorAt(canvasY: number): string {
    const cel = celestialOf(this.world.tickCount, this.cycle);
    // Rough vertical position in the sky band [0,1].
    const surfaceCanvasY = this.canvas.height * 0.4;
    const t = Math.max(0, Math.min(1, canvasY / Math.max(1, surfaceCanvasY)));
    const day = lerpRgb(
      [SKY_TOP_DAY[0], SKY_TOP_DAY[1], SKY_TOP_DAY[2]],
      [SKY_BOT_DAY[0], SKY_BOT_DAY[1], SKY_BOT_DAY[2]],
      t,
    );
    const night = lerpRgb(
      [SKY_TOP_NIGHT[0], SKY_TOP_NIGHT[1], SKY_TOP_NIGHT[2]],
      [SKY_BOT_NIGHT[0], SKY_BOT_NIGHT[1], SKY_BOT_NIGHT[2]],
      t,
    );
    const r = night[0] + (day[0] - night[0]) * cel.daylight;
    const g = night[1] + (day[1] - night[1]) * cel.daylight;
    const b = night[2] + (day[2] - night[2]) * cel.daylight;
    return `rgb(${r | 0},${g | 0},${b | 0})`;
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

  /**
   * Convert a canvas-pixel position (e.g. from a mouse/touch event)
   * to world-cell coordinates. Returns null if the point is outside
   * the rendered world rect.
   */
  canvasToWorld(cxPx: number, cyPx: number): { x: number; y: number } | null {
    const { dx, dy, dw, dh } = this.fitRect();
    if (cxPx < dx || cxPx > dx + dw || cyPx < dy || cyPx > dy + dh) return null;
    const sx = dw / this.world.width;
    return { x: (cxPx - dx) / sx, y: (cyPx - dy) / sx };
  }

  /** Selected ant id to highlight; -1 for none. */
  selectedAntId = -1;

  draw(colony: Colony, alpha: number): void {
    const ctx = this.ctx;
    const cel = celestialOf(this.world.tickCount, this.cycle);
    this.paintGrid(cel.daylight);

    const { dx, dy, dw, dh } = this.fitRect();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(this.offscreen, dx, dy, dw, dh);

    // Sun / moon arcs. Each rises from the left horizon, peaks
    // overhead, sets to the right.
    const archCenterX = this.canvas.width * 0.5;
    const archHorizonY = this.canvas.height * 0.35;
    const archSpanX = this.canvas.width * 0.45;
    const archSpanY = this.canvas.height * 0.25;
    const discR = Math.max(8, Math.min(this.canvas.width, this.canvas.height) * 0.025);

    if (cel.sunUp) {
      // Sun position parameterised by sunPhase ∈ [0,1].
      const ang = (cel.sunPhase - 0.5) * Math.PI;
      const sx = archCenterX + Math.sin(ang) * archSpanX;
      const sy = archHorizonY - Math.cos(ang) * archSpanY;
      ctx.fillStyle = RENDER.sunColor;
      ctx.beginPath();
      ctx.arc(sx, sy, discR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Moon arcs from left horizon (moonPhase=0) to right horizon
      // (moonPhase=1), peaking overhead at moonPhase=0.5.
      const moonAng = (cel.moonPhase - 0.5) * Math.PI;
      const mx = archCenterX + Math.sin(moonAng) * archSpanX;
      const my = archHorizonY - Math.cos(moonAng) * archSpanY;
      // Notional sun continues across the lower (under-world) arc:
      // it set on the right at moonPhase=0 and rises on the left at
      // moonPhase=1, opposite the moon. This gives the crescent the
      // proper apparent rotation through the night — lit side faces
      // the (invisible) sun.
      const sunAng = Math.PI / 2 + cel.moonPhase * Math.PI;
      const sx = archCenterX + Math.sin(sunAng) * archSpanX;
      const sy = archHorizonY - Math.cos(sunAng) * archSpanY;
      this.drawCrescentMoon(mx, my, discR * 0.9, sx, sy);
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
      this.drawAnt(
        nx,
        ny,
        colony.heading[i]!,
        gaitT + i * 0.7,
        colony.state[i]!,
        colony.bodyLengthCells[i]!,
        colony.id[i] === this.selectedAntId,
      );
    }
    ctx.restore();
  }
}
