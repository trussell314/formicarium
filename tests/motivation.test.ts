import { describe, expect, it } from 'vitest';
import { Colony, STATE_CARRY, STATE_DIG, STATE_REST, STATE_WANDER } from '../src/sim/colony';
import { motivationOf } from '../src/motivation';

describe('motivationOf', () => {
  function make(state: 0 | 1 | 2 | 3, target?: { x: number; y: number }): Colony {
    const c = new Colony(2);
    c.spawn(0.5, 0.5, 0);
    c.setState(0, state);
    if (target) c.setTarget(0, target.x, target.y);
    else c.clearTarget(0);
    return c;
  }

  it('labels WANDER ants as exploring', () => {
    const c = make(STATE_WANDER);
    const m = motivationOf(c, 0);
    expect(m.stateLabel).toBe('WANDER');
    expect(m.description.toLowerCase()).toContain('explor');
    expect(m.destinationCm).toBeNull();
  });

  it('DIG includes target coords when set', () => {
    const c = make(STATE_DIG, { x: 40, y: 80 });
    const m = motivationOf(c, 0);
    expect(m.stateLabel).toBe('DIG');
    expect(m.description).toContain('40');
    expect(m.description).toContain('80');
    expect(m.destinationCm).not.toBeNull();
  });

  it('CARRY describes hauling to surface', () => {
    const c = make(STATE_CARRY);
    const m = motivationOf(c, 0);
    expect(m.stateLabel).toBe('CARRY');
    expect(m.description.toLowerCase()).toContain('grain');
  });

  it('REST labels ant as resting', () => {
    const c = make(STATE_REST);
    const m = motivationOf(c, 0);
    expect(m.stateLabel).toBe('REST');
    expect(m.description.toLowerCase()).toContain('rest');
  });

  it('reports stateTicks', () => {
    const c = make(STATE_WANDER);
    c.tickTimers();
    c.tickTimers();
    c.tickTimers();
    const m = motivationOf(c, 0);
    expect(m.stateTicks).toBe(3);
  });
});
