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
    width: Math.max(40, num('width', 200) | 0),
    height: Math.max(30, num('height', 120) | 0),
    ants: Math.max(1, num('ants', 24) | 0),
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

  const colony = new Colony(s.ants);
  const cx = world.width >> 1;
  colony.spawnInRect(
    cx - halfW + 1,
    surfaceRow + 1,
    cx + halfW - 1,
    surfaceRow + depth,
    s.ants,
    rng,
    (x, y) => world.cells[world.index(x, y)] === 0 /* AIR */,
  );
  return { rng, world, colony };
}

function main(): void {
  const settings = readSettings();
  let { rng, world, colony } = build(settings);

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const help = document.getElementById('help') as HTMLDivElement;
  const spark = document.getElementById('spark') as HTMLCanvasElement;
  const sparkCtx = spark.getContext('2d')!;
  const renderer = new Renderer(canvas, world);
  const particles = new ParticleSystem(256);

  // Rolling buffer of dig counts per frame; the sparkline shows the
  // last SPARK_LEN samples. Gives the viewer an at-a-glance signal
  // for "is the colony actively working?"
  const SPARK_LEN = spark.width;
  const sparkBuf = new Int16Array(SPARK_LEN);
  let sparkHead = 0;
  let prevSoil = world.countSoil();
  let sparkSamples = 0;

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
    else if (e.key === 'r') {
      const s2 = { ...settings, seed: (settings.seed * 16807 + 1) >>> 0 };
      const built = build(s2);
      rng = built.rng;
      world = built.world;
      colony = built.colony;
      // Hot-swap: rebuild renderer view of the new world.
      (renderer as unknown as { world: World }).world = world;
      prevSoil = world.countSoil();
      sparkBuf.fill(0);
      sparkSamples = 0;
      spark.classList.remove('live');
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
        step(world, colony, rng, DEFAULT_PARAMS, particles);
      }
      // No fixed-timestep accumulator yet — render alpha=1 (no
      // interpolation) is fine while sub-stepping multiple sim ticks
      // per frame, since the visible motion comes from the sim itself.
      alpha = 1;
    }

    renderer.render(colony, alpha, particles);

    // Sparkline: dig events (soil cells lost) per render frame, in
    // a ring buffer. Rendered as a single smoothed polyline — the
    // earlier vertical-bar implementation produced a busy
    // "scrolling histogram" that read as motion crossing the
    // screen rather than as a quiet readout.
    const curSoil = world.countSoil();
    const dug = Math.max(0, prevSoil - curSoil);
    prevSoil = curSoil;
    sparkBuf[sparkHead] = dug;
    sparkHead = (sparkHead + 1) % SPARK_LEN;
    sparkSamples++;
    // Don't fade the sparkline in until the buffer is full — otherwise
    // the empty-half of the ring sweeps across the screen as a
    // low-flat line emerging from nothing, which reads as a moving
    // bar to a casual viewer.
    if (sparkSamples === SPARK_LEN) spark.classList.add('live');
    let peak = 1;
    for (let k = 0; k < SPARK_LEN; k++) {
      if (sparkBuf[k]! > peak) peak = sparkBuf[k]!;
    }
    sparkCtx.clearRect(0, 0, spark.width, spark.height);
    // Faint baseline so the sparkline still has visual anchorage
    // even when the colony is idle.
    sparkCtx.fillStyle = 'rgba(216, 200, 168, 0.10)';
    sparkCtx.fillRect(0, spark.height - 1, spark.width, 1);
    sparkCtx.strokeStyle = 'rgba(216, 200, 168, 0.7)';
    sparkCtx.lineWidth = 1;
    sparkCtx.beginPath();
    for (let k = 0; k < SPARK_LEN; k++) {
      // Plot oldest sample on the left, newest on the right. Apply a
      // 3-tap smoothing to take the edge off single-frame spikes
      // (each dig is one frame; smoothing makes the line read as a
      // dig-rate curve instead of dense flicker).
      const idx0 = (sparkHead + k) % SPARK_LEN;
      const idxL = (sparkHead + Math.max(0, k - 1)) % SPARK_LEN;
      const idxR = (sparkHead + Math.min(SPARK_LEN - 1, k + 1)) % SPARK_LEN;
      const v = (sparkBuf[idxL]! + sparkBuf[idx0]! * 2 + sparkBuf[idxR]!) * 0.25;
      const yy = spark.height - 0.5 - (v / peak) * (spark.height - 2);
      if (k === 0) sparkCtx.moveTo(k + 0.5, yy);
      else sparkCtx.lineTo(k + 0.5, yy);
    }
    sparkCtx.stroke();

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
