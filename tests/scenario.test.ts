import { describe, expect, it } from 'vitest';
import {
  CELLS_PER_CM,
  buildFromScenario,
  resolveScenario,
  type Scenario,
} from '../src/scenario';
import { DEFAULT_SCENARIO } from '../src/scenarios/default';

describe('scenario DSL', () => {
  it('resolveScenario fills in all defaults', () => {
    const minimal: Scenario = { name: 'min', ants: { worker: { count: 5 } } };
    const r = resolveScenario(minimal);
    expect(r.secondsPerTick).toBeCloseTo(0.1);
    expect(r.dayDurationSec).toBe(60);
    expect(r.nightDurationSec).toBe(60);
    expect(r.worldHeightCm).toBe(20);
    expect(r.surfaceFromTopCm).toBe(5);
    expect(r.totalAnts).toBe(5);
    expect(r.ants.worker!.walkSpeedCmPerSec).toBeCloseTo(2.4);
    expect(r.ants.worker!.digProbPerSoilHit).toBeCloseTo(0.12);
    expect(r.ants.worker!.bodyLengthCm).toBeCloseTo(0.6);
  });

  it('day/night seconds convert to ticks via secondsPerTick', () => {
    const r = resolveScenario({
      name: 't',
      secondsPerTick: 0.1,
      dayDurationSec: 30,
      nightDurationSec: 15,
      ants: { worker: { count: 1 } },
    });
    expect(r.dayDurationTicks).toBe(300); // 30 / 0.1
    expect(r.nightDurationTicks).toBe(150); // 15 / 0.1
  });

  it('cm dimensions convert to cells via CELLS_PER_CM = 20', () => {
    expect(CELLS_PER_CM).toBe(20);
    const r = resolveScenario({
      name: 't',
      worldWidthCm: 10,
      worldHeightCm: 8,
      surfaceFromTopCm: 2,
      ants: { x: { count: 1 } },
    });
    expect(r.gridWidth).toBe(200);
    expect(r.gridHeight).toBe(160);
    expect(r.surfaceCellsFromTop).toBe(40);
  });

  it('totalAnts sums all ant types', () => {
    const r = resolveScenario({
      name: 'multi',
      ants: {
        worker: { count: 8 },
        scout: { count: 3 },
        queen: { count: 1 },
      },
    });
    expect(r.totalAnts).toBe(12);
  });

  it('user-supplied values override defaults', () => {
    const r = resolveScenario({
      name: 'custom',
      secondsPerTick: 0.5,
      dayDurationSec: 100,
      nightDurationSec: 30,
      worldHeightCm: 50,
      surfaceFromTopCm: 12,
      starterChamberWidthCm: 5,
      starterChamberDepthCm: 2,
      ants: { worker: { count: 2, walkSpeedCmPerSec: 5, bodyLengthCm: 1.2 } },
    });
    expect(r.secondsPerTick).toBe(0.5);
    expect(r.dayDurationSec).toBe(100);
    expect(r.nightDurationSec).toBe(30);
    expect(r.worldHeightCm).toBe(50);
    expect(r.surfaceFromTopCm).toBe(12);
    expect(r.starterChamberWidthCm).toBe(5);
    expect(r.starterChamberDepthCm).toBe(2);
    expect(r.ants.worker!.walkSpeedCmPerSec).toBe(5);
    expect(r.ants.worker!.bodyLengthCm).toBeCloseTo(1.2);
  });

  it('buildFromScenario produces a valid world + colony', () => {
    const { world, colony, resolved } = buildFromScenario(DEFAULT_SCENARIO);
    expect(world.width).toBe(resolved.gridWidth);
    expect(world.height).toBe(resolved.gridHeight);
    expect(colony.count).toBe(10);
    for (let i = 0; i < colony.count; i++) {
      expect(colony.id[i]).toBe(i);
    }
    for (let i = 0; i < colony.count; i++) {
      const ix = colony.posX[i]! | 0;
      const iy = colony.posY[i]! | 0;
      expect(world.isAir(ix, iy)).toBe(true);
    }
  });

  it('per-ant behaviour respects scenario walkSpeedCmPerSec ↦ cells/tick', () => {
    const { colony, resolved } = buildFromScenario({
      name: 'speed-test',
      secondsPerTick: 0.1,
      ants: { worker: { count: 3, walkSpeedCmPerSec: 2.0, variation: 0 } },
    });
    // 2 cm/sec * 20 cells/cm * 0.1 sec/tick = 4 cells/tick.
    for (let i = 0; i < colony.count; i++) {
      expect(colony.walkSpeedCellsPerTick[i]).toBeCloseTo(2.0 * CELLS_PER_CM * resolved.secondsPerTick);
    }
  });

  it('per-ant bodyLengthCells scales with CELLS_PER_CM', () => {
    const { colony } = buildFromScenario({
      name: 'body-test',
      ants: { worker: { count: 1, bodyLengthCm: 0.5, variation: 0 } },
    });
    // 0.5 cm * 20 cells/cm = 10 cells.
    expect(colony.bodyLengthCells[0]).toBeCloseTo(0.5 * CELLS_PER_CM);
  });

  it('variation > 0 produces heterogeneous ants within a single caste', () => {
    const { colony } = buildFromScenario({
      name: 'het',
      seed: 42,
      ants: { worker: { count: 20, variation: 0.3 } },
    });
    const speeds = new Set<number>();
    for (let i = 0; i < colony.count; i++) speeds.add(colony.walkSpeedCellsPerTick[i]!);
    // With variation on, essentially every ant should have a
    // distinct walk speed.
    expect(speeds.size).toBeGreaterThanOrEqual(15);
  });

  it('multiple ant types each get their tag and behaviour', () => {
    const { colony, antType } = buildFromScenario({
      name: 'mixed',
      ants: {
        worker: { count: 3, walkSpeedCmPerSec: 1 },
        scout:  { count: 2, walkSpeedCmPerSec: 4 },
      },
    });
    expect(colony.count).toBe(5);
    const workerSpeeds: number[] = [];
    const scoutSpeeds: number[] = [];
    for (let i = 0; i < colony.count; i++) {
      if (antType[i] === 'worker') workerSpeeds.push(colony.walkSpeedCellsPerTick[i]!);
      if (antType[i] === 'scout')  scoutSpeeds.push(colony.walkSpeedCellsPerTick[i]!);
    }
    expect(workerSpeeds.length).toBe(3);
    expect(scoutSpeeds.length).toBe(2);
    expect(workerSpeeds[0]).toBeLessThan(scoutSpeeds[0]!);
  });
});
