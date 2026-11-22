/**
 * The video World: one tool that turns an `edit-manifest` into a checked vertical preview.
 *
 * The person's source files live in `<data>/video/media` and are only read. Renders go to
 * `<data>/video/renders`, intermediates to `<data>/video/work`, which is emptied per render. FFmpeg
 * and ffprobe are found through the video's path settings, environment variables, common install
 * locations and PATH.
 */
import { join } from 'node:path';
import { relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { ToolCallContext, ToolDef, ToolOutcome, World } from 'cortico/core/types.ts';
import type { ModelLanguage } from '../language.ts';
import type { FileSystemActionAuthorizationRequest, FileSystemActionAuthorization } from '../action-authorization.ts';
import { readManifest, srt, type ResolvedManifest } from './manifest.ts';
import { VIDEO_TEXT, type VideoText } from './model-text.ts';
import { listMedia } from './library.ts';
import { RenderFailure, render, sha256File } from './render.ts';
import { planPreparedUpload, prepareUpload, type PreparedUploadPlan, type RenderReceipt } from './prepared.ts';
import { VIDEO_TOOL_DECLS } from './tools.ts';

export const VIDEO_WORLD_ID = 'video';

const parseJson = (value: string): unknown => {
  try { return JSON.parse(value); } catch { return null; }
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const digestText = (value: string): string => createHash('sha256').update(value).digest('hex');

function outputForRender(value: unknown, renderId: string): unknown {
  const manifest = record(value);
  if (!manifest) return value;
  const output = record(manifest.output);
  const hasOutput = Object.prototype.hasOwnProperty.call(manifest, 'output');
  if (hasOutput && (!output || Object.prototype.hasOwnProperty.call(output, 'path'))) return value;
  return { ...manifest, output: { ...(output ?? {}), path: `${renderId}.mp4` } };
}

export interface VideoWorldOptions {
  dataDir: string;
  modelLanguage: () => ModelLanguage;
  ffmpegPath?: () => string;
  ffprobePath?: () => string;
  authorizeAction?: (
    request: FileSystemActionAuthorizationRequest,
    confirmInCoreUi: () => Promise<boolean>,
  ) => Promise<FileSystemActionAuthorization | null>;
  confirmAction?: (request: Pick<FileSystemActionAuthorizationRequest, 'action' | 'target' | 'taskText' | 'files'>) => Promise<boolean>;
}

export class VideoWorld implements World {
  readonly id = VIDEO_WORLD_ID;
  private readonly renderReceipts = new Map<string, RenderReceipt>();

  constructor(private readonly opts: VideoWorldOptions) {}

  private get t(): VideoText {
    return VIDEO_TEXT[this.opts.modelLanguage()];
  }

  private get root(): string {
    return join(this.opts.dataDir, 'video');
  }

  private async authorizeFileWrite(request: FileSystemActionAuthorizationRequest): Promise<FileSystemActionAuthorization | null> {
    if (!this.opts.authorizeAction || !this.opts.confirmAction) return null;
    return this.opts.authorizeAction(request, () => this.opts.confirmAction!(request));
  }

  private async renderPayloadDigest(manifest: ResolvedManifest, signal?: AbortSignal): Promise<string> {
    const files = new Set<string>(manifest.sources.map((source) => source.file));
    if (manifest.music) files.add(manifest.music.file);
    if (manifest.voiceover) files.add(manifest.voiceover.file);
    const inputFacts: Array<{ path: string; bytes: number; digest: string }> = [];
    for (const file of [...files].sort()) {
      if (signal?.aborted) throw new Error('render was interrupted');
      const before = statSync(file);
      if (!before.isFile()) throw new Error('a render input is not a regular file');
      const digest = await sha256File(file, signal);
      const after = statSync(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error('a render input changed while its approval snapshot was read');
      }
      inputFacts.push({ path: relative(this.root, file).split(sep).join('/'), bytes: after.size, digest });
    }
    return digestText(JSON.stringify({
      canvas: manifest.canvas,
      sources: manifest.sources.map((source) => ({ id: source.id, path: relative(this.root, source.file).split(sep).join('/'), rights: source.rights })),
      clips: manifest.clips.map((clip) => ({ ...clip, file: relative(this.root, clip.file).split(sep).join('/') })),
      music: manifest.music ? { ...manifest.music, file: relative(this.root, manifest.music.file).split(sep).join('/') } : null,
      voiceover: manifest.voiceover ? { ...manifest.voiceover, file: relative(this.root, manifest.voiceover.file).split(sep).join('/') } : null,
      captions: manifest.captions,
      captionsBurnIn: manifest.captionsBurnIn,
      output: relative(this.root, manifest.output).split(sep).join('/'),
      totalSec: manifest.totalSec,
      inputFacts,
    }));
  }

  private fileWriteRequest(
    ctx: ToolCallContext,
    actionName: string,
    targetPath: string,
    snapshotId: string,
    payloadDigest: string,
    taskText: string,
    files: FileSystemActionAuthorizationRequest['files'],
  ): FileSystemActionAuthorizationRequest {
    return {
      taskId: ctx.callId ? `video:${ctx.callId}` : `video:${randomUUID()}`,
      taskText,
      expectedChange: taskText,
      risk: 'REVERSIBLE_LOCAL',
      target: {
        surface: 'filesystem',
        instanceId: 'video-world',
        workspaceRoot: this.root,
        path: targetPath,
        operation: 'file-write',
        snapshotId,
        source: 'video-world',
      },
      action: 'file-write',
      actionName,
      payloadDigest,
      files,
      expiresInMs: 30_000,
      maxSteps: 1,
    };
  }

  envPromptVars(): Record<string, string> | null {
    return null;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> { this.renderReceipts.clear(); }

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
    if (tool === 'video_prepare_upload') return this.prepareRenderedUpload(args, dirs.mediaDir, dirs.rendersDir, ctx);
    // a model sometimes sends the manifest as JSON text rather than an object
    const source = typeof args.manifest === 'string' ? parseJson(args.manifest) : args.manifest;
    const renderId = randomUUID();
    const parsed = readManifest(outputForRender(source, renderId), dirs);
    if (!parsed.ok) return { text: this.t.invalid(parsed.problems), failed: true };
    let authorization: FileSystemActionAuthorization | null = null;
    let dispatched = false;
    try {
      const payloadDigest = await this.renderPayloadDigest(parsed.manifest, ctx.signal);
      if (ctx.signal?.aborted) return { text: this.t.interrupted, failed: true };
      const outputPath = relative(this.root, parsed.manifest.output).split(sep).join('/');
      const sidecarText = parsed.manifest.captions.length ? srt(parsed.manifest.captions) : null;
      const files = sidecarText === null ? [] : [{
        path: outputPath.replace(/\.mp4$/i, '.srt'),
        bytes: Buffer.byteLength(sidecarText),
        mime: 'application/x-subrip',
        digest: digestText(sidecarText),
      }];
      const taskText = `Create a local preview at ${outputPath}${files.length ? ` and a caption file at ${files[0]!.path}` : ''} from ${parsed.manifest.sources.length} listed media source(s). Input manifest and content SHA-256: ${payloadDigest}.`;
      const request = this.fileWriteRequest(ctx, 'video_render', outputPath, payloadDigest, payloadDigest, taskText, files);
      authorization = await this.authorizeFileWrite(request);
      if (!authorization) return { text: this.t.failed('the Core file write authorization was unavailable or declined'), failed: true };
      if (ctx.signal?.aborted) {
        authorization.revoke();
        return { text: this.t.interrupted, failed: true };
      }
      const current = readManifest(outputForRender(source, renderId), dirs);
      if (!current.ok || await this.renderPayloadDigest(current.manifest, ctx.signal) !== payloadDigest) {
        authorization.revoke();
        return { text: this.t.failed('the render inputs or destination changed after approval'), failed: true };
      }
      if (!authorization.consume(request.target, request.expectedChange, request.files)) {
        return { text: this.t.failed('the render authorization expired or no longer matches'), failed: true };
      }
      dispatched = true;
      const result = await render(parsed.manifest, {
        workDir: join(this.root, 'work'),
        ffmpegPath: this.opts.ffmpegPath?.(),
        ffprobePath: this.opts.ffprobePath?.(),
        renderId,
      }, ctx.signal);
      const verifiedHash = await sha256File(result.output, ctx.signal);
      const verifiedSize = statSync(result.output).size;
      let sidecarsMatch = true;
      for (const file of files) {
        const path = join(this.root, file.path);
        if (!existsSync(path) || statSync(path).size !== file.bytes || await sha256File(path, ctx.signal) !== file.digest) {
          sidecarsMatch = false;
          break;
        }
      }
      if (verifiedHash !== result.sha256 || verifiedSize !== result.probe.sizeBytes || !sidecarsMatch) {
        authorization.complete({
          phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown',
          note: 'the render output or its caption file did not match the approved result',
          evidence: { source: 'video-world', status: 'readback-mismatch', summary: outputPath, digest: verifiedHash, observedAt: Date.now() },
        });
        return { text: this.t.failed('the rendered files did not match their read-back receipts'), failed: true };
      }
      authorization.complete({
        phase: 'verified', dispatchState: 'delivered', outcome: 'verified',
        note: `created ${outputPath} (${verifiedSize} bytes)`,
        evidence: { source: 'video-world', status: 'file-hash-and-size-verified', summary: outputPath, digest: verifiedHash, observedAt: Date.now() },
      });
      const receipt: RenderReceipt = { renderId: result.renderId, output: result.output, sha256: result.sha256, probe: result.probe, tools: result.tools };
      this.renderReceipts.set(renderId, receipt);
      while (this.renderReceipts.size > 100) this.renderReceipts.delete(this.renderReceipts.keys().next().value!);
      const text = this.t.rendered({
        renderId,
        width: result.probe.width,
        height: result.probe.height,
        durationSec: result.probe.durationSec,
        sizeBytes: result.probe.sizeBytes,
        sha256: result.sha256,
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
      if (authorization) {
        if (dispatched) {
          try {
            authorization.complete({
              phase: 'unknown', dispatchState: existsSync(parsed.manifest.output) ? 'delivered' : 'unknown', outcome: 'unknown',
              note: 'the render did not return a verifiable file result',
              evidence: { source: 'video-world', status: 'render-result-unknown', summary: relative(this.root, parsed.manifest.output).split(sep).join('/'), observedAt: Date.now() },
            });
          } catch { /* the acting receipt stays unresolved if it cannot be saved */ }
        } else authorization.revoke();
      }
      if (ctx.signal?.aborted) return { text: this.t.interrupted, failed: true };
      const why = error instanceof RenderFailure ? error.message : String((error as Error)?.message ?? error);
      return { text: this.t.failed(why), failed: true };
    }
  }

  private async prepareRenderedUpload(
    args: Record<string, unknown>,
    mediaDir: string,
    rendersDir: string,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    const renderId = typeof args.renderId === 'string' ? args.renderId.trim() : '';
    const receipt = this.renderReceipts.get(renderId);
    if (!receipt) return { text: this.t.prepareFailed('renderId is missing, expired or was not created in this Core session'), failed: true };
    if (ctx.signal?.aborted) return { text: this.t.interrupted, failed: true };
    let authorization: FileSystemActionAuthorization | null = null;
    let dispatched = false;
    try {
      const plan = await planPreparedUpload(mediaDir, rendersDir, receipt, new Date().toISOString(), ctx.signal);
      const payloadDigest = digestText(JSON.stringify({ renderId, source: relative(this.root, receipt.output).split(sep).join('/'), sourceDigest: receipt.sha256, files: plan.files }));
      const targetPath = `media/prepared/${renderId}`;
      const taskText = `Copy the checked render to ${targetPath}/render.mp4 and write its receipt.json. Source SHA-256: ${receipt.sha256}; prepared file digests are listed below.`;
      const request = this.fileWriteRequest(ctx, 'video_prepare_upload', targetPath, payloadDigest, payloadDigest, taskText, plan.files.map((file) => ({ ...file, path: `media/${file.path}` })));
      authorization = await this.authorizeFileWrite(request);
      if (!authorization) return { text: this.t.prepareFailed('the Core file write authorization was unavailable or declined'), failed: true };
      if (ctx.signal?.aborted) {
        authorization.revoke();
        return { text: this.t.interrupted, failed: true };
      }
      const prepared = await prepareUpload(plan, () => {
        if (ctx.signal?.aborted) return false;
        dispatched = authorization!.consume(request.target, request.expectedChange, request.files);
        return dispatched;
      }, ctx.signal);
      authorization.complete({
        phase: 'verified', dispatchState: 'delivered', outcome: 'verified',
        note: `prepared ${prepared.path} (${prepared.bytes} bytes)`,
        evidence: { source: 'video-world', status: 'file-hash-and-size-verified', summary: prepared.path, digest: prepared.sha256, observedAt: Date.now() },
      });
      this.renderReceipts.delete(renderId);
      return { text: this.t.prepared({ renderId, ...prepared }) };
    } catch (error) {
      if (authorization) {
        if (dispatched) {
          try {
            authorization.complete({
              phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown',
              note: 'the prepared copy did not return a verifiable result',
              evidence: { source: 'video-world', status: 'prepared-copy-unknown', summary: `media/prepared/${renderId}`, observedAt: Date.now() },
            });
          } catch { /* the acting receipt stays unresolved if it cannot be saved */ }
        } else authorization.revoke();
      }
      if (ctx.signal?.aborted) return { text: this.t.interrupted, failed: true };
      const why = error instanceof RenderFailure ? error.message : String((error as Error)?.message ?? error);
      return { text: this.t.prepareFailed(why), failed: true };
    }
  }
}
