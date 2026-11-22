import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFinalPackageManifest } from '../scripts/package-manifest.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coopanion-final-package-'));
  roots.push(root);
  const appPath = join(root, 'Coopanion Test.app');
  const resources = join(appPath, 'Contents', 'Resources', 'app');
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, 'build-manifest.json'), JSON.stringify({
    channel: 'test',
    runId: 'r1-fixture',
    source: { commit: 'fixture-source', worktreeDirty: false },
    platform: { os: 'darwin', architecture: 'arm64' },
    app: { appId: 'ai.pal.coopanion.test.fixture', version: '0.4.0' },
    signature: 'ad-hoc (identity -); not notarized',
    content: { scope: 'staged-app-directory-before-electron-builder', filesSha256: 'stage-hash' },
  }));
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(appPath, 'Contents', 'Info.plist'), 'bundle metadata');
  writeFileSync(join(appPath, 'Contents', 'MacOS', 'Coopanion'), 'executable bytes');
  symlinkSync('../MacOS/Coopanion', join(appPath, 'Contents', 'Resources', 'launcher'));
  const artifactPath = join(root, 'Coopanion-Test-fixture.zip');
  writeFileSync(artifactPath, 'installer bytes');
  return { root, appPath, artifactPath };
}

describe('final Test App package manifest', () => {
  it('hashes the signed app tree and installer artifacts outside the bundle', () => {
    const { appPath, artifactPath } = fixture();
    const manifest = createFinalPackageManifest({ appPath, artifactPaths: [artifactPath], signatureVerified: true });
    const inventory = manifest.appInventory as { fileCount: number; filesSha256: string; files: Array<Record<string, unknown>> };

    expect(manifest.schema).toBe('coopanion-final-package-manifest/v1');
    expect(manifest.runId).toBe('r1-fixture');
    expect(manifest.signature).toMatchObject({ verification: 'passed', notarized: false });
    expect(inventory.fileCount).toBe(4);
    expect(inventory.filesSha256).toBe(createHash('sha256').update(JSON.stringify(inventory.files)).digest('hex'));
    expect(inventory.files.some((file) => file.path === 'Contents/Resources/launcher' && file.link === '../MacOS/Coopanion')).toBe(true);
    expect((manifest.artifacts as Array<{ path: string; size: number; sha256: string }>)[0]).toMatchObject({
      path: artifactPath,
      size: Buffer.byteLength('installer bytes'),
      sha256: createHash('sha256').update('installer bytes').digest('hex'),
    });
  });

  it('rejects an unverified signature and installer artifacts inside the app bundle', () => {
    const { appPath, artifactPath } = fixture();
    expect(() => createFinalPackageManifest({ appPath, artifactPaths: [artifactPath], signatureVerified: false })).toThrow(/signature was not verified/);
    expect(() => createFinalPackageManifest({ appPath, artifactPaths: [join(appPath, 'Contents', 'Info.plist')], signatureVerified: true })).toThrow(/outside the app bundle/);
  });
});
