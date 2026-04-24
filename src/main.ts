// Entry point — boots the web app from the default scenario.
//
// All world dimensions, day/night durations, and ant populations
// come from src/scenarios/default.ts. To change what the live demo
// shows, edit that scenario file, not this one.

import { buildFromScenario } from './scenario';
import { DEFAULT_SCENARIO } from './scenarios/default';
import { stepSimulation } from './sim/ant-rules';
import { Renderer } from './render/renderer';
import { Loop } from './runtime/loop';
import { bindVisibilityPause } from './runtime/visibility';

function boot(): void {
  const canvas = document.getElementById('screen') as HTMLCanvasElement | null;
  const overlayEl = document.getElementById('overlay') as HTMLDivElement | null;
  if (!canvas) throw new Error('missing canvas#screen');

  const { resolved, world, colony, rng, antType } = buildFromScenario(DEFAULT_SCENARIO);

  const renderer = new Renderer(
    canvas,
    world,
    {
      dayDurationTicks: resolved.dayDurationTicks,
      nightDurationTicks: resolved.nightDurationTicks,
    },
    resolved.surfaceCellsFromTop,
  );

  // Loop runs at the scenario's tick rate. With secondsPerTick=1
  // that's 1 Hz; the renderer interpolates between ticks for smooth
  // motion at 60 fps.
  const simHz = 1 / resolved.secondsPerTick;
  const loop = new Loop(simHz, {
    step: () => stepSimulation(world, colony, rng),
    draw: (alpha: number) => renderer.draw(colony, alpha),
  });

  if (overlayEl) {
    overlayEl.classList.remove('hidden');
    setInterval(() => {
      overlayEl.textContent = [
        `scenario: ${resolved.name}`,
        `seed: 0x${resolved.seed.toString(16)}  tick: ${world.tickCount}`,
        `world: ${resolved.worldWidthCm}×${resolved.worldHeightCm} cm  ` +
          `(${world.width}×${world.height} cells)`,
        `day: ${resolved.dayDurationTicks}t  night: ${resolved.nightDurationTicks}t  ` +
          `tick: ${resolved.secondsPerTick}s`,
        `ants: ${colony.count}  ` +
          Object.entries(resolved.ants).map(([n, s]) => `${n}=${s.count}`).join(' '),
      ].join('\n');
    }, 250);
  }

  // Quiet "unused" suppressor for the antType array (it's exposed to
  // future renderers / analytics that distinguish castes).
  void antType;

  bindVisibilityPause(loop);
  loop.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
