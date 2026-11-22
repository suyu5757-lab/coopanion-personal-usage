import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoWorld } from '../core/video/world.ts';

let tempDir: string | null = null;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('video media listing', () => {
  it('returns local media paths without reading content or following symlinks', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'coopanion-video-world-'));
    const media = join(tempDir, 'video', 'media');
    const subdir = join(media, 'generated');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'cover.png'), 'image');
    writeFileSync(join(media, 'draft.mp4'), 'video');
    writeFileSync(join(media, 'notes.txt'), 'not media');
    writeFileSync(join(tempDir, 'outside.mp4'), 'outside');
    symlinkSync(join(tempDir, 'outside.mp4'), join(media, 'outside.mp4'));

    const world = new VideoWorld({ dataDir: tempDir, modelLanguage: () => 'zh' });
    const tool = world.tools().find((entry) => entry.name === 'video_list_media')!;
    const result = await tool.handler({}, {} as never);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('draft.mp4');
    expect(text).toContain('generated/cover.png');
    expect(text).not.toContain('outside.mp4');
    expect(text).not.toContain('notes.txt');
  });
});
