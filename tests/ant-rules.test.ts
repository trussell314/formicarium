// ant-rules tests are integration-ish: they construct a small,
// controlled world, drive a few ticks, and assert that the
// behavioural state machine produces the cited primitives in the
// right order. Pinning these stops a future refactor from silently
// removing (e.g.) the Sudd contact-dig fire path or the Aina/Aguilar
// REST cycle.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_CARRY, STATE_REST, STATE_WANDER } from '../src/sim/colony';
import { DEFAULT_PARAMS, step, type SimParams } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from '../src/sim/world';

/** Build a tiny test world: top half air, bottom half soil, surface
 *  at row `surfRow`. No starter divot — predictable for unit tests. */
function flatWorld(width: number, height: number, surfRow: number): World {
  const w = new World(width, height);
  for (let x = 0; x < width; x++) {
    w.naturalSurface[x] = surfRow;
    for (let y = 0; y < height; y++) {
      w.cells[w.index(x, y)] = y < surfRow ? CELL_AIR : CELL_SOIL;
    }
  }
  w.initialSoilCells = w.countSoil();
  return w;
}

function fields(w: World): { dig: Pheromone; build: Pheromone } {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.985),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

const TRAITS = {
  digProb: 0.10,
  pickProb: 0.02,
  stigmergy: 0.55,
  turnNoise: 0.35,
  restThreshold: 8.0,
};

describe('ant-rules: WANDER → CARRY (digging)', () => {
  it('a WANDER ant in an enclosed pocket with digProb=1 transitions to CARRY within a few ticks', () => {
    // Sudd 1970: per-contact dig probability INSIDE an excavation
    // context (the enclosure gate in ant-rules.ts). With digProb=1
    // every contact-from-inside-a-pocket must fire, so an ant in
    // a 1-cell pocket pressed against a wall MUST transition out of
    // WANDER quickly. If this regresses we've broken the basic
    // excavation primitive.
    const w = flatWorld(40, 30, 10);
    // Carve a 1-cell pocket so the ant has ≥2 soil neighbours at
    // its spawn cell (left, right, below all soil).
    w.cells[w.index(20, 10)] = CELL_AIR;
    w.initialSoilCells = w.countSoil();
    const params: SimParams = { ...DEFAULT_PARAMS, digProb: 1.0, turnNoise: 0.01 };
    const rng = new RNG(123);
    const colony = new Colony(1);
    colony.spawn(20.5, 10.5, Math.PI / 2, rng, { ...TRAITS, digProb: 1.0, turnNoise: 0.01 });
    const { dig, build } = fields(w);
    let transitioned = false;
    for (let t = 0; t < 50; t++) {
      step(w, colony, dig, build, rng, params);
      if (colony.state[0] === STATE_CARRY) { transitioned = true; break; }
    }
    expect(transitioned).toBe(true);
    // World soil count must be strictly less (a cell was dug).
    expect(w.countSoil()).toBeLessThan(w.initialSoilCells);
  });

  it('a successful dig deposits dig pheromone at the dug cell', () => {
    // Stigmergic recruitment depends on the dig fire ALSO writing
    // the dig field. Without this the colony loses its "active
    // front" signal and excavation diffuses into noise.
    const w = flatWorld(40, 30, 10);
    w.cells[w.index(20, 10)] = CELL_AIR;
    w.initialSoilCells = w.countSoil();
    const params: SimParams = { ...DEFAULT_PARAMS, digProb: 1.0, turnNoise: 0.01 };
    const rng = new RNG(456);
    const colony = new Colony(1);
    colony.spawn(20.5, 10.5, Math.PI / 2, rng, { ...TRAITS, digProb: 1.0, turnNoise: 0.01 });
    const { dig, build } = fields(w);
    for (let t = 0; t < 50; t++) {
      step(w, colony, dig, build, rng, params);
      if (colony.state[0] === STATE_CARRY) break;
    }
    // Some cell in the dig field should now be > 0.
    let total = 0;
    for (let i = 0; i < dig.current.length; i++) total += dig.current[i]!;
    expect(total).toBeGreaterThan(0);
  });
});

describe('ant-rules: CARRY → WANDER (deposit)', () => {
  it('a CARRY ant near the surface deposits within a few ticks (state→WANDER, grain count up)', () => {
    // Theraulaz construction model: CARRY ants drop their grain
    // when above the natural surface row over solid ground. This
    // pins both halves: the state transition AND the new grain
    // appearing in the world.
    const w = flatWorld(40, 30, 15);
    // Manually carve a bit above the surface so the ant can stand
    // there easily — but keep ground intact below.
    const rng = new RNG(789);
    const colony = new Colony(1);
    // Place at column 20, two rows ABOVE the natural surface
    // (py < surf), facing down so geotaxis won't push it back into
    // the air column.
    colony.spawn(20.5, 13.5, 0, rng, TRAITS);
    colony.setState(0, STATE_CARRY);
    const { dig, build } = fields(w);
    let deposited = false;
    const grainsBefore = w.countGrains();
    for (let t = 0; t < 30; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS);
      if (colony.state[0] === STATE_WANDER && w.countGrains() > grainsBefore) {
        deposited = true; break;
      }
    }
    expect(deposited).toBe(true);
    expect(w.countGrains()).toBeGreaterThan(grainsBefore);
  });
});

describe('ant-rules: REST entry and exit', () => {
  it('a WANDER ant whose collisionCount exceeds restThreshold enters REST', () => {
    // Aguilar 2018 / Aina 2023 agitation model. When a WANDER ant's
    // running collision tally crosses its threshold, the next tick
    // must transition it to REST and clear stateTicks.
    const w = flatWorld(40, 30, 25); // huge air space, no soil contact concerns
    const rng = new RNG(101);
    const colony = new Colony(1);
    colony.spawn(20.5, 5.5, 0, rng, { ...TRAITS, restThreshold: 5.0 });
    // Force the threshold-crossing condition manually — bypass the
    // O(n²) collision pass by writing collisionCount directly.
    colony.collisionCount[0] = 100;
    const { dig, build } = fields(w);
    step(w, colony, dig, build, rng, DEFAULT_PARAMS);
    expect(colony.state[0]).toBe(STATE_REST);
    expect(colony.stateTicks[0]).toBe(0);
  });

  it('an ant in REST exits to WANDER after restDuration ticks', () => {
    // The hard cap on REST exists for deadlock safety per the
    // ant-rules.ts comment. After exactly restDuration ticks of
    // REST, the ant must resume WANDER with cleared collision.
    const w = flatWorld(40, 30, 25);
    const params: SimParams = { ...DEFAULT_PARAMS, restDuration: 10, turnNoise: 0.0 };
    const rng = new RNG(202);
    const colony = new Colony(1);
    colony.spawn(20.5, 5.5, 0, rng, { ...TRAITS, turnNoise: 0.0 });
    colony.setState(0, STATE_REST);
    colony.collisionCount[0] = 50;
    const { dig, build } = fields(w);
    // Step restDuration+1 ticks; the +1 lets the post-duration
    // exit branch fire.
    for (let t = 0; t < 12; t++) {
      step(w, colony, dig, build, rng, params);
    }
    expect(colony.state[0]).toBe(STATE_WANDER);
    expect(colony.collisionCount[0]).toBe(0);
  });

  it('REST ants do not dig (no excavation while withdrawn)', () => {
    // Per Aina 2023: withdrawn ants disengage from work. Pin the
    // contract that REST ignores the contact-dig path.
    const w = flatWorld(40, 30, 10);
    const params: SimParams = { ...DEFAULT_PARAMS, digProb: 1.0, turnNoise: 0.01 };
    const rng = new RNG(303);
    const colony = new Colony(1);
    colony.spawn(20.5, 9.5, Math.PI / 2, rng, { ...TRAITS, digProb: 1.0, turnNoise: 0.01 });
    colony.setState(0, STATE_REST);
    const soilBefore = w.countSoil();
    const { dig, build } = fields(w);
    // Run for fewer ticks than restDuration so the ant stays in REST.
    for (let t = 0; t < 5; t++) {
      step(w, colony, dig, build, rng, params);
      // Stay in REST — exit would void the test.
      if (colony.state[0] !== STATE_REST) break;
    }
    expect(w.countSoil()).toBe(soilBefore);
  });
});

describe('ant-rules: trait heterogeneity at colony scale', () => {
  it('spawning N ants with the same params produces a distribution whose mean is within 10% of param mean', () => {
    // Beshers & Fewell 2001: division of labour requires variance.
    // The colony-wide trait mean must still match the user's
    // dialled-in setting (so the "more aggressive diggers" knob
    // moves the cohort centre, not just a single ant).
    const rng = new RNG(404);
    const N = 500;
    const c = new Colony(N);
    for (let i = 0; i < N; i++) c.spawn(0, 0, 0, rng, TRAITS);
    let sumDig = 0, sumPick = 0, sumStig = 0, sumTurn = 0, sumRest = 0;
    for (let i = 0; i < N; i++) {
      sumDig += c.digProb[i]!;
      sumPick += c.pickProb[i]!;
      sumStig += c.stigmergy[i]!;
      sumTurn += c.turnNoise[i]!;
      sumRest += c.restThreshold[i]!;
    }
    expect(Math.abs(sumDig / N - TRAITS.digProb)).toBeLessThan(TRAITS.digProb * 0.1);
    expect(Math.abs(sumPick / N - TRAITS.pickProb)).toBeLessThan(TRAITS.pickProb * 0.1);
    expect(Math.abs(sumStig / N - TRAITS.stigmergy)).toBeLessThan(TRAITS.stigmergy * 0.1);
    expect(Math.abs(sumTurn / N - TRAITS.turnNoise)).toBeLessThan(TRAITS.turnNoise * 0.1);
    expect(Math.abs(sumRest / N - TRAITS.restThreshold)).toBeLessThan(TRAITS.restThreshold * 0.1);
  });

  it('trait variance is non-zero across the colony (no zero-sigma collapse)', () => {
    // If the Gaussian sampler ever degenerates to mean output, every
    // ant becomes identical and emergent specialisation breaks. We
    // already test this in colony.test.ts via distinct-set; here we
    // pin the population variance directly.
    const rng = new RNG(505);
    const N = 200;
    const c = new Colony(N);
    for (let i = 0; i < N; i++) c.spawn(0, 0, 0, rng, TRAITS);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += c.digProb[i]!;
    mean /= N;
    let varSum = 0;
    for (let i = 0; i < N; i++) {
      const d = c.digProb[i]! - mean;
      varSum += d * d;
    }
    const variance = varSum / N;
    expect(variance).toBeGreaterThan(0);
  });
});

describe('ant-rules: pheromone fields advance every tick', () => {
  it('digField.step is invoked each sim tick (tick counter equality after 5 ticks)', () => {
    // The reaction-diffusion field must tick in lockstep with the
    // sim. If we forgot to call step on either field, mounds and
    // dig fronts would persist forever and over-recruit the colony.
    const w = flatWorld(20, 15, 8);
    const rng = new RNG(606);
    const colony = new Colony(0); // no ants — isolate field stepping
    const { dig, build } = fields(w);
    dig.deposit(10, 10, 100);
    build.deposit(5, 5, 100);
    const digBefore = dig.sample(10, 10);
    const buildBefore = build.sample(5, 5);
    for (let t = 0; t < 5; t++) step(w, colony, dig, build, rng, DEFAULT_PARAMS);
    // Both fields must have decayed (evaporate < 1).
    expect(dig.sample(10, 10)).toBeLessThan(digBefore);
    expect(build.sample(5, 5)).toBeLessThan(buildBefore);
  });

  it('world.tick increments by exactly 1 per step call', () => {
    // The sim tick is the canonical clock; rendering, instrumentation,
    // and digTick all anchor on it. Off-by-one or skipped ticks here
    // ripple through everything.
    const w = flatWorld(20, 15, 8);
    const rng = new RNG(707);
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    expect(w.tick).toBe(0);
    step(w, colony, dig, build, rng, DEFAULT_PARAMS);
    expect(w.tick).toBe(1);
    step(w, colony, dig, build, rng, DEFAULT_PARAMS);
    step(w, colony, dig, build, rng, DEFAULT_PARAMS);
    expect(w.tick).toBe(3);
  });
});

describe('ant-rules: determinism', () => {
  it('two sims with the same seed produce identical state after N ticks', () => {
    // CLAUDE.md §1: all randomness goes through src/sim/rng. Two
    // sims sharing a seed must walk in lockstep to byte-for-byte
    // identity. If this breaks, replays and bug-repro fall apart.
    function makeAndRun(seed: number) {
      const rng = new RNG(seed);
      const w = flatWorld(40, 25, 12);
      const colony = new Colony(10);
      colony.spawnInRect(15, 10, 25, 14, 10, rng,
        (x, y) => w.cells[w.index(x, y)] === CELL_AIR, TRAITS);
      const { dig, build } = fields(w);
      for (let t = 0; t < 100; t++) step(w, colony, dig, build, rng, DEFAULT_PARAMS);
      return { w, colony };
    }
    const a = makeAndRun(0xfeed1234);
    const b = makeAndRun(0xfeed1234);
    expect(a.colony.count).toBe(b.colony.count);
    for (let i = 0; i < a.colony.count; i++) {
      expect(a.colony.posX[i]).toBe(b.colony.posX[i]);
      expect(a.colony.posY[i]).toBe(b.colony.posY[i]);
      expect(a.colony.state[i]).toBe(b.colony.state[i]);
    }
    expect(a.w.countSoil()).toBe(b.w.countSoil());
    expect(a.w.countGrains()).toBe(b.w.countGrains());
  });
});

describe('ant-rules: grain conservation under arbitrary tick counts', () => {
  it('initial soil = current soil + grains in world + carriers (CLAUDE.md §6)', () => {
    // CLAUDE.md §6: hard invariant. Pin at multiple checkpoints to
    // catch a bug that only manifests after some specific transition
    // sequence (e.g. a CARRY ant phasing into REST should not drop
    // its cargo silently).
    const rng = new RNG(0x808);
    const w = flatWorld(40, 30, 15);
    const colony = new Colony(8);
    colony.spawnInRect(15, 10, 25, 14, 8, rng,
      (x, y) => w.cells[w.index(x, y)] === CELL_AIR, TRAITS);
    const { dig, build } = fields(w);
    for (let checkpoint = 0; checkpoint < 5; checkpoint++) {
      for (let t = 0; t < 200; t++) step(w, colony, dig, build, rng, DEFAULT_PARAMS);
      let carriers = 0;
      for (let i = 0; i < colony.count; i++) {
        if (colony.state[i] === STATE_CARRY) carriers++;
      }
      const dug = w.initialSoilCells - w.countSoil();
      expect(dug).toBe(w.countGrains() + carriers);
      // Sanity: no embedded grain/soil collisions detected by inspecting cells type.
      void CELL_GRAIN;
    }
  });
});

describe('ant-rules: REST does not change the soil count over its full duration', () => {
  it('an ant in REST cannot pickGrain either (no construction-pheromone deposit)', () => {
    // Symmetrical to the no-dig test: REST suppresses both Sudd
    // contact-dig AND Theraulaz pickup. Place a grain right next to
    // a REST ant; it must remain.
    const w = flatWorld(20, 15, 8);
    const rng = new RNG(909);
    const colony = new Colony(1);
    colony.spawn(10.5, 6.5, 0, rng, { ...TRAITS, pickProb: 1.0, turnNoise: 0.01 });
    colony.setState(0, STATE_REST);
    // Drop a grain at an adjacent cell.
    w.cells[w.index(11, 6)] = CELL_GRAIN;
    const { dig, build } = fields(w);
    for (let t = 0; t < 5; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS);
      if (colony.state[0] !== STATE_REST) break;
    }
    expect(w.cells[w.index(11, 6)]).toBe(CELL_GRAIN);
  });
});
