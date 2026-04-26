// Canvas2D renderer. Two passes:
//   1. Terrain: putImageData of the cell grid, scaled up nearest-neighbor
//      to viewport. Soil gets per-cell hash noise + a "fresh dig" tint
//      so excavated cells briefly glow lighter.
//   2. Ants: stroked ovals on top of the scaled terrain, interpolated
//      between prev and current positions for smooth motion.
//
// Renderer reads sim state. Never writes. (CLAUDE.md invariant.)

import { Colony, STATE_CARRY } from '../sim/colony';
import type { ParticleSystem } from '../sim/particles';
import { CELL_AIR, CELL_SOIL, World } from '../sim/world';

const SKY_TOP: [number, number, number] = [22, 30, 50];
const SKY_BOTTOM: [number, number, number] = [70, 75, 96];
// Tunnel air. Real ant-farm tunnels are LIGHTER than the surrounding
// substrate — light enters from the top, dust on the gel reflects, the
// dug area reads as paler than the dirt. The previous TUNNEL value
// (38,27,18) was darker than mid-soil (70,42,22) so excavations
// looked like ink stains. TUNNEL_NEAR is what air close to the
// surface looks like; TUNNEL_DEEP is the deep-tunnel color the depth
// fog blends toward.
const TUNNEL_NEAR: [number, number, number] = [148, 110, 78];
const TUNNEL_DEEP: [number, number, number] = [42, 28, 20];
// Solid soil — single dark palette. Per-grain wear lives on the
// GRAIN cells (world.grainMoves), not on undisturbed soil.
const SOIL_TOP: [number, number, number] = [70, 44, 22];
const SOIL_BOTTOM: [number, number, number] = [42, 24, 12];
// Grain has its own dark→light gradient driven by world.grainMoves
// per cell. Fresh-from-the-soil grain (moves = 1) reads close to
// soil colour; grain that's been picked up and re-deposited many
// times trends toward the brighter, dried "weathered" end.
const GRAIN_FRESH: [number, number, number] = [110, 70, 38];
const GRAIN_WORN: [number, number, number] = [220, 168, 100];
// Food (seeds) — bright green when freshly delivered (moves = 0,
// surface seed rain), darkening as ants pick up and re-deposit.
const FOOD_FRESH: [number, number, number] = [90, 220, 70];
const FOOD_WORN: [number, number, number] = [30, 80, 24];
/** Cap for the moves→colour lerp. Beyond this many moves, additional
 *  re-deposits don't change colour further. Picked to match a few
 *  realistic relocations rather than the Uint8 saturation point. */
const MOVE_COLOUR_CAP = 30;
const GRAIN_COLOR: [number, number, number] = [185, 138, 78];
const FRESH_DIG: [number, number, number] = [78, 56, 38];

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly off: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private readonly buf: Uint8ClampedArray;
  /** Bound world. Mutable via setWorld() — the reseed action in
   *  main.ts swaps in a freshly-generated world without rebuilding
   *  the whole renderer. Width/height are assumed unchanged across
   *  the swap (the offscreen canvas is sized at construction). */
  private world: World;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d context not available');
    this.ctx = ctx;
    this.world = world;
    this.off = document.createElement('canvas');
    this.off.width = world.width;
    this.off.height = world.height;
    const offCtx = this.off.getContext('2d', { alpha: false });
    if (!offCtx) throw new Error('off-screen 2d context not available');
    this.offCtx = offCtx;
    this.imageData = this.offCtx.createImageData(world.width, world.height);
    this.buf = this.imageData.data;
  }

  /** Toggleable pheromone-field overlay. Off by default; flip with
   *  the 'p' key in the live UI. Two fields are blended with
   *  translucent unused colours so they don't conflict with the
   *  brown/green/tan terrain palette: cyan = dig, magenta = build. */
  showPheromones = false;

  /** User zoom factor (1.0 = fit-to-screen). Mutated by main's pinch /
   *  wheel handlers. */
  zoom = 1;
  /** User pan in viewport pixels. Reset to (0,0) when zoom returns to 1. */
  panX = 0;
  panY = 0;

  /** Swap in a freshly-generated World. Width and height must match
   *  the existing offscreen canvas; the renderer assumes that. */
  setWorld(world: World): void {
    this.world = world;
  }

  resize(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Convert a viewport-pixel coordinate to a world-cell coordinate
   *  given the current zoom + pan. Used by input handlers (e.g. to
   *  anchor a pinch zoom around the focal point). */
  screenToWorld(px: number, py: number): { x: number; y: number } {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const w = this.world.width;
    const h = this.world.height;
    const dpr = cw / parseFloat(this.canvas.style.width || `${cw}`);
    const baseScale = Math.min(cw / w, ch / h);
    const scale = baseScale * this.zoom;
    const ow = w * scale;
    const oh = h * scale;
    const ox = (cw - ow) * 0.5 + this.panX * dpr;
    const oy = (ch - oh) * 0.5 + this.panY * dpr;
    return { x: (px * dpr - ox) / scale, y: (py * dpr - oy) / scale };
  }

  /** Clamp pan so the world stays at least partially on-screen. */
  clampPan(): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const w = this.world.width;
    const h = this.world.height;
    const dpr = cw / parseFloat(this.canvas.style.width || `${cw}`);
    const baseScale = Math.min(cw / w, ch / h);
    const scale = baseScale * this.zoom;
    const ow = w * scale;
    const oh = h * scale;
    // Allow the world's edge to scroll up to half-screen off; any
    // further loses too much context.
    const slackX = Math.max(0, (ow - cw) * 0.5 + cw * 0.25);
    const slackY = Math.max(0, (oh - ch) * 0.5 + ch * 0.25);
    const maxPanX = slackX / dpr;
    const maxPanY = slackY / dpr;
    if (this.panX < -maxPanX) this.panX = -maxPanX;
    if (this.panX > maxPanX) this.panX = maxPanX;
    if (this.panY < -maxPanY) this.panY = -maxPanY;
    if (this.panY > maxPanY) this.panY = maxPanY;
  }

  render(
    colony: Colony, alpha: number, particles?: ParticleSystem,
    pheromones?: { dig: { current: Float32Array }; build: { current: Float32Array } },
  ): void {
    const w = this.world.width;
    const h = this.world.height;
    const cells = this.world.cells;
    const noise = this.world.soilNoise;
    const surfRow = this.world.naturalSurface;
    const digTick = this.world.digTick;
    const tick = this.world.tick;
    const data = this.buf;

    for (let y = 0; y < h; y++) {
      const skyT = y / Math.max(1, h * 0.5);
      const sky = lerp3(SKY_TOP, SKY_BOTTOM, Math.min(1, skyT));
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const k = cells[idx]!;
        let r: number, g: number, b: number;
        if (k === CELL_AIR) {
          if (y < surfRow[x]!) {
            [r, g, b] = sky;
          } else {
            // Below-surface air = tunnel. Lerp between TUNNEL_NEAR
            // (light, near surface) and TUNNEL_DEEP (dark, deep
            // underground). Real ant-farm tunnels read as paler than
            // the surrounding substrate near the top because light
            // gets in; deep down they go to shadow.
            const sy = surfRow[x]!;
            const depth = (y - sy) / Math.max(1, h - sy);
            const tunnel = lerp3(TUNNEL_NEAR, TUNNEL_DEEP, Math.min(1, depth * 1.4));
            r = tunnel[0]; g = tunnel[1]; b = tunnel[2];
            // Fresh dig: cells excavated within the last ~120 ticks
            // glow slightly lighter so the user can see WHERE the
            // colony is currently working.
            const age = tick - digTick[idx]!;
            if (age >= 0 && age < 120) {
              const t = 1 - age / 120;
              const tint = lerp3([r, g, b], FRESH_DIG, 0.5 * t);
              r = tint[0]; g = tint[1]; b = tint[2];
            }
          }
        } else if (k === CELL_SOIL) {
          const sy = surfRow[x]!;
          const t = (y - sy) / Math.max(1, h - sy);
          const soil = lerp3(SOIL_TOP, SOIL_BOTTOM, Math.min(1, t));
          const n = (noise[idx]! / 255 - 0.5) * 0.18;
          r = soil[0] * (1 + n);
          g = soil[1] * (1 + n);
          b = soil[2] * (1 + n);
          // Depth fog: darken substrate below ~80% of the world
          // height. Sells the cross-section as bottomless rather
          // than a hard floor. Only applied below a threshold so
          // the visible chamber stays bright.
          const depth = (y - sy) / Math.max(1, h - sy);
          if (depth > 0.55) {
            const f = (depth - 0.55) / 0.45;
            r *= 1 - 0.55 * f;
            g *= 1 - 0.55 * f;
            b *= 1 - 0.55 * f;
          }
        } else {
          // GRAIN — colour lerps fresh → worn by per-cell move count.
          // moves=1 (just dug & dropped) reads close to soil; many
          // re-handlings push it toward the bright weathered end.
          const moves = this.world.grainMoves[idx]!;
          const t = Math.min(1, moves / MOVE_COLOUR_CAP);
          const grain = lerp3(GRAIN_FRESH, GRAIN_WORN, t);
          const n = (noise[idx]! / 255 - 0.5) * 0.18;
          r = grain[0] * (1 + n);
          g = grain[1] * (1 + n);
          b = grain[2] * (1 + n);
        }
        // Food overlay. Food sits on top of (or inside) AIR cells,
        // independent of cell type. Draw it after the substrate so
        // the green completely covers the underlying air pixel.
        if (this.world.food[idx]! > 0) {
          const moves = this.world.foodMoves[idx]!;
          const t = Math.min(1, moves / MOVE_COLOUR_CAP);
          const food = lerp3(FOOD_FRESH, FOOD_WORN, t);
          r = food[0]; g = food[1]; b = food[2];
        }
        const o = idx * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    // Optional pheromone overlay. Each field is alpha-blended into
    // its pixel using a colour outside the terrain palette: cyan
    // (dig) and magenta (build). The intensity is normalised to a
    // soft cap so a single deposit doesn't blow out the picture.
    if (this.showPheromones && pheromones) {
      const dig = pheromones.dig.current;
      const build = pheromones.build.current;
      const CAP = 0.5;
      for (let i = 0; i < dig.length; i++) {
        const dv = Math.min(1, dig[i]! / CAP);
        const bv = Math.min(1, build[i]! / CAP);
        if (dv < 0.01 && bv < 0.01) continue;
        const o = i * 4;
        // Cyan = dig (boost B+G, dim R). Magenta = build (boost R+B, dim G).
        const ar = data[o]!;
        const ag = data[o + 1]!;
        const ab = data[o + 2]!;
        const aDig = dv * 0.55;
        const aBuild = bv * 0.55;
        // Compose dig over base, then build over that.
        let nr = ar * (1 - aDig) + 0  * aDig;
        let ng = ag * (1 - aDig) + 220 * aDig;
        let nb = ab * (1 - aDig) + 220 * aDig;
        nr = nr * (1 - aBuild) + 220 * aBuild;
        ng = ng * (1 - aBuild) + 0   * aBuild;
        nb = nb * (1 - aBuild) + 220 * aBuild;
        data[o]     = nr | 0;
        data[o + 1] = ng | 0;
        data[o + 2] = nb | 0;
      }
    }
    this.offCtx.putImageData(this.imageData, 0, 0);

    // Scale to viewport. Letterbox if aspect mismatch — the world has a
    // canonical aspect ratio (e.g. 12:7) we don't want to distort.
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    // baseScale is the fit-to-screen scale; the user's zoom multiplies
    // it. Pan is in CSS pixels and is multiplied to canvas pixels by
    // the device pixel ratio.
    const dpr = cw / parseFloat(this.canvas.style.width || `${cw}`);
    const baseScale = Math.min(cw / w, ch / h);
    const scale = baseScale * this.zoom;
    const ow = w * scale;
    const oh = h * scale;
    const ox = (cw - ow) * 0.5 + this.panX * dpr;
    const oy = (ch - oh) * 0.5 + this.panY * dpr;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, cw, ch);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.off, 0, 0, w, h, ox, oy, ow, oh);

    // Ant overlay.
    // Ant body radius. 0.55 of a scaled cell makes ants clearly
    // readable as creatures at any zoom; the previous 0.35 produced
    // sub-pixel legs at typical screen sizes and the ants got lost
    // against the substrate.
    const radius = Math.max(2, scale * 0.55);
    for (let i = 0; i < colony.count; i++) {
      const x = colony.prevX[i]! + (colony.posX[i]! - colony.prevX[i]!) * alpha;
      const y = colony.prevY[i]! + (colony.posY[i]! - colony.prevY[i]!) * alpha;
      const px = ox + x * scale;
      const py = oy + y * scale;
      const carry = colony.state[i] === STATE_CARRY;
      // Contact shadow: a small dim ellipse a fraction below the ant
      // anchors them to the substrate. Without it ants read as
      // floating overlay sprites instead of agents on the ground.
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      this.ctx.beginPath();
      this.ctx.ellipse(px, py + radius * 0.85, radius * 1.3, radius * 0.4, 0, 0, Math.PI * 2);
      this.ctx.fill();
      // Six legs, three per side. The walk phase comes from a hash of
      // (id, tick, distance moved) so ants in motion shuffle their
      // legs and stationary ants stay still. Lines are short and thin
      // — at small scales they read as a leggy silhouette rather than
      // distinct legs, which is what we want.
      const dxMoved = colony.posX[i]! - colony.prevX[i]!;
      const dyMoved = colony.posY[i]! - colony.prevY[i]!;
      const speed = Math.hypot(dxMoved, dyMoved);
      if (speed > 0.005) {
        const phase = (this.world.tick + i * 7) * 0.6 + speed * 4;
        const heading = colony.heading[i]!;
        const cosH = Math.cos(heading);
        const sinH = Math.sin(heading);
        this.ctx.strokeStyle = '#0f0805';
        this.ctx.lineWidth = Math.max(0.8, scale * 0.12);
        this.ctx.lineCap = 'round';
        for (let leg = 0; leg < 3; leg++) {
          const along = (leg - 1) * radius * 0.9;
          const swing = Math.sin(phase + leg * 1.1) * 0.45;
          for (const side of [-1, 1] as const) {
            const lx = along + swing * radius * 0.4;
            const ly = side * (radius * 0.6 + Math.abs(swing) * radius * 0.5);
            const ex = px + cosH * lx - sinH * ly;
            const ey = py + sinH * lx + cosH * ly;
            // Hip is a tiny inset so legs anchor to the body silhouette.
            const hx = px + cosH * along * 0.4 - sinH * (side * radius * 0.3);
            const hy = py + sinH * along * 0.4 + cosH * (side * radius * 0.3);
            this.ctx.beginPath();
            this.ctx.moveTo(hx, hy);
            this.ctx.lineTo(ex, ey);
            this.ctx.stroke();
          }
        }
      }
      this.ctx.fillStyle = '#1a0f08';
      this.ctx.beginPath();
      this.ctx.ellipse(px, py, radius * 1.4, radius, colony.heading[i]!, 0, Math.PI * 2);
      this.ctx.fill();
      if (carry) {
        this.ctx.fillStyle = GRAIN_COLOR_CSS;
        this.ctx.beginPath();
        this.ctx.arc(px, py - radius * 0.6, radius * 0.55, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }

    // Dust particles. Drawn after ants so they render in front, with
    // alpha proportional to remaining life.
    if (particles) {
      const dustR = Math.max(1, scale * 0.18);
      // highWater is one past the last live slot; iterating to it
      // skips the bulk of the ring buffer when there's no recent
      // dig activity (no allocation, no draws).
      for (let i = 0; i < particles.highWater; i++) {
        const life = particles.life[i]!;
        if (life <= 0) continue;
        const t = life / Math.max(1, particles.maxLife[i]!);
        this.ctx.fillStyle = `rgba(150, 110, 70, ${(t * 0.85).toFixed(3)})`;
        const dx = ox + particles.posX[i]! * scale;
        const dy = oy + particles.posY[i]! * scale;
        this.ctx.beginPath();
        this.ctx.arc(dx, dy, dustR, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }

    // "Glass case" frame: dark outer border + subtle vignette. Reads as
    // an enclosure rather than an unbounded plane, and the radial
    // darkening at the edges sells the implied depth.
    const borderPx = Math.max(2, Math.round(scale * 1.2));
    this.ctx.strokeStyle = 'rgba(20, 14, 10, 0.85)';
    this.ctx.lineWidth = borderPx;
    this.ctx.strokeRect(
      ox + borderPx * 0.5,
      oy + borderPx * 0.5,
      ow - borderPx,
      oh - borderPx,
    );
    const grad = this.ctx.createRadialGradient(
      ox + ow * 0.5, oy + oh * 0.5, Math.min(ow, oh) * 0.45,
      ox + ow * 0.5, oy + oh * 0.5, Math.max(ow, oh) * 0.75,
    );
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(ox, oy, ow, oh);
  }
}

const GRAIN_COLOR_CSS = `rgb(${GRAIN_COLOR[0]}, ${GRAIN_COLOR[1]}, ${GRAIN_COLOR[2]})`;
