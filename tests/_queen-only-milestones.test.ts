// Queen-only founding-colony milestone test. Starts with ONLY the
// founding queen (no seeded workers) and runs until the nest reaches
// 500 below-surface AIR cells. Records the tick count at each
// 100/200/300/400/500-cell milestone so we can see how long claustral
// founding takes to produce a usable workforce + nest.

import { describe, expect, it } from 'vitest';
import { Colony, STATE_QUEEN } from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_AIR, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

describe('queen-only founding milestones', () => {
  it('records ticks at 100/200/300/400/500-cell nest milestones', () => {
    const seed = 7;
    const rng = new RNG(seed);
    const w = 400, h = 250;
    const world = new World(w, h);
    const surfaceRow = Math.floor(h * 0.17);
    const halfW = Math.max(6, Math.floor(w * 0.06));
    const depth = Math.max(4, Math.floor(h * 0.05));
    world.generate(rng, surfaceRow, halfW, depth);
    const colony = new Colony(2000);
    const cx = w >> 1;
    const cy = surfaceRow + depth;
    colony.spawn(cx + 0.5, cy + 0.5, 0, rng, DEFAULT_PARAMS);
    colony.setState(0, STATE_QUEEN);
    colony.energy[0] = 1.0;
    // No seeded workers — pure claustral founding.
    const fields = {
      dig: new Pheromone(w, h, 0.10, 0.999),
      build: new Pheromone(w, h, 0.10, 0.985),
      trail: new Pheromone(w, h, 0.05, 0.992),
      alarm: new Pheromone(w, h, 0.20, 0.95),
      queen: new Pheromone(w, h, 1.00, 0.9995, true),
      brood: new Pheromone(w, h, 0.30, 0.998),
      necro: new Pheromone(w, h, 0.10, 0.99),
      noEntry: new Pheromone(w, h, 0.05, 0.985),
      granary: new Pheromone(w, h, 0.20, 0.998),
      trunk: new Pheromone(w, h, 0.05, 0.9995),
    };
    const particles = new ParticleSystem(2000);
    function countNestCells(): number {
      let n = 0;
      for (let x = 0; x < w; x++) {
        const surf = world.naturalSurface[x]!;
        for (let y = surf; y < h; y++) {
          if (world.cells[y * w + x]! === CELL_AIR) n++;
        }
      }
      return n;
    }
    function aliveWorkers(): number {
      let n = 0;
      for (let i = 0; i < colony.count; i++) {
        const s = colony.state[i];
        // Worker = not DEAD(5), QUEEN(6), EGG(7), LARVA(9), PUPA(10).
        if (s !== 5 && s !== 6 && s !== 7 && s !== 9 && s !== 10) n++;
      }
      return n;
    }
    const log = (m: string): void => { process.stderr.write(`[queen-only] ${m}\n`); };
    const milestones = [100, 200, 300, 400, 500];
    const milestoneTicks: Record<number, number> = {};
    const SNAPSHOT = 50_000;
    const CAP = 5_000_000;
    log(`start init=${countNestCells()}, target milestones=${milestones.join(',')}`);
    const t0 = Date.now();
    let ticks = 0;
    while (ticks < CAP) {
      step(
        world, colony, fields.dig!, fields.build!,
        rng, DEFAULT_PARAMS, particles, HARVESTER,
        fields.trail, fields.alarm, fields.queen,
        fields.brood, fields.necro, fields.noEntry,
        fields.granary, fields.trunk,
      );
      ticks++;
      // Check milestones at every tick (cheap — countNestCells is O(W·H)
      // but only fires on snapshot ticks for logging; for milestone
      // detection we want exact tick counts so we recheck whenever a
      // dig might have happened. Compromise: recheck only at snapshot
      // boundaries and when remaining milestones could be hit. Less
      // exact but good enough for "how long".)
      if (ticks % SNAPSHOT === 0) {
        const cells = countNestCells();
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const aw = aliveWorkers();
        log(`tick=${ticks} cells=${cells} workers=${aw} (${dt}s wall)`);
        for (const m of milestones) {
          if (cells >= m && milestoneTicks[m] === undefined) {
            milestoneTicks[m] = ticks;
            log(`MILESTONE ${m} cells reached at tick ≤ ${ticks}`);
          }
        }
        if (cells >= 500) break;
      }
    }
    log('\n========== summary ==========');
    log(`final cells: ${countNestCells()}`);
    log(`final ticks: ${ticks}`);
    for (const m of milestones) {
      const t = milestoneTicks[m];
      log(`milestone ${m}: ${t === undefined ? 'NOT REACHED' : `tick ≤ ${t}`}`);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
