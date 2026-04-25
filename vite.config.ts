import { defineConfig } from 'vite';

// Project pages are served from /<repo>/, so we need a non-root base for the
// build. Local dev uses '/' so HMR + asset URLs work.
export default defineConfig({
  base: process.env.GITHUB_PAGES === '1' ? '/formicarium/' : '/',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
