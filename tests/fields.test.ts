import { describe, expect, it } from 'vitest';
import { PheromoneField } from '../src/sim/fields';

describe('PheromoneField', () => {
  it('deposit and sample roundtrip', () => {
    const f = new PheromoneField(10, 10, 0.99, 0.1);
    f.deposit(3, 4, 1.5);
    expect(f.sample(3, 4)).toBeCloseTo(1.5);
    expect(f.sample(0, 0)).toBe(0);
  });

  it('deposit ignores out-of-bounds writes', () => {
    const f = new PheromoneField(5, 5, 0.99, 0.1);
    f.deposit(-1, 0, 1);
    f.deposit(0, -1, 1);
    f.deposit(5, 0, 1);
    f.deposit(0, 5, 1);
    let total = 0;
    for (let i = 0; i < f.values.length; i++) total += f.values[i]!;
    expect(total).toBe(0);
  });

  it('step diffuses and evaporates over many ticks', () => {
    const f = new PheromoneField(20, 20, 0.95, 0.2);
    f.deposit(10, 10, 100);
    const initial = f.sample(10, 10);
    for (let i = 0; i < 50; i++) f.step();
    // Center value should drop due to diffusion + evaporation.
    expect(f.sample(10, 10)).toBeLessThan(initial);
    // Some pheromone should have spread to neighbours.
    expect(f.sample(11, 10)).toBeGreaterThan(0);
    expect(f.sample(10, 11)).toBeGreaterThan(0);
  });

  it('field decays toward zero with no input', () => {
    const f = new PheromoneField(10, 10, 0.9, 0.1);
    f.deposit(5, 5, 10);
    for (let i = 0; i < 500; i++) f.step();
    let total = 0;
    for (let i = 0; i < f.values.length; i++) total += f.values[i]!;
    expect(total).toBeLessThan(0.01);
  });

  it('clear resets all values', () => {
    const f = new PheromoneField(8, 8, 0.99, 0.1);
    f.deposit(4, 4, 5);
    f.clear();
    expect(f.sample(4, 4)).toBe(0);
  });
});
