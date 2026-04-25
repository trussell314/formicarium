// Default scenario — what the web UI renders.
//
// Plain-data object. Edit this file to change the live demo; no
// code changes elsewhere are needed.

import type { Scenario } from '../scenario';

export const DEFAULT_SCENARIO: Scenario = {
  name: 'default-web',

  // 10 ticks/sec — small enough that per-tick ant motion is a
  // fraction of a cell so motion animates smoothly between ticks.
  secondsPerTick: 0.1,
  // 60 s of daylight, then 60 s of night. 2-minute cycle.
  dayDurationSec: 60,
  nightDurationSec: 60,

  // 36 cm wide × 20 cm tall. At 20 cells/cm that's a 720 × 400 grid.
  worldWidthCm: 36,
  worldHeightCm: 20,
  surfaceFromTopCm: 5,

  // Starter chamber: 4 cm wide × 2 cm deep. With 10 workers that's
  // roughly 8 cells of chamber area per ant — not crowded.
  starterChamberWidthCm: 4,
  starterChamberDepthCm: 2,

  // Print a debug summary every 5 seconds of sim time (50 ticks).
  debugIntervalTicks: 50,

  ants: {
    worker: {
      count: 10,
      walkSpeedCmPerSec: 2.4,
      digProbPerSoilHit: 0.12,
      turnNoiseRadPerSec: 1.2,
      bodyLengthCm: 0.6,
    },
  },
};
