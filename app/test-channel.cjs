const { createHash } = require('node:crypto');
const { join } = require('node:path');

function testIdentity(runId) {
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) {
    throw new Error('The Test App has no valid runId');
  }
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 24);
  return { productName: `Coopanion Test ${runId}`, appId: `ai.pal.coopanion.test.${suffix}` };
}

function testChannelConfig(appPackage, appData) {
  const build = appPackage?.coopanion;
  if (build?.channel !== 'test') return null;
  const runId = typeof build.runId === 'string' ? build.runId : '';
  const runIdentity = testIdentity(runId);
  const identity = build.appId === undefined
    ? { productName: 'Coopanion Test', appId: 'ai.pal.coopanion.test' }
    : runIdentity;
  if (appPackage.productName !== identity.productName) {
    throw new Error('The Test App package name is invalid');
  }
  if (build.appId !== undefined && build.appId !== identity.appId) {
    throw new Error('The Test App bundle identifier is invalid');
  }

  // A Test App stays memory-off unless the operator names a loopback Hindsight stub
  // and a test bank for this run. Nothing here can point at a real bank.
  const hindsightOn = process.env.COOPANION_TEST_HINDSIGHT === '1';
  const hindsightUrl = hindsightOn ? String(process.env.COOPANION_TEST_HINDSIGHT_URL ?? '').trim() : '';
  const hindsightBank = hindsightOn ? String(process.env.COOPANION_TEST_HINDSIGHT_BANK ?? '').trim() : '';
  if (hindsightOn && (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(hindsightUrl)
    || !/^coopanion-test:/.test(hindsightBank))) {
    throw new Error('The Test App Hindsight stub needs a loopback URL and a coopanion-test bank');
  }

  return {
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
      ...(hindsightOn ? {
        COOPANION_HINDSIGHT: '1',
        COOPANION_HINDSIGHT_URL: hindsightUrl,
        COOPANION_HINDSIGHT_TOKEN: '',
        COOPANION_HINDSIGHT_BANK: hindsightBank,
      } : {
        COOPANION_HINDSIGHT: '0',
        COOPANION_HINDSIGHT_URL: 'http://127.0.0.1:18888',
        COOPANION_HINDSIGHT_TOKEN: '',
        COOPANION_HINDSIGHT_BANK: `coopanion-test:${runId}`,
      }),
      COOPANION_TTS_URL: 'http://127.0.0.1:19881/v1/audio/speech',
    },
  };
}

module.exports = { testChannelConfig, testIdentity };
