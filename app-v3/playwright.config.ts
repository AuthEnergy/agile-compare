import { defineConfig } from '@playwright/test';

// e2e runs against the BUILT single file (v3/index.html) loaded via file://, so
// the tests exercise the exact artifact that ships — including CSP enforcement —
// not a dev-server transform of the source. Octopus calls are mocked per-test.
export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    trace: 'off',
  },
});
