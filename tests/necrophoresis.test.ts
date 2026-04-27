// Necrophoresis tests. Wilson, Durlach & Roth (1958): ants pick up
// dead nestmates and haul them outside the nest to refuse piles.
// Verify:
//   1. A WANDER ant on/adjacent to a corpse cell rolls necrophoresisProb
//      and transitions to STATE_NECRO_CARRY.
//   2. A NECRO_CARRY ant heads upward and eventually drops the body
//      on a cell above the natural surface.
//   3. The total corpse count remains conserved (clearing the source
//      cell + creating a midden cell == 1 corpse, not 2).

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_NECRO_CARRY, STATE_WANDER,
} from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import { CELL_AIR, World } from '../src/sim/world';

// Test species with very high pickup probability so transitions
// are observable in a single tick rather than statistically over
// thousands. Real HARVESTER value (1e-3) is calibrated for visible
// cleanup over a biological hour.
const FAST_NECRO: AntSpecies = {
  ...HARVESTER,
  necrophoresisProb: 1.0,   // pickup-on-contact for testing
  necroHaulMinTicks: 5,     // can drop almost immediately for testing
};

function flatWorld(w: number, h: number, surf: number): World {
  // Bypass world.generate's wave so test geometry is predictable.
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = surf;
  for (let i = 0; i < world.cells.length; i++) world.cells[i] = 0;
  for (let y = surf; y < h; y++) {
    for (let x = 0; x < w; x++) {
      world.cells[world.index(x, y)] = 1; // SOIL
    }
  }
  // Carve a small chamber at the centre so an ant can stand
  // somewhere with a corpse adjacent.
  const cx = w >> 1;
  for (let y = surf; y < surf + 3; y++) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      world.cells[world.index(x, y)] = CELL_AIR;
    }
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

function fields(w: World) {
  const dig = new Pheromone(w.width, w.height, 0.12, 0.99);
  const build = new Pheromone(w.width, w.height, 0.10, 0.997);
  return { dig, build };
}

const TRAITS = {
  digProb: 0, pickProb: 0, stigmergy: 0.5, turnNoise: 0.05,
  restThreshold: 8.0,
};

describe('necrophoresis', () => {
  it('WANDER ant adjacent to a corpse picks it up and becomes NECRO_CARRY', () => {
    const rng = new RNG(1);
    const w = flatWorld(40, 30, 12);
    const cx = 20;
    // Place a corpse marker at the cell where the ant will stand.
    w.corpse[w.index(cx, 13)] = 1;
    const colony = new Colony(1);
    colony.spawn(cx + 0.5, 13.5, 0, rng, TRAITS);
    const { dig, build } = fields(w);
    step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_NECRO);
    expect(colony.state[0]).toBe(STATE_NECRO_CARRY);
    // Source corpse marker cleared (ant carries the body now).
    expect(w.corpse[w.index(cx, 13)]).toBe(0);
  });

  it('NECRO_CARRY ant drives toward the surface and drops the body above ground', () => {
    const rng = new RNG(2);
    const w = flatWorld(40, 30, 12);
    const cx = 20;
    // Carve a vertical exit shaft so the carrier can actually leave
    // the chamber. flatWorld only carves the chamber; everything
    // above is air (the sky), so the ant just needs to climb through
    // its current chamber and then the air above the surface.
    for (let y = 12; y < 15; y++) {
      w.cells[w.index(cx, y)] = CELL_AIR;
    }
    w.initialSoilCells = w.countSoil();
    const colony = new Colony(1);
    // Spawn the ant already in NECRO_CARRY at the chamber floor.
    colony.spawn(cx + 0.5, 14.5, -Math.PI / 2, rng, TRAITS);
    colony.state[0] = STATE_NECRO_CARRY;
    colony.stateTicks[0] = 0;
    const { dig, build } = fields(w);
    let droppedAt: number | null = null;
    for (let t = 0; t < 1500; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_NECRO);
      if (colony.state[0] === STATE_WANDER) {
        // The drop fired; find the new corpse cell.
        for (let i = 0; i < w.corpse.length; i++) {
          if (w.corpse[i]! > 0) { droppedAt = i; break; }
        }
        break;
      }
    }
    expect(droppedAt).not.toBeNull();
    const dropY = (droppedAt! / w.width) | 0;
    const dropX = droppedAt! - dropY * w.width;
    // Dropped above the natural surface.
    expect(dropY).toBeLessThan(w.naturalSurface[dropX]!);
  });

  it('corpse count is conserved across pickup + drop', () => {
    const rng = new RNG(3);
    const w = flatWorld(40, 30, 12);
    const cx = 20;
    // Carve a column to the surface
    for (let y = 12; y < 15; y++) w.cells[w.index(cx, y)] = CELL_AIR;
    w.corpse[w.index(cx, 14)] = 1;
    w.initialSoilCells = w.countSoil();

    const before = w.corpse.reduce((a, b) => a + b, 0);
    expect(before).toBe(1);

    const colony = new Colony(1);
    colony.spawn(cx + 0.5, 14.5, -Math.PI / 2, rng, TRAITS);
    const { dig, build } = fields(w);
    for (let t = 0; t < 1500; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, FAST_NECRO);
      // The ant's corpse total is the WORLD corpse marker count plus
      // 1 if the ant is currently NECRO_CARRY (carrying a body but
      // no marker on the world). Sum should always equal 1.
      const worldCorpses = w.corpse.reduce((a, b) => a + b, 0);
      const carried = colony.state[0] === STATE_NECRO_CARRY ? 1 : 0;
      expect(worldCorpses + carried).toBe(1);
    }
  });

  it('does nothing when the species has necrophoresisProb = 0', () => {
    const rng = new RNG(4);
    const w = flatWorld(40, 30, 12);
    const cx = 20;
    w.corpse[w.index(cx, 13)] = 1;
    const colony = new Colony(1);
    colony.spawn(cx + 0.5, 13.5, 0, rng, TRAITS);
    const { dig, build } = fields(w);
    const NO_NECRO: AntSpecies = { ...HARVESTER, necrophoresisProb: 0 };
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, NO_NECRO);
    }
    expect(colony.state[0]).toBe(STATE_WANDER);
    // Corpse not hauled — it remains in the same column (gravity may
    // settle it down a row inside the chamber, which is fine; the
    // test is really "necrophoresis didn't pick it up").
    let total = 0;
    let inSameColumn = 0;
    for (let i = 0; i < w.corpse.length; i++) {
      if (w.corpse[i]! > 0) {
        total++;
        const cx2 = i % w.width;
        if (cx2 === cx) inSameColumn++;
      }
    }
    expect(total).toBe(1);
    expect(inSameColumn).toBe(1);
  });
});
