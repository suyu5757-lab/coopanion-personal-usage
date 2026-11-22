/**
 * The acceptance build: a real packaged app with its own identity, data root and profiles.
 *
 * It exists so a v5 bundle can be run beside the installed 0.4.0 app without either one touching
 * the other's data. The bundle id is a test identity only; it is not a Bank trusted issuer and
 * does not authorize production config or Bank writes. Hindsight stays read-only, telemetry and
 * the updater stay off, and the settings window opens by itself so a run does not depend on
 * macOS accessibility automation to reach the window it must observe.
 */
const { createHash } = require('node:crypto');
const { join } = require('node:path');

/** A run id names one acceptance data root; identity is derived so two runs never share one. */
function acceptanceIdentity(runId) {
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) {
    throw new Error('The Acceptance App has no valid runId');
  }
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 24);
  return { productName: `Coopanion 验收 ${runId}`, appId: `ai.pal.coopanion.acceptance.${suffix}` };
}

function acceptanceChannelConfig(appPackage, appData) {
  const build = appPackage?.coopanion;
  if (build?.channel !== 'acceptance') return null;
  const runId = typeof build.runId === 'string' ? build.runId : '';
  const identity = acceptanceIdentity(runId);
  if (appPackage.productName !== identity.productName) {
    throw new Error('The Acceptance App package name is invalid');
  }
  if (build.appId !== undefined && build.appId !== identity.appId) {
    throw new Error('The Acceptance App bundle identifier is invalid');
  }

  // The production window is opt-in and needs an explicit acknowledgement plus the bundle's
  // own run id. The Electron profile still lives under the acceptance root; only the Core's
  // home is the production data root, so the old app's Chromium profile is never reused.
  const production = process.env.COOPANION_ACCEPTANCE_PRODUCTION === '1';
  if (production && process.env.COOPANION_ACCEPTANCE_PRODUCTION_ACK !== 'READ_PRODUCTION_V5') {
    throw new Error('The production acceptance window needs COOPANION_ACCEPTANCE_PRODUCTION_ACK=READ_PRODUCTION_V5');
  }
  if (production && process.env.COOPANION_ACCEPTANCE_PRODUCTION_RUN_ID !== runId) {
    throw new Error('The production acceptance run id does not match the bundle run id');
  }
  const profileDir = join(appData, 'Coopanion Acceptance', runId);
  const dataDir = production ? join(appData, 'Coopanion') : profileDir;

  return {
    runId,
    appName: 'Coopanion 验收',
    productName: identity.productName,
    appId: identity.appId,
    production,
    dataDir,
    profileDir,
    settingsPartition: `persist:coopanion-acceptance-settings-${runId}`,
    browserPartition: `persist:coopanion-acceptance-browser-${runId}`,
    coreEnvironment: {
      COOPANION_ACCEPTANCE_CHANNEL: '1',
      COOPANION_HINDSIGHT_READ_ONLY: '1',
      COOPANION_MEMORY_DIAGNOSTICS: '1',
      COOPANION_SYSTEM_PROXY: '0',
      COOPANION_VOICE: '0',
      ...(production ? { COOPANION_PRODUCTION_ACCEPTANCE: '1' } : {}),
    },
  };
}

module.exports = { acceptanceChannelConfig, acceptanceIdentity };
