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
    // Smaller default world: at 200×120 each cell rendered as ~9 px on
    // a 1080-tall viewport and the ants were sub-5-pixel dots, almost
    // invisible. 140×80 puts each cell at ~13 px and lifts the ant
    // sprite into visible territory. The chamber detail is coarser
    // but it reads as an ant farm rather than a smooth blob.
    width: Math.max(40, num('width', 140) | 0),
    height: Math.max(30, num('height', 80) | 0),
    // 16 ants in a 140-wide world is about 1 ant per 9 cm across.
    // The previous 24 in a 200-wide world packed them tightly enough
    // that pairwise repulsion overwhelmed any tunnel-front formation
    // — they'd cluster at one wall and grind it back as a uniform
    // chamber. Fewer ants spread across the same world give more
    // room for distinct work fronts.
    ants: Math.max(1, num('ants', 16) | 0),
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
  // Spawn ants in the BOTTOM half of the divot (deeper rows) — the
  // divot radius matches what world.generate uses.
  const divotR = Math.max(4, Math.min(halfW, depth + 3));
  colony.spawnInRect(
    cx - divotR + 1,
    surfaceRow + divotR - 1,
    cx + divotR - 1,
    surfaceRow + 2 * divotR - 1,
    s.ants,
    rng,
    (x, y) => world.cells[world.index(x, y)] === 0 /* AIR */,
    DEFAULT_PARAMS,
  );
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

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') { paused = !paused; e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { stepsPerFrame = Math.min(64, stepsPerFrame * 2); }
    else if (e.key === '-' || e.key === '_') { stepsPerFrame = Math.max(1, stepsPerFrame >> 1); }
    else if (e.key === '?') {
      help.classList.toggle('hidden');
      if (helpHideTimer !== undefined) {
        window.clearTimeout(helpHideTimer);
        helpHideTimer = undefined;
      }
    }
    else if (e.key === '0') {
      renderer.zoom = 1;
      renderer.panX = 0;
      renderer.panY = 0;
    }
    else if (e.key === 'f') {
      // Browsers require fullscreen requests to be tied to a user
      // gesture — a keydown qualifies. Errors are non-fatal: a
      // browser without permission just stays windowed.
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    }
    else if (e.key === 'p') {
      renderer.showPheromones = !renderer.showPheromones;
    }
    else if (e.key === 'r') {
      const s2 = { ...settings, seed: (settings.seed * 16807 + 1) >>> 0 };
      const built = build(s2);
      rng = built.rng;
      world = built.world;
      colony = built.colony;
      digField = built.digField;
      buildField = built.buildField;
      // Hot-swap: rebuild renderer view of the new world.
      (renderer as unknown as { world: World }).world = world;
    }
  });

  let last = performance.now();
  let alpha = 0;
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;

    if (!paused) {
      for (let i = 0; i < stepsPerFrame; i++) {
        step(world, colony, digField, buildField, rng, DEFAULT_PARAMS);
      }
      void particles;
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
        `  ·  dug ${dugTotal}  grains ${grains}` +
        `  ·  speed ${stepsPerFrame}×${paused ? '  ·  PAUSED' : ''}` +
        `  ·  ${(1000 / Math.max(1, dt)).toFixed(0)} fps`;
    }
  };
  requestAnimationFrame(frame);
}

main();
