import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';
import { RNG } from '../src/sim/rng';

describe('World', () => {
  it('generate produces air on top and soil below', () => {
    const w = new World(64, 64);
    w.generate(new RNG(1));
    // Top row should all be air.
    for (let x = 0; x < 64; x++) {
      expect(w.get(x, 0)).toBe(CELL_AIR);
    }
    // Bottom row should all be soil.
    for (let x = 0; x < 64; x++) {
      expect(w.get(x, 63)).toBe(CELL_SOIL);
    }
  });

  it('initialSoilCells matches countSoil after generate', () => {
    const w = new World(64, 64);
    w.generate(new RNG(7));
    expect(w.countSoil()).toBe(w.initialSoilCells);
  });

  it('inBounds rejects out-of-range', () => {
    const w = new World(10, 10);
    expect(w.inBounds(0, 0)).toBe(true);
    expect(w.inBounds(9, 9)).toBe(true);
    expect(w.inBounds(-1, 0)).toBe(false);
    expect(w.inBounds(0, -1)).toBe(false);
    expect(w.inBounds(10, 0)).toBe(false);
    expect(w.inBounds(0, 10)).toBe(false);
  });

  it('surfaceY finds top-most soil/grain', () => {
    const w = new World(10, 10);
    w.set(5, 7, CELL_SOIL);
    expect(w.surfaceY(5)).toBe(7);
    w.set(5, 5, CELL_GRAIN);
    expect(w.surfaceY(5)).toBe(5);
  });
});
