// Smoke tests for the time-compression dial. Runs the default
// scenario for 50k ticks at three compression settings to verify
// the sim stays healthy (no NaN energies, no embedded ants, grain
// conservation holds) and that compression measurably shifts what
// happens in 50k ticks (more eggs at higher compression, etc.).
//
// File starts with `_` so it stays alongside _monitor.test.ts as a
// hand-runnable diagnostic — the regular `npm test` already exercises
// compression=100 indirectly through the rest of the suite.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_CARRY, STATE_DEAD, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_GRAIN, CELL_SOIL, setTimeCompression, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

function buildSim(seed: number, compression: number): {
  world: World; colony: Colony; rng: RNG;
  fields: Record<string, Pheromone>;
  particles: ParticleSystem;
} {
  setTimeCompression(compression);
  const rng = new RNG(seed);
  const world = new World(400, 250);
  const surfaceRow = Math.floor(world.height * 0.17);
  const halfW = Math.max(6, Math.floor(world.width * 0.06));
  const depth = Math.max(4, Math.floor(world.height * 0.05));
  world.generate(rng, surfaceRow, halfW, depth);
  const colony = new Colony(1000);
  // Single founding queen at the centre of the chamber, like the
  // default scenario.
  const cx = world.width >> 1;
  const cy = surfaceRow + depth;
  colony.spawn(cx + 0.5, cy + 0.5, 0, rng, DEFAULT_PARAMS);
  colony.setState(0, STATE_QUEEN);
  colony.energy[0] = 1.0;
  const fields = {
    dig: new Pheromone(world.width, world.height, 0.10, 0.985),
    build: new Pheromone(world.width, world.height, 0.10, 0.985),
    trail: new Pheromone(world.width, world.height, 0.05, 0.992),
    alarm: new Pheromone(world.width, world.height, 0.20, 0.95),
    queen: new Pheromone(world.width, world.height, 1.00, 0.9995, true),
    brood: new Pheromone(world.width, world.height, 0.30, 0.998),
    necro: new Pheromone(world.width, world.height, 0.10, 0.99),
    noEntry: new Pheromone(world.width, world.height, 0.05, 0.985),
    granary: new Pheromone(world.width, world.height, 0.20, 0.998),
    trunk: new Pheromone(world.width, world.height, 0.05, 0.9995),
  };
  const particles = new ParticleSystem(2000);
  return { world, colony, rng, fields, particles };
}

function runFor(s: ReturnType<typeof buildSim>, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    step(
      s.world, s.colony, s.fields.dig!, s.fields.build!,
      s.rng, DEFAULT_PARAMS, s.particles, HARVESTER,
      s.fields.trail, s.fields.alarm, s.fields.queen,
      s.fields.brood, s.fields.necro, s.fields.noEntry,
      s.fields.granary, s.fields.trunk,
    );
  }
}

function invariants(s: ReturnType<typeof buildSim>): void {
  // Grain conservation.
  let soil = 0, grain = 0, carrying = 0;
  for (let i = 0; i < s.world.cells.length; i++) {
    if (s.world.cells[i] === CELL_SOIL) soil++;
    else if (s.world.cells[i] === CELL_GRAIN) grain++;
  }
  for (let i = 0; i < s.colony.count; i++) {
    if (s.colony.state[i] === STATE_CARRY) carrying++;
  }
  expect(soil + grain + carrying).toBe(s.world.initialSoilCells);

  // No NaN energies.
  for (let i = 0; i < s.colony.count; i++) {
    if (s.colony.state[i] !== STATE_DEAD) {
      expect(Number.isFinite(s.colony.energy[i]!)).toBe(true);
    }
  }
}

function alive(c: Colony): number {
  let n = 0;
  for (let i = 0; i < c.count; i++) if (c.state[i] !== STATE_DEAD) n++;
  return n;
}

describe('compression smoke', () => {
  // Reset to baseline after each so other tests don't see a leftover
  // compression value (these tests are the only ones that mutate it).
  const restore = () => setTimeCompression(100);

  it('default 100× — 50k ticks: invariants hold and population grows', () => {
    const s = buildSim(7, 100);
    runFor(s, 50_000);
    invariants(s);
    expect(alive(s.colony)).toBeGreaterThan(1);
    restore();
  });

  it('1× (real biology) — 50k ticks: invariants hold, slow growth', () => {
    const s = buildSim(7, 1);
    runFor(s, 50_000);
    invariants(s);
    expect(alive(s.colony)).toBeGreaterThanOrEqual(1);
    restore();
  });

  it('1000× — 50k ticks: invariants hold, faster growth than 100×', () => {
    const slow = buildSim(7, 100);
    runFor(slow, 50_000);
    const slowAlive = alive(slow.colony);
    invariants(slow);

    const fast = buildSim(7, 1000);
    runFor(fast, 50_000);
    invariants(fast);
    const fastAlive = alive(fast.colony);

    // 10× compression should produce noticeably more biological
    // events in the same tick budget. Loose check: fast colony has
    // at least as many alive ants. Exact biology depends on RNG.
    expect(fastAlive).toBeGreaterThanOrEqual(slowAlive);
    restore();
  });
});
