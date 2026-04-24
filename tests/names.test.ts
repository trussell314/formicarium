import { describe, expect, it } from 'vitest';
import { allNames, antName } from '../src/names';

describe('ant names', () => {
  it('returns a stable name for each id', () => {
    for (let i = 0; i < 50; i++) {
      const a = antName(i);
      const b = antName(i);
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThan(0);
    }
  });

  it('wraps around for ids beyond the list', () => {
    const list = allNames();
    expect(antName(list.length)).toBe(list[0]);
    expect(antName(list.length + 1)).toBe(list[1]);
  });

  it('provides at least 30 distinct names', () => {
    const set = new Set(allNames());
    expect(set.size).toBeGreaterThanOrEqual(30);
  });
});
