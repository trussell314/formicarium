// Canvas 2D renderer. Draws the simulation onto an offscreen ImageData buffer
// at grid resolution, then blits to the visible canvas with pixel-perfect
// scaling. Agents are drawn as circles in a separate vector pass on top.
//
// SPEC defers GPU rendering (Phase 4) — for the MVP, this Canvas2D path keeps
// the dependency surface tiny and runs comfortably at 60fps for the default
// quality tier (480x270 grid, ~500 ants).

import { RENDER, SIM } from '../config';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../sim/world';
import {
  Colony,
  STATE_CARRY,
  STATE_DIG,
  STATE_REST,
} from '../sim/colony';
import type { FieldsState } from '../sim/fields';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const SOIL_TOP = hexToRgb(RENDER.soilTop);
const SOIL_BOT = hexToRgb(RENDER.soilBottom);
const SOIL_EDGE = hexToRgb(RENDER.soilEdge);
const GRAIN = hexToRgb(RENDER.grainColor);
const SKY_TOP = hexToRgb(RENDER.skyTop);
const SKY_BOT = hexToRgb(RENDER.skyBottom);

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly world: World;
  readonly offscreen: HTMLCanvasElement;
  readonly offCtx: CanvasRenderingContext2D;
  readonly imageData: ImageData;
  // Cached "chrome" gradient layer — sky and base soil colors per row,
  // computed once from world height.
  private readonly skyRow: Uint8ClampedArray;
  private readonly soilRow: Uint8ClampedArray;

  showPheromones = false;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D context');
    this.ctx = ctx;
    this.world = world;

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = world.width;
    this.offscreen.height = world.height;
    const oc = this.offscreen.getContext('2d', { alpha: false });
    if (!oc) throw new Error('No offscreen context');
    this.offCtx = oc;
    this.imageData = oc.createImageData(world.width, world.height);

    this.skyRow = new Uint8ClampedArray(world.height * 3);
    this.soilRow = new Uint8ClampedArray(world.height * 3);
    for (let y = 0; y < world.height; y++) {
      const t = y / Math.max(1, world.height - 1);
      const sky = lerpRgb(SKY_TOP, SKY_BOT, t);
      const soil = lerpRgb(SOIL_TOP, SOIL_BOT, t);
      this.skyRow[y * 3] = sky[0];
      this.skyRow[y * 3 + 1] = sky[1];
      this.skyRow[y * 3 + 2] = sky[2];
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
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Paint world cells into the offscreen buffer. */
  private paintGrid(fields: FieldsState): void {
    const w = this.world.width;
    const h = this.world.height;
    const data = this.imageData.data;
    const cells = this.world.cells;
    const grain = this.world.grainAmount;
    const showP = this.showPheromones;
    const digValues = fields.dig.values;
    const conValues = fields.construction.values;
    for (let y = 0; y < h; y++) {
      const skyR = this.skyRow[y * 3];
      const skyG = this.skyRow[y * 3 + 1];
      const skyB = this.skyRow[y * 3 + 2];
      const soilR = this.soilRow[y * 3];
      const soilG = this.soilRow[y * 3 + 1];
      const soilB = this.soilRow[y * 3 + 2];
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const k = cells[idx];
        const o = idx * 4;
        let r: number;
        let g: number;
        let b: number;
        if (k === CELL_AIR) {
          r = skyR; g = skyG; b = skyB;
        } else if (k === CELL_SOIL) {
          // Edge cells (soil adjacent to air) get a subtle highlight so
          // tunnel walls feel sculpted rather than flat.
          const isEdge =
            (x > 0 && cells[idx - 1] === CELL_AIR) ||
            (x < w - 1 && cells[idx + 1] === CELL_AIR) ||
            (y > 0 && cells[idx - w] === CELL_AIR) ||
            (y < h - 1 && cells[idx + w] === CELL_AIR);
          if (isEdge) {
            r = SOIL_EDGE[0]; g = SOIL_EDGE[1]; b = SOIL_EDGE[2];
          } else {
            r = soilR; g = soilG; b = soilB;
          }
        } else if (k === CELL_GRAIN) {
          const amt = Math.min(8, grain[idx]);
          const t = amt / 8;
          r = GRAIN[0] * (0.7 + 0.3 * t);
          g = GRAIN[1] * (0.7 + 0.3 * t);
          b = GRAIN[2] * (0.7 + 0.3 * t);
        } else {
          r = 0; g = 0; b = 0;
        }
        if (showP) {
          const dp = Math.min(1, digValues[idx] * 0.5);
          if (dp > 0) {
            r = r * (1 - dp * 0.6) + RENDER.digPheromoneColor[0] * dp * 0.6;
            g = g * (1 - dp * 0.6) + RENDER.digPheromoneColor[1] * dp * 0.6;
            b = b * (1 - dp * 0.6) + RENDER.digPheromoneColor[2] * dp * 0.6;
          }
          const cp = Math.min(1, conValues[idx] * 0.5);
          if (cp > 0) {
            r = r * (1 - cp * 0.5) + RENDER.constructionPheromoneColor[0] * cp * 0.5;
            g = g * (1 - cp * 0.5) + RENDER.constructionPheromoneColor[1] * cp * 0.5;
            b = b * (1 - cp * 0.5) + RENDER.constructionPheromoneColor[2] * cp * 0.5;
          }
        }
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    this.offCtx.putImageData(this.imageData, 0, 0);
  }

  /** Compute dest rect that fits the world into the canvas with letterboxing. */
  private fitRect(): { dx: number; dy: number; dw: number; dh: number } {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const ww = this.world.width;
    const wh = this.world.height;
    const sx = cw / ww;
    const sy = ch / wh;
    const s = Math.max(sx, sy); // cover (no letterbox); aspect always 16:9-ish
    const dw = ww * s;
    const dh = wh * s;
    const dx = (cw - dw) * 0.5;
    const dy = (ch - dh) * 0.5;
    return { dx, dy, dw, dh };
  }

  draw(colony: Colony, fields: FieldsState, alpha: number): void {
    this.paintGrid(fields);

    const ctx = this.ctx;
    const { dx, dy, dw, dh } = this.fitRect();
    const sx = dw / this.world.width;

    // Background fill (covers any letterbox).
    ctx.fillStyle = RENDER.skyTop;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.offscreen, dx, dy, dw, dh);

    // Ants — drawn in screen space.
    ctx.save();
    ctx.translate(dx, dy);
    ctx.scale(sx, sx);
    const r = Math.max(0.45, SIM.antRadius * 1.4);
    for (let i = 0; i < colony.count; i++) {
      const px = colony.prevX[i];
      const py = colony.prevY[i];
      const cx = colony.posX[i] * alpha + px * (1 - alpha);
      const cy = colony.posY[i] * alpha + py * (1 - alpha);
      const s = colony.state[i];
      let color: string;
      switch (s) {
        case STATE_CARRY: color = RENDER.antCarryColor; break;
        case STATE_DIG: color = RENDER.antDigColor; break;
        case STATE_REST: color = RENDER.antRestColor; break;
        default: color = RENDER.antBodyColor;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      // Tiny grain dot on carriers.
      if (s === STATE_CARRY) {
        ctx.fillStyle = RENDER.grainColor;
        ctx.beginPath();
        ctx.arc(cx, cy - r * 0.3, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
