// Per-ant names. A small deterministic list keyed by ant id — ants in
// a fresh run get stable names, and the UI can refer to them
// individually.

const NAMES: readonly string[] = [
  'Ada', 'Beatrix', 'Cora', 'Daisy', 'Elma',
  'Freya', 'Gilda', 'Hazel', 'Inez', 'Juno',
  'Kiva', 'Luna', 'Mira', 'Nova', 'Opal',
  'Pearl', 'Quinn', 'Rita', 'Stella', 'Tess',
  'Uma', 'Vera', 'Wren', 'Xyla', 'Yara',
  'Zora', 'Ava', 'Bea', 'Clio', 'Dot',
  'Elsie', 'Fae', 'Greta', 'Hera', 'Ivy',
];

export function antName(id: number): string {
  return NAMES[id % NAMES.length]!;
}

export function allNames(): readonly string[] {
  return NAMES;
}
