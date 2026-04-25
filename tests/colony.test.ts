// Colony tests pin the SoA-storage invariants from CLAUDE.md §5
// (parallel TypedArrays, never an array of class instances), the
// capacity discipline (`spawn` never overflows), and the trait
// heterogeneity that emergent task allocation depends on
// (Beshers & Fewell 2001 — identical agents can't differentiate
// roles, so spawn must produce a Gaussian spread per parameter).

import { describe, expect, it } from 'vitest';
import {
  Colony,
  STATE_CARRY,
  STATE_REST,
  STATE_WANDER,
} from '../src/sim/colony';
import { RNG } from '../src/sim/rng';

const MEANS = {
  digProb: 0.10,
  pickProb: 0.02,
  stigmergy: 0.55,
  turnNoise: 0.35,
  restThreshold: 8.0,
};

describe('Colony.spawn', () => {
  it('refuses to overflow capacity and returns -1', () => {
    // Capacity is the absolute upper bound on the SoA arrays — any
    // overflow would silently clobber another ant's state. spawn must
    // signal failure so callers can stop trying.
    const rng = new RNG(1);
    const c = new Colony(3);
    expect(c.spawn(0, 0, 0, rng, MEANS)).toBe(0);
    expect(c.spawn(1, 0, 0, rng, MEANS)).toBe(1);
    expect(c.spawn(2, 0, 0, rng, MEANS)).toBe(2);
    expect(c.spawn(3, 0, 0, rng, MEANS)).toBe(-1);
    expect(c.count).toBe(3);
  });

  it('assigns sequential IDs starting at 0 and bumps count', () => {
    // ID == array index. The renderer and physics rely on the index
    // returned by spawn matching the slot in posX/posY/etc.
    const rng = new RNG(2);
    const c = new Colony(5);
    for (let i = 0; i < 5; i++) {
      const id = c.spawn(i, 0, 0, rng, MEANS);
      expect(id).toBe(i);
      expect(c.count).toBe(i + 1);
    }
  });

  it('writes the spawn position, prev position, and heading', () => {
    // prevX/prevY default to the spawn position so the renderer's
    // first interpolation step doesn't show a teleport from (0,0).
    const rng = new RNG(3);
    const c = new Colony(1);
    c.spawn(12.25, 7.75, 1.5, rng, MEANS);
    expect(c.posX[0]).toBe(12.25);
    expect(c.posY[0]).toBe(7.75);
    expect(c.prevX[0]).toBe(12.25);
    expect(c.prevY[0]).toBe(7.75);
    expect(c.heading[0]).toBe(1.5);
    expect(c.state[0]).toBe(STATE_WANDER);
    expect(c.stateTicks[0]).toBe(0);
    expect(c.collisionCount[0]).toBe(0);
  });

  it('clamps trait values to mean*0.2 floor (no zero or negative traits)', () => {
    // A zero turnNoise or zero restThreshold would break the
    // behaviour model (no random walk; instant REST). The explicit
    // floor in `trait()` exists to prevent that even when Gaussian
    // tails undershoot.
    const rng = new RNG(4);
    const c = new Colony(2000);
    for (let i = 0; i < 2000; i++) {
      c.spawn(0, 0, 0, rng, MEANS, /* sigma */ 5.0); // huge sigma to drive negatives
    }
    // Float32 storage rounds the f64 floor down by up to 1 ULP, so
    // assert with a tiny epsilon. The trait() floor is intentional
    // (see `Colony.trait`); this test guards the spec, not float
    // exactness.
    const EPS = 1e-6;
    for (let i = 0; i < c.count; i++) {
      expect(c.digProb[i]).toBeGreaterThanOrEqual(MEANS.digProb * 0.2 - EPS);
      expect(c.pickProb[i]).toBeGreaterThanOrEqual(MEANS.pickProb * 0.2 - EPS);
      expect(c.stigmergy[i]).toBeGreaterThanOrEqual(MEANS.stigmergy * 0.2 - EPS);
      expect(c.turnNoise[i]).toBeGreaterThanOrEqual(MEANS.turnNoise * 0.2 - EPS);
      expect(c.restThreshold[i]).toBeGreaterThanOrEqual(MEANS.restThreshold * 0.2 - EPS);
    }
  });

  it('samples traits with mean approximately equal to param mean', () => {
    // Beshers & Fewell 2001: heterogeneity is what makes division of
    // labour possible. Pin that the average matches what the user
    // dialled in (so a "more aggressive diggers" knob actually moves
    // the population mean).
    const rng = new RNG(5);
    const N = 1000;
    const c = new Colony(N);
    for (let i = 0; i < N; i++) c.spawn(0, 0, 0, rng, MEANS, 0.3);
    let sumDig = 0, sumStig = 0;
    for (let i = 0; i < N; i++) {
      sumDig += c.digProb[i]!;
      sumStig += c.stigmergy[i]!;
    }
    const meanDig = sumDig / N;
    const meanStig = sumStig / N;
    // The mean*0.2 floor biases the empirical mean upward a little
    // (truncation), so allow a generous 15% tolerance.
    expect(Math.abs(meanDig - MEANS.digProb)).toBeLessThan(MEANS.digProb * 0.15);
    expect(Math.abs(meanStig - MEANS.stigmergy)).toBeLessThan(MEANS.stigmergy * 0.15);
  });

  it('produces a non-degenerate distribution (not all the same value)', () => {
    // If trait sigma was accidentally zeroed or rng.gauss() got stuck,
    // every ant would be a clone — emergent specialisation breaks.
    const rng = new RNG(6);
    const N = 200;
    const c = new Colony(N);
    for (let i = 0; i < N; i++) c.spawn(0, 0, 0, rng, MEANS, 0.3);
    const distinct = new Set<number>();
    for (let i = 0; i < N; i++) distinct.add(c.digProb[i]!);
    expect(distinct.size).toBeGreaterThan(N * 0.5);
  });
});

describe('Colony.setState', () => {
  it('updates state and resets stateTicks to 0', () => {
    // stateTicks is the per-state dwell counter (e.g. REST exits when
    // it crosses params.restDuration). It MUST reset on transition or
    // a freshly-RESTing ant could exit immediately because stateTicks
    // carried over from its previous WANDER lifetime.
    const rng = new RNG(7);
    const c = new Colony(1);
    c.spawn(0, 0, 0, rng, MEANS);
    c.stateTicks[0] = 999;
    c.setState(0, STATE_CARRY);
    expect(c.state[0]).toBe(STATE_CARRY);
    expect(c.stateTicks[0]).toBe(0);
    c.stateTicks[0] = 50;
    c.setState(0, STATE_REST);
    expect(c.state[0]).toBe(STATE_REST);
    expect(c.stateTicks[0]).toBe(0);
  });
});

describe('Colony.spawnInRect', () => {
  it('places ants only in cells where isAir returns true', () => {
    // The isAir filter is the only thing keeping spawn from embedding
    // ants in soil at t=0 (which would violate the no-embedded-ants
    // invariant from CLAUDE.md §7 before the first physics tick).
    const rng = new RNG(8);
    const c = new Colony(50);
    // Air everywhere EXCEPT the right half of the rect.
    const isAir = (x: number, _y: number) => x < 10;
    c.spawnInRect(0, 0, 20, 5, 30, rng, isAir, MEANS);
    for (let i = 0; i < c.count; i++) {
      expect((c.posX[i]! | 0)).toBeLessThan(10);
    }
  });

  it('places ants inside the rect bounds [x0, x1] x [y0, y1]', () => {
    // Renderer/sim assume positions are inside the world. spawnInRect
    // is the public seeding API; rect-respect is its contract.
    const rng = new RNG(9);
    const c = new Colony(50);
    c.spawnInRect(5, 3, 12, 8, 30, rng, () => true, MEANS);
    for (let i = 0; i < c.count; i++) {
      expect(c.posX[i]).toBeGreaterThanOrEqual(5);
      expect(c.posX[i]).toBeLessThanOrEqual(12);
      expect(c.posY[i]).toBeGreaterThanOrEqual(3);
      expect(c.posY[i]).toBeLessThanOrEqual(8);
    }
  });

  it('does not exceed colony capacity even when n > capacity', () => {
    // Belt-and-suspenders against the capacity invariant: spawnInRect
    // calls spawn in a loop, and an off-by-one here would silently
    // overflow the SoA arrays.
    const rng = new RNG(10);
    const c = new Colony(7);
    const placed = c.spawnInRect(0, 0, 20, 20, 50, rng, () => true, MEANS);
    expect(c.count).toBe(7);
    expect(placed).toBeLessThanOrEqual(50);
  });

  it('gives up after a finite number of tries when no air is available', () => {
    // If isAir is always false (e.g. fully soil-packed rect) the loop
    // must terminate. Otherwise the sim setup hangs forever.
    const rng = new RNG(11);
    const c = new Colony(10);
    const placed = c.spawnInRect(0, 0, 5, 5, 5, rng, () => false, MEANS);
    expect(placed).toBe(0);
    expect(c.count).toBe(0);
  });

  it('assigns headings in [0, 2π)', () => {
    // Headings are unbounded radians inside the sim (wrapAngle keeps
    // them sane), but spawn samples specifically from rng.range(0, 2π)
    // so the first frame doesn't have ants pointing in random NaN
    // directions.
    const rng = new RNG(12);
    const c = new Colony(50);
    c.spawnInRect(0, 0, 10, 10, 50, rng, () => true, MEANS);
    for (let i = 0; i < c.count; i++) {
      expect(c.heading[i]).toBeGreaterThanOrEqual(0);
      expect(c.heading[i]).toBeLessThan(Math.PI * 2);
    }
  });
});
