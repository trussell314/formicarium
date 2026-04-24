import { describe, expect, it } from 'vitest';
import { Colony, STATE_CARRY, STATE_WANDER } from '../src/sim/colony';
import { RNG } from '../src/sim/rng';

describe('Colony', () => {
  it('spawn stores position, heading, state and increments count', () => {
    const c = new Colony(4);
    const idx = c.spawn(3.5, 4.5, 0.1);
    expect(idx).toBe(0);
    expect(c.count).toBe(1);
    expect(c.posX[0]).toBe(3.5);
    expect(c.posY[0]).toBe(4.5);
    expect(c.prevX[0]).toBe(3.5);
    expect(c.prevY[0]).toBe(4.5);
    expect(c.heading[0]).toBeCloseTo(0.1, 5);
    expect(c.state[0]).toBe(STATE_WANDER);
  });

  it('spawn returns null when at capacity', () => {
    const c = new Colony(1);
    expect(c.spawn(0, 0, 0)).toBe(0);
    expect(c.spawn(1, 1, 0)).toBeNull();
  });

  it('setState resets the state timer', () => {
    const c = new Colony(2);
    c.spawn(0, 0, 0);
    c.tickTimers();
    c.tickTimers();
    expect(c.stateTimer[0]).toBe(2);
    c.setState(0, STATE_CARRY);
    expect(c.stateTimer[0]).toBe(0);
  });

  it('spawnInRect places ants only at air cells', () => {
    const c = new Colony(10);
    const rng = new RNG(1);
    // "Air" is odd x+y; "solid" otherwise (checkerboard).
    const isAir = (x: number, y: number) => ((x + y) & 1) === 1;
    const n = c.spawnInRect(0, 0, 9, 0, 10, rng, isAir);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < c.count; i++) {
      const ix = c.posX[i]! | 0;
      const iy = c.posY[i]! | 0;
      expect(isAir(ix, iy)).toBe(true);
    }
  });
});
