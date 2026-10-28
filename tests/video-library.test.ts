import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMedia } from '../core/video/library.ts';

let tempDir: string | null = null;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('video media library', () => {
  it('lists supported assets by relative path and skips symlinks and unrelated files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'coopanion-video-library-'));
    const media = join(tempDir, 'video', 'media');
    const nested = join(media, 'covers');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'cover.png'), 'image');
    writeFileSync(join(media, 'clip.mp4'), 'video');
    writeFileSync(join(media, 'notes.txt'), 'text');
    writeFileSync(join(tempDir, 'outside.mov'), 'outside');
    symlinkSync(join(tempDir, 'outside.mov'), join(media, 'external.mov'));

    expect(listMedia(media)).toEqual({
      files: [
        { path: 'clip.mp4', type: 'video', bytes: 5 },
        { path: 'covers/cover.png', type: 'image', bytes: 5 },
      ],
      truncated: false,
    });
  });

  it('returns an empty library when the folder is not present', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'coopanion-video-library-'));
    expect(listMedia(join(tempDir, 'missing'))).toEqual({ files: [], truncated: false });
  });
});
