// Entry point. Spawns the simulation in a worker thread so the
// render loop (rAF, 60Hz) stays smooth even at high speed
// multipliers. URL params:
//   ?seed=N       fixed RNG seed (otherwise time-derived)
//   ?speed=N      realtime multiplier (default 1; 1× = realtime)
//   ?ants=N       initial ant count
//   ?width=N      world width (cells)
//   ?height=N     world height (cells)

import {
  STATE_CARRY, STATE_CARRY_FOOD, STATE_DEAD, STATE_EGG, STATE_FORAGE, STATE_LARVA,
  STATE_NECRO_CARRY, STATE_QUEEN, STATE_REST, STATE_WANDER,
} from './sim/colony';
import {
  clearSavedSnapshot, readSavedBlob, saveToLocalStorage,
} from './sim/persist';
import { DAY_TICKS, SECONDS_PER_TICK_BIO, TICK_MS } from './sim/world';
import { Renderer } from './render/renderer';
import type { FromWorker, RenderSnapshot, ToWorker } from './worker/protocol';
import SimWorker from './worker/sim-worker?worker';

interface Settings {
  seed: number;
  width: number;
  height: number;
  ants: number;
  /** Wall-clock tick-rate multiplier — independent of biology. 1× =
   *  one wall-tick per TICK_MS ms; higher = more sim CPU per real
   *  second; visually faster animation. */
  speedMul: number;
  /** When true, enable burn-in-prevention drift in the renderer
   *  AND hide the HUD/controls/help overlays so the visible canvas
   *  is just the simulation. Intended for use as a screensaver or
   *  always-on desktop background. URL param: ?screensaver=1. */
  screensaver: boolean;
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
    width: Math.max(40, num('width', 400) | 0),
    height: Math.max(30, num('height', 250) | 0),
    ants: Math.max(0, num('ants', 0) | 0),
    speedMul: Math.max(0.125, num('speed', 8)),
    screensaver: p.get('screensaver') === '1',
  };
}

function makePlaceholderWorld(s: Settings): {
  width: number; height: number; tick: number;
  cells: Uint8Array; soilNoise: Uint8Array;
  naturalSurface: Uint16Array;
  food: Uint8Array; foodMoves: Uint8Array;
  corpse: Uint8Array; sprout: Uint8Array; sproutTick: Int32Array;
  digTick: Int32Array;
  plant: Uint8Array;
  plantHeight: Uint16Array;
  bgPlant: Uint8Array;
  bgPlantHeight: Uint16Array;
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
    plant: new Uint8Array(s.width),
    plantHeight: new Uint16Array(s.width),
    bgPlant: new Uint8Array(s.width),
    bgPlantHeight: new Uint16Array(s.width),
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
    <div class="row hdr-mini"><span class="v" id="h-mini"></span></div>
    <div class="row"><span>colony</span><span class="v" id="h-colony"></span></div>
    <div class="row"><span>brood</span><span class="v" id="h-brood"></span></div>
    <div class="row"><span>nest</span><span class="v" id="h-nest"></span></div>
    <div class="row"><span>resources</span><span class="v" id="h-res"></span></div>
    <div class="row"><span>time</span><span class="v" id="h-time"></span></div>
    <div class="row"><span>speed</span><span class="v" id="h-speed"></span></div>
    <div class="row"><span>states</span><span class="v" id="h-states"></span></div>
    <div class="row"><span>age</span><span class="v"><span class="histo-label" id="h-age-lbl">young → old</span><canvas class="histo" id="h-age-cv" width="120" height="14"></canvas></span></div>
    <div class="row"><span>energy</span><span class="v"><span class="histo-label" id="h-energy-lbl">low → full</span><canvas class="histo" id="h-energy-cv" width="120" height="14"></canvas></span></div>
    <div class="row sel hidden" id="h-sel-row"><span>selected</span><span class="v" id="h-sel"></span></div>
    <div class="row dim"><span>render</span><span class="v" id="h-fps"></span></div>
    <div class="pop-graph" id="h-pop-graph">
      <canvas id="h-pop-canvas" width="340" height="56"></canvas>
    </div>
    <div class="legend" id="h-legend" style="display:none">
      <div><span class="swatch" style="background:#00dcdc"></span><span id="leg-dig">dig</span></div>
      <div><span class="swatch" style="background:#dc00dc"></span><span id="leg-build">build</span></div>
      <div><span class="swatch" style="background:#f0dc3c"></span><span id="leg-trail">trail</span></div>
      <div><span class="swatch" style="background:#ff1e1e"></span><span id="leg-alarm">alarm</span></div>
      <div><span class="swatch" style="background:#6e46c8"></span><span id="leg-queen">queen</span></div>
      <div><span class="swatch" style="background:#ffb4b4"></span><span id="leg-brood">brood</span></div>
      <div><span class="swatch" style="background:#8c8232"></span><span id="leg-necro">necromone</span></div>
      <div><span class="swatch" style="background:#8c96aa"></span><span id="leg-noEntry">no-entry</span></div>
      <div><span class="swatch" style="background:#ffa03c"></span><span id="leg-granary">granary</span></div>
      <div><span class="swatch" style="background:#c8aa1e"></span><span id="leg-trunk">trunk</span></div>
    </div>
  `;
  const hudEls = {
    seed: document.getElementById('h-seed')!,
    mini: document.getElementById('h-mini')!,
    colony: document.getElementById('h-colony')!,
    brood: document.getElementById('h-brood')!,
    nest: document.getElementById('h-nest')!,
    res: document.getElementById('h-res')!,
    time: document.getElementById('h-time')!,
    speed: document.getElementById('h-speed')!,
    states: document.getElementById('h-states')!,
    sel: document.getElementById('h-sel')!,
    selRow: document.getElementById('h-sel-row')!,
    fps: document.getElementById('h-fps')!,
    legDig: document.getElementById('leg-dig')!,
    legBuild: document.getElementById('leg-build')!,
    legTrail: document.getElementById('leg-trail')!,
    legAlarm: document.getElementById('leg-alarm')!,
    legQueen: document.getElementById('leg-queen')!,
    legBrood: document.getElementById('leg-brood')!,
    legNecro: document.getElementById('leg-necro')!,
    legNoEntry: document.getElementById('leg-noEntry')!,
    legGranary: document.getElementById('leg-granary')!,
    legTrunk: document.getElementById('leg-trunk')!,
  };
  const LEG_NAMES: ReadonlyArray<readonly [string, string]> = [
    ['legDig', 'dig'],
    ['legBuild', 'build'],
    ['legTrail', 'trail'],
    ['legAlarm', 'alarm'],
    ['legQueen', 'queen'],
    ['legBrood', 'brood'],
    ['legNecro', 'necromone'],
    ['legNoEntry', 'no-entry'],
    ['legGranary', 'granary'],
    ['legTrunk', 'trunk'],
  ];
  /** Update the legend labels to show pheromone values at the
   *  given cell. If `values` is null (no selection), reset to
   *  bare names. */
  function setLegendValues(values: ReadonlyArray<number> | null): void {
    for (let i = 0; i < LEG_NAMES.length; i++) {
      const [k, name] = LEG_NAMES[i]!;
      const el = (hudEls as Record<string, HTMLElement>)[k]!;
      if (values === null) {
        el.textContent = name;
      } else {
        el.textContent = `${name}: ${values[i]!.toFixed(2)}`;
      }
    }
  }
  // Population graph. Adaptive-decimation ring buffer: the most
  // recent samples stay fine-grained; once the buffer is full, every
  // other sample is dropped and the push interval doubles. End
  // result is a roughly log-spaced timeline that always covers
  // "all time" since session start, regardless of how long it runs.
  type PopSample = { tick: number; alive: number };
  const popHistory: PopSample[] = [];
  const POP_HISTORY_MAX = 220;
  let popPushInterval = 1;
  let popPushCounter = 0;
  function pushPopSample(tick: number, alive: number): void {
    popPushCounter++;
    if (popPushCounter < popPushInterval) return;
    popPushCounter = 0;
    if (popHistory.length > 0 && popHistory[popHistory.length - 1]!.tick === tick) return;
    popHistory.push({ tick, alive });
    if (popHistory.length > POP_HISTORY_MAX) {
      const half: PopSample[] = [];
      for (let i = 0; i < popHistory.length; i += 2) half.push(popHistory[i]!);
      popHistory.length = 0;
      popHistory.push(...half);
      popPushInterval *= 2;
    }
  }
  // Tick milestones rendered as faint vertical lines on the graph.
  // Chosen to be visible across the typical session range.
  const POP_MILESTONES: ReadonlyArray<{ tick: number; label: string }> = [
    { tick: 100_000, label: '100k' },
    { tick: 500_000, label: '500k' },
    { tick: 1_000_000, label: '1M' },
    { tick: 5_000_000, label: '5M' },
    { tick: 10_000_000, label: '10M' },
  ];
  const popCanvas = document.getElementById('h-pop-canvas') as HTMLCanvasElement;
  const popCtx = popCanvas.getContext('2d')!;
  function drawPopGraph(): void {
    const cw = popCanvas.width;
    const ch = popCanvas.height;
    popCtx.clearRect(0, 0, cw, ch);
    if (popHistory.length < 2) return;
    const t0 = popHistory[0]!.tick;
    const t1 = popHistory[popHistory.length - 1]!.tick;
    const tRange = Math.max(1, t1 - t0);
    let popMax = 1;
    for (const p of popHistory) if (p.alive > popMax) popMax = p.alive;
    // Milestone lines first so the population line renders on top.
    popCtx.fillStyle = 'rgba(216, 200, 168, 0.18)';
    popCtx.font = '9px monospace';
    popCtx.textBaseline = 'top';
    for (const m of POP_MILESTONES) {
      if (m.tick < t0 || m.tick > t1) continue;
      const x = ((m.tick - t0) / tRange) * cw;
      popCtx.fillRect(x, 0, 1, ch);
      popCtx.fillStyle = 'rgba(216, 200, 168, 0.55)';
      popCtx.fillText(m.label, x + 2, 1);
      popCtx.fillStyle = 'rgba(216, 200, 168, 0.18)';
    }
    // Population line.
    popCtx.strokeStyle = '#7bcda0';
    popCtx.lineWidth = 1.25;
    popCtx.beginPath();
    for (let i = 0; i < popHistory.length; i++) {
      const p = popHistory[i]!;
      const x = ((p.tick - t0) / tRange) * cw;
      const y = ch - 1 - (p.alive / popMax) * (ch - 12);
      if (i === 0) popCtx.moveTo(x, y);
      else popCtx.lineTo(x, y);
    }
    popCtx.stroke();
    // Latest-value annotation.
    const last = popHistory[popHistory.length - 1]!;
    popCtx.fillStyle = '#f0e2c4';
    popCtx.font = '10px monospace';
    popCtx.textBaseline = 'top';
    popCtx.textAlign = 'right';
    popCtx.fillText(`${last.alive} (max ${popMax})`, cw - 3, 1);
    popCtx.textAlign = 'left';
  }
  // Histograms drawn into <canvas> so their pixel widths are
  // exactly fixed (text-based block chars varied slightly in
  // width across fonts, making the HUD wobble). 12 bars × 10 px
  // wide = 120 px canvas; bar heights scale to in-frame max.
  const ageCanvas = document.getElementById('h-age-cv') as HTMLCanvasElement;
  const ageCtx = ageCanvas.getContext('2d')!;
  const energyCanvas = document.getElementById('h-energy-cv') as HTMLCanvasElement;
  const energyCtx = energyCanvas.getContext('2d')!;
  function drawHisto(ctx: CanvasRenderingContext2D, buckets: ArrayLike<number>): void {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    let max = 1;
    for (let i = 0; i < buckets.length; i++) {
      const v = buckets[i]!;
      if (v > max) max = v;
    }
    const n = buckets.length;
    const slot = cw / n;
    const barW = Math.max(1, Math.floor(slot - 1));
    ctx.fillStyle = '#7bcda0';
    for (let i = 0; i < n; i++) {
      const t = buckets[i]! / max;
      const h = Math.max(1, Math.round(t * (ch - 1)));
      const x = Math.round(i * slot);
      ctx.fillRect(x, ch - h, barW, h);
    }
  }
  const hudMinBtn = document.getElementById('hud-min')!;
  hudMinBtn.addEventListener('click', () => {
    hud.classList.toggle('minimized');
    hudMinBtn.textContent = hud.classList.contains('minimized') ? '+' : '−';
  });
  const help = document.getElementById('help') as HTMLDivElement;
  const renderer = new Renderer(canvas, makePlaceholderWorld(settings));
  renderer.screensaver = settings.screensaver;
  // Screensaver mode: hide the static HUD and controls so the canvas
  // is the only thing on screen. The HUD is the highest burn-in risk
  // (small high-contrast text in the top-left corner that doesn't
  // change for hours). Hiding it AND drifting the canvas covers both
  // the static-pixel and stuck-text failure modes for OLED panels in
  // always-on use.
  if (settings.screensaver) {
    hud.style.display = 'none';
    help.style.display = 'none';
    document.body.style.cursor = 'none';
  }

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
  // Manual save bookkeeping. Set when the user clicks Save or hits
  // 's'; cleared by the savedBlob handler which then flashes the
  // button so the user sees confirmation.
  let manualSavePending = false;
  const flashButton = (act: string, kind: 'ok' | 'noop'): void => {
    const btn = document.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
    if (!btn) return;
    btn.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-noop');
    window.setTimeout(() => {
      btn.classList.remove('flash-ok', 'flash-noop');
    }, 600);
  };

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
        if (manualSavePending) {
          manualSavePending = false;
          flashButton('save', msg.blob === null ? 'noop' : 'ok');
        }
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
  // Click-to-inspect bookkeeping. Track the down-position and the
  // travelled distance per pointer so pointerup can decide click vs
  // drag; a click within the slop threshold runs pickAnt on the
  // canvas → sim coordinates and selects an ant. The selected id
  // is rendered in main's render call and shown in the HUD.
  let pressX = 0, pressY = 0, pressMoved = 0;
  let selectedAntId = -1;
  let selectedCell: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      panLastX = e.clientX;
      panLastY = e.clientY;
      pressX = e.clientX; pressY = e.clientY; pressMoved = 0;
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
    if (activePointers.size === 1) {
      pressMoved = Math.max(pressMoved, Math.hypot(e.clientX - pressX, e.clientY - pressY));
    }
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
    // Click-vs-drag: a release with minimal travel from press is
    // treated as a tap and runs ant pick. 6 px is roughly a finger
    // tap on a touch screen and a deliberate click on a mouse.
    const wasOnly = activePointers.size === 1;
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStartDist = 0;
    if (activePointers.size === 1) {
      const [p] = Array.from(activePointers.values());
      panLastX = p!.x; panLastY = p!.y;
    }
    if (wasOnly && pressMoved < 6 && latest) {
      // pickAnt does the screen→world transform internally so we
      // pass raw client coords. -1 means "missed" — clear selection.
      const colony = {
        count: latest.count,
        posX: latest.posX, posY: latest.posY,
        prevX: latest.prevX, prevY: latest.prevY,
        heading: latest.heading,
        state: latest.state,
        energy: latest.energy,
      };
      selectedAntId = renderer.pickAnt(e.clientX, e.clientY, colony, 2.5);
      if (selectedAntId < 0) {
        // No ant at click position — pick the cell so the HUD can
        // report its type / pheromones / depth. Useful for
        // diagnosing whether visible specks are SOIL pillars or
        // GRAIN deposits (they share the same render palette).
        const w = renderer.screenToWorld(e.clientX, e.clientY);
        selectedCell = { x: w.x | 0, y: w.y | 0 };
      } else {
        selectedCell = null;
      }
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
      requestedSpeed = Math.min(8192, requestedSpeed * 2);
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
    phero: () => {
      renderer.showPheromones = !renderer.showPheromones;
      const legend = document.getElementById('h-legend');
      if (legend) legend.style.display = renderer.showPheromones ? '' : 'none';
    },
    minimap: () => { renderer.showMinimap = !renderer.showMinimap; },
    reseed: () => {
      clearSavedSnapshot();
      settings.seed = (settings.seed * 16807 + 1) >>> 0;
      send({ kind: 'reseed', settings: { ...settings } });
      extinct = false;
    },
    save: () => {
      // Manual save: ask the worker for a fresh capture; the
      // 'savedBlob' handler writes it to localStorage. We flag the
      // request so the handler can flash the Save button green for
      // a beat to confirm the write.
      manualSavePending = true;
      send({ kind: 'captureForSave' });
    },
    load: () => {
      // Manual load: read whatever's in localStorage, hand it to
      // the worker as a fresh init blob. The worker rebuilds its
      // bundle and the existing 'ready' handshake produces the
      // first snapshot of the restored state. If there's no save,
      // do nothing — flash the button red briefly so the user
      // notices.
      const blob = readSavedBlob();
      if (blob === null) {
        flashButton('load', 'noop');
        return;
      }
      send({ kind: 'loadSave', settings: { ...settings }, restoreBlob: blob });
      extinct = false;
      flashButton('load', 'ok');
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
    else if (e.key === 'm') actions.minimap!();
    else if (e.key === 's') actions.save!();
    else if (e.key === 'l') actions.load!();
    else if (e.key === 'r') actions.reseed!();
  });

  const ctrls = document.getElementById('ctrls') as HTMLDivElement | null;
  if (ctrls && settings.screensaver) ctrls.style.display = 'none';
  if (ctrls) {
    ctrls.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t?.dataset?.act;
      if (act && actions[act]) actions[act]!();
    });
  }

  // ── Speed and time-scale dials ─────────────────────────────
  // Two sliders, both log-scaled in the markup so the slider position
  // varies linearly across powers of the displayed unit. They're
  // independent: speed scales wall-clock tick rate (CPU dimension);
  // time-scale scales how much biology happens per tick (the
  // TIME_COMPRESSION knob). Their PRODUCT is biology-per-real-second.
  const dials = document.getElementById('dials') as HTMLDivElement | null;
  if (dials && settings.screensaver) dials.style.display = 'none';
  const dialSpeed = document.getElementById('dial-speed') as HTMLInputElement | null;
  const dialSpeedVal = document.getElementById('dial-speed-val');
  const fmtMul = (n: number): string =>
    n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2).replace(/\.?0+$/, '');
  if (dialSpeed && dialSpeedVal) {
    dialSpeed.value = String(Math.round(Math.log2(Math.max(0.125, settings.speedMul))));
    dialSpeedVal.textContent = `${fmtMul(settings.speedMul)}×`;
    const onSpeedInput = (): void => {
      const exp = Number(dialSpeed.value);
      const v = Math.pow(2, exp);
      requestedSpeed = v;
      send({ kind: 'setSpeed', speedMul: v });
      dialSpeedVal.textContent = `${fmtMul(v)}×`;
    };
    dialSpeed.addEventListener('input', onSpeedInput);
  }
  // Keep the speed slider in sync when keyboard +/− changes the value
  // out from under the UI (so the slider thumb moves to match the
  // requested speed). Re-uses requestedSpeed which the action handler
  // updates.
  const syncSpeedSlider = (): void => {
    if (dialSpeed && dialSpeedVal) {
      dialSpeed.value = String(Math.round(Math.log2(Math.max(0.125, requestedSpeed))));
      dialSpeedVal.textContent = `${fmtMul(requestedSpeed)}×`;
    }
  };
  const origFaster = actions.faster!;
  const origSlower = actions.slower!;
  actions.faster = () => { origFaster(); syncSpeedSlider(); };
  actions.slower = () => { origSlower(); syncSpeedSlider(); };

  // Auto-save every 5 min wall (and on visibility-hidden /
  // beforeunload). The worker captures the snapshot; we hand off
  // to localStorage. Captures are async (cross-thread) so we don't
  // get a synchronous answer on beforeunload — best-effort.
  const AUTO_SAVE_MS = 5 * 60_000;
  window.setInterval(() => {
    send({ kind: 'captureForSave' });
  }, AUTO_SAVE_MS);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send({ kind: 'captureForSave' });
  });
  window.addEventListener('beforeunload', () => send({ kind: 'captureForSave' }));

  // ── Render loop ─────────────────────────────────────────────
  let last = performance.now();
  let frameCounter = 0;
  // Pheromone overlay refresh cadence. Every Nth frame — at 60 fps
  // that's 60 / N Hz of fresh overlay data. 6 = ~10 Hz, well above
  // the visual rate at which slowly-diffusing chemical fields
  // change perceptibly while cutting the overlay-on snapshot
  // payload by ~85 %.
  const PHERO_SNAPSHOT_INTERVAL = 6;
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;

    // Drive the worker by requesting a fresh snapshot. The worker
    // handles its own bio-time accumulation and stepping budget;
    // we just pull a new render frame each rAF.
    //
    // Pheromone snapshots are throttled. The fields are ~3.6 MB
    // total at 300×300 (10 fields × 90k cells × 4 B each) and the
    // overlay reads them through a 5-point diffusion that evolves
    // on a half-life of hundreds of ticks — refreshing the overlay
    // texture at 60 Hz wastes a lot of memcpy/transfer with no
    // visible improvement. Refresh every PHERO_SNAPSHOT_INTERVAL
    // frames; in between, the worker omits pheromones from the
    // snapshot and the renderer keeps using its cached textures
    // (GL path) or last-frame arrays (CPU fallback).
    if (!paused && !extinct && !snapshotPending) {
      const includePheromones = renderer.showPheromones &&
        (frameCounter % PHERO_SNAPSHOT_INTERVAL) === 0;
      send({ kind: 'requestSnapshot', includePheromones });
      snapshotPending = true;
    }
    frameCounter++;

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
      // If the selection points at a slot that's now dead or out of
      // range (count shrank after death), drop it so the ring vanishes
      // and the HUD row hides on the next update.
      if (selectedAntId >= 0 && (
        selectedAntId >= snap.count
        || snap.state[selectedAntId] === STATE_DEAD
      )) {
        selectedAntId = -1;
      }
      renderer.render(colony, 1, particles, pheromones, snap.daylight, selectedAntId);
    }

    if (latest && now - lastHud > 250) {
      lastHud = now;
      const snap = latest;
      const start = settings.ants + 1;
      // Bio time conversion. SECONDS_PER_TICK_BIO is the macro-bio
      // calendar advance per tick (= TIME_COMPRESSION / TICKS_PER_SEC,
      // currently 10 sec/tick). DAY_TICKS is the in-sim diel period.
      const bioSecs = snap.tick * SECONDS_PER_TICK_BIO;
      const bioDays = Math.floor(bioSecs / 86400);
      const bioHours = Math.floor((bioSecs / 3600) % 24);
      const bioMins = Math.floor((bioSecs / 60) % 60);
      const bioSecsR = Math.floor(bioSecs % 60);
      const bioTime = bioDays > 0
        ? `${bioDays}d ${bioHours}h ${bioMins}m`
        : bioHours > 0
          ? `${bioHours}h ${bioMins}m ${bioSecsR}s`
          : `${bioMins}m ${bioSecsR}s`;
      const dayPhase = (snap.tick % DAY_TICKS) / DAY_TICKS;
      const phaseLabel =
        dayPhase < 0.20 ? 'night'
          : dayPhase < 0.30 ? 'dawn'
            : dayPhase < 0.45 ? 'morning'
              : dayPhase < 0.55 ? 'noon'
                : dayPhase < 0.70 ? 'afternoon'
                  : dayPhase < 0.80 ? 'dusk'
                    : 'night';
      // Effective speed = measured ticks/sec × ms/tick / 1000.
      const effective = (measuredTicksPerSec * TICK_MS) / 1000;
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
      // Set with pulse: re-trigger the .pulse animation on text
      // change so the user notices when a number ticks. We strip
      // the class first to restart the CSS animation.
      const setPulse = (el: Element, text: string): void => {
        if (el.textContent === text) return;
        el.textContent = text;
        el.classList.remove('pulse');
        // Force reflow so the animation re-runs.
        void (el as HTMLElement).offsetWidth;
        el.classList.add('pulse');
      };
      hudEls.seed.textContent =
        `0x${settings.seed.toString(16)} · ${snap.width}×${snap.height}`;
      setPulse(hudEls.colony,
        `${snap.hud.alive} alive (start ${start}, +${snap.hud.totalBorn} −${snap.hud.totalDied})`);
      pushPopSample(snap.tick, snap.hud.alive);
      drawPopGraph();
      setPulse(hudEls.brood,
        `Q ${snap.hud.queens} · ${snap.hud.eggs}E · ${snap.hud.larvae}L · ${snap.hud.pupae}P`);
      setPulse(hudEls.nest,
        `${snap.hud.nestVol} cells · depth ${snap.hud.maxDepth} · ${snap.hud.chambers} ch`);
      setPulse(hudEls.res,
        `${snap.hud.grains} grains · ${snap.hud.foodCount} seeds`);
      hudEls.time.textContent =
        `t=${snap.tick.toLocaleString()} · ${bioTime} · ${phaseLabel}`;
      // Minimised-bar text: visible even when the user collapses the
      // HUD, so the colony's basic vitals (population + clock) remain
      // on screen at a glance.
      hudEls.mini.textContent =
        `${snap.hud.alive}/${snap.hud.alive + snap.hud.eggs + snap.hud.larvae + snap.hud.pupae} · ${bioTime} · t=${snap.tick.toLocaleString()}`;
      // Status flag. Priority: PAUSED > EXTINCT > STARVING. Below
      // 0.4 mean worker energy the colony is in real trouble — half
      // the workers are running on fumes and trophallaxis can't
      // keep up. Surfacing this earlier than EXTINCT lets the user
      // notice a slow collapse before it's too late to intervene.
      const starving = !paused && !extinct
        && snap.hud.alive > 0
        && snap.hud.meanWorkerEnergy < 0.4;
      const flag = paused
        ? ' · PAUSED'
        : extinct
          ? ' · EXTINCT — press r'
          : starving
            ? ' · STARVING'
            : '';
      hudEls.speed.textContent = speedDisplay + flag;
      // Worker breakdown — letter codes match the diag conventions.
      // W=wander, C=carry-grain, R=rest, F=forage, Cf=carry-food,
      // N=necro-carry. Skip zero-valued slots to keep the line dense.
      const stateParts: string[] = [];
      if (snap.hud.wander) stateParts.push(`W${snap.hud.wander}`);
      if (snap.hud.carry) stateParts.push(`C${snap.hud.carry}`);
      if (snap.hud.rest) stateParts.push(`R${snap.hud.rest}`);
      if (snap.hud.forage) stateParts.push(`F${snap.hud.forage}`);
      if (snap.hud.carryFood) stateParts.push(`Cf${snap.hud.carryFood}`);
      if (snap.hud.necroCarry) stateParts.push(`N${snap.hud.necroCarry}`);
      hudEls.states.textContent = stateParts.join(' ') || '—';
      drawHisto(ageCtx, snap.hud.ageBuckets);
      drawHisto(energyCtx, snap.hud.energyBuckets);
      // Selected-ant inspector. Hidden when no ant is selected; pins
      // id, role, position, energy, heading. State is shown by code
      // matching the diag glossary (W/C/R/F/Cf/N/Q/E/L) so the row
      // stays compact at one line.
      if (selectedAntId >= 0 && selectedAntId < snap.count) {
        const id = selectedAntId;
        const stateCode = (() => {
          switch (snap.state[id]) {
            case STATE_WANDER: return 'W';
            case STATE_CARRY: return 'C';
            case STATE_REST: return 'R';
            case STATE_FORAGE: return 'F';
            case STATE_CARRY_FOOD: return 'Cf';
            case STATE_NECRO_CARRY: return 'N';
            case STATE_QUEEN: return 'Q';
            case STATE_EGG: return 'E';
            case STATE_LARVA: return 'L';
            default: return '?';
          }
        })();
        const ex = snap.posX[id]!.toFixed(1);
        const ey = snap.posY[id]!.toFixed(1);
        const en = snap.energy[id]!.toFixed(2);
        const hd = ((snap.heading[id]! * 180 / Math.PI) | 0);
        // Local pheromones at the selected ant's cell. Names match
        // the legend swatches. Sorted by strength; top 3 shown.
        const ix = (snap.posX[id]! | 0);
        const iy = (snap.posY[id]! | 0);
        const cellIdx = iy * snap.width + ix;
        const pheroSamples: Array<{ name: string; v: number }> = [];
        if (snap.pheromones && ix >= 0 && iy >= 0 && ix < snap.width && iy < snap.height) {
          const p = snap.pheromones;
          pheroSamples.push({ name: 'dig', v: p.dig[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'build', v: p.build[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'trail', v: p.trail[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'alarm', v: p.alarm[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'queen', v: p.queen[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'brood', v: p.brood[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'necro', v: p.necro[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'noEntry', v: p.noEntry[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'granary', v: p.granary[cellIdx] ?? 0 });
          pheroSamples.push({ name: 'trunk', v: p.trunk[cellIdx] ?? 0 });
          pheroSamples.sort((a, b) => b.v - a.v);
        }
        const pheroSummary = pheroSamples
          .filter((s) => s.v > 0.01)
          .slice(0, 3)
          .map((s) => `${s.name}=${s.v.toFixed(2)}`)
          .join(' ');
        hudEls.sel.textContent =
          `#${id} ${stateCode} (${ex},${ey}) e=${en} ${hd}°` +
          (pheroSummary ? ` · ${pheroSummary}` : '');
        hudEls.selRow.classList.remove('hidden');
        // Update legend with values at this ant's cell. Skip the
        // call when pheromones aren't in this snapshot (the worker
        // throttles them every Nth frame to save bandwidth) — keeps
        // the previous values on screen instead of flickering blank.
        if (snap.pheromones) setLegendValues([
          snap.pheromones.dig[cellIdx] ?? 0,
          snap.pheromones.build[cellIdx] ?? 0,
          snap.pheromones.trail[cellIdx] ?? 0,
          snap.pheromones.alarm[cellIdx] ?? 0,
          snap.pheromones.queen[cellIdx] ?? 0,
          snap.pheromones.brood[cellIdx] ?? 0,
          snap.pheromones.necro[cellIdx] ?? 0,
          snap.pheromones.noEntry[cellIdx] ?? 0,
          snap.pheromones.granary[cellIdx] ?? 0,
          snap.pheromones.trunk[cellIdx] ?? 0,
        ]);
      } else if (selectedCell !== null
                 && selectedCell.x >= 0 && selectedCell.x < snap.width
                 && selectedCell.y >= 0 && selectedCell.y < snap.height) {
        // Cell-type readout (no ant under cursor — clicked empty
        // space). Shows the raw cell type and depth so we can tell
        // SOIL pillars from GRAIN deposits.
        const cx = selectedCell.x;
        const cy = selectedCell.y;
        const cIdx = cy * snap.width + cx;
        const cellVal = snap.cells[cIdx]!;
        const cellName = cellVal === 0 ? 'AIR' : cellVal === 1 ? 'SOIL' : cellVal === 2 ? 'GRAIN' : '?';
        const surf = snap.naturalSurface[cx]!;
        const depth = cy - surf;
        const where = cy < surf ? 'above' : `d${depth}`;
        // Local pheromones same as ant readout.
        const cellSamples: Array<{ name: string; v: number }> = [];
        if (snap.pheromones) {
          const p = snap.pheromones;
          cellSamples.push({ name: 'dig', v: p.dig[cIdx] ?? 0 });
          cellSamples.push({ name: 'build', v: p.build[cIdx] ?? 0 });
          cellSamples.push({ name: 'trail', v: p.trail[cIdx] ?? 0 });
          cellSamples.push({ name: 'alarm', v: p.alarm[cIdx] ?? 0 });
          cellSamples.push({ name: 'queen', v: p.queen[cIdx] ?? 0 });
          cellSamples.push({ name: 'brood', v: p.brood[cIdx] ?? 0 });
          cellSamples.push({ name: 'necro', v: p.necro[cIdx] ?? 0 });
          cellSamples.push({ name: 'noEntry', v: p.noEntry[cIdx] ?? 0 });
          cellSamples.push({ name: 'granary', v: p.granary[cIdx] ?? 0 });
          cellSamples.push({ name: 'trunk', v: p.trunk[cIdx] ?? 0 });
          cellSamples.sort((a, b) => b.v - a.v);
        }
        const cellPheroSummary = cellSamples
          .filter((s) => s.v > 0.01)
          .slice(0, 3)
          .map((s) => `${s.name}=${s.v.toFixed(2)}`)
          .join(' ');
        hudEls.sel.textContent =
          `cell (${cx},${cy}) ${cellName} ${where}` +
          (cellPheroSummary ? ` · ${cellPheroSummary}` : '');
        hudEls.selRow.classList.remove('hidden');
        // Update legend with values at this clicked cell. Same
        // throttle-skip logic as the ant branch.
        if (snap.pheromones) setLegendValues([
          snap.pheromones.dig[cIdx] ?? 0,
          snap.pheromones.build[cIdx] ?? 0,
          snap.pheromones.trail[cIdx] ?? 0,
          snap.pheromones.alarm[cIdx] ?? 0,
          snap.pheromones.queen[cIdx] ?? 0,
          snap.pheromones.brood[cIdx] ?? 0,
          snap.pheromones.necro[cIdx] ?? 0,
          snap.pheromones.noEntry[cIdx] ?? 0,
          snap.pheromones.granary[cIdx] ?? 0,
          snap.pheromones.trunk[cIdx] ?? 0,
        ]);
      } else {
        hudEls.selRow.classList.add('hidden');
        setLegendValues(null);
      }
      hudEls.fps.textContent = `${renderFps} fps`;
    }
  };
  requestAnimationFrame(frame);
}

main();
