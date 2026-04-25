// Entry point — boots the web app from the default scenario.
//
// Click/tap on an ant to see its identity (generated name) and
// motivation. The info panel tracks the selected ant across ticks.

import { buildFromScenario } from './scenario';
import { DEFAULT_SCENARIO } from './scenarios/default';
import { stepSimulation } from './sim/ant-rules';
import { createPheromones } from './sim/pheromone';
import { Renderer } from './render/renderer';
import { Loop } from './runtime/loop';
import { bindVisibilityPause } from './runtime/visibility';
import { antName } from './names';
import { motivationOf } from './motivation';
import { CELLS_PER_CM } from './scenario';

function boot(): void {
  const canvasMaybe = document.getElementById('screen') as HTMLCanvasElement | null;
  const overlayEl = document.getElementById('overlay') as HTMLDivElement | null;
  const antInfoEl = document.getElementById('antinfo') as HTMLDivElement | null;
  if (!canvasMaybe) throw new Error('missing canvas#screen');
  const canvas = canvasMaybe;

  const { resolved, world, colony, rng, antType } = buildFromScenario(DEFAULT_SCENARIO);
  const pheromones = createPheromones(world.width, world.height);

  const renderer = new Renderer(
    canvas,
    world,
    {
      dayDurationTicks: resolved.dayDurationTicks,
      nightDurationTicks: resolved.nightDurationTicks,
    },
    resolved.surfaceCellsFromTop,
    resolved.cellsPerCm,
  );

  const simHz = 1 / resolved.secondsPerTick;
  const loop = new Loop(simHz, {
    step: () => stepSimulation(
      world,
      colony,
      rng,
      resolved.slabThicknessCm,
      pheromones,
      { dayDurationTicks: resolved.dayDurationTicks, nightDurationTicks: resolved.nightDurationTicks },
    ),
    draw: (alpha: number) => renderer.draw(colony, alpha),
  });

  // Click / tap → select nearest ant within a reasonable radius.
  function pointerToAntId(clientX: number, clientY: number): number {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (canvas.width / rect.width);
    const py = (clientY - rect.top) * (canvas.height / rect.height);
    const worldPt = renderer.canvasToWorld(px, py);
    if (!worldPt) return -1;
    let best = -1;
    let bestDist2 = Infinity;
    for (let i = 0; i < colony.count; i++) {
      const dx = colony.posX[i]! - worldPt.x;
      const dy = colony.posY[i]! - worldPt.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        best = i;
      }
    }
    // Require the click to be within ~1.5× body length of an ant.
    const threshold = 1.5 * (colony.bodyLengthCells[best] ?? 10);
    return bestDist2 <= threshold * threshold ? best : -1;
  }

  function renderInfoPanel(): void {
    if (!antInfoEl) return;
    const id = renderer.selectedAntId;
    if (id < 0 || id >= colony.count) {
      antInfoEl.classList.add('hidden');
      return;
    }
    const m = motivationOf(colony, id);
    const xCm = (colony.posX[id]! / CELLS_PER_CM).toFixed(2);
    const yCm = (colony.posY[id]! / CELLS_PER_CM).toFixed(2);
    const dest = m.destinationCm
      ? `${m.destinationCm.x.toFixed(1)}, ${m.destinationCm.y.toFixed(1)} cm`
      : '—';
    antInfoEl.classList.remove('hidden');
    antInfoEl.innerHTML = [
      `<span class="close" id="antinfo-close">×</span>`,
      `<div class="name">${antName(id)}</div>`,
      `<div class="id">#${id} · ${antType[id] ?? 'worker'}</div>`,
      `<div class="row"><span class="label">state</span><span class="value">${m.stateLabel}</span></div>`,
      `<div class="row"><span class="label">doing</span><span class="value">${m.description}</span></div>`,
      `<div class="row"><span class="label">for</span><span class="value">${(m.stateTicks * resolved.secondsPerTick).toFixed(1)} s</span></div>`,
      `<div class="row"><span class="label">at</span><span class="value">${xCm}, ${yCm} cm</span></div>`,
      `<div class="row"><span class="label">dest</span><span class="value">${dest}</span></div>`,
    ].join('');
    const closeBtn = document.getElementById('antinfo-close');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        renderer.selectedAntId = -1;
        renderInfoPanel();
      };
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    const id = pointerToAntId(e.clientX, e.clientY);
    renderer.selectedAntId = id;
    renderInfoPanel();
  });

  // Keep the panel in sync with sim state (position, motivation
  // updates live without needing a fresh click).
  setInterval(renderInfoPanel, 200);

  if (overlayEl) {
    overlayEl.classList.remove('hidden');
    setInterval(() => {
      overlayEl.textContent = [
        `scenario: ${resolved.name}`,
        `seed: 0x${resolved.seed.toString(16)}  tick: ${world.tickCount}`,
        `world: ${resolved.worldWidthCm}×${resolved.worldHeightCm} cm ` +
          `(${world.width}×${world.height} cells)`,
        `day: ${resolved.dayDurationSec}s  night: ${resolved.nightDurationSec}s  ` +
          `tick: ${resolved.secondsPerTick}s`,
        `ants: ${colony.count}  ` +
          Object.entries(resolved.ants).map(([n, s]) => `${n}=${s.count}`).join(' '),
      ].join('\n');
    }, 250);
  }

  // Speed control. Buttons in #speed (1×/2×/4×/8×/16×/32×) drive
  // loop.speedMultiplier directly. Highlight the active one.
  const speedEl = document.getElementById('speed');
  if (speedEl) {
    const buttons = Array.from(speedEl.querySelectorAll('button[data-speed]')) as HTMLButtonElement[];
    const setSpeed = (mult: number): void => {
      loop.speedMultiplier = mult;
      for (const b of buttons) {
        const m = Number(b.dataset.speed);
        b.classList.toggle('active', m === mult);
      }
    };
    setSpeed(1);
    for (const b of buttons) {
      b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
    }
  }

  bindVisibilityPause(loop);
  loop.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
