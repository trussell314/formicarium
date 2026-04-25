// Default scenario — what the web UI renders.
//
// Plain-data object. Edit this file to change the live demo; no
// code changes elsewhere are needed.

import type { Scenario } from '../scenario';

export const DEFAULT_SCENARIO: Scenario = {
  name: 'default-web',

  // 30 Hz sim. At 10 Hz the heading-snap was visible as choppy
  // motion on the detail-rich 3D ant model; 30 Hz × interpolation
  // between prev and current = smooth.
  secondsPerTick: 1 / 30,
  // Day/night durations stay in seconds; resolver derives ticks.
  dayDurationSec: 60,
  nightDurationSec: 60,

  // Smaller world (12 × 7 cm) so the chamber fills more of the
  // screen — the previous 36 × 20 cm world made the ants feel like
  // tiny dots in a big field.
  worldWidthCm: 12,
  worldHeightCm: 7,
  surfaceFromTopCm: 2,

  // Starter chamber: 2 cm wide × 1 cm deep. Smaller than the
  // visible world so excavation has somewhere to go — with the
  // previous 4 × 1.5 cm chamber, ants dug at the edges but the
  // chamber barely changed visually over many in-game days.
  starterChamberWidthCm: 2,
  starterChamberDepthCm: 1,

  // Ant slab depth (z dimension).
  slabThicknessCm: 0.8,

  // Print a debug summary every 5 seconds of sim time (150 ticks
  // at 30 Hz).
  debugIntervalTicks: 150,

  // Food drops every 12 s of sim time (was 4 s). With 10 ants the
  // previous rate kept ~9/10 of them stuck in HAUL trips at any
  // moment, leaving almost nobody free to dig.
  foodSpawnIntervalSec: 12,

  ants: {
    worker: {
      count: 10,
      walkSpeedCmPerSec: 2.4,
      // Pushed high so the user can SEE digging happen on a normal
      // viewing window. With this and 10 ants in a small chamber,
      // the colony excavates ~30 cells in the first ~5 seconds of
      // sim time and continues to expand visibly thereafter.
      digProbPerSoilHit: 0.55,
      turnNoiseRadPerSec: 1.2,
      bodyLengthCm: 0.6,
    },
  },
};
