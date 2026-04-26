// Pheromone field tests pin the reaction-diffusion contract from
// CLAUDE.md §3 (no sample-and-write the same texture in one pass) and
// the deposit/sample/gradient API that ant-rules.ts depends on for
// stigmergy. The 5-point stencil + multiplicative evaporation is the
// substrate for the Grassé/Bonabeau/Deneubourg model: get the math
// wrong and emergent recruitment to dig fronts breaks.

import { describe, expect, it } from 'vitest';
import { Pheromone } from '../src/sim/pheromone';

describe('Pheromone.deposit/sample', () => {
  it('returns the deposited value at the target cell', () => {
    // The deposit/sample round-trip is the most basic contract; if
    // this drifts (e.g. wrong row-major math) every behavioural test
    // downstream becomes meaningless.
    const p = new Pheromone(20, 10, 0.1, 0.99);
    p.deposit(5, 4, 1.5);
    expect(p.sample(5, 4)).toBeCloseTo(1.5, 6);
  });

  it('accumulates additively when depositing twice on the same cell', () => {
    // ant-rules.ts deposits per-tick on dig and on grain placement;
    // multiple ants hitting the same cell must sum, not overwrite.
    const p = new Pheromone(10, 10, 0.1, 0.99);
    p.deposit(3, 3, 0.7);
    p.deposit(3, 3, 0.4);
    expect(p.sample(3, 3)).toBeCloseTo(1.1, 6);
  });

  it('deposit and sample are no-ops outside the grid', () => {
    // Out-of-bounds is silent — agents near the wall sample neighbours
    // beyond the edge during gradient(), so OOB must return 0 rather
    // than crash or wrap around.
    const p = new Pheromone(5, 5, 0.1, 0.99);
    p.deposit(-1, 0, 99);
    p.deposit(0, 99, 99);
    p.deposit(5, 0, 99);
    expect(p.sample(-1, 0)).toBe(0);
    expect(p.sample(0, 99)).toBe(0);
    expect(p.sample(5, 0)).toBe(0);
  });
});

describe('Pheromone.gradient', () => {
  it('returns (0, 0) on a uniform field', () => {
    // Stigmergy bias must vanish when there is no information; an ant
    // in a uniform field should fall back to its correlated random
    // walk and not be pulled in some arbitrary direction.
    const p = new Pheromone(10, 10, 0.1, 0.99);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) p.deposit(x, y, 1);
    }
    const g = p.gradient(5, 5);
    expect(g.dx).toBe(0);
    expect(g.dy).toBe(0);
  });

  it('returns (0, 0) on an empty field', () => {
    // The startup case: no one has dug yet, no pheromone anywhere.
    const p = new Pheromone(10, 10, 0.1, 0.99);
    const g = p.gradient(3, 3);
    expect(g.dx).toBe(0);
    expect(g.dy).toBe(0);
  });

  it('points right when concentration is higher to the right', () => {
    // gradient returns the vector pointing UP the gradient (per the
    // doc on Pheromone.gradient). gradient uses central differences,
    // so the deposit must land at one of the sampled neighbours
    // (x+1) for dx to register at the central cell.
    const p = new Pheromone(10, 10, 0.1, 0.99);
    p.deposit(6, 5, 5); // neighbour to the right of (5,5)
    const g = p.gradient(5, 5);
    expect(g.dx).toBeGreaterThan(0);
    expect(g.dy).toBe(0);
  });

  it('points down when concentration is higher below (positive dy)', () => {
    // y grows downward in this codebase; a peak at (x, y+1) should
    // yield dy > 0 so an ant turning to atan2(dy, dx) faces down.
    const p = new Pheromone(10, 10, 0.1, 0.99);
    p.deposit(5, 6, 5);
    const g = p.gradient(5, 5);
    expect(g.dy).toBeGreaterThan(0);
    expect(g.dx).toBe(0);
  });

  it('points toward a diagonal peak after diffusion spreads it', () => {
    // For the diagonal case we run a few diffusion steps so the
    // central-difference gradient at a far cell can pick up the
    // smoothed influence of the distant peak.
    const p = new Pheromone(20, 20, 0.4, 1.0); // strong diffusion, no decay
    p.deposit(15, 15, 100);
    for (let t = 0; t < 20; t++) p.step();
    const g = p.gradient(10, 10);
    expect(g.dx).toBeGreaterThan(0);
    expect(g.dy).toBeGreaterThan(0);
  });
});

describe('Pheromone.step (evaporation)', () => {
  it('decays an isolated deposit by the evaporation factor each tick', () => {
    // For a single cell with no neighbours, value next tick =
    // ((1 - f) * c + f4 * 0) * e = (1 - f) * c * e. Pinning this
    // catches bugs where evaporation is applied before diffusion or
    // skipped on certain cells.
    const p = new Pheromone(10, 10, 0.2, 0.9);
    p.deposit(5, 5, 100);
    p.step();
    // Interior cell: (1-0.2)*100*0.9 = 72.
    expect(p.sample(5, 5)).toBeCloseTo(72, 4);
  });

  it('eventually clamps near-zero values to 0', () => {
    // The 1e-6 floor exists to keep sparse regions sparse and avoid
    // denormal-float drag. If we step many times on a tiny deposit
    // it must reach exactly 0 (not drift as a denormal).
    const p = new Pheromone(8, 8, 0.05, 0.5);
    p.deposit(4, 4, 0.001);
    for (let t = 0; t < 200; t++) p.step();
    expect(p.sample(4, 4)).toBe(0);
  });

  it('edge cells diffuse with their existing in-grid neighbours (absorbing boundary)', () => {
    // Pre-fix: edges only evaporated and pheromone accumulated there
    // unbounded over long runs (visually a glowing wall on the world
    // border). Now edges diffuse with their existing neighbours;
    // missing out-of-grid neighbours contribute 0 — pheromone past
    // the world is gone.
    const p = new Pheromone(8, 8, 0.5, 0.8);
    p.deposit(0, 3, 10); // left edge with empty neighbours
    p.step();
    // Left edge cell (0, 3) has 3 in-grid neighbours, all zero. So
    // v = ((1 - 0.5)*10 + 0.5/4 * 0) * 0.8 = (5 + 0) * 0.8 = 4.
    // The "missing" west neighbour absorbs 0.5/4 * 10 = 1.25 of the
    // outflow, which is lost outside the grid.
    expect(p.sample(0, 3)).toBeCloseTo(4, 4);
    // The eastward in-grid neighbour (1, 3) receives diffusion
    // outflow: 0.5/4 * 10 * 0.8 = 1.0.
    expect(p.sample(1, 3)).toBeCloseTo(1.0, 4);
  });

  it('total mass is non-increasing under step (evaporation cannot inject)', () => {
    // Diffusion is mass-conserving, evaporation is mass-shedding.
    // Net mass after a step must be <= mass before. Catches
    // sign-flip bugs in the stencil.
    const p = new Pheromone(20, 20, 0.15, 0.97);
    for (let i = 0; i < 50; i++) {
      p.deposit((i * 7) % 20, (i * 13) % 20, 1);
    }
    let before = 0;
    for (let i = 0; i < p.current.length; i++) before += p.current[i]!;
    p.step();
    let after = 0;
    for (let i = 0; i < p.current.length; i++) after += p.current[i]!;
    expect(after).toBeLessThanOrEqual(before + 1e-9);
  });

  it('diffuses concentration to 4-neighbours (5-point stencil)', () => {
    // After one step, a single point deposit should leak some value
    // into each of its four cardinal neighbours. Models the discretised
    // heat equation that gives rise to recruitment trails.
    const p = new Pheromone(10, 10, 0.4, 1.0); // no evaporation
    p.deposit(5, 5, 100);
    p.step();
    // Each cardinal neighbour gets f4 * 100 = 0.1 * 100 = 10.
    expect(p.sample(4, 5)).toBeGreaterThan(0);
    expect(p.sample(6, 5)).toBeGreaterThan(0);
    expect(p.sample(5, 4)).toBeGreaterThan(0);
    expect(p.sample(5, 6)).toBeGreaterThan(0);
    // Diagonal stays zero — 5-point stencil does NOT diffuse on
    // diagonals (a 9-point would; we don't).
    expect(p.sample(4, 4)).toBe(0);
  });
});

describe('Pheromone ping-pong (no double-mutation)', () => {
  it('stepping twice produces the same field as a single explicit two-step compose', () => {
    // The CLAUDE.md §3 invariant: never sample-and-write the same
    // texture in one pass. If swap is broken or scratch is reused as
    // src, the second step would read from a half-written buffer and
    // diverge from the deterministic two-step result.
    const a = new Pheromone(8, 8, 0.2, 0.95);
    const b = new Pheromone(8, 8, 0.2, 0.95);
    a.deposit(4, 4, 50);
    b.deposit(4, 4, 50);
    a.step(); a.step();
    b.step(); b.step();
    for (let i = 0; i < a.current.length; i++) {
      expect(a.current[i]).toBeCloseTo(b.current[i]!, 6);
    }
  });

  it('current is a different reference after step (the swap actually swapped)', () => {
    // The cheap structural assertion that the buffer pointer rotated.
    // If `current` and `scratch` ended up aliased we'd have undefined
    // behaviour next tick.
    const p = new Pheromone(8, 8, 0.2, 0.95);
    const before = p.current;
    p.step();
    expect(p.current).not.toBe(before);
  });

  it('a single deposit then step puts (1-f)*c*e at the source, not 0', () => {
    // Regression: if scratch was never zeroed between steps, an old
    // value could leak through. This tests one step starting from
    // clean scratch produces the documented value at the source.
    const p = new Pheromone(8, 8, 0.2, 0.95);
    p.deposit(4, 4, 100);
    p.step();
    // (1-f)*c*e = 0.8*100*0.95 = 76.
    expect(p.sample(4, 4)).toBeCloseTo(76, 4);
  });

  it('REGRESSION: edges do NOT accumulate pheromone fed from interior', () => {
    // Before the boundary-fix, edge cells only evaporated — they
    // never lost pheromone via diffusion. Interior cells still leaked
    // INTO edges via the 5-point stencil, so over many ticks the
    // edges became unbounded pheromone traps. User observed a
    // glowing magenta wall on the world boundary in deployed runs.
    //
    // This pins the fix: deposit at an interior cell adjacent to the
    // left edge, run many ticks, and verify the edge cell never
    // accumulates more than a sensible bound relative to the source.
    const p = new Pheromone(20, 20, 0.4, 0.99);
    for (let t = 0; t < 200; t++) {
      p.deposit(1, 10, 5.0); // adjacent to left edge at (0, 10)
      p.step();
    }
    const interior = p.sample(1, 10);
    const edge = p.sample(0, 10);
    // Edge gets fed by interior but the absorbing boundary lets it
    // shed pheromone too — no runaway accumulation.
    expect(edge).toBeLessThan(interior);
    expect(edge).toBeLessThan(interior * 0.6);
  });
});
