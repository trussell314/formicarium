import { describe, expect, it } from 'vitest';
import { celestialOf } from '../src/render/renderer';

describe('celestialOf', () => {
  const cycle = { dayDurationTicks: 60, nightDurationTicks: 60 };

  it('starts at sunrise: t=0 is sun-up, daylight=0', () => {
    const c = celestialOf(0, cycle);
    expect(c.sunUp).toBe(true);
    expect(c.daylight).toBeCloseTo(0);
    expect(c.sunPhase).toBeCloseTo(0);
  });

  it('peaks at noon: middle of day', () => {
    const c = celestialOf(30, cycle);
    expect(c.sunUp).toBe(true);
    expect(c.daylight).toBeCloseTo(1);
    expect(c.sunPhase).toBeCloseTo(0.5);
  });

  it('flips to night at exact day boundary', () => {
    const c = celestialOf(60, cycle);
    expect(c.sunUp).toBe(false);
    expect(c.daylight).toBe(0);
    expect(c.moonPhase).toBeCloseTo(0);
  });

  it('night midpoint has moonPhase = 0.5', () => {
    const c = celestialOf(90, cycle);
    expect(c.sunUp).toBe(false);
    expect(c.moonPhase).toBeCloseTo(0.5);
  });

  it('cycles repeat: tick t and tick t+cycle yield same state', () => {
    const cycleLen = cycle.dayDurationTicks + cycle.nightDurationTicks;
    for (const t of [0, 17, 30, 60, 89]) {
      const a = celestialOf(t, cycle);
      const b = celestialOf(t + cycleLen, cycle);
      expect(a.daylight).toBeCloseTo(b.daylight);
      expect(a.sunPhase).toBeCloseTo(b.sunPhase);
      expect(a.moonPhase).toBeCloseTo(b.moonPhase);
      expect(a.sunUp).toBe(b.sunUp);
    }
  });

  it('asymmetric day/night still divides cleanly', () => {
    const asym = { dayDurationTicks: 100, nightDurationTicks: 20 };
    expect(celestialOf(99, asym).sunUp).toBe(true);
    expect(celestialOf(100, asym).sunUp).toBe(false);
    expect(celestialOf(119, asym).sunUp).toBe(false);
    expect(celestialOf(120, asym).sunUp).toBe(true); // wraps
  });
});
