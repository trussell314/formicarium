import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// Build-time identifiers surfaced in the HUD so a running tab can be
// distinguished from a fresh deploy. Wrapped in try/catch so a build
// outside a git checkout (e.g. tarball deploy) still succeeds — falls
// back to "unknown" + the wall clock at build time.
function gitRev(): string {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
}
function gitDirty(): string {
  try {
    const out = execSync('git status --porcelain').toString().trim();
    return out.length === 0 ? '' : '+';
  } catch { return ''; }
}
const BUILD_REV = gitRev() + gitDirty();
const BUILD_TIME = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// Project pages are served from /<repo>/, so we need a non-root base for the
// build. Local dev uses '/' so HMR + asset URLs work.
export default defineConfig({
  base: process.env.GITHUB_PAGES === '1' ? '/formicarium/' : '/',
  // Treat .wasm as a static asset so `import url from 'foo.wasm?url'` produces
  // a hashed file in dist/assets that we can fetch at runtime. Without this,
  // Vite tries to interpret the import as ES module + JS glue, which doesn't
  // round-trip the raw bytes the WebAssembly.instantiate() call needs.
  assetsInclude: ['**/*.wasm'],
  define: {
    __BUILD_REV__: JSON.stringify(BUILD_REV),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
