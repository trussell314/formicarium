import { describe, expect, it } from 'vitest';
import { RNG } from '../src/sim/rng';

describe('RNG', () => {
  it('is deterministic given a seed', () => {
    const a = new RNG(12345);
    const b = new RNG(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different streams for different seeds', () => {
    const a = new RNG(1);
    const b = new RNG(2);
    let identical = 0;
    for (let i = 0; i < 100; i++) {
      if (a.next() === b.next()) identical++;
    }
    expect(identical).toBeLessThan(5);
  });

  it('range is within bounds', () => {
    const r = new RNG(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.range(2.5, 5.5);
      expect(v).toBeGreaterThanOrEqual(2.5);
      expect(v).toBeLessThan(5.5);
    }
  });

  it('int is within bounds', () => {
    const r = new RNG(42);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(0, 10);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });

  it('reseed restarts the stream', () => {
    const r = new RNG(99);
    const first = [r.next(), r.next(), r.next()];
    r.reseed(99);
    expect(r.next()).toBe(first[0]);
    expect(r.next()).toBe(first[1]);
    expect(r.next()).toBe(first[2]);
  });
});
