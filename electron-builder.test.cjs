const path = require('node:path');
const { cpSync, mkdirSync } = require('node:fs');

const root = __dirname;
const app = path.join(root, 'build', 'app');

module.exports = {
  extends: path.join(root, 'electron-builder.yml'),
  appId: 'ai.pal.coopanion.test',
  productName: 'Coopanion Test',
  directories: {
    app,
    output: path.join(root, 'dist', 'test'),
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
      ? path.join(appOutDir, 'Coopanion Test.app', 'Contents', 'Resources', 'app')
      : path.join(appOutDir, 'resources', 'app');
    const source = path.join(app, 'node_modules', 'pnpm', 'dist', 'node_modules');
    const destination = path.join(packagedApp, 'node_modules', 'pnpm', 'dist', 'node_modules');
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true });
  },
};
