# SIMD / WASM implementation plan

> Status: deferred. The Web Worker refactor (commit `e7d7388`)
> already gives us 60fps render decoupled from sim work, which
> covers the most user-visible ergonomic complaint about
> performance. WASM is the next lever if the sustained-speed
> ceiling becomes the limiting factor in practice.

## Goal

Bring the MEDIUM-budget tick cost (480×270 / 500 ants / 10
pheromone fields) from ~4 ms back to ≤ 1 ms (the original
`CLAUDE.md` budget). Provide enough headroom that the worker
sustains 60-100× requested speed at MEDIUM without falling
behind, and keeps a margin for future biology features.

Headroom estimate after this work:

| Pass | Pure JS today | WASM SIMD target | Speedup |
|---|---|---|---|
| Pheromone step (10 fields) | ~50% of tick | ~12% of tick | 4× |
| Per-ant body | ~25% of tick | ~16% of tick | 1.6× |
| Collision pass | ~10% of tick | unchanged | — |
| Periodic sweeps | ~10% of tick | unchanged | — |
| Other | ~5% | unchanged | — |
| **Total** | 4.0 ms/tick | ~2.0 ms/tick | **2×** |

Most of the realistic win is in the pheromone step because it's
the hottest loop and is naturally vectorisable (data-parallel
stencil). The per-ant body benefits less because the inner loop
has many state-dependent branches.

## Approach

Two phases. Each phase ships an opt-in implementation behind a
feature gate so the JS fallback remains the canonical correctness
reference and CI keeps running both.

### Phase 1: pheromone step in WASM SIMD

Lowest risk, highest leverage. The 5-point-stencil loop in
`Pheromone.step()` reads four neighbours, does an FMA, applies a
clamp, writes the result. Each cell is independent of every other
cell within the same tick (we already use ping-pong buffers), so
the loop is embarrassingly parallel.

#### Tooling

Use **AssemblyScript** for the WASM module. Reasons:
- TypeScript-like syntax — minimal cognitive cost for the
  existing codebase.
- Direct `v128` SIMD intrinsics (`f32x4_add`, `f32x4_mul`, etc.).
- Produces small `.wasm` modules (typical ~10 KB) without a Rust
  toolchain.
- `npm install --save-dev assemblyscript` and a one-liner build
  script.

Alternatives considered:
- **Rust + wasm-pack**: best codegen but heavy toolchain (cargo,
  rustup, plus the wasm-pack glue). Overkill for ~50 lines of
  numerical code.
- **Hand-written WAT**: tightest output but most fragile to
  modify and maintain.
- **Emscripten / C**: same toolchain weight as Rust without the
  ergonomics.

#### Module surface

A single AssemblyScript module exporting one function:

```ts
export function pheromoneStep(
  src: usize,        // ptr to current Float32Array
  dst: usize,        // ptr to scratch Float32Array
  width: i32,
  height: i32,
  diffuse: f32,
  evaporate: f32,
  cap: f32,
): void;
```

The host (worker thread) keeps its existing `Pheromone` class but
calls into the WASM function for `step()`. The class still owns
the JS-side `Float32Array` views — we use `WebAssembly.Memory`
backed by a `SharedArrayBuffer` so the JS arrays and the WASM
memory point at the same bytes (no copies per step).

Edge cells stay in JS — they're 2(w+h-2) cells out of w×h, a few
percent of the work, and the WASM SIMD interior loop is cleaner
without the boundary special cases.

#### Internal loop sketch

```ts
// Process rows from y=1 to y=h-2, lanes of 4 cells horizontally.
for (let y: i32 = 1; y < h - 1; y++) {
  let i: i32 = y * w + 1;
  const rowEnd: i32 = y * w + w - 1;
  // Aligned 4-wide steps.
  while (i + 4 <= rowEnd) {
    const c   = v128.load(src + i*4);
    const xL  = v128.load(src + (i-1)*4);
    const xR  = v128.load(src + (i+1)*4);
    const yU  = v128.load(src + (i-w)*4);
    const yD  = v128.load(src + (i+w)*4);
    const sum = f32x4.add(f32x4.add(xL, xR), f32x4.add(yU, yD));
    let v = f32x4.add(
      f32x4.mul(f32x4.splat(1.0 - diffuse), c),
      f32x4.mul(f32x4.splat(diffuse * 0.25), sum)
    );
    v = f32x4.mul(v, f32x4.splat(evaporate));
    // clamp to [0, cap], with sub-1e-6 → 0 already handled by max
    v = f32x4.min(v, f32x4.splat(cap));
    v = f32x4.max(v, f32x4.splat(0));
    v128.store(dst + i*4, v);
    i += 4;
  }
  // Remainder lane scalar.
  while (i < rowEnd) { /* same arithmetic, scalar */ i++; }
}
```

#### Feature gate

`Pheromone.useWasmStep: boolean` — set on construction. Default
on if `WebAssembly.validate(SIMD_PROBE_BYTES)` returns true (most
modern browsers since 2022). Falls back to the existing JS
implementation on browsers without SIMD.

#### Persistence

Unchanged. The `current` Float32Array is still serialised to
base64 the same way; the SharedArrayBuffer behind it is
incidental.

#### Testing

Crucial: the JS and WASM versions must be byte-identical for
deterministic seeded runs. Add a test that creates two parallel
`Pheromone` instances (one JS, one WASM), runs N random
deposit-and-step cycles, asserts `bytesEqual(jsCurrent,
wasmCurrent)` on every step. The bench script grows a `--engine`
flag to A/B compare timings.

#### Estimated effort

- AssemblyScript build setup: 0.5 day.
- Module code: 0.5 day.
- Pheromone class plumbing + feature gate: 0.5 day.
- Determinism + bench tests: 0.5 day.
- **Total: ~2 days**, with a clear single-target deliverable.

Estimated speedup on pheromone step: **3-5×**. Total tick CPU at
MEDIUM drops from ~4 ms to ~2.5-3 ms.

### Phase 2: per-ant body in WASM (optional)

Materially harder, smaller win. The per-ant body has:
- Many state-dependent branches (REST / FORAGE / CARRY_FOOD /
  NECRO_CARRY / EGG / LARVA / QUEEN / WANDER + CARRY default).
- RNG calls — mulberry32 needs to be implemented identically in
  AssemblyScript (small, easy).
- Reads from many TypedArrays (Colony's 16+ arrays, World's
  cells/food/corpse/sprout/etc.).
- Writes to all of those arrays.

Because the branches are state-dependent, SIMD doesn't help —
ants in adjacent SoA slots usually take different paths. The
WASM win comes from removing JIT type-inference overhead and
inlining the math in tight loops, typically 1.5-2× on
JavaScript-heavy work.

#### Approach

Move the entire `step(world, colony, ...)` function from
`ant-rules.ts` into AssemblyScript. The Pheromone fields,
World, and Colony all become memory pointers; their JS-side
classes retain ownership of the SharedArrayBuffer-backed
TypedArrays.

Heaviest refactor in the project — about 2000 lines of
TypeScript needs an AssemblyScript twin. Several language
gotchas:
- AssemblyScript doesn't support complex type narrowing or
  union types; the state-machine `if (stateNow === STATE_X)`
  chains have to be rewritten as switch statements.
- Function calls have measurable overhead in AssemblyScript;
  hot helpers (`tryStep`, `adjacentSoil`, `placeGrain`) need
  to be inlined manually or marked `@inline`.
- AssemblyScript doesn't have closures — the per-ant
  scratch lambdas (e.g., the cargo-drop `for-each-offset`
  pattern) need to be expanded inline.

#### Estimated effort

- Initial port: 3-5 days (mechanical translation + debugging
  the determinism mismatches).
- Tooling for keeping JS/WASM ports in sync: 1 day.
- Cross-engine determinism tests across the full sim: 1 day.
- **Total: ~5-7 days** for one platform; recurring maintenance
  cost: every behavioural change needs to land in both ports.

Estimated speedup on per-ant body: **1.5-2×**. Total tick CPU
drops a further ~10-15% on top of phase 1.

#### Maintenance recommendation

Skip phase 2 unless phase 1 lands and the headroom still proves
inadequate in practice. The "two ports of the sim" maintenance
cost is real — biology features land slower because every
behavioural tweak has to be mirrored. Phase 1 doesn't have this
problem because the pheromone step's logic doesn't change.

## Rollout

1. Add `npm run build:wasm` script and check the `.wasm` artefact
   into git (small, opaque to Vite). Vite already supports
   `?init` imports for WASM modules.
2. Ship phase 1 behind a query-param opt-in (`?wasm=1`) for one
   release; promote to default once a soak run on the deploy
   target shows determinism + perf.
3. Bench script gains `--engine js | wasm` to publish A/B numbers
   in the bench output for any future PR that touches the
   pheromone math.

## Out of scope

- WebGPU compute. The pheromone step is a textbook compute-shader
  workload and would absolutely fly on a GPU, but: WebGPU is
  still not universally supported, the readback latency for
  per-frame snapshots would erase a lot of the win, and the
  worker-thread model already gives us the visible-fps
  improvement that motivated this work.
- Multi-threaded WASM (Workers + SharedArrayBuffer + Atomics
  inside the sim). Could shave another factor of 2 on multicore
  but at significant complexity, and would add a COOP/COEP
  deployment requirement. Defer until the sequential WASM ceiling
  becomes the practical limit.
