// Wire protocol between main thread and sim worker.
//
// The sim runs in its own thread so the render loop (rAF, 60Hz)
// stays smooth no matter how busy the simulation is. Communication
// uses a tiny tagged-union message protocol.
//
// Snapshot-vs-live-state: the worker owns ALL sim state. The main
// thread only ever sees periodic snapshots that the worker pushes
// for rendering. Every TypedArray in a snapshot is a fresh copy —
// we use structured-clone (not Transferable) so the worker keeps
// its source data and can keep stepping while main renders. At
// default world dims (280×140) the snapshot is ~150 KB without
// pheromones, ~1.6 MB with the overlay enabled.

export type SaveSettings = {
  seed: number;
  width: number;
  height: number;
  ants: number;
};

// ── Main → worker ────────────────────────────────────────────

export type ToWorker =
  | { kind: 'init'; settings: SaveSettings; restoreBlob: string | null }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'setSpeed'; speedMul: number }
  | { kind: 'reseed'; settings: SaveSettings }
  | { kind: 'requestSnapshot'; includePheromones: boolean }
  | { kind: 'captureForSave' }
  | { kind: 'loadSave'; settings: SaveSettings; restoreBlob: string }
  | { kind: 'shutdown' };

// ── Worker → main ────────────────────────────────────────────

/** Render-only state. Just the arrays the renderer reads, copied
 *  fresh each frame. Field names mirror World/Colony so the
 *  renderer can take this as a loose-typed `world`/`colony`
 *  duck-typed argument. */
export type RenderSnapshot = {
  // World fields
  width: number;
  height: number;
  tick: number;
  cells: Uint8Array;
  soilNoise: Uint8Array;
  naturalSurface: Uint16Array;
  food: Uint8Array;
  foodMoves: Uint8Array;
  corpse: Uint8Array;
  sprout: Uint8Array;
  sproutTick: Int32Array;
  digTick: Int32Array;
  plant: Uint8Array;
  plantHeight: Uint16Array;
  bgPlant: Uint8Array;
  bgPlantHeight: Uint16Array;
  // Colony fields
  count: number;
  posX: Float32Array;
  posY: Float32Array;
  prevX: Float32Array;
  prevY: Float32Array;
  heading: Float32Array;
  state: Uint8Array;
  energy: Float32Array;
  // Pheromone .current arrays. Optional — main can ask the worker
  // to skip these in the snapshot when the overlay is off.
  pheromones: null | {
    dig: Float32Array;
    build: Float32Array;
    trail: Float32Array;
    alarm: Float32Array;
    queen: Float32Array;
    brood: Float32Array;
    necro: Float32Array;
    noEntry: Float32Array;
    granary: Float32Array;
    trunk: Float32Array;
  };
  // Aggregated HUD counters (computed once on the worker each
  // snapshot — cheaper than scanning the full colony on the main
  // thread every render).
  hud: {
    alive: number;
    dead: number;
    eggs: number;
    larvae: number;
    pupae: number;
    queens: number;
    // Per-state worker breakdown (W/C/R/F/CF/N — wander/carry/rest/
    // forage/carry-food/necro-carry). Counts are over alive ants
    // only; queen and brood states get their own fields above.
    wander: number;
    carry: number;
    rest: number;
    forage: number;
    carryFood: number;
    necroCarry: number;
    grains: number;
    foodCount: number;
    nestVol: number;
    maxDepth: number;
    /** Distinct connected-component count of below-surface AIR
     *  cells. 1 = single chamber/shaft, larger = branching nest. */
    chambers: number;
    foodCap: number;
    totalBorn: number;
    totalDied: number;
    soilCount: number;
    initialSoilCells: number;
    // 8-bucket histograms over alive non-queen ants.
    // ageBuckets bins age uniformly across [0, matureAge × 1.5];
    // energyBuckets bins across [0, maxEnergy].
    ageBuckets: Uint16Array;
    energyBuckets: Uint16Array;
    /** Mean energy across alive worker-class ants (excludes queen,
     *  eggs, larvae). Used by the HUD to surface a STARVING badge
     *  before the colony tips into extinction. */
    meanWorkerEnergy: number;
  };
  // Particles snapshot — small, copied verbatim. Renderer uses
  // these directly; null if the sim doesn't run particles.
  particles: null | {
    posX: Float32Array;
    posY: Float32Array;
    life: Int16Array;
    maxLife: Int16Array;
    highWater: number;
  };
  daylight: number;
  extinct: boolean;
};

export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'snapshot'; snap: RenderSnapshot }
  | { kind: 'savedBlob'; blob: string | null };
