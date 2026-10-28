import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';

export interface DarwinProcessIdentity {
  bundleId: string;
  executablePath: string;
  processStart: string;
}

export type MetadataCommand = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;

const execFile = promisify(execFileCallback);

const runMetadataCommand: MetadataCommand = async (file, args, signal) => {
  const { stdout } = await execFile(file, args, { timeout: 4_000, maxBuffer: 64 * 1024, signal });
  return String(stdout);
};

export function executableFromLsof(text: string): string | null {
  let descriptor = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('f')) {
      descriptor = line.slice(1).trim();
      continue;
    }
    if (line.startsWith('n') && (!descriptor || descriptor === 'txt')) {
      const path = line.slice(1).trim();
      if (path && isAbsolute(path) && !path.endsWith(' (deleted)')) return path;
    }
  }
  return null;
}

function appBundleForExecutable(path: string): string | null {
  const marker = '.app/Contents/MacOS/';
  const index = path.lastIndexOf(marker);
  return index > 0 ? path.slice(0, index + '.app'.length) : null;
}

export async function resolveDarwinProcessIdentity(
  pid: number,
  options: { platform?: string; run?: MetadataCommand; signal?: AbortSignal } = {},
): Promise<DarwinProcessIdentity | null> {
  if ((options.platform ?? process.platform) !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const run = options.run ?? runMetadataCommand;
  try {
    const [startOutput, lsofOutput] = await Promise.all([
      run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options.signal),
      run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], options.signal),
    ]);
    const processStart = startOutput.trim();
    const executablePath = executableFromLsof(lsofOutput);
    const appBundle = executablePath ? appBundleForExecutable(executablePath) : null;
    if (!processStart || processStart.length > 128 || !executablePath || !appBundle) return null;

    const bundleId = (await run('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleIdentifier', join(appBundle, 'Contents', 'Info.plist'),
    ], options.signal)).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(bundleId)) return null;
    return { bundleId, executablePath, processStart };
  } catch {
    return null;
  }
}
