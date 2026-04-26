import { describe, expect, it } from 'vitest';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';
import { digCell, isSupported, pickGrain, placeGrain, settle, settleGrain, tryStep } from '../src/sim/physics';
import { RNG } from '../src/sim/rng';

function blank(w: number, h: number): World {
  const wd = new World(w, h);
  wd.cells.fill(CELL_AIR);
  for (let x = 0; x < w; x++) wd.naturalSurface[x] = h;
  return wd;
}

/** Blank world with a soil floor at the bottom row, surface = h-1. */
function withFloor(w: number, h: number): World {
  const wd = blank(w, h);
  for (let x = 0; x < w; x++) {
    wd.cells[wd.index(x, h - 1)] = CELL_SOIL;
    wd.naturalSurface[x] = h - 1;
  }
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

describe('tryStep — out of bounds and stair-step', () => {
  it('refuses out-of-bounds moves in all four directions', () => {
    // tryStep is the no-fly-through-solid AND no-fly-off-the-grid
    // gatekeeper. The implicit "outside grid is solid" rule comes
    // from this clamp.
    const w = blank(10, 10);
    expect(tryStep(w, 0, 5, -1, 0)).toEqual({ x: 0, y: 5, hitSoil: false }); // left
    expect(tryStep(w, 9, 5, 1, 0)).toEqual({ x: 9, y: 5, hitSoil: false });  // right
    expect(tryStep(w, 5, 0, 0, -1)).toEqual({ x: 5, y: 0, hitSoil: false }); // up
    expect(tryStep(w, 5, 9, 0, 1)).toEqual({ x: 5, y: 9, hitSoil: false });  // down
  });

  it('stair-steps over a 1-cell grain pile when the head clearance is air', () => {
    // The 2D abstraction of tarsal-claw climbing — ants step UP when
    // the cell-above-the-obstacle is clear. A 1-cell grain at
    // (6, 5) with clearance above must produce a y reduction.
    const w = blank(20, 10);
    w.cells[w.index(6, 5)] = CELL_GRAIN;
    const r = tryStep(w, 5.5, 5.5, 1, 0);
    expect(r.hitSoil).toBe(false);
    expect(r.x).toBe(6.5);
    expect(r.y).toBeLessThan(5.5);
  });

  it('stair-steps over a 2-cell grain pile (max climb)', () => {
    // MAX_CLIMB = 2 is hard-coded. A 2-cell stack must still be
    // walkable; a 3-cell stack must not (covered separately).
    const w = blank(20, 10);
    w.cells[w.index(6, 5)] = CELL_GRAIN;
    w.cells[w.index(6, 4)] = CELL_GRAIN;
    const r = tryStep(w, 5.5, 5.5, 1, 0);
    expect(r.hitSoil).toBe(false);
    expect(r.y).toBeLessThanOrEqual(3.5);
  });

  it('refuses to climb a 3-cell grain pile (over MAX_CLIMB)', () => {
    // Real ants can't trivially scale arbitrary mounds in this
    // model — the cap forces them to walk around or wait for the
    // pile to slump. If we lifted this, mound-shape physics would
    // degenerate.
    const w = blank(20, 10);
    w.cells[w.index(6, 5)] = CELL_GRAIN;
    w.cells[w.index(6, 4)] = CELL_GRAIN;
    w.cells[w.index(6, 3)] = CELL_GRAIN;
    const r = tryStep(w, 5.5, 5.5, 1, 0);
    expect(r.x).toBe(5.5);
    expect(r.y).toBe(5.5);
  });

  it('refuses to climb when the head clearance above is itself solid', () => {
    // Even a 1-cell grain is unclimbable if the cell above it is
    // soil — the ant has nowhere to put its body after stepping up.
    const w = blank(20, 10);
    w.cells[w.index(6, 5)] = CELL_GRAIN;
    w.cells[w.index(6, 4)] = CELL_SOIL; // ceiling above the pile
    const r = tryStep(w, 5.5, 5.5, 1, 0);
    expect(r.x).toBe(5.5);
    expect(r.y).toBe(5.5);
  });
});

describe('placeGrain / settleGrain (sandpile)', () => {
  it('a single grain dropped from above lands on the floor', () => {
    // Trivial gravity: air column above floor → grain ends up at
    // the row above the floor. The whole sandpile cascade reduces to
    // this in the simplest case.
    const w = withFloor(20, 10); // floor at y=9
    const rng = new RNG(1);
    const final = placeGrain(w, 10, 0, rng, 1);
    expect(final).not.toBeNull();
    expect(final!.y).toBe(8);
    expect(w.cells[w.index(10, 8)]).toBe(CELL_GRAIN);
  });

  it('returns null for non-air seed cells (cannot place into solid)', () => {
    // The placeGrain contract: only air cells are valid seeds.
    // Otherwise we'd silently overwrite soil and break grain
    // conservation.
    const w = withFloor(20, 10);
    const rng = new RNG(1);
    expect(placeGrain(w, 10, 9, rng, 1)).toBeNull(); // floor cell is soil
    // Out-of-bounds is also null.
    expect(placeGrain(w, -1, 5, rng, 1)).toBeNull();
    expect(placeGrain(w, 5, 99, rng, 1)).toBeNull();
  });

  it('repeated placement at one column produces a stable sandpile (angle of repose emerges)', () => {
    // Bak/Tang/Wiesenfeld 1987: drop 50 grains at the same column;
    // the cascade rule must spread them sideways into a pile, not
    // a 1-wide pillar to the ceiling. Validates the diagonal-slide
    // branch of settleGrain.
    const w = withFloor(40, 20);
    const rng = new RNG(0xabc);
    for (let i = 0; i < 50; i++) {
      placeGrain(w, 20, 0, rng);
    }
    // Count grains in the centre column vs. neighbours: pile should
    // be wider than 1 cell.
    let centre = 0, neighbour = 0;
    for (let y = 0; y < 19; y++) {
      if (w.cells[w.index(20, y)] === CELL_GRAIN) centre++;
      if (w.cells[w.index(19, y)] === CELL_GRAIN) neighbour++;
      if (w.cells[w.index(21, y)] === CELL_GRAIN) neighbour++;
    }
    expect(neighbour).toBeGreaterThan(0);
    // Pile height shouldn't reach the top — most grains are off to the side.
    expect(centre).toBeLessThan(19);
  });

  it('grain conservation: every placed grain ends up as exactly one grain cell', () => {
    // Sum of grains in world equals number of placeGrain calls that
    // returned non-null. Catches cells being stranded as orphan
    // SOIL or vanishing in the cascade.
    const w = withFloor(30, 20);
    const rng = new RNG(0xdef);
    let placed = 0;
    for (let i = 0; i < 30; i++) {
      const r = placeGrain(w, 15, 0, rng, 1);
      if (r !== null) placed++;
    }
    expect(w.countGrains()).toBe(placed);
  });
});

describe('pickGrain', () => {
  it('clears the cell and decrements mound for that column', () => {
    // pickGrain must zero the cell (so it becomes traversable air)
    // and update world.mound[x] so the renderer's mound stat stays
    // accurate.
    const w = withFloor(20, 10); // surface at y=9, mound counted above row 9
    const rng = new RNG(1);
    placeGrain(w, 10, 0, rng, 1); // lands at (10, 8)
    expect(w.cells[w.index(10, 8)]).toBe(CELL_GRAIN);
    expect(w.mound[10]).toBe(1);
    // pickGrain returns the grain's stored move count (>= 0) on
    // success or -1 on failure.
    const moves = pickGrain(w, 10, 8, rng);
    expect(moves).toBeGreaterThanOrEqual(0);
    expect(w.cells[w.index(10, 8)]).toBe(CELL_AIR);
    expect(w.mound[10]).toBe(0);
  });

  it('returns -1 on non-grain cells', () => {
    // The Theraulaz pickup rule asks the env "is this grain?"
    // before committing. -1 means the agent's transition is
    // refused; if pickGrain lied here, ants would CARRY phantom grains.
    const w = withFloor(10, 10);
    const rng = new RNG(1);
    expect(pickGrain(w, 5, 9, rng)).toBe(-1); // soil
    expect(pickGrain(w, 5, 5, rng)).toBe(-1); // air
    expect(pickGrain(w, -1, 5, rng)).toBe(-1); // OOB
  });

  it('re-settles a grain that was sitting on top', () => {
    // If we pull out the bottom grain of a 2-stack, the upper
    // grain must cascade into the void. Otherwise we'd have a
    // floating grain and break the sandpile invariant.
    // We stack grains by direct cell writes (placeGrain may slide
    // diagonally, defeating the deterministic two-stack setup).
    const w = withFloor(10, 10);
    const rng = new RNG(2);
    // Surround so the top grain has nowhere to slide diagonally.
    w.cells[w.index(4, 8)] = CELL_GRAIN;
    w.cells[w.index(6, 8)] = CELL_GRAIN;
    w.cells[w.index(5, 8)] = CELL_GRAIN; // bottom of the stack
    w.cells[w.index(5, 7)] = CELL_GRAIN; // top of the stack
    pickGrain(w, 5, 8, rng);
    // The grain that was at (5,7) must have fallen into (5,8).
    expect(w.cells[w.index(5, 7)]).toBe(CELL_AIR);
    expect(w.cells[w.index(5, 8)]).toBe(CELL_GRAIN);
  });
});

describe('digCell', () => {
  it('removes a soil cell and returns true', () => {
    // The excavation primitive. After digCell, the cell must be air
    // and the grain count of the world is unchanged (digging produces
    // a CARRY ant separately; the cell itself just becomes air).
    const w = withFloor(10, 10);
    const rng = new RNG(1);
    expect(digCell(w, 5, 9, rng)).toBe(true);
    expect(w.cells[w.index(5, 9)]).toBe(CELL_AIR);
  });

  it('returns false on non-soil cells (no double-dig, no air-dig)', () => {
    // ant-rules.ts may dispatch a dig at a cell that just became
    // air via a neighbour's cascade; digCell must refuse rather
    // than silently re-fire and inflate the dug-cell tally.
    const w = withFloor(10, 10);
    const rng = new RNG(1);
    expect(digCell(w, 5, 5, rng)).toBe(false);  // air
    expect(digCell(w, -1, 9, rng)).toBe(false); // OOB
    w.cells[w.index(5, 5)] = CELL_GRAIN;
    expect(digCell(w, 5, 5, rng)).toBe(false);  // grain (use pickGrain instead)
  });

  it('cascades a grain that was sitting directly above the dug cell', () => {
    // Physical consistency: removing soil with a grain on top must
    // resettle that grain into the new void. Otherwise we'd violate
    // the sandpile invariant and leave a floating grain.
    const w = withFloor(10, 10);
    const rng = new RNG(3);
    // Two stacked soils at (5, 8) and (5, 9), with a grain on top at (5, 7).
    w.cells[w.index(5, 8)] = CELL_SOIL;
    w.cells[w.index(5, 7)] = CELL_GRAIN;
    digCell(w, 5, 8, rng);
    // Grain that was at (5,7) must have fallen into (5,8) (the new void).
    expect(w.cells[w.index(5, 7)]).toBe(CELL_AIR);
    expect(w.cells[w.index(5, 8)]).toBe(CELL_GRAIN);
  });
});

describe('settleGrain edge cases', () => {
  it('a grain at the bottom row stays put (off-world stop)', () => {
    // The y+1 >= h guard protects against indexing past the grid;
    // a grain on the floor is already at rest.
    const w = blank(10, 10);
    const rng = new RNG(1);
    w.cells[w.index(5, 9)] = CELL_GRAIN;
    const r = settleGrain(w, 5, 9, rng);
    expect(r.x).toBe(5);
    expect(r.y).toBe(9);
    expect(w.cells[w.index(5, 9)]).toBe(CELL_GRAIN);
  });
});
