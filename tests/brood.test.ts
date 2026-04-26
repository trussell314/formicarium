// Tests for the brood / population-replenishment system:
// queen state, periodic egg-laying, egg → worker maturation, and
// the colony-cap / energy gates that govern when laying happens.
//
// Citations underlying the behavioural assertions:
//   Hölldobler & Wilson 1990, Ch. 5 (claustral founding) and Ch. 9
//     (caste / brood progression).
//   Tschinkel 1998: P. barbatus colony growth and queen lifetime.

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_CARRY, STATE_DEAD, STATE_EGG, STATE_QUEEN, STATE_WANDER,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER, type AntSpecies } from '../src/sim/species';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';

function makeWorld(): World {
  const w = new World(40, 40);
  for (let x = 0; x < w.width; x++) {
    w.naturalSurface[x] = 10;
    for (let y = 0; y < w.height; y++) {
      w.cells[w.index(x, y)] = y < 10 ? CELL_AIR : CELL_SOIL;
    }
  }
  // Carve a small chamber for the queen at (20, 20).
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      w.cells[w.index(20 + dx, 20 + dy)] = CELL_AIR;
    }
  }
  w.initialSoilCells = w.countSoil();
  return w;
}

function fields(w: World): { dig: Pheromone; build: Pheromone } {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.9986),
    build: new Pheromone(w.width, w.height, 0.10, 0.99995),
  };
}

function spawnQueen(colony: Colony, rng: RNG): number {
  const i = colony.spawn(20.5, 20.5, 0, rng, DEFAULT_PARAMS);
  if (i < 0) throw new Error('spawn failed');
  colony.state[i] = STATE_QUEEN;
  colony.stateTicks[i] = 0;
  colony.energy[i] = HARVESTER.maxEnergy;
  return i;
}

describe('brood: queen', () => {
  it('queen state is preserved across ticks (no auto-transition)', () => {
    const rng = new RNG(1);
    const w = makeWorld();
    const colony = new Colony(50);
    const qi = spawnQueen(colony, rng);
    const { dig, build } = fields(w);
    // 100 ticks is well under eggLayInterval; queen should stay
    // STATE_QUEEN the entire run.
    for (let t = 0; t < 100; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS);
      expect(colony.state[qi]).toBe(STATE_QUEEN);
    }
  });

  it('queen does not move (its position is stationary)', () => {
    const rng = new RNG(2);
    const w = makeWorld();
    const colony = new Colony(50);
    const qi = spawnQueen(colony, rng);
    const x0 = colony.posX[qi]!;
    const y0 = colony.posY[qi]!;
    const { dig, build } = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS);
    }
    expect(colony.posX[qi]).toBe(x0);
    expect(colony.posY[qi]).toBe(y0);
  });

  it('queen dies (STATE_DEAD) when energy hits zero', () => {
    // Use a species with very high metabolism so energy crashes fast.
    const rng = new RNG(3);
    const w = makeWorld();
    const colony = new Colony(50);
    const qi = spawnQueen(colony, rng);
    const fastDeath: AntSpecies = { ...HARVESTER, metabolism: 0.1 };
    const { dig, build } = fields(w);
    for (let t = 0; t < 50; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fastDeath);
      if (colony.state[qi] === STATE_DEAD) break;
    }
    expect(colony.state[qi]).toBe(STATE_DEAD);
    expect(colony.energy[qi]).toBe(0);
    // Corpse marker placed at queen's cell.
    const ix = colony.posX[qi]! | 0;
    const iy = colony.posY[qi]! | 0;
    expect(w.corpse[iy * w.width + ix]).toBe(1);
  });
});

describe('brood: egg laying', () => {
  it('queen lays an egg roughly every eggLayInterval ticks', () => {
    const rng = new RNG(4);
    const w = makeWorld();
    const colony = new Colony(50);
    spawnQueen(colony, rng);
    // Use a small eggLayInterval to keep the test fast.
    const fastEggs: AntSpecies = {
      ...HARVESTER,
      eggLayInterval: 100,
      eggMatureTicks: 10000, // long enough that no eggs mature during the test
    };
    const { dig, build } = fields(w);
    for (let t = 0; t < 500; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fastEggs);
    }
    // Over 500 ticks at interval 100, expect ~5 eggs laid.
    let eggCount = 0;
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] === STATE_EGG) eggCount++;
    }
    expect(eggCount).toBeGreaterThanOrEqual(4);
    expect(eggCount).toBeLessThanOrEqual(6);
  });

  it('eggs spawn at the queen\'s position', () => {
    const rng = new RNG(5);
    const w = makeWorld();
    const colony = new Colony(50);
    const qi = spawnQueen(colony, rng);
    const fastEggs: AntSpecies = { ...HARVESTER, eggLayInterval: 50, eggMatureTicks: 100000 };
    const { dig, build } = fields(w);
    for (let t = 0; t < 100; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fastEggs);
    }
    let foundEgg = false;
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] !== STATE_EGG) continue;
      foundEgg = true;
      // Egg should be at queen's cell.
      expect(colony.posX[i]).toBe(colony.posX[qi]);
      expect(colony.posY[i]).toBe(colony.posY[qi]);
    }
    expect(foundEgg).toBe(true);
  });

  it('queen does not lay eggs when energy is below threshold', () => {
    const rng = new RNG(6);
    const w = makeWorld();
    const colony = new Colony(50);
    const qi = spawnQueen(colony, rng);
    colony.energy[qi] = 0.1; // below the 0.4 lay threshold
    const fastEggs: AntSpecies = { ...HARVESTER, eggLayInterval: 50, eggMatureTicks: 100000 };
    const { dig, build } = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fastEggs);
      if (colony.state[qi] === STATE_DEAD) break;
    }
    let eggCount = 0;
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] === STATE_EGG) eggCount++;
    }
    expect(eggCount).toBe(0);
  });

  it('queen stops laying once colony hits maxColonySize', () => {
    const rng = new RNG(7);
    const w = makeWorld();
    const colony = new Colony(20); // capacity = 20
    spawnQueen(colony, rng);
    // Eat into capacity so egg-laying can fill the rest.
    const capped: AntSpecies = {
      ...HARVESTER,
      eggLayInterval: 10, // very fast
      eggMatureTicks: 1000000,
      maxColonySize: 10, // cap below capacity
    };
    const { dig, build } = fields(w);
    for (let t = 0; t < 1000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, capped);
    }
    expect(colony.count).toBeLessThanOrEqual(10);
  });
});

describe('brood: egg maturation', () => {
  it('egg becomes a STATE_WANDER worker after eggMatureTicks', () => {
    const rng = new RNG(8);
    const w = makeWorld();
    const colony = new Colony(50);
    spawnQueen(colony, rng);
    const fast: AntSpecies = {
      ...HARVESTER,
      eggLayInterval: 50,
      eggMatureTicks: 100, // mature fast for test
    };
    const { dig, build } = fields(w);
    let laidEggIdx = -1;
    for (let t = 0; t < 80; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
      // Find an egg laid recently.
      for (let i = 0; i < colony.count; i++) {
        if (colony.state[i] === STATE_EGG) {
          if (laidEggIdx < 0) laidEggIdx = i;
        }
      }
      if (laidEggIdx >= 0) break;
    }
    expect(laidEggIdx).toBeGreaterThan(0);
    // Run long enough for that egg to mature.
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
      if (colony.state[laidEggIdx] === STATE_WANDER) break;
    }
    expect(colony.state[laidEggIdx]).toBe(STATE_WANDER);
    expect(colony.energy[laidEggIdx]).toBe(HARVESTER.maxEnergy);
    expect(colony.age[laidEggIdx]).toBe(0); // emerges as a young worker
  });

  it('egg energy doesn\'t drain (no metabolism for brood)', () => {
    const rng = new RNG(9);
    const w = makeWorld();
    const colony = new Colony(50);
    spawnQueen(colony, rng);
    const fast: AntSpecies = {
      ...HARVESTER,
      eggLayInterval: 30,
      eggMatureTicks: 1000000,
      metabolism: 0.001, // would crash an adult fast
    };
    const { dig, build } = fields(w);
    for (let t = 0; t < 100; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
    }
    // Find an egg and confirm its energy is still full.
    for (let i = 0; i < colony.count; i++) {
      if (colony.state[i] !== STATE_EGG) continue;
      // Eggs spawn at maxEnergy (set in spawn()) and don't drain.
      expect(colony.energy[i]).toBe(1.0);
    }
  });
});

describe('brood: replenishment effect on colony', () => {
  it('a queen-only colony grows over time (eggs hatch into workers)', () => {
    const rng = new RNG(10);
    const w = makeWorld();
    const colony = new Colony(50);
    spawnQueen(colony, rng);
    const fast: AntSpecies = {
      ...HARVESTER,
      eggLayInterval: 50,
      eggMatureTicks: 200,
    };
    const { dig, build } = fields(w);
    for (let t = 0; t < 2000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
    }
    // Count adult workers (anything that's not queen, egg, or dead).
    let workers = 0;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i];
      if (s === STATE_QUEEN || s === STATE_EGG || s === STATE_DEAD) continue;
      workers++;
    }
    // From 0 starting workers, several should have emerged from
    // matured eggs.
    expect(workers).toBeGreaterThan(0);
  });
});

describe('brood: cargo-drop on worker death', () => {
  it('a CARRY worker dying drops grain in an adjacent air cell', () => {
    const rng = new RNG(11);
    const w = makeWorld();
    const colony = new Colony(10);
    // Spawn a CARRY worker in the queen chamber. Force energy to zero
    // next tick by bumping metabolism.
    const i = colony.spawn(20.5, 20.5, 0, rng, DEFAULT_PARAMS);
    colony.setState(i, STATE_CARRY);
    colony.carryMoves[i] = 5;
    colony.energy[i] = 1e-7;
    const fastDeath: AntSpecies = { ...HARVESTER, metabolism: 1.0 };
    const grainsBefore = w.countGrains();
    const { dig, build } = fields(w);
    step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fastDeath);
    expect(colony.state[i]).toBe(STATE_DEAD);
    const grainsAfter = w.countGrains();
    // Grain went from carrier into a neighbouring air cell.
    expect(grainsAfter).toBe(grainsBefore + 1);
    // Conservation: carryMoves cleared.
    expect(colony.carryMoves[i]).toBe(0);
  });
});

describe('brood: queen+egg do not interfere with worker invariants', () => {
  it('eggs are skipped in collision/gravity passes (don\'t break embedded-ant invariant)', () => {
    const rng = new RNG(12);
    const w = makeWorld();
    const colony = new Colony(50);
    spawnQueen(colony, rng);
    const fast: AntSpecies = {
      ...HARVESTER,
      eggLayInterval: 30,
      eggMatureTicks: 1000000,
    };
    const { dig, build } = fields(w);
    for (let t = 0; t < 500; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, fast);
      // No egg should be in a soil cell — eggs spawn at queen's cell
      // (which is air); they shouldn't be moved by physics into solid.
      for (let i = 0; i < colony.count; i++) {
        if (colony.state[i] !== STATE_EGG) continue;
        const ix = colony.posX[i]! | 0;
        const iy = colony.posY[i]! | 0;
        const k = w.cells[iy * w.width + ix]!;
        expect(k).toBe(CELL_AIR);
      }
    }
  });
});
