import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifest, resolveInside, srt } from '../core/video/manifest.ts';
import { canDrawText, discoverTools, render } from '../core/video/render.ts';

const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Media and renders folders, with the source files a manifest may name. */
const dirs = (files: string[] = ['clip1.mp4', 'clip2.mp4']) => {
  const created = mkdtempSync(join(tmpdir(), 'coo-video-'));
  roots.push(created);
  const root = realpathSync(created);
  const mediaDir = join(root, 'media');
  const rendersDir = join(root, 'renders');
  const workDir = join(root, 'work');
  mkdirSync(join(mediaDir, 'assets'), { recursive: true });
  mkdirSync(rendersDir, { recursive: true });
  for (const file of files) writeFileSync(join(mediaDir, 'assets', file), '');
  return { root, mediaDir, rendersDir, workDir };
};

const manifest = (overrides: Record<string, unknown> = {}) => ({
  canvas: { width: 1080, height: 1920, fps: 30 },
  sources: [{ id: 's1', path: 'assets/clip1.mp4', rights: 'user-provided' }],
  clips: [{ source: 's1', startSec: 0, durationSec: 4 }],
  ...overrides,
});

describe('edit manifest', () => {
  it('resolves a valid manifest and defaults the output under renders', () => {
    const d = dirs();
    const parsed = readManifest(manifest(), d);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.output).toBe(join(d.rendersDir, 'preview.mp4'));
    expect(parsed.manifest.totalSec).toBe(4);
    expect(parsed.manifest.clips[0]!.file).toBe(join(d.mediaDir, 'assets', 'clip1.mp4'));
  });

  it('refuses a path that climbs out of the media folder', () => {
    const d = dirs();
    const parsed = readManifest(manifest({ sources: [{ id: 's1', path: '../outside.mp4', rights: 'user-provided' }] }), d);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.problems.join('\n')).toContain('inside the media folder');
  });

  it('refuses source and output symlinks that escape their allowed folders', () => {
    const d = dirs([]);
    const outside = join(d.root, 'outside.mp4');
    writeFileSync(outside, 'video');
    symlinkSync(outside, join(d.mediaDir, 'assets', 'escape.mp4'));
    const source = readManifest(manifest({ sources: [{ id: 's1', path: 'assets/escape.mp4', rights: 'user-provided' }] }), d);
    expect(source.ok).toBe(false);
    expect(source.ok === false && source.problems.join('\n')).toContain('inside the media folder');

    symlinkSync(outside, join(d.rendersDir, 'escape.mp4'));
    const output = readManifest(manifest({ output: { path: 'escape.mp4' } }), d);
    expect(output.ok).toBe(false);
    expect(output.ok === false && output.problems.join('\n')).toContain('renders folder');
  });

  it('refuses a source without a rights note, an odd canvas, and an output outside renders', () => {
    const d = dirs();
    const noRights = readManifest(manifest({ sources: [{ id: 's1', path: 'assets/clip1.mp4', rights: '' }] }), d);
    expect(noRights.ok).toBe(false);
    expect(noRights.ok === false && noRights.problems.join('\n')).toContain('rights');

    const odd = readManifest(manifest({ canvas: { width: 1081, height: 1920, fps: 30 } }), d);
    expect(odd.ok).toBe(false);
    expect(odd.ok === false && odd.problems.join('\n')).toContain('even');

    const outside = readManifest(manifest({ output: { path: '../elsewhere.mp4' } }), d);
    expect(outside.ok).toBe(false);
    expect(outside.ok === false && outside.problems.join('\n')).toContain('renders folder');

    const absolute = readManifest(manifest({ output: { path: join(d.rendersDir, 'preview.mp4') } }), d);
    expect(absolute.ok).toBe(false);
    expect(absolute.ok === false && absolute.problems.join('\n')).toContain('renders folder');
  });

  it('refuses a clip whose source is unknown and clips over two minutes', () => {
    const d = dirs();
    const unknown = readManifest(manifest({ clips: [{ source: 's9', startSec: 0, durationSec: 2 }] }), d);
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.problems.join('\n')).toContain('not one of the sources');

    const long = readManifest(manifest({ clips: Array.from({ length: 4 }, () => ({ source: 's1', startSec: 0, durationSec: 31 })) }), d);
    expect(long.ok).toBe(false);
    expect(long.ok === false && long.problems.join('\n')).toContain('at most 120');

    const single = readManifest(manifest({ clips: [{ source: 's1', startSec: 0, durationSec: 61 }] }), d);
    expect(single.ok).toBe(false);
    expect(single.ok === false && single.problems.join('\n')).toContain('at most 60');

    const badStart = readManifest(manifest({ clips: [{ source: 's1', startSec: 'invalid', durationSec: 2 }] }), d);
    expect(badStart.ok).toBe(false);
    expect(badStart.ok === false && badStart.problems.join('\n')).toContain('startSec');
  });

  it('rejects invalid audio offsets and loop values', () => {
    const d = dirs();
    const parsed = readManifest(manifest({ audio: { music: { path: 'assets/music.mp3', rights: 'self-made', startSec: -1, loop: 'yes' } } }), d);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.problems.join('\n')).toContain('startSec');
    expect(parsed.ok === false && parsed.problems.join('\n')).toContain('loop');
  });

  it('keeps repeated clips of the same source in order', () => {
    const d = dirs();
    const parsed = readManifest(manifest({
      clips: [
        { source: 's1', startSec: 0, durationSec: 2 },
        { source: 's1', startSec: 3, durationSec: 2, fit: 'cover' },
      ],
    }), d);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.clips.map((clip) => clip.startSec)).toEqual([0, 3]);
    expect(parsed.manifest.clips[1]!.fit).toBe('cover');
  });

  it('resolves only relative paths that stay under the root', () => {
    expect(resolveInside('/a/b', 'c.mp4')).toBe('/a/b/c.mp4');
    expect(resolveInside('/a/b', '/etc/passwd')).toBeNull();
    expect(resolveInside('/a/b', '../c.mp4')).toBeNull();
    expect(resolveInside('/a/b', '')).toBeNull();
  });

  it('writes an SRT with the stated times', () => {
    expect(srt([{ text: '第一句', startSec: 0, durationSec: 1.5 }, { text: 'second', startSec: 62.25, durationSec: 2 }]))
      .toBe('1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:01:02,250 --> 00:01:04,250\nsecond\n');
  });
});

describe.skipIf(!hasFfmpeg)('rendering', () => {
  const make = (file: string, color: string, seconds: number) => {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=${seconds}:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  };
  const makeAudio = (file: string, seconds: number) => {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`, '-c:a', 'aac', file]);
  };

  it('renders a 1080×1920 preview, checks it, and leaves the sources and work folder alone', async () => {
    const d = dirs([]);
    mkdirSync(join(d.mediaDir, 'assets'), { recursive: true });
    make(join(d.mediaDir, 'assets', 'one.mp4'), 'red', 2);
    make(join(d.mediaDir, 'assets', 'two.mp4'), 'blue', 2);
    makeAudio(join(d.mediaDir, 'assets', 'music.m4a'), 4);
    const before = statSync(join(d.mediaDir, 'assets', 'one.mp4')).size;

    const parsed = readManifest({
      canvas: { width: 1080, height: 1920, fps: 30 },
      sources: [
        { id: 'a', path: 'assets/one.mp4', rights: 'self-made' },
        { id: 'b', path: 'assets/two.mp4', rights: 'self-made' },
      ],
      clips: [
        { source: 'a', startSec: 0, durationSec: 2 },
        { source: 'b', startSec: 0.5, durationSec: 1.5 },
      ],
      audio: { music: { path: 'assets/music.m4a', rights: 'self-made', loop: true } },
      captions: [{ text: '海边的下午', startSec: 0, durationSec: 1 }],
      output: { path: 'preview.mp4' },
    }, d);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const tools = await discoverTools();
    expect(await canDrawText(tools)).toBe(false); // this build: captions go to the sidecar

    const result = await render(parsed.manifest, { workDir: d.workDir });
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.pixelFormat).toBe('yuv420p');
    expect(result.probe.audioCodec).toBe('aac');
    expect(Math.abs(result.probe.durationSec - 3.5)).toBeLessThan(0.3);
    expect(result.poster.length).toBeGreaterThan(500);
    expect(result.captionsFile).toBe(join(d.rendersDir, 'preview.srt'));
    expect(readFileSync(result.captionsFile!, 'utf8')).toContain('海边的下午');
    expect(existsSync(result.output)).toBe(true);

    // the source is byte-for-byte what it was, and no intermediate outlives the render
    expect(statSync(join(d.mediaDir, 'assets', 'one.mp4')).size).toBe(before);
    expect(readdirSync(d.workDir)).toEqual([]);
  }, 120_000);

  it('keeps the source when the render fails', async () => {
    const d = dirs([]);
    mkdirSync(join(d.mediaDir, 'assets'), { recursive: true });
    const broken = join(d.mediaDir, 'assets', 'broken.mp4');
    writeFileSync(broken, 'not a video');
    const parsed = readManifest(manifest({
      sources: [{ id: 's1', path: 'assets/broken.mp4', rights: 'self-made' }],
      captions: [{ text: 'caption', startSec: 0, durationSec: 1 }],
    }), d);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await expect(render(parsed.manifest, { workDir: d.workDir })).rejects.toThrow(/did not finish/);
    expect(existsSync(broken)).toBe(true);
    expect(existsSync(join(d.rendersDir, 'preview.srt'))).toBe(false);
    expect(readdirSync(d.workDir)).toEqual([]);
  }, 120_000);
});
