import { describe, expect, it } from 'vitest';
import { Colony, STATE_DIG, STATE_WANDER } from '../src/sim/colony';
import { RNG } from '../src/sim/rng';

describe('Colony', () => {
  it('spawns up to capacity', () => {
    const c = new Colony(3);
    expect(c.spawn(1, 1, 0)).toBe(0);
    expect(c.spawn(2, 2, 0)).toBe(1);
    expect(c.spawn(3, 3, 0)).toBe(2);
    expect(c.spawn(4, 4, 0)).toBe(null);
    expect(c.count).toBe(3);
  });

  it('initial state is WANDER', () => {
    const c = new Colony(5);
    c.spawn(0, 0, 0);
    expect(c.state[0]).toBe(STATE_WANDER);
  });

  it('setState resets stateTimer only on actual change', () => {
    const c = new Colony(5);
    c.spawn(0, 0, 0);
    c.stateTimer[0] = 50;
    c.setState(0, STATE_WANDER); // no change
    expect(c.stateTimer[0]).toBe(50);
    c.setState(0, STATE_DIG);
    expect(c.stateTimer[0]).toBe(0);
  });

  it('endOfTickBookkeeping decays collisions and ages', () => {
    const c = new Colony(2);
    c.spawn(0, 0, 0);
    c.collisionCount[0] = 5;
    c.endOfTickBookkeeping();
    expect(c.collisionCount[0]).toBeLessThan(5);
    expect(c.collisionCount[0]).toBeGreaterThanOrEqual(0);
    expect(c.age[0]).toBe(1);
    expect(c.stateTimer[0]).toBe(1);
  });

  it('spawnCluster places ants near the center', () => {
    const c = new Colony(20);
    const r = new RNG(1);
    const added = c.spawnCluster(50, 50, 10, r, 3);
    expect(added).toBe(10);
    for (let i = 0; i < c.count; i++) {
      const dx = c.posX[i]! - 50;
      const dy = c.posY[i]! - 50;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThanOrEqual(3);
    }
  });
});
