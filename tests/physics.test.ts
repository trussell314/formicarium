import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';
import { isSupported, settle, tryStep } from '../src/sim/physics';

function blank(w: number, h: number): World {
  const wd = new World(w, h);
  wd.cells.fill(CELL_AIR);
  for (let x = 0; x < w; x++) wd.naturalSurface[x] = h;
  return wd;
}

describe('physics', () => {
  it('isSupported true at world bottom', () => {
    const w = blank(20, 10);
    expect(isSupported(w, 5, 9)).toBe(true);
  });

  it('isSupported true with solid below', () => {
    const w = blank(20, 10);
    w.cells[w.index(5, 6)] = CELL_SOIL;
    expect(isSupported(w, 5, 5)).toBe(true);
  });

  it('isSupported false in mid-air', () => {
    const w = blank(20, 10);
    expect(isSupported(w, 5, 4)).toBe(false);
  });

  it('tryStep refuses solid and reports hitSoil only on SOIL', () => {
    const w = blank(20, 10);
    w.cells[w.index(5, 5)] = CELL_SOIL;
    w.cells[w.index(7, 5)] = CELL_GRAIN;
    const intoSoil = tryStep(w, 4.5, 5.5, 1, 0);
    expect(intoSoil.hitSoil).toBe(true);
    expect(intoSoil.x).toBe(4.5);
    const intoGrain = tryStep(w, 6.5, 5.5, 1, 0);
    // Without clearance above, grain should also block (no climb).
    // But if the cell above is air, stair-step lifts the ant.
    // Default empty world is all air, so stair-step succeeds.
    expect(intoGrain.hitSoil).toBe(false);
    expect(intoGrain.y).toBeLessThan(5.5);
  });

  it('settle drops a single cell when unsupported', () => {
    const w = blank(20, 10);
    // Floor at y=8.
    for (let x = 0; x < w.width; x++) w.cells[w.index(x, 9)] = CELL_SOIL;
    // Ant in mid-air at y=4.
    const after = settle(w, 5, 4);
    expect(after).toBe(5);
  });

  it('settle extricates from solid (e.g. just-dug spot collapsed)', () => {
    const w = blank(20, 10);
    for (let x = 0; x < w.width; x++) w.cells[w.index(x, 9)] = CELL_SOIL;
    w.cells[w.index(5, 8)] = CELL_SOIL;
    // Embedded at (5, 8). settle should pop it up.
    const after = settle(w, 5, 8);
    expect(after).toBe(7);
  });
});
