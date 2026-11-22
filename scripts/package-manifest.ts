import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type PackageFile =
  | { path: string; link: string }
  | { path: string; size: number; sha256: string };

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function fileInventory(root: string, rel = ''): PackageFile[] {
  const abs = join(root, rel);
  return readdirSync(abs).sort().flatMap((name) => {
    const child = join(rel, name);
    const path = join(root, child);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [{ path: child.split(sep).join('/'), link: readlinkSync(path) }];
    if (stat.isDirectory()) return fileInventory(root, child);
    return [{ path: child.split(sep).join('/'), size: stat.size, sha256: sha256(path) }];
  });
}

export interface FinalPackageManifestOptions {
  appPath: string;
  artifactPaths: string[];
  signatureVerified: boolean;
}

export function createFinalPackageManifest(options: FinalPackageManifestOptions): Record<string, unknown> {
  const appPath = resolve(options.appPath);
  const buildManifestPath = join(appPath, 'Contents', 'Resources', 'app', 'build-manifest.json');
  const staged = JSON.parse(readFileSync(buildManifestPath, 'utf8')) as {
    channel?: string;
    runId?: string;
    source?: { commit?: string; worktreeDirty?: boolean };
    platform?: Record<string, unknown>;
    app?: Record<string, unknown>;
    signature?: string;
    content?: { scope?: string; filesSha256?: string };
  };
  if ((staged.channel !== 'test' && staged.channel !== 'acceptance') || typeof staged.runId !== 'string' || !staged.runId) {
    throw new Error(`Expected an isolated app build manifest at ${buildManifestPath}`);
  }
  if (options.signatureVerified !== true) throw new Error('The isolated app signature was not verified');
  if (!options.artifactPaths.length) throw new Error('The isolated app has no installer artifacts to record');

  const artifacts = options.artifactPaths.map((rawPath) => {
    const path = resolve(rawPath);
    const rel = relative(appPath, path);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
      throw new Error(`Installer artifact must be outside the app bundle: ${path}`);
    }
    return { path: path.split(sep).join('/'), size: lstatSync(path).size, sha256: sha256(path) };
  });
  const files = fileInventory(appPath);

  return {
    schema: 'coopanion-final-package-manifest/v1',
    createdAt: new Date().toISOString(),
    runId: staged.runId,
    appPath: appPath.split(sep).join('/'),
    source: staged.source ?? null,
    platform: staged.platform ?? null,
    app: staged.app ?? null,
    signature: {
      configured: staged.signature ?? 'unknown',
      verification: 'passed',
      notarized: false,
    },
    stagedManifest: {
      path: 'Contents/Resources/app/build-manifest.json',
      sha256: sha256(buildManifestPath),
      contentScope: staged.content?.scope ?? 'staging inventory; not the final signed app',
      contentFilesSha256: staged.content?.filesSha256 ?? null,
    },
    appInventory: {
      fileCount: files.length,
      filesSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      files,
    },
    artifacts,
  };
}

export function writeFinalPackageManifest(path: string, options: FinalPackageManifestOptions): Record<string, unknown> {
  const manifest = createFinalPackageManifest(options);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
