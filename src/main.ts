// Entry point. Wires sim, renderer, loop, input, and overlay together.

import { parseOptionsFromURL, QUALITY_PROFILES, SIM } from './config';
import { World } from './sim/world';
import { Colony, STATE_CARRY, STATE_DIG, STATE_REST, STATE_WANDER } from './sim/colony';
import { createFields } from './sim/fields';
import { stepSimulation } from './sim/ant-rules';
import { RNG } from './sim/rng';
import { Renderer } from './render/renderer';
import { Loop } from './runtime/loop';
import { bindVisibilityPause } from './runtime/visibility';
import { bindInput } from './input/input';
import { Perf } from './runtime/perf';

function boot(): void {
  const opts = parseOptionsFromURL();
  const profile = QUALITY_PROFILES[opts.quality];

  const canvas = document.getElementById('screen') as HTMLCanvasElement | null;
  const overlayEl = document.getElementById('overlay') as HTMLDivElement | null;
  const helpEl = document.getElementById('help') as HTMLDivElement | null;
  if (!canvas || !overlayEl || !helpEl) {
    throw new Error('Missing required DOM elements');
  }

  const rng = new RNG(opts.seed);
  const world = new World(profile.gridWidth, profile.gridHeight);
  world.generate(rng);
  const colony = new Colony(profile.antCount * 2);
  const fields = createFields(world.width, world.height);

  // Seed initial colony just below the surface, in the starter divot.
  const surfaceY = Math.floor(world.height * SIM.surfaceFraction);
  const isAir = (x: number, y: number): boolean => world.isPassable(x, y);
  colony.spawnCluster(world.width / 2, surfaceY + 4, profile.antCount, rng, 5, isAir);

  const renderer = new Renderer(canvas, world);
  renderer.showPheromones = opts.showPheromones;

  const perf = new Perf();

  let lastSimMs = 0;
  let lastRenderMs = 0;

  const loop = new Loop(profile.simHz, {
    step: () => {
      const t0 = performance.now();
      stepSimulation(world, colony, fields, rng);
      lastSimMs = performance.now() - t0;
      perf.recordSim(lastSimMs);
    },
    draw: (alpha: number) => {
      const t0 = performance.now();
      renderer.draw(colony, fields, alpha);
      lastRenderMs = performance.now() - t0;
      perf.recordRender(lastRenderMs);
      if (perf.tick(t0) && opts.showOverlay) {
        updateOverlay();
      }
    },
  });
  loop.speedMultiplier = opts.speedMultiplier;

  function countByState(): { wander: number; dig: number; carry: number; rest: number } {
    let wander = 0; let dig = 0; let carry = 0; let rest = 0;
    for (let i = 0; i < colony.count; i++) {
      switch (colony.state[i]) {
        case STATE_WANDER: wander++; break;
        case STATE_DIG: dig++; break;
        case STATE_CARRY: carry++; break;
        case STATE_REST: rest++; break;
      }
    }
    return { wander, dig, carry, rest };
  }

  function updateOverlay(): void {
    const c = countByState();
    const dug = world.initialSoilCells - world.countSoil();
    const grains = world.countGrains();
    overlayEl!.textContent = [
      `formicarium · ${opts.quality}`,
      `seed: ${opts.seed}`,
      `fps: ${perf.fps.toFixed(1)}  sim: ${perf.simMs.toFixed(2)}ms  render: ${perf.renderMs.toFixed(2)}ms`,
      `ants: ${colony.count}  wander:${c.wander} dig:${c.dig} carry:${c.carry} rest:${c.rest}`,
      `dug cells: ${dug}  surface grains: ${grains}`,
      `keys: space=pause  h=overlay  p=pheromones  r=reseed  c=clear  n=spawn`,
    ].join('\n');
  }

  function setOverlayVisible(v: boolean): void {
    if (v) overlayEl!.classList.remove('hidden');
    else overlayEl!.classList.add('hidden');
    if (v) helpEl!.classList.add('hidden');
    else helpEl!.classList.remove('hidden');
    opts.showOverlay = v;
    if (v) updateOverlay();
  }
  setOverlayVisible(opts.showOverlay);

  // Hide the help hint after 6 seconds of no interaction.
  const helpHideTimer = window.setTimeout(() => {
    if (!opts.showOverlay) helpEl!.classList.add('hidden');
  }, 6000);

  function reseed(seed?: number): void {
    if (seed !== undefined) {
      opts.seed = (seed | 0) >>> 0;
    } else {
      opts.seed = (Date.now() & 0xffffffff) >>> 0;
    }
    rng.reseed(opts.seed);
    world.cells.fill(0);
    world.exposure.fill(0);
    world.grainAmount.fill(0);
    world.surfaceMound.fill(0);
    world.generate(rng);
    fields.dig.clear();
    fields.construction.clear();
    colony.count = 0;
    const isAir = (x: number, y: number): boolean => world.isPassable(x, y);
  colony.spawnCluster(world.width / 2, surfaceY + 4, profile.antCount, rng, 5, isAir);
    if (opts.showOverlay) updateOverlay();
  }

  function clearWorld(): void {
    world.cells.fill(0);
    world.exposure.fill(0);
    world.grainAmount.fill(0);
    world.surfaceMound.fill(0);
    world.generate(rng);
    fields.dig.clear();
    fields.construction.clear();
  }

  function spawnBurst(): void {
    const remaining = colony.capacity - colony.count;
    const n = Math.min(50, remaining);
    if (n > 0) {
      colony.spawnCluster(world.width / 2, surfaceY + 4, n, rng, 6, isAir);
    }
  }

  bindInput({
    canvas,
    world,
    colony,
    fields,
    loop,
    rng,
    reseed,
    toggleOverlay: () => {
      window.clearTimeout(helpHideTimer);
      setOverlayVisible(!opts.showOverlay);
    },
    togglePheromones: () => {
      renderer.showPheromones = !renderer.showPheromones;
    },
    clearWorld,
    spawnBurst,
  });

  bindVisibilityPause(loop);
  loop.start();

  // Battery-aware quality stepdown — best-effort, deferred so it doesn't
  // block startup. SPEC §7.5.
  type BatteryManager = { charging: boolean; addEventListener: (t: string, cb: () => void) => void };
  type NavigatorWithBattery = Navigator & { getBattery?: () => Promise<BatteryManager> };
  const navWithBattery = navigator as NavigatorWithBattery;
  if (typeof navWithBattery.getBattery === 'function') {
    navWithBattery.getBattery().then((bat: BatteryManager) => {
      const apply = (): void => {
        if (!bat.charging && opts.quality === 'high') {
          // Best-effort: just slow down sim. Full re-init on quality
          // change would require rebuilding the world, which is more
          // disruptive than a minor speed tweak.
          loop.speedMultiplier = Math.min(opts.speedMultiplier, 0.6);
        } else {
          loop.speedMultiplier = opts.speedMultiplier;
        }
      };
      bat.addEventListener('chargingchange', apply);
      apply();
    }).catch(() => { /* Battery API not available — ignore. */ });
  }

  // Lively bridge: noop if not running under Lively, but exposes a global
  // `livelyPropertyListener` they can call. SPEC §8.1.
  type WindowWithLively = Window & { livelyPropertyListener?: (name: string, value: unknown) => void };
  (window as WindowWithLively).livelyPropertyListener = (name: string, value: unknown): void => {
    if (name === 'quality' && typeof value === 'number') {
      const q = ['low', 'medium', 'high'][value | 0];
      if (q && q !== opts.quality) {
        const url = new URL(location.href);
        url.searchParams.set('quality', q);
        location.href = url.toString();
      }
    } else if (name === 'speed' && typeof value === 'number') {
      loop.speedMultiplier = Math.max(0.1, Math.min(5, value));
    }
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
