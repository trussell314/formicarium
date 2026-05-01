import { defineConfig } from 'vitest/config';

// Long-running diagnostic tests excluded from the default `npm test`:
//   • _monitor.test.ts             ~15 min — claustral colony trajectory
//   • _smoke-compression.test.ts   ~2 min  — time-compression dial smoke
//
// Run them explicitly:
//   npx vitest run tests/_monitor.test.ts --testTimeout=1800000
//   npx vitest run tests/_smoke-compression.test.ts --testTimeout=600000
//   npm run test:monitor
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/_monitor.test.ts',
      'tests/_smoke-compression.test.ts',
    ],
  },
});
