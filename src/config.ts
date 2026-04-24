// Single source of truth for all tunable constants.
//
// This is the "restart" config. Deliberately minimal:
//   - no quality tiers, one profile only
//   - 10 ants (observable scale; each ant individually renderable)
//   - 30 Hz simulation, real-time (no speed multiplier anywhere else)
//   - 1-minute day/night cycle
//   - scientifically motivated behaviour parameters (ant speed based on
//     published observations of Formicinae locomotion: ~2 cm/s ≈ 2
//     cells/s at our grid scale)

export const CONFIG = {
  // World geometry.
  gridWidth: 240,
  gridHeight: 135,
  // Natural surface sits at this fraction from the top of the world.
  // Above this: sky. Below: soil (before excavation).
  surfaceFraction: 0.35,
  // Amplitude (cells) of the wavy surface generator.
  surfaceRoughness: 2,

  // Agents.
  antCount: 10,

  // Simulation pacing. 30 Hz gives smooth motion with 33 ms per tick.
  // 1 minute = 1800 ticks.
  simHz: 30,
  dayLengthTicks: 1800,

  // Locomotion. 0.08 cells/tick × 30 Hz = 2.4 cells/sec — a believable
  // "walking" speed for a body roughly 4 cells long.
  antWalkSpeed: 0.08,
  turnNoiseRad: 0.15, // gaussian per-tick heading perturbation stddev

  // Behaviour.
  // Probabilistic dig on soil contact, per Sudd 1970 observations of
  // Lasius flavus: most contacts do nothing, a fraction become digs.
  digProbPerSoilHit: 0.035,
  // When carrying, ant turns toward up so it heads for surface.
  carryUpBias: 0.25,

  // Grain deposit physics.
  grainPileMax: 6,
  grainAngleOfRepose: 1,

  // Starter chamber (tiny — just enough for 10 ants to stand).
  starterChamberHalfWidth: 6,
  starterChamberDepth: 4,
} as const;

// Renderer constants.
export const RENDER = {
  // Daytime sky gradient.
  skyTopDay: '#4a7eb0',
  skyBottomDay: '#bfd8ee',
  // Night sky.
  skyTopNight: '#0a1020',
  skyBottomNight: '#1b1a35',
  // Sun and moon.
  sunColor: '#fff5c8',
  moonColor: '#d8dcf0',

  // Terrain.
  soilTop: '#7a5536',
  soilBottom: '#3a2414',
  soilEdge: '#8b6946',
  // Tunnel interior — sub-surface air.
  tunnelTop: '#c4a374',
  tunnelBottom: '#7a5a38',

  grassTop: '#6aa83e',
  grassRoot: '#3e5c28',
  grainColor: '#d4b076',

  // Ants — near-black for silhouette contrast against tan tunnels.
  antBody: '#151017',
  antHead: '#0a070b',
  antLeg: '#201820',
} as const;

export interface Options {
  seed: number;
  showOverlay: boolean;
  paused: boolean;
}

export function parseOptions(search: string = location.search): Options {
  const p = new URLSearchParams(search);
  const seed = p.get('seed');
  return {
    seed: seed !== null && Number.isFinite(Number(seed))
      ? (Number(seed) | 0) >>> 0
      : (Date.now() & 0xffffffff) >>> 0,
    showOverlay: p.get('overlay') === '1',
    paused: false,
  };
}
