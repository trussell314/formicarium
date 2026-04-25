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
});
