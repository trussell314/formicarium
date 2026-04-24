// Scenario DSL.
//
// A scenario is a single typed object that fully specifies a sim run:
// world geometry in centimetres, day/night durations in **seconds**,
// and the population of ants by type. It's the canonical input for
// both the web UI and the headless runner — same object, same
// behaviour.
//
// Cells-per-cm is fixed (CELLS_PER_CM = 20 → 0.5 mm cells). All
// scenario fields are in cm, sec, or counts; the resolver converts
// into cells and ticks.

import { Colony } from './sim/colony';
import { World } from './sim/world';
import { RNG } from './sim/rng';

export const CELLS_PER_CM = 20;

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
   * Physical body length in cm (nose to gaster tip). Default 0.6 cm,
   * a Formica-worker-ish size. The renderer scales ant anatomy by
   * this so ants stay the same *physical* size even when the grid
   * resolution changes.
   */
  bodyLengthCm?: number;
  /**
   * Per-ant variation. At spawn each behaviour parameter is jittered
   * by (1 + gauss() × variation). Models heterogeneity within a
   * caste — real workers have individually-varying thresholds and
   * speeds. Default 0.15 (= 15% stddev).
   */
  variation?: number;
  /**
   * Reserved — no behaviour yet: alates/queens during nuptial flight
   * bypass gravity.
   */
  winged?: boolean;
  tag?: string;
}

/** A complete scenario. All fields except `name` and `ants` have defaults. */
export interface Scenario {
  name: string;

  /** Wall-clock seconds represented per simulation tick. Default 0.1 (10 Hz). */
  secondsPerTick?: number;
  /** Seconds of daytime per cycle. Default 60. */
  dayDurationSec?: number;
  /** Seconds of nighttime per cycle. Default 60. */
  nightDurationSec?: number;

  /** Total world height in cm. Default 20. */
  worldHeightCm?: number;
  /** Total world width in cm. Default 36 (16:9 at 20 cm tall). */
  worldWidthCm?: number;
  /** Distance from the top of the world to the natural surface. Default 5. */
  surfaceFromTopCm?: number;

  /** Width of the carved starter chamber in cm. Default 4. */
  starterChamberWidthCm?: number;
  /** Depth of the carved starter chamber in cm. Default 2. */
  starterChamberDepthCm?: number;

  /** PRNG seed. Default Date.now()-derived. */
  seed?: number;

  /** Tick interval at which a scenario runner should print debug info. */
  debugIntervalTicks?: number;

  /** Map of caste name → behaviour spec. */
  ants: Record<string, AntTypeSpec>;
}

/** Fully-resolved scenario with all defaults filled in (cm, sec, ticks). */
export interface ResolvedScenario {
  name: string;
  secondsPerTick: number;
  dayDurationSec: number;
  nightDurationSec: number;
  /** Derived: dayDurationSec / secondsPerTick, rounded. */
  dayDurationTicks: number;
  /** Derived: nightDurationSec / secondsPerTick, rounded. */
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
  cellsPerCm: number;
}

const DEFAULTS = {
  secondsPerTick: 0.1,
  dayDurationSec: 60,
  nightDurationSec: 60,
  worldWidthCm: 36,
  worldHeightCm: 20,
  surfaceFromTopCm: 5,
  starterChamberWidthCm: 4,
  starterChamberDepthCm: 2,
  debugIntervalTicks: 50,
};

const ANT_DEFAULTS = {
  walkSpeedCmPerSec: 2.4,
  digProbPerSoilHit: 0.035,
  turnNoiseRadPerSec: 1.2,
  bodyLengthCm: 0.6,
  variation: 0.15,
  winged: false,
};

/** Fill in defaults; convert cm to cells, sec to ticks. Pure function. */
export function resolveScenario(s: Scenario): ResolvedScenario {
  const secondsPerTick = s.secondsPerTick ?? DEFAULTS.secondsPerTick;
  const worldWidthCm = s.worldWidthCm ?? DEFAULTS.worldWidthCm;
  const worldHeightCm = s.worldHeightCm ?? DEFAULTS.worldHeightCm;
  const surfaceFromTopCm = s.surfaceFromTopCm ?? DEFAULTS.surfaceFromTopCm;
  const starterChamberWidthCm = s.starterChamberWidthCm ?? DEFAULTS.starterChamberWidthCm;
  const starterChamberDepthCm = s.starterChamberDepthCm ?? DEFAULTS.starterChamberDepthCm;
  const dayDurationSec = s.dayDurationSec ?? DEFAULTS.dayDurationSec;
  const nightDurationSec = s.nightDurationSec ?? DEFAULTS.nightDurationSec;

  const ants: ResolvedScenario['ants'] = {};
  let total = 0;
  for (const [name, spec] of Object.entries(s.ants)) {
    ants[name] = {
      count: spec.count,
      walkSpeedCmPerSec: spec.walkSpeedCmPerSec ?? ANT_DEFAULTS.walkSpeedCmPerSec,
      digProbPerSoilHit: spec.digProbPerSoilHit ?? ANT_DEFAULTS.digProbPerSoilHit,
      turnNoiseRadPerSec: spec.turnNoiseRadPerSec ?? ANT_DEFAULTS.turnNoiseRadPerSec,
      bodyLengthCm: spec.bodyLengthCm ?? ANT_DEFAULTS.bodyLengthCm,
      variation: spec.variation ?? ANT_DEFAULTS.variation,
      winged: spec.winged ?? ANT_DEFAULTS.winged,
      tag: spec.tag,
    };
    total += spec.count;
  }

  return {
    name: s.name,
    secondsPerTick,
    dayDurationSec,
    nightDurationSec,
    dayDurationTicks: Math.max(1, Math.round(dayDurationSec / secondsPerTick)),
    nightDurationTicks: Math.max(1, Math.round(nightDurationSec / secondsPerTick)),
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
    cellsPerCm: CELLS_PER_CM,
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
  // Per-ant variation: each parameter gets an independent gaussian
  // jitter factor clamped below by 0.3× to avoid zero or negative
  // values. Spawned one at a time so each ant gets its own roll.
  const jitter = (base: number, stddev: number): number =>
    base * Math.max(0.3, 1 + rng.gauss() * stddev);
  for (const [name, spec] of Object.entries(resolved.ants)) {
    const baseCellsPerTick = spec.walkSpeedCmPerSec * CELLS_PER_CM * resolved.secondsPerTick;
    const baseNoisePerTick = spec.turnNoiseRadPerSec * resolved.secondsPerTick;
    const baseBodyLen = spec.bodyLengthCm * CELLS_PER_CM;
    for (let k = 0; k < spec.count; k++) {
      const behaviour = {
        walkSpeedCellsPerTick: jitter(baseCellsPerTick, spec.variation),
        digProbPerSoilHit: jitter(spec.digProbPerSoilHit, spec.variation),
        turnNoiseRadPerTick: jitter(baseNoisePerTick, spec.variation),
        winged: spec.winged ? 1 : 0,
        // Body-length variation is halved so ants don't end up
        // visually wildly different sizes.
        bodyLengthCells: jitter(baseBodyLen, spec.variation * 0.5),
      };
      const before = colony.count;
      colony.spawnInRect(
        cx - halfW,
        surfaceY + 1,
        cx + halfW,
        surfaceY + resolved.starterChamberDepthCells,
        1,
        rng,
        (x, y) => world.isAir(x, y),
        behaviour,
      );
      if (colony.count > before) antType.push(name);
    }
  }

  return { resolved, world, colony, rng, antType };
}
