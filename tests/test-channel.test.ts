import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { testChannelConfig, testIdentity } = require('../app/test-channel.cjs') as {
  testIdentity(runId: string): { productName: string; appId: string };
  testChannelConfig(appPackage: Record<string, unknown>, appData: string): null | {
    runId: string;
    appName: string;
    productName: string;
    appId: string;
    dataDir: string;
    settingsPartition: string;
    browserPartition: string;
    coreEnvironment: Record<string, string>;
  };
};

describe('Test App channel', () => {
  it('does not select Test App state for another channel', () => {
    expect(testChannelConfig({ coopanion: { channel: 'github' }, productName: 'Coopanion' }, '/Users/test/Library/Application Support')).toBeNull();
  });

  it('binds app identity, profiles, and isolated service defaults to the runId', () => {
    const runId = 'r1-20261028-01';
    const appData = '/Users/test/Library/Application Support';
    const identity = testIdentity(runId);
    expect(identity.appId).toMatch(/^ai\.pal\.coopanion\.test\.[0-9a-f]{24}$/);
    expect(testIdentity('r1-20261028-02').appId).not.toBe(identity.appId);
    const config = testChannelConfig({ coopanion: { channel: 'test', runId, appId: identity.appId }, productName: identity.productName }, appData)!;

    expect(config).toMatchObject({
      runId,
      appName: 'Coopanion Test',
      productName: identity.productName,
      appId: identity.appId,
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

  it('accepts an earlier Test App package while retaining run-scoped paths', () => {
    const runId = 'r1-legacy';
    const appData = '/Users/test/Library/Application Support';
    const config = testChannelConfig({ coopanion: { channel: 'test', runId }, productName: 'Coopanion Test' }, appData)!;

    expect(config).toMatchObject({
      runId,
      appId: 'ai.pal.coopanion.test',
      dataDir: join(appData, 'Coopanion Test', runId),
    });
  });

  it('fails closed when the package has no valid runId or Test App name', () => {
    expect(() => testChannelConfig({ coopanion: { channel: 'test' }, productName: 'Coopanion Test' }, '/Users/test/Library/Application Support')).toThrow('runId');
    const identity = testIdentity('r1-test');
    expect(() => testChannelConfig({ coopanion: { channel: 'test', runId: 'r1-test', appId: identity.appId }, productName: 'Coopanion' }, '/Users/test/Library/Application Support')).toThrow('package name');
    expect(() => testChannelConfig({ coopanion: { channel: 'test', runId: 'r1-test', appId: 'ai.pal.coopanion.test' }, productName: identity.productName }, '/Users/test/Library/Application Support')).toThrow('bundle identifier');
  });
});
