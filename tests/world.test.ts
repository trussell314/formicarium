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

  it('starter divot is approximately circular and centred on cx', () => {
    const rng = new RNG(2);
    const w = new World(80, 60);
    w.generate(rng, 20, 6, 4);
    const cx = w.width >> 1;
    // The cell directly under the centre at the natural surface row
    // should always be AIR (the divot's top).
    const surfHere = w.naturalSurface[cx]!;
    expect(w.cells[w.index(cx, surfHere)]).toBe(CELL_AIR);
    // Two cells outside the divot (radius ~5 here) should still be soil.
    expect(w.cells[w.index(cx + 12, surfHere + 2)]).toBe(CELL_SOIL);
  });

  it('initialSoilCells matches the actual soil count', () => {
    const rng = new RNG(3);
    const w = new World(120, 80);
    w.generate(rng, 28, 8, 6);
    expect(w.initialSoilCells).toBe(w.countSoil());
  });
});
