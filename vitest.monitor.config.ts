import { defineConfig } from 'vitest/config';

// Config used by `npm run test:monitor` — same as vitest.config.ts but
// WITHOUT the `tests/_monitor.test.ts` exclude. Lets the long-running
// diagnostic harness actually run when explicitly invoked.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
