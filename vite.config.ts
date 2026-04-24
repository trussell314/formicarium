import { defineConfig } from 'vite';

// GitHub Pages serves project sites under /<repo-name>/, so use a relative
// base in production builds. Override with VITE_BASE for custom hosting.
const base = process.env.VITE_BASE ?? (process.env.GITHUB_PAGES === '1' ? '/formicarium/' : '/');

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
