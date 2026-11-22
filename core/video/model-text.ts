/** What Coo reads from the video World: what came out of a render, and why one did not run. */
import type { ModelLanguage } from '../language.ts';

export interface RenderReport {
  renderId: string;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number;
  sha256: string;
  videoCodec: string;
  audioCodec: string | null;
  blackSec: number;
  output: string;
  captionsFile: string | null;
  captionsBurnedIn: boolean;
  ffmpeg: string;
  version: string;
}

export interface PreparedReport {
  renderId: string;
  path: string;
  bytes: number;
  mime: string;
  sha256: string;
}

export interface VideoText {
  mediaLibrary(files: Array<{ path: string; type: 'image' | 'video' | 'audio'; bytes: number }>, truncated: boolean): string;
  rendered(report: RenderReport): string;
  prepared(report: PreparedReport): string;
  prepareFailed(why: string): string;
  invalid(problems: string[]): string;
  failed(why: string): string;
  interrupted: string;
  noImage: string;
  posterFallback(width: number, height: number): string;
}

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
const size = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const clock = (seconds: number): string => (seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}` : `${seconds.toFixed(1)}s`);

const zh: VideoText = {
  mediaLibrary: (files, truncated) => [
    files.length ? `[视频素材] 素材目录有 ${files.length} 个文件:` : '[视频素材] 素材目录里没有可用的图片、视频或音频文件。',
    ...files.map((file) => `- ${file.type === 'image' ? '图片' : file.type === 'video' ? '视频' : '音频'} · ${file.path} · ${size(file.bytes)}`),
    truncated ? '只显示了列表前 200 个文件。' : '',
  ].filter(Boolean).join('\n'),
  rendered: (r) => [
    `[视频] 生成了 ${r.width}×${r.height}、${clock(r.durationSec)} 的预览,${mb(r.sizeBytes)} MB,视频 ${r.videoCodec}${r.audioCodec ? `,音频 ${r.audioCodec}` : ',没有音轨'}。`,
    `renderId:${r.renderId} · SHA-256:${r.sha256}`,
    r.blackSec >= 0.5 ? `画面里有约 ${r.blackSec.toFixed(1)} 秒几乎全黑,检查一下排版。` : '没有检测到长时间黑屏。',
    r.captionsFile ? (r.captionsBurnedIn ? '字幕已烧进画面,并另存同名 .srt。' : '字幕在同名的 .srt 里,没有烧进画面。') : '',
    `文件:${r.output}`,
    `用 ${r.ffmpeg}(${r.version})。原始素材没有改动,中间文件已清理。`,
  ].filter(Boolean).join('\n'),
  prepared: (r) => `[视频] 已准备上传文件。renderId:${r.renderId} · 路径:${r.path} · ${r.bytes} 字节 · ${r.mime} · SHA-256:${r.sha256}。浏览器上传仍需单独确认。`,
  prepareFailed: (why) => `[视频 没准备好上传] ${why}`,
  invalid: (problems) => `[视频 没生成] 清单有问题:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  failed: (why) => `[视频 没生成] ${why}`,
  interrupted: '[视频] 被打断了,这一步没有继续;素材没有改动。',
  noImage: '(当前模型看不了图片)',
  posterFallback: (width, height) => `[预览首帧 ${width}×${height}]`,
};

const en: VideoText = {
  mediaLibrary: (files, truncated) => [
    files.length ? `[video media] ${files.length} files in the media folder:` : '[video media] No supported images, videos or audio files were found.',
    ...files.map((file) => `- ${file.type} · ${file.path} · ${size(file.bytes)}`),
    truncated ? 'Only the first 200 files are listed.' : '',
  ].filter(Boolean).join('\n'),
  rendered: (r) => [
    `[video] Rendered a ${r.width}×${r.height} preview, ${clock(r.durationSec)}, ${mb(r.sizeBytes)} MB, ${r.videoCodec}${r.audioCodec ? ` with ${r.audioCodec} audio` : ', no audio track'}.`,
    `renderId: ${r.renderId} · SHA-256: ${r.sha256}`,
    r.blackSec >= 0.5 ? `About ${r.blackSec.toFixed(1)}s of it is almost black; check the layout.` : 'No long black stretch was found.',
    r.captionsFile ? (r.captionsBurnedIn ? 'The captions are burned into the picture and saved in a sidecar .srt.' : 'The captions are in an .srt beside it, not burned into the picture.') : '',
    `File: ${r.output}`,
    `Made with ${r.ffmpeg} (${r.version}). The source files are unchanged and the intermediates are cleaned up.`,
  ].filter(Boolean).join('\n'),
  prepared: (r) => `[video] Prepared upload file. renderId: ${r.renderId} · path: ${r.path} · ${r.bytes} bytes · ${r.mime} · SHA-256: ${r.sha256}. Browser upload still needs separate approval.`,
  prepareFailed: (why) => `[video upload preparation failed] ${why}`,
  invalid: (problems) => `[video not rendered] The manifest has problems:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  failed: (why) => `[video not rendered] ${why}`,
  interrupted: '[video] Interrupted; this step did not continue and the sources are unchanged.',
  noImage: '(this model cannot see images)',
  posterFallback: (width, height) => `[preview frame ${width}×${height}]`,
};

export const VIDEO_TEXT: Record<ModelLanguage, VideoText> = { zh, en };
