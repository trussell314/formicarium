// Default scenario — what the web UI renders.
//
// Plain-data object. Anyone reading this file can see the entire
// initial-conditions contract for the live demo: world size, day/
// night durations, how many ants of which caste. To tweak the live
// experience, edit this file (no code changes elsewhere needed).

import type { Scenario } from '../scenario';

export const DEFAULT_SCENARIO: Scenario = {
  name: 'default-web',

  // Real-time pacing: 1 tick = 1 second; day = 60 ticks = 1 minute,
  // and so does night, for a 2-minute cycle.
  secondsPerTick: 1,
  dayDurationTicks: 60,
  nightDurationTicks: 60,

  // 36 cm wide × 20 cm tall; surface 5 cm down. At 4 cells/cm:
  //   144 × 80 grid, surface at row 20.
  worldWidthCm: 36,
  worldHeightCm: 20,
  surfaceFromTopCm: 5,

  // Starter chamber: 6 cm wide × 3 cm deep (24 × 12 cells). Sized so
  // 10 ants spread across roughly half the chamber rather than
  // bunching into a 2.5×0.75 cm pocket (which the headless runner
  // surfaced on the previous default).
  starterChamberWidthCm: 6,
  starterChamberDepthCm: 3,

  // Headless runner: print colony state every 10 ticks (10 seconds).
  debugIntervalTicks: 10,

  ants: {
    worker: {
      count: 10,
      walkSpeedCmPerSec: 2.4,
      digProbPerSoilHit: 0.035,
      turnNoiseRadPerSec: 0.5,
    },
  },
};
