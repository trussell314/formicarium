// Brood-pipeline diagnostic. Runs a queen-only founding colony for
// 200k ticks at the pinned 100× compression baseline, dumps per-state
// counts + key energies every 10k ticks. Goal: identify where the
// pipeline dies (no eggs laid? eggs not hatching? larvae starving?
// pupae stuck?) so we can target the fix.

import { describe, expect, it } from 'vitest';
import {
  Colony, STATE_CARRY, STATE_CARRY_FOOD, STATE_DEAD, STATE_EGG,
  STATE_FORAGE, STATE_LARVA, STATE_NECRO_CARRY, STATE_PUPA,
  STATE_QUEEN, STATE_REST, STATE_WANDER,
} from '../src/sim/colony';
import { Pheromone } from '../src/sim/pheromone';
import { RNG } from '../src/sim/rng';
import { HARVESTER } from '../src/sim/species';
import { DEFAULT_PARAMS, step } from '../src/sim/ant-rules';
import { CELL_AIR, World } from '../src/sim/world';
import { ParticleSystem } from '../src/sim/particles';

describe('brood-pipeline diagnostic', () => {
  it('queen-only — counts by state every 10k ticks', () => {
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

    function countNest(): number {
      let n = 0;
      for (let x = 0; x < w; x++) {
        const surf = world.naturalSurface[x]!;
        for (let y = surf; y < h; y++) {
          if (world.cells[y * w + x]! === CELL_AIR) n++;
        }
      }
      return n;
    }

    function snapshot(tick: number, dt: string): void {
      const counts: Record<string, number> = {
        Q: 0, EGG: 0, LARVA: 0, PUPA: 0, WANDER: 0, FORAGE: 0,
        REST: 0, CARRY: 0, CARRY_FOOD: 0, NECRO: 0, DEAD: 0, OTHER: 0,
      };
      let queenE = -1;
      let larvaESum = 0, larvaCount = 0;
      let pupaESum = 0, pupaCount = 0;
      const totalBorn = world.totalBorn;
      const totalDied = world.totalDied;
      for (let i = 0; i < colony.count; i++) {
        const s = colony.state[i];
        const e = colony.energy[i]!;
        switch (s) {
          case STATE_QUEEN: counts.Q!++; queenE = e; break;
          case STATE_EGG: counts.EGG!++; break;
          case STATE_LARVA: counts.LARVA!++; larvaESum += e; larvaCount++; break;
          case STATE_PUPA: counts.PUPA!++; pupaESum += e; pupaCount++; break;
          case STATE_WANDER: counts.WANDER!++; break;
          case STATE_FORAGE: counts.FORAGE!++; break;
          case STATE_REST: counts.REST!++; break;
          case STATE_CARRY: counts.CARRY!++; break;
          case STATE_CARRY_FOOD: counts.CARRY_FOOD!++; break;
          case STATE_NECRO_CARRY: counts.NECRO!++; break;
          case STATE_DEAD: counts.DEAD!++; break;
          default: counts.OTHER!++;
        }
      }
      const meanLarvaE = larvaCount > 0 ? (larvaESum / larvaCount).toFixed(2) : '—';
      void pupaESum; void pupaCount;
      const cells = countNest();
      const qlTroph = (globalThis as any).__qlTrophCount || 0;
      // Find queen position + first larva position for distance check.
      let qx = -1, qy = -1, lx = -1, ly = -1;
      for (let i = 0; i < colony.count; i++) {
        if (colony.state[i] === STATE_QUEEN) { qx = colony.posX[i]!; qy = colony.posY[i]!; }
        if (colony.state[i] === STATE_LARVA && lx < 0) { lx = colony.posX[i]!; ly = colony.posY[i]!; }
      }
      const dist = (lx >= 0 && qx >= 0)
        ? Math.hypot(lx - qx, ly - qy).toFixed(1)
        : '—';
      process.stderr.write(
        `[diag] t=${String(tick).padStart(7)} ` +
        `cells=${String(cells).padStart(3)} ` +
        `Q=${counts.Q}@(${qx.toFixed(0)},${qy.toFixed(0)}) qE=${queenE >= 0 ? queenE.toFixed(2) : '—'} ` +
        `EGG=${counts.EGG} LRV=${counts.LARVA}@(${lx >= 0 ? lx.toFixed(0) : '?'},${ly >= 0 ? ly.toFixed(0) : '?'}) ` +
        `(eL=${meanLarvaE}) dist=${dist} ` +
        `PUP=${counts.PUPA} ` +
        `DEAD=${counts.DEAD} ` +
        `born=${totalBorn} died=${totalDied} qlT=${qlTroph} ` +
        `(${dt}s)\n`,
      );
    }

    const t0 = Date.now();
    const CAP = 200_000;
    const SNAP = 10_000;
    snapshot(0, '0.0');
    for (let tick = 1; tick <= CAP; tick++) {
      step(
        world, colony, fields.dig!, fields.build!,
        rng, DEFAULT_PARAMS, particles, HARVESTER,
        fields.trail, fields.alarm, fields.queen,
        fields.brood, fields.necro, fields.noEntry,
        fields.granary, fields.trunk,
      );
      if (tick % SNAP === 0) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        snapshot(tick, dt);
      }
    }
    expect(true).toBe(true);
  });
});
