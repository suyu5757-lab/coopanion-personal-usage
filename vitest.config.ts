import { defineConfig } from 'vitest/config';
import { CORTICO_ALIAS, decodeFileUrlIds } from './vitest.shared.ts';

export default defineConfig({
  plugins: [decodeFileUrlIds],
  resolve: { alias: CORTICO_ALIAS },
  // what scripts/stage.ts defines when it builds the settings window (console/app-version.ts)
  define: { COOPANION_VERSION: JSON.stringify('0.0.0'), COOPANION_CHANNEL: JSON.stringify('github') },
  test: {
    setupFiles: ['tests/setup/jsdom-storage.ts'],
    include: ['tests/**/*.test.{ts,js}', 'packages/cortico-provider-coo/tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    // a busy Windows runner takes longer than the 1 s default to reach what a poll waits for
    expect: { poll: { timeout: 10_000 } },
    pool: 'forks',
  },
});
