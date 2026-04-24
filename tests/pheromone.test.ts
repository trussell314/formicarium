import { describe, expect, it } from 'vitest';
import { PheromoneField, createPheromones } from '../src/sim/pheromone';
import { CELL_AIR, CELL_SOIL, World } from '../src/sim/world';
import { Colony, STATE_WANDER } from '../src/sim/colony';
import { stepSimulation } from '../src/sim/ant-rules';
import { RNG } from '../src/sim/rng';

describe('PheromoneField', () => {
  it('deposit and sample agree', () => {
    const f = new PheromoneField(8, 8);
    f.deposit(3, 4, 2.5);
    expect(f.sample(3, 4)).toBeCloseTo(2.5);
    expect(f.sample(0, 0)).toBe(0);
  });

  it('step() diffuses to neighbours and evaporates', () => {
    const f = new PheromoneField(8, 8);
    f.deposit(4, 4, 1.0);
    f.step(0.05, 0.95);
    // Centre loses to 4 neighbours + 5% global decay.
    expect(f.sample(4, 4)).toBeGreaterThan(0.5);
    expect(f.sample(4, 4)).toBeLessThan(1.0);
    expect(f.sample(5, 4)).toBeGreaterThan(0);
    expect(f.sample(3, 4)).toBeGreaterThan(0);
    // Evaporation: total mass should shrink.
    let total = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) total += f.sample(x, y);
    expect(total).toBeLessThan(1.0);
    expect(total).toBeGreaterThan(0.9);
  });

  it('many steps drive the field to near-zero', () => {
    const f = new PheromoneField(8, 8);
    f.deposit(4, 4, 1.0);
    for (let i = 0; i < 500; i++) f.step(0.05, 0.95);
    let total = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) total += f.sample(x, y);
    expect(total).toBeLessThan(0.01);
  });
});

describe('pheromone integration', () => {
  it('dig event deposits into the field', () => {
    const rng = new RNG(1);
    const world = new World(40, 30);
    // Simple world: air band, soil below.
    for (let x = 0; x < 40; x++) {
      world.naturalSurface[x] = 10;
      for (let y = 10; y < 30; y++) world.cells[world.index(x, y)] = CELL_SOIL;
    }
    world.initialSoilCells = 40 * 20;
    const colony = new Colony(4);
    colony.spawn(20.5, 11.5, 0, {
      walkSpeedCellsPerTick: 0.3,
      digProbPerSoilHit: 1, // always dig on contact
      turnNoiseRadPerTick: 0,
    });
    colony.setState(0, STATE_WANDER);
    const pheromones = createPheromones(40, 30);
    // Run a few ticks — ant should hit soil and deposit.
    for (let t = 0; t < 30; t++) stepSimulation(world, colony, rng, 0.8, pheromones);
    // Field should have accumulated some signal somewhere near the
    // start position.
    let maxNear = 0;
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -5; dy <= 5; dy++) {
        maxNear = Math.max(maxNear, pheromones.dig.sample(20 + dx, 11 + dy));
      }
    }
    expect(maxNear).toBeGreaterThan(0);
  });
});

// Silence unused import.
void CELL_AIR;
