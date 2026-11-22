/** Copy a verified render into the media allowlist for a later, separately approved browser upload. */
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

export interface PreparedUploadPlan extends PreparedUpload {
  mediaDir: string;
  rendersDir: string;
  canonicalMedia: string;
  preparedRoot: string;
  destinationDir: string;
  destination: string;
  render: RenderReceipt;
  preparedAt: string;
  receiptText: string;
  files: Array<{ path: string; digest: string; bytes: number; mime: string }>;
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

async function removeCreatedDirectory(directory: string, created: Array<{ name: string; dev: number; ino: number }>): Promise<void> {
  for (const file of created) {
    try {
      const info = await lstat(join(directory, file.name));
      if (info.isFile() && !info.isSymbolicLink() && info.dev === file.dev && info.ino === file.ino) {
        await unlink(join(directory, file.name));
      }
    } catch { /* a failed or replaced file is preserved */ }
  }
  try { await rmdir(directory); } catch { /* preserve unexpected contents */ }
}

const textDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

async function inspectPreparedRoot(canonicalMedia: string, preparedRoot: string): Promise<void> {
  try {
    const info = await lstat(preparedRoot);
    if (info.isSymbolicLink() || !info.isDirectory() || !inside(canonicalMedia, await realpath(preparedRoot))) {
      throw new Error('prepared folder must stay inside the media folder');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Checks the render and reserves an exact, new destination without writing files. */
export async function planPreparedUpload(
  mediaDir: string,
  rendersDir: string,
  receipt: RenderReceipt,
  preparedAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<PreparedUploadPlan> {
  if (signal?.aborted) throw new Error('preparation was interrupted');
  if (!renderIdValid(receipt.renderId)) throw new Error('renderId is invalid');
  if (!/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.probe.sizeBytes) || receipt.probe.sizeBytes < 1) {
    throw new Error('render receipt is invalid');
  }
  const source = await checkedFile(rendersDir, receipt.output);
  const sourceInfo = await stat(source);
  if (sourceInfo.size !== receipt.probe.sizeBytes) throw new Error('render size changed after verification');
  if (await sha256File(source, signal) !== receipt.sha256) throw new Error('render hash changed after verification');
  if (signal?.aborted) throw new Error('preparation was interrupted');
  if (!await hasMp4Signature(source)) throw new Error('render is not an MP4 file');
  const tools = await discoverTools(receipt.tools.ffmpeg, receipt.tools.ffprobe);
  const sourceProbe = await inspectVideo(tools, source, signal);
  if (!sameProbe(sourceProbe, receipt.probe)) throw new Error('render ffprobe result changed after verification');

  const canonicalMedia = await realpath(mediaDir);
  const mediaInfo = await lstat(canonicalMedia);
  if (!mediaInfo.isDirectory() || mediaInfo.isSymbolicLink()) throw new Error('media folder must be a real directory');
  const preparedRoot = join(canonicalMedia, 'prepared');
  await inspectPreparedRoot(canonicalMedia, preparedRoot);

  const destinationDir = join(preparedRoot, receipt.renderId);
  try {
    const info = await lstat(destinationDir);
    if (info.isSymbolicLink() || !info.isDirectory() || !inside(canonicalMedia, await realpath(destinationDir))) {
      throw new Error('prepared destination is not a real folder inside media');
    }
    throw new Error('prepared destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const path = `prepared/${receipt.renderId}/render.mp4`;
  const receiptText = `${JSON.stringify({
    schemaVersion: 1,
    renderId: receipt.renderId,
    source: relative(await realpath(rendersDir), source).split(sep).join('/'),
    path,
    bytes: sourceInfo.size,
    mime: 'video/mp4',
    sha256: receipt.sha256,
    probe: sourceProbe,
    tools: receipt.tools,
    preparedAt,
  }, null, 2)}\n`;
  const files = [
    { path, bytes: sourceInfo.size, mime: 'video/mp4', digest: receipt.sha256 },
    { path: `prepared/${receipt.renderId}/receipt.json`, bytes: Buffer.byteLength(receiptText), mime: 'application/json', digest: textDigest(receiptText) },
  ];
  return {
    mediaDir,
    rendersDir,
    canonicalMedia,
    preparedRoot,
    destinationDir,
    destination: join(destinationDir, 'render.mp4'),
    render: receipt,
    preparedAt,
    receiptText,
    files,
    path,
    bytes: sourceInfo.size,
    mime: 'video/mp4',
    sha256: receipt.sha256,
    probe: sourceProbe,
  };
}

/** Rechecks the plan and consumes its one-use grant immediately before creating the destination. */
export async function prepareUpload(plan: PreparedUploadPlan, beforeWrite: () => boolean, signal?: AbortSignal): Promise<PreparedUpload> {
  const current = await planPreparedUpload(plan.mediaDir, plan.rendersDir, plan.render, plan.preparedAt, signal);
  if (current.canonicalMedia !== plan.canonicalMedia || current.destination !== plan.destination
    || current.receiptText !== plan.receiptText || textDigest(JSON.stringify(current.files)) !== textDigest(JSON.stringify(plan.files))) {
    throw new Error('the prepared upload plan changed after approval');
  }
  if (!beforeWrite()) throw new Error('the prepared upload was not authorized for dispatch');

  let destinationCreated = false;
  const created: Array<{ name: string; dev: number; ino: number }> = [];
  let preparedRootCreated = false;
  try {
    try { await mkdir(plan.preparedRoot, { mode: 0o700 }); preparedRootCreated = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await inspectPreparedRoot(plan.canonicalMedia, plan.preparedRoot);
    if (signal?.aborted) throw new Error('preparation was interrupted');
    await mkdir(plan.destinationDir, { mode: 0o700 });
    destinationCreated = true;
    const destinationInfo = await lstat(plan.destinationDir);
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()
      || !inside(plan.canonicalMedia, await realpath(plan.destinationDir))) throw new Error('prepared destination is not a real folder inside media');
    const output = await open(plan.destination, 'wx', 0o600);
    const outputInfo = await output.stat();
    created.push({ name: 'render.mp4', dev: outputInfo.dev, ino: outputInfo.ino });
    try {
      const input = createReadStream(current.render.output, signal ? { signal } : undefined);
      for await (const chunk of input) {
        if (signal?.aborted) throw new Error('preparation was interrupted');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let written = 0;
        while (written < bytes.length) {
          const result = await output.write(bytes, written, bytes.length - written, null);
          if (result.bytesWritten < 1) throw new Error('prepared MP4 copy stopped before completion');
          written += result.bytesWritten;
        }
      }
      await output.sync();
    } finally {
      await output.close();
    }
    if (signal?.aborted) throw new Error('preparation was interrupted');
    const copiedInfo = await lstat(plan.destination);
    if (copiedInfo.isSymbolicLink() || !copiedInfo.isFile() || copiedInfo.size !== plan.bytes) {
      throw new Error('prepared MP4 size or file type did not match the render');
    }
    const copiedHash = await sha256File(plan.destination, signal);
    const checkedSourceAgain = await checkedFile(plan.rendersDir, current.render.output);
    if (checkedSourceAgain !== current.render.output || copiedHash !== plan.sha256 || await sha256File(checkedSourceAgain, signal) !== plan.sha256) {
      throw new Error('prepared MP4 hash did not match the render');
    }
    if (!await hasMp4Signature(plan.destination)) throw new Error('prepared file is not an MP4');
    const copiedProbe = await inspectVideo(current.render.tools, plan.destination, signal);
    if (!sameProbe(copiedProbe, plan.probe)) throw new Error('prepared MP4 ffprobe result did not match the render');
    await writeFile(join(plan.destinationDir, 'receipt.json'), plan.receiptText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const receiptPath = join(plan.destinationDir, 'receipt.json');
    const receiptInfo = await lstat(receiptPath);
    if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile()) throw new Error('prepared receipt is not a regular file');
    const expectedReceipt = plan.files.find((file) => file.path.endsWith('/receipt.json'));
    const receiptDigest = await sha256File(receiptPath, signal);
    if (!expectedReceipt || receiptInfo.size !== expectedReceipt.bytes || receiptDigest !== expectedReceipt.digest) {
      throw new Error('prepared receipt did not match its approved contents');
    }
    created.push({ name: 'receipt.json', dev: receiptInfo.dev, ino: receiptInfo.ino });
    if (signal?.aborted) throw new Error('preparation was interrupted');
    return { ...plan, path: plan.path, bytes: copiedInfo.size, mime: 'video/mp4', sha256: copiedHash, probe: copiedProbe };
  } catch (error) {
    if (destinationCreated) await removeCreatedDirectory(plan.destinationDir, created);
    if (preparedRootCreated) {
      try { await rmdir(plan.preparedRoot); } catch { /* retain a non-empty directory */ }
    }
    throw error;
  }
}
