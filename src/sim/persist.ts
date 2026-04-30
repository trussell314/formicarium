// LocalStorage save/restore for the full simulation state.
//
// Snapshots include: every TypedArray on World and Colony, both
// pheromone fields, and the RNG state. Particles are intentionally
// omitted — they're ephemeral visual fluff and re-spawn from regular
// dig events anyway.
//
// Encoding: each TypedArray's underlying bytes are base64-encoded
// strings inside a JSON envelope. localStorage stores strings only,
// so this is the simplest cross-browser approach. With the default
// 400×200 world + 1000-ant capacity colony, the serialized blob is
// roughly 2 MB — well under the typical 5–10 MB localStorage limit.
//
// Schema is versioned (v: number). On version mismatch we discard
// the save and start fresh — no migration logic.

import { Colony } from './colony';
import { Pheromone } from './pheromone';
import { RNG } from './rng';
import { World } from './world';

const SAVE_KEY = 'formicarium:save';
// Bump on schema change so old saves are silently discarded rather
// than restored into mismatched buffer layouts. v2 added sprout +
// sproutTick; v3 added the foraging trail pheromone; v4 added the
// alarm pheromone; v5 added the population-driven food rate
// (foodCap, clumpAccum); v6 added per-ant stuckTicks; v7 added the
// queen pheromone; v8 added brood, necromone, no-entry, granary,
// and trunk-trail pheromones; v9 added per-column surface plant;
// v10 added per-column plant height (split from immutable kind);
// v11 widened plantHeight to Uint16 for real-scale plants
// (mature trees up to ~1500 cells at 3 mm/cell).
const SAVE_VERSION = 11;

// Chunked btoa to avoid argument-list length limits on very large arrays.
function bytesToB64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface SaveStateV11 {
  v: 11;
  foodCap: number;
  clumpAccum: number;
  // Settings — needed to validate that a save matches the requested run.
  seed: number;
  width: number;
  height: number;
  capacity: number;
  // RNG
  rng: number;
  // World scalars
  tick: number;
  initialSoilCells: number;
  wearLost: number;
  totalBorn: number;
  totalDied: number;
  digsByDir: number[];
  // World arrays (b64)
  cells: string;
  naturalSurface: string;
  mound: string;
  soilNoise: string;
  grainMoves: string;
  food: string;
  foodMoves: string;
  corpse: string;
  sprout: string;
  sproutTick: string;
  digTick: string;
  plant: string;
  plantHeight: string;
  // Colony scalars
  colonyCount: number;
  // Colony arrays (b64)
  posX: string;
  posY: string;
  prevX: string;
  prevY: string;
  heading: string;
  state: string;
  stateTicks: string;
  digProb: string;
  pickProb: string;
  stigmergy: string;
  turnNoise: string;
  restThreshold: string;
  collisionCount: string;
  carryMoves: string;
  energy: string;
  age: string;
  stuckTicks: string;
  // Pheromone fields — only `current` is stored (scratch is rebuilt fresh).
  digCurrent: string;
  buildCurrent: string;
  trailCurrent: string;
  alarmCurrent: string;
  queenCurrent: string;
  broodCurrent: string;
  necroCurrent: string;
  noEntryCurrent: string;
  granaryCurrent: string;
  trunkCurrent: string;
}

export interface SaveSettings {
  seed: number;
  width: number;
  height: number;
}

/**
 * Capture the full simulation state into a single string suitable
 * for localStorage. Returns null if the encoded blob would exceed
 * a safe size (in which case the caller should fall back to
 * skipping the save rather than throwing on the localStorage write).
 */
export function captureSnapshot(
  world: World, colony: Colony,
  digField: Pheromone, buildField: Pheromone, trailField: Pheromone,
  alarmField: Pheromone, queenField: Pheromone,
  broodField: Pheromone, necroField: Pheromone, noEntryField: Pheromone,
  granaryField: Pheromone, trunkField: Pheromone,
  rng: RNG, settings: SaveSettings,
): string | null {
  const state: SaveStateV11 = {
    v: SAVE_VERSION,
    seed: settings.seed,
    width: settings.width,
    height: settings.height,
    capacity: colony.capacity,
    rng: rng.getState(),
    tick: world.tick,
    initialSoilCells: world.initialSoilCells,
    wearLost: world.wearLost,
    totalBorn: world.totalBorn,
    totalDied: world.totalDied,
    foodCap: world.foodCap,
    clumpAccum: world.clumpAccum,
    digsByDir: Array.from(world.digsByDir),
    cells: bytesToB64(world.cells),
    naturalSurface: bytesToB64(world.naturalSurface),
    mound: bytesToB64(world.mound),
    soilNoise: bytesToB64(world.soilNoise),
    grainMoves: bytesToB64(world.grainMoves),
    food: bytesToB64(world.food),
    foodMoves: bytesToB64(world.foodMoves),
    corpse: bytesToB64(world.corpse),
    sprout: bytesToB64(world.sprout),
    sproutTick: bytesToB64(world.sproutTick),
    digTick: bytesToB64(world.digTick),
    plant: bytesToB64(world.plant),
    plantHeight: bytesToB64(world.plantHeight),
    colonyCount: colony.count,
    posX: bytesToB64(colony.posX),
    posY: bytesToB64(colony.posY),
    prevX: bytesToB64(colony.prevX),
    prevY: bytesToB64(colony.prevY),
    heading: bytesToB64(colony.heading),
    state: bytesToB64(colony.state),
    stateTicks: bytesToB64(colony.stateTicks),
    digProb: bytesToB64(colony.digProb),
    pickProb: bytesToB64(colony.pickProb),
    stigmergy: bytesToB64(colony.stigmergy),
    turnNoise: bytesToB64(colony.turnNoise),
    restThreshold: bytesToB64(colony.restThreshold),
    collisionCount: bytesToB64(colony.collisionCount),
    carryMoves: bytesToB64(colony.carryMoves),
    energy: bytesToB64(colony.energy),
    age: bytesToB64(colony.age),
    stuckTicks: bytesToB64(colony.stuckTicks),
    digCurrent: bytesToB64(digField.current),
    buildCurrent: bytesToB64(buildField.current),
    trailCurrent: bytesToB64(trailField.current),
    alarmCurrent: bytesToB64(alarmField.current),
    queenCurrent: bytesToB64(queenField.current),
    broodCurrent: bytesToB64(broodField.current),
    necroCurrent: bytesToB64(necroField.current),
    noEntryCurrent: bytesToB64(noEntryField.current),
    granaryCurrent: bytesToB64(granaryField.current),
    trunkCurrent: bytesToB64(trunkField.current),
  };
  return JSON.stringify(state);
}

/**
 * Try to write a snapshot to localStorage. Quota errors and missing-
 * storage environments are swallowed silently — saving is best-effort
 * and never blocks the simulation.
 */
export function saveToLocalStorage(blob: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(SAVE_KEY, blob);
    return true;
  } catch {
    return false;
  }
}

export function clearSavedSnapshot(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

export function readSavedBlob(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}

/**
 * Reverse of captureSnapshot. Mutates the provided world / colony /
 * pheromone fields / rng IN PLACE — the caller has already constructed
 * fresh instances at the right dimensions and we overwrite their
 * buffers with the saved data. Returns false on any decode/version
 * mismatch (caller should fall back to a fresh sim).
 *
 * The provided settings are checked against the saved settings; if
 * width / height / seed don't match, the save is rejected (otherwise
 * we'd be deserializing into wrongly-sized buffers, or restoring a
 * different scenario than the user requested).
 */
export function restoreSnapshot(
  blob: string, settings: SaveSettings,
  world: World, colony: Colony,
  digField: Pheromone, buildField: Pheromone, trailField: Pheromone,
  alarmField: Pheromone, queenField: Pheromone,
  broodField: Pheromone, necroField: Pheromone, noEntryField: Pheromone,
  granaryField: Pheromone, trunkField: Pheromone,
  rng: RNG,
): boolean {
  let raw: unknown;
  try { raw = JSON.parse(blob); } catch { return false; }
  const s = raw as Partial<SaveStateV11>;
  if (
    !s ||
    s.v !== SAVE_VERSION ||
    s.seed !== settings.seed ||
    s.width !== settings.width ||
    s.height !== settings.height ||
    typeof s.capacity !== 'number' || s.capacity !== colony.capacity
  ) return false;

  const copyBytes = (src: string, dst: ArrayBufferView): void => {
    const bytes = b64ToBytes(src);
    const dstBytes = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength);
    if (bytes.length !== dstBytes.length) throw new Error('size mismatch');
    dstBytes.set(bytes);
  };

  /** Clamp NaN / Infinity in a freshly-restored Float32 pheromone
   *  buffer to zero. See the call site for the failure mode this
   *  guards against. Cost: one Float32 sweep per field on restore;
   *  no per-tick cost. */
  const sanitisePheromoneBuffer = (buf: Float32Array): void => {
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]!;
      if (!Number.isFinite(v)) buf[i] = 0;
    }
  };

  try {
    rng.setState(s.rng!);
    world.tick = s.tick!;
    world.initialSoilCells = s.initialSoilCells!;
    world.wearLost = s.wearLost!;
    world.totalBorn = s.totalBorn!;
    world.totalDied = s.totalDied!;
    world.foodCap = s.foodCap!;
    world.clumpAccum = s.clumpAccum!;
    for (let i = 0; i < 4; i++) world.digsByDir[i] = s.digsByDir![i]!;
    copyBytes(s.cells!, world.cells);
    copyBytes(s.naturalSurface!, world.naturalSurface);
    copyBytes(s.mound!, world.mound);
    copyBytes(s.soilNoise!, world.soilNoise);
    copyBytes(s.grainMoves!, world.grainMoves);
    copyBytes(s.food!, world.food);
    copyBytes(s.foodMoves!, world.foodMoves);
    copyBytes(s.corpse!, world.corpse);
    copyBytes(s.sprout!, world.sprout);
    copyBytes(s.sproutTick!, world.sproutTick);
    copyBytes(s.digTick!, world.digTick);
    copyBytes(s.plant!, world.plant);
    copyBytes(s.plantHeight!, world.plantHeight);
    colony.count = s.colonyCount!;
    copyBytes(s.posX!, colony.posX);
    copyBytes(s.posY!, colony.posY);
    copyBytes(s.prevX!, colony.prevX);
    copyBytes(s.prevY!, colony.prevY);
    copyBytes(s.heading!, colony.heading);
    copyBytes(s.state!, colony.state);
    copyBytes(s.stateTicks!, colony.stateTicks);
    copyBytes(s.digProb!, colony.digProb);
    copyBytes(s.pickProb!, colony.pickProb);
    copyBytes(s.stigmergy!, colony.stigmergy);
    copyBytes(s.turnNoise!, colony.turnNoise);
    copyBytes(s.restThreshold!, colony.restThreshold);
    copyBytes(s.collisionCount!, colony.collisionCount);
    copyBytes(s.carryMoves!, colony.carryMoves);
    copyBytes(s.energy!, colony.energy);
    copyBytes(s.age!, colony.age);
    copyBytes(s.stuckTicks!, colony.stuckTicks);
    copyBytes(s.digCurrent!, digField.current);
    copyBytes(s.buildCurrent!, buildField.current);
    copyBytes(s.trailCurrent!, trailField.current);
    copyBytes(s.alarmCurrent!, alarmField.current);
    copyBytes(s.queenCurrent!, queenField.current);
    copyBytes(s.broodCurrent!, broodField.current);
    copyBytes(s.necroCurrent!, necroField.current);
    copyBytes(s.noEntryCurrent!, noEntryField.current);
    copyBytes(s.granaryCurrent!, granaryField.current);
    copyBytes(s.trunkCurrent!, trunkField.current);
    // Defensive scrub. Saves authored by older builds may contain
    // NaN / Infinity pheromone values — earlier in this branch's
    // history a since-reverted dirty-tile pheromone refactor could
    // produce both — and feeding a NaN through a 5-point stencil
    // poisons every cell it touches by the next tick. The pheromone
    // overlay path then uploads NaN-bearing RGBA32F textures, which
    // some browser/GPU combinations handle by stalling the GL
    // pipeline or running the fragment shader for a comically long
    // time per pixel. Clearing here is a one-pass cost on restore
    // and a no-op for buffers that were already valid.
    sanitisePheromoneBuffer(digField.current);
    sanitisePheromoneBuffer(buildField.current);
    sanitisePheromoneBuffer(trailField.current);
    sanitisePheromoneBuffer(alarmField.current);
    sanitisePheromoneBuffer(queenField.current);
    sanitisePheromoneBuffer(broodField.current);
    sanitisePheromoneBuffer(necroField.current);
    sanitisePheromoneBuffer(noEntryField.current);
    sanitisePheromoneBuffer(granaryField.current);
    sanitisePheromoneBuffer(trunkField.current);
    // The Pheromone class tracks an internal "is the buffer all-zero"
    // flag for the empty-field fast path in step(). Direct byte
    // copies above bypass that bookkeeping, so re-derive it from
    // each field's restored content before the next step().
    digField.resyncNonZero();
    buildField.resyncNonZero();
    trailField.resyncNonZero();
    alarmField.resyncNonZero();
    queenField.resyncNonZero();
    broodField.resyncNonZero();
    necroField.resyncNonZero();
    noEntryField.resyncNonZero();
    granaryField.resyncNonZero();
    trunkField.resyncNonZero();
  } catch {
    return false;
  }
  return true;
}
