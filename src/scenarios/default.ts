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

  // Starter chamber: 4 cm wide × 1.5 cm deep, ~1/3 of the world's
  // width — visibly the focal point.
  starterChamberWidthCm: 4,
  starterChamberDepthCm: 1.5,

  // Ant slab depth (z dimension).
  slabThicknessCm: 0.8,

  // Print a debug summary every 5 seconds of sim time (150 ticks
  // at 30 Hz).
  debugIntervalTicks: 150,

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
