import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptsUpload, isDouyinPageUrl, resolveUploadFiles } from '../app/browser-upload.cjs';

let tempDir;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('Douyin media upload boundary', () => {
  it('accepts only the Douyin site and checks the file input accept rules', () => {
    expect(isDouyinPageUrl('https://creator.douyin.com/creator-micro/upload')).toBe(true);
    expect(isDouyinPageUrl('https://douyin.com/')).toBe(false);
    expect(isDouyinPageUrl('https://douyin.com.example.org/')).toBe(false);
    expect(isDouyinPageUrl('http://creator.douyin.com/')).toBe(false);
    const file = { extension: '.png', mime: 'image/png' };
    expect(acceptsUpload('video/*,image/*', file)).toBe(true);
    expect(acceptsUpload('.mp4,.mov', file)).toBe(false);
    expect(acceptsUpload('', file)).toBe(true);
  });

  it('resolves only supported, unique media files inside the media folder with a content digest', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'coopanion-browser-upload-'));
    const media = join(tempDir, 'video', 'media');
    const generated = join(media, 'generated');
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, 'cover.png'), 'image');
    writeFileSync(join(media, 'preview.mp4'), 'video');
    writeFileSync(join(tempDir, 'outside.mp4'), 'outside');
    symlinkSync(join(tempDir, 'outside.mp4'), join(media, 'escape.mp4'));

    const files = await resolveUploadFiles(media, ['generated/cover.png', 'preview.mp4']);
    expect(files.map((file) => file.name))
      .toEqual(['generated/cover.png', 'preview.mp4']);
    expect(files.map((file) => file.digest)).toEqual([
      '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d',
      '0cab1c9617404faf2b24e221e189ca5945813e14d3f766345b09ca13bbe28ffc',
    ]);
    await expect(resolveUploadFiles(media, ['../outside.mp4'])).rejects.toThrow(/stay inside/);
    await expect(resolveUploadFiles(media, ['escape.mp4'])).rejects.toThrow(/outside/);
    await expect(resolveUploadFiles(media, ['preview.mp4', 'preview.mp4'])).rejects.toThrow(/more than once/);
  });
});
