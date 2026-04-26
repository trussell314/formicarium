// Entry point. Builds the world + colony, runs the sim loop, draws to
// the canvas. URL params:
//   ?seed=N       fixed RNG seed (otherwise time-derived)
//   ?speed=N      sim sub-steps per render frame (default 8)
//   ?ants=N       initial ant count
//   ?width=N      world width (cells)
//   ?height=N     world height (cells)

import { Colony } from './sim/colony';
import { DEFAULT_PARAMS, step } from './sim/ant-rules';
import { ParticleSystem } from './sim/particles';
import { Pheromone } from './sim/pheromone';
import { RNG } from './sim/rng';
import { World } from './sim/world';
import { Renderer } from './render/renderer';

interface Settings {
  seed: number;
  width: number;
  height: number;
  ants: number;
  /** Sim sub-steps per render frame. Higher = faster time-lapse. */
  simStepsPerFrame: number;
}

function readSettings(): Settings {
  const p = new URLSearchParams(location.search);
  const num = (k: string, d: number): number => {
    const v = p.get(k);
    if (v === null) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    seed: num('seed', (Date.now() & 0xffffffff) >>> 0),
    // Default world is 200×100 cells. The Khuong+Buhl regime where
    // multiple tunnel fronts emerge requires both critical density
    // AND room for the fronts to spread without immediately colliding.
    // 200×100 with 100 ants gives ~1 ant per 200 cells — the upper end
    // of the medium-density range Buhl 2004 reports producing branched
    // (rather than single-gallery or diffuse-chamber) architecture.
    width: Math.max(40, num('width', 200) | 0),
    height: Math.max(30, num('height', 100) | 0),
    ants: Math.max(1, num('ants', 100) | 0),
    simStepsPerFrame: Math.max(1, num('speed', 8) | 0),
  };
}

function build(s: Settings) {
  const rng = new RNG(s.seed);
  const world = new World(s.width, s.height);
  const surfaceRow = Math.floor(s.height * 0.30);
  const halfW = Math.max(6, Math.floor(s.width * 0.06));
  const depth = Math.max(4, Math.floor(s.height * 0.05));
  world.generate(rng, surfaceRow, halfW, depth);

  // Two pheromone fields. The dig-pheromone evaporation is at the
  // FAST end of the literature range (Bonabeau et al. 1998 give
  // 0.95–0.99). Slow evaporation (0.992 → ~85-tick half-life) made
  // stigmergy too sticky: once the first dig front established its
  // gradient, no second front could compete. Faster evaporation
  // (0.97 → ~22-tick half-life) means a site's recruitment power
  // decays unless ants keep working it; new sites get a fair shot
  // at bootstrapping. Build pheromone stays slow (0.997) — spoil
  // mounds are meant to be persistent landmarks.
  const digField = new Pheromone(world.width, world.height, 0.12, 0.985);
  const buildField = new Pheromone(world.width, world.height, 0.10, 0.997);

  const colony = new Colony(s.ants);
  const cx = world.width >> 1;
  // Pack as many founders as will reasonably fit into the pinhole +
  // terminal pocket; scatter the rest on the surface a few cells to
  // either side of the entrance. This mirrors the natural founding
  // picture: a few ants down the shaft + foragers milling on the
  // surface, all about to discover the existing void. Geometry must
  // match world.generate's pinhole.
  const SHAFT_DEPTH = 5;
  const POCKET_HALF = 1;
  const POCKET_HEIGHT = 2;
  const PACK_DENSITY = 4; // ants per air cell — dense but not gridlock
  const surfHere = world.naturalSurface[cx]!;
  const shaftAir = SHAFT_DEPTH;
  const pocketAir = (POCKET_HALF * 2 + 1) * POCKET_HEIGHT;
  const pinholeCap = Math.min(s.ants, (shaftAir + pocketAir) * PACK_DENSITY);
  const isAir = (x: number, y: number): boolean =>
    world.cells[world.index(x, y)] === 0 /* AIR */;
  const placedInPinhole = colony.spawnInRect(
    cx - POCKET_HALF,
    surfHere,
    cx + POCKET_HALF,
    surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1,
    pinholeCap,
    rng,
    isAir,
    DEFAULT_PARAMS,
  );
  // Surface scatter for the remainder. Place them in an air row
  // safely above the wavy natural surface in a band centred on the
  // entrance; physics gravity-settles each onto its own column's
  // ground in a few ticks.
  const remaining = s.ants - placedInPinhole;
  if (remaining > 0) {
    const SCATTER_HALF = 10;
    let topRow = world.height;
    for (let x = Math.max(0, cx - SCATTER_HALF); x <= Math.min(world.width - 1, cx + SCATTER_HALF); x++) {
      if (world.naturalSurface[x]! < topRow) topRow = world.naturalSurface[x]!;
    }
    const scatterY = Math.max(0, topRow - 1);
    colony.spawnInRect(
      Math.max(0, cx - SCATTER_HALF),
      scatterY,
      Math.min(world.width - 1, cx + SCATTER_HALF),
      scatterY,
      remaining,
      rng,
      isAir,
      DEFAULT_PARAMS,
    );
  }
  return { rng, world, colony, digField, buildField };
}

function main(): void {
  const settings = readSettings();
  let { rng, world, colony, digField, buildField } = build(settings);

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const help = document.getElementById('help') as HTMLDivElement;
  const renderer = new Renderer(canvas, world);
  const particles = new ParticleSystem(256);

  // Auto-hide the help panel after a few seconds so it doesn't clutter
  // the screensaver indefinitely. The `?` key brings it back.
  let helpHideTimer: number | undefined = window.setTimeout(() => {
    help.classList.add('hidden');
  }, 6000);

  const onResize = () => renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  onResize();

  // Camera (zoom + pan) handling. Pinch on mobile, wheel on desktop,
  // single-pointer drag to pan when zoomed in. We can't rely on
  // browser-native pinch-zoom — it scales the page chrome (HUD,
  // sparkline) and reflows the canvas to a smaller pixel size; the
  // simulation has to own its own camera.
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 6;
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let pinchAnchor = { x: 0, y: 0 };
  let panLastX = 0;
  let panLastY = 0;
  const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const zoomAtPoint = (newZoom: number, sx: number, sy: number) => {
    const zClamped = clampZoom(newZoom);
    const old = renderer.zoom;
    if (zClamped === old) return;
    // Anchor: keep the world point under (sx, sy) fixed across the
    // zoom change. Adjust pan so that screenToWorld at (sx, sy) maps
    // to the same world coordinate before and after.
    const before = renderer.screenToWorld(sx, sy);
    renderer.zoom = zClamped;
    const after = renderer.screenToWorld(sx, sy);
    // shift in WORLD cells; convert back to viewport CSS pixels.
    const cw = canvas.width;
    const w = world.width;
    const h = world.height;
    const ch = canvas.height;
    const dpr = cw / parseFloat(canvas.style.width || `${cw}`);
    const baseScale = Math.min(cw / w, ch / h);
    const scale = baseScale * renderer.zoom;
    renderer.panX += (after.x - before.x) * scale / dpr;
    renderer.panY += (after.y - before.y) * scale / dpr;
    if (renderer.zoom === 1) { renderer.panX = 0; renderer.panY = 0; }
    renderer.clampPan();
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 1-step click of a typical mouse wheel ≈ 100 px; pinch trackpads
    // emit much smaller deltas. Multiply by a gentle factor.
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAtPoint(renderer.zoom * factor, e.clientX, e.clientY);
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      panLastX = e.clientX;
      panLastY = e.clientY;
    } else if (activePointers.size === 2) {
      const [a, b] = Array.from(activePointers.values());
      pinchStartDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      pinchStartZoom = renderer.zoom;
      pinchAnchor = { x: (a!.x + b!.x) * 0.5, y: (a!.y + b!.y) * 0.5 };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1 && renderer.zoom > 1.001) {
      // Drag to pan only when zoomed in. At zoom=1 the world fills
      // the screen and panning would just push it off-edge.
      renderer.panX += e.clientX - panLastX;
      renderer.panY += e.clientY - panLastY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      renderer.clampPan();
    } else if (activePointers.size === 2) {
      const [a, b] = Array.from(activePointers.values());
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchStartDist > 0) {
        const ratio = dist / pinchStartDist;
        zoomAtPoint(pinchStartZoom * ratio, pinchAnchor.x, pinchAnchor.y);
      }
    }
  });
  const onPointerEnd = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStartDist = 0;
    if (activePointers.size === 1) {
      const [p] = Array.from(activePointers.values());
      panLastX = p!.x; panLastY = p!.y;
    }
  };
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);

  let paused = false;
  let stepsPerFrame = settings.simStepsPerFrame;
  let lastHud = 0;

  // Action map — single source of truth for keyboard AND on-screen
  // controls. Mobile users have no keyboard, so the button cluster
  // in index.html dispatches via the same names.
  const actions: Record<string, () => void> = {
    pause: () => { paused = !paused; },
    faster: () => { stepsPerFrame = Math.min(64, stepsPerFrame * 2); },
    slower: () => { stepsPerFrame = Math.max(1, stepsPerFrame >> 1); },
    help: () => {
      help.classList.toggle('hidden');
      if (helpHideTimer !== undefined) {
        window.clearTimeout(helpHideTimer);
        helpHideTimer = undefined;
      }
    },
    zoomout: () => { renderer.zoom = 1; renderer.panX = 0; renderer.panY = 0; },
    full: () => {
      // Browsers require fullscreen requests to be tied to a user
      // gesture — both keydown and click qualify.
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    },
    phero: () => { renderer.showPheromones = !renderer.showPheromones; },
    reseed: () => {
      const s2 = { ...settings, seed: (settings.seed * 16807 + 1) >>> 0 };
      const built = build(s2);
      rng = built.rng;
      world = built.world;
      colony = built.colony;
      digField = built.digField;
      buildField = built.buildField;
      renderer.setWorld(world);
    },
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') { actions.pause!(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') actions.faster!();
    else if (e.key === '-' || e.key === '_') actions.slower!();
    else if (e.key === '?') actions.help!();
    else if (e.key === '0') actions.zoomout!();
    else if (e.key === 'f') actions.full!();
    else if (e.key === 'p') actions.phero!();
    else if (e.key === 'r') actions.reseed!();
  });

  // Wire the on-screen button cluster (index.html #ctrls). Each
  // button has a data-act attribute that names the action above.
  const ctrls = document.getElementById('ctrls') as HTMLDivElement | null;
  if (ctrls) {
    ctrls.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t?.dataset?.act;
      if (act && actions[act]) actions[act]!();
    });
  }

  let last = performance.now();
  let alpha = 0;
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;

    if (!paused) {
      for (let i = 0; i < stepsPerFrame; i++) {
        step(world, colony, digField, buildField, rng, DEFAULT_PARAMS, particles);
      }
      // No fixed-timestep accumulator yet — render alpha=1 (no
      // interpolation) is fine while sub-stepping multiple sim ticks
      // per frame, since the visible motion comes from the sim itself.
      alpha = 1;
    }

    renderer.render(colony, alpha, particles, { dig: digField, build: buildField });

    if (now - lastHud > 250) {
      lastHud = now;
      const dugTotal = world.initialSoilCells - world.countSoil();
      const grains = world.countGrains();
      hud.textContent =
        `formicarium · seed 0x${settings.seed.toString(16)}` +
        `  ·  ${world.width}×${world.height}` +
        `  ·  ants ${colony.count}` +
        `  ·  t=${world.tick.toLocaleString()}` +
        `  ·  dug ${dugTotal}  grains ${grains}` +
        `  ·  speed ${stepsPerFrame}×${paused ? '  ·  PAUSED' : ''}` +
        `  ·  ${(1000 / Math.max(1, dt)).toFixed(0)} fps`;
    }
  };
  requestAnimationFrame(frame);
}

main();
