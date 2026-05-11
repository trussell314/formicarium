// Sim worker. Owns the entire simulation state and drives it
// independently of the main thread's render cadence. Main posts
// commands ('init', 'pause', 'setSpeed', 'requestSnapshot', etc.)
// via the message channel; we reply with rendering snapshots and
// save blobs as needed.
//
// Wall-time accumulator drives stepping: each rAF tick on the main
// thread (or each `requestSnapshot` here) advances bioAccum by the
// elapsed wall time × speedMul; we step as long as the accumulator
// has 120 ms (TICK_MS) of biological time to spend, capped at
// TICK_BUDGET_MS of wall time so the worker stays responsive to
// commands.

import { Colony, STATE_DEAD, STATE_EGG, STATE_LARVA, STATE_QUEEN } from '../sim/colony';
import { DEFAULT_PARAMS, step } from '../sim/ant-rules';
import { ParticleSystem } from '../sim/particles';
import { Pheromone, attachPheromoneWasm, uploadPheromoneCells } from '../sim/pheromone';
import { initPheromoneWasm } from '../sim/pheromone-wasm';
import {
  captureSnapshot, clearSavedSnapshot, restoreSnapshot,
} from '../sim/persist';
import { RNG } from '../sim/rng';
import { HARVESTER, type AntSpecies } from '../sim/species';
import { CELL_AIR, daylight, TICK_MS, World } from '../sim/world';
import type { FromWorker, RenderSnapshot, SaveSettings, ToWorker } from './protocol';
// WASM module URL — Vite resolves this at build time and serves the
// compiled bytes at the resulting URL. Worker fetches the bytes
// once at startup, instantiates, and attaches the runtime so all
// Pheromone instances created afterwards run on the SIMD kernel.
import wasmUrl from '../wasm/pheromone.wasm?url';

interface SimBundle {
  rng: RNG;
  world: World;
  colony: Colony;
  digField: Pheromone;
  buildField: Pheromone;
  trailField: Pheromone;
  alarmField: Pheromone;
  queenField: Pheromone;
  broodField: Pheromone;
  necroField: Pheromone;
  noEntryField: Pheromone;
  granaryField: Pheromone;
  trunkField: Pheromone;
  breachAlarmField: Pheromone;
  entranceField: Pheromone;
  particles: ParticleSystem;
  species: AntSpecies;
}

let bundle: SimBundle | null = null;
let settings: SaveSettings | null = null;
let paused = false;
let extinct = false;
let speedMul = 1;
// Wall-clock anchor for the bio-time accumulator. TICK_MS is imported
// from sim/world (= 1000 / TICKS_PER_SEC).
let lastDriveMs = 0;
let bioAccum = 0;
// Per "drive" call (request from main), spend at most this many ms
// of wall time stepping. The drive call returns once it hits the
// budget so the worker can answer the next message promptly. The
// budget is intentionally larger than the main render frame because
// the worker has no other competing work — only sim. Spilled bio
// time stays in bioAccum for next drive.
const TICK_BUDGET_MS = 12;

function buildBundle(s: SaveSettings, restoreBlob: string | null): SimBundle {
  const rng = new RNG(s.seed);
  const world = new World(s.width, s.height);
  // Enable the food rain. The numeric value used to act as a rate
  // cap; that cap was removed, so any non-zero value just toggles
  // the rain on. (Zero would disable food entirely — used by tests
  // that need a no-food world.)
  world.foodCap = 1;
  // Surface row at 17% — sky band 68 cells (≈ 20 cm at 3 mm/cell),
  // soil depth 332 cells (≈ 100 cm). Real P. barbatus nests run
  // 1-2 m deep so we still cover the lower end of mature-nest
  // depth, while leaving meaningful sky for plants, stars, and
  // the celestial cycle to read.
  const surfaceRow = Math.floor(s.height * 0.17);
  const halfW = Math.max(6, Math.floor(s.width * 0.06));
  const depth = Math.max(4, Math.floor(s.height * 0.05));
  world.generate(rng, surfaceRow, halfW, depth);

  // Initialise the WASM kernel's cells layout BEFORE constructing
  // any Pheromone instances. allocField() throws if uploadCells
  // hasn't run, because the bump pointer for field allocations
  // depends on cells.length. Done here (after world.generate, before
  // any new Pheromone) so the JS path is unaffected — uploadCells
  // is a no-op when no WASM runtime is attached.
  uploadPheromoneCells(world.cells);

  // Pheromone half-lives, compressed 10× from the original
  // calibration to compensate for the 100× time compression of
  // sim activity rates. Without this, fields with deposit rates
  // tied to colony activity (build, trunk, queen, granary, no-entry)
  // accumulate to the saturation cap and produce a giant pile-up
  // attractor that traps half the colony in a self-reinforcing
  // loop. Short-lived fields (alarm, necromone) and the mid-life
  // ones (trail, brood) are left as-is — they don't bloat at the
  // new activity rate.
  const digField = new Pheromone(s.width, s.height, 0.24, 0.999);
  const buildField = new Pheromone(s.width, s.height, 0.40, 0.9995);
  const trailField = new Pheromone(s.width, s.height, 0.40, 0.999);
  const alarmField = new Pheromone(s.width, s.height, 0.50, 0.985);
  // Queen + brood fields are PERMEABLE — they diffuse through soil
  // as well as air. Real ants detect queen presence via cuticular
  // hydrocarbons in chamber air AND via substrate-borne vibrations
  // and CO2 plumes that carry through soil. Without through-soil
  // diffusion a queen sealed off by a cave-in or fully-buried
  // entrance becomes invisible to surface workers and the colony
  // can't recover. Other fields (dig/build/trail/alarm/necro) are
  // truly volatile and stay AIR-only.
  // Queen pheromone: high diffusion + slow evaporation give a
  // characteristic decay length of ~45 cells (13 cm), in the
  // ballpark of real CHC detection range (30-100 cm). The
  // earlier (D=0.10, evap=0.999) collapsed signal at ~10 cells
  // (3 cm) — workers far from the queen never sensed her at all.
  // 4.6-hr biological half-life matches real cuticular-hydrocarbon
  // persistence in still chamber air.
  const queenField = new Pheromone(s.width, s.height, 1.00, 0.9995, true);
  const broodField = new Pheromone(s.width, s.height, 0.20, 0.999, true);
  const necroField = new Pheromone(s.width, s.height, 0.30, 0.99);
  const noEntryField = new Pheromone(s.width, s.height, 0.05, 0.995);
  const granaryField = new Pheromone(s.width, s.height, 0.10, 0.999);
  const trunkField = new Pheromone(s.width, s.height, 0.20, 0.9995);
  // Breach alarm: short half-life so a sealed breach clears quickly
  // and the field doesn't drag recruits to old (already-repaired)
  // sites. Decay rate matches the regular alarm field — both signal
  // urgent local conditions that should fade fast on resolution.
  const breachAlarmField = new Pheromone(s.width, s.height, 0.50, 0.985);
  // Entrance scent. Long decay length (~70 cells) so CARRY_FOOD ants
  // 50+ cells from the nearest shaft can still resolve a return
  // gradient. Refreshed at every open-shaft cell during the periodic
  // open-shaft scan (ant-rules.ts), so the field keeps tracking
  // the actual entry geometry as new shafts open or old ones seal.
  const entranceField = new Pheromone(s.width, s.height, 0.50, 0.9999);

  const colony = new Colony(HARVESTER.maxColonySize);
  // Founding-colony spawn (matches main.ts pre-worker behaviour).
  const cx = world.width >> 1;
  const SHAFT_DEPTH = 10;
  const POCKET_HALF = 2;
  const POCKET_HEIGHT = 4;
  const PACK_DENSITY = 1;
  const surfHere = world.naturalSurface[cx]!;
  const queenY = surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1;
  const queenIdx = colony.spawn(cx + 0.5, queenY + 0.5, 0, rng, DEFAULT_PARAMS);
  if (queenIdx >= 0) {
    colony.state[queenIdx] = STATE_QUEEN;
    colony.stateTicks[queenIdx] = 0;
    colony.energy[queenIdx] = HARVESTER.maxEnergy;
  }
  const shaftAir = SHAFT_DEPTH;
  const pocketAir = (POCKET_HALF * 2 + 1) * POCKET_HEIGHT;
  const pinholeCap = Math.min(s.ants, (shaftAir + pocketAir) * PACK_DENSITY);
  const isAir = (x: number, y: number): boolean =>
    world.cells[world.index(x, y)] === CELL_AIR;
  const placedInPinhole = colony.spawnInRect(
    cx - POCKET_HALF, surfHere,
    cx + POCKET_HALF, surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1,
    pinholeCap, rng, isAir, DEFAULT_PARAMS,
  );
  const remaining = s.ants - placedInPinhole;
  if (remaining > 0) {
    const TARGET_SCATTER_DENSITY = 1;
    const SCATTER_HALF = Math.max(20, Math.min(
      Math.floor((world.width - 1) / 2),
      Math.ceil(remaining / (2 * TARGET_SCATTER_DENSITY)),
    ));
    let topRow = world.height;
    for (let x = Math.max(0, cx - SCATTER_HALF); x <= Math.min(world.width - 1, cx + SCATTER_HALF); x++) {
      if (world.naturalSurface[x]! < topRow) topRow = world.naturalSurface[x]!;
    }
    const scatterY = Math.max(0, topRow - 1);
    colony.spawnInRect(
      Math.max(0, cx - SCATTER_HALF), scatterY,
      Math.min(world.width - 1, cx + SCATTER_HALF), scatterY,
      remaining, rng, isAir, DEFAULT_PARAMS,
    );
  }
  for (let i = 0; i < colony.count; i++) {
    if (colony.state[i] !== 0 /* STATE_WANDER */) continue;
    colony.age[i] = (rng.next() * HARVESTER.matureAge * 1.5) | 0;
  }

  const particles = new ParticleSystem(256);

  if (restoreBlob !== null) {
    const ok = restoreSnapshot(
      restoreBlob,
      { seed: s.seed, width: s.width, height: s.height },
      world, colony,
      digField, buildField, trailField, alarmField, queenField,
      broodField, necroField, noEntryField, granaryField, trunkField,
      rng,
    );
    if (!ok) {
      // Mismatch — fall through with the freshly built bundle.
    }
  }

  return {
    rng, world, colony,
    digField, buildField, trailField, alarmField, queenField,
    broodField, necroField, noEntryField, granaryField, trunkField,
    breachAlarmField, entranceField,
    particles, species: HARVESTER,
  };
}

function drive(now: number): void {
  if (!bundle || paused || extinct) {
    lastDriveMs = now;
    return;
  }
  const dt = Math.min(100, now - lastDriveMs);
  lastDriveMs = now;
  bioAccum += dt * speedMul;
  const sliceStart = now;
  while (bioAccum >= TICK_MS && performance.now() - sliceStart < TICK_BUDGET_MS) {
    step(
      bundle.world, bundle.colony,
      bundle.digField, bundle.buildField,
      bundle.rng, DEFAULT_PARAMS, bundle.particles, bundle.species,
      bundle.trailField, bundle.alarmField, bundle.queenField,
      bundle.broodField, bundle.necroField, bundle.noEntryField,
      bundle.granaryField, bundle.trunkField,
      bundle.breachAlarmField, bundle.entranceField,
    );
    bioAccum -= TICK_MS;
  }
  // If we couldn't keep up with bioAccum within the budget, drop
  // residual rather than spiral on the next drive call.
  if (bioAccum > TICK_MS * 8) bioAccum = 0;
}

function buildSnapshot(includePheromones: boolean): RenderSnapshot {
  if (!bundle) throw new Error('snapshot requested before init');
  const { world, colony, particles, species } = bundle;
  // Aggregated HUD counters + 8-bucket histograms over alive
  // non-queen ants for age and energy distribution charts.
  let alive = 0, dead = 0, eggs = 0, larvae = 0, pupae = 0, queens = 0;
  let wander = 0, carry = 0, rest = 0, forage = 0, carryFood = 0, necroCarry = 0;
  let workerEnergySum = 0, workerEnergyN = 0;
  const ageBuckets = new Uint16Array(12);
  const energyBuckets = new Uint16Array(12);
  const ageCap = species.matureAge * 1.5;
  for (let i = 0; i < colony.count; i++) {
    const s = colony.state[i];
    if (s === STATE_DEAD) { dead++; continue; }
    if (s === STATE_EGG) { eggs++; continue; }
    if (s === STATE_LARVA) { larvae++; continue; }
    if (s === 10 /* STATE_PUPA */) { pupae++; continue; }
    if (s === STATE_QUEEN) { queens++; continue; }
    // Adult worker breakdown.
    if (s === 0 /* WANDER */) wander++;
    else if (s === 1 /* CARRY */) carry++;
    else if (s === 2 /* REST */) rest++;
    else if (s === 3 /* FORAGE */) forage++;
    else if (s === 4 /* CARRY_FOOD */) carryFood++;
    else if (s === 8 /* NECRO_CARRY */) necroCarry++;
    // Histograms (alive workers only — eggs/larvae/queen excluded).
    const ageBucket = Math.min(11, Math.floor((colony.age[i]! / ageCap) * 12));
    ageBuckets[ageBucket]!++;
    const energyBucket = Math.min(11, Math.max(0, Math.floor((colony.energy[i]! / species.maxEnergy) * 12)));
    energyBuckets[energyBucket]!++;
    workerEnergySum += colony.energy[i]!;
    workerEnergyN++;
  }
  const meanWorkerEnergy = workerEnergyN > 0 ? workerEnergySum / workerEnergyN : 1;
  alive = colony.count - dead;
  if (alive === 0 && !extinct) extinct = true;

  let grains = 0, foodCount = 0, soilCount = 0;
  for (let i = 0; i < world.cells.length; i++) {
    const c = world.cells[i]!;
    if (c === 1 /* SOIL */) soilCount++;
    else if (c === 2 /* GRAIN */) grains++;
    if (world.food[i]! > 0) foodCount++;
  }
  let nestVol = 0, maxDepth = 0;
  const wW = world.width;
  const wH = world.height;
  // Chamber count: distinct AIR connected components below natural
  // surface. A single 1-cell-wide passage from surface to a deep
  // pocket counts as one chamber; a gallery with three lateral
  // pockets counts as one (all connected). Useful as a colony-size
  // / nest-architecture metric in the HUD: small numbers (1-3)
  // imply a young or dysfunctional nest, larger (10+) imply a
  // proper Pogonomyrmex-style branching gallery. Flood-fill is
  // O(nestVol) per snapshot; cheap at default world dims.
  let chambers = 0;
  const visited = new Uint8Array(wW * wH);
  // Reusable BFS queue. Sized at the max nest volume (whole world)
  // so we never reallocate. Each entry is a packed (y * wW + x).
  const queue = new Int32Array(wW * wH);
  for (let y = 0; y < wH; y++) {
    for (let x = 0; x < wW; x++) {
      const idx = y * wW + x;
      if (world.cells[idx] !== 0 /* AIR */) continue;
      const sy = world.naturalSurface[x]!;
      if (y < sy) continue;
      nestVol++;
      const d = y - sy;
      if (d > maxDepth) maxDepth = d;
      // Flood-fill from any below-surface AIR cell that hasn't been
      // visited yet. Each unvisited start is a new component.
      if (!visited[idx]) {
        chambers++;
        let head = 0, tail = 0;
        queue[tail++] = idx;
        visited[idx] = 1;
        while (head < tail) {
          const p = queue[head++]!;
          const py = (p / wW) | 0;
          const px = p - py * wW;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= wW || ny >= wH) continue;
            const nIdx = ny * wW + nx;
            if (visited[nIdx] || world.cells[nIdx] !== 0) continue;
            const nsy = world.naturalSurface[nx]!;
            if (ny < nsy) continue;
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }
  }

  // Copy TypedArrays. structured-clone in postMessage will copy
  // again; for now build the snapshot from fresh slices so the
  // worker can keep mutating the originals while main consumes.
  // (Skipping the .slice() and relying on postMessage's own copy
  // would also work but is harder to reason about — explicit is
  // safer.)
  const snap: RenderSnapshot = {
    width: world.width,
    height: world.height,
    tick: world.tick,
    cells: world.cells.slice(),
    soilNoise: world.soilNoise.slice(),
    naturalSurface: world.naturalSurface.slice(),
    food: world.food.slice(),
    foodMoves: world.foodMoves.slice(),
    grainHardness: world.grainHardness.slice(),
    corpse: world.corpse.slice(),
    sprout: world.sprout.slice(),
    sproutTick: world.sproutTick.slice(),
    digTick: world.digTick.slice(),
    plant: world.plant.slice(),
    plantHeight: world.plantHeight.slice(),
    bgPlant: world.bgPlant.slice(),
    bgPlantHeight: world.bgPlantHeight.slice(),
    count: colony.count,
    posX: colony.posX.slice(0, colony.count),
    posY: colony.posY.slice(0, colony.count),
    prevX: colony.prevX.slice(0, colony.count),
    prevY: colony.prevY.slice(0, colony.count),
    heading: colony.heading.slice(0, colony.count),
    state: colony.state.slice(0, colony.count),
    energy: colony.energy.slice(0, colony.count),
    pheromones: includePheromones ? {
      dig: bundle.digField.current.slice(),
      build: bundle.buildField.current.slice(),
      trail: bundle.trailField.current.slice(),
      alarm: bundle.alarmField.current.slice(),
      queen: bundle.queenField.current.slice(),
      brood: bundle.broodField.current.slice(),
      necro: bundle.necroField.current.slice(),
      noEntry: bundle.noEntryField.current.slice(),
      granary: bundle.granaryField.current.slice(),
      trunk: bundle.trunkField.current.slice(),
      breachAlarm: bundle.breachAlarmField.current.slice(),
      entrance: bundle.entranceField.current.slice(),
    } : null,
    hud: {
      alive, dead, eggs, larvae, pupae, queens,
      wander, carry, rest, forage, carryFood, necroCarry,
      grains, foodCount, nestVol, maxDepth, chambers,
      foodCap: world.foodCap,
      totalBorn: world.totalBorn,
      totalDied: world.totalDied,
      totalForageStarts: world.totalForageStarts,
      totalForagePickups: world.totalForagePickups,
      totalForageDeliveries: world.totalForageDeliveries,
      totalForageBails: world.totalForageBails,
      soilCount,
      initialSoilCells: world.initialSoilCells,
      ageBuckets,
      energyBuckets,
      meanWorkerEnergy,
    },
    particles: particles.highWater > 0 ? {
      posX: particles.posX.slice(0, particles.highWater),
      posY: particles.posY.slice(0, particles.highWater),
      life: particles.life.slice(0, particles.highWater),
      maxLife: particles.maxLife.slice(0, particles.highWater),
      highWater: particles.highWater,
    } : null,
    daylight: daylight(world.tick),
    extinct,
  };
  return snap;
}

function send(msg: FromWorker): void {
  // self.postMessage in a Worker context is the channel back to main.
  // For 'snapshot' messages we hand the underlying ArrayBuffers off
  // as Transferables: structured-clone otherwise copies every
  // TypedArray, which at 300×300 with the pheromone overlay enabled
  // is ~5 MB per frame on each end of the channel. Each snapshot
  // typed array was built via .slice() (see buildSnapshot) so the
  // worker has no need to keep the buffers after sending — transfer
  // is safe.
  if (msg.kind === 'snapshot') {
    const transfer = collectSnapshotBuffers(msg.snap);
    (self as unknown as Worker).postMessage(msg, transfer);
    return;
  }
  (self as unknown as Worker).postMessage(msg);
}

/** Walk a RenderSnapshot and collect every TypedArray's underlying
 *  ArrayBuffer for the postMessage transfer list. Each buffer must
 *  be transferred at most once across the run; since snapshots are
 *  built fresh each call this holds. The .slice() typed-array
 *  results we put in the snapshot are always backed by ArrayBuffer
 *  (never SharedArrayBuffer), but lib.dom.d.ts types `.buffer` as
 *  the union so we narrow with a cast. */
function collectSnapshotBuffers(snap: RenderSnapshot): ArrayBuffer[] {
  const ab = (a: { buffer: ArrayBufferLike }): ArrayBuffer => a.buffer as ArrayBuffer;
  const bufs: ArrayBuffer[] = [
    ab(snap.cells), ab(snap.soilNoise), ab(snap.naturalSurface),
    ab(snap.food), ab(snap.foodMoves), ab(snap.grainHardness), ab(snap.corpse),
    ab(snap.sprout), ab(snap.sproutTick), ab(snap.digTick),
    ab(snap.plant), ab(snap.plantHeight),
    ab(snap.bgPlant), ab(snap.bgPlantHeight),
    ab(snap.posX), ab(snap.posY), ab(snap.prevX),
    ab(snap.prevY), ab(snap.heading), ab(snap.state),
    ab(snap.energy),
  ];
  if (snap.pheromones !== null) {
    bufs.push(
      ab(snap.pheromones.dig), ab(snap.pheromones.build),
      ab(snap.pheromones.trail), ab(snap.pheromones.alarm),
      ab(snap.pheromones.queen), ab(snap.pheromones.brood),
      ab(snap.pheromones.necro), ab(snap.pheromones.noEntry),
      ab(snap.pheromones.granary), ab(snap.pheromones.trunk),
      ab(snap.pheromones.breachAlarm),
      ab(snap.pheromones.entrance),
    );
  }
  if (snap.particles !== null) {
    bufs.push(
      ab(snap.particles.posX), ab(snap.particles.posY),
      ab(snap.particles.life), ab(snap.particles.maxLife),
    );
  }
  return bufs;
}

// Async WASM bootstrap. Started immediately on worker load so it
// races with the main thread sending 'init'. If the kernel loads
// before init arrives, all subsequent Pheromone allocations use
// the SIMD path. If WASM/SIMD is unsupported the runtime is null
// and Pheromone falls back to the JS path transparently.
let wasmReady: Promise<void> = (async () => {
  try {
    const rt = await initPheromoneWasm(async () => {
      const r = await fetch(wasmUrl);
      return r.arrayBuffer();
    });
    attachPheromoneWasm(rt);
  } catch (err) {
    console.warn('pheromone-wasm init failed; using JS fallback', err);
    attachPheromoneWasm(null);
  }
})();

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'init': {
      settings = msg.settings;
      // Wait for the WASM module before constructing any Pheromone
      // instances. The await is one-shot — wasmReady resolves once
      // and then all subsequent ticks proceed synchronously.
      wasmReady.then(() => {
        bundle = buildBundle(msg.settings, msg.restoreBlob);
        paused = false;
        extinct = false;
        bioAccum = 0;
        lastDriveMs = performance.now();
        send({ kind: 'ready' });
      });
      break;
    }
    case 'pause':
      paused = true;
      break;
    case 'resume':
      paused = false;
      lastDriveMs = performance.now();
      break;
    case 'setSpeed':
      speedMul = msg.speedMul;
      break;
    case 'reseed':
    case 'loadSave': {
      // Both paths rebuild the bundle. reseed wipes the save and
      // starts fresh; loadSave rehydrates from the supplied blob
      // and PRESERVES the save (so reload after load doesn't lose
      // the user's pinned state). A fresh WASM runtime gives us a
      // clean slab allocator and avoids leaking the old fields'
      // memory in the WASM heap.
      const restoreBlob = msg.kind === 'loadSave' ? msg.restoreBlob : null;
      if (msg.kind === 'reseed') clearSavedSnapshot();
      settings = msg.settings;
      paused = false;
      wasmReady = (async () => {
        try {
          const rt = await initPheromoneWasm(async () => {
            const r = await fetch(wasmUrl);
            return r.arrayBuffer();
          });
          attachPheromoneWasm(rt);
        } catch {
          attachPheromoneWasm(null);
        }
      })();
      wasmReady.then(() => {
        bundle = buildBundle(msg.settings, restoreBlob);
        extinct = false;
        bioAccum = 0;
        lastDriveMs = performance.now();
        send({ kind: 'ready' });
      });
      break;
    }
    case 'requestSnapshot': {
      // Worker may still be booting (async WASM load + buildBundle).
      // The main-thread render loop fires requestSnapshot from rAF
      // independently of the 'ready' handshake, so we defensively
      // skip when bundle isn't ready yet — main will retry on the
      // next frame, and the deferred snapshotPending state will
      // unstick when 'ready' triggers a fresh request.
      if (!bundle) break;
      drive(performance.now());
      const snap = buildSnapshot(msg.includePheromones);
      send({ kind: 'snapshot', snap });
      break;
    }
    case 'captureForSave': {
      if (!bundle || !settings) {
        send({ kind: 'savedBlob', blob: null });
        break;
      }
      const blob = captureSnapshot(
        bundle.world, bundle.colony,
        bundle.digField, bundle.buildField, bundle.trailField,
        bundle.alarmField, bundle.queenField,
        bundle.broodField, bundle.necroField, bundle.noEntryField,
        bundle.granaryField, bundle.trunkField,
        bundle.rng,
        { seed: settings.seed, width: settings.width, height: settings.height },
      );
      send({ kind: 'savedBlob', blob });
      break;
    }
    case 'shutdown':
      bundle = null;
      break;
  }
};
