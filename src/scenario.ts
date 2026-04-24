// Scenario DSL.
//
// A scenario is a single typed object that fully specifies a sim run:
// world geometry in centimetres, day/night durations in ticks, and
// the population of ants by type. It's the canonical input for both
// the web UI and the headless runner — same object, same behaviour.
//
// Cells-per-cm is fixed (CELLS_PER_CM = 4 → 0.25 cm cells). All
// scenario fields are in cm or ticks; the builder converts.

import { Colony } from './sim/colony';
import { World } from './sim/world';
import { RNG } from './sim/rng';

export const CELLS_PER_CM = 4;

/** Behaviour and population of one ant caste. */
export interface AntTypeSpec {
  /** Number of ants of this type to spawn. */
  count: number;
  /** Walking speed in cm/sec. Real Formica ≈ 2.4 cm/sec. */
  walkSpeedCmPerSec?: number;
  /** Per-soil-contact dig probability. Sudd 1970 ≈ 0.01-0.05. */
  digProbPerSoilHit?: number;
  /** Heading-noise stddev (radians) per second of sim time. */
  turnNoiseRadPerSec?: number;
  /**
   * Future hooks (no behavioural effect yet, but reserved so callers
   * can already declare them and not break when behaviour lands):
   *   `winged`: bypass gravity (for alates / queens during nuptial
   *             flight).
   *   `tag`: arbitrary label that the renderer or analytics may use.
   */
  winged?: boolean;
  tag?: string;
}

/** A complete scenario. All fields except `name` and `ants` have defaults. */
export interface Scenario {
  name: string;

  /** Wall-clock seconds represented per simulation tick. Default 1. */
  secondsPerTick?: number;
  /** Ticks of "daytime" per cycle. Default 60. */
  dayDurationTicks?: number;
  /** Ticks of "nighttime" per cycle. Default 60. */
  nightDurationTicks?: number;

  /** Total world height in cm. Default 20. */
  worldHeightCm?: number;
  /** Total world width in cm. Default 36 (16:9-ish at 20cm tall). */
  worldWidthCm?: number;
  /** Distance from the top of the world to the natural surface. Default 5. */
  surfaceFromTopCm?: number;

  /** Width of the carved starter chamber in cm. Default 3. */
  starterChamberWidthCm?: number;
  /** Depth of the carved starter chamber in cm. Default 1.5. */
  starterChamberDepthCm?: number;

  /** PRNG seed. Default Date.now()-derived. */
  seed?: number;

  /** Tick interval at which a scenario runner should print debug info. */
  debugIntervalTicks?: number;

  /** Map of caste name → behaviour spec. */
  ants: Record<string, AntTypeSpec>;
}

/** Fully-resolved scenario with all defaults filled in (cm, ticks, etc.). */
export interface ResolvedScenario {
  name: string;
  secondsPerTick: number;
  dayDurationTicks: number;
  nightDurationTicks: number;
  worldWidthCm: number;
  worldHeightCm: number;
  surfaceFromTopCm: number;
  starterChamberWidthCm: number;
  starterChamberDepthCm: number;
  seed: number;
  debugIntervalTicks: number;
  ants: Record<string, Required<Omit<AntTypeSpec, 'tag'>> & { tag?: string }>;

  // Derived fields.
  gridWidth: number;
  gridHeight: number;
  surfaceCellsFromTop: number;
  starterChamberHalfWidthCells: number;
  starterChamberDepthCells: number;
  totalAnts: number;
}

const DEFAULTS = {
  secondsPerTick: 1,
  dayDurationTicks: 60,
  nightDurationTicks: 60,
  worldWidthCm: 36,
  worldHeightCm: 20,
  surfaceFromTopCm: 5,
  starterChamberWidthCm: 3,
  starterChamberDepthCm: 1.5,
  debugIntervalTicks: 10,
};

const ANT_DEFAULTS = {
  walkSpeedCmPerSec: 2.4,
  digProbPerSoilHit: 0.035,
  turnNoiseRadPerSec: 0.45,
  winged: false,
};

/** Fill in defaults; convert cm to cells. Pure function — no side effects. */
export function resolveScenario(s: Scenario): ResolvedScenario {
  const secondsPerTick = s.secondsPerTick ?? DEFAULTS.secondsPerTick;
  const worldWidthCm = s.worldWidthCm ?? DEFAULTS.worldWidthCm;
  const worldHeightCm = s.worldHeightCm ?? DEFAULTS.worldHeightCm;
  const surfaceFromTopCm = s.surfaceFromTopCm ?? DEFAULTS.surfaceFromTopCm;
  const starterChamberWidthCm = s.starterChamberWidthCm ?? DEFAULTS.starterChamberWidthCm;
  const starterChamberDepthCm = s.starterChamberDepthCm ?? DEFAULTS.starterChamberDepthCm;

  const ants: ResolvedScenario['ants'] = {};
  let total = 0;
  for (const [name, spec] of Object.entries(s.ants)) {
    ants[name] = {
      count: spec.count,
      walkSpeedCmPerSec: spec.walkSpeedCmPerSec ?? ANT_DEFAULTS.walkSpeedCmPerSec,
      digProbPerSoilHit: spec.digProbPerSoilHit ?? ANT_DEFAULTS.digProbPerSoilHit,
      turnNoiseRadPerSec: spec.turnNoiseRadPerSec ?? ANT_DEFAULTS.turnNoiseRadPerSec,
      winged: spec.winged ?? ANT_DEFAULTS.winged,
      tag: spec.tag,
    };
    total += spec.count;
  }

  return {
    name: s.name,
    secondsPerTick,
    dayDurationTicks: s.dayDurationTicks ?? DEFAULTS.dayDurationTicks,
    nightDurationTicks: s.nightDurationTicks ?? DEFAULTS.nightDurationTicks,
    worldWidthCm,
    worldHeightCm,
    surfaceFromTopCm,
    starterChamberWidthCm,
    starterChamberDepthCm,
    seed: s.seed ?? ((Date.now() & 0xffffffff) >>> 0),
    debugIntervalTicks: s.debugIntervalTicks ?? DEFAULTS.debugIntervalTicks,
    ants,
    gridWidth: Math.round(worldWidthCm * CELLS_PER_CM),
    gridHeight: Math.round(worldHeightCm * CELLS_PER_CM),
    surfaceCellsFromTop: Math.round(surfaceFromTopCm * CELLS_PER_CM),
    starterChamberHalfWidthCells: Math.max(2, Math.round(starterChamberWidthCm * CELLS_PER_CM * 0.5)),
    starterChamberDepthCells: Math.max(2, Math.round(starterChamberDepthCm * CELLS_PER_CM)),
    totalAnts: total,
  };
}

/** Build a World + Colony populated according to the scenario. */
export function buildFromScenario(s: Scenario): {
  resolved: ResolvedScenario;
  world: World;
  colony: Colony;
  rng: RNG;
  /** Per-ant caste tag, indexed by colony index. */
  antType: string[];
} {
  const resolved = resolveScenario(s);
  const rng = new RNG(resolved.seed);
  const world = new World(resolved.gridWidth, resolved.gridHeight);
  // Override the world's notion of where the surface is so the
  // generator carves at the scenario-specified depth, not the legacy
  // CONFIG.surfaceFraction.
  world.generate(rng, {
    surfaceCellsFromTop: resolved.surfaceCellsFromTop,
    starterChamberHalfWidth: resolved.starterChamberHalfWidthCells,
    starterChamberDepth: resolved.starterChamberDepthCells,
  });

  const colony = new Colony(resolved.totalAnts);
  const cx = Math.floor(world.width / 2);
  const halfW = resolved.starterChamberHalfWidthCells;
  const surfaceY = resolved.surfaceCellsFromTop;
  const antType: string[] = [];
  for (const [name, spec] of Object.entries(resolved.ants)) {
    // Convert cm/sec → cells/tick using the scenario's secondsPerTick.
    const cellsPerTick = spec.walkSpeedCmPerSec * CELLS_PER_CM * resolved.secondsPerTick;
    const noisePerTick = spec.turnNoiseRadPerSec * resolved.secondsPerTick;
    const behaviour = {
      walkSpeedCellsPerTick: cellsPerTick,
      digProbPerSoilHit: spec.digProbPerSoilHit,
      turnNoiseRadPerTick: noisePerTick,
      winged: spec.winged ? 1 : 0,
    };
    const before = colony.count;
    colony.spawnInRect(
      cx - halfW,
      surfaceY + 1,
      cx + halfW,
      surfaceY + resolved.starterChamberDepthCells,
      spec.count,
      rng,
      (x, y) => world.isAir(x, y),
      behaviour,
    );
    for (let i = before; i < colony.count; i++) antType.push(name);
  }

  return { resolved, world, colony, rng, antType };
}
