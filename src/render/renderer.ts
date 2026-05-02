// Canvas2D renderer. Two passes:
//   1. Terrain: putImageData of the cell grid, scaled up nearest-neighbor
//      to viewport. Soil gets per-cell hash noise + a "fresh dig" tint
//      so excavated cells briefly glow lighter.
//   2. Ants: stroked ovals on top of the scaled terrain, interpolated
//      between prev and current positions for smooth motion.
//
// Renderer reads sim state. Never writes. (CLAUDE.md invariant.)

import {
  STATE_CARRY, STATE_CARRY_FOOD, STATE_DEAD, STATE_EGG, STATE_FORAGE, STATE_LARVA,
  STATE_NECRO_CARRY, STATE_PUPA, STATE_QUEEN, STATE_REST,
} from '../sim/colony';
import { CELL_AIR, CELL_SOIL, DAY_TICKS } from '../sim/world';
import { GLTerrainRenderer } from './gl-terrain';

// Renderer reads a structural subset of World/Colony — same field
// names so both the live class instances and the worker's
// RenderSnapshot satisfy this duck-typed contract. Renderer never
// writes to sim state (CLAUDE.md invariant), so this is read-only
// in spirit.
export interface RenderableWorld {
  width: number;
  height: number;
  tick: number;
  cells: Uint8Array;
  soilNoise: Uint8Array;
  naturalSurface: Uint16Array;
  food: Uint8Array;
  foodMoves: Uint8Array;
  corpse: Uint8Array;
  sprout: Uint8Array;
  sproutTick: Int32Array;
  digTick: Int32Array;
  plant: Uint8Array;
  plantHeight: Uint16Array;
  bgPlant: Uint8Array;
  bgPlantHeight: Uint16Array;
}

export interface RenderableColony {
  count: number;
  posX: Float32Array;
  posY: Float32Array;
  prevX: Float32Array;
  prevY: Float32Array;
  heading: Float32Array;
  state: Uint8Array;
  energy: Float32Array;
}

export interface RenderableParticles {
  posX: Float32Array;
  posY: Float32Array;
  life: Int16Array;
  maxLife: Int16Array;
  highWater: number;
}

// Sky palette is two pairs: a NIGHT pair (cool deep blue, near-black at
// the horizon) and a DAY pair (pale slate above, hazy off-white at the
// horizon). The render() pass lerps between them based on the
// `daylight` parameter (0 = midnight, 1 = noon). At the dawn/dusk
// shoulder the lerp produces a warm muted in-between, which is fine
// for a screensaver — adding a separate sunrise/sunset accent would
// require a triple-key lerp and isn't worth the complexity.
const SKY_TOP_NIGHT: [number, number, number] = [10, 14, 28];
const SKY_BOTTOM_NIGHT: [number, number, number] = [22, 22, 36];
const SKY_TOP_DAY: [number, number, number] = [120, 145, 180];
const SKY_BOTTOM_DAY: [number, number, number] = [185, 195, 215];
// Tunnel air. Real ant-farm tunnels are LIGHTER than the surrounding
// substrate — light enters from the top, dust on the gel reflects, the
// dug area reads as paler than the dirt. The previous TUNNEL value
// (38,27,18) was darker than mid-soil (70,42,22) so excavations
// looked like ink stains. TUNNEL_NEAR is what air close to the
// surface looks like; TUNNEL_DEEP is the deep-tunnel color the depth
// fog blends toward.
const TUNNEL_NEAR: [number, number, number] = [148, 110, 78];
const TUNNEL_DEEP: [number, number, number] = [42, 28, 20];
// Solid soil — single dark palette. GRAIN cells (excavated spoil)
// share this palette: a real Pogonomyrmex mound and the undisturbed
// substrate around it are made of the same earth and look visually
// indistinguishable; the only cue that something is "mound" rather
// than "ground" is its position above the natural surface row.
const SOIL_TOP: [number, number, number] = [56, 35, 18];
const SOIL_BOTTOM: [number, number, number] = [32, 18, 9];
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

/** Returns true if the cell at (cellX, cellY) in world coords is
 *  inside any plant's silhouette (foreground OR background skyline).
 *  Mirrors the GL fragment shader's two plant-render scans so the
 *  Canvas2D star-occlusion path picks the same pixels the shader
 *  paints over. */
function plantCovers(world: RenderableWorld, cellX: number, cellY: number): boolean {
  const w = world.width;
  // Foreground scan — kind-based radii, matches GL FG branch.
  for (let dx = -5; dx <= 5; dx++) {
    const nx = cellX + dx;
    if (nx < 0 || nx >= w) continue;
    const kind = world.plant[nx]!;
    if (kind === 0) continue;
    const h = world.plantHeight[nx]!;
    if (h === 0) continue;
    const surf = world.naturalSurface[nx]!;
    const base = surf - 1;
    const top = surf - h;
    if (cellY > base || cellY < top) continue;
    const trunkCells = kind === 1 ? 0 : kind === 2 ? 1 : Math.max(1, Math.floor(h / 6));
    const inTrunk = trunkCells > 0 && cellY > base - trunkCells;
    const trunkRadius = kind === 1 ? 0 : kind === 2 ? 1 : 2;
    const canopyRadius = kind === 1 ? 0 : kind === 2 ? 3 : 5;
    const reqRadius = inTrunk ? trunkRadius : canopyRadius;
    const absDx = dx < 0 ? -dx : dx;
    if (absDx <= reqRadius) return true;
  }
  // Background scan — only the NEAR BG plants (distClass 0-1) occlude
  // stars; far ones (distClass 2-3) are too hazy to block. Matches the
  // GL BG branch's distance-modulated rendering.
  for (let dx = -8; dx <= 8; dx++) {
    const nx = cellX + dx;
    if (nx < 0 || nx >= w) continue;
    const kind = world.bgPlant[nx]!;
    if (kind === 0) continue;
    const h = world.bgPlantHeight[nx]!;
    if (h === 0) continue;
    const distClass = (world.soilNoise[nx]! >> 4) & 3;
    if (distClass >= 2) continue;
    const surf = world.naturalSurface[nx]!;
    const base = surf - 1 + distClass;
    const top = surf - h + distClass;
    if (cellY > base || cellY < top) continue;
    const trunkCells = kind === 1 ? 0 : kind === 2 ? 1 : Math.max(1, Math.floor(h / 6));
    const inTrunk = trunkCells > 0 && cellY > base - trunkCells;
    const distScale = 1.0 - distClass * 0.18;
    const trunkR0 = kind === 1 ? 0 : kind === 2 ? 2 : 3;
    const canopyR0 = kind === 1 ? 1 : kind === 2 ? 5 : 8;
    const trunkRadius = Math.max(0, Math.round(trunkR0 * distScale));
    const canopyRadius = Math.max(0, Math.round(canopyR0 * distScale));
    const reqRadius = inTrunk ? trunkRadius : canopyRadius;
    const absDx = dx < 0 ? -dx : dx;
    if (absDx <= reqRadius) return true;
  }
  return false;
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
  private world: RenderableWorld;

  /** Sub-cell rendering scale. Each sim cell maps to SUB×SUB
   *  pixels in the offscreen buffer; per-sub-cell variation
   *  (driven by world.soilNoise) breaks up the blocky appearance
   *  without changing sim resolution. Bumped 2→4: each sim cell
   *  now occupies 16 framebuffer pixels, giving room for finer
   *  sub-cell shading (rim light, AO, multi-octave noise) and
   *  smoother edges at the cost of 4× framebuffer memory
   *  (~600 KB → ~2.4 MB at default world dims, trivial). */
  private readonly SUB = 4;

  /** Pre-baked star field for the night sky. Positions in normalized
   *  (0..1) sky-rectangle space; each star has a stable twinkle phase
   *  and base brightness so the field reads natural. Generated once
   *  at construction; the same stars persist for the entire run. */
  private readonly stars: ReadonlyArray<{
    x: number; y: number; brightness: number; phase: number;
    size: number; tint: [number, number, number];
  }>;

  /** WebGL2 terrain + pheromone-overlay renderer. Owns its own
   *  canvas, sized identically to the offscreen Canvas2D buffer.
   *  When non-null, terrain rendering offloads to a fragment
   *  shader and the per-pixel CPU loop is skipped. Falls back to
   *  the Canvas2D path when WebGL2 isn't supported (very old
   *  hardware, screensaver runtimes without 3D acceleration). */
  private gltr: GLTerrainRenderer | null;

  constructor(canvas: HTMLCanvasElement, world: RenderableWorld) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d context not available');
    this.ctx = ctx;
    this.world = world;
    this.off = document.createElement('canvas');
    this.off.width = world.width * this.SUB;
    this.off.height = world.height * this.SUB;
    const offCtx = this.off.getContext('2d', { alpha: false });
    if (!offCtx) throw new Error('off-screen 2d context not available');
    this.offCtx = offCtx;
    this.imageData = this.offCtx.createImageData(world.width * this.SUB, world.height * this.SUB);
    this.buf = this.imageData.data;
    // Try WebGL2; on failure we keep the Canvas2D pixel loop as a
    // backwards-compatible fallback. Errors here aren't fatal — they
    // just mean the user falls back to the slower path.
    try {
      this.gltr = new GLTerrainRenderer(world.width, world.height, this.SUB);
    } catch (err) {
      console.warn('GL terrain renderer init failed; using CPU fallback', err);
      this.gltr = null;
    }
    // Star field. Density picked so a typical viewport shows ~80
    // stars — sparse enough that you can see individual ones, dense
    // enough that the sky doesn't read as empty. Most stars are
    // small white dots; a few are brighter and warmer (yellow/orange)
    // or cooler (blue) to break up the monochrome look. Mulberry32
    // PRNG inline so the field is the same every run without
    // pulling sim/rng (renderer is sim-independent).
    let seed = 0x9e3779b1;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const stars: { x: number; y: number; brightness: number; phase: number;
      size: number; tint: [number, number, number] }[] = [];
    for (let i = 0; i < 120; i++) {
      const r = rand();
      let tint: [number, number, number];
      if (r < 0.05) tint = [255, 210, 160]; // warm giant
      else if (r < 0.10) tint = [180, 200, 255]; // blue-white
      else tint = [240, 240, 245]; // typical white
      stars.push({
        x: rand(),
        // Bias toward the upper half of the sky band — feels closer
        // to a real horizon view (more stars overhead than near the
        // horizon haze).
        y: rand() * rand(),
        brightness: 0.3 + rand() * 0.7,
        phase: rand() * Math.PI * 2,
        size: 0.6 + rand() * 1.4,
        tint,
      });
    }
    this.stars = stars;
  }

  /** Toggleable pheromone-field overlay. Off by default; flip with
   *  the 'p' key in the live UI. Two fields are blended with
   *  translucent unused colours so they don't conflict with the
   *  brown/green/tan terrain palette: cyan = dig, magenta = build. */
  showPheromones = false;
  /** Last pheromone payload received, cached so throttled frames
   *  (the main render loop only requests fresh pheromone data
   *  every Nth frame to keep the snapshot transfer cost down) can
   *  still render the overlay. */
  private cachedPheromones: {
    dig: { current: Float32Array };
    build: { current: Float32Array };
    trail?: { current: Float32Array };
    alarm?: { current: Float32Array };
    queen?: { current: Float32Array };
    brood?: { current: Float32Array };
    necro?: { current: Float32Array };
    noEntry?: { current: Float32Array };
    granary?: { current: Float32Array };
    trunk?: { current: Float32Array };
  } | undefined;
  /** Toggleable mini-map in the bottom-right corner. On by default
   *  — at zoom 1 it's small enough to ignore, and at higher zooms
   *  the viewport indicator gives the user a "you are here" cue. */
  showMinimap = true;

  /** Burn-in-prevention mode for actual screensaver / always-on
   *  desktop-background use. When enabled, the entire rendered
   *  canvas drifts on a slow Lissajous trajectory so every screen
   *  pixel cycles through a band of scene values over ~2-minute
   *  periods. Without drift, even a slowly-evolving sim can leave
   *  static-bright pixels (HUD, sky-near-top, deep-soil-bottom)
   *  imprinted on OLED panels over many hours. The day/night cycle
   *  already exercises most pixels through a wide colour range
   *  every 14 wall-minutes (at default 8× speed) — drift handles
   *  the residual. Off by default for normal viewing; enable with
   *  ?screensaver=1 URL param.
   *
   *  HUD burn-in is handled separately in main.ts (the screensaver
   *  flag hides the HUD entirely). */
  screensaver = false;
  /** Wall-time anchor for the screensaver drift. */
  private screensaverStartMs = performance.now();

  /** User zoom factor (1.0 = fit-to-screen). Mutated by main's pinch /
   *  wheel handlers. */
  zoom = 1;
  /** User pan in viewport pixels. Reset to (0,0) when zoom returns to 1. */
  panX = 0;
  panY = 0;

  /** Swap in a freshly-generated World. Width and height must match
   *  the existing offscreen canvas; the renderer assumes that. */
  setWorld(world: RenderableWorld): void {
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

  /**
   * Pick the closest ant to a screen-pixel point. Returns -1 if no
   * live ant is within `maxCells` of the click in world space. Used
   * by main.ts to wire click-to-inspect: the user taps a worker, we
   * look up the nearest one, the HUD pins its state. The hit radius
   * is generous (default 2 cells) so the user doesn't have to land
   * the cursor exactly on a 6 mm ant.
   */
  pickAnt(
    screenX: number, screenY: number,
    colony: RenderableColony,
    maxCells = 2,
  ): number {
    const w = this.screenToWorld(screenX, screenY);
    let bestIdx = -1;
    let bestDist = maxCells * maxCells;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i]!;
      if (s === STATE_DEAD) continue;
      const dx = colony.posX[i]! - w.x;
      const dy = colony.posY[i]! - w.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
    }
    return bestIdx;
  }

  /** Burn-in prevention drift. Returns a (dx, dy) offset in CSS
   *  pixels that the renderer applies via ctx.translate() at the
   *  start of render(). Lissajous with two prime-period axes so
   *  the pattern doesn't visibly repeat. Amplitude 24 px on x,
   *  16 px on y — large enough that any static bright pixel
   *  cycles through 32-48 different scene positions, well past
   *  the imprint threshold for OLED panels. */
  private screensaverDrift(): { dx: number; dy: number } {
    if (!this.screensaver) return { dx: 0, dy: 0 };
    const t = (performance.now() - this.screensaverStartMs) / 1000;
    // Periods 137 s and 89 s. Both prime, so the LCM is ~3.4 hours
    // before the trajectory repeats — burn-in protection across
    // overnight idle.
    const dx = Math.cos(t * 2 * Math.PI / 137) * 24;
    const dy = Math.sin(t * 2 * Math.PI / 89) * 16;
    return { dx, dy };
  }

  render(
    colony: RenderableColony, alpha: number, particles?: RenderableParticles,
    pheromones?: {
      dig: { current: Float32Array };
      build: { current: Float32Array };
      trail?: { current: Float32Array };
      alarm?: { current: Float32Array };
      queen?: { current: Float32Array };
      brood?: { current: Float32Array };
      necro?: { current: Float32Array };
      noEntry?: { current: Float32Array };
      granary?: { current: Float32Array };
      trunk?: { current: Float32Array };
    },
    daylight = 1,
    selectedId = -1,
  ): void {
    const w = this.world.width;
    const h = this.world.height;
    const cells = this.world.cells;
    const noise = this.world.soilNoise;
    const surfRow = this.world.naturalSurface;
    const digTick = this.world.digTick;
    const tick = this.world.tick;
    const data = this.buf;
    // Pheromone-snapshot throttling. Main only requests fresh
    // pheromone data every Nth frame; on the in-between frames the
    // caller passes `pheromones=undefined`. Re-use the last
    // received payload so the overlay keeps rendering. The first
    // overlay-on frame before any data has arrived stays
    // overlay-off — that's a single sub-100ms warm-up gap.
    if (pheromones) this.cachedPheromones = pheromones;
    pheromones = this.cachedPheromones;
    // GL fast-path: a single fragment shader does terrain +
    // pheromone overlay in one pass, replacing the per-pixel CPU
    // loop and the second per-cell pheromone composite. We still
    // need the rest of the render() body (celestial, ants,
    // particles, frame, mini-map) so the body doesn't return — it
    // just skips the CPU-pixel work below.
    const useGL = this.gltr !== null;
    if (this.gltr !== null) {
      this.gltr.render(this.world, daylight, this.showPheromones,
        pheromones ? {
          dig: pheromones.dig.current,
          build: pheromones.build.current,
          trail: pheromones.trail?.current ?? new Float32Array(0),
          alarm: pheromones.alarm?.current ?? new Float32Array(0),
          queen: pheromones.queen?.current ?? new Float32Array(0),
          brood: pheromones.brood?.current ?? new Float32Array(0),
          necro: pheromones.necro?.current ?? new Float32Array(0),
          noEntry: pheromones.noEntry?.current ?? new Float32Array(0),
          granary: pheromones.granary?.current ?? new Float32Array(0),
          trunk: pheromones.trunk?.current ?? new Float32Array(0),
        } : null);
    }

    // Sky palette lerps between night and day pairs by the daylight
    // parameter passed in by main(). Computed once outside the pixel
    // loop — every air pixel above the natural surface uses the same
    // pair of stops, just at different vertical fractions.
    const skyTop = lerp3(SKY_TOP_NIGHT, SKY_TOP_DAY, daylight);
    const skyBottom = lerp3(SKY_BOTTOM_NIGHT, SKY_BOTTOM_DAY, daylight);

    if (!useGL) for (let y = 0; y < h; y++) {
      const skyT = y / Math.max(1, h * 0.5);
      const sky = lerp3(skyTop, skyBottom, Math.min(1, skyT));
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
          // Per-cell luminance perturbation. Stronger (±18%) than the
          // legacy ±9% so the soil reads as visibly textured rather
          // than uniformly dark. Combined with the per-subcell noise
          // below, this gives chamber walls a granular look closer
          // to a packed-soil cross-section photo.
          const n = (noise[idx]! / 255 - 0.5) * 0.36;
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
          // GRAIN — render with the SOIL palette. Real spoil mounds
          // and undisturbed soil are made of the same earth and look
          // visually indistinguishable; the previous fresh→worn
          // lighter lerp made spoil heaps tan-coloured against the
          // brown undisturbed substrate, which read as a different
          // material. All soil stays brown forever; the only way to
          // tell mound from undisturbed ground is its position above
          // the natural surface row.
          const sy = surfRow[x]!;
          const t = (y - sy) / Math.max(1, h - sy);
          const soil = lerp3(SOIL_TOP, SOIL_BOTTOM, Math.min(1, t));
          const n = (noise[idx]! / 255 - 0.5) * 0.36;
          r = soil[0] * (1 + n);
          g = soil[1] * (1 + n);
          b = soil[2] * (1 + n);
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
        // Corpse marker — overrides everything else for that cell so
        // dead-worker spots show up clearly even if the cell also
        // had food in it. A dim purplish-grey reads as "ex-ant" against
        // the brown/green palette without competing with live ants.
        if (this.world.corpse[idx]! > 0) {
          r = 90; g = 70; b = 92;
        }
        // Sprout marker — a small bright-green pixel for cells where
        // a stored seed has germinated. The sprout cell uses a
        // markedly brighter green than fresh food so the viewer can
        // tell "an old seed sprouted" apart from "a new seed
        // arrived". Brightness ramps with sprout age so freshly-
        // germinated cells are dim and mature ones pop.
        if (this.world.sprout[idx]! > 0) {
          const age = tick - this.world.sproutTick[idx]!;
          // Half-bright at age 0, full bright by ~1000 ticks, then
          // hold to lifetimeTicks where decay clears the cell.
          const t = Math.min(1, Math.max(0.4, age / 1000));
          r = 70 * t; g = 230 * t; b = 50 * t;
        }
        // Write SUB×SUB sub-pixels for this sim cell. SOIL/GRAIN get
        // a per-sub-cell luminance perturbation derived from the
        // per-cell soilNoise plus the sub-cell index — adds intra-
        // cell texture that breaks up the blocky look without
        // changing sim resolution. AIR cells (sky and tunnel) skip
        // the perturbation: they have no material to texture and the
        // hash showed up as a paper-grain speckle on the daytime sky.
        const SUB = this.SUB;
        const subBase = noise[idx]!;
        const isAir = k === CELL_AIR;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            let sr: number, sg: number, sb: number;
            if (isAir) {
              sr = r; sg = g; sb = b;
            } else {
              const subI = sy * SUB + sx;
              const subN = ((subBase + subI * 67) & 0xff) / 255 - 0.5;
              // Bumped 0.10 → 0.20 so per-subcell variation reads
              // as visible grain (sand-grit) at typical zoom rather
              // than just slight luminance noise.
              const PERT = 0.20;
              sr = r * (1 + subN * PERT);
              sg = g * (1 + subN * PERT);
              sb = b * (1 + subN * PERT);
            }
            const so = ((y * SUB + sy) * (w * SUB) + (x * SUB + sx)) * 4;
            data[so] = sr < 0 ? 0 : sr > 255 ? 255 : sr;
            data[so + 1] = sg < 0 ? 0 : sg > 255 ? 255 : sg;
            data[so + 2] = sb < 0 ? 0 : sb > 255 ? 255 : sb;
            data[so + 3] = 255;
          }
        }
      }
    }
    // Optional pheromone overlay. Each field is alpha-blended into
    // its pixel using a colour outside the terrain palette: cyan
    // (dig) and magenta (build). The intensity is normalised to a
    // soft cap so a single deposit doesn't blow out the picture.
    if (!useGL && this.showPheromones && pheromones) {
      const dig = pheromones.dig.current;
      const build = pheromones.build.current;
      const trail = pheromones.trail?.current;
      const alarm = pheromones.alarm?.current;
      const queen = pheromones.queen?.current;
      const brood = pheromones.brood?.current;
      const necro = pheromones.necro?.current;
      const noEntry = pheromones.noEntry?.current;
      const granary = pheromones.granary?.current;
      const trunk = pheromones.trunk?.current;
      // Per-field cap values picked so cells at peak concentration
      // saturate to ~1.0 contribution. Calibrated from the deposit
      // rate × retention half-life of each field.
      //   dig/build: 0.5 (deposit 1.0 on rare events)
      //   trail:     0.5 (volatile, decays fast)
      //   alarm:     0.15 (small per-deposit amounts)
      //   queen:     4.0 (continuous emission, long half-life)
      //   brood:     1.5 (continuous emission per larva)
      //   necro:     0.8 (continuous emission per corpse)
      //   no-entry:  2.0 (slow accumulation by unproductive WANDER)
      //   granary:   4.0 (rare strong deposits, long half-life)
      //   trunk:     5.0 (cumulative over many foraging trips)
      // We composite ADDITIVELY rather than alpha-stacking — each
      // layer pushes the cell color toward its target by
      // (target - current) * intensity * weight. This produces
      // order-independent blending and lets weak signals from many
      // fields combine without later layers wiping out earlier ones.
      const W = 0.55;
      const SUB = this.SUB;
      const sw = w * SUB;
      // Single-cell composite then write to all SUB×SUB sub-pixels.
      // The pheromone field itself is per-cell so within a cell all
      // sub-pixels get the same overlay tint. Variation in the
      // underlying terrain shows through unchanged because we read
      // each sub-pixel's pre-overlay RGB.
      for (let i = 0; i < dig.length; i++) {
        const dv = Math.min(1, dig[i]! / 0.5);
        const bv = Math.min(1, build[i]! / 0.5);
        const tv = trail ? Math.min(1, trail[i]! / 0.5) : 0;
        const av = alarm ? Math.min(1, alarm[i]! / 0.15) : 0;
        const qv = queen ? Math.min(1, queen[i]! / 4) : 0;
        const brv = brood ? Math.min(1, brood[i]! / 1.5) : 0;
        const nv = necro ? Math.min(1, necro[i]! / 0.8) : 0;
        const xv = noEntry ? Math.min(1, noEntry[i]! / 2) : 0;
        const gv = granary ? Math.min(1, granary[i]! / 4) : 0;
        const tkv = trunk ? Math.min(1, trunk[i]! / 5) : 0;
        if (
          dv < 0.01 && bv < 0.01 && tv < 0.01 && av < 0.01 && qv < 0.01 &&
          brv < 0.01 && nv < 0.01 && xv < 0.01 && gv < 0.01 && tkv < 0.01
        ) continue;
        const cy = (i / w) | 0;
        const cx = i - cy * w;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const so = ((cy * SUB + sy) * sw + (cx * SUB + sx)) * 4;
            let r = data[so]!;
            let g = data[so + 1]!;
            let b = data[so + 2]!;
            // Color targets — see overlay legend in HUD.
            r += (0   - r) * dv  * W; g += (220 - g) * dv  * W; b += (220 - b) * dv  * W;
            r += (220 - r) * bv  * W; g += (0   - g) * bv  * W; b += (220 - b) * bv  * W;
            r += (240 - r) * tv  * W; g += (220 - g) * tv  * W; b += (60  - b) * tv  * W;
            r += (255 - r) * av  * 0.75; g += (30  - g) * av  * 0.75; b += (30  - b) * av  * 0.75;
            r += (110 - r) * qv  * W; g += (70  - g) * qv  * W; b += (200 - b) * qv  * W;
            r += (255 - r) * brv * W; g += (180 - g) * brv * W; b += (180 - b) * brv * W;
            r += (140 - r) * nv  * W; g += (130 - g) * nv  * W; b += (50  - b) * nv  * W;
            r += (140 - r) * xv  * W; g += (150 - g) * xv  * W; b += (170 - b) * xv  * W;
            r += (255 - r) * gv  * W; g += (160 - g) * gv  * W; b += (60  - b) * gv  * W;
            r += (200 - r) * tkv * W; g += (170 - g) * tkv * W; b += (30  - b) * tkv * W;
            data[so]     = r < 0 ? 0 : r > 255 ? 255 : r | 0;
            data[so + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
            data[so + 2] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
          }
        }
      }
    }
    if (!useGL) this.offCtx.putImageData(this.imageData, 0, 0);
    // Source canvas for the visible-canvas drawImage and the mini-map.
    // GL path uses the GL canvas (already rendered); CPU path uses
    // the offscreen Canvas2D buffer that just received putImageData.
    const terrainSource = useGL ? this.gltr!.canvas : this.off;

    // Burn-in-prevention drift. Applied as a uniform translate to
    // the visible canvas so terrain, ants, celestial, AND the
    // minimap all shift together. The black fill behind the
    // letterbox covers any newly-exposed canvas pixels at the drift
    // edges. Off when screensaver mode is disabled (drift returns
    // 0,0). Done as ctx.translate rather than offset arithmetic so
    // every subsequent draw call inherits the shift without
    // touching individual position math.
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const drift = this.screensaverDrift();
    this.ctx.save();
    if (drift.dx !== 0 || drift.dy !== 0) {
      const dprForDrift = this.canvas.width / parseFloat(this.canvas.style.width || `${this.canvas.width}`);
      this.ctx.translate(drift.dx * dprForDrift, drift.dy * dprForDrift);
    }

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
    // Black-fill happens before the screensaver-drift translate; see
    // the fillRect call earlier in render(). Translate is in effect
    // now, so all subsequent draws drift uniformly.
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(terrainSource, 0, 0, w * this.SUB, h * this.SUB, ox, oy, ow, oh);

    // Celestial layer. Drawn on the visible canvas (not into the
    // pixel buffer) so the sun/moon and stars are crisp vector
    // shapes that don't pixelate at high zoom. Clipped to the sky
    // band — the rectangle from the top of the world down to the
    // highest natural-surface peak — so they never appear over
    // soil or the cross-section. The sky band spans the columns of
    // the world image at the current scale.
    let minSurf = surfRow[0]!;
    for (let x = 1; x < w; x++) if (surfRow[x]! < minSurf) minSurf = surfRow[x]!;
    const skyHeightPx = Math.max(0, minSurf * scale);
    if (skyHeightPx > 4) {
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(ox, oy, ow, skyHeightPx);
      this.ctx.clip();

      // Day-night phase. tick=0 is solar midnight; phase 0.25 = sunrise,
      // 0.5 = noon, 0.75 = sunset. See sim/world.ts daylight().
      const phase = (tick % DAY_TICKS) / DAY_TICKS;

      // Stars. Visible while the sun is below the horizon (phase ∉
      // [0.25, 0.75]). Fade smoothly through the dawn/dusk shoulder
      // so they don't pop. starAlpha = 1 at full night, 0 at full day.
      const starAlpha = Math.max(0, 1 - daylight * 1.4);
      if (starAlpha > 0.01) {
        const tw = ow;
        const th = skyHeightPx;
        for (let i = 0; i < this.stars.length; i++) {
          const s = this.stars[i]!;
          const sx = ox + s.x * tw;
          const sy = oy + s.y * th;
          // Plant occlusion: skip stars that fall inside any plant's
          // silhouette. The same scan-±N-columns logic the GL shader
          // uses for plant rendering — keeps the two paths in sync.
          const cellX = Math.floor((sx - ox) / scale);
          const cellY = Math.floor((sy - oy) / scale);
          if (plantCovers(this.world, cellX, cellY)) continue;
          // Slow per-star twinkle. Period ~5–8 s at 60 fps. The
          // 0.4..1.0 envelope keeps stars visible at the trough.
          const twk = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(tick * 0.06 + s.phase));
          const a = starAlpha * s.brightness * twk;
          const r = s.tint[0]; const g = s.tint[1]; const b = s.tint[2];
          this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
          this.ctx.beginPath();
          this.ctx.arc(sx, sy, s.size, 0, Math.PI * 2);
          this.ctx.fill();
        }
      }

      // Sun and moon as celestial bodies on a virtual sphere, mapped
      // to a parabolic-style arc. The sun's angular position drives
      // both the diel cycle and (with a 28-day offset) the moon's
      // position. Lunar phase emerges geometrically from the angle
      // between sun and moon as seen from the viewer:
      //   - new moon: ΔL ≈ 0     → sun and moon co-located, lit
      //                             face away from us, fully dark.
      //   - first quarter: ΔL = π/2 → 50% lit, rises at noon.
      //   - full moon: ΔL = π     → 180° apart, lit face toward us,
      //                             100% lit, rises at sunset.
      //   - last quarter: ΔL = 3π/2 → rises at midnight.
      //
      // Angular convention: θ = 0 → body overhead, θ = ±π/2 → on the
      // horizon (-π/2 east/rising, +π/2 west/setting), |θ| > π/2 →
      // below horizon. screen-x increases with sin(θ) (rising on
      // left, setting on right); screen-y is high near apex via
      // cos(θ).
      const skyTop = oy;
      const skyBottom = oy + skyHeightPx;
      const peakY = skyTop + skyHeightPx * 0.15;
      const horizonY = skyBottom - skyHeightPx * 0.05;
      const bodyR = Math.max(6, Math.min(skyHeightPx * 0.07, ow * 0.025));
      // Lunar cycle: 28 sim days. Uses world.tick directly (rather
      // than the daily-mod phase) so the offset accumulates across
      // days rather than resetting each midnight. dL ∈ [0, 2π).
      const LUNAR_DAYS = 28;
      const dL = ((tick / DAY_TICKS / LUNAR_DAYS) % 1) * Math.PI * 2;
      // Sun's angular position. phase=0 is solar midnight, so
      // θ_sun = (phase − 0.5) · 2π puts noon at θ=0 (overhead),
      // sunrise at θ=−π/2 (east), sunset at θ=+π/2 (west), midnight
      // at θ=±π (directly below).
      const thetaSun = (phase - 0.5) * Math.PI * 2;
      // Moon lags the sun in the daily arc — real moon orbits in the
      // same direction Earth rotates, but slower, so each day the
      // moon's azimuth falls ~13° behind the sun's (rises ~50 min
      // later). θ_moon = θ_sun − dL gives the correct rise/set
      // timing across the lunar cycle:
      //   day 0 (new, dL=0):    moon co-located with sun.
      //   day 7 (dL=π/2):       at noon, moon at east horizon →
      //                          first quarter rises at noon. ✓
      //   day 14 (dL=π):        at sunset, moon at east horizon →
      //                          full moon rises at sunset. ✓
      //   day 21 (dL=3π/2):     at midnight, moon at east horizon →
      //                          last quarter rises at midnight. ✓
      const thetaMoon = thetaSun - dL;
      // Mapping from angular position θ to screen coords. Used both
      // for the visible-bodies path and to compute the sun's virtual
      // position when below the horizon (needed for moon-shadow
      // direction).
      const bodyScreenPos = (theta: number): { x: number; y: number; visible: boolean } => {
        const tn = Math.atan2(Math.sin(theta), Math.cos(theta)); // wrap to [-π, π]
        const altitude = Math.cos(tn); // +1 overhead, -1 below
        // Linear horizontal sweep east→overhead→west, scaled to ow.
        // Use sin for the screen-x so apex sits at ow/2 and limbs at
        // 0 / ow regardless of altitude sign.
        const x = ox + ow * (Math.sin(tn) * 0.5 + 0.5);
        // Parabolic-ish y: at altitude 0 → horizonY, at altitude 1 →
        // peakY. Negative altitudes extend below horizon for the
        // virtual-sun calculation.
        const y = horizonY + (peakY - horizonY) * altitude;
        return { x, y, visible: altitude > 0 };
      };
      const sunPos = bodyScreenPos(thetaSun);
      const moonPos = bodyScreenPos(thetaMoon);
      // Plant occlusion clip helper. Builds a path that includes
      // only cells in the disc area NOT covered by a foreground or
      // background plant; subsequent draws inside the clip skip
      // plant-covered pixels entirely. Result: trees render on top
      // of sun/moon as they should, without requiring sun/moon to
      // move into the GL pass.
      const clipDiscOutsidePlants = (cx: number, cy: number, r: number): void => {
        const bb = Math.ceil(r / scale + 1);
        const cellX = Math.floor((cx - ox) / scale);
        const cellY = Math.floor((cy - oy) / scale);
        this.ctx.save();
        this.ctx.beginPath();
        for (let dy = -bb; dy <= bb; dy++) {
          for (let dx = -bb; dx <= bb; dx++) {
            const wx = cellX + dx;
            const wy = cellY + dy;
            if (wx < 0 || wy < 0 || wx >= this.world.width || wy >= this.world.height) continue;
            if (plantCovers(this.world, wx, wy)) continue;
            this.ctx.rect(ox + wx * scale, oy + wy * scale, scale + 0.5, scale + 0.5);
          }
        }
        this.ctx.clip();
      };
      if (sunPos.visible) {
        clipDiscOutsidePlants(sunPos.x, sunPos.y, bodyR * 3.5);
        // Soft halo + bright disc. The halo is a radial gradient that
        // fades the warm tint into transparency over 3× the disc
        // radius — sells the "atmospheric scatter" without costing
        // per-pixel work.
        const g = this.ctx.createRadialGradient(sunPos.x, sunPos.y, 0, sunPos.x, sunPos.y, bodyR * 3.5);
        g.addColorStop(0, 'rgba(255, 230, 160, 0.55)');
        g.addColorStop(0.5, 'rgba(255, 200, 120, 0.18)');
        g.addColorStop(1, 'rgba(255, 200, 120, 0)');
        this.ctx.fillStyle = g;
        this.ctx.beginPath();
        this.ctx.arc(sunPos.x, sunPos.y, bodyR * 3.5, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.fillStyle = 'rgb(255, 240, 190)';
        this.ctx.beginPath();
        this.ctx.arc(sunPos.x, sunPos.y, bodyR, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.restore();
      }
      if (moonPos.visible) {
        clipDiscOutsidePlants(moonPos.x, moonPos.y, bodyR * 1.5);
        // One sphere lit from the side. Drawn as a moon disc with a
        // shadow disc on top, both clipped to the moon's outline so
        // the shadow can never render outside the lit body. Without
        // the clip, at higher offsetMag the shadow disc renders next
        // to the moon as a separate circle, giving the bug the user
        // pointed out — "two circles next to each other, not one
        // sphere lit from the side."
        //
        // Lit fraction k = (1 − cos ΔL) / 2 (0 at new, 1 at full).
        // Shadow disc is offset along the unit vector pointing AWAY
        // from the sun. Offset magnitude m = 2·bodyR · k:
        //   new (ΔL=0):    m = 0          → shadow covers whole moon
        //   quarter (π/2): m = bodyR      → terminator at moon centre
        //   full (π):      m = 2·bodyR    → shadow entirely outside,
        //                                    clip discards it → fully lit
        const dxToSun = sunPos.x - moonPos.x;
        const dyToSun = sunPos.y - moonPos.y;
        const dist = Math.hypot(dxToSun, dyToSun);
        const ux = dist > 1e-3 ? -dxToSun / dist : 1;
        const uy = dist > 1e-3 ? -dyToSun / dist : 0;
        const k = (1 - Math.cos(dL)) / 2;
        const offsetMag = bodyR * 2 * k;
        // Faint daytime moon: moon disc is dimmer when the sun is up
        // and the sky is bright. Real half-moons ARE visible in
        // afternoon — we don't fully suppress, just lower contrast.
        const dayLight = Math.max(0, Math.cos(thetaSun));
        const moonAlpha = 0.95 - 0.6 * dayLight;
        // Shadow colour lerps between night-sky [22,22,36] and a
        // daytime sky-blue [100,130,170] based on the sun's altitude.
        // Real daytime moons read as faintly blue-on-blue — the unlit
        // hemisphere is slightly darker than the sky from
        // atmospheric scatter, never the deep night-sky tone.
        const shR = 22 + (100 - 22) * dayLight;
        const shG = 22 + (130 - 22) * dayLight;
        const shB = 36 + (170 - 36) * dayLight;
        const shadowAlpha = 0.92;
        this.ctx.save();
        // Clip path = moon's circular outline. Anything drawn after
        // this only renders within that disc.
        this.ctx.beginPath();
        this.ctx.arc(moonPos.x, moonPos.y, bodyR, 0, Math.PI * 2);
        this.ctx.clip();
        // Lit moon fills the entire clip region.
        this.ctx.fillStyle = `rgba(225, 225, 235, ${moonAlpha.toFixed(3)})`;
        this.ctx.fillRect(
          moonPos.x - bodyR, moonPos.y - bodyR,
          bodyR * 2, bodyR * 2,
        );
        // Shadow disc on top. With clipping, only the part that
        // overlaps the moon disc is visible — produces a true
        // crescent at small k, half-disc at k=0.5, nothing at k=1.
        this.ctx.fillStyle = `rgba(${shR | 0}, ${shG | 0}, ${shB | 0}, ${shadowAlpha.toFixed(3)})`;
        this.ctx.beginPath();
        this.ctx.arc(
          moonPos.x + ux * offsetMag,
          moonPos.y + uy * offsetMag,
          bodyR,
          0, Math.PI * 2,
        );
        this.ctx.fill();
        this.ctx.restore();
        // Match the clipDiscOutsidePlants save() at the top of
        // the moon block.
        this.ctx.restore();
      }
      this.ctx.restore();
    }

    // Ant overlay.
    // Ant body radius. At 3 mm/cell the ant body is 2 cells wide, so
    // radius ≈ 1.1 cells (was 0.55 at 6 mm/cell). This keeps the ant
    // visually the same physical size on screen regardless of sim
    // resolution.
    const radius = Math.max(2, scale * 1.1);
    for (let i = 0; i < colony.count; i++) {
      const state = colony.state[i];
      // Dead ants: their bodies are already drawn as a corpse cell
      // in the terrain pass. Skip the live-ant overlay so we don't
      // render twice.
      if (state === STATE_DEAD) continue;

      // Eggs — small cream-coloured dots at the queen's chamber.
      // They don't move; static position throughout maturation.
      if (state === STATE_EGG) {
        const ex = ox + colony.posX[i]! * scale;
        const ey = oy + colony.posY[i]! * scale;
        this.ctx.fillStyle = 'rgba(245, 230, 200, 0.85)';
        this.ctx.beginPath();
        this.ctx.ellipse(ex, ey, radius * 0.4, radius * 0.55, 0, 0, Math.PI * 2);
        this.ctx.fill();
        continue;
      }

      // Larva — soft-white grub, larger than an egg and slightly
      // elongated. Energy-dependent saturation: hungry larvae fade
      // toward dim grey, well-fed larvae read bright. The queen's
      // chamber will read as a cluster of these once the colony
      // gets going (real Pogonomyrmex broodpiles are visible to
      // the naked eye through the chamber wall in lab arenas).
      if (state === STATE_LARVA) {
        const lx = ox + colony.posX[i]! * scale;
        const ly = oy + colony.posY[i]! * scale;
        const e = Math.max(0.2, Math.min(1, colony.energy[i]!));
        const r = (240 * e + 100 * (1 - e)) | 0;
        const g = (235 * e + 100 * (1 - e)) | 0;
        const b = (220 * e + 100 * (1 - e)) | 0;
        this.ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        this.ctx.beginPath();
        this.ctx.ellipse(lx, ly, radius * 0.65, radius * 0.4, 0, 0, Math.PI * 2);
        this.ctx.fill();
        continue;
      }
      // Pupa — slightly oblong cocoon, pale ivory with a faint
      // dorsal seam. Smaller than a fully-fed larva (real pupae
      // shed water during metamorphosis), and the seam shows the
      // worker outline forming inside. Vertical orientation
      // because real pupae are stacked head-up in the brood pile.
      if (state === STATE_PUPA) {
        const px2 = ox + colony.posX[i]! * scale;
        const py2 = oy + colony.posY[i]! * scale;
        this.ctx.fillStyle = 'rgb(245, 240, 220)';
        this.ctx.beginPath();
        this.ctx.ellipse(px2, py2, radius * 0.40, radius * 0.62, 0, 0, Math.PI * 2);
        this.ctx.fill();
        // Dorsal seam: narrow darker line down the centre showing
        // the developing worker. Subtle so the cocoon still reads
        // as ivory at small zoom.
        this.ctx.strokeStyle = 'rgba(180, 160, 130, 0.6)';
        this.ctx.lineWidth = Math.max(0.5, scale * 0.05);
        this.ctx.beginPath();
        this.ctx.moveTo(px2, py2 - radius * 0.45);
        this.ctx.lineTo(px2, py2 + radius * 0.45);
        this.ctx.stroke();
        continue;
      }

      // Queen — drawn ~40% larger than workers, in deep blue-purple
      // so she pops against the brown earth + cream brood + black
      // workers. Real Pogonomyrmex queens are 9-13 mm vs 5-8 mm
      // workers (~1.5× linear). She doesn't move (negligible delta);
      // skip leg animation for clarity.
      if (state === STATE_QUEEN) {
        const qx = ox + colony.posX[i]! * scale;
        const qy = oy + colony.posY[i]! * scale;
        const qr = radius * 1.5;
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        this.ctx.beginPath();
        this.ctx.ellipse(qx, qy + qr * 0.85, qr * 1.3, qr * 0.4, 0, 0, Math.PI * 2);
        this.ctx.fill();
        // Abdomen + thorax: rich indigo, distinct from any other
        // palette element (sky is teal-blue, build pheromone is
        // magenta, dig pheromone is cyan, soil/grain are browns).
        this.ctx.fillStyle = 'rgb(90, 60, 170)';
        this.ctx.beginPath();
        this.ctx.ellipse(qx, qy + qr * 0.4, qr * 0.6, qr * 1.0, 0, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.fillStyle = 'rgb(140, 100, 220)';
        this.ctx.beginPath();
        this.ctx.arc(qx, qy - qr * 0.55, qr * 0.5, 0, Math.PI * 2);
        this.ctx.fill();
        // Highlight pip on the head — a bright dot that catches the
        // eye even at low zoom.
        this.ctx.fillStyle = 'rgb(220, 200, 255)';
        this.ctx.beginPath();
        this.ctx.arc(qx, qy - qr * 0.55, qr * 0.18, 0, Math.PI * 2);
        this.ctx.fill();
        continue;
      }

      const x = colony.prevX[i]! + (colony.posX[i]! - colony.prevX[i]!) * alpha;
      const y = colony.prevY[i]! + (colony.posY[i]! - colony.prevY[i]!) * alpha;
      const px = ox + x * scale;
      const py = oy + y * scale;
      const carry = state === STATE_CARRY;
      const carryFood = state === STATE_CARRY_FOOD;
      const necro = state === STATE_NECRO_CARRY;
      // Per-ant size variation (#13). Real Pogonomyrmex workers
      // vary visibly in head and gaster size; uniform ant
      // silhouettes look like clones. Hash the ant's index so the
      // size is stable across frames. We apply the jitter via the
      // strokeStyle / ellipse calls below by referencing `r` not
      // `radius` — the outer `radius` stays the egg/larva-friendly
      // baseline, and `r` is the per-ant sized version.
      const sizeHash = ((i * 2654435761) >>> 0) / 4294967296;
      const sizeJitter = 0.85 + sizeHash * 0.30; // 0.85..1.15
      const r = radius * sizeJitter;
      // Contact shadow: a small dim ellipse a fraction below the ant
      // anchors them to the substrate. Without it ants read as
      // floating overlay sprites instead of agents on the ground.
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      this.ctx.beginPath();
      this.ctx.ellipse(px, py + r * 0.85, r * 1.3, r * 0.4, 0, 0, Math.PI * 2);
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
          const along = (leg - 1) * r * 0.9;
          const swing = Math.sin(phase + leg * 1.1) * 0.45;
          for (const side of [-1, 1] as const) {
            const lx = along + swing * r * 0.4;
            const ly = side * (r * 0.6 + Math.abs(swing) * r * 0.5);
            const ex = px + cosH * lx - sinH * ly;
            const ey = py + sinH * lx + cosH * ly;
            // Hip is a tiny inset so legs anchor to the body silhouette.
            const hx = px + cosH * along * 0.4 - sinH * (side * r * 0.3);
            const hy = py + sinH * along * 0.4 + cosH * (side * r * 0.3);
            this.ctx.beginPath();
            this.ctx.moveTo(hx, hy);
            this.ctx.lineTo(ex, ey);
            this.ctx.stroke();
          }
        }
      }
      // Three-segment ant body: abdomen (rear, largest), thorax
      // (middle, narrower), head (front, small). Real ants have
      // exactly this morphology; the previous single-ellipse form
      // read as a featureless oval at low zoom. The segments are
      // laid out along the heading direction with small gaps so
      // the petiole between them is visible.
      const heading = colony.heading[i]!;
      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);
      // Caste tint by role + energy. Pogonomyrmex worker polyethism
      // (Mirenda & Vinson 1981; Tschinkel 2006) produces visibly
      // different cuticle tones: callow (newly eclosed) workers
      // are pale tan, nurses mid-brown, foragers darkest from sun
      // exposure and chitin maturation. We approximate that with
      // role-keyed base colours and modulate brightness by energy
      // so depleted ants read as duller across the board.
      //
      //   STATE_REST       → callow / nurse: light brown, slight red.
      //   STATE_FORAGE/CF  → forager: nearly black, sun-tanned.
      //   STATE_NECRO      → undertaker: cool slate-grey-brown.
      //   default          → general worker / wander / carry-grain.
      const e = colony.energy[i]!;
      const tint = Math.max(0.6, Math.min(1, e * 1.1));
      // Bodies darkened across the board so ants read clearly against
      // the SOIL_TOP=(70,44,22) substrate. The previous REST tone of
      // (70,38,22) was almost the dirt colour, making resting workers
      // invisible. All values now sit at <50% of the dirt RGB so the
      // silhouette pops at any zoom.
      let baseR = 12, baseG = 7, baseB = 4;
      if (state === STATE_REST) { baseR = 38; baseG = 22; baseB = 12; }
      else if (state === STATE_FORAGE || state === STATE_CARRY_FOOD) {
        baseR = 4; baseG = 2; baseB = 1;
      } else if (state === STATE_NECRO_CARRY) {
        baseR = 24; baseG = 18; baseB = 22;
      }
      const bodyR = (baseR * tint) | 0;
      const bodyG = (baseG * tint) | 0;
      const bodyB = (baseB * tint) | 0;
      this.ctx.fillStyle = `rgb(${bodyR},${bodyG},${bodyB})`;
      // Abdomen — pointing backward from centre.
      this.ctx.beginPath();
      this.ctx.ellipse(
        px - cosH * r * 0.7, py - sinH * r * 0.7,
        r * 0.85, r * 0.62, heading, 0, Math.PI * 2,
      );
      this.ctx.fill();
      // Thorax — slightly forward of centre, narrower.
      this.ctx.beginPath();
      this.ctx.ellipse(
        px + cosH * r * 0.10, py + sinH * r * 0.10,
        r * 0.42, r * 0.40, heading, 0, Math.PI * 2,
      );
      this.ctx.fill();
      // Head — at the front, near-circular.
      const headX = px + cosH * r * 0.85;
      const headY = py + sinH * r * 0.85;
      this.ctx.beginPath();
      this.ctx.arc(headX, headY, r * 0.45, 0, Math.PI * 2);
      this.ctx.fill();
      // Antennae (#11). Two short forward-curving lines from the
      // head, splaying ±30° from the heading. Real ants flick
      // their antennae continuously; we add a small per-tick
      // wiggle for life.
      const antennaWiggle = Math.sin(this.world.tick * 0.4 + i * 1.7) * 0.15;
      const antLen = r * 0.6;
      this.ctx.strokeStyle = `rgb(${bodyR},${bodyG},${bodyB})`;
      this.ctx.lineWidth = Math.max(0.6, scale * 0.08);
      for (const dir of [-1, 1] as const) {
        const angle = heading + dir * (0.5 + antennaWiggle);
        const ax = headX + Math.cos(angle) * antLen;
        const ay = headY + Math.sin(angle) * antLen;
        this.ctx.beginPath();
        this.ctx.moveTo(headX, headY);
        // Curved antenna: a quadratic with mid-point bent outward.
        const cx = headX + Math.cos(heading + dir * 0.7) * antLen * 0.5;
        const cy = headY + Math.sin(heading + dir * 0.7) * antLen * 0.5;
        this.ctx.quadraticCurveTo(cx, cy, ax, ay);
        this.ctx.stroke();
      }
      // Body segment seams (#15). Faint dark line marking the
      // petiole between thorax and abdomen — sells the
      // 3-segment morphology without overdrawing.
      this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      this.ctx.lineWidth = Math.max(0.5, scale * 0.06);
      this.ctx.beginPath();
      const seamX = px - cosH * r * 0.18;
      const seamY = py - sinH * r * 0.18;
      this.ctx.moveTo(seamX - sinH * r * 0.35, seamY + cosH * r * 0.35);
      this.ctx.lineTo(seamX + sinH * r * 0.35, seamY - cosH * r * 0.35);
      this.ctx.stroke();
      // Mandibles when carrying anything (#12). Two short forward-
      // pointing lines from the head, gripping the cargo. Reads as
      // "ant holding object" instead of "object floating above ant".
      if (carry || carryFood || necro) {
        this.ctx.strokeStyle = `rgb(${Math.max(0, bodyR - 4)},${Math.max(0, bodyG - 4)},${Math.max(0, bodyB - 4)})`;
        this.ctx.lineWidth = Math.max(0.7, scale * 0.10);
        const mLen = r * 0.35;
        for (const dir of [-0.4, 0.4] as const) {
          const angle = heading + dir;
          const mx = headX + Math.cos(angle) * mLen;
          const my = headY + Math.sin(angle) * mLen;
          this.ctx.beginPath();
          this.ctx.moveTo(headX + cosH * r * 0.2, headY + sinH * r * 0.2);
          this.ctx.lineTo(mx, my);
          this.ctx.stroke();
        }
      }
      this.ctx.fillStyle = `rgb(${bodyR},${bodyG},${bodyB})`;
      if (carry) {
        this.ctx.fillStyle = GRAIN_COLOR_CSS;
        this.ctx.beginPath();
        this.ctx.arc(px, py - r * 0.6, r * 0.55, 0, Math.PI * 2);
        this.ctx.fill();
      } else if (necro) {
        // Hauled corpse — same dim purplish-grey as the world.corpse
        // overlay so the viewer reads "ant carrying a body" rather
        // than "ant carrying a different cargo type". Drawn slightly
        // larger than a grain because it's a whole nestmate.
        this.ctx.fillStyle = 'rgb(90, 70, 92)';
        this.ctx.beginPath();
        this.ctx.ellipse(
          px, py - r * 0.7,
          r * 0.85, r * 0.55,
          colony.heading[i]!, 0, Math.PI * 2,
        );
        this.ctx.fill();
      }
    }

    // Selection ring. Drawn after the ant overlay so it stays on top
    // of the body silhouette. Pulses softly so the user's eye stays
    // anchored to the picked ant even as it walks. Bail if the
    // selection no longer maps to a live ant (count shrank, ant died).
    if (selectedId >= 0 && selectedId < colony.count
        && colony.state[selectedId]! !== STATE_DEAD) {
      const sx = ox + (colony.prevX[selectedId]!
        + (colony.posX[selectedId]! - colony.prevX[selectedId]!) * alpha) * scale;
      const sy = oy + (colony.prevY[selectedId]!
        + (colony.posY[selectedId]! - colony.prevY[selectedId]!) * alpha) * scale;
      const pulse = 0.7 + 0.3 * Math.sin(this.world.tick * 0.18);
      this.ctx.strokeStyle = `rgba(255, 220, 80, ${pulse.toFixed(3)})`;
      this.ctx.lineWidth = Math.max(1.2, scale * 0.18);
      this.ctx.beginPath();
      this.ctx.arc(sx, sy, Math.max(4, scale * 1.8), 0, Math.PI * 2);
      this.ctx.stroke();
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

    // Selected-ant inset preview (#21). When an ant is picked,
    // show a 8× zoom of a small region around them in the
    // bottom-right corner above the mini-map. Re-blits from the
    // terrainSource (already-composited terrain + pheromone) and
    // overlays the worker's body using the same renderer logic
    // would be ideal, but a simple imageSmoothingEnabled=false
    // re-blit is enough to read the per-ant detail and gives the
    // user a quick "what's this ant doing" look.
    if (selectedId >= 0 && selectedId < colony.count
        && colony.state[selectedId]! !== STATE_DEAD) {
      const insetSize = 120; // px on the visible canvas
      const insetSrcCells = 16; // 16×16 cell window around the ant
      const insetX = cw - insetSize - 12;
      const insetY = ch - insetSize - (this.showMinimap ? 124 : 12);
      const ix = colony.posX[selectedId]!;
      const iy = colony.posY[selectedId]!;
      // Source region in framebuffer pixels (each cell = SUB px).
      const sxF = Math.max(0,
        Math.min(w * this.SUB - insetSrcCells * this.SUB,
          (ix - insetSrcCells / 2) * this.SUB));
      const syF = Math.max(0,
        Math.min(h * this.SUB - insetSrcCells * this.SUB,
          (iy - insetSrcCells / 2) * this.SUB));
      // Backdrop + border for legibility.
      this.ctx.fillStyle = 'rgba(10, 6, 6, 0.7)';
      this.ctx.fillRect(insetX - 4, insetY - 4, insetSize + 8, insetSize + 8);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(
        terrainSource,
        sxF, syF, insetSrcCells * this.SUB, insetSrcCells * this.SUB,
        insetX, insetY, insetSize, insetSize,
      );
      this.ctx.strokeStyle = 'rgba(255, 220, 80, 0.85)';
      this.ctx.lineWidth = 1.5;
      this.ctx.strokeRect(insetX + 0.5, insetY + 0.5, insetSize - 1, insetSize - 1);
      // Crosshair where the ant sits within the inset.
      const insetScale = insetSize / (insetSrcCells * this.SUB);
      const crossX = insetX + (ix * this.SUB - sxF) * insetScale;
      const crossY = insetY + (iy * this.SUB - syF) * insetScale;
      this.ctx.strokeStyle = 'rgba(255, 220, 80, 0.6)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.arc(crossX, crossY, 8, 0, Math.PI * 2);
      this.ctx.stroke();
    }

    // Mini-map. Bottom-right inset showing the full world at low
    // resolution with the current viewport rectangle outlined when
    // the user is zoomed in. Always drawn — at zoom 1 it shows the
    // whole world (so the rectangle covers the entire mini-map),
    // at higher zooms it serves as a "you are here" overlay.
    // Drawn on top of the vignette so it stays legible when the
    // user is zoomed deep into a corner of the world.
    if (this.showMinimap) {
      const mmAspect = w / h;
      const mmW = Math.min(220, cw * 0.22);
      const mmH = mmW / mmAspect;
      const mmX = cw - mmW - 12;
      const mmY = ch - mmH - 12;
      // Slight backdrop for legibility on bright daytime renders.
      this.ctx.fillStyle = 'rgba(10, 6, 6, 0.55)';
      this.ctx.fillRect(mmX - 4, mmY - 4, mmW + 8, mmH + 8);
      // Source the same offscreen buffer the world is drawn from —
      // it already has terrain + pheromone overlay composited, so
      // the mini-map matches the main view's content. Smoothing on
      // for a clean reduction (aliasing reads as "noise" at this size).
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.drawImage(terrainSource, 0, 0, w * this.SUB, h * this.SUB, mmX, mmY, mmW, mmH);
      this.ctx.imageSmoothingEnabled = false;
      // Border.
      this.ctx.strokeStyle = 'rgba(216, 200, 168, 0.55)';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(mmX + 0.5, mmY + 0.5, mmW - 1, mmH - 1);
      // Viewport indicator. Map the visible world rectangle (after
      // pan/zoom) into mini-map space and outline it. At zoom=1 the
      // rectangle is the whole mini-map; at higher zooms it shrinks
      // and tracks the user's pan.
      const viewLeft = -ox / scale;
      const viewTop = -oy / scale;
      const viewRight = (cw - ox) / scale;
      const viewBottom = (ch - oy) / scale;
      const vL = Math.max(0, Math.min(w, viewLeft));
      const vT = Math.max(0, Math.min(h, viewTop));
      const vR = Math.max(0, Math.min(w, viewRight));
      const vB = Math.max(0, Math.min(h, viewBottom));
      const vx = mmX + (vL / w) * mmW;
      const vy = mmY + (vT / h) * mmH;
      const vw = ((vR - vL) / w) * mmW;
      const vh = ((vB - vT) / h) * mmH;
      if (this.zoom > 1.001) {
        this.ctx.strokeStyle = 'rgba(255, 220, 80, 0.95)';
        this.ctx.lineWidth = 1.5;
        this.ctx.strokeRect(vx, vy, vw, vh);
      }
      // Live ant dots. One pixel per ant — at default 280×140 with
      // 50–500 ants the dot density reads as a nest cluster + a few
      // surface foragers without hitting overdraw. Skip eggs and
      // larvae (they cluster at the queen and make the mini-map
      // unreadable); they're already implied by the queen marker.
      const sxScale = mmW / w;
      const syScale = mmH / h;
      for (let i = 0; i < colony.count; i++) {
        const s = colony.state[i]!;
        if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA) continue;
        let dotR = 90, dotG = 70, dotB = 50;
        if (s === STATE_QUEEN) { dotR = 220; dotG = 180; dotB = 255; }
        else if (s === STATE_FORAGE || s === STATE_CARRY_FOOD) {
          dotR = 240; dotG = 220; dotB = 80;
        } else if (s === STATE_CARRY) { dotR = 200; dotG = 160; dotB = 100; }
        this.ctx.fillStyle = `rgb(${dotR}, ${dotG}, ${dotB})`;
        const dxm = mmX + colony.posX[i]! * sxScale;
        const dym = mmY + colony.posY[i]! * syScale;
        const r = s === STATE_QUEEN ? 1.8 : 1.2;
        this.ctx.fillRect(dxm - r, dym - r, r * 2, r * 2);
      }
    }
    // Pair the screensaver-drift translate at the top of render().
    this.ctx.restore();
  }
}

const GRAIN_COLOR_CSS = `rgb(${GRAIN_COLOR[0]}, ${GRAIN_COLOR[1]}, ${GRAIN_COLOR[2]})`;
