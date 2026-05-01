import { describe, expect, it } from 'vitest';
import { RNG } from '../src/sim/rng';

describe('RNG', () => {
  it('is deterministic for a fixed seed', () => {
    const a = new RNG(42);
    const b = new RNG(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different seeds', () => {
    const a = new RNG(1);
    const b = new RNG(2);
    let differs = 0;
    for (let i = 0; i < 100; i++) if (a.next() !== b.next()) differs++;
    expect(differs).toBeGreaterThan(50);
  });

  it('returns values in [0, 1)', () => {
    const r = new RNG(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('events() matches Bernoulli at rate < 1, allows multi-fires above', () => {
    // At rate < 1, events() must consume exactly one draw and yield
    // the same 0/1 as `rng.next() < rate`. This guarantees that the
    // refactor from per-tick Bernoulli to events() is bit-identical
    // at the current default compression.
    const a = new RNG(101);
    const b = new RNG(101);
    let bernSum = 0;
    let evtSum = 0;
    for (let i = 0; i < 10_000; i++) {
      bernSum += a.next() < 0.05 ? 1 : 0;
      evtSum += b.events(0.05);
    }
    expect(bernSum).toBe(evtSum);

    // At rate ≥ 1, events() must always fire at least floor(rate)
    // and average to rate (within sampling noise).
    const r = new RNG(7);
    let total = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) total += r.events(3.4);
    expect(total / N).toBeGreaterThan(3.3);
    expect(total / N).toBeLessThan(3.5);

    // Integer rates fire deterministically (frac == 0 → no Bernoulli draw).
    const r2 = new RNG(5);
    for (let i = 0; i < 100; i++) expect(r2.events(2)).toBe(2);

    // Zero / negative collapse to zero.
    const r3 = new RNG(99);
    expect(r3.events(0)).toBe(0);
    expect(r3.events(-1)).toBe(0);
  });
});
