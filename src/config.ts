// All tunable constants. See SPEC §13.

export type Quality = 'low' | 'medium' | 'high';

export interface QualityProfile {
  gridWidth: number;
  gridHeight: number;
  antCount: number;
  simHz: number;
}

export const QUALITY_PROFILES: Record<Quality, QualityProfile> = {
  low: { gridWidth: 320, gridHeight: 180, antCount: 200, simHz: 15 },
  medium: { gridWidth: 480, gridHeight: 270, antCount: 500, simHz: 20 },
  high: { gridWidth: 720, gridHeight: 405, antCount: 900, simHz: 24 },
};

export const SIM = {
  // Soil starts at this normalized fraction from the top (0..1).
  surfaceFraction: 0.18,
  // Surface roughness amplitude in cells.
  surfaceRoughness: 2,

  // Agent kinematics.
  antSpeed: 1.6, // cells per simulation tick
  antRadius: 0.45,
  turnNoiseRad: 0.55, // per-tick gaussian-ish heading noise stddev (radians)

  // Pheromone fields.
  digPheromoneDeposit: 1.0,
  digPheromoneEvap: 0.985,
  digPheromoneDiffuse: 0.18, // fraction of cell's value that diffuses to neighbors
  constructionPheromoneDeposit: 1.0,
  constructionPheromoneEvap: 0.995,
  constructionPheromoneDiffuse: 0.10,

  // Behaviour.
  digProbBase: 0.018,
  digProbPheromone: 0.55, // multiplier from local dig pheromone (pre-clamp)
  digProbCollisionPenalty: 0.35,
  digSensingRadius: 5, // cells, used for pheromone arc sampling
  agitationThreshold: 4, // collisions needed in window to enter REST
  agitationRestTicks: 30,
  collisionDecayPerTick: 0.06, // per-tick decay on collisionCount float

  // Wandering biases.
  downwardBias: 0.12,
  surfaceUpBias: 0.20, // when carrying, head up
  pheromoneFollowStrength: 1.6,

  // Chamber widening — once a soil cell is "exposed" (adjacent to air w/ active
  // pheromone) for this many ticks, lateral digging is favored.
  chamberExposureThreshold: 90,
  chamberLateralBias: 0.55,

  // Grain disposal.
  grainPileMax: 6,
  grainPileGrowthRadius: 3,

  // Disturbance (mouse poke).
  disturbanceRadius: 18,
  disturbanceCollisionBoost: 8,
  disturbanceDigPheromoneBoost: 2.0,

  // Spawn.
  initialQueenDepthFraction: 0.05, // ants spawn just below the surface
} as const;

export const RENDER = {
  // Background gradient.
  skyTop: '#0a0c10',
  skyBottom: '#13161e',
  soilTop: '#7a583a',
  soilBottom: '#3a2a1c',
  soilEdge: '#5a3f28',
  grainColor: '#a47a4d',

  // Pheromone visualization (dev / subtle).
  digPheromoneColor: [255, 220, 120] as const,
  constructionPheromoneColor: [120, 200, 255] as const,
  pheromoneVisAlpha: 0.22, // baseline; multiplied by config flag

  // Ants.
  antBodyColor: '#1a1a1f',
  antRestColor: '#3a3032',
  antCarryColor: '#a47a4d',
  antDigColor: '#26211e',

  // Dev pheromone overlay strength (boolean toggled by overlay flag).
  showPheromones: false,
} as const;

export interface Options {
  quality: Quality;
  seed: number;
  showOverlay: boolean;
  showPheromones: boolean;
  speedMultiplier: number;
}

const DEFAULTS: Options = {
  quality: 'medium',
  seed: (Date.now() & 0xffffffff) >>> 0,
  showOverlay: false,
  showPheromones: false,
  speedMultiplier: 1,
};

export function parseOptionsFromURL(search: string = location.search): Options {
  const params = new URLSearchParams(search);
  const opts: Options = { ...DEFAULTS };
  const q = params.get('quality');
  if (q === 'low' || q === 'medium' || q === 'high') opts.quality = q;
  const seed = params.get('seed');
  if (seed !== null) {
    const n = Number(seed);
    if (Number.isFinite(n)) opts.seed = (n | 0) >>> 0;
  }
  if (params.get('overlay') === '1') opts.showOverlay = true;
  if (params.get('pheromones') === '1') opts.showPheromones = true;
  const sp = params.get('speed');
  if (sp !== null) {
    const n = Number(sp);
    if (Number.isFinite(n) && n > 0) opts.speedMultiplier = n;
  }
  return opts;
}
