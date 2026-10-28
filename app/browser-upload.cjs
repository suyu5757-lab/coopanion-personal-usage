const { realpathSync, statSync } = require('node:fs');
const { basename, extname, isAbsolute, relative, resolve, sep } = require('node:path');

const UPLOAD_TYPES = new Map([
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'], ['.webm', 'video/webm'], ['.mkv', 'video/x-matroska'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
]);
const MAX_FILES = 20;

function isDouyinPageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && host === 'creator.douyin.com';
  } catch { return false; }
}

function inside(root, file) {
  const path = relative(root, file);
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function resolveUploadFiles(mediaDir, values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_FILES || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`choose 1 to ${MAX_FILES} relative paths from the video media folder`);
  }
  const root = realpathSync(mediaDir);
  const seen = new Set();
  const visibleNames = new Set();
  return values.map((value) => {
    const input = value.trim();
    if (input.includes('\\') || input.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) || isAbsolute(input)) {
      throw new Error('media paths must stay inside the video media folder');
    }
    const candidate = resolve(root, input);
    const file = realpathSync(candidate);
    if (!inside(root, file)) throw new Error('media path resolves outside the video media folder');
    if (file !== candidate) throw new Error('media symlinks cannot be uploaded');
    const stats = statSync(file);
    if (!stats.isFile()) throw new Error('each selected path must be a media file');
    const extension = extname(file).toLowerCase();
    const mime = UPLOAD_TYPES.get(extension);
    if (!mime) throw new Error(`unsupported upload type ${extension || '(no extension)'}`);
    if (seen.has(file)) throw new Error('the same media file was selected more than once');
    const visibleName = basename(file);
    if (visibleNames.has(visibleName)) throw new Error('selected media filenames must be unique for page verification');
    seen.add(file);
    visibleNames.add(visibleName);
    return { path: file, name: relative(root, file).split(sep).join('/'), visibleName, extension, mime, bytes: stats.size };
  });
}

function acceptsUpload(accept, file) {
  const value = String(accept || '').trim();
  if (!value) return true;
  const parts = value.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  return parts.some((part) => part === '*/*' || part === file.extension || part === file.mime || part === `${file.mime.split('/')[0]}/*`);
}

module.exports = { MAX_FILES, acceptsUpload, isDouyinPageUrl, resolveUploadFiles };
