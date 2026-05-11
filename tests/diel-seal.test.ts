// Diurnal nest entrance sealing. P. barbatus closes the entrance
// with sand grains at sunset and reopens at dawn (MacKay 1981;
// Gordon 1991). Verify the colony-level rule:
//   1. At dusk, with a donor mound grain present, the entrance
//      cell becomes GRAIN.
//   2. At dawn, an existing seal grain is moved back to the mound.
//   3. Total grain count is preserved across the swap.

import { describe, expect, it } from 'vitest';
import { Colony } from '../src/sim/colony';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { type AntSpecies, HARVESTER } from '../src/sim/species';
import {
  CELL_AIR, CELL_GRAIN, CELL_SOIL, DAY_TICKS, World,
} from '../src/sim/world';

const QUIET: AntSpecies = {
  ...HARVESTER,
  forageProb: 0,
  seedsPerTick: 0,
  metabolism: 0,
  necrophoresisProb: 0,
  sproutProb: 0,
  clumpSize: 0,
};

function flatWorldWithEntrance(w = 60, h = 30, surf = 12): World {
  const world = new World(w, h);
  for (let x = 0; x < w; x++) world.naturalSurface[x] = surf;
  for (let y = surf; y < h; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = CELL_SOIL;
  }
  for (let y = 0; y < surf; y++) {
    for (let x = 0; x < w; x++) world.cells[world.index(x, y)] = CELL_AIR;
  }
  // Excavate the founding shaft at width/2 so cells[(width/2, surf)] is AIR.
  const cx = w >> 1;
  for (let y = surf; y < surf + 6; y++) {
    world.cells[world.index(cx, y)] = CELL_AIR;
  }
  world.initialSoilCells = world.countSoil();
  return world;
}

function fields(w: World) {
  return {
    dig: new Pheromone(w.width, w.height, 0.12, 0.99),
    build: new Pheromone(w.width, w.height, 0.10, 0.997),
  };
}

function countGrains(w: World): number {
  let n = 0;
  for (let i = 0; i < w.cells.length; i++) if (w.cells[i] === CELL_GRAIN) n++;
  return n;
}

describe('diel entrance sealing', () => {
  it('seals the entrance at dusk when a donor grain is available', () => {
    const rng = new RNG(101);
    const w = flatWorldWithEntrance();
    const cx = w.width >> 1;
    // Stamp a donor grain on the mound at column cx + 5.
    const donorCol = cx + 5;
    const donorIdx = (12 - 1) * w.width + donorCol;
    w.cells[donorIdx] = CELL_GRAIN;
    w.mound[donorCol] = 1;
    // Set tick to mid-dusk window (phase 0.85).
    w.tick = (DAY_TICKS * 0.85) | 0;
    const entranceIdx = 12 * w.width + cx;
    expect(w.cells[entranceIdx]).toBe(CELL_AIR);
    const before = countGrains(w);
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    let sealed = false;
    for (let t = 0; t < 1000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (w.cells[entranceIdx] === CELL_GRAIN) { sealed = true; break; }
    }
    expect(sealed).toBe(true);
    // Grain conservation: same total count after the swap.
    expect(countGrains(w)).toBe(before);
  });

  it('reopens the entrance at dawn', () => {
    const rng = new RNG(103);
    const w = flatWorldWithEntrance();
    const cx = w.width >> 1;
    // Pre-seal the entrance.
    const entranceIdx = 12 * w.width + cx;
    w.cells[entranceIdx] = CELL_GRAIN;
    // Set tick to mid-dawn window (phase 0.25).
    w.tick = (DAY_TICKS * 0.25) | 0;
    const before = countGrains(w);
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    let opened = false;
    for (let t = 0; t < 1000; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
      if (w.cells[entranceIdx] === CELL_AIR) { opened = true; break; }
    }
    expect(opened).toBe(true);
    expect(countGrains(w)).toBe(before);
  });

  it('does nothing during midday', () => {
    const rng = new RNG(107);
    const w = flatWorldWithEntrance();
    const cx = w.width >> 1;
    // Plenty of donor grains.
    for (let r = 1; r <= 5; r++) {
      const col = cx + r;
      w.cells[(12 - 1) * w.width + col] = CELL_GRAIN;
      w.mound[col] = 1;
    }
    // Phase 0.5 = noon.
    w.tick = DAY_TICKS / 2;
    const entranceIdx = 12 * w.width + cx;
    const colony = new Colony(0);
    const { dig, build } = fields(w);
    for (let t = 0; t < 200; t++) {
      step(w, colony, dig, build, rng, DEFAULT_PARAMS, undefined, QUIET);
    }
    expect(w.cells[entranceIdx]).toBe(CELL_AIR);
  });
});
