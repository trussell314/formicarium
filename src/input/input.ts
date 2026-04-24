// Input wiring. SPEC §6.7 + §7. Mouse poke + keyboard bindings.

import type { World } from '../sim/world';
import type { Colony } from '../sim/colony';
import type { FieldsState } from '../sim/fields';
import { applyDisturbance } from '../sim/ant-rules';
import type { Loop } from '../runtime/loop';
import type { RNG } from '../sim/rng';

export interface InputContext {
  canvas: HTMLCanvasElement;
  world: World;
  colony: Colony;
  fields: FieldsState;
  loop: Loop;
  rng: RNG;
  /** Reseed and rebuild the world. */
  reseed: (seed?: number) => void;
  /** Toggle dev overlay element. */
  toggleOverlay: () => void;
  /** Toggle pheromone visualization in renderer. */
  togglePheromones: () => void;
  /** Reset world (clear soil scratching) but keep ants. */
  clearWorld: () => void;
  /** Spawn a small burst of ants near the surface. */
  spawnBurst: () => void;
}

/**
 * Convert a window-pixel coordinate (clientX/Y) to world cell coordinates.
 * Mirrors the cover-fit logic in Renderer.fitRect, but uses CSS pixels.
 */
function clientToWorld(
  ctx: InputContext,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = ctx.canvas.getBoundingClientRect();
  const cw = rect.width;
  const ch = rect.height;
  const ww = ctx.world.width;
  const wh = ctx.world.height;
  const sx = cw / ww;
  const sy = ch / wh;
  const s = Math.max(sx, sy);
  const dw = ww * s;
  const dh = wh * s;
  const dx = (cw - dw) * 0.5;
  const dy = (ch - dh) * 0.5;
  const x = (clientX - rect.left - dx) / s;
  const y = (clientY - rect.top - dy) / s;
  return { x, y };
}

export function bindInput(ctx: InputContext): () => void {
  const onPointer = (ev: MouseEvent): void => {
    if (ev.button !== 0 && ev.type !== 'mousemove') return;
    if (ev.type === 'mousemove' && (ev.buttons & 1) === 0) return;
    const { x, y } = clientToWorld(ctx, ev.clientX, ev.clientY);
    if (x < 0 || y < 0 || x >= ctx.world.width || y >= ctx.world.height) return;
    applyDisturbance(ctx.world, ctx.colony, ctx.fields, x, y);
  };

  const onKey = (ev: KeyboardEvent): void => {
    // Ignore modified keys so OS shortcuts still work.
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    switch (ev.key.toLowerCase()) {
      case ' ':
        if (ctx.loop.isRunning()) ctx.loop.pause();
        else ctx.loop.resume();
        ev.preventDefault();
        break;
      case 'h':
        ctx.toggleOverlay();
        break;
      case 'p':
        ctx.togglePheromones();
        break;
      case 'r':
        ctx.reseed();
        break;
      case 'c':
        ctx.clearWorld();
        break;
      case 'n':
        ctx.spawnBurst();
        break;
    }
  };

  ctx.canvas.addEventListener('mousedown', onPointer);
  ctx.canvas.addEventListener('mousemove', onPointer);
  window.addEventListener('keydown', onKey);

  return () => {
    ctx.canvas.removeEventListener('mousedown', onPointer);
    ctx.canvas.removeEventListener('mousemove', onPointer);
    window.removeEventListener('keydown', onKey);
  };
}
