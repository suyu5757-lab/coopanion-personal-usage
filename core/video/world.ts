/**
 * The video World: one tool that turns an `edit-manifest` into a checked vertical preview.
 *
 * The person's source files live in `<data>/video/media` and are only read. Renders go to
 * `<data>/video/renders`, intermediates to `<data>/video/work`, which is emptied per render. FFmpeg
 * and ffprobe are found through the video's path settings, environment variables, common install
 * locations and PATH.
 */
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome, World } from 'cortico/core/types.ts';
import type { ModelLanguage } from '../language.ts';
import { readManifest } from './manifest.ts';
import { VIDEO_TEXT, type VideoText } from './model-text.ts';
import { listMedia } from './library.ts';
import { RenderFailure, render } from './render.ts';
import { VIDEO_TOOL_DECLS } from './tools.ts';

export const VIDEO_WORLD_ID = 'video';

const parseJson = (value: string): unknown => {
  try { return JSON.parse(value); } catch { return null; }
};

export interface VideoWorldOptions {
  dataDir: string;
  modelLanguage: () => ModelLanguage;
  ffmpegPath?: () => string;
  ffprobePath?: () => string;
}

export class VideoWorld implements World {
  readonly id = VIDEO_WORLD_ID;

  constructor(private readonly opts: VideoWorldOptions) {}

  private get t(): VideoText {
    return VIDEO_TEXT[this.opts.modelLanguage()];
  }

  private get root(): string {
    return join(this.opts.dataDir, 'video');
  }

  envPromptVars(): Record<string, string> | null {
    return null;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  tools(): ToolDef[] {
    return VIDEO_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: (args, ctx) => this.run(decl.name, args, ctx),
    }));
  }

  private async run(tool: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const dirs = { mediaDir: join(this.root, 'media'), rendersDir: join(this.root, 'renders') };
    if (tool === 'video_list_media') {
      const library = listMedia(dirs.mediaDir);
      return { text: this.t.mediaLibrary(library.files, library.truncated) };
    }
    // a model sometimes sends the manifest as JSON text rather than an object
    const raw = typeof args.manifest === 'string' ? parseJson(args.manifest) : args.manifest;
    const parsed = readManifest(raw, dirs);
    if (!parsed.ok) return { text: this.t.invalid(parsed.problems), failed: true };
    try {
      const result = await render(parsed.manifest, {
        workDir: join(this.root, 'work'),
        ffmpegPath: this.opts.ffmpegPath?.(),
        ffprobePath: this.opts.ffprobePath?.(),
      }, ctx.signal);
      const text = this.t.rendered({
        width: result.probe.width,
        height: result.probe.height,
        durationSec: result.probe.durationSec,
        sizeBytes: result.probe.sizeBytes,
        videoCodec: result.probe.videoCodec,
        audioCodec: result.probe.audioCodec,
        blackSec: result.blackSec,
        output: result.output,
        captionsFile: result.captionsFile,
        captionsBurnedIn: result.captionsBurnedIn,
        ffmpeg: result.tools.ffmpeg,
        version: result.tools.version.replace(/^ffmpeg version\s*/i, '').split(' ')[0] ?? '',
      });
      return {
        text,
        blobs: [{
          bytes: result.poster,
          mime: 'image/jpeg',
          name: 'preview.jpg',
          fallbackText: this.t.posterFallback(result.probe.width, result.probe.height),
        }],
      };
    } catch (error) {
      if (ctx.signal?.aborted) return { text: this.t.interrupted, failed: true };
      const why = error instanceof RenderFailure ? error.message : String((error as Error)?.message ?? error);
      return { text: this.t.failed(why), failed: true };
    }
  }
}
