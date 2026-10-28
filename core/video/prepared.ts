/** Copy a verified render into the media allowlist for a later, separately approved browser upload. */
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { discoverTools, inspectVideo, sha256File, type Probe, type Tools } from './render.ts';

export interface RenderReceipt {
  renderId: string;
  output: string;
  sha256: string;
  probe: Probe;
  tools: Tools;
}

export interface PreparedUpload {
  path: string;
  bytes: number;
  mime: 'video/mp4';
  sha256: string;
  probe: Probe;
}

const inside = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const renderIdValid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

async function checkedFile(root: string, file: string): Promise<string> {
  const rootAbsolute = resolve(root);
  const relativeFile = relative(rootAbsolute, resolve(file));
  if (!relativeFile || relativeFile.startsWith('..') || isAbsolute(relativeFile)) throw new Error('render file must stay inside the renders folder');
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  const parts = relativeFile.split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('render files and folders cannot be symbolic links');
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('render path parent is not a directory');
    if (index === parts.length - 1 && !info.isFile()) throw new Error('render output is not a regular file');
  }
  if (await realpath(current) !== current) throw new Error('render file path is not canonical');
  return current;
}

async function hasMp4Signature(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.toString('ascii', 4, 8) === 'ftyp';
  } finally {
    await handle.close();
  }
}

function sameProbe(left: Probe, right: Probe): boolean {
  return left.width === right.width && left.height === right.height && left.fps === right.fps
    && left.durationSec === right.durationSec && left.sizeBytes === right.sizeBytes
    && left.videoCodec === right.videoCodec && left.pixelFormat === right.pixelFormat
    && left.audioCodec === right.audioCodec;
}

async function removeCreatedDirectory(directory: string): Promise<void> {
  for (const name of ['render.mp4', 'receipt.json']) {
    const file = join(directory, name);
    try {
      const info = await lstat(file);
      if (info.isFile() && !info.isSymbolicLink()) await unlink(file);
    } catch { /* a failed or absent file needs no cleanup */ }
  }
  try { await rmdir(directory); } catch { /* preserve unexpected contents */ }
}

/** Re-verify the render before and after an exclusive copy into `media/prepared/<renderId>`. */
export async function prepareUpload(mediaDir: string, rendersDir: string, receipt: RenderReceipt): Promise<PreparedUpload> {
  if (!renderIdValid(receipt.renderId)) throw new Error('renderId is invalid');
  if (!/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.probe.sizeBytes) || receipt.probe.sizeBytes < 1) {
    throw new Error('render receipt is invalid');
  }
  const source = await checkedFile(rendersDir, receipt.output);
  const sourceInfo = await stat(source);
  if (sourceInfo.size !== receipt.probe.sizeBytes) throw new Error('render size changed after verification');
  if (await sha256File(source) !== receipt.sha256) throw new Error('render hash changed after verification');
  if (!await hasMp4Signature(source)) throw new Error('render is not an MP4 file');
  const tools = await discoverTools(receipt.tools.ffmpeg, receipt.tools.ffprobe);
  const sourceProbe = await inspectVideo(tools, source);
  if (!sameProbe(sourceProbe, receipt.probe)) throw new Error('render ffprobe result changed after verification');

  const canonicalMedia = await realpath(mediaDir);
  const mediaInfo = await lstat(canonicalMedia);
  if (!mediaInfo.isDirectory() || mediaInfo.isSymbolicLink()) throw new Error('media folder must be a real directory');
  const preparedRoot = join(canonicalMedia, 'prepared');
  try { await mkdir(preparedRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const preparedInfo = await lstat(preparedRoot);
  if (preparedInfo.isSymbolicLink() || !preparedInfo.isDirectory() || !inside(canonicalMedia, await realpath(preparedRoot))) {
    throw new Error('prepared folder must stay inside the media folder');
  }

  const destinationDir = join(preparedRoot, receipt.renderId);
  await mkdir(destinationDir, { mode: 0o700 });
  try {
    const destinationInfo = await lstat(destinationDir);
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()
      || !inside(canonicalMedia, await realpath(destinationDir))) throw new Error('prepared destination is not a real folder inside media');
    const destination = join(destinationDir, 'render.mp4');
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    const copiedInfo = await lstat(destination);
    if (copiedInfo.isSymbolicLink() || !copiedInfo.isFile() || copiedInfo.size !== receipt.probe.sizeBytes) {
      throw new Error('prepared MP4 size or file type did not match the render');
    }
    const copiedHash = await sha256File(destination);
    const checkedSourceAgain = await checkedFile(rendersDir, receipt.output);
    if (checkedSourceAgain !== source || copiedHash !== receipt.sha256 || await sha256File(source) !== receipt.sha256) {
      throw new Error('prepared MP4 hash did not match the render');
    }
    if (!await hasMp4Signature(destination)) throw new Error('prepared file is not an MP4');
    const copiedProbe = await inspectVideo(tools, destination);
    if (!sameProbe(copiedProbe, receipt.probe)) throw new Error('prepared MP4 ffprobe result did not match the render');

    const path = `prepared/${receipt.renderId}/render.mp4`;
    const prepared: PreparedUpload = { path, bytes: copiedInfo.size, mime: 'video/mp4', sha256: copiedHash, probe: copiedProbe };
    await writeFile(join(destinationDir, 'receipt.json'), `${JSON.stringify({
      schemaVersion: 1,
      renderId: receipt.renderId,
      source: relative(await realpath(rendersDir), source).split(sep).join('/'),
      path,
      bytes: prepared.bytes,
      mime: prepared.mime,
      sha256: prepared.sha256,
      probe: prepared.probe,
      tools: receipt.tools,
      preparedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return prepared;
  } catch (error) {
    await removeCreatedDirectory(destinationDir);
    throw error;
  }
}
