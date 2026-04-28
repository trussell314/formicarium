// Entry point. Spawns the simulation in a worker thread so the
// render loop (rAF, 60Hz) stays smooth even at high speed
// multipliers. URL params:
//   ?seed=N       fixed RNG seed (otherwise time-derived)
//   ?speed=N      realtime multiplier (default 1; 1× = realtime)
//   ?ants=N       initial ant count
//   ?width=N      world width (cells)
//   ?height=N     world height (cells)

import {
  clearSavedSnapshot, readSavedBlob, saveToLocalStorage,
} from './sim/persist';
import { Renderer } from './render/renderer';
import type { FromWorker, RenderSnapshot, ToWorker } from './worker/protocol';
import SimWorker from './worker/sim-worker?worker';

interface Settings {
  seed: number;
  width: number;
  height: number;
  ants: number;
  /** Realtime speed multiplier — 1× = wall:bio identity. */
  speedMul: number;
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
    width: Math.max(40, num('width', 280) | 0),
    height: Math.max(30, num('height', 140) | 0),
    ants: Math.max(0, num('ants', 50) | 0),
    speedMul: Math.max(0.125, num('speed', 8)),
  };
}

function makePlaceholderWorld(s: Settings): {
  width: number; height: number; tick: number;
  cells: Uint8Array; soilNoise: Uint8Array;
  naturalSurface: Uint16Array;
  food: Uint8Array; foodMoves: Uint8Array;
  corpse: Uint8Array; sprout: Uint8Array; sproutTick: Int32Array;
  digTick: Int32Array;
} {
  // Renderer needs SOMETHING at construction time, before the
  // worker has produced its first snapshot. Empty arrays of the
  // right shape are sufficient — first render will use the real
  // snapshot.
  const sz = s.width * s.height;
  return {
    width: s.width, height: s.height, tick: 0,
    cells: new Uint8Array(sz),
    soilNoise: new Uint8Array(sz),
    naturalSurface: new Uint16Array(s.width),
    food: new Uint8Array(sz), foodMoves: new Uint8Array(sz),
    corpse: new Uint8Array(sz),
    sprout: new Uint8Array(sz), sproutTick: new Int32Array(sz),
    digTick: new Int32Array(sz),
  };
}

function main(): void {
  const settings = readSettings();

  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  // Build the static HUD scaffold once. Rows are addressed by id
  // (.v elements) and updated each render frame by writing
  // textContent — much cheaper than re-parsing the whole HUD HTML
  // every 250 ms, and it preserves the minimise toggle state across
  // updates.
  hud.innerHTML = `
    <button id="hud-min" title="minimise / restore">−</button>
    <div class="row hdr"><span>FORMICARIUM</span><span class="v" id="h-seed"></span></div>
    <div class="row"><span>colony</span><span class="v" id="h-colony"></span></div>
    <div class="row"><span>brood</span><span class="v" id="h-brood"></span></div>
    <div class="row"><span>nest</span><span class="v" id="h-nest"></span></div>
    <div class="row"><span>resources</span><span class="v" id="h-res"></span></div>
    <div class="row"><span>time</span><span class="v" id="h-time"></span></div>
    <div class="row"><span>speed</span><span class="v" id="h-speed"></span></div>
    <div class="row dim"><span>render</span><span class="v" id="h-fps"></span></div>
    <div class="legend" id="h-legend">
      <div><span class="swatch" style="background:#00dcdc"></span>dig</div>
      <div><span class="swatch" style="background:#dc00dc"></span>build</div>
      <div><span class="swatch" style="background:#f0dc3c"></span>trail</div>
      <div><span class="swatch" style="background:#ff1e1e"></span>alarm</div>
      <div><span class="swatch" style="background:#6e46c8"></span>queen</div>
      <div><span class="swatch" style="background:#ffb4b4"></span>brood</div>
      <div><span class="swatch" style="background:#8c8232"></span>necromone</div>
      <div><span class="swatch" style="background:#8c96aa"></span>no-entry</div>
      <div><span class="swatch" style="background:#ffa03c"></span>granary</div>
      <div><span class="swatch" style="background:#c8aa1e"></span>trunk</div>
    </div>
  `;
  const hudEls = {
    seed: document.getElementById('h-seed')!,
    colony: document.getElementById('h-colony')!,
    brood: document.getElementById('h-brood')!,
    nest: document.getElementById('h-nest')!,
    res: document.getElementById('h-res')!,
    time: document.getElementById('h-time')!,
    speed: document.getElementById('h-speed')!,
    fps: document.getElementById('h-fps')!,
  };
  const hudMinBtn = document.getElementById('hud-min')!;
  hudMinBtn.addEventListener('click', () => {
    hud.classList.toggle('minimized');
    hudMinBtn.textContent = hud.classList.contains('minimized') ? '+' : '−';
  });
  const help = document.getElementById('help') as HTMLDivElement;
  const renderer = new Renderer(canvas, makePlaceholderWorld(settings));

  let helpHideTimer: number | undefined = window.setTimeout(() => {
    help.classList.add('hidden');
  }, 6000);

  const onResize = () => renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  onResize();

  // ── Worker setup ───────────────────────────────────────────
  const worker = new SimWorker();
  const send = (msg: ToWorker) => {
    worker.postMessage(msg);
  };

  // Most-recent snapshot from the worker. Render loop reads this;
  // the worker overwrites it whenever a fresh snapshot arrives.
  let latest: RenderSnapshot | null = null;
  let snapshotPending = false;
  let extinct = false;
  // We track the "requested" speed (what the user asked for) and
  // the "effective" speed (what the worker actually delivered, by
  // measuring tick-rate) so the HUD can show the user when they're
  // CPU-bound. Updated in the snapshot handler below.
  let requestedSpeed = settings.speedMul;
  let lastTickAtMs = performance.now();
  let lastTickValue = 0;
  let measuredTicksPerSec = 0;

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    switch (msg.kind) {
      case 'ready':
        // Initial init or reseed completed — request the first
        // snapshot to get the render loop started.
        send({ kind: 'requestSnapshot', includePheromones: renderer.showPheromones });
        snapshotPending = true;
        break;
      case 'snapshot': {
        latest = msg.snap;
        snapshotPending = false;
        if (msg.snap.extinct) extinct = true;
        // Tick-rate measurement: ticks since previous snapshot ÷
        // wall ms since previous snapshot. Smooth with EMA.
        const now = performance.now();
        const dt = now - lastTickAtMs;
        const dTicks = msg.snap.tick - lastTickValue;
        if (dt > 0 && dTicks >= 0) {
          const instantTps = (dTicks * 1000) / dt;
          measuredTicksPerSec = measuredTicksPerSec === 0
            ? instantTps
            : measuredTicksPerSec * 0.85 + instantTps * 0.15;
        }
        lastTickAtMs = now;
        lastTickValue = msg.snap.tick;
        break;
      }
      case 'savedBlob':
        if (msg.blob !== null) saveToLocalStorage(msg.blob);
        break;
    }
  };

  // Init the worker. If localStorage has a save matching the
  // current settings, the worker will restore from it.
  send({
    kind: 'init',
    settings: { ...settings },
    restoreBlob: readSavedBlob(),
  });
  send({ kind: 'setSpeed', speedMul: settings.speedMul });

  // ── Camera (zoom + pan) ────────────────────────────────────
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
    const before = renderer.screenToWorld(sx, sy);
    renderer.zoom = zClamped;
    const after = renderer.screenToWorld(sx, sy);
    const cw = canvas.width;
    const w = settings.width;
    const h = settings.height;
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
  let lastHud = 0;

  const actions: Record<string, () => void> = {
    pause: () => {
      paused = !paused;
      send({ kind: paused ? 'pause' : 'resume' });
    },
    faster: () => {
      requestedSpeed = Math.min(1024, requestedSpeed * 2);
      send({ kind: 'setSpeed', speedMul: requestedSpeed });
    },
    slower: () => {
      requestedSpeed = Math.max(0.125, requestedSpeed / 2);
      send({ kind: 'setSpeed', speedMul: requestedSpeed });
    },
    help: () => {
      help.classList.toggle('hidden');
      if (helpHideTimer !== undefined) {
        window.clearTimeout(helpHideTimer);
        helpHideTimer = undefined;
      }
    },
    zoomout: () => { renderer.zoom = 1; renderer.panX = 0; renderer.panY = 0; },
    full: () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    },
    phero: () => { renderer.showPheromones = !renderer.showPheromones; },
    reseed: () => {
      clearSavedSnapshot();
      settings.seed = (settings.seed * 16807 + 1) >>> 0;
      send({ kind: 'reseed', settings: { ...settings } });
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

  const ctrls = document.getElementById('ctrls') as HTMLDivElement | null;
  if (ctrls) {
    ctrls.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t?.dataset?.act;
      if (act && actions[act]) actions[act]!();
    });
  }

  // Auto-save every 30 sec wall (and on visibility-hidden /
  // beforeunload). The worker captures the snapshot; we hand off
  // to localStorage. Captures are async (cross-thread) so we don't
  // get a synchronous answer on beforeunload — best-effort.
  const AUTO_SAVE_MS = 30_000;
  window.setInterval(() => {
    send({ kind: 'captureForSave' });
  }, AUTO_SAVE_MS);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send({ kind: 'captureForSave' });
  });
  window.addEventListener('beforeunload', () => send({ kind: 'captureForSave' }));

  // ── Render loop ─────────────────────────────────────────────
  let last = performance.now();
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;

    // Drive the worker by requesting a fresh snapshot. The worker
    // handles its own bio-time accumulation and stepping budget;
    // we just pull a new render frame each rAF.
    if (!paused && !extinct && !snapshotPending) {
      send({ kind: 'requestSnapshot', includePheromones: renderer.showPheromones });
      snapshotPending = true;
    }

    if (latest) {
      const snap = latest;
      // The renderer's bound world points at the placeholder; on
      // every frame we feed the snapshot's array views in via
      // setWorld so the renderer reads the freshest data.
      renderer.setWorld(snap);
      const colony = {
        count: snap.count,
        posX: snap.posX, posY: snap.posY,
        prevX: snap.prevX, prevY: snap.prevY,
        heading: snap.heading,
        state: snap.state,
        energy: snap.energy,
      };
      const pheromones = snap.pheromones === null ? undefined : {
        dig: { current: snap.pheromones.dig },
        build: { current: snap.pheromones.build },
        trail: { current: snap.pheromones.trail },
        alarm: { current: snap.pheromones.alarm },
        queen: { current: snap.pheromones.queen },
        brood: { current: snap.pheromones.brood },
        necro: { current: snap.pheromones.necro },
        noEntry: { current: snap.pheromones.noEntry },
        granary: { current: snap.pheromones.granary },
        trunk: { current: snap.pheromones.trunk },
      };
      const particles = snap.particles ?? undefined;
      renderer.render(colony, 1, particles, pheromones, snap.daylight);
    }

    if (latest && now - lastHud > 250) {
      lastHud = now;
      const snap = latest;
      const start = settings.ants + 1;
      const dugTotal = snap.cells.length - snap.hud.soilCount - snap.hud.grains;
      const bioSecs = snap.tick * 0.12;
      const bioDays = Math.floor(bioSecs / 86400);
      const bioHours = Math.floor((bioSecs / 3600) % 24);
      const bioMins = Math.floor((bioSecs / 60) % 60);
      const bioSecsR = Math.floor(bioSecs % 60);
      const bioTime = bioDays > 0
        ? `${bioDays}d ${bioHours}h ${bioMins}m`
        : bioHours > 0
          ? `${bioHours}h ${bioMins}m ${bioSecsR}s`
          : `${bioMins}m ${bioSecsR}s`;
      const dayPhase = (snap.tick % 720000) / 720000;
      const phaseLabel =
        dayPhase < 0.20 ? 'night'
          : dayPhase < 0.30 ? 'dawn'
            : dayPhase < 0.45 ? 'morning'
              : dayPhase < 0.55 ? 'noon'
                : dayPhase < 0.70 ? 'afternoon'
                  : dayPhase < 0.80 ? 'dusk'
                    : 'night';
      // Effective speed = measured ticks/sec × 120 ms/tick / 1000.
      const effective = (measuredTicksPerSec * 120) / 1000;
      const renderFps = (1000 / Math.max(1, dt)).toFixed(0);
      const speedDisplay = (() => {
        const fmt = (x: number) =>
          x >= 10 ? x.toFixed(0) :
          x >= 1 ? x.toFixed(1) :
          x.toFixed(2);
        if (Math.abs(effective - requestedSpeed) / Math.max(0.001, requestedSpeed) < 0.10) {
          return `${fmt(requestedSpeed)}×`;
        }
        return `${fmt(requestedSpeed)}× (effective ${fmt(effective)}×)`;
      })();
      hudEls.seed.textContent =
        `0x${settings.seed.toString(16)} · ${snap.width}×${snap.height}`;
      hudEls.colony.textContent =
        `${snap.hud.alive} alive (start ${start}, +${snap.hud.totalBorn} −${snap.hud.totalDied})`;
      hudEls.brood.textContent =
        `Q ${snap.hud.queens} · ${snap.hud.eggs} eggs · ${snap.hud.larvae} larvae`;
      hudEls.nest.textContent =
        `${snap.hud.nestVol} cells · depth ${snap.hud.maxDepth} · dug ${dugTotal}`;
      hudEls.res.textContent =
        `${snap.hud.grains} grains · ${snap.hud.foodCount} seeds`;
      hudEls.time.textContent =
        `t=${snap.tick.toLocaleString()} · ${bioTime} · ${phaseLabel}`;
      const flag = paused ? ' · PAUSED' : extinct ? ' · EXTINCT — press r' : '';
      hudEls.speed.textContent = speedDisplay + flag;
      hudEls.fps.textContent = `${renderFps} fps`;
    }
  };
  requestAnimationFrame(frame);
}

main();
