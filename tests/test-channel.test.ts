import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { testChannelConfig } = require('../app/test-channel.cjs') as {
  testChannelConfig(build: Record<string, unknown>, appData: string): null | {
    runId: string;
    appName: string;
    appId: string;
    dataDir: string;
    settingsPartition: string;
    browserPartition: string;
    coreEnvironment: Record<string, string>;
  };
};

describe('Test App channel', () => {
  it('does not select Test App state for another channel', () => {
    expect(testChannelConfig({ channel: 'github', productName: 'Coopanion' }, '/Users/test/Library/Application Support')).toBeNull();
  });

  it('binds app identity, profiles, and isolated service defaults to the runId', () => {
    const runId = 'r1-20261028-01';
    const appData = '/Users/test/Library/Application Support';
    const config = testChannelConfig({ channel: 'test', runId, productName: 'Coopanion Test' }, appData)!;

    expect(config).toMatchObject({
      runId,
      appName: 'Coopanion Test',
      appId: 'ai.pal.coopanion.test',
      dataDir: join(appData, 'Coopanion Test', runId),
      settingsPartition: `persist:coopanion-settings-${runId}`,
      browserPartition: `persist:coo-browser-${runId}`,
      coreEnvironment: {
        CORTICO_TEST_CHANNEL: '1',
        COOPANION_TEST_CHANNEL: '1',
        COOPANION_HINDSIGHT: '0',
        COOPANION_HINDSIGHT_URL: 'http://127.0.0.1:18888',
        COOPANION_TTS_URL: 'http://127.0.0.1:19881/v1/audio/speech',
      },
    });
    expect(config.dataDir).not.toBe(join(appData, 'Coopanion'));
  });

  it('fails closed when the package has no valid runId or Test App name', () => {
    expect(() => testChannelConfig({ channel: 'test', productName: 'Coopanion Test' }, '/Users/test/Library/Application Support')).toThrow('runId');
    expect(() => testChannelConfig({ channel: 'test', runId: 'r1-test', productName: 'Coopanion' }, '/Users/test/Library/Application Support')).toThrow('package name');
  });
});
