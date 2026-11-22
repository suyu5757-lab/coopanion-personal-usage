/**
 * The FFmpeg side of the video World: turn a resolved `edit-manifest` into one vertical MP4, then
 * check the file that came out instead of trusting the command's exit code.
 *
 * Sources are only ever read. The output and the one poster frame are written under the renders
 * directory; every intermediate file lives in a task directory that is removed in `finally`.
 *
 * Captions are written beside the video as an SRT. A manifest can also request burned-in captions
 * when the selected FFmpeg has the `drawtext` filter.
 */
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { srt, type ResolvedManifest } from './manifest.ts';

const run = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 10 * 60_000;

export interface Tools { ffmpeg: string; ffprobe: string; version: string }

export interface Probe {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  sizeBytes: number;
  videoCodec: string;
  pixelFormat: string;
  audioCodec: string | null;
}

export interface RenderResult {
  renderId: string;
  output: string;
  sha256: string;
  /** The first frame, as JPEG, for the tool receipt. */
  poster: Buffer;
  probe: Probe;
  /** Seconds the output spends mostly black; a quick layout check, not a judgement of the cut. */
  blackSec: number;
  tools: Tools;
  /** Where the captions went when they could not be burned in; null when they are in the picture or absent. */
  captionsFile: string | null;
  captionsBurnedIn: boolean;
}

export class RenderFailure extends Error {}

const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

function locate(binary: string): string {
  const resourcePaths = resourcesPath ? [join(resourcesPath, 'ffmpeg', binary), join(resourcesPath, 'bin', binary)] : [];
  const paths = [
    ...resourcePaths,
    ...(process.platform === 'darwin' ? [join('/opt/homebrew/bin', binary), join('/usr/local/bin', binary)] : []),
    ...(process.platform !== 'win32' ? [join('/usr/bin', binary)] : []),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, binary)),
  ];
  return paths.find((path) => existsSync(path)) ?? binary;
}

/** The FFmpeg and ffprobe to use: world settings, environment, packaged/common locations, then PATH. */
export async function discoverTools(configured?: string, configuredProbe?: string): Promise<Tools> {
  const ffmpeg = configured?.trim() || process.env.COOPANION_FFMPEG || locate(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const siblingProbe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_match, extension = '') => `ffprobe${extension}`);
  const ffprobe = configuredProbe?.trim() || process.env.COOPANION_FFPROBE
    || (siblingProbe !== ffmpeg && existsSync(siblingProbe) ? siblingProbe : locate(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
  try {
    const { stdout } = await run(ffmpeg, ['-version'], { timeout: 10_000, maxBuffer: MAX_BUFFER });
    const version = String(stdout).split('\n')[0]?.trim() ?? '';
    await run(ffprobe, ['-version'], { timeout: 10_000, maxBuffer: MAX_BUFFER });
    return { ffmpeg, ffprobe, version };
  } catch (error) {
    throw new RenderFailure(`FFmpeg was not found (${ffmpeg}): ${(error as Error).message}`);
  }
}

/** Whether this FFmpeg can draw text into the picture; reported, not relied on. */
export async function canDrawText(tools: Tools): Promise<boolean> {
  try {
    const { stdout } = await run(tools.ffmpeg, ['-hide_banner', '-filters'], { timeout: 10_000, maxBuffer: MAX_BUFFER });
    return /^\s*[.A-Z|]{3}\s+drawtext\s/m.test(String(stdout));
  } catch { return false; }
}

const seconds = (value: number): string => value.toFixed(3);

/** The `-filter_complex` graph: trim, fit each clip to the canvas, concatenate, then mix audio. */
function filterGraph(manifest: ResolvedManifest, opts: { captionTextFiles?: string[]; fontPath?: string } = {}): string {
  const { width, height, fps } = manifest.canvas;
  const parts: string[] = [];
  manifest.clips.forEach((clip, index) => {
    const fit = clip.fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    parts.push(`[${index}:v]trim=start=${seconds(clip.startSec)}:end=${seconds(clip.startSec + clip.durationSec)},setpts=PTS-STARTPTS,${fit},setsar=1,fps=${fps},format=yuv420p[v${index}]`);
  });
  parts.push(`${manifest.clips.map((_, index) => `[v${index}]`).join('')}concat=n=${manifest.clips.length}:v=1:a=0[vout]`);

  let videoOutput = 'vout';
  if (manifest.captionsBurnIn) {
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const font = opts.fontPath ? `fontfile='${escape(opts.fontPath)}':` : '';
    const filters = manifest.captions.map((caption, index) => {
      const textFile = opts.captionTextFiles?.[index];
      if (!textFile) throw new RenderFailure('caption text files were not prepared');
      return `drawtext=${font}textfile='${escape(textFile)}':x=(w-text_w)/2:y=h-text_h-96:fontsize=h*0.035:fontcolor=white:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=12:enable='between(t,${seconds(caption.startSec)},${seconds(caption.startSec + caption.durationSec)})'`;
    });
    parts.push(`[vout]${filters.join(',')}[vcaption]`);
    videoOutput = 'vcaption';
  }

  const tracks: string[] = [];
  let input = manifest.clips.length;
  for (const [kind, track] of [['music', manifest.music], ['voiceover', manifest.voiceover]] as const) {
    if (!track) continue;
    parts.push(`[${input}:a]atrim=start=${seconds(track.startSec)}:end=${seconds(track.startSec + manifest.totalSec)},asetpts=PTS-STARTPTS,volume=${track.gainDb}dB,aresample=48000[${kind}]`);
    tracks.push(`[${kind}]`);
    input += 1;
  }
  if (tracks.length === 1) parts.push(`${tracks[0]}anull[aout]`);
  else if (tracks.length === 2) parts.push(`${tracks.join('')}amix=inputs=2:duration=longest:dropout_transition=0[aout]`);
  return parts.join(';');
}

/** The argv after the binary: inputs, graph, encoder, output. */
export function renderArgs(manifest: ResolvedManifest, opts: { captionTextFiles?: string[]; fontPath?: string } = {}): string[] {
  const args = ['-n', '-hide_banner', '-loglevel', 'error'];
  for (const clip of manifest.clips) args.push('-i', clip.file);
  if (manifest.music?.loop) args.push('-stream_loop', '-1');
  if (manifest.music) args.push('-i', manifest.music.file);
  if (manifest.voiceover?.loop) args.push('-stream_loop', '-1');
  if (manifest.voiceover) args.push('-i', manifest.voiceover.file);
  const videoOutput = manifest.captionsBurnIn ? '[vcaption]' : '[vout]';
  args.push('-filter_complex', filterGraph(manifest, opts), '-map', videoOutput);
  if (manifest.music || manifest.voiceover) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  else args.push('-an');
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', String(manifest.canvas.fps), '-t', seconds(manifest.totalSec),
    '-movflags', '+faststart', manifest.output,
  );
  return args;
}

const probeOf = (json: string): Probe => {
  const parsed = JSON.parse(json) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video') ?? {};
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const rate = String(video.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: rate[0] && rate[1] ? Number((rate[0] / rate[1]).toFixed(3)) : 0,
    durationSec: Number(parsed.format?.duration) || 0,
    sizeBytes: Number(parsed.format?.size) || 0,
    videoCodec: String(video.codec_name ?? ''),
    pixelFormat: String(video.pix_fmt ?? ''),
    audioCodec: audio ? String(audio.codec_name ?? '') : null,
  };
};

async function probe(tools: Tools, file: string, signal?: AbortSignal): Promise<Probe> {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30_000, maxBuffer: MAX_BUFFER, signal });
  return probeOf(String(stdout));
}

export async function inspectVideo(tools: Tools, file: string, signal?: AbortSignal): Promise<Probe> {
  return probe(tools, file, signal);
}

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(file, signal ? { signal } : undefined);
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once('error', reject);
    stream.once('end', resolveHash);
  });
  return hash.digest('hex');
}

/** Seconds covered by ffmpeg's blackdetect on the finished file. */
async function blackSeconds(tools: Tools, file: string): Promise<number> {
  try {
    const result = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-'], { timeout: 120_000, maxBuffer: MAX_BUFFER });
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return [...log.matchAll(/black_duration:(\d+(?:\.\d+)?)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  } catch (error) {
    throw new RenderFailure(`black detection failed: ${String((error as Error).message ?? error)}`);
  }
}

/** One poster frame, taken a little into the video. */
async function poster(tools: Tools, file: string, at: number, dir: string): Promise<Buffer> {
  const target = join(dir, 'poster.jpg');
  await run(tools.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', seconds(at), '-i', file, '-frames:v', '1', '-q:v', '3', target], { timeout: 60_000, maxBuffer: MAX_BUFFER });
  return readFileSync(target);
}

/** Renders, checks and reports; throws `RenderFailure` with a reason the receipt can show. */
export async function render(manifest: ResolvedManifest, opts: { ffmpegPath?: string; ffprobePath?: string; captionFontPath?: string; workDir: string; renderId: string }, signal?: AbortSignal): Promise<RenderResult> {
  const tools = await discoverTools(opts.ffmpegPath, opts.ffprobePath);
  const supportsDrawText = manifest.captionsBurnIn ? await canDrawText(tools) : false;
  if (manifest.captionsBurnIn && !supportsDrawText) throw new RenderFailure('captionsBurnIn needs an FFmpeg build with the drawtext filter');
  mkdirSync(dirname(manifest.output), { recursive: true });
  mkdirSync(opts.workDir, { recursive: true });
  const workInfo = lstatSync(opts.workDir);
  if (workInfo.isSymbolicLink() || !workInfo.isDirectory()) throw new RenderFailure('the video work folder must be a directory, not a symbolic link');
  const scratch = mkdtempSync(join(opts.workDir, 'render-'));
  try {
    const captionTextFiles = manifest.captionsBurnIn ? manifest.captions.map((caption, index) => {
      const file = join(scratch, `caption-${index}.txt`);
      writeFileSync(file, caption.text, 'utf8');
      return file;
    }) : undefined;
    try {
      await run(tools.ffmpeg, renderArgs(manifest, { captionTextFiles, fontPath: opts.captionFontPath }), { timeout: RENDER_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal });
    } catch (error) {
      throw new RenderFailure(`the render did not finish: ${String((error as Error).message ?? error)}`);
    }
    const facts = await probe(tools, manifest.output, signal);
    if (facts.width !== manifest.canvas.width || facts.height !== manifest.canvas.height) {
      throw new RenderFailure(`the output is ${facts.width}×${facts.height}, not ${manifest.canvas.width}×${manifest.canvas.height}`);
    }
    if (Math.abs(facts.durationSec - manifest.totalSec) > 0.5) {
      throw new RenderFailure(`the output is ${facts.durationSec.toFixed(2)}s, not ${manifest.totalSec.toFixed(2)}s`);
    }
    if (facts.videoCodec !== 'h264') throw new RenderFailure(`the output video codec is ${facts.videoCodec || 'unknown'}, not h264`);
    if (facts.pixelFormat !== 'yuv420p') throw new RenderFailure(`the output pixel format is ${facts.pixelFormat || 'unknown'}, not yuv420p`);
    if (Math.abs(facts.fps - manifest.canvas.fps) > 0.1) throw new RenderFailure(`the output frame rate is ${facts.fps}, not ${manifest.canvas.fps}`);
    if ((manifest.music || manifest.voiceover) && facts.audioCodec !== 'aac') {
      throw new RenderFailure(`the output audio codec is ${facts.audioCodec || 'missing'}, not aac`);
    }
    if (!manifest.music && !manifest.voiceover && facts.audioCodec !== null) {
      throw new RenderFailure(`the output unexpectedly contains ${facts.audioCodec} audio`);
    }
    if (facts.sizeBytes < 1) throw new RenderFailure('the output file is empty');
    const sha256 = await sha256File(manifest.output, signal);
    const posterFrame = await poster(tools, manifest.output, Math.min(1, manifest.totalSec / 2), scratch);
    if (!posterFrame.length) throw new RenderFailure('the output poster frame is empty');
    const blackSec = await blackSeconds(tools, manifest.output);
    const captionsFile = manifest.captions.length ? manifest.output.replace(/\.mp4$/i, '.srt') : null;
    if (captionsFile) {
      try {
        const sidecar = lstatSync(captionsFile);
        if (sidecar.isSymbolicLink() || !sidecar.isFile()) throw new RenderFailure('the caption sidecar path is not a regular file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      writeFileSync(captionsFile, srt(manifest.captions), { encoding: 'utf8', flag: 'wx' });
    }
    return {
      renderId: opts.renderId,
      output: manifest.output,
      sha256,
      poster: posterFrame,
      probe: facts,
      blackSec,
      tools,
      captionsFile,
      captionsBurnedIn: supportsDrawText,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
