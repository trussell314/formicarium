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

  // ── Dirty-tile tracking. The field is partitioned into 16×16 cell
  //    tiles. A tile is "dirty" if any cell inside it has non-zero
  //    concentration; clean tiles can be skipped entirely by step()
  //    because zero in / zero diffusion neighbour out → zero out. On
  //    a 300×300 idle world this turns ~360 tiles × ~10 fields × ~90k
  //    cell-ops/tick into ~0 cell-ops for the empty fields and a few
  //    hundred for the lightly-populated ones, recovering most of
  //    the wall-time gap vs a smaller dense world.
  //
  //    Two bitmaps for double-buffering: `dirty` is the input set this
  //    step() reads, `dirtyNext` is what step() rebuilds for the
  //    following tick. Tiles with non-zero output cells (or tiles
  //    adjacent to one — diffusion crosses tile boundaries) are
  //    marked in dirtyNext; the bitmaps swap at end of step().
  //
  //    Invariant: in BOTH `current` and `scratch`, cells inside a
  //    clean tile are guaranteed 0. Maintained by zeroing both
  //    buffers' cells inside any tile that transitions dirty→clean.
  //    Without this the ping-pong leaves stale values in the new
  //    `current` buffer for tiles we skipped.
  static readonly TILE_SHIFT = 4;
  static readonly TILE_SIZE = 16;
  private readonly tilesX: number;
  private readonly tilesY: number;
  private dirty: Uint8Array;
  private dirtyNext: Uint8Array;
  /** Cached `dirty` non-empty flag — fast early-exit in step(). */
  private anyDirty: boolean;

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
    // Tile bookkeeping. Round up so the tile grid covers the whole
    // world even when width or height isn't a multiple of TILE_SIZE.
    this.tilesX = (width + Pheromone.TILE_SIZE - 1) >> Pheromone.TILE_SHIFT;
    this.tilesY = (height + Pheromone.TILE_SIZE - 1) >> Pheromone.TILE_SHIFT;
    this.dirty = new Uint8Array(this.tilesX * this.tilesY);
    this.dirtyNext = new Uint8Array(this.tilesX * this.tilesY);
    this.anyDirty = false;
  }

  /** Mark tile (tx, ty) and its 8 cardinal+diagonal neighbours dirty
   *  in the current (input-side) bitmap. Used by deposit() — whenever
   *  a cell receives a non-zero value, both that cell's tile AND its
   *  neighbouring tiles need to step next round, because diffusion
   *  outflow at a tile boundary lands in the adjacent tile. */
  private markTileNeighbourhoodDirty(tx: number, ty: number): void {
    const txMin = tx > 0 ? tx - 1 : 0;
    const txMax = tx + 1 < this.tilesX ? tx + 1 : this.tilesX - 1;
    const tyMin = ty > 0 ? ty - 1 : 0;
    const tyMax = ty + 1 < this.tilesY ? ty + 1 : this.tilesY - 1;
    const dirty = this.dirty;
    const stride = this.tilesX;
    for (let y = tyMin; y <= tyMax; y++) {
      for (let x = txMin; x <= txMax; x++) {
        dirty[y * stride + x] = 1;
      }
    }
    this.anyDirty = true;
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
    // Fast bail when the field is fully zero. anyDirty becomes false
    // only when every tile in `dirty` is also zero, which is the
    // common case for trail/alarm/necro/granary/trunk in the early
    // game and for noEntry/granary in idle worlds. Skipping the WASM
    // call too matters: the FFI overhead is non-trivial at 10
    // fields/tick.
    //
    // We still swap current ↔ scratch on the empty-field path to
    // preserve the structural ping-pong invariant other callers
    // (and one test) rely on. Both buffers are all-zero, so the
    // swap is a no-op semantically — we just rotate the references.
    if (!this.anyDirty) {
      const tmp = this.current;
      this.current = this.scratch;
      this.scratch = tmp;
      return;
    }

    // WASM path: kernel reads cells from its own copy (uploaded once
    // per tick by the worker via PheromoneWasm.uploadCells) and
    // operates directly on the Float32Array views backing this
    // instance. After it runs, current/scratch refer to the swapped
    // buffers, identical semantics to the JS path.
    //
    // We populate the kernel's dirty-tile bitmap with our DILATED
    // dirty set (each dirty tile + its 8 neighbours) so the kernel
    // skips fully-clean tiles. After the kernel runs, scan the
    // output to rebuild `dirty` for the next tick.
    if (this.wasmHandle !== null && wasmRuntime !== null) {
      this.populateWasmDirtyBitmap();
      wasmRuntime.step(this.wasmHandle, this.diffuse, this.evaporate, 1000);
      this.current = this.wasmHandle.current;
      this.scratch = this.wasmHandle.scratch;
      this.recomputeDirtyFromCurrent();
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
    // Saturation cap. Without an upper bound, fields with steady
    // deposit > evaporation grow unbounded over long runs (Float32
    // eventually loses precision; gradient at saturated cells reads
    // ~0 because all neighbours are equally saturated, so the
    // sensing radius collapses). 1000 is well above the largest
    // useful gradient signal — the renderer caps display at ≤4 for
    // the densest field — so capping here doesn't change visible
    // behaviour at any concentration the rest of the system reads.
    const CAP = 1000;

    // AIR-only diffusion with REFLECTING walls. Real volatile
    // pheromones don't propagate through soil walls — they live in
    // the air column the colony has carved out. The 5-point stencil
    // would normally lose fraction f per tick (split f/4 to each
    // direction), but in a narrow tunnel where most directions are
    // soil that f/4 outflow has nowhere to go: previously we just
    // discarded it (absorbing walls), so a 1-cell-wide tunnel cell
    // lost 3f/4 per tick to nothing. That made pheromone trails
    // attenuate fast through narrow passages and queen-pheromone
    // gradients vanish a few cells from the source.
    //
    // Reflecting walls are the physically-correct alternative for
    // "molecules can't pass": a cell only loses outflow toward
    // AIR neighbours. Total outflow = (kAir/4) × f × src[i] where
    // kAir is the count of AIR cardinal neighbours; the rest of the
    // would-be outflow stays put (reflects). Net concentration in
    // narrow tunnels and dead-end pockets is preserved.
    //
    // CELL_AIR == 0 (see world.ts). Skip the import to keep the
    // pheromone module self-contained.

    // Build the "to-process" set: all tiles that are dirty OR adjacent
    // to a dirty tile (a 1-tile dilation of `dirty`). Diffusion from
    // a dirty tile reaches one cell into each adjacent tile, so the
    // adjacent tile must be stepped to capture that inflow even if
    // it was previously clean. We reuse `dirtyNext` as scratch space
    // here — it's still safe because we're about to rebuild it from
    // the output anyway.
    const dirty = this.dirty;
    const dirtyNext = this.dirtyNext;
    dirtyNext.fill(0);
    const tx = this.tilesX;
    const ty = this.tilesY;
    for (let yy = 0; yy < ty; yy++) {
      const rowOff = yy * tx;
      for (let xx = 0; xx < tx; xx++) {
        if (dirty[rowOff + xx] === 0) continue;
        const yMin = yy > 0 ? yy - 1 : 0;
        const yMax = yy + 1 < ty ? yy + 1 : ty - 1;
        const xMin = xx > 0 ? xx - 1 : 0;
        const xMax = xx + 1 < tx ? xx + 1 : tx - 1;
        for (let y2 = yMin; y2 <= yMax; y2++) {
          for (let x2 = xMin; x2 <= xMax; x2++) {
            dirtyNext[y2 * tx + x2] = 1;
          }
        }
      }
    }

    // Scalar boundary stepper — used for cells in the outermost row
    // or column. mEff uses kOut (out-of-grid absorbs, soil reflects),
    // identical to the pre-tiled implementation.
    const stepBoundaryCell = (x: number, y: number): number => {
      const i = y * w + x;
      if (cells && cells[i] !== 0) { dst[i] = 0; return 0; }
      let sum = 0;
      let kOut = 0;
      if (x > 0) {
        if (!cells || cells[i - 1] === 0) { sum += src[i - 1]!; kOut++; }
      } else { kOut++; }
      if (x < w - 1) {
        if (!cells || cells[i + 1] === 0) { sum += src[i + 1]!; kOut++; }
      } else { kOut++; }
      if (y > 0) {
        if (!cells || cells[i - w] === 0) { sum += src[i - w]!; kOut++; }
      } else { kOut++; }
      if (y < h - 1) {
        if (!cells || cells[i + w] === 0) { sum += src[i + w]!; kOut++; }
      } else { kOut++; }
      const mEff = 1 - kOut * f4;
      let v = (mEff * src[i]! + f4 * sum) * e;
      if (v < 1e-6) v = 0;
      else if (v > CAP) v = CAP;
      dst[i] = v;
      return v;
    };

    // Now `dirtyNext` holds the to-process set. Walk those tiles,
    // stepping every cell, and BUILD the new dirty bitmap into
    // `dirty` (we'll swap at the end). For each tile, track whether
    // any output cell ended up non-zero: if not, the tile is clean
    // and we additionally zero its cells in `src` so the buffer-
    // ping-pong invariant holds (clean tiles must have 0 in BOTH
    // buffers).
    dirty.fill(0);
    let anyDirty = false;
    const TILE = Pheromone.TILE_SIZE;
    for (let yy = 0; yy < ty; yy++) {
      const tileRowOff = yy * tx;
      for (let xx = 0; xx < tx; xx++) {
        if (dirtyNext[tileRowOff + xx] === 0) continue;
        const x0 = xx << Pheromone.TILE_SHIFT;
        const y0 = yy << Pheromone.TILE_SHIFT;
        const x1 = x0 + TILE < w ? x0 + TILE : w;
        const y1 = y0 + TILE < h ? y0 + TILE : h;
        let tileMax = 0;
        for (let y = y0; y < y1; y++) {
          // Identify whether this row is at a world boundary; if so,
          // every cell in it goes through stepBoundaryCell. Otherwise
          // the leftmost / rightmost cells of the tile may still be
          // boundary cells (when the tile sits against the world
          // edge), but the interior cells use the fast 5-point form.
          const yIsBoundary = (y === 0 || y === h - 1);
          for (let x = x0; x < x1; x++) {
            const xIsBoundary = (x === 0 || x === w - 1);
            let v: number;
            if (yIsBoundary || xIsBoundary) {
              v = stepBoundaryCell(x, y);
            } else {
              const i = y * w + x;
              if (cells && cells[i] !== 0) { dst[i] = 0; v = 0; }
              else {
                let sum = 0;
                let kAir = 0;
                if (!cells || cells[i - 1] === 0) { sum += src[i - 1]!; kAir++; }
                if (!cells || cells[i + 1] === 0) { sum += src[i + 1]!; kAir++; }
                if (!cells || cells[i - w] === 0) { sum += src[i - w]!; kAir++; }
                if (!cells || cells[i + w] === 0) { sum += src[i + w]!; kAir++; }
                const mEff = 1 - kAir * f4;
                v = (mEff * src[i]! + f4 * sum) * e;
                if (v < 1e-6) v = 0;
                else if (v > CAP) v = CAP;
                dst[i] = v;
              }
            }
            if (v > tileMax) tileMax = v;
          }
        }
        if (tileMax > 0) {
          // Tile has live content next tick; mark it AND its 8
          // neighbours dirty so subsequent ticks pick up the
          // diffusion outflow.
          const yMin = yy > 0 ? yy - 1 : 0;
          const yMax = yy + 1 < ty ? yy + 1 : ty - 1;
          const xMin = xx > 0 ? xx - 1 : 0;
          const xMax = xx + 1 < tx ? xx + 1 : tx - 1;
          for (let y2 = yMin; y2 <= yMax; y2++) {
            for (let x2 = xMin; x2 <= xMax; x2++) {
              dirty[y2 * tx + x2] = 1;
            }
          }
          anyDirty = true;
        } else {
          // Tile transitioned to (or stayed at) all-zero. dst[tile
          // cells] is 0 from the writes above; also zero src[tile
          // cells] so when we swap buffers the new `scratch` won't
          // hand stale values back when the tile is later skipped.
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              src[y * w + x] = 0;
            }
          }
        }
      }
    }

    this.anyDirty = anyDirty;
    this.current = dst;
    this.scratch = src;
  }

  /** Copy the dilation of `this.dirty` into the WASM kernel's bitmap
   *  before each step(). The kernel skips tiles where the bitmap is
   *  zero; by passing the dilation we make sure adjacent tiles that
   *  receive diffusion inflow get processed. */
  private populateWasmDirtyBitmap(): void {
    if (this.wasmHandle === null) return;
    const dirty = this.dirty;
    const wasmDirty = this.wasmHandle.dirty;
    const tx = this.tilesX;
    const ty = this.tilesY;
    wasmDirty.fill(0);
    for (let yy = 0; yy < ty; yy++) {
      const rowOff = yy * tx;
      for (let xx = 0; xx < tx; xx++) {
        if (dirty[rowOff + xx] === 0) continue;
        const yMin = yy > 0 ? yy - 1 : 0;
        const yMax = yy + 1 < ty ? yy + 1 : ty - 1;
        const xMin = xx > 0 ? xx - 1 : 0;
        const xMax = xx + 1 < tx ? xx + 1 : tx - 1;
        for (let y2 = yMin; y2 <= yMax; y2++) {
          for (let x2 = xMin; x2 <= xMax; x2++) {
            wasmDirty[y2 * tx + x2] = 1;
          }
        }
      }
    }
  }

  /** Re-derive `dirty` from the current buffer's actual contents.
   *  Used after the WASM path runs (which already skipped clean
   *  tiles per the input bitmap) so the next tick can refine the
   *  set: tiles that produced all-zero output drop out of `dirty`,
   *  tiles whose diffusion crossed into a neighbour stay marked.
   *  When this trips an all-zero tile we also zero the scratch
   *  buffer's matching cells to maintain the buffer-zero invariant. */
  private recomputeDirtyFromCurrent(): void {
    const w = this.width;
    const h = this.height;
    const cur = this.current;
    const scr = this.scratch;
    const dirty = this.dirty;
    const tx = this.tilesX;
    const ty = this.tilesY;
    const TILE = Pheromone.TILE_SIZE;
    // We only need to scan tiles that the WASM kernel actually
    // processed this tick (its input bitmap = the dilation we wrote
    // in populateWasmDirtyBitmap). Tiles outside that set retained
    // their pre-step zero by invariant, so they're still clean —
    // scanning them again would waste ~256 reads per tile per tick.
    const processSet = this.wasmHandle !== null ? this.wasmHandle.dirty : null;
    dirty.fill(0);
    let anyDirty = false;
    for (let yy = 0; yy < ty; yy++) {
      for (let xx = 0; xx < tx; xx++) {
        if (processSet !== null && processSet[yy * tx + xx] === 0) continue;
        const x0 = xx << Pheromone.TILE_SHIFT;
        const y0 = yy << Pheromone.TILE_SHIFT;
        const x1 = x0 + TILE < w ? x0 + TILE : w;
        const y1 = y0 + TILE < h ? y0 + TILE : h;
        let tileMax = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const v = cur[y * w + x]!;
            if (v > tileMax) tileMax = v;
          }
        }
        if (tileMax > 0) {
          const yMin = yy > 0 ? yy - 1 : 0;
          const yMax = yy + 1 < ty ? yy + 1 : ty - 1;
          const xMin = xx > 0 ? xx - 1 : 0;
          const xMax = xx + 1 < tx ? xx + 1 : tx - 1;
          for (let y2 = yMin; y2 <= yMax; y2++) {
            for (let x2 = xMin; x2 <= xMax; x2++) {
              dirty[y2 * tx + x2] = 1;
            }
          }
          anyDirty = true;
        } else {
          // All-zero tile: ensure scratch matches so the buffer-zero
          // invariant holds across subsequent skipped ticks.
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              scr[y * w + x] = 0;
            }
          }
        }
      }
    }
    this.anyDirty = anyDirty;
  }

  /** Add `amount` to the cell at (x, y). No-op for out-of-bounds. */
  deposit(x: number, y: number, amount: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.current[y * this.width + x]! += amount;
    this.markTileNeighbourhoodDirty(x >> Pheromone.TILE_SHIFT, y >> Pheromone.TILE_SHIFT);
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
