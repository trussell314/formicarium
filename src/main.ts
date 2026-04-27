// Entry point. Builds the world + colony, runs the sim loop, draws to
// the canvas. URL params:
//   ?seed=N       fixed RNG seed (otherwise time-derived)
//   ?speed=N      sim sub-steps per render frame (default 8)
//   ?ants=N       initial ant count
//   ?width=N      world width (cells)
//   ?height=N     world height (cells)

import { Colony, STATE_DEAD, STATE_EGG, STATE_LARVA, STATE_QUEEN } from './sim/colony';
import { DEFAULT_PARAMS, step } from './sim/ant-rules';
import { ParticleSystem } from './sim/particles';
import { Pheromone } from './sim/pheromone';
import {
  captureSnapshot, clearSavedSnapshot, readSavedBlob,
  restoreSnapshot, saveToLocalStorage,
} from './sim/persist';
import { RNG } from './sim/rng';
import { HARVESTER } from './sim/species';
import { daylight, World } from './sim/world';
import { Renderer } from './render/renderer';

interface Settings {
  seed: number;
  width: number;
  height: number;
  ants: number;
  /** Sim sub-steps per render frame. Higher = faster time-lapse. */
  simStepsPerFrame: number;
}

function readSettings(): Settings {
  const p = new URLSearchParams(location.search);
  const num = (k: string, d: number): number => {
    const v = p.get(k);
    if (v === null) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    seed: num('seed', (Date.now() & 0xffffffff) >>> 0),
    // Default world is 280×140 cells × 3 mm/cell = 84 cm × 42 cm
    // physical, scaled down from the previous 400×200 / 100-ant
    // default to roughly half the cell area now that the starter
    // colony is 50 ants. Aspect ratio (2:1) preserved. The
    // Khuong+Buhl medium-density regime — ~1 ant per 200 cells,
    // upper end of "branched architecture" rather than single-
    // gallery — still holds: 50 ants in 39,200 cells = 1 per 784,
    // a bit lighter than before, which fits a smaller starter
    // colony's looser dig effort. Sim cost scales linearly with
    // W·H so the pheromone field update is ~half the work too.
    width: Math.max(40, num('width', 280) | 0),
    height: Math.max(30, num('height', 140) | 0),
    ants: Math.max(0, num('ants', 50) | 0),
    simStepsPerFrame: Math.max(1, num('speed', 8) | 0),
  };
}

function build(s: Settings) {
  const rng = new RNG(s.seed);
  const world = new World(s.width, s.height);
  // Food-rate cap. The clump rain inside step() computes a target
  // rate every tick from live colony metabolic demand × 1.10, and
  // saturates that rate at `foodCap` workers' worth of demand.
  // 10× the starting-ant URL parameter gives the colony substantial
  // growth headroom while preventing runaway food drops at maxed-out
  // colony sizes. Floor at 50 so a queen-only (?ants=0) founding
  // colony still gets meaningful food rain once her first nanitics
  // start foraging — without the floor the cap is 0 and no clump
  // ever fires.
  world.foodCap = Math.max(50, s.ants * 10);
  const surfaceRow = Math.floor(s.height * 0.30);
  const halfW = Math.max(6, Math.floor(s.width * 0.06));
  const depth = Math.max(4, Math.floor(s.height * 0.05));
  world.generate(rng, surfaceRow, halfW, depth);

  // Two pheromone fields. The dig-pheromone evaporation is at the
  // FAST end of the literature range (Bonabeau et al. 1998 give
  // 0.95–0.99). Slow evaporation (0.992 → ~85-tick half-life) made
  // stigmergy too sticky: once the first dig front established its
  // gradient, no second front could compete. Faster evaporation
  // (0.97 → ~22-tick half-life) means a site's recruitment power
  // decays unless ants keep working it; new sites get a fair shot
  // at bootstrapping. Build pheromone stays slow (0.997) — spoil
  // mounds are meant to be persistent landmarks.
  // Pheromone parameters calibrated to biological half-lives AND to
  // gradient sharpness. Diffuse rate scales by 1/cell_size² to keep
  // physical diffusion coefficient D constant: at 3 mm/cell (was 6),
  // diffuse must be 4× higher than the original 6-mm-cell values
  // (0.06 → 0.24, 0.10 → 0.40). Half-life is tick-based not space-
  // based and stays the same.
  //   dig field   — 14 min biological half-life (top of Bonabeau
  //                 et al. 1998 range): retention = 0.5^(1/7000) ≈
  //                 0.9999. diffuse = 0.24 (cell-scaled).
  //   build field — 30 min biological half-life (construction
  //                 pheromone, slower-decaying class; Khuong 2016):
  //                 retention = 0.5^(1/15000) ≈ 0.99995. diffuse =
  //                 0.40 (cell-scaled).
  const digField = new Pheromone(world.width, world.height, 0.24, 0.9999);
  const buildField = new Pheromone(world.width, world.height, 0.40, 0.99995);
  // Foraging recruitment trail (Bonabeau et al. 1998). Lives entirely
  // above the natural surface; CARRY_FOOD ants returning from a
  // patch lay a fading breadcrumb chain that other FORAGE ants
  // bias their heading along. Half-life ~700 ticks (~84 sec
  // biological — matches Pheidole / Solenopsis trail volatility,
  // shorter than the dig pheromone so a stale trail doesn't keep
  // pulling foragers to a long-empty patch).
  const trailField = new Pheromone(world.width, world.height, 0.40, 0.999);
  // Alarm pheromone (Hölldobler & Wilson 1990 Ch. 7). Fast diffuse
  // (signal needs to spread quickly) + short half-life (~50 ticks
  // = ~6 sec biological — alarm is volatile so it doesn't lock the
  // colony into yesterday's emergency). Emitted by CARRY and
  // CARRY_FOOD ants when their tryStep returns hitSoil — i.e. they
  // have a destination they can't reach. Read by WANDER ants for
  // gradient-following AND by the Sudd dig gate as a bypass.
  const alarmField = new Pheromone(world.width, world.height, 0.50, 0.985);
  // Queen pheromone. Slow diffuse + very long half-life — non-
  // volatile cuticular signal that defines "this is the broodpile".
  // Emitted by the queen at her cell each tick; followed by young
  // (nurse-caste) WANDER workers. With this in place, attendant
  // workers reliably congregate near the queen, supplying the
  // trophallactic bouts that keep her energy above the lay
  // threshold even in long-running sessions.
  const queenField = new Pheromone(world.width, world.height, 0.10, 0.9999);
  // Brood pheromone (Cassill 2002; Slipinski et al. 2006). Larvae
  // emit a hunger-call signal distinct from queen pheromone. Since
  // brood thermoregulation drifts larvae away from the queen, a
  // separate field ensures nurses still find the broodpile.
  // Faster decay than queen so the gradient tracks the larvae as
  // they migrate with daylight.
  const broodField = new Pheromone(world.width, world.height, 0.20, 0.999);
  // Necromone (Wilson, Durlach & Roth 1958). Oleic-acid analog
  // emitted continuously by corpse cells. Necrophoresis-eligible
  // workers bias toward the gradient as pickup recruitment.
  const necroField = new Pheromone(world.width, world.height, 0.30, 0.99);
  // No-entry pheromone (Robinson, Jackson, Holcombe & Ratnieks
  // 2005). Workers who've been wandering unproductively deposit a
  // "skip me" mark; other WANDER ants bias AWAY from the gradient.
  // Slow diffuse + medium retention so dead-end markers persist
  // through the area without instantly bleeding everywhere.
  const noEntryField = new Pheromone(world.width, world.height, 0.05, 0.9995);
  // Granary marker (Tschinkel 2004). CARRY_FOOD deposits set this
  // field; descending CARRY_FOOD ants bias toward established
  // granaries so seed caches consolidate at consistent depths
  // rather than scattering by RNG.
  const granaryField = new Pheromone(world.width, world.height, 0.10, 0.9999);
  // Trunk trail. Persistent long-half-life version of the foraging
  // trail. Built up over many trips to the same food patch; lets
  // foragers re-find a stable resource even after the volatile
  // trailField has decayed between expeditions.
  const trunkField = new Pheromone(world.width, world.height, 0.20, 0.99995);

  // Capacity = species cap, so brood production has slots to fill.
  const colony = new Colony(HARVESTER.maxColonySize);
  const cx = world.width >> 1;
  // Pack as many founders as will reasonably fit into the pinhole +
  // terminal pocket; scatter the rest on the surface a few cells to
  // either side of the entrance. This mirrors the natural founding
  // picture: a few ants down the shaft + foragers milling on the
  // surface, all about to discover the existing void. Geometry must
  // match world.generate's pinhole.
  // Pinhole geometry must match world.generate (cells, scaled with
  // cell size). Physical dimensions: 30 mm shaft × 15 mm pocket.
  const SHAFT_DEPTH = 10;
  const POCKET_HALF = 2;
  const POCKET_HEIGHT = 4;
  // Pack density is in ants per cell. 1 ant/cell at the new finer
  // resolution = same physical density as 4 ants/cell at the old
  // 6-mm/cell scale (since each old cell is 4 new cells).
  const PACK_DENSITY = 1;
  const surfHere = world.naturalSurface[cx]!;
  // Queen: spawned first, parked at the deepest carved cell (the
  // pocket bottom). Hölldobler & Wilson (1990) Ch. 5: the founding
  // queen excavates her shaft, lays the first eggs, and stays in the
  // chamber thereafter. We seed one queen no matter the requested
  // ant count; the requested count then becomes the founder workforce.
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
    world.cells[world.index(x, y)] === 0 /* AIR */;
  const placedInPinhole = colony.spawnInRect(
    cx - POCKET_HALF,
    surfHere,
    cx + POCKET_HALF,
    surfHere + SHAFT_DEPTH + POCKET_HEIGHT - 1,
    pinholeCap,
    rng,
    isAir,
    DEFAULT_PARAMS,
  );
  // Surface scatter for the remainder. Place them in an air row
  // safely above the wavy natural surface in a band centred on the
  // entrance; physics gravity-settles each onto its own column's
  // ground in a few ticks.
  const remaining = s.ants - placedInPinhole;
  if (remaining > 0) {
    // Scale scatter band by colony size to keep spawn density roughly
    // constant (~3 ants per surface cell). Default 100 ants → 21-cell
    // band; 500 ants → 153-cell band. Without scaling, packing 500
    // ants into a 21-cell band hit immediate collision overload and
    // pinned >90% of the colony in REST permanently — observed at
    // t=240k diag, the colony survived but never built anything.
    // Density is per-cell. With 3 mm/cell, 1 ant/cell still gives
    // ~3 ant body widths' clearance per ant on a single row. Min
    // half-band 20 cells = 60 mm, matching the old 10-cell × 6-mm
    // physical band.
    const TARGET_SCATTER_DENSITY = 1;
    const SCATTER_HALF = Math.max(
      20,
      Math.min(
        Math.floor((world.width - 1) / 2),
        Math.ceil(remaining / (2 * TARGET_SCATTER_DENSITY)),
      ),
    );
    let topRow = world.height;
    for (let x = Math.max(0, cx - SCATTER_HALF); x <= Math.min(world.width - 1, cx + SCATTER_HALF); x++) {
      if (world.naturalSurface[x]! < topRow) topRow = world.naturalSurface[x]!;
    }
    const scatterY = Math.max(0, topRow - 1);
    colony.spawnInRect(
      Math.max(0, cx - SCATTER_HALF),
      scatterY,
      Math.min(world.width - 1, cx + SCATTER_HALF),
      scatterY,
      remaining,
      rng,
      isAir,
      DEFAULT_PARAMS,
    );
  }
  // Seed worker age distribution. Real colonies have continuous brood
  // production → workers span every age class at once; we now have
  // brood production, but at t=0 the founder workforce all spawns as
  // adults so we still seed ages uniformly across [0, 1.5×matureAge]
  // to give a starting age spread. Skip queen + eggs — queen is
  // ageless for our purposes and eggs use stateTicks not age.
  for (let i = 0; i < colony.count; i++) {
    if (colony.state[i] !== 0 /* STATE_WANDER */) continue;
    colony.age[i] = (rng.next() * HARVESTER.matureAge * 1.5) | 0;
  }
  // Try restoring a saved snapshot now that fresh world+colony+
  // pheromone+rng instances exist. restoreSnapshot validates that
  // the save matches the current settings (seed/width/height/
  // capacity); on mismatch we keep the freshly-built scenario.
  const saved = readSavedBlob();
  if (saved) {
    const ok = restoreSnapshot(
      saved,
      { seed: s.seed, width: s.width, height: s.height },
      world, colony, digField, buildField, trailField, alarmField, queenField,
      broodField, necroField, noEntryField, granaryField, trunkField, rng,
    );
    if (ok) {
      // eslint-disable-next-line no-console
      console.log(`[formicarium] restored from save at tick ${world.tick.toLocaleString()}`);
    }
  }
  return {
    rng, world, colony, digField, buildField, trailField, alarmField, queenField,
    broodField, necroField, noEntryField, granaryField, trunkField,
  };
}

function main(): void {
  const settings = readSettings();
  let {
    rng, world, colony, digField, buildField, trailField, alarmField, queenField,
    broodField, necroField, noEntryField, granaryField, trunkField,
  } = build(settings);

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const help = document.getElementById('help') as HTMLDivElement;
  const renderer = new Renderer(canvas, world);
  const particles = new ParticleSystem(256);

  // Auto-hide the help panel after a few seconds so it doesn't clutter
  // the screensaver indefinitely. The `?` key brings it back.
  let helpHideTimer: number | undefined = window.setTimeout(() => {
    help.classList.add('hidden');
  }, 6000);

  const onResize = () => renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  onResize();

  // Camera (zoom + pan) handling. Pinch on mobile, wheel on desktop,
  // single-pointer drag to pan when zoomed in. We can't rely on
  // browser-native pinch-zoom — it scales the page chrome (HUD,
  // sparkline) and reflows the canvas to a smaller pixel size; the
  // simulation has to own its own camera.
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 6;
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let pinchAnchor = { x: 0, y: 0 };
  let panLastX = 0;
  let panLastY = 0;
  const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const zoomAtPoint = (newZoom: number, sx: number, sy: number) => {
    const zClamped = clampZoom(newZoom);
    const old = renderer.zoom;
    if (zClamped === old) return;
    // Anchor: keep the world point under (sx, sy) fixed across the
    // zoom change. Adjust pan so that screenToWorld at (sx, sy) maps
    // to the same world coordinate before and after.
    const before = renderer.screenToWorld(sx, sy);
    renderer.zoom = zClamped;
    const after = renderer.screenToWorld(sx, sy);
    // shift in WORLD cells; convert back to viewport CSS pixels.
    const cw = canvas.width;
    const w = world.width;
    const h = world.height;
    const ch = canvas.height;
    const dpr = cw / parseFloat(canvas.style.width || `${cw}`);
    const baseScale = Math.min(cw / w, ch / h);
    const scale = baseScale * renderer.zoom;
    renderer.panX += (after.x - before.x) * scale / dpr;
    renderer.panY += (after.y - before.y) * scale / dpr;
    if (renderer.zoom === 1) { renderer.panX = 0; renderer.panY = 0; }
    renderer.clampPan();
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 1-step click of a typical mouse wheel ≈ 100 px; pinch trackpads
    // emit much smaller deltas. Multiply by a gentle factor.
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAtPoint(renderer.zoom * factor, e.clientX, e.clientY);
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      panLastX = e.clientX;
      panLastY = e.clientY;
    } else if (activePointers.size === 2) {
      const [a, b] = Array.from(activePointers.values());
      pinchStartDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      pinchStartZoom = renderer.zoom;
      pinchAnchor = { x: (a!.x + b!.x) * 0.5, y: (a!.y + b!.y) * 0.5 };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1 && renderer.zoom > 1.001) {
      // Drag to pan only when zoomed in. At zoom=1 the world fills
      // the screen and panning would just push it off-edge.
      renderer.panX += e.clientX - panLastX;
      renderer.panY += e.clientY - panLastY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      renderer.clampPan();
    } else if (activePointers.size === 2) {
      const [a, b] = Array.from(activePointers.values());
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchStartDist > 0) {
        const ratio = dist / pinchStartDist;
        zoomAtPoint(pinchStartZoom * ratio, pinchAnchor.x, pinchAnchor.y);
      }
    }
  });
  const onPointerEnd = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStartDist = 0;
    if (activePointers.size === 1) {
      const [p] = Array.from(activePointers.values());
      panLastX = p!.x; panLastY = p!.y;
    }
  };
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);

  let paused = false;
  // Speed is a multiplier on realtime: 1× means one tick of bio
  // time per 120 ms wall, 2× means two ticks per 120 ms, etc. Range
  // [0.125, 1024]. The frame loop uses a wall-time accumulator so
  // visual ant motion looks correct at any multiplier — at 1× a
  // forager covers 30 mm/sec on screen exactly as in real biology.
  let speedMul = settings.simStepsPerFrame; // ?speed=N URL param maps to multiplier
  let lastHud = 0;
  // Cached "any live ants?" check, refreshed each HUD update so we
  // don't scan the colony every render frame. When the colony goes
  // fully extinct (queen + all workers + all brood dead), the sim
  // pauses — there's nothing left to step. The user can reseed (`r`
  // key) for a fresh colony.
  let extinct = false;

  // Action map — single source of truth for keyboard AND on-screen
  // controls. Mobile users have no keyboard, so the button cluster
  // in index.html dispatches via the same names.
  const actions: Record<string, () => void> = {
    pause: () => { paused = !paused; },
    faster: () => { speedMul = Math.min(1024, speedMul * 2); },
    slower: () => { speedMul = Math.max(0.125, speedMul / 2); },
    help: () => {
      help.classList.toggle('hidden');
      if (helpHideTimer !== undefined) {
        window.clearTimeout(helpHideTimer);
        helpHideTimer = undefined;
      }
    },
    zoomout: () => { renderer.zoom = 1; renderer.panX = 0; renderer.panY = 0; },
    full: () => {
      // Browsers require fullscreen requests to be tied to a user
      // gesture — both keydown and click qualify.
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    },
    phero: () => { renderer.showPheromones = !renderer.showPheromones; },
    reseed: () => {
      // Manual reseed clears the saved snapshot — otherwise the next
      // build() call on the new seed would still try to restore from
      // the stale (different-seed) blob, fail the seed check, and
      // silently fall through to a fresh sim. Clearing here keeps the
      // intent ("user wants a new run") and the behaviour ("nothing
      // restores from disk") aligned.
      clearSavedSnapshot();
      const s2 = { ...settings, seed: (settings.seed * 16807 + 1) >>> 0 };
      // Update settings.seed in place so the auto-save loop captures
      // snapshots under the new seed (and the next page-load restore
      // matches the new seed too).
      settings.seed = s2.seed;
      const built = build(s2);
      rng = built.rng;
      world = built.world;
      colony = built.colony;
      digField = built.digField;
      buildField = built.buildField;
      trailField = built.trailField;
      alarmField = built.alarmField;
      queenField = built.queenField;
      broodField = built.broodField;
      necroField = built.necroField;
      noEntryField = built.noEntryField;
      granaryField = built.granaryField;
      trunkField = built.trunkField;
      renderer.setWorld(world);
      // Clear extinction flag — fresh colony, sim runs again.
      extinct = false;
    },
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') { actions.pause!(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') actions.faster!();
    else if (e.key === '-' || e.key === '_') actions.slower!();
    else if (e.key === '?') actions.help!();
    else if (e.key === '0') actions.zoomout!();
    else if (e.key === 'f') actions.full!();
    else if (e.key === 'p') actions.phero!();
    else if (e.key === 'r') actions.reseed!();
  });

  // Wire the on-screen button cluster (index.html #ctrls). Each
  // button has a data-act attribute that names the action above.
  const ctrls = document.getElementById('ctrls') as HTMLDivElement | null;
  if (ctrls) {
    ctrls.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t?.dataset?.act;
      if (act && actions[act]) actions[act]!();
    });
  }

  // Periodic snapshot to localStorage so a tab refresh / OS restart
  // resumes near where it left off rather than starting a brand new
  // colony. 30 sec wall is well under the typical browser tab lifetime
  // and short enough that a crashed tab loses at most ~30 s of work,
  // but long enough that the JSON encode + base64 cost (~10 ms at
  // default world size) doesn't show up in a frame budget. The save
  // is best-effort: a quota error or missing localStorage just no-
  // ops, and we never block the sim on the I/O.
  const AUTO_SAVE_MS = 30_000;
  const autoSaveTimer = window.setInterval(() => {
    const blob = captureSnapshot(
      world, colony, digField, buildField, trailField, alarmField, queenField,
      broodField, necroField, noEntryField, granaryField, trunkField, rng,
      { seed: settings.seed, width: settings.width, height: settings.height },
    );
    if (blob !== null) saveToLocalStorage(blob);
  }, AUTO_SAVE_MS);
  // Also flush on tab close/visibility change — losing the last 30 s
  // of activity to a closed-laptop is jarring when the cost of saving
  // is negligible. visibilitychange fires reliably on tab background;
  // beforeunload is a belt-and-braces extra hook.
  const flushSnapshot = () => {
    const blob = captureSnapshot(
      world, colony, digField, buildField, trailField, alarmField, queenField,
      broodField, necroField, noEntryField, granaryField, trunkField, rng,
      { seed: settings.seed, width: settings.width, height: settings.height },
    );
    if (blob !== null) saveToLocalStorage(blob);
  };
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSnapshot();
  });
  window.addEventListener('beforeunload', flushSnapshot);
  void autoSaveTimer;

  let last = performance.now();
  let alpha = 0;
  // Wall-time accumulator. 1 sim tick = 120 ms of biological time
  // (the calibration anchor — see species.ts comments). At
  // speedMul=1 we want exactly that wall:bio mapping, so each ms
  // of wall time advances the accumulator by 1 ms (then we step
  // every time it crosses 120 ms). Higher speedMul scales accum
  // proportionally: at 8× we step 8 times per 120 ms wall.
  const TICK_MS = 120;
  let bioAccum = 0;
  // Hard cap on ticks-per-frame to prevent spiral-of-death after a
  // tab-backgrounded long pause. 4096 ticks per frame at 30 fps is
  // ~120k ticks/sec → ~14 sec biological per sec wall, plenty.
  const MAX_TICKS_PER_FRAME = 4096;
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;

    if (!paused && !extinct) {
      bioAccum += dt * speedMul;
      let budget = MAX_TICKS_PER_FRAME;
      while (bioAccum >= TICK_MS && budget > 0) {
        step(
          world, colony, digField, buildField, rng, DEFAULT_PARAMS, particles, HARVESTER,
          trailField, alarmField, queenField,
          broodField, necroField, noEntryField, granaryField, trunkField,
        );
        bioAccum -= TICK_MS;
        budget--;
      }
      // If we hit the per-frame cap, drop residual accumulator so
      // we don't spiral on the next frame.
      if (budget === 0) bioAccum = 0;
      alpha = 1;
    }

    const day = daylight(world.tick);
    renderer.render(colony, alpha, particles, { dig: digField, build: buildField, trail: trailField, alarm: alarmField, queen: queenField }, day);

    if (now - lastHud > 250) {
      lastHud = now;
      const dugTotal = world.initialSoilCells - world.countSoil();
      const grains = world.countGrains();
      let foodCount = 0;
      for (let i = 0; i < world.food.length; i++) if (world.food[i]! > 0) foodCount++;
      let dead = 0;
      let eggs = 0;
      let larvae = 0;
      let queens = 0;
      for (let i = 0; i < colony.count; i++) {
        const s = colony.state[i];
        if (s === STATE_DEAD) dead++;
        else if (s === STATE_EGG) eggs++;
        else if (s === STATE_LARVA) larvae++;
        else if (s === STATE_QUEEN) queens++;
      }
      const alive = colony.count - dead;
      // Extinction detection. If alive == 0 (no queen, no workers,
      // no brood — anything that consumes resources or could
      // re-establish), pause the sim. Brood-only states wouldn't
      // recover either since brood needs trophallaxis from
      // workers, so we treat full death as terminal.
      if (alive === 0 && !extinct) extinct = true;
      // start = the founder colony at t=0 (queen + initial workers
      // requested via ?ants). After that, born tracks egg→worker
      // hatches and died tracks every transition into STATE_DEAD,
      // so alive = start + born - died holds as an invariant.
      const start = settings.ants + 1;
      // Nest geometry: nestVol = AIR cells below each column's natural
      // surface (per-column to honour the wave); maxDepth = deepest
      // such cell measured from its own surface row. O(W×H) but only
      // every 250 ms.
      let nestVol = 0;
      let maxDepth = 0;
      const wW = world.width;
      const wH = world.height;
      const surfRow = world.naturalSurface;
      const cells = world.cells;
      for (let y = 0; y < wH; y++) {
        for (let x = 0; x < wW; x++) {
          if (cells[y * wW + x] !== 0 /* AIR */) continue;
          const sy = surfRow[x]!;
          if (y < sy) continue;
          nestVol++;
          const d = y - sy;
          if (d > maxDepth) maxDepth = d;
        }
      }
      // Convert ticks to biological time. Calibration anchor is
      // 1 tick ≈ 120 ms biological (walkSpeed × cellSize matches
      // Pogonomyrmex forager 30 mm/sec — see species.ts comment).
      // Format as days/hours/minutes for readable session duration.
      const bioSecs = world.tick * 0.12;
      const bioDays = Math.floor(bioSecs / 86400);
      const bioHours = Math.floor((bioSecs / 3600) % 24);
      const bioMins = Math.floor((bioSecs / 60) % 60);
      const bioSecsR = Math.floor(bioSecs % 60);
      const bioTime = bioDays > 0
        ? `${bioDays}d ${bioHours}h ${bioMins}m`
        : bioHours > 0
          ? `${bioHours}h ${bioMins}m ${bioSecsR}s`
          : `${bioMins}m ${bioSecsR}s`;
      // Day-night phase label. The `daylight` curve in world.ts is
      // sinusoidal with 0 at midnight, 1 at noon; we discretise into
      // four named phases so the HUD reads as a clock label rather
      // than a percentage. tick=0 corresponds to solar midnight.
      const dayPhase = (world.tick % 720000) / 720000; // [0, 1)
      const phaseLabel =
        dayPhase < 0.20 ? 'night'
          : dayPhase < 0.30 ? 'dawn'
            : dayPhase < 0.45 ? 'morning'
              : dayPhase < 0.55 ? 'noon'
                : dayPhase < 0.70 ? 'afternoon'
                  : dayPhase < 0.80 ? 'dusk'
                    : 'night';
      hud.textContent =
        `formicarium · ${HARVESTER.commonName} · seed 0x${settings.seed.toString(16)}` +
        `  ·  ${world.width}×${world.height}` +
        `  ·  ants ${alive} (start ${start}, +${world.totalBorn} born, −${world.totalDied} died)` +
        `  ·  Q ${queens} eggs ${eggs} larvae ${larvae}` +
        `  ·  t=${world.tick.toLocaleString()} (${bioTime}, ${phaseLabel})` +
        `  ·  dug ${dugTotal}  grains ${grains}  food ${foodCount}` +
        `  ·  nest ${nestVol} (depth ${maxDepth})` +
        `  ·  speed ${speedMul >= 1 ? speedMul.toFixed(0) : speedMul.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}×${paused ? '  ·  PAUSED' : ''}${extinct ? '  ·  EXTINCT — press r to reseed' : ''}` +
        `  ·  ${(1000 / Math.max(1, dt)).toFixed(0)} fps`;
    }
  };
  requestAnimationFrame(frame);
}

main();
