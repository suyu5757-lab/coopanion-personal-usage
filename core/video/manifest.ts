/**
 * `edit-manifest`: the JSON contract for one vertical preview. It names authorized source files,
 * the clips cut from them, optional music, voice-over and captions, and the output path.
 *
 * Validation is the boundary: every path must resolve inside the media directory, every source and
 * audio file must carry a rights note, and the output must land in the renders directory. Nothing
 * here reads or writes a file; `render.ts` runs the FFmpeg command this manifest compiles to.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface Source { id: string; path: string; rights: string }
export interface ResolvedTrack { file: string; rights: string; startSec: number; gainDb: number; loop: boolean }
export interface Caption { text: string; startSec: number; durationSec: number }
export interface Clip { source: string; startSec: number; durationSec: number; fit: 'contain' | 'cover' }

export interface ResolvedManifest {
  canvas: { width: number; height: number; fps: number };
  /** Absolute paths; `id` keys the clips. */
  sources: Array<{ id: string; file: string; rights: string }>;
  clips: Array<{ file: string; startSec: number; durationSec: number; fit: 'contain' | 'cover' }>;
  music: ResolvedTrack | null;
  voiceover: ResolvedTrack | null;
  captions: Caption[];
  captionsBurnIn: boolean;
  output: string;
  totalSec: number;
}

export interface ManifestDirs { mediaDir: string; rendersDir: string }

export type ManifestResult = { ok: true; manifest: ResolvedManifest } | { ok: false; problems: string[] };

const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const MIN_SIDE = 240;
const MAX_SIDE = 3840;
const MAX_TOTAL_SEC = 120;
const MAX_CLIP_SEC = 60;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const outputRelative = (path: string): string | null => {
  if (!path || isAbsolute(path)) return null;
  if (path.startsWith('./renders/')) return path.slice('./renders/'.length);
  if (path.startsWith('renders/')) return path.slice('renders/'.length);
  return path;
};

/** `rel` resolved under `root`, or null when it is absolute, empty or climbs out. */
export function resolveInside(root: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const full = resolve(root, rel);
  const inside = relative(resolve(root), full);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
  return full;
}

const inside = (root: string, full: string): boolean => {
  const path = relative(root, full);
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Existing source files must resolve to the media tree after following any symlinks. */
function resolveExistingInside(root: string, rel: string): string | null {
  const candidate = resolveInside(root, rel);
  if (!candidate) return null;
  try {
    const rootPath = realpathSync(root);
    const filePath = realpathSync(candidate);
    return inside(rootPath, filePath) ? filePath : null;
  } catch { return null; }
}

/** A new output may have missing parents, but no existing path component may be a symlink. */
function resolveOutputInside(root: string, rel: string): string | null {
  const candidate = resolveInside(root, rel);
  if (!candidate) return null;
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, candidate);
  let ancestor = rootPath;
  const missing: string[] = [];
  while (true) {
    try {
      ancestor = resolve(realpathSync(ancestor), ...missing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  const output = resolve(ancestor, relativePath);
  if (!inside(ancestor, output)) return null;
  const parts = relative(ancestor, output).split(sep).filter(Boolean);
  let current = ancestor;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) return null;
      if (index < parts.length - 1 && !info.isDirectory()) return null;
      if (index === parts.length - 1 && !info.isFile()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return output;
}

const isFile = (path: string): boolean => {
  try { return statSync(path).isFile(); } catch { return false; }
};

const problemsOf = (raw: unknown, dirs: ManifestDirs): string[] => {
  const problems: string[] = [];
  const root = record(raw);
  if (!root) return ['the manifest must be an object'];

  const canvas = record(root.canvas);
  const width = number(canvas?.width), height = number(canvas?.height), fps = number(canvas?.fps);
  if (width === null || height === null) problems.push('canvas.width and canvas.height are required numbers');
  if (fps === null) problems.push('canvas.fps is required');
  for (const [name, side] of [['width', width], ['height', height]] as const) {
    if (side === null) continue;
    if (!Number.isInteger(side) || side < MIN_SIDE || side > MAX_SIDE) problems.push(`canvas.${name} must be a whole number from ${MIN_SIDE} to ${MAX_SIDE}`);
    else if (side % 2) problems.push(`canvas.${name} must be even for H.264`);
  }
  if (fps !== null && (!Number.isInteger(fps) || fps < 1 || fps > 60)) problems.push('canvas.fps must be a whole number from 1 to 60');

  const rawSources = Array.isArray(root.sources) ? root.sources : [];
  if (!rawSources.length) problems.push('at least one source is required');
  if (rawSources.length > 20) problems.push('at most 20 sources');
  const sources = new Map<string, { file: string; rights: string }>();
  rawSources.forEach((rawSource, index) => {
    const source = record(rawSource);
    const id = text(source?.id);
    const path = text(source?.path);
    const rights = text(source?.rights);
    if (!/^[a-z0-9_-]{1,32}$/i.test(id)) { problems.push(`sources[${index}].id must be 1-32 letters, digits, - or _`); return; }
    if (sources.has(id)) { problems.push(`sources[${index}].id ${id} is used twice`); return; }
    const file = resolveExistingInside(dirs.mediaDir, path);
    if (!file) { problems.push(`sources[${index}].path must stay inside the media folder`); return; }
    if (!VIDEO_EXT.includes(file.slice(file.lastIndexOf('.')).toLowerCase())) { problems.push(`sources[${index}].path must be a video (${VIDEO_EXT.join(', ')})`); return; }
    if (!isFile(file)) { problems.push(`sources[${index}].path does not exist`); return; }
    if (!rights) { problems.push(`sources[${index}].rights must say why this file may be used`); return; }
    if (rights.length > 200) { problems.push(`sources[${index}].rights is too long`); return; }
    sources.set(id, { file, rights });
  });

  const rawClips = Array.isArray(root.clips) ? root.clips : [];
  if (!rawClips.length) problems.push('at least one clip is required');
  if (rawClips.length > 40) problems.push('at most 40 clips');
  let total = 0;
  rawClips.forEach((rawClip, index) => {
    const clip = record(rawClip);
    const source = text(clip?.source);
    const start = clip?.startSec === undefined ? 0 : number(clip.startSec);
    const duration = number(clip?.durationSec);
    const fit = clip?.fit === 'cover' ? 'cover' : 'contain';
    if (!sources.has(source)) problems.push(`clips[${index}].source is not one of the sources`);
    if (start === null || start < 0) problems.push(`clips[${index}].startSec must be 0 or more`);
    if (duration === null || duration < 0.1) problems.push(`clips[${index}].durationSec must be at least 0.1`);
    else if (duration > MAX_CLIP_SEC) problems.push(`clips[${index}].durationSec must be at most ${MAX_CLIP_SEC}`);
    else total += duration;
    if (clip?.fit !== undefined && clip.fit !== 'contain' && clip.fit !== 'cover') problems.push(`clips[${index}].fit must be contain or cover`);
  });
  if (total > MAX_TOTAL_SEC) problems.push(`the clips add up to ${total.toFixed(1)}s; at most ${MAX_TOTAL_SEC}s`);
  if (total > 0 && total < 1) problems.push('the clips add up to less than a second');

  const audio = record(root.audio);
  for (const key of ['music', 'voiceover'] as const) {
    const track = record(audio?.[key]);
    if (!track) continue;
    const file = resolveExistingInside(dirs.mediaDir, text(track.path));
    if (!file || !isFile(file)) problems.push(`audio.${key}.path must be an existing file inside the media folder`);
    if (!text(track.rights)) problems.push(`audio.${key}.rights must say why this audio may be used`);
    const start = track.startSec === undefined ? 0 : number(track.startSec);
    if (start === null || start < 0) problems.push(`audio.${key}.startSec must be 0 or more`);
    const gain = track.gainDb === undefined ? 0 : number(track.gainDb);
    if (gain === null || gain < -30 || gain > 12) problems.push(`audio.${key}.gainDb must be between -30 and 12`);
    if (track.loop !== undefined && typeof track.loop !== 'boolean') problems.push(`audio.${key}.loop must be true or false`);
  }

  const rawCaptions = root.captions;
  if (rawCaptions !== undefined && !Array.isArray(rawCaptions)) problems.push('captions must be an array');
  if (Array.isArray(rawCaptions)) {
    if (rawCaptions.length > 20) problems.push('at most 20 captions');
    rawCaptions.forEach((rawCaption, index) => {
      const caption = record(rawCaption);
      if (!text(caption?.text)) problems.push(`captions[${index}].text is empty`);
      if (text(caption?.text).length > 200) problems.push(`captions[${index}].text is longer than 200 characters`);
      const start = number(caption?.startSec), duration = number(caption?.durationSec);
      if (start === null || start < 0) problems.push(`captions[${index}].startSec must be 0 or more`);
      if (duration === null || duration < 0.1) problems.push(`captions[${index}].durationSec must be at least 0.1`);
      if (start !== null && duration !== null && start + duration > total + 0.01) problems.push(`captions[${index}] ends after the video`);
    });
  }
  if (root.captionsBurnIn !== undefined && typeof root.captionsBurnIn !== 'boolean') problems.push('captionsBurnIn must be true or false');
  if (root.captionsBurnIn === true && (!Array.isArray(rawCaptions) || rawCaptions.length === 0)) problems.push('captionsBurnIn needs at least one caption');

  const outputConfig = record(root.output);
  if (root.output !== undefined && !outputConfig) problems.push('output must be an object');
  const outputValue = outputConfig?.path;
  const outputPath = outputConfig && outputValue !== undefined ? text(outputValue) : 'renders/preview.mp4';
  if (outputConfig && outputValue !== undefined && (typeof outputValue !== 'string' || !outputPath)) {
    problems.push('output.path must be a non-empty relative path');
  }
  const outputRel = outputRelative(outputPath);
  const output = outputRel ? resolveOutputInside(dirs.rendersDir, outputRel) : null;
  if (!output || !output.toLowerCase().endsWith('.mp4')) problems.push('output.path must be an .mp4 under the renders folder');
  else {
    try { lstatSync(output); problems.push('output.path must be new; existing files are preserved'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push('output.path could not be checked safely'); }
    if (Array.isArray(rawCaptions) && rawCaptions.length) {
      const sidecar = output.replace(/\.mp4$/i, '.srt');
      try { lstatSync(sidecar); problems.push('caption sidecar must be new; existing files are preserved'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push('caption sidecar could not be checked safely'); }
    }
  }
  if (output && [...sources.values()].some((source) => source.file === output)) problems.push('output.path must not be one of the sources');

  return problems;
};

/** The manifest as the renderer runs it, or every problem found. */
export function readManifest(raw: unknown, dirs: ManifestDirs): ManifestResult {
  const problems = problemsOf(raw, dirs);
  if (problems.length) return { ok: false, problems };
  const root = raw as Record<string, unknown>;
  const canvas = root.canvas as Record<string, number>;
  const sourceList = (root.sources as Array<Record<string, unknown>>).map((source) => ({
    id: String(source.id), file: resolveExistingInside(dirs.mediaDir, String(source.path))!, rights: String(source.rights),
  }));
  const byId = new Map(sourceList.map((source) => [source.id, source.file]));
  const clips = (root.clips as Array<Record<string, unknown>>).map((clip) => ({
    file: byId.get(String(clip.source))!,
    startSec: number(clip.startSec) ?? 0,
    durationSec: number(clip.durationSec)!,
    fit: (clip.fit === 'cover' ? 'cover' : 'contain') as 'contain' | 'cover',
  }));
  const track = (value: unknown): ResolvedTrack | null => {
    const raw = record(value);
    if (!raw) return null;
    return {
      file: resolveExistingInside(dirs.mediaDir, String(raw.path))!,
      rights: String(raw.rights),
      startSec: number(raw.startSec) ?? 0,
      gainDb: number(raw.gainDb) ?? 0,
      loop: raw.loop === true,
    };
  };
  const audio = record(root.audio);
  const outputPath = text(record(root.output)?.path) || 'renders/preview.mp4';
  const output = resolveOutputInside(dirs.rendersDir, outputRelative(outputPath)!)!;
  return {
    ok: true,
    manifest: {
      canvas: { width: Math.round(canvas.width!), height: Math.round(canvas.height!), fps: Math.round(canvas.fps!) },
      sources: sourceList,
      clips,
      music: track(audio?.music),
      voiceover: track(audio?.voiceover),
      captions: (Array.isArray(root.captions) ? root.captions : []).map((caption) => {
        const c = caption as Record<string, unknown>;
        return { text: String(c.text), startSec: number(c.startSec)!, durationSec: number(c.durationSec)! };
      }),
      captionsBurnIn: root.captionsBurnIn === true,
      output,
      totalSec: clips.reduce((sum, clip) => sum + clip.durationSec, 0),
    },
  };
}

/** The captions as an SRT file's text, for a build without burned-in text. */
export function srt(captions: Caption[]): string {
  const clock = (seconds: number): string => {
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return captions.map((caption, index) => `${index + 1}\n${clock(caption.startSec)} --> ${clock(caption.startSec + caption.durationSec)}\n${caption.text}\n`).join('\n');
}
