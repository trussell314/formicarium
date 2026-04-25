import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';
import { RNG } from '../src/sim/rng';

describe('World.generate', () => {
  it('produces a soil-below / air-above grid with a starter chamber', () => {
    const rng = new RNG(1);
    const w = new World(80, 60);
    w.generate(rng, 20, 6, 4);
    // Top row is air.
    for (let x = 0; x < w.width; x++) {
      expect(w.cells[w.index(x, 0)]).toBe(CELL_AIR);
    }
    // Bottom row is soil.
    for (let x = 0; x < w.width; x++) {
      expect(w.cells[w.index(x, w.height - 1)]).toBe(CELL_SOIL);
    }
    // Chamber center is air.
    const cx = w.width >> 1;
    expect(w.cells[w.index(cx, 22)]).toBe(CELL_AIR);
  });

  it('does not leave grass floating over the chamber', () => {
    const rng = new RNG(2);
    const w = new World(80, 60);
    w.generate(rng, 20, 6, 4);
    // For each chamber column, the natural-surface row is AIR (carved).
    const cx = w.width >> 1;
    for (let dx = -5; dx <= 5; dx++) {
      const x = cx + dx;
      const sy = w.naturalSurface[x]!;
      expect(w.cells[w.index(x, sy)]).toBe(CELL_AIR);
    }
  });

  it('initialSoilCells matches the actual soil count', () => {
    const rng = new RNG(3);
    const w = new World(120, 80);
    w.generate(rng, 28, 8, 6);
    expect(w.initialSoilCells).toBe(w.countSoil());
  });
});
