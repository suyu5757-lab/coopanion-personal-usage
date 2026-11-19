const path = require('node:path');
const { cpSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { acceptanceIdentity } = require('./app/acceptance-channel.cjs');

const root = __dirname;
const runId = process.env.COOPANION_ACCEPTANCE_RUN_ID;
const identity = acceptanceIdentity(runId);
const app = path.join(root, 'build', 'acceptance-app', runId);
const stagedPackage = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
if (stagedPackage.productName !== identity.productName || stagedPackage.coopanion?.appId !== identity.appId) {
  throw new Error('The staged Acceptance App identity does not match COOPANION_ACCEPTANCE_RUN_ID');
}

module.exports = {
  extends: path.join(root, 'electron-builder.yml'),
  appId: identity.appId,
  productName: identity.productName,
  directories: {
    app,
    buildResources: path.join(root, 'app', 'icons'),
    output: path.join(root, 'dist', 'acceptance', runId),
  },
  publish: null,
  win: {
    artifactName: 'Coopanion-Acceptance-${version}-${arch}.${ext}',
  },
  nsis: {
    runAfterFinish: false,
    artifactName: 'Coopanion-Acceptance-Setup-${version}.exe',
  },
  mac: {
    artifactName: 'Coopanion-Acceptance-${version}-mac-${arch}.${ext}',
  },
  linux: {
    artifactName: 'Coopanion-Acceptance-${version}-linux-${arch}.${ext}',
  },
  afterPack: async ({ appOutDir, electronPlatformName }) => {
    const packagedApp = electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${identity.productName}.app`, 'Contents', 'Resources', 'app')
      : path.join(appOutDir, 'resources', 'app');
    for (const file of [
      'build/cortico/package.json',
      'build/console/index.html',
      'build/browser-agent.js',
      'build/panels/coopanion/webui.js',
    ]) {
      if (!existsSync(path.join(packagedApp, file))) {
        throw new Error(`The packaged Acceptance App is missing ${file}`);
      }
    }
    const source = path.join(app, 'node_modules', 'pnpm', 'dist', 'node_modules');
    const destination = path.join(packagedApp, 'node_modules', 'pnpm', 'dist', 'node_modules');
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true });
  },
};
