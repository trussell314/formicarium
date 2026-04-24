import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';
import { isSupported, settle, tryStep } from '../src/sim/physics';

function blank(w = 16, h = 16): World {
  const world = new World(w, h);
  world.cells.fill(CELL_AIR);
  return world;
}

function stamp(world: World, x: number, y: number, kind: number): void {
  world.cells[world.index(x, y)] = kind;
}

describe('isSupported', () => {
  it('returns true when cell below is soil', () => {
    const w = blank();
    stamp(w, 5, 6, CELL_SOIL);
    expect(isSupported(w, 5, 5)).toBe(true);
  });

  it('returns true when cell below is grain', () => {
    const w = blank();
    stamp(w, 5, 6, CELL_GRAIN);
    expect(isSupported(w, 5, 5)).toBe(true);
  });

  it('returns true when lateral neighbour is solid (wall grip)', () => {
    const w = blank();
    stamp(w, 4, 5, CELL_SOIL);
    expect(isSupported(w, 5, 5)).toBe(true);
  });

  it('returns true when below-diagonal is solid (ledge)', () => {
    const w = blank();
    stamp(w, 4, 6, CELL_SOIL);
    expect(isSupported(w, 5, 5)).toBe(true);
  });

  it('returns false when ant is surrounded only by air', () => {
    const w = blank();
    expect(isSupported(w, 5, 5)).toBe(false);
  });

  it('returns true at the bottom row of the world', () => {
    const w = blank(16, 16);
    expect(isSupported(w, 5, 15)).toBe(true);
  });
});

describe('tryStep (strict no-flying rule)', () => {
  it('moves into supported air', () => {
    const w = blank();
    // Floor under row 5.
    for (let x = 0; x < w.width; x++) stamp(w, x, 6, CELL_SOIL);
    const r = tryStep(w, 5.5, 5.5, 1, 0);
    expect(r.x).toBeCloseTo(6.5);
    expect(r.y).toBeCloseTo(5.5);
  });

  it('refuses moving off a cliff into unsupported air', () => {
    const w = blank();
    // Floor from x=0..5 only at y=6. Beyond x=5, no floor.
    for (let x = 0; x <= 5; x++) stamp(w, x, 6, CELL_SOIL);
    // Ant at the last supported cell (5, 5) stepping right:
    // destination (6, 5) has (6, 6) air, (7, 6) air, (5, 6) soil (diag).
    // That DIAG support still counts — one cell gap is fine.
    const r1 = tryStep(w, 5.5, 5.5, 1, 0);
    expect(r1.x).toBeGreaterThan(5.5);
    // But stepping to (7, 5) with (5.5, 5.5) start + dx=2, destination
    // (7, 5.5) → (7, 5) cell, support check fails (neighbours all air).
    const r2 = tryStep(w, 5.5, 5.5, 2, 0);
    expect(r2.x).toBe(5.5);
    expect(r2.y).toBe(5.5);
  });

  it('refuses moving into solid and reports hitSoil', () => {
    const w = blank();
    stamp(w, 6, 5, CELL_SOIL);
    stamp(w, 5, 6, CELL_SOIL);
    const r = tryStep(w, 5.5, 5.5, 1, 0);
    expect(r.x).toBe(5.5);
    expect(r.hitSoil).toBe(true);
  });

  it('refuses leaving the world bounds', () => {
    const w = blank();
    const r = tryStep(w, 0.5, 0.5, -1, 0);
    expect(r.x).toBe(0.5);
    expect(r.y).toBe(0.5);
  });
});

describe('settle', () => {
  it('extricates upward through solid cells', () => {
    const w = blank();
    // Soil at y=5..7, air above.
    for (let y = 5; y <= 7; y++) stamp(w, 5, y, CELL_SOIL);
    const iy = settle(w, 5, 6); // embedded inside soil
    expect(iy).toBe(4); // lands on top of soil
  });

  it('drops an ant in free air to the floor', () => {
    const w = blank();
    for (let x = 0; x < w.width; x++) stamp(w, x, 10, CELL_SOIL);
    const iy = settle(w, 5, 2);
    expect(iy).toBe(9); // resting on floor
  });

  it('keeps an ant already on a floor where it is', () => {
    const w = blank();
    for (let x = 0; x < w.width; x++) stamp(w, x, 10, CELL_SOIL);
    const iy = settle(w, 5, 9);
    expect(iy).toBe(9);
  });

  it('lands on bottom of world if no floor exists', () => {
    const w = blank(10, 10);
    const iy = settle(w, 5, 3);
    expect(iy).toBe(9);
  });

  it('keeps an ant clinging to a wall in open shaft', () => {
    const w = blank();
    // Vertical shaft with soil walls at x=4 and x=6, y=3..9.
    for (let y = 3; y <= 9; y++) {
      stamp(w, 4, y, CELL_SOIL);
      stamp(w, 6, y, CELL_SOIL);
    }
    // Ant at (5, 5) in the shaft. Walls give lateral support.
    const iy = settle(w, 5, 5);
    expect(iy).toBe(5);
  });
});
