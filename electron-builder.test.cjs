const path = require('node:path');
const { cpSync, mkdirSync, readFileSync } = require('node:fs');
const { testIdentity } = require('./app/test-channel.cjs');

const root = __dirname;
const runId = process.env.COOPANION_TEST_RUN_ID;
const identity = testIdentity(runId);
const app = path.join(root, 'build', 'test-app', runId);
const stagedPackage = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
if (stagedPackage.productName !== identity.productName || stagedPackage.coopanion?.appId !== identity.appId) {
  throw new Error('The staged Test App identity does not match COOPANION_TEST_RUN_ID');
}

module.exports = {
  extends: path.join(root, 'electron-builder.yml'),
  appId: identity.appId,
  productName: identity.productName,
  directories: {
    app,
    output: path.join(root, 'dist', 'test', runId),
  },
  publish: null,
  win: {
    artifactName: 'Coopanion-Test-${version}-${arch}.${ext}',
  },
  nsis: {
    runAfterFinish: false,
    artifactName: 'Coopanion-Test-Setup-${version}.exe',
  },
  mac: {
    artifactName: 'Coopanion-Test-${version}-mac-${arch}.${ext}',
  },
  linux: {
    artifactName: 'Coopanion-Test-${version}-linux-${arch}.${ext}',
  },
  afterPack: async ({ appOutDir, electronPlatformName }) => {
    const packagedApp = electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${identity.productName}.app`, 'Contents', 'Resources', 'app')
      : path.join(appOutDir, 'resources', 'app');
    const source = path.join(app, 'node_modules', 'pnpm', 'dist', 'node_modules');
    const destination = path.join(packagedApp, 'node_modules', 'pnpm', 'dist', 'node_modules');
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true });
  },
};
