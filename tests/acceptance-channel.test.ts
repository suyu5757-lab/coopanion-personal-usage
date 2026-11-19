import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { acceptanceChannelConfig, acceptanceIdentity } = require('../app/acceptance-channel.cjs') as {
  acceptanceIdentity(runId: string): { productName: string; appId: string };
  acceptanceChannelConfig(appPackage: Record<string, unknown>, appData: string): null | {
    runId: string;
    appName: string;
    productName: string;
    appId: string;
    dataDir: string;
    profileDir: string;
    production: boolean;
    settingsPartition: string;
    browserPartition: string;
    coreEnvironment: Record<string, string>;
  };
};

describe('Acceptance App channel', () => {
  it('does not select acceptance state for another channel', () => {
    expect(acceptanceChannelConfig({ coopanion: { channel: 'github' }, productName: 'Coopanion' }, '/Users/test/Library/Application Support')).toBeNull();
  });

  it('binds identity, profiles, and isolated data to the runId', () => {
    const runId = 'rev29-20261115-01';
    const appData = '/Users/test/Library/Application Support';
    const identity = acceptanceIdentity(runId);
    expect(identity.appId).toMatch(/^ai\.pal\.coopanion\.acceptance\.[0-9a-f]{24}$/);
    expect(acceptanceIdentity('rev29-20261115-02').appId).not.toBe(identity.appId);
    const config = acceptanceChannelConfig({ coopanion: { channel: 'acceptance', runId, appId: identity.appId }, productName: identity.productName }, appData)!;

    expect(config).toMatchObject({
      runId,
      appName: 'Coopanion 验收',
      productName: identity.productName,
      appId: identity.appId,
      dataDir: join(appData, 'Coopanion Acceptance', runId),
      profileDir: join(appData, 'Coopanion Acceptance', runId),
      production: false,
      settingsPartition: `persist:coopanion-acceptance-settings-${runId}`,
      browserPartition: `persist:coopanion-acceptance-browser-${runId}`,
      coreEnvironment: {
        COOPANION_ACCEPTANCE_CHANNEL: '1',
        COOPANION_HINDSIGHT_READ_ONLY: '1',
        COOPANION_MEMORY_DIAGNOSTICS: '1',
        COOPANION_SYSTEM_PROXY: '0',
        COOPANION_VOICE: '0',
      },
    });
    expect(config.dataDir).not.toBe(join(appData, 'Coopanion'));
    expect(config.dataDir).not.toContain(`${join(appData, 'Coopanion')}/`);
  });

  it('selects the production data root only under the explicit acknowledgement', () => {
    const runId = 'rev29-production-test';
    const appData = '/Users/test/Library/Application Support';
    const identity = acceptanceIdentity(runId);
    const pkg = { coopanion: { channel: 'acceptance', runId, appId: identity.appId }, productName: identity.productName };
    const saved = { ...process.env };
    try {
      process.env.COOPANION_ACCEPTANCE_PRODUCTION = '1';
      expect(() => acceptanceChannelConfig(pkg, appData)).toThrow('COOPANION_ACCEPTANCE_PRODUCTION_ACK');
      process.env.COOPANION_ACCEPTANCE_PRODUCTION_ACK = 'READ_PRODUCTION_V5';
      expect(() => acceptanceChannelConfig(pkg, appData)).toThrow('run id');
      process.env.COOPANION_ACCEPTANCE_PRODUCTION_RUN_ID = runId;
      const config = acceptanceChannelConfig(pkg, appData)!;
      expect(config.production).toBe(true);
      expect(config.dataDir).toBe(join(appData, 'Coopanion'));
      expect(config.profileDir).toBe(join(appData, 'Coopanion Acceptance', runId));
      expect(config.coreEnvironment.COOPANION_PRODUCTION_ACCEPTANCE).toBe('1');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('fails closed when the package has no valid runId or acceptance name', () => {
    expect(() => acceptanceChannelConfig({ coopanion: { channel: 'acceptance' }, productName: 'Coopanion 验收' }, '/Users/test/Library/Application Support')).toThrow('runId');
    const identity = acceptanceIdentity('rev29-test');
    expect(() => acceptanceChannelConfig({ coopanion: { channel: 'acceptance', runId: 'rev29-test', appId: identity.appId }, productName: 'Coopanion' }, '/Users/test/Library/Application Support')).toThrow('package name');
    expect(() => acceptanceChannelConfig({ coopanion: { channel: 'acceptance', runId: 'rev29-test', appId: 'ai.pal.coopanion.acceptance.nope' }, productName: identity.productName }, '/Users/test/Library/Application Support')).toThrow('bundle identifier');
  });
});
