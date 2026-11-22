const { closeSync, constants, createReadStream, fstatSync, lstatSync, linkSync, openSync, readSync, realpathSync, unlinkSync } = require('node:fs');
const { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isPublicHttp } = require('./browser-network-policy.cjs');

const MAX_MEDIA_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MIME_FORMATS = new Map([
  ['image/png', ['png']],
  ['image/jpeg', ['jpeg']],
  ['image/webp', ['webp']],
  ['image/gif', ['gif']],
  ['image/avif', ['avif']],
  ['video/mp4', ['mp4', 'm4v']],
  ['video/quicktime', ['mov']],
  ['video/webm', ['webm']],
  ['video/x-matroska', ['mkv']],
  ['video/x-msvideo', ['avi']],
]);
const EXTENSION_FORMATS = new Map([
  ['.png', 'png'], ['.jpg', 'jpeg'], ['.jpeg', 'jpeg'], ['.webp', 'webp'], ['.gif', 'gif'], ['.avif', 'avif'],
  ['.mp4', 'mp4'], ['.m4v', 'mp4'], ['.mov', 'mov'], ['.webm', 'webm'], ['.mkv', 'mkv'], ['.avi', 'avi'],
]);

function isMediaDownloadUrl(value) {
  return isPublicHttp(value);
}

function mediaDownloadRedirectsAllowed(requestedUrl, chain) {
  if (!isMediaDownloadUrl(requestedUrl) || !Array.isArray(chain) || chain.length < 1 || chain.length > 10) return false;
  let requested;
  try { requested = new URL(requestedUrl); } catch { return false; }
  requested.hash = '';
  let first;
  try { first = new URL(chain[0]); } catch { return false; }
  first.hash = '';
  if (first.href !== requested.href) return false;
  for (const item of chain) {
    let url;
    try { url = new URL(item); } catch { return false; }
    if (!isMediaDownloadUrl(url.href) || url.origin !== requested.origin) return false;
  }
  return true;
}

function existingDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('choose an existing absolute directory');
  if (value.split(sep).includes('..')) throw new Error('download directory cannot contain a parent path component');
  const normalized = resolve(value);
  const root = parse(normalized).root;
  let current = root;
  for (const part of relative(root, normalized).split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) throw new Error('download directory cannot contain a symbolic link');
  }
  const info = lstatSync(normalized);
  if (!info.isDirectory()) throw new Error('download target must be an existing directory');
  return realpathSync(normalized);
}

function safeMediaFilename(value) {
  if (typeof value !== 'string' || !value) throw new Error('choose a filename up to 240 bytes');
  const name = value.normalize('NFC').trim();
  if (Buffer.byteLength(name, 'utf8') > 240) throw new Error('choose a filename up to 240 bytes');
  if (!name || name === '.' || name === '..' || name !== basename(name) || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('filename must be a single safe path component');
  }
  if (name.endsWith('.') || name.endsWith(' ')) throw new Error('filename cannot end with a dot or space');
  const extension = extname(name).toLowerCase();
  if (!EXTENSION_FORMATS.has(extension)) throw new Error('choose a supported image or video filename extension');
  const stem = basename(name, extname(name)).replace(/[ .]+$/g, '').toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) throw new Error('filename is reserved by the filesystem');
  return { name, extension, format: EXTENSION_FORMATS.get(extension) };
}

function mediaFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (bytes.toString('ascii', 8, 12) === 'AVI ') return 'avi';
  }
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) return 'gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand === 'qt  ') return 'mov';
    if (brand.startsWith('m4v')) return 'mp4';
    if (/^(?:isom|iso[2-9]|mp4[12]|avc1|dash|msnv|3gp[4-9])$/.test(brand)) return 'mp4';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const header = bytes.toString('ascii', 0, Math.min(bytes.length, 128));
    if (header.includes('webm')) return 'webm';
    if (header.includes('matroska')) return 'mkv';
  }
  return null;
}

async function hashFile(file, expectedBytes) {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  if (bytes !== expectedBytes) throw new Error('downloaded file changed while being checked');
  return digest.digest('hex');
}

async function verifyMediaFile(file, { filename, mime, maxBytes, expectedType }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_DOWNLOAD_BYTES) {
    throw new Error('maximum download size must be between 1 byte and 1 GiB');
  }
  const name = safeMediaFilename(filename);
  const entry = lstatSync(file);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size <= 0 || entry.size > maxBytes) {
    throw new Error('downloaded file is empty, unsafe or exceeds the approved size limit');
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const header = Buffer.alloc(128);
  let headerBytes;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== entry.size) throw new Error('downloaded file changed while being checked');
    headerBytes = readSync(fd, header, 0, header.length, 0);
  }
  finally { closeSync(fd); }
  const format = mediaFormat(header.subarray(0, headerBytes));
  if (!format || format !== name.format) throw new Error('downloaded file signature does not match the approved filename type');
  const normalizedMime = String(mime ?? '').toLowerCase().split(';')[0].trim();
  const compatibleFormats = MIME_FORMATS.get(normalizedMime);
  if (compatibleFormats && !compatibleFormats.includes(format)) throw new Error('response MIME type does not match the downloaded file');
  if (normalizedMime && normalizedMime !== 'application/octet-stream' && !compatibleFormats) {
    throw new Error('response MIME type is not a supported image or video');
  }
  const mediaType = ['png', 'jpeg', 'webp', 'gif', 'avif'].includes(format) ? 'image' : 'video';
  if (expectedType && mediaType !== expectedType) throw new Error('downloaded media type differs from the approved target');
  return { bytes: entry.size, digest: await hashFile(file, entry.size), format, mediaType, mime: normalizedMime };
}

function mediaTemporaryPath(directory) {
  return join(directory, `.coopanion-download-${randomUUID()}.partial`);
}

function reserveMediaTemporaryFile(directory) {
  const targetDirectory = existingDirectory(directory);
  const file = mediaTemporaryPath(targetDirectory);
  const fd = openSync(file, 'wx', 0o600);
  closeSync(fd);
  return file;
}

function publishWithoutOverwrite(temporaryPath, directory, filename) {
  const targetDirectory = existingDirectory(directory);
  const name = safeMediaFilename(filename).name;
  if (lstatSync(temporaryPath).isSymbolicLink()) throw new Error('temporary download cannot be a symbolic link');
  const source = realpathSync(temporaryPath);
  if (dirname(source) !== targetDirectory) throw new Error('temporary download must be in the approved directory');
  const target = join(targetDirectory, name);
  try {
    linkSync(source, target);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('a file with the approved name already exists');
    throw error;
  }
  try { unlinkSync(source); }
  catch (error) {
    try { unlinkSync(target); } catch { /* leave an unverified output unavailable for further use */ }
    throw error;
  }
  return target;
}

module.exports = {
  MAX_MEDIA_DOWNLOAD_BYTES,
  existingDirectory,
  isMediaDownloadUrl,
  mediaDownloadRedirectsAllowed,
  mediaFormat,
  mediaTemporaryPath,
  reserveMediaTemporaryFile,
  publishWithoutOverwrite,
  safeMediaFilename,
  verifyMediaFile,
};
