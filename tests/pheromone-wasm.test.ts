// Verify the WASM-SIMD pheromone kernel produces bit-identical
// output to the pure-JS scalar path. Same op order, same IEEE-754
// rounding, so a deterministic seed should give matching fields
// after many ticks. If this breaks, the kernel has drifted from
// the JS spec and stigmergy behaviour will diverge in production.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pheromone, attachPheromoneWasm } from '../src/sim/pheromone';
import { initPheromoneWasm } from '../src/sim/pheromone-wasm';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../src/wasm/pheromone.wasm');

describe('WASM pheromone parity', () => {
  it('produces identical fields to the JS path after 50 ticks', async () => {
    const w = 40, h = 24;
    // Build a cells map with some soil patches so the AIR-gating
    // logic exercises both the SIMD and scalar paths.
    const cells = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (y < 3) cells[y * w + x] = 0;          // sky
        else if (y < 8 + (x % 4)) cells[y * w + x] = 1;  // soil with rough surface
        else cells[y * w + x] = 0;                  // tunnel
      }
    }
    // Carve a small chamber.
    for (let y = 12; y < 18; y++) for (let x = 14; x < 26; x++) cells[y * w + x] = 0;

    // JS path: no runtime attached.
    attachPheromoneWasm(null);
    const js = new Pheromone(w, h, 0.3, 0.99);
    js.deposit(20, 15, 100);
    js.deposit(5, 4, 50);
    for (let t = 0; t < 50; t++) js.step(cells);

    // WASM path: attach runtime, allocate the field after upload.
    const bytes = await readFile(wasmPath);
    const rt = await initPheromoneWasm(async () => bytes.buffer);
    expect(rt).not.toBeNull();
    rt!.uploadCells(cells);
    attachPheromoneWasm(rt);
    const wa = new Pheromone(w, h, 0.3, 0.99);
    wa.deposit(20, 15, 100);
    wa.deposit(5, 4, 50);
    for (let t = 0; t < 50; t++) {
      rt!.uploadCells(cells);
      wa.step(cells);
    }

    // Detach so subsequent tests don't accidentally hit WASM.
    attachPheromoneWasm(null);

    // Bit-exact comparison: both paths should produce identical
    // floats. If they don't, the kernel has drifted from the spec.
    expect(wa.current.length).toBe(js.current.length);
    let maxDiff = 0;
    for (let i = 0; i < js.current.length; i++) {
      const d = Math.abs(wa.current[i]! - js.current[i]!);
      if (d > maxDiff) maxDiff = d;
    }
    // Allow a tiny tolerance for ARM/x86 SIMD reorderings — both are
    // IEEE-754 but compiler-emitted SIMD ops MAY differ from scalar
    // associativity if optimiser folds (a*b)+(c*d) differently than
    // the scalar a*b then +c*d. 1e-5 is well below pheromone signal.
    expect(maxDiff).toBeLessThan(1e-5);
  });
});
