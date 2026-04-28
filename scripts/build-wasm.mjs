// Compile the AssemblyScript pheromone kernel to WASM.
//
// Run via `npm run build:wasm`. Outputs src/wasm/pheromone.wasm,
// which is loaded at runtime by src/sim/pheromone-wasm.ts.
//
// We pass --enable simd to ensure 128-bit SIMD instructions emit
// (the v128.* intrinsics in the source require it). --runtime stub
// strips the AS managed-runtime/GC because the kernel doesn't
// allocate; just raw memory ops on linear memory.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src/wasm/pheromone.ts');
const out = resolve(root, 'src/wasm/pheromone.wasm');

const args = [
  src,
  '--outFile', out,
  '--optimize',
  '--enable', 'simd',
  '--runtime', 'stub',
  '--exportRuntime',
  '--memoryBase', '0',
  '--initialMemory', '4',
];

const ascBin = resolve(root, 'node_modules/.bin/asc');
console.log(`> asc ${args.join(' ')}`);
const result = await exec(ascBin, args, { cwd: root });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
console.log(`✓ wrote ${out}`);
