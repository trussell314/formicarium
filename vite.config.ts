import { defineConfig } from 'vite';

// Project pages are served from /<repo>/, so we need a non-root base for the
// build. Local dev uses '/' so HMR + asset URLs work.
export default defineConfig({
  base: process.env.GITHUB_PAGES === '1' ? '/formicarium/' : '/',
  // Treat .wasm as a static asset so `import url from 'foo.wasm?url'` produces
  // a hashed file in dist/assets that we can fetch at runtime. Without this,
  // Vite tries to interpret the import as ES module + JS glue, which doesn't
  // round-trip the raw bytes the WebAssembly.instantiate() call needs.
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
