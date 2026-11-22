import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const {
  existingDirectory,
  isMediaDownloadUrl,
  mediaDownloadRedirectsAllowed,
  mediaFormat,
  mediaTemporaryPath,
  publishWithoutOverwrite,
  reserveMediaTemporaryFile,
  safeMediaFilename,
  verifyMediaFile,
} = require('../app/browser-media-download.cjs') as {
  existingDirectory(path: string): string;
  isMediaDownloadUrl(value: string): boolean;
  mediaDownloadRedirectsAllowed(requestedUrl: string, chain: string[]): boolean;
  mediaFormat(bytes: Buffer): string | null;
  mediaTemporaryPath(directory: string): string;
  publishWithoutOverwrite(temporaryPath: string, directory: string, filename: string): string;
  reserveMediaTemporaryFile(directory: string): string;
  safeMediaFilename(value: string): { name: string; extension: string; format: string };
  verifyMediaFile(file: string, options: { filename: string; mime?: string; maxBytes: number; expectedType?: string }): Promise<{
    bytes: number; digest: string; format: string; mediaType: string; mime: string;
  }>;
};

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function makeRoot(): string {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'coopanion-media-download-'));
  return root;
}

describe('Browser media download boundary', () => {
  it('accepts named public HTTP(S) asset URLs and rejects local, credentialed or non-HTTP URLs', () => {
    expect(isMediaDownloadUrl('https://cdn.example.com/video.mp4')).toBe(true);
    expect(isMediaDownloadUrl('http://images.example.com/picture.png')).toBe(true);
    expect(isMediaDownloadUrl('https://user:secret@cdn.example.com/video.mp4')).toBe(false);
    expect(isMediaDownloadUrl('https://127.0.0.1/video.mp4')).toBe(false);
    expect(isMediaDownloadUrl('http://media.local/video.mp4')).toBe(false);
    expect(isMediaDownloadUrl('blob:https://cdn.example.com/id')).toBe(false);
  });

  it('keeps redirects within the approved source origin and starts with the exact selected URL', () => {
    const selected = 'https://cdn.example.com/files/clip.mp4?token=private';
    expect(mediaDownloadRedirectsAllowed(selected, [selected, 'https://cdn.example.com/files/final.mp4?token=private'])).toBe(true);
    expect(mediaDownloadRedirectsAllowed(selected, ['https://cdn.example.com/other.mp4?token=private'])).toBe(false);
    expect(mediaDownloadRedirectsAllowed(selected, [selected, 'https://other.example.com/final.mp4'])).toBe(false);
    expect(mediaDownloadRedirectsAllowed(selected, [selected, 'http://127.0.0.1/private.mp4'])).toBe(false);
    expect(mediaDownloadRedirectsAllowed(selected, [selected, 'https://user:secret@cdn.example.com/private.mp4'])).toBe(false);
  });

  it('requires an existing absolute directory without symlink components', () => {
    const base = makeRoot();
    const target = join(base, 'existing');
    const link = join(base, 'link');
    writeFileSync(join(base, 'marker'), 'x');
    mkdirSync(target);
    symlinkSync(target, link);
    expect(existingDirectory(target)).toBe(target);
    expect(() => existingDirectory('relative')).toThrow(/absolute/);
    expect(() => existingDirectory(`${target}/../existing`)).toThrow(/parent path/);
    expect(() => existingDirectory(join(base, 'missing'))).toThrow();
    expect(() => existingDirectory(link)).toThrow(/symbolic link/);
  });

  it('rejects path components and unsupported filename types', () => {
    expect(safeMediaFilename('image-01.png')).toEqual({ name: 'image-01.png', extension: '.png', format: 'png' });
    for (const name of ['../image.png', '..\\image.png', 'folder/image.png', 'movie.exe', '.', 'name\n.png', 'bad:name.mp4', 'CON.mp4']) {
      expect(() => safeMediaFilename(name)).toThrow();
    }
    expect(() => safeMediaFilename(`${'多'.repeat(81)}.png`)).toThrow(/bytes/);
  });

  it('recognizes supported image and video file signatures', () => {
    expect(mediaFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(mediaFormat(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('jpeg');
    expect(mediaFormat(Buffer.from('RIFF0000WEBP'))).toBe('webp');
    expect(mediaFormat(Buffer.from('GIF89a'))).toBe('gif');
    expect(mediaFormat(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000')]))).toBe('mp4');
    expect(mediaFormat(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypqt  0000')]))).toBe('mov');
    expect(mediaFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, ...Buffer.from('webm')]))).toBe('webm');
    expect(mediaFormat(Buffer.from('not a media file'))).toBe(null);
  });

  it('verifies header, extension, MIME, expected type, byte limit and SHA-256', async () => {
    const directory = makeRoot();
    const path = join(directory, 'clip.mp4');
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000')]);
    writeFileSync(path, bytes);
    await expect(verifyMediaFile(path, {
      filename: 'clip.mp4', mime: 'video/mp4; codecs=avc1', maxBytes: 1024, expectedType: 'video',
    })).resolves.toEqual({ bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), format: 'mp4', mediaType: 'video', mime: 'video/mp4' });
    await expect(verifyMediaFile(path, { filename: 'clip.png', mime: 'video/mp4', maxBytes: 1024 })).rejects.toThrow(/signature/);
    await expect(verifyMediaFile(path, { filename: 'clip.mp4', mime: 'text/html', maxBytes: 1024 })).rejects.toThrow(/MIME/);
    await expect(verifyMediaFile(path, { filename: 'clip.mp4', mime: 'video/mp4', maxBytes: 8 })).rejects.toThrow(/size limit/);
    await expect(verifyMediaFile(path, { filename: 'clip.mp4', mime: 'video/mp4', maxBytes: 1024, expectedType: 'image' })).rejects.toThrow(/media type/);
  });

  it('publishes a verified same-directory file atomically without overwriting', () => {
    const directory = makeRoot();
    const temporary = mediaTemporaryPath(directory);
    writeFileSync(temporary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const published = publishWithoutOverwrite(temporary, directory, 'image.png');
    expect(published).toBe(join(directory, 'image.png'));
    expect(lstatSync(published).isFile()).toBe(true);
    const conflict = mediaTemporaryPath(directory);
    writeFileSync(conflict, Buffer.from('other file'));
    expect(() => publishWithoutOverwrite(conflict, directory, 'image.png')).toThrow(/already exists/);
  });

  it('reserves a private temporary file in the approved directory', () => {
    const directory = makeRoot();
    const reserved = reserveMediaTemporaryFile(directory);
    expect(reserved.startsWith(`${directory}/.coopanion-download-`)).toBe(true);
    expect(lstatSync(reserved).isFile()).toBe(true);
    expect(() => reserveMediaTemporaryFile(join(directory, 'missing'))).toThrow();
  });
});
