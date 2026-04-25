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

  it('naturalSurface[x] is the topmost soil row at t=0 for every column', () => {
    // The renderer and ant-rules.ts use naturalSurface as ground
    // truth for where the open sky ends. After generate(), the
    // cell at row naturalSurface[x] must be soil for every column
    // OUTSIDE the starter divot (cells inside the divot are
    // carved away).
    const rng = new RNG(42);
    const w = new World(80, 60);
    w.generate(rng, 20, 6, 4);
    const cx = w.width >> 1;
    for (let x = 0; x < w.width; x++) {
      // Skip the carved divot column band (~chamberHalfWidth either side)
      if (Math.abs(x - cx) <= 8) continue;
      const sy = w.naturalSurface[x]!;
      expect(w.cells[w.index(x, sy)]).toBe(CELL_SOIL);
      // And the cell above must be air.
      if (sy > 0) expect(w.cells[w.index(x, sy - 1)]).toBe(CELL_AIR);
    }
  });

  it('countSoil and countGrains return zero on a freshly-allocated world', () => {
    // Pre-generate the cells array is all-zero (CELL_AIR), so both
    // counters must be 0. Catches a bug where the default cell value
    // accidentally drifts off CELL_AIR.
    const w = new World(20, 20);
    expect(w.countSoil()).toBe(0);
    expect(w.countGrains()).toBe(0);
  });
});

describe('World.index', () => {
  it('is consistent at the four boundaries (top-left, top-right, bottom-left, bottom-right)', () => {
    // The row-major formula y*w + x must produce the right linear
    // index at every corner. Catches off-by-one and width/height
    // swap bugs.
    const w = new World(10, 8);
    expect(w.index(0, 0)).toBe(0);
    expect(w.index(9, 0)).toBe(9);
    expect(w.index(0, 7)).toBe(70);
    expect(w.index(9, 7)).toBe(79);
    expect(w.cells.length).toBe(80);
  });

  it('row-major: incrementing x moves by 1, incrementing y moves by width', () => {
    // Same invariant phrased as deltas. If anything ever flips this
    // (e.g. column-major), every loop in physics/render breaks.
    const w = new World(13, 7);
    expect(w.index(4, 3) - w.index(3, 3)).toBe(1);
    expect(w.index(3, 4) - w.index(3, 3)).toBe(13);
  });
});

describe('World.inBounds', () => {
  it('accepts the four corners and rejects each one-step outside', () => {
    // inBounds is the cheap sentinel that physics primitives use
    // before indexing. Off-by-one here would silently let
    // OOB writes through.
    const w = new World(10, 8);
    expect(w.inBounds(0, 0)).toBe(true);
    expect(w.inBounds(9, 7)).toBe(true);
    expect(w.inBounds(-1, 0)).toBe(false);
    expect(w.inBounds(0, -1)).toBe(false);
    expect(w.inBounds(10, 0)).toBe(false);
    expect(w.inBounds(0, 8)).toBe(false);
  });
});
