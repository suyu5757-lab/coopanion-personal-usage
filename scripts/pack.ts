/**
 * Assembles `build/app/`, the directory electron-builder packages, then runs electron-builder.
 *
 * The workspace's pnpm layout (symlinked packages) is not what an installed app should carry, so
 * the app directory is built flat: the app code, the release notes, the staged Cortico copy, a `package.json` with
 * only the runtime dependencies installed by npm, and the three workspace packages copied into
 * `node_modules/` as real directories.
 *
 * Run: `pnpm run build:installer` (builds build/cortico first). Output: `dist/Coopanion-Setup-<version>.exe` on
 * Windows, `dist/Coopanion-<version>-mac-<arch>.dmg` and `.zip` on a Mac, `dist/Coopanion-<version>-linux-x64.AppImage`
 * and `.deb` on Linux. `PACK_ARCH` (x64 or arm64) builds for
 * another architecture than the machine's: npm installs that architecture's native packages (esbuild, sherpa-onnx) and
 * electron-builder packs that Electron, so one Apple silicon Mac builds both Mac downloads.
 *
 * `COOPANION_CHANNEL=steam` with `STEAM_APP_ID` builds for Steam instead: the app directory without an
 * installer (`dist/win-unpacked`, `dist/linux-unpacked`), which Steam installs and updates, carrying
 * steamworks.js for the Workshop (app/steam.cjs) and without the whale pack, which goes out through the Workshop.
 * `COOPANION_CHANNEL=portable` (Windows) builds the portable zip, `dist/Coopanion-<version>-win-x64-portable.zip`:
 * the app directory to unpack anywhere, without the updater. The channel and app id go into the app's package.json
 * as `coopanion` (app/main.cjs).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'build', 'app');
const run = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const ARCH = process.env.PACK_ARCH || process.arch;
const STEAM = process.env.COOPANION_CHANNEL === 'steam';
const TEST = process.env.COOPANION_CHANNEL === 'test';
const TEST_RUN_ID = String(process.env.COOPANION_TEST_RUN_ID ?? '');
if (TEST && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(TEST_RUN_ID)) {
  throw new Error('COOPANION_TEST_RUN_ID must be a short lowercase identifier');
}
const STEAM_APP_ID = Number(process.env.STEAM_APP_ID);
if (STEAM && !(Number.isInteger(STEAM_APP_ID) && STEAM_APP_ID > 0)) {
  console.error('COOPANION_CHANNEL=steam 需要 STEAM_APP_ID(Steamworks 后台的 App ID)');
  process.exit(1);
}
if (STEAM && process.platform !== 'win32' && process.platform !== 'linux') {
  console.error('Steam 版只在 Windows 和 Linux 上构建');
  process.exit(1);
}
const PORTABLE = process.env.COOPANION_CHANNEL === 'portable';
if (PORTABLE && process.platform !== 'win32') {
  console.error('便携版只在 Windows 上构建');
  process.exit(1);
}
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown> & {
  version: string;
  productName: string;
  devDependencies?: Record<string, string>;
};
const WORKSPACE = ['cortico-world-desktop-pet', 'cortico-world-opencode', 'cortico-provider-coo', 'cortico-world-codex'];
/**
 * Runtime dependencies: Core (express, ws, undici for the per-host system proxy), the TypeScript loader, pnpm for extension installs, the updater
 * (app/updater.cjs, not in the portable build) or for Steam steamworks.js (app/steam.cjs), and the workspace packages' own.
 */
const dependencySources = new Map<string, Set<string>>();
function addDependency(name: string, source: string): void {
  if (WORKSPACE.includes(name)) return;
  const sources = dependencySources.get(name) ?? new Set<string>();
  sources.add(source);
  dependencySources.set(name, sources);
}
for (const name of ['@vectorize-io/hindsight-client', 'express', 'ws', 'undici', 'tsx', 'pnpm']) addDependency(name, ROOT);
if (STEAM) addDependency('steamworks.js', ROOT);
else if (!PORTABLE && !TEST) addDependency('electron-updater', ROOT);
for (const name of WORKSPACE) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const source = join(ROOT, 'packages', name);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) addDependency(dependency, source);
}

function installedVersion(name: string): string {
  if (name === 'steamworks.js') return '0.4.0';
  const paths = [...dependencySources.get(name) ?? [], ROOT]
    .map((source) => join(source, 'node_modules', name, 'package.json'));
  const path = paths.find(existsSync);
  if (!path) throw new Error(`Runtime dependency ${name} is absent from the frozen workspace install`);
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

const DEPS = Object.fromEntries([...dependencySources.keys()].sort().map((name) => [name, installedVersion(name)])) as Record<string, string>;

/**
 * Git for Windows' MinGit, which the Windows build carries for the history of Coo's workspace (core/persona.ts;
 * app/main.cjs puts its cmd\ first on the Core's PATH). Pinned by version and SHA-256; the download is kept in
 * build/cache/.
 */
const MINGIT = {
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1/MinGit-2.56.0-64-bit.zip',
  sha256: '064b440ff870ed5198527e8f3a92cdf5bd2fd0fedf5e718af95e3fdaddeff718',
};

async function addMinGit(dir: string): Promise<void> {
  const cached = join(ROOT, 'build', 'cache', MINGIT.url.split('/').pop()!);
  if (!existsSync(cached)) {
    const res = await fetch(MINGIT.url);
    if (!res.ok) throw new Error(`MinGit 下载失败:HTTP ${res.status} ${MINGIT.url}`);
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  const zip = readFileSync(cached);
  const sum = createHash('sha256').update(zip).digest('hex');
  if (sum !== MINGIT.sha256) {
    rmSync(cached);
    throw new Error(`MinGit 校验不符:得到 ${sum},应为 ${MINGIT.sha256}`);
  }
  for (const [name, data] of Object.entries(unzipSync(zip))) {
    if (name.endsWith('/')) continue;
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  console.log(`MinGit ${relative(ROOT, dir)}`);
}

const skip = (base: string) => (src: string) => {
  const rel = relative(base, src).split(sep);
  // the top-level extensions/ of the staged Cortico is a junction to the developer's own data
  if (rel[0] === 'extensions') return false;
  // the Steam build's whale comes from the Workshop
  if (STEAM && rel[1] === 'whale' && (rel[0] === 'web' || rel[0] === 'examples')) return false;
  return !rel.some((p) => ['node_modules', '.git', 'test', 'tests', 'scratch'].includes(p));
};

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fileInventory(root: string, rel = ''): Array<Record<string, string | number>> {
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

function packageInventory(root: string, rel = ''): Array<{ path: string; name: string; version: string }> {
  const abs = join(root, rel);
  return readdirSync(abs).sort().flatMap((name) => {
    const child = join(rel, name);
    const path = join(root, child);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    if (stat.isDirectory()) return packageInventory(root, child);
    if (name !== 'package.json') return [];
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
    return pkg.name && pkg.version ? [{ path: child.split(sep).join('/'), name: pkg.name, version: pkg.version }] : [];
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'app'), join(OUT, 'app'), { recursive: true });
cpSync(join(ROOT, 'core'), join(OUT, 'core'), { recursive: true });
// the coopanion World (core/notice.ts) tells Coo these after an update
cpSync(join(ROOT, 'docs', 'releases'), join(OUT, 'docs', 'releases'), { recursive: true });
cpSync(join(ROOT, 'build', 'cortico'), join(OUT, 'build', 'cortico'), { recursive: true, filter: (src) => !src.endsWith('.map') && skip(join(ROOT, 'build', 'cortico'))(src) });
// the settings window (app/main.cjs serves it)
cpSync(join(ROOT, 'build', 'console'), join(OUT, 'build', 'console'), { recursive: true, filter: (src) => !src.endsWith('.map') });
// the page script of Coo's browser window (scripts/stage.ts builds it)
cpSync(join(ROOT, 'build', 'browser-agent.js'), join(OUT, 'build', 'browser-agent.js'));
// the coopanion World's panel bundle (core/companion.ts registers it)
cpSync(join(ROOT, 'build', 'panels'), join(OUT, 'build', 'panels'), { recursive: true, filter: (src) => !src.endsWith('.map') });
writeFileSync(join(OUT, 'package.json'), JSON.stringify({
  name: TEST ? 'coopanion-test' : rootPkg.name,
  productName: TEST ? 'Coopanion Test' : rootPkg.productName,
  version: rootPkg.version, description: rootPkg.description,
  license: rootPkg.license, author: rootPkg.author, homepage: rootPkg.homepage, type: 'module', main: 'app/main.cjs',
  dependencies: DEPS,
  coopanion: TEST ? { channel: 'test', runId: TEST_RUN_ID }
    : STEAM ? { channel: 'steam', steamAppId: STEAM_APP_ID }
      : { channel: PORTABLE ? 'portable' : 'github' },
}, null, 2));
run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', `--os=${process.platform}`, `--cpu=${ARCH}`], OUT);
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `--os=${process.platform}`, `--cpu=${ARCH}`], OUT);
if (STEAM) {
  // steamworks.js carries the Steam library of every platform; this build loads its own platform's
  const own = process.platform === 'win32' ? 'win64' : 'linux64';
  const dist = join(OUT, 'node_modules', 'steamworks.js', 'dist');
  for (const dir of ['win64', 'linux64', 'osx']) if (dir !== own) rmSync(join(dist, dir), { recursive: true, force: true });
}
const stagedPackage = JSON.parse(readFileSync(join(OUT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  productName: string;
  version: string;
};
for (const name of WORKSPACE) {
  const from = join(ROOT, 'packages', name);
  cpSync(from, join(OUT, 'node_modules', name), { recursive: true, filter: skip(from) });
  // listed only now: npm must not fetch them, but electron-builder ships only listed dependencies
  stagedPackage.dependencies[name] = (JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')) as { version: string }).version;
}
writeFileSync(join(OUT, 'package.json'), JSON.stringify(stagedPackage, null, 2));
if (process.platform === 'win32') await addMinGit(join(OUT, 'mingit'));
const packageLock = join(OUT, 'package-lock.json');
const fileManifest = fileInventory(OUT);
const sourceCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain=v1'], { encoding: 'utf8' }).trim().length > 0;
const driverBinary = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver';
const buildManifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  channel: TEST ? 'test' : STEAM ? 'steam' : PORTABLE ? 'portable' : 'github',
  ...(TEST ? { runId: TEST_RUN_ID } : {}),
  source: { commit: sourceCommit, worktreeDirty: sourceDirty },
  platform: { os: process.platform, architecture: ARCH, node: process.version, electron: rootPkg.devDependencies?.electron ?? null },
  app: { productName: stagedPackage.productName, version: stagedPackage.version, appId: TEST ? 'ai.pal.coopanion.test' : 'ai.pal.coopanion' },
  signature: process.platform === 'darwin' ? 'ad-hoc (identity -); not notarized' : 'platform default; not attested',
  npmResolvedLockSha256: existsSync(packageLock) ? sha256(packageLock) : null,
  directRuntimeDependencies: Object.fromEntries(Object.entries(stagedPackage.dependencies).sort(([a], [b]) => a.localeCompare(b))),
  installedPackages: packageInventory(join(OUT, 'node_modules')).sort((a, b) => a.path.localeCompare(b.path)),
  externalRuntimes: existsSync(driverBinary) ? [{ name: 'Cua Driver', path: driverBinary, sha256: sha256(driverBinary) }] : [],
  content: {
    files: fileManifest,
    filesSha256: createHash('sha256').update(JSON.stringify(fileManifest)).digest('hex'),
  },
};
writeFileSync(join(OUT, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2) + '\n');
console.log(`app directory ready: ${relative(ROOT, OUT)}`);

const target = process.platform === 'darwin' ? '--mac' : process.platform === 'linux' ? '--linux' : '--win';
run(join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'), [target, ...PORTABLE ? ['zip'] : [], `--${ARCH}`, ...STEAM ? ['--dir'] : [], ...(TEST ? ['--projectDir', OUT, '--config', join(ROOT, 'electron-builder.test.cjs')] : []), '--publish', 'never', ...process.argv.slice(2)], TEST ? OUT : ROOT);

if (STEAM) {
  // electron-builder takes node_modules from the pnpm workspace's dependency graph, which has no steamworks.js and
  // has the workspace packages as they are in packages/ (the whale included): the Steam build ships build/app's
  const shipped = join(ROOT, 'dist', `${process.platform === 'win32' ? 'win' : 'linux'}-unpacked`, 'resources', 'app', 'node_modules');
  rmSync(shipped, { recursive: true, force: true });
  cpSync(join(OUT, 'node_modules'), shipped, { recursive: true });
  console.log(`node_modules of ${relative(ROOT, OUT)} copied into ${relative(ROOT, shipped)}`);
}
