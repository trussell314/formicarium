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

    if (now - lastHud > 250) {
      lastHud = now;
      const dug = world.initialSoilCells - world.countSoil();
      const grains = world.countGrains();
      hud.textContent =
        `formicarium · seed 0x${settings.seed.toString(16)}` +
        `  ·  ${world.width}×${world.height}` +
        `  ·  ants ${colony.count}` +
        `  ·  dug ${dug}  grains ${grains}` +
        `  ·  speed ${stepsPerFrame}×${paused ? '  ·  PAUSED' : ''}` +
        `  ·  ${(1000 / Math.max(1, dt)).toFixed(0)} fps`;
    }
  };
  requestAnimationFrame(frame);
}

main();
