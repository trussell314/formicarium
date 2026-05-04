// Surface-breach detection tests. Real *Pogonomyrmex barbatus*
// mature colonies treat any unsealed surface opening (other than
// the canonical entrance) as an urgent threat. The breach
// detection sweep emits alarm pheromone at every non-entrance
// surface AIR cell with chamber connectivity below — the gradient
// is the steering signal that downstream behaviour (CARRY repair-
// deposit, WANDER recruitment) will follow.
//
// This file pins the detection signal only — no behaviour change
// yet. Behaviour tests follow once recruitment + repair-deposit
// land.

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  larvaMetabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  eggLayInterval: 1e9,
  clumpInterval: 1e9,
};

function makeFields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
    breachAlarm: new Pheromone(w.width, w.height, 0.50, 0.985),
  };
}

// World 40 wide, surface row 10, soil 10..30. Entrance shaft at
// column 20 (= width/2) carved from row 10 down to row 14. Anything
// else on the surface row is intact SOIL by default.
function makeBreachWorld(): World {
  const w = new World(40, 30);
  for (let x = 0; x < w.width; x++) w.naturalSurface[x] = 10;
  for (let y = 10; y < 30; y++) {
    for (let x = 0; x < w.width; x++) {
      const idx = w.index(x, y);
      w.cells[idx] = CELL_SOIL;
      w.grainHardness[idx] = 255;
    }
  }
  // Canonical entrance: shaft at col 20 (= width >> 1), rows 10..14.
  for (let y = 10; y <= 14; y++) w.cells[w.index(20, y)] = CELL_AIR;
  w.initialSoilCells = w.countSoil();
  return w;
}

describe('breach detection', () => {
  it('a non-entrance surface opening with chamber connectivity emits breachAlarm within one sweep', () => {
    const rng = new RNG(101);
    const w = makeBreachWorld();
    // Carve a 1-cell-wide breach 15 columns east of the canonical
    // entrance (at col 35). Row 10 cell becomes AIR, with a chamber
    // cavity at row 11 below it so the connectivity check passes.
    w.cells[w.index(35, 10)] = CELL_AIR;
    w.cells[w.index(35, 11)] = CELL_AIR;
    const colony = new Colony(0);
    const f = makeFields(w);
    // Detection sweep fires every 50 ticks; run 50 ticks so it
    // hits the t%50===0 condition exactly once.
    for (let t = 0; t < 51; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, f.breachAlarm);
    }
    // Alarm should be present at the breach cell.
    expect(f.breachAlarm.sample(35, 10)).toBeGreaterThan(0);
  });

  it('the canonical entrance itself does NOT register as a breach', () => {
    const rng = new RNG(102);
    const w = makeBreachWorld();
    const colony = new Colony(0);
    const f = makeFields(w);
    for (let t = 0; t < 51; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, f.breachAlarm);
    }
    // No alarm at the entrance shaft column.
    expect(f.breachAlarm.sample(20, 10)).toBe(0);
  });

  it('a sky-AIR cell above the surface (no chamber below) is NOT a breach', () => {
    // The chamber-connectivity check protects against surface-row
    // cells that happen to be AIR by world-gen artefact (e.g. an
    // above-surface column that the surface wave dipped through)
    // but have intact SOIL beneath them. Without it, every "high
    // surface" column would falsely register.
    const rng = new RNG(103);
    const w = makeBreachWorld();
    // Carve only the surface row at column 30, NO chamber below.
    w.cells[w.index(30, 10)] = CELL_AIR;
    // Cell (30, 11) stays SOIL.
    const colony = new Colony(0);
    const f = makeFields(w);
    for (let t = 0; t < 51; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, f.breachAlarm);
    }
    // No alarm at this non-breach cell.
    expect(f.breachAlarm.sample(30, 10)).toBe(0);
  });

  it('breaches within the entrance discriminator radius are treated as part of the entrance', () => {
    // Carve a hole 5 cells east of the canonical entrance —
    // within the ENTRANCE_BREACH_RADIUS=10 zone. Should NOT
    // register as a breach (it's part of the entrance's natural
    // widening footprint).
    const rng = new RNG(104);
    const w = makeBreachWorld();
    w.cells[w.index(25, 10)] = CELL_AIR; // 5 columns from entrance
    w.cells[w.index(25, 11)] = CELL_AIR;
    const colony = new Colony(0);
    const f = makeFields(w);
    for (let t = 0; t < 51; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, f.breachAlarm);
    }
    expect(f.breachAlarm.sample(25, 10)).toBe(0);
  });
});
