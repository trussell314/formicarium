import { defineConfig } from 'vitest/config';

// `_monitor.test.ts` is a 540k-tick headless diagnostic harness that takes
// ~15 min wall time. Excluded from the default `npm test` so CI builds and
// `vitest run` stay quick. Run it explicitly when investigating the
// claustral-colony trajectory:
//
//   npx vitest run tests/_monitor.test.ts --testTimeout=1800000
//
// or
//
//   npm run test:monitor
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/_monitor.test.ts'],
  },
});
