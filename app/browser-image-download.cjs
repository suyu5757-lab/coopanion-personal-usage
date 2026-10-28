const { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync } = require('node:fs');
const { basename, join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MIME_FORMATS = new Map([
  ['image/png', { format: 'png', extension: 'png' }],
  ['image/jpeg', { format: 'jpeg', extension: 'jpg' }],
  ['image/webp', { format: 'webp', extension: 'webp' }],
]);

function isChatGPTPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function isChatGPTImageDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:') return isChatGPTPageUrl(url.origin);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'chatgpt.com' || host === 'chat.openai.com' || host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com'));
  } catch { return false; }
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function generatedImagePath(mediaDir, mime) {
  const kind = MIME_FORMATS.get(String(mime).toLowerCase().split(';')[0].trim());
  if (!kind) throw new Error('ChatGPT image download must be PNG, JPEG or WebP');
  mkdirSync(mediaDir, { recursive: true });
  const root = realpathSync(mediaDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = join(root, `chatgpt-image-${Date.now()}-${randomUUID()}.${kind.extension}`);
    if (!existsSync(file)) return { file, name: basename(file), mime: `image/${kind.format === 'jpeg' ? 'jpeg' : kind.format}` };
  }
  throw new Error('could not allocate a new media filename');
}

function verifyGeneratedImage(file, mime) {
  const expected = MIME_FORMATS.get(String(mime).toLowerCase().split(';')[0].trim());
  if (!expected) throw new Error('ChatGPT image download has an unsupported MIME type');
  const info = statSync(file);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) throw new Error('ChatGPT image download is empty or larger than 40 MB');
  const fd = openSync(file, 'r');
  const header = Buffer.alloc(12);
  const digest = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024);
  try {
    const headerBytes = readSync(fd, header, 0, header.length, 0);
    if (imageFormat(header.subarray(0, headerBytes)) !== expected.format) throw new Error('downloaded file contents do not match the image type');
    for (let offset = 0; offset < info.size;) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, info.size - offset), offset);
      if (read <= 0) throw new Error('downloaded image changed while it was being checked');
      digest.update(chunk.subarray(0, read));
      offset += read;
    }
  } finally { closeSync(fd); }
  return { bytes: info.size, format: expected.format, digest: digest.digest('hex') };
}

module.exports = { MAX_IMAGE_BYTES, generatedImagePath, imageFormat, isChatGPTImageDownloadUrl, isChatGPTPageUrl, verifyGeneratedImage };
