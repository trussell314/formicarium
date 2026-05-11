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
import { Colony, STATE_CARRY, STATE_WANDER } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { settleGrain } from '../src/sim/physics';
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

describe('breach repair-deposit', () => {
  it('a CARRY ant at a breach cell deposits her cargo, sealing the breach', () => {
    // Carve a breach 15 columns east of the entrance. Place a
    // single CARRY ant at the breach cell with cargo. Pre-charge
    // the breach alarm above the repair threshold so the deposit
    // gate fires immediately (otherwise the detection sweep would
    // need 50 ticks to seed the alarm).
    const rng = new RNG(201);
    const w = makeBreachWorld();
    w.cells[w.index(35, 10)] = CELL_AIR;
    w.cells[w.index(35, 11)] = CELL_AIR;
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(1);
    colony.spawn(35.5, 10.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0.55, turnNoise: 0, restThreshold: 100,
    });
    colony.state[0] = STATE_CARRY;
    colony.carryMoves[0] = 3;
    const f = makeFields(w);
    // Saturate breach alarm at the breach cell so repair gate fires
    // immediately on the first tick, no waiting on diffusion.
    for (let k = 0; k < 30; k++) f.breachAlarm.deposit(35, 10, 1.0);
    let sealed = false;
    for (let t = 0; t < 100; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, f.breachAlarm);
      // Re-paint alarm so evaporation doesn't drop it below
      // threshold during the test (the actual sim would re-emit
      // from the detection sweep every 50 ticks).
      f.breachAlarm.deposit(35, 10, 1.0);
      // Breach is sealed when the surface cell becomes SOIL again.
      if (w.cells[w.index(35, 10)] === CELL_SOIL) {
        sealed = true;
        break;
      }
    }
    expect(sealed).toBe(true);
    // Ant should have transitioned out of CARRY (deposit succeeded
    // → setState(WANDER)).
    expect(colony.state[0]).not.toBe(STATE_CARRY);
  });

  it('a CARRY ant NOT at a breach cell does NOT trigger the repair-deposit path', () => {
    // Same setup but the ant is far from any breach. The repair
    // path should not fire — the routine deposit logic still
    // applies but the alarm-triggered short-circuit doesn't.
    const rng = new RNG(202);
    const w = makeBreachWorld();
    // No breach carved.
    const colony = new Colony(1);
    // Spawn ant in a chamber far from anything — at the bottom of
    // the canonical shaft (col 20, row 14 = AIR).
    colony.spawn(20.5, 14.5, 0, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0.55, turnNoise: 0, restThreshold: 100,
    });
    colony.state[0] = STATE_CARRY;
    colony.carryMoves[0] = 3;
    const f = makeFields(w);
    // No alarm anywhere.
    let stillSoil = w.countSoil();
    for (let t = 0; t < 50; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, f.breachAlarm);
    }
    // No repair-driven deposits should have happened. Soil count
    // shouldn't have INCREASED via spurious breach-seal placements.
    // (Other deposit paths may still fire — we only assert the
    // breach path itself doesn't spuriously trigger.)
    expect(w.countSoil()).toBeLessThanOrEqual(stillSoil + 1); // tolerance for routine placements
  });
});

describe('breach recruitment (WANDER bias)', () => {
  it('a WANDER ant near a breach biases heading toward the gradient', () => {
    // Spawn a WANDER ant adjacent to a saturated breach. Verify
    // her heading points TOWARD the breach (east), not the
    // entrance (which is west — entrance homing would otherwise
    // dominate). Average cos(heading) over a few ticks: positive
    // average ⇒ pulled east toward the breach; negative would
    // mean entrance-homing won.
    const rng = new RNG(301);
    const w = makeBreachWorld();
    // Carve a breach at col 35; ant spawns 1 cell west.
    w.cells[w.index(35, 10)] = CELL_AIR;
    w.cells[w.index(35, 11)] = CELL_AIR;
    const colony = new Colony(1);
    colony.spawn(34.5, 9.5, Math.PI, rng, {
      digProb: 0, pickProb: 0, stigmergy: 0.55, turnNoise: 0, restThreshold: 100,
    });
    colony.state[0] = STATE_WANDER;
    const f = makeFields(w);
    // Saturate alarm aggressively so the field at the ant's cell
    // (after diffusion) crosses the 0.05 threshold for the bias.
    for (let k = 0; k < 100; k++) f.breachAlarm.deposit(35, 10, 1.0);
    let cosSum = 0;
    let samples = 0;
    for (let t = 0; t < 20; t++) {
      step(w, colony, f.dig, f.build, rng, DEFAULT_PARAMS, undefined, QUIET,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, f.breachAlarm);
      f.breachAlarm.deposit(35, 10, 1.0);
      cosSum += Math.cos(colony.heading[0]!);
      samples++;
    }
    const avgCos = cosSum / samples;
    expect(avgCos).toBeGreaterThan(0);
  });
});

describe('cave-in physics (option-2 partial guard)', () => {
  it('loose grain ABOVE a non-entrance breach DOES cascade through into the chamber', () => {
    // The wouldCrossSurface guard now applies only within
    // ENTRANCE_GUARD_RADIUS=10 of the canonical entrance. A loose
    // grain placed above a breach far from the entrance must
    // cascade through to the chamber (real cave-in physics).
    const rng = new RNG(401);
    const w = makeBreachWorld();
    // Carve a breach at col 35 (15 cols east of entrance, well
    // outside ENTRANCE_GUARD_RADIUS) with a chamber AIR cell at
    // (35, 11) below.
    w.cells[w.index(35, 10)] = CELL_AIR;
    w.cells[w.index(35, 11)] = CELL_AIR;
    // Place a loose grain above the breach at (35, 9).
    w.cells[w.index(35, 9)] = CELL_SOIL;
    w.grainHardness[w.index(35, 9)] = 0;
    settleGrain(w, 35, 9, rng);
    // After settle, the grain should have fallen INTO the chamber.
    // Cell (35, 11) was AIR — now SOIL (grain landed there).
    expect(w.cells[w.index(35, 11)]).toBe(CELL_SOIL);
    // (35, 9) and (35, 10) should be AIR (grain vacated).
    expect(w.cells[w.index(35, 9)]).toBe(CELL_AIR);
  });

  it('loose grain ABOVE the entrance shaft does NOT cascade through (entrance-zone guard)', () => {
    // Inside ENTRANCE_GUARD_RADIUS=10, the surface barrier is
    // preserved — mound material can't cascade into the entrance.
    // This approximates real ants actively maintaining entrance
    // clearance through constant traffic. Verify by checking the
    // shaft cells (rows 11..14 at col 20) stay AIR — those were
    // intentionally carved at world-setup and would only become
    // SOIL if the grain cascaded into them.
    const rng = new RNG(402);
    const w = makeBreachWorld();
    // Place a loose grain above the entrance shaft at (20, 9).
    w.cells[w.index(20, 9)] = CELL_SOIL;
    w.grainHardness[w.index(20, 9)] = 0;
    settleGrain(w, 20, 9, rng);
    // Shaft cells (the carved entrance, rows 11-14) must remain AIR.
    for (let y = 11; y <= 14; y++) {
      expect(w.cells[w.index(20, y)]).toBe(CELL_AIR);
    }
  });
});
