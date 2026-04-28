// Pheromone field — environment, not agent. A scalar Float32 per cell
// that diffuses to neighbours and evaporates each tick. Agents read
// it (gradient sampling) and write it (deposit on dig / on grain
// placement). The dynamics are the standard reaction-diffusion model
// used for ant stigmergy:
//
//   Grassé, P-P. (1959). La reconstruction du nid et les
//     coordinations inter-individuelles chez Bellicositermes...
//   Bonabeau, E., Theraulaz, G., Deneubourg, J-L., Aron, S. and
//     Camazine, S. (1997). Self-organization in social insects.
//     Trends Ecol. Evol. 12: 188–193.
//   Deneubourg, J-L., Goss, S. (1989). Collective patterns and
//     decision-making. Ethol. Ecol. Evol. 1: 295–311.
//
// The 5-point stencil is the discretised heat equation on a regular
// grid; evaporation models the volatile chemical's degradation. The
// ping-pong of two arrays is the standard way to avoid sampling and
// writing the same texture in one pass.

import type { PheromoneWasm, WasmFieldHandle } from './pheromone-wasm';

/** Module-level WASM runtime. When attached via attachPheromoneWasm,
 *  newly-constructed Pheromone instances allocate their buffers in
 *  WASM linear memory and route step() through the SIMD kernel.
 *  Tests don't attach a runtime and exercise the JS path. Both
 *  paths are bit-exact (same op order, same IEEE-754 rounding). */
let wasmRuntime: PheromoneWasm | null = null;
export function attachPheromoneWasm(rt: PheromoneWasm | null): void {
  wasmRuntime = rt;
}
/** Upload the current cells snapshot to the WASM kernel once per
 *  tick, before any pheromone step() call. No-op if WASM isn't
 *  attached. The kernel reads cells by pointer; without this call
 *  it would diffuse against a stale snapshot. */
export function uploadPheromoneCells(cells: Uint8Array): void {
  if (wasmRuntime !== null) wasmRuntime.uploadCells(cells);
}

export class Pheromone {
  readonly width: number;
  readonly height: number;
  /** Current concentration field. Read by agents and by step(). */
  current: Float32Array;
  /** Scratch buffer written by step(); swapped with current at end. */
  private scratch: Float32Array;
  /** Fraction of each cell's value that diffuses to its 4-neighbours
   *  in one tick. 0.10–0.20 is the typical literature range. */
  readonly diffuse: number;
  /** Multiplier applied per cell per tick. evap ∈ (0, 1). 0.99 gives
   *  a half-life of ~69 ticks. */
  readonly evaporate: number;
  /** WASM kernel handle when this instance is using the SIMD path,
   *  null otherwise. step() consults this to pick a backend. */
  private wasmHandle: WasmFieldHandle | null;
  /** When true, the field diffuses through SOIL/GRAIN cells the same
   *  as through AIR — modelling persistent caste-recognition signals
   *  (cuticular hydrocarbons, vibrations, CO2 plumes) that real ants
   *  detect through substrate. Volatile fields (dig/build/trail/
   *  alarm/necro) stay AIR-only. Permeable fields run on the JS
   *  scalar path because the WASM kernel hardcodes the AIR-only
   *  gating; at 1-2 permeable fields per world the cost is fine. */
  private readonly permeable: boolean;

  constructor(width: number, height: number, diffuse: number, evaporate: number, permeable = false) {
    this.width = width;
    this.height = height;
    this.diffuse = diffuse;
    this.evaporate = evaporate;
    this.permeable = permeable;
    // Permeable fields skip the WASM allocator — the kernel can't
    // express through-soil diffusion without recompilation, so we
    // run them on the JS scalar path with cells effectively ignored.
    if (wasmRuntime !== null && !permeable) {
      const handle = wasmRuntime.allocField(width, height);
      this.wasmHandle = handle;
      this.current = handle.current;
      this.scratch = handle.scratch;
    } else {
      this.wasmHandle = null;
      this.current = new Float32Array(width * height);
      this.scratch = new Float32Array(width * height);
    }
  }

  /**
   * Advance one tick: 5-point diffusion + multiplicative evaporation.
   *
   * Boundary condition: ABSORBING. Cells at the world edge diffuse
   * to their existing in-grid neighbours; the "missing" out-of-
   * world neighbours contribute 0, which means a quarter of the
   * normal outflow is lost to outside (equivalent to pheromone
   * dispersing into sky above or deep-soil below the simulated
   * cross-section). The earlier "edges only evaporate" boundary
   * was a bug: interior cells still leaked INTO edges via the
   * 5-point stencil, but edges had no way to lose pheromone
   * except via the very-slow evaporation rate (0.99995 retention =
   * 30-min half-life for build), so edges became pheromone traps
   * that accumulated unbounded over the run. Visually that showed
   * up as a glowing magenta/cyan wall on the world boundary.
   *
   * Sub-1e-6 values clamp to zero to keep sparse regions sparse
   * and avoid denormal-float drag.
   */
  step(cells?: Uint8Array): void {
    // WASM path: kernel reads cells from its own copy (uploaded once
    // per tick by the worker via PheromoneWasm.uploadCells) and
    // operates directly on the Float32Array views backing this
    // instance. After it runs, current/scratch refer to the swapped
    // buffers, identical semantics to the JS path.
    if (this.wasmHandle !== null && wasmRuntime !== null) {
      wasmRuntime.step(this.wasmHandle, this.diffuse, this.evaporate, 1000);
      this.current = this.wasmHandle.current;
      this.scratch = this.wasmHandle.scratch;
      return;
    }
    // Permeable fields ignore the cells gate so they diffuse through
    // SOIL/GRAIN as if the world were uniform — the JS scalar code
    // already does no-op gating when cells is undefined.
    if (this.permeable) cells = undefined;
    const w = this.width;
    const h = this.height;
    const src = this.current;
    const dst = this.scratch;
    const f = this.diffuse;
    const f4 = f * 0.25;
    const e = this.evaporate;
    const m = 1 - f;
    // Saturation cap. Without an upper bound, fields with steady
    // deposit > evaporation grow unbounded over long runs (Float32
    // eventually loses precision; gradient at saturated cells reads
    // ~0 because all neighbours are equally saturated, so the
    // sensing radius collapses). 1000 is well above the largest
    // useful gradient signal — the renderer caps display at ≤4 for
    // the densest field — so capping here doesn't change visible
    // behaviour at any concentration the rest of the system reads.
    const CAP = 1000;
    // AIR-only diffusion. Real volatile pheromones don't propagate
    // through soil walls — they live in the air column the colony
    // has carved out. When `cells` is provided, non-AIR cells (SOIL,
    // GRAIN) are zeroed and contribute nothing to neighbour sums.
    // Pheromone "leaks into" walls in the sense that the AIR cell
    // adjacent to a wall has fewer contributing neighbours and
    // therefore loses some signal each tick (an absorbing boundary
    // at every wall). This drops the over-bloomed gradient that
    // previously bled through 30+ cells of solid earth.
    //
    // CELL_AIR == 0 (see world.ts). Skip the import to keep the
    // pheromone module self-contained.
    if (w >= 2 && h >= 2) {
      const wm1 = w - 1;
      const hm1 = h - 1;
      for (let y = 1; y < hm1; y++) {
        const rowStart = y * w + 1;
        const rowEnd = y * w + wm1;
        for (let i = rowStart; i < rowEnd; i++) {
          if (cells && cells[i] !== 0) { dst[i] = 0; continue; }
          let sum = 0;
          if (!cells || cells[i - 1] === 0) sum += src[i - 1]!;
          if (!cells || cells[i + 1] === 0) sum += src[i + 1]!;
          if (!cells || cells[i - w] === 0) sum += src[i - w]!;
          if (!cells || cells[i + w] === 0) sum += src[i + w]!;
          let v = m * src[i]! + f4 * sum;
          v *= e;
          if (v < 1e-6) v = 0;
          else if (v > CAP) v = CAP;
          dst[i] = v;
        }
      }
    }
    // Edge rows (y=0 and y=h-1) and edge columns (x=0 and x=w-1).
    // Use the original guarded form. Total work: 2*(w + h - 2).
    const stepBoundaryCell = (x: number, y: number): void => {
      const i = y * w + x;
      if (cells && cells[i] !== 0) { dst[i] = 0; return; }
      let sum = 0;
      if (x > 0 && (!cells || cells[i - 1] === 0)) sum += src[i - 1]!;
      if (x < w - 1 && (!cells || cells[i + 1] === 0)) sum += src[i + 1]!;
      if (y > 0 && (!cells || cells[i - w] === 0)) sum += src[i - w]!;
      if (y < h - 1 && (!cells || cells[i + w] === 0)) sum += src[i + w]!;
      let v = ((1 - f) * src[i]! + f4 * sum) * e;
      if (v < 1e-6) v = 0;
      else if (v > CAP) v = CAP;
      dst[i] = v;
    };
    if (h > 0) {
      for (let x = 0; x < w; x++) stepBoundaryCell(x, 0);
      if (h > 1) for (let x = 0; x < w; x++) stepBoundaryCell(x, h - 1);
    }
    if (w > 0) {
      for (let y = 1; y < h - 1; y++) stepBoundaryCell(0, y);
      if (w > 1) for (let y = 1; y < h - 1; y++) stepBoundaryCell(w - 1, y);
    }
    this.current = dst;
    this.scratch = src;
  }

  /** Add `amount` to the cell at (x, y). No-op for out-of-bounds. */
  deposit(x: number, y: number, amount: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.current[y * this.width + x]! += amount;
  }

  /** Concentration at integer (x, y). Zero outside the grid. */
  sample(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.current[y * this.width + x]!;
  }

  /**
   * Gradient at (x, y) by central differences. Returns the vector
   * pointing UP the gradient (so an ant heading toward this vector
   * climbs the concentration). At the grid edge the missing
   * neighbour is treated as zero.
   *
   * Fast path: most calls happen at interior cells where all four
   * neighbours are in-bounds. Skipping the four bounds-checked
   * sample() calls there saves ~16 branches per gradient — and
   * gradient is the hottest pheromone API since every WANDER ant
   * samples 5+ fields per tick.
   */
  gradient(x: number, y: number): { dx: number; dy: number } {
    const w = this.width;
    if (x > 0 && y > 0 && x < w - 1 && y < this.height - 1) {
      const i = y * w + x;
      const cur = this.current;
      return { dx: cur[i + 1]! - cur[i - 1]!, dy: cur[i + w]! - cur[i - w]! };
    }
    // Edge fallback — at least one neighbour out of bounds.
    return {
      dx: this.sample(x + 1, y) - this.sample(x - 1, y),
      dy: this.sample(x, y + 1) - this.sample(x, y - 1),
    };
  }
}
