// Runtime loader for the SIMD-accelerated pheromone step kernel.
//
// The kernel itself lives in src/wasm/pheromone.wasm (compiled from
// the AssemblyScript source in src/wasm/pheromone.ts). This module:
//   1. instantiates the kernel,
//   2. owns a single linear memory shared across all pheromone fields,
//   3. allocates Float32 slots for each field,
//   4. provides step() that hands the kernel raw pointers.
//
// The Pheromone class in pheromone.ts checks for a globally-registered
// runtime; if present, step() routes to the WASM path. Tests run
// without registering one and exercise the pure-JS fallback. Both
// paths compute identical IEEE-754 output (same op order, same
// rounding modes), so determinism holds either way.

export interface PheromoneWasm {
  /** Allocate a paired (current, scratch) buffer pair for one field
   *  inside the kernel's linear memory. Returns Float32Array views
   *  backed by that memory plus the byte offsets needed when calling
   *  step(). */
  allocField(width: number, height: number): WasmFieldHandle;
  /** Copy `cells` into the kernel's linear memory; subsequent
   *  step() calls reference this snapshot. Caller is responsible
   *  for re-uploading when the world changes (the worker does it
   *  once per tick, before stepping all fields). */
  uploadCells(cells: Uint8Array): void;
  /** Run one diffusion+evaporation+clamp pass on the field
   *  identified by `handle`, using the most recently uploaded
   *  cells. Swaps current ↔ scratch on the handle so the new
   *  field is available via handle.current. */
  step(handle: WasmFieldHandle, diffuse: number, evaporate: number, cap: number): void;
  /** Subscribe to the "WASM linear-memory grew, all TypedArray views
   *  onto the old buffer are detached" event. The callback is
   *  invoked once per existing handle whenever any subsequent
   *  allocField / uploadCells call triggers a memory.grow. The
   *  Pheromone class wires this up to re-cache its `.current` /
   *  `.scratch` references — without it those cached refs keep
   *  pointing at detached buffers and the next access throws. */
  onBuffersRefreshed(cb: (handle: WasmFieldHandle) => void): void;
}

export interface WasmFieldHandle {
  width: number;
  height: number;
  /** Float32Array view of the front buffer. Backed by WASM memory. */
  current: Float32Array;
  /** Float32Array view of the back buffer. Backed by WASM memory. */
  scratch: Float32Array;
  /** Internal: byte offsets the kernel needs. Mutated by step(). */
  _curPtr: number;
  _scrPtr: number;
}

/**
 * Initialise the WASM kernel. Returns a runtime if WASM + SIMD is
 * supported and the module loads, otherwise null. Callers should
 * fall back to the JS path when null is returned.
 *
 * The wasm bytes are loaded via a path argument so this works in
 * both browser (Vite hands us a URL) and Node (vitest reads from
 * the filesystem). The bytes loader is the only platform-specific
 * piece; everything else is portable.
 */
export async function initPheromoneWasm(
  loadBytes: () => Promise<BufferSource>,
): Promise<PheromoneWasm | null> {
  if (typeof WebAssembly === 'undefined') return null;
  // SIMD feature detect: try to compile a tiny module that uses one
  // SIMD instruction. If validation fails, the runtime won't have
  // SIMD support. Bytes adapted from wasm-feature-detect.
  const simdProbe = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
    10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
  ]);
  if (!WebAssembly.validate(simdProbe)) return null;

  let bytes: BufferSource;
  try {
    bytes = await loadBytes();
  } catch {
    return null;
  }
  let mod: WebAssembly.WebAssemblyInstantiatedSource;
  try {
    mod = await WebAssembly.instantiate(bytes, {
      env: {
        // Trap stub for AS abort calls. We don't expect any since the
        // kernel does no allocation, but emit a clear error if it
        // ever does.
        abort: (_msg: number, _file: number, line: number, col: number): void => {
          throw new Error(`pheromone.wasm aborted at ${line}:${col}`);
        },
      },
    });
  } catch {
    return null;
  }
  const exports = mod.instance.exports as {
    memory: WebAssembly.Memory;
    step: (
      srcPtr: number, dstPtr: number, cellsPtr: number,
      w: number, h: number, f: number, e: number, cap: number,
    ) => void;
  };
  const memory = exports.memory;
  // Layout: a single linear memory shared by all fields.
  //   [0, 16)         alignment headroom
  //   [16, 16+N)      cells snapshot (N = world cell count)
  //   [bumpPtr, ...)  paired (current, scratch) Float32 buffers,
  //                    one pair per pheromone field, 16-byte aligned
  // uploadCells() must be called once before any allocField() so the
  // bump pointer knows where to start. The field buffers do not
  // move once allocated; only their content swaps each step.
  //
  // memory.grow() detaches all existing TypedArray views, so we
  // track every handed-out handle and rebuild its views after
  // any growth. Same for the cells view.
  let cellsPtr = -1;
  let cellsLen = 0;
  let bumpPtr = -1;
  const handles: WasmFieldHandle[] = [];

  const subscribers: Array<(h: WasmFieldHandle) => void> = [];
  const refreshViews = (): void => {
    for (const h of handles) {
      h.current = new Float32Array(memory.buffer, h._curPtr, h.width * h.height);
      h.scratch = new Float32Array(memory.buffer, h._scrPtr, h.width * h.height);
      // Notify any owners (typically the Pheromone instance that
      // wraps this handle) so they can re-cache their .current /
      // .scratch references. Without this, the cached references
      // continue to point at the now-detached old ArrayBuffer and
      // any subsequent .slice() / read / write on them throws
      // "detached or out-of-bounds ArrayBuffer".
      for (const sub of subscribers) sub(h);
    }
  };

  const ensureMemory = (totalBytes: number): boolean => {
    const have = memory.buffer.byteLength;
    if (totalBytes <= have) return false;
    const need = Math.ceil((totalBytes - have) / 65536);
    memory.grow(need);
    return true;
  };

  const align16 = (n: number): number => (n + 15) & ~15;

  const runtime: PheromoneWasm = {
    allocField(width: number, height: number): WasmFieldHandle {
      if (bumpPtr < 0) {
        throw new Error('pheromone-wasm: uploadCells() must be called before allocField()');
      }
      const len = width * height;
      const bytes = len * 4;
      const curPtr = align16(bumpPtr);
      const scrPtr = align16(curPtr + bytes);
      bumpPtr = scrPtr + bytes;
      const grew = ensureMemory(bumpPtr);
      if (grew) refreshViews();
      const current = new Float32Array(memory.buffer, curPtr, len);
      const scratch = new Float32Array(memory.buffer, scrPtr, len);
      const handle: WasmFieldHandle = { width, height, current, scratch, _curPtr: curPtr, _scrPtr: scrPtr };
      handles.push(handle);
      return handle;
    },
    uploadCells(cells: Uint8Array): void {
      if (cellsPtr < 0) {
        // First call sets the layout. Subsequent calls just copy.
        cellsPtr = 16;
        cellsLen = cells.length;
        bumpPtr = align16(cellsPtr + cellsLen);
        const grew = ensureMemory(bumpPtr);
        if (grew) refreshViews();
      } else if (cells.length !== cellsLen) {
        throw new Error(
          `pheromone-wasm: cells size changed (${cellsLen} → ${cells.length}); `
          + 'world resize is not supported by the WASM kernel',
        );
      }
      new Uint8Array(memory.buffer, cellsPtr, cells.length).set(cells);
    },
    step(handle: WasmFieldHandle, f: number, e: number, cap: number): void {
      if (cellsPtr < 0) {
        throw new Error('pheromone-wasm: uploadCells() must be called before step()');
      }
      exports.step(
        handle._curPtr, handle._scrPtr, cellsPtr,
        handle.width, handle.height, f, e, cap,
      );
      // Swap front/back so the kernel's output becomes the next
      // tick's input. Field views point at the same byte offsets
      // forever; we just swap which one is "current".
      const tmpPtr = handle._curPtr;
      handle._curPtr = handle._scrPtr;
      handle._scrPtr = tmpPtr;
      const tmpView = handle.current;
      handle.current = handle.scratch;
      handle.scratch = tmpView;
    },
    onBuffersRefreshed(cb: (h: WasmFieldHandle) => void): void {
      subscribers.push(cb);
    },
  };
  return runtime;
}
