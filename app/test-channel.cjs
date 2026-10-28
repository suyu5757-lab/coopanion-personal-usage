const { join } = require('node:path');

function testChannelConfig(build, appData) {
  if (build?.channel !== 'test') return null;
  const runId = typeof build.runId === 'string' ? build.runId : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('The Test App has no valid runId');
  if (build.productName !== 'Coopanion Test') throw new Error('The Test App package name is invalid');

  return {
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
      COOPANION_HINDSIGHT_TOKEN: '',
      COOPANION_HINDSIGHT_BANK: `coopanion-test:${runId}`,
      COOPANION_TTS_URL: 'http://127.0.0.1:19881/v1/audio/speech',
    },
  };
}

module.exports = { testChannelConfig };
