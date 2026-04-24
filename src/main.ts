// Entry point. Wires sim + renderer + loop for the 10-ant restart.

import { CONFIG, parseOptions } from './config';
import { World } from './sim/world';
import { Colony } from './sim/colony';
import { stepSimulation } from './sim/ant-rules';
import { RNG } from './sim/rng';
import { Renderer } from './render/renderer';
import { Loop } from './runtime/loop';
import { bindVisibilityPause } from './runtime/visibility';

function boot(): void {
  const opts = parseOptions();

  const canvas = document.getElementById('screen') as HTMLCanvasElement | null;
  const overlayEl = document.getElementById('overlay') as HTMLDivElement | null;
  if (!canvas) throw new Error('missing canvas#screen');

  const rng = new RNG(opts.seed);
  const world = new World(CONFIG.gridWidth, CONFIG.gridHeight);
  world.generate(rng);

  const colony = new Colony(CONFIG.antCount);
  // Spawn the colony into the starter chamber (find air cells in a
  // box around the world centre, pick randomly).
  const surfaceY = Math.floor(world.height * CONFIG.surfaceFraction);
  const cx = Math.floor(world.width / 2);
  const halfW = CONFIG.starterChamberHalfWidth;
  colony.spawnInRect(
    cx - halfW,
    surfaceY + 1,
    cx + halfW,
    surfaceY + CONFIG.starterChamberDepth,
    CONFIG.antCount,
    rng,
    (x, y) => world.isAir(x, y),
  );

  const renderer = new Renderer(canvas, world);

  const loop = new Loop(CONFIG.simHz, {
    step: () => stepSimulation(world, colony, rng),
    draw: (alpha: number) => renderer.draw(colony, alpha),
  });

  if (overlayEl && opts.showOverlay) {
    overlayEl.classList.remove('hidden');
    setInterval(() => {
      const phase = (world.tickCount % CONFIG.dayLengthTicks) / CONFIG.dayLengthTicks;
      const daylight = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
      overlayEl.textContent = [
        `formicarium restart · seed=${opts.seed.toString(16)}`,
        `ants=${colony.count}  tick=${world.tickCount}`,
        `daylight=${daylight.toFixed(2)}  phase=${phase.toFixed(2)}`,
        `dug=${world.initialSoilCells - world.countSoil()}  grains=${world.countGrains()}`,
      ].join('\n');
    }, 200);
  }

  bindVisibilityPause(loop);
  loop.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
