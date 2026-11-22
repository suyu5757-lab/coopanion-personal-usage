import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import type { BrowserTransport } from '../core/browser/bridge.ts';
import { readSelfTime, SELF_TIME_DEFAULTS } from '../core/browser/config.ts';
import { browserDefinition } from '../core/browser/definition.ts';
import { clickRefusal, isSearchField, isWriteAction, targetStateToggle, typeRefusal } from '../core/browser/guard.ts';
import { selfTimeLine } from '../core/browser/model-text.ts';
import { BrowserWorld } from '../core/browser/world.ts';
import { coopanionPersona } from '../core/persona.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';

type Page = {
  url: string; title: string; header: string; content: string; footer: string;
  video: null | { current: number; duration: number; paused: boolean; muted: boolean; volume: number; width: number; height: number; src: string };
  snapshotId?: string;
  mediaTargets?: Array<{ index: number; token: string; mediaType: 'image' | 'video'; label: string; host: string; filenameHint: string }>;
  current?: { url: string; title: string; itemId?: string; authorRef?: string; authorLabel?: string; contentSnippet?: string; containerIdentity?: string; playing?: boolean; observedAt?: number } | null;
  account?: { ref: string; label: string } | null;
  elements?: Array<{ id: number; label: string; pressed?: boolean }>;
};

const page = (overrides: Partial<Page> = {}): Page => ({
  url: 'https://www.bilibili.com/',
  title: '哔哩哔哩',
  header: 'Current Page: [哔哩哔哩](https://www.bilibili.com/)\nPage info: 1100x732px viewport',
  content: '*[0]<a >首页 />\n*[1]<a >一个视频 />\n*[2]<div title=点赞>12 />',
  footer: '[End of page]',
  video: null,
  ...overrides,
});

/** One second of silence as the 16 kHz mono 16-bit WAV the page records. */
const wav = (samples = 16_000): string => {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + samples * 2, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes.toString('base64');
};

class FakeBridge implements BrowserTransport {
  readonly calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  readonly listeners = new Set<(event: 'closed') => void>();
  responses: Record<string, unknown | ((args: Record<string, unknown>) => unknown)> = {};
  element: unknown = null;
  active: unknown = null;

  async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ op, args });
    if (op === 'element') return this.element;
    if (op === 'active') return this.active;
    const value = this.responses[op];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? (value as (args: Record<string, unknown>) => unknown)(args) : value;
  }

  onEvent(listener: (event: 'closed') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: 'closed'): void {
    for (const listener of this.listeners) listener(event);
  }
}

const element = (overrides: Record<string, unknown> = {}) => ({
  id: 2, tag: 'div', text: '点赞 12', label: '点赞 12', type: '', placeholder: '', aria: '', title: '点赞', role: '',
  href: '', disabled: false, visible: true, ...overrides,
});

const host = (pushed: Array<Record<string, unknown>>, sees = true) => ({
  modelFacts: { accepts: () => sees },
  pushEvent: async (e: Record<string, unknown>) => {
    pushed.push(e);
    return { ...e, cursor: pushed.length, origin: 'external', contextDelivery: 'deliver' };
  },
} as unknown as WorldHost);

const taskJournalDirs: string[] = [];
afterEach(() => {
  for (const directory of taskJournalDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const run = async (world: BrowserWorld, name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
  const tool = world.tools().find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const out = await tool.handler(args, {} as ToolCallContext);
  return typeof out === 'string' ? { text: out } : out;
};

const make = async (opts: {
  self?: Partial<typeof SELF_TIME_DEFAULTS>;
  bridge?: FakeBridge;
  pushed?: Array<Record<string, unknown>>;
  sees?: boolean;
  ask?: (question: string, choices: [yes: string, no: string]) => Promise<'yes' | 'always' | 'no' | 'dismissed' | 'timeout' | 'unavailable'>;
  transcribe?: (pcm: Int16Array) => Promise<{ text: string; error?: string | null }>;
} = {}) => {
  const bridge = opts.bridge ?? new FakeBridge();
  const pushed = opts.pushed ?? [];
  let self = { ...SELF_TIME_DEFAULTS, enabled: true, ...opts.self };
  const taskJournalDir = mkdtempSync(join(tmpdir(), 'coo-browser-task-journal-'));
  taskJournalDirs.push(taskJournalDir);
  const taskJournalFile = join(taskJournalDir, 'task-actions.json');
  const world = new BrowserWorld({
    bridge,
    selfTime: () => self,
    modelLanguage: () => 'zh',
    timezone: 'Asia/Shanghai',
    taskJournalFile,
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
  });
  await world.start(host(pushed, opts.sees ?? true));
  return {
    world, bridge, pushed, taskJournalFile,
    setSelf: (patch: Partial<typeof self>) => { self = { ...self, ...patch }; },
  };
};

describe('selfTime settings', () => {
  it('reads defaults and clamps hand-edited values', () => {
    expect(readSelfTime(undefined)).toEqual(SELF_TIME_DEFAULTS);
    expect(SELF_TIME_DEFAULTS.enabled).toBe(false);
    expect(SELF_TIME_DEFAULTS.actions).toBe(false);
    expect(SELF_TIME_DEFAULTS.imageGeneration).toBe(false);
    expect(SELF_TIME_DEFAULTS.imageSaving).toBe(false);
    expect(SELF_TIME_DEFAULTS.mediaUpload).toBe(false);
    expect(SELF_TIME_DEFAULTS.mediaDownload).toBe(false);
    expect(readSelfTime({ companion: { selfTime: { enabled: true, afterMinutes: 999, sessionMinutes: 1, sessionUnlimited: true, sound: true, actions: false } } }))
      .toEqual({ enabled: true, afterMinutes: 240, sessionMinutes: 5, sessionUnlimited: true, sound: true, topics: '', actions: false, imageGeneration: false, imageSaving: false, mediaUpload: false, mediaDownload: false });
    expect(readSelfTime({ companion: { selfTime: { afterMinutes: 0, sessionMinutes: 999 } } }))
      .toEqual({ ...SELF_TIME_DEFAULTS, afterMinutes: 1, sessionMinutes: 60 });
    expect(readSelfTime({ companion: { selfTime: { enabled: true } }, worlds: { browser: { enabled: false } } }).enabled).toBe(false);
  });

  it('wakes Coo with the browser as an option, not an order', () => {
    const zh = selfTimeLine('zh', 30, 20);
    expect(zh).toContain('30 秒');
    expect(zh).toContain('20 分钟');
    expect(zh).toContain('end_turn');
    const en = selfTimeLine('en', 120, 15);
    expect(en).toContain('2 minutes');
    expect(en).toContain('15 minutes');
    expect(en).toContain('end_turn');
    const unlimited = selfTimeLine('zh', 30, 20, true);
    expect(unlimited).toContain('不限时长');
    expect(unlimited).not.toContain('最多 20 分钟');
    expect(unlimited).toContain('不要搜索或打开浏览器');
    const allowed = selfTimeLine('zh', 30, 20, false, '开源游戏设计');
    expect(allowed).toContain('只探索这些主题');
    expect(allowed).toContain('<topics>\n开源游戏设计\n</topics>');
    const enUnlimited = selfTimeLine('en', 120, 15, true);
    expect(enUnlimited).toContain('no time limit');
    expect(enUnlimited).not.toContain('15 minutes');
  });
});

describe('Coo’s quiet line', () => {
  it('offers her own time with the session limit when the setting is on, and Cormini’s line when it is off', () => {
    const on = coopanionPersona(Cormini, {
      selfTime: () => ({ ...SELF_TIME_DEFAULTS, enabled: true, sessionMinutes: 15 }),
      modelLanguage: () => 'zh',
    });
    const p = new on({ memoryDir: mkdtempSync(join(tmpdir(), 'coo-self-time-')) });
    const line = (p as unknown as { tickText(seconds: number): string }).tickText(30);
    expect(line).toContain('自己的时间');
    expect(line).toContain('15 分钟');
    expect(line).toContain('不要搜索或打开浏览器');
    const unlimited = coopanionPersona(Cormini, {
      selfTime: () => ({ ...SELF_TIME_DEFAULTS, enabled: true, sessionUnlimited: true }),
      modelLanguage: () => 'zh',
    });
    const u = new unlimited({ memoryDir: mkdtempSync(join(tmpdir(), 'coo-self-time-')) });
    expect((u as unknown as { tickText(seconds: number): string }).tickText(30)).toContain('不限时长');
    const off = coopanionPersona(Cormini, { selfTime: () => ({ ...SELF_TIME_DEFAULTS, enabled: false }) });
    const q = new off({ memoryDir: mkdtempSync(join(tmpdir(), 'coo-self-time-')) });
    const quiet = (q as unknown as { tickText(seconds: number): string }).tickText(90);
    expect(quiet).toContain('已安静');
    expect(quiet).not.toContain('自己的时间');
  });
});

describe('browser guard', () => {
  it('refuses spending and private messages, but not likes or favorites', () => {
    expect(clickRefusal('立即购买')).toBe('payment');
    expect(clickRefusal('打赏')).toBe('payment');
    expect(clickRefusal('发消息')).toBe('private');
    expect(clickRefusal('点赞')).toBeNull();
    expect(clickRefusal('收藏')).toBeNull();
    expect(clickRefusal('删除')).toBe('destructive');
    expect(clickRefusal('删除评论')).toBe('destructive');
    expect(clickRefusal('Delete comment')).toBe('destructive');
  });

  it('refuses password and personal fields, and recognizes search fields', () => {
    expect(typeRefusal({ type: 'password' })).toBe('personal');
    expect(typeRefusal({ placeholder: '请输入手机号' })).toBe('personal');
    expect(typeRefusal({ placeholder: '发个友善的弹幕' })).toBeNull();
    expect(isSearchField({ type: 'search' })).toBe(true);
    expect(isSearchField({ placeholder: '搜索视频' })).toBe(true);
    expect(isWriteAction('点赞')).toBe(true);
    expect(isWriteAction('分享')).toBe(true);
    expect(isWriteAction('播放')).toBe(false);
    expect(isWriteAction('删除评论')).toBe(true);
    expect(targetStateToggle('点赞 12 · 点赞')).toBe('like');
    expect(targetStateToggle('收藏夹')).toBeNull();
  });

  it('never clicks a delete control even while public actions are enabled', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = {
      ...page(),
      snapshotId: 'snapshot-delete',
      elements: [{ id: 3, label: '删除评论' }],
    };
    bridge.element = element({
      id: 3, tag: 'button', text: '删除评论', label: '删除评论', title: '', snapshotId: 'snapshot-delete',
    });
    await run(world, 'browser_open', { url: 'https://www.douyin.com/creator-micro/comment/manage' });
    const out = await run(world, 'browser_click', { index: 3 });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('删除或移除内容');
    expect(bridge.calls.some((call) => call.op === 'click')).toBe(false);
  });

  it('recognizes final publishing controls on the main Douyin site and leaves them to the person', async () => {
    const { world, bridge } = await make();
    const douyin = page({ url: 'https://www.douyin.com/video/123', title: '视频' });
    bridge.responses.open = douyin;
    bridge.element = element({ id: 3, tag: 'button', label: '发布', text: '发布', title: '', snapshotId: douyin.snapshotId });
    await run(world, 'browser_open', { url: douyin.url });

    const out = await run(world, 'browser_click', { index: 3 });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('最终发布只能由你在浏览器窗口里亲自点击');
    expect(bridge.calls.some((call) => call.op === 'click')).toBe(false);
  });
});

describe('browser World', () => {
  it('opens a page, strips the new-element marker, and shows the video line', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    const out = await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('哔哩哔哩');
    expect(out.text).toContain('[1]<a >一个视频 />');
    expect(out.text).not.toContain('*[1]');
    expect(out.text).toContain('视频: 没有');
    expect(bridge.calls.find((c) => c.op === 'open')?.args).toMatchObject({ muted: true });
  });

  it('refuses a page that is not http(s) before opening the window', async () => {
    const { world, bridge } = await make();
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1:17788/', 'http://192.168.1.1/', 'http://[::1]/']) {
      const out = await run(world, 'browser_open', { url });
      expect(out.failed).toBe(true);
    }
    expect(bridge.calls.some((c) => c.op === 'open')).toBe(false);
  });

  it('reads only after a session starts', async () => {
    const { world, bridge } = await make();
    const out = await run(world, 'browser_read', {});
    expect(out.failed).toBe(true);
    expect(out.text).toContain('还没打开');
    expect(bridge.calls.some((c) => c.op === 'read')).toBe(false);
  });

  it('reads page text and finds a line in it', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    bridge.responses.read = page();
    bridge.responses.text = { url: 'https://www.bilibili.com/', title: '哔哩哔哩', text: '第一行\n视频标题\n第三行', video: null };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const text = await run(world, 'browser_text', {});
    expect(text.text).toContain('视频标题');
    const found = await run(world, 'browser_find', { query: '第三行' });
    expect(found.text).toContain('第三行');
  });

  it('submits one image prompt through the ChatGPT page and reports an unclear result without retrying', async () => {
    const { world, bridge } = await make({ self: { actions: true, imageGeneration: true }, ask: async () => 'yes' });
    const chatgpt = { ...page({ url: 'https://chatgpt.com/', title: 'ChatGPT', header: 'ChatGPT', content: 'Message' }), snapshotId: 'chatgpt-snapshot' };
    bridge.responses.open = chatgpt;
    bridge.responses.read = chatgpt;
    bridge.responses['chatgpt-composer'] = { id: 'composer-1', snapshotId: 'chatgpt-snapshot' };
    bridge.responses['chatgpt-generate-image'] = {
      submitted: false,
      state: chatgpt,
      base64: Buffer.from('page').toString('base64'),
      width: 640,
      height: 480,
    };
    await run(world, 'browser_open', { url: 'https://chatgpt.com/' });
    const out = await run(world, 'browser_chatgpt_generate_image', { prompt: 'A cozy little whale beside a window' });
    const retry = await run(world, 'browser_chatgpt_generate_image', { prompt: 'A cozy little whale beside a window' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('不要再次提交');
    expect(retry.failed).toBe(true);
    expect(retry.text).toContain('没有重发');
    expect(bridge.calls.filter((call) => call.op === 'chatgpt-generate-image')).toHaveLength(1);
  });

  it('tracks a one-shot image task from the exact prompt turn through a newly observed assistant image', async () => {
    const prompt = 'A small whale reading beside a rainy window';
    const questions: string[] = [];
    const { world, bridge, taskJournalFile } = await make({
      self: { actions: true, imageGeneration: true, mediaDownload: true },
      ask: async (question) => { questions.push(question); return 'yes'; },
    });
    const chatgpt = { ...page({ url: 'https://chatgpt.com/c/abc', title: 'ChatGPT', content: 'Message' }), snapshotId: 'chatgpt-snapshot' };
    bridge.responses.open = chatgpt;
    bridge.responses.read = chatgpt;
    bridge.responses['chatgpt-composer'] = { id: 'composer-1', snapshotId: 'chatgpt-snapshot' };
    bridge.responses['chatgpt-generate-image'] = (args: Record<string, unknown>) => ({
      submitted: true,
      task: {
        taskId: args.taskId, promptDigest: args.promptDigest, status: 'prompt_submitted',
        userTurnDigest: 'b'.repeat(64), evidenceDigest: 'c'.repeat(64),
      },
      state: chatgpt,
      base64: Buffer.from('page').toString('base64'), width: 640, height: 480,
    });
    let polls = 0;
    bridge.responses['chatgpt-image-status'] = (args: Record<string, unknown>) => ({
      taskId: args.taskId, promptDigest: args.promptDigest,
      status: ++polls === 1 ? 'generating' : 'image_available',
      imageCount: polls === 1 ? 0 : 1, evidenceDigest: (polls === 1 ? 'd' : 'e').repeat(64),
    });

    await run(world, 'browser_open', { url: chatgpt.url });
    const submitted = await run(world, 'browser_chatgpt_generate_image', { prompt });
    expect(submitted.failed).toBeUndefined();
    expect(submitted.text).toContain('prompt_submitted');
    expect(questions[0]).toContain(prompt);
    expect(questions[0]).toContain('额度');
    const journalAfterSubmit = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<{ taskId: string; phase: string; payloadDigest: string }>;
    const action = journalAfterSubmit.at(-1)!;
    expect(action.taskId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(action.phase).toBe('submitted');
    expect(action.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(journalAfterSubmit)).not.toContain(prompt);
    const overlapping = await run(world, 'browser_chatgpt_generate_image', { prompt: 'A different image request' });
    expect(overlapping.failed).toBe(true);
    expect(bridge.calls.filter((call) => call.op === 'chatgpt-generate-image')).toHaveLength(1);
    const directory = dirname(taskJournalFile);
    const mediaPage = {
      ...chatgpt,
      mediaTargets: [{ index: 0, token: 'a'.repeat(64), mediaType: 'image' as const, label: 'Generated whale', host: 'files.oaiusercontent.com', filenameHint: 'generated.png' }],
    };
    bridge.responses.read = mediaPage;
    await run(world, 'browser_read', {});
    const beforeImage = await run(world, 'browser_download_media', {
      index: 0, directory, filename: 'generated.png', maxBytes: 1024, taskId: action.taskId,
    });
    expect(beforeImage.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'download-media')).toBe(false);

    const generating = await run(world, 'browser_chatgpt_image_status', { taskId: action.taskId });
    expect(generating.text).toContain('generating');
    const available = await run(world, 'browser_chatgpt_image_status', { taskId: action.taskId });
    expect(available.text).toContain('image_available');
    expect(available.text).toContain('1');
    const journalAfterImage = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<{ taskId: string; phase: string; evidence: Array<{ status: string }> }>;
    expect(journalAfterImage.at(-1)).toMatchObject({ taskId: action.taskId, phase: 'verified' });
    expect(journalAfterImage.at(-1)?.evidence.map((item) => item.status)).toContain('image_available');

    bridge.responses['download-media'] = {
      status: 'download_verified', file: 'generated.png', path: join(directory, 'generated.png'), sourceHost: 'files.oaiusercontent.com',
      mediaType: 'image', mime: 'image/png', bytes: 512, digest: 'f'.repeat(64),
      stages: ['downloading', 'saved_unverified', 'download_verified'].map((status) => ({ status, observedAt: Date.now() })),
    };
    const downloaded = await run(world, 'browser_download_media', {
      index: 0, directory, filename: 'generated.png', maxBytes: 1024, taskId: action.taskId,
    });
    expect(downloaded.failed, downloaded.text).toBeUndefined();
    expect(downloaded.text).toContain('SHA-256');
    expect(bridge.calls.find((call) => call.op === 'download-media')?.args).toMatchObject({ imageTaskId: action.taskId });
    expect(questions[1]).toContain(action.taskId);
  });

  it('requires the Core approval bubble to submit an image prompt', async () => {
    const { world, bridge } = await make({ self: { imageGeneration: true } });
    const chatgpt = { ...page({ url: 'https://chatgpt.com/', title: 'ChatGPT' }), snapshotId: 'chatgpt-snapshot' };
    bridge.responses.open = chatgpt;
    bridge.responses.read = chatgpt;
    bridge.responses['chatgpt-composer'] = { id: 'composer-1', snapshotId: 'chatgpt-snapshot' };
    await run(world, 'browser_open', { url: 'https://chatgpt.com/' });
    const out = await run(world, 'browser_chatgpt_generate_image', { prompt: 'A blue whale' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('not_dispatched');
    expect(bridge.calls.some((call) => call.op === 'chatgpt-generate-image')).toBe(false);
  });

  it('stages a ChatGPT image, shows its hash, then saves only after a second Core approval', async () => {
    const questions: string[] = [];
    const { world, bridge, taskJournalFile } = await make({
      self: { actions: false, imageSaving: true },
      ask: async (question) => { questions.push(question); return 'yes'; },
    });
    const state = {
      ...page({ url: 'https://chatgpt.com/c/abc', title: 'ChatGPT', content: 'Generated image' }),
      snapshotId: 'image-state',
      elements: [{ id: 2, label: 'Download' }],
    };
    bridge.responses.open = state;
    bridge.responses.read = state;
    bridge.element = element({ id: 2, tag: 'button', label: 'Download', text: 'Download', snapshotId: 'image-state' });
    const stagedFile = 'chatgpt-image-1730000000000-123e4567-e89b-12d3-a456-426614174000.png';
    const stageToken = '223e4567-e89b-12d3-a456-426614174000';
    const digest = 'a'.repeat(64);
    bridge.responses['stage-chatgpt-image'] = {
      stageToken, file: stagedFile, bytes: 1024, mime: 'image/png', digest, state,
    };
    bridge.responses['commit-staged-chatgpt-image'] = {
      file: stagedFile, bytes: 1024, mime: 'image/png', digest,
    };
    await run(world, 'browser_open', { url: 'https://chatgpt.com/c/abc' });
    const out = await run(world, 'browser_save_chatgpt_image', { index: 2 });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain(stagedFile);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain('暂存');
    expect(questions[1]).toContain(stagedFile);
    expect(questions[1]).toContain('1024 字节');
    expect(questions[1]).toContain(digest);
    expect(bridge.calls.find((call) => call.op === 'stage-chatgpt-image')?.args).toMatchObject({ index: 2, snapshotId: 'image-state' });
    expect(bridge.calls.find((call) => call.op === 'commit-staged-chatgpt-image')?.args)
      .toMatchObject({ stageToken, file: stagedFile, bytes: 1024, mime: 'image/png', digest, snapshotId: 'image-state' });
    const journal = JSON.parse(readFileSync(taskJournalFile, 'utf8'));
    expect(journal).toHaveLength(2);
    expect(journal.map((action: { phase: string }) => action.phase)).toEqual(['verified', 'verified']);
  });

  it('discards a staged image when the final media save is declined', async () => {
    let prompts = 0;
    const { world, bridge } = await make({
      self: { imageSaving: true },
      ask: async () => (++prompts === 1 ? 'yes' : 'no'),
    });
    const state = {
      ...page({ url: 'https://chatgpt.com/c/abc', title: 'ChatGPT' }),
      snapshotId: 'image-state',
    };
    bridge.responses.open = state;
    bridge.responses.read = state;
    bridge.element = element({ label: 'Download', text: 'Download', snapshotId: 'image-state' });
    bridge.responses['stage-chatgpt-image'] = {
      stageToken: '223e4567-e89b-12d3-a456-426614174000',
      file: 'chatgpt-image-1730000000000-123e4567-e89b-12d3-a456-426614174000.png',
      bytes: 1024, mime: 'image/png', digest: 'b'.repeat(64), state,
    };
    await run(world, 'browser_open', { url: state.url });
    const out = await run(world, 'browser_save_chatgpt_image', { index: 2 });
    expect(out.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'discard-staged-chatgpt-image')).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'commit-staged-chatgpt-image')).toBe(false);
  });

  it('does not retry an image save after the final commit result is unknown', async () => {
    let prompts = 0;
    let stages = 0;
    const { world, bridge, taskJournalFile } = await make({
      self: { imageSaving: true },
      ask: async () => { prompts++; return 'yes'; },
    });
    const state = {
      ...page({ url: 'https://chatgpt.com/c/abc', title: 'ChatGPT' }),
      snapshotId: 'image-state',
    };
    bridge.responses.open = state;
    bridge.responses.read = state;
    bridge.element = element({ label: 'Download', text: 'Download', snapshotId: 'image-state' });
    bridge.responses['stage-chatgpt-image'] = () => {
      stages++;
      return {
        stageToken: `223e4567-e89b-12d3-a456-42661417400${stages}`,
        file: `chatgpt-image-173000000000${stages}-123e4567-e89b-12d3-a456-426614174000.png`,
        bytes: 1024, mime: 'image/png', digest: 'c'.repeat(64), state,
      };
    };
    bridge.responses['commit-staged-chatgpt-image'] = new Error('bridge timeout');
    await run(world, 'browser_open', { url: state.url });
    const first = await run(world, 'browser_save_chatgpt_image', { index: 2 });
    const second = await run(world, 'browser_save_chatgpt_image', { index: 2 });
    expect(first.failed).toBe(true);
    expect(second.failed).toBe(true);
    expect(stages).toBe(2);
    expect(prompts).toBe(3);
    expect(bridge.calls.filter((call) => call.op === 'commit-staged-chatgpt-image')).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.op === 'discard-staged-chatgpt-image')).toHaveLength(2);
    const journal = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<{ phase: string; duplicateKey: string }>;
    expect(journal.some((action) => action.phase === 'unknown')).toBe(true);
    expect(new Set(journal.filter((action) => action.phase === 'unknown').map((action) => action.duplicateKey)).size).toBe(1);
  });

  it('refuses ChatGPT image generation when its separate permission is off', async () => {
    const { world, bridge } = await make({ self: { actions: true, imageGeneration: false } });
    bridge.responses.open = page({ url: 'https://chatgpt.com/', title: 'ChatGPT' });
    await run(world, 'browser_open', { url: 'https://chatgpt.com/' });
    const out = await run(world, 'browser_chatgpt_generate_image', { prompt: 'A blue whale' });
    expect(out.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'chatgpt-generate-image')).toBe(false);
  });

  it('places only listed media into a current Douyin file input without publishing the post', async () => {
    let approvalQuestion = '';
    const { world, bridge } = await make({
      self: { actions: false, mediaUpload: true },
      ask: async (question) => { approvalQuestion = question; return 'yes'; },
    });
    const state = {
      ...page({ url: 'https://creator.douyin.com/creator-micro/upload', title: '发布作品' }),
      snapshotId: 'upload-snapshot',
      account: { ref: 'creator-1', label: '测试账号' },
      fileInputs: [{ id: 88, label: '上传视频', accept: 'video/mp4,image/png', multiple: true, disabled: false, visible: false }],
    };
    bridge.responses.open = state;
    bridge.responses.read = state;
    const approvedFiles = [{
      path: 'generated/cover.png', bytes: 321, digest: 'a'.repeat(64), mime: 'image/png',
    }];
    const inspection = {
      url: state.url,
      snapshotId: 'upload-snapshot',
      accept: 'video/mp4,image/png',
      multiple: true,
      account: state.account,
      files: approvedFiles,
    };
    bridge.responses['inspect-upload'] = inspection;
    bridge.responses['upload-media'] = { files: ['generated/cover.png'], state };
    await run(world, 'browser_open', { url: state.url });
    const out = await run(world, 'browser_upload_media', { fileId: 88, files: ['generated/cover.png'] });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('generated/cover.png');
    expect(out.text).toContain('没有提交作品');
    expect(approvalQuestion).toContain('测试账号 (creator-1)');
    expect(approvalQuestion).toContain('sha256 ' + 'a'.repeat(64));
    expect(bridge.calls.find((call) => call.op === 'upload-media')?.args)
      .toMatchObject({ fileId: 88, snapshotId: 'upload-snapshot', files: ['generated/cover.png'], expectedFiles: approvedFiles });
  });

  it('keeps Douyin upload receipts open across reads until the page reports a durable result', async () => {
    const { world, bridge, taskJournalFile } = await make({
      self: { actions: false, mediaUpload: true },
      ask: async () => 'yes',
    });
    let currentState = {
      ...page({ url: 'https://creator.douyin.com/creator-micro/upload', title: '发布作品' }),
      snapshotId: 'upload-snapshot',
      account: { ref: 'creator-1', label: '测试账号' },
      fileInputs: [{ id: 88, label: '上传视频', accept: 'video/mp4', multiple: false, disabled: false, visible: true }],
      statusMessages: [] as string[],
    };
    const approvedFiles = [{ path: 'preview.mp4', bytes: 1234, digest: 'b'.repeat(64), mime: 'video/mp4' }];
    bridge.responses.open = () => currentState;
    bridge.responses.read = () => currentState;
    bridge.responses['inspect-upload'] = {
      url: currentState.url,
      snapshotId: currentState.snapshotId,
      accept: 'video/mp4',
      multiple: false,
      account: currentState.account,
      files: approvedFiles,
    };
    bridge.responses['upload-media'] = () => ({ files: ['preview.mp4'], state: currentState });
    bridge.responses['inspect-upload-progress'] = () => ({
      url: currentState.url,
      snapshotId: currentState.snapshotId,
      account: currentState.account,
      selection: { names: ['preview.mp4'], accept: 'video/mp4', multiple: false },
      statusMessages: currentState.statusMessages,
    });

    await run(world, 'browser_open', { url: currentState.url });
    expect((await run(world, 'browser_upload_media', { fileId: 88, files: ['preview.mp4'] })).failed).toBeUndefined();
    let receipts = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>;
    expect(receipts[0]).toMatchObject({ phase: 'acting', dispatchState: 'delivered', outcome: 'delivered' });
    expect(receipts[0].evidence).toEqual(expect.arrayContaining([expect.objectContaining({
      source: 'douyin-upload-state', status: 'file_selected',
    })]));

    currentState = { ...currentState, statusMessages: ['草稿已保存'] };
    await run(world, 'browser_read', {});
    receipts = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>;
    expect(receipts[0]).toMatchObject({ phase: 'draft-ready', outcome: 'draft-ready' });

    currentState = { ...currentState, statusMessages: ['草稿已保存', '作品已提交'] };
    await run(world, 'browser_read', {});
    receipts = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>;
    expect(receipts[0]).toMatchObject({ phase: 'submitted', outcome: 'remote-acknowledged' });

    currentState = { ...currentState, statusMessages: ['草稿已保存', '作品已提交', '作品审核中'] };
    await run(world, 'browser_read', {});
    receipts = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>;
    expect(receipts[0]).toMatchObject({ phase: 'review-pending', outcome: 'review-pending' });

    currentState = { ...currentState, statusMessages: ['草稿已保存', '作品已提交', '作品审核中', '作品已发布'] };
    await run(world, 'browser_read', {});
    receipts = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>;
    expect(receipts[0]).toMatchObject({ phase: 'verified', outcome: 'verified' });
    expect(bridge.calls.filter((call) => call.op === 'inspect-upload-progress')).toHaveLength(4);
  });

  it('keeps upload notices unattributed when account, URL, snapshot or selected files do not match', async () => {
    const { world, bridge, taskJournalFile } = await make({
      self: { actions: false, mediaUpload: true },
      ask: async () => 'yes',
    });
    const uploadUrl = 'https://creator.douyin.com/creator-micro/upload';
    let currentState = {
      ...page({ url: uploadUrl, title: '发布作品' }),
      snapshotId: 'upload-snapshot',
      account: { ref: 'creator-1', label: '测试账号' },
      fileInputs: [{ id: 88, label: '上传视频', accept: 'video/mp4', multiple: false, disabled: false, visible: true }],
      statusMessages: [] as string[],
    };
    let reportedAccount = currentState.account;
    let reportedUrl = uploadUrl;
    let reportedSnapshot = currentState.snapshotId;
    let selectionNames = ['preview.mp4'];
    let observedMessages: string[] = [];
    const approvedFiles = [{ path: 'preview.mp4', bytes: 1234, digest: 'c'.repeat(64), mime: 'video/mp4' }];
    bridge.responses.open = () => currentState;
    bridge.responses.read = () => currentState;
    bridge.responses['inspect-upload'] = {
      url: uploadUrl, snapshotId: currentState.snapshotId, accept: 'video/mp4', multiple: false,
      account: currentState.account, files: approvedFiles,
    };
    bridge.responses['upload-media'] = () => ({ files: ['preview.mp4'], state: currentState });
    bridge.responses['inspect-upload-progress'] = () => ({
      url: reportedUrl, snapshotId: reportedSnapshot, account: reportedAccount,
      selection: { names: selectionNames, accept: 'video/mp4', multiple: false }, statusMessages: observedMessages,
    });

    await run(world, 'browser_open', { url: uploadUrl });
    await run(world, 'browser_upload_media', { fileId: 88, files: ['preview.mp4'] });
    const progressCalls = () => bridge.calls.filter((call) => call.op === 'inspect-upload-progress').length;

    reportedAccount = { ref: 'creator-2', label: '其他账号' };
    await run(world, 'browser_read', {});
    expect(progressCalls()).toBe(1);
    expect((JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>)[0])
      .toMatchObject({ phase: 'acting', outcome: 'delivered' });
    reportedAccount = currentState.account;

    currentState = { ...currentState, url: `${uploadUrl}?step=other` };
    await run(world, 'browser_read', {});
    expect(progressCalls()).toBe(1);
    currentState = { ...currentState, url: uploadUrl };

    reportedSnapshot = 'stale-snapshot';
    await run(world, 'browser_read', {});
    expect(progressCalls()).toBe(2);
    reportedSnapshot = currentState.snapshotId;

    selectionNames = ['different.mp4'];
    observedMessages = ['作品已发布'];
    currentState = { ...currentState, statusMessages: observedMessages };
    await run(world, 'browser_read', {});
    const receipts = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>;
    const evidence = receipts[0].evidence as Array<Record<string, unknown>>;
    expect(receipts[0]).toMatchObject({ phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown' });
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'douyin-upload-file-input', status: 'mismatch' }),
      expect.objectContaining({ source: 'douyin-upload-notice', status: 'unattributed' }),
      expect.objectContaining({ source: 'douyin-upload-state', status: 'unknown' }),
    ]));
    expect(evidence.some((item) => item.status === 'published_verified')).toBe(false);
  });

  it('does not upload media when its separate permission is off, even if social actions are on', async () => {
    const { world, bridge } = await make({ self: { actions: true, mediaUpload: false } });
    bridge.responses.open = {
      ...page({ url: 'https://creator.douyin.com/creator-micro/upload', title: '发布作品' }),
      snapshotId: 'upload-snapshot',
      fileInputs: [{ id: 88, label: '上传视频', accept: 'video/mp4', multiple: false, disabled: false, visible: false }],
    };
    await run(world, 'browser_open', { url: 'https://creator.douyin.com/creator-micro/upload' });
    const out = await run(world, 'browser_upload_media', { fileId: 88, files: ['preview.mp4'] });
    expect(out.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'upload-media')).toBe(false);
  });

  it('keeps media downloads off independently of upload and social-action settings', async () => {
    const { world, bridge } = await make({ self: { actions: true, mediaUpload: true, mediaDownload: false } });
    bridge.responses.open = page({
      snapshotId: 'media-snapshot',
      mediaTargets: [{ index: 0, token: 'a'.repeat(64), mediaType: 'image', label: 'Blue whale', host: 'cdn.example.com', filenameHint: 'whale.png' }],
    });
    await run(world, 'browser_open', { url: 'https://www.example.com/' });
    const out = await run(world, 'browser_download_media', {
      index: 0, directory: '/tmp', filename: 'whale.png', maxBytes: 1024,
    });
    expect(out.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'download-media')).toBe(false);
  });

  it('binds a one-time media download approval to the current opaque target and records file verification', async () => {
    const { world, bridge, taskJournalFile } = await make({
      self: { mediaDownload: true },
      ask: async () => 'yes',
    });
    const mediaTarget = {
      index: 0, token: 'a'.repeat(64), mediaType: 'image' as const, label: 'Blue whale', host: 'cdn.example.com',
      filenameHint: 'whale.png', url: 'https://cdn.example.com/whale.png?token=secret',
    } as NonNullable<Page['mediaTargets']>[number];
    const snapshot = page({
      url: 'https://www.example.com/page',
      snapshotId: 'media-snapshot',
      mediaTargets: [mediaTarget],
    });
    bridge.responses.open = snapshot;
    bridge.responses.read = snapshot;
    const directory = dirname(taskJournalFile);
    const path = join(directory, 'whale.png');
    bridge.responses['download-media'] = ({ token }: Record<string, unknown>) => ({
      status: 'download_verified', file: 'whale.png', path, sourceHost: 'cdn.example.com',
      mediaType: 'image', mime: 'image/png', bytes: 9, digest: 'b'.repeat(64),
      stages: [
        { status: 'downloading', observedAt: 10 },
        { status: 'saved_unverified', observedAt: 20 },
        { status: 'download_verified', observedAt: 30 },
      ],
      token,
    });
    const opened = await run(world, 'browser_open', { url: snapshot.url });
    expect(opened.text).toContain('Blue whale');
    expect(opened.text).not.toContain('token=secret');
    const out = await run(world, 'browser_download_media', {
      index: 0, directory, filename: 'whale.png', maxBytes: 1024,
    });

    expect(out.failed).toBeFalsy();
    expect(out.text).toContain(path);
    const downloadCall = bridge.calls.find((call) => call.op === 'download-media');
    expect(downloadCall?.args).toMatchObject({ index: 0, token: 'a'.repeat(64), snapshotId: 'media-snapshot', directory, filename: 'whale.png', maxBytes: 1024 });
    expect(JSON.stringify(bridge.calls)).not.toContain('token=secret');
    const receipts = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<Record<string, unknown>>;
    expect(receipts[0]).toMatchObject({ intent: 'media-download', risk: 'REVERSIBLE_LOCAL', phase: 'verified', outcome: 'verified' });
    expect(receipts[0].evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'downloading' }),
      expect.objectContaining({ status: 'saved_unverified' }),
      expect.objectContaining({ status: 'download_verified', digest: 'b'.repeat(64) }),
    ]));
  });

  it('refuses a payment control before calling the page', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element({ text: '立即购买', label: '立即购买', title: '' });
    const out = await run(world, 'browser_click', { index: 2 });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('没有点');
    expect(bridge.calls.some((c) => c.op === 'click')).toBe(false);
  });

  it('refuses a payment control named by its visible text before calling the page', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_click', { text: '立即购买' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('没有点');
    expect(bridge.calls.some((c) => c.op === 'click')).toBe(false);
  });

  it('clicks a control by its visible text when it has no number', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    bridge.responses.click = { answer: { success: true }, state: page({ content: '[3]<div >添加音乐 />' }) };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_click', { text: '添加音乐' });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('点了「添加音乐');
    expect(out.text).toContain('添加音乐');
  });

  it('resolves a structured locator against the latest snapshot before clicking', async () => {
    const { world, bridge } = await make();
    const snapshotId = 'locator-snapshot';
    bridge.responses.open = page({ snapshotId, elements: [{ id: 9, label: 'Continue' }] });
    bridge.responses['resolveLocator'] = (args: Record<string, unknown>) => ({ ok: true, id: 9, snapshotId: args.expectedSnapshotId });
    bridge.element = element({ id: 9, tag: 'button', label: 'Continue', text: 'Continue', title: '', role: 'button', dataE2e: 'submit', snapshotId });
    bridge.responses.click = { answer: { success: true }, state: page({ snapshotId: 'after-click', content: '[9]<button >Continue />' }) };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });

    const locator = { role: 'button', name: 'Continue', testId: 'submit', within: { role: 'article', name: 'Form A' } };
    const out = await run(world, 'browser_click', { locator });
    expect(out.failed).toBeUndefined();
    expect(bridge.calls.find((call) => call.op === 'resolveLocator')?.args).toMatchObject({ locator, expectedSnapshotId: snapshotId });
    expect(bridge.calls.find((call) => call.op === 'click')?.args).toMatchObject({ index: 9, snapshotId });
  });

  it('refuses an ambiguous structured locator before dispatch', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page({ snapshotId: 'locator-snapshot', elements: [{ id: 9, label: 'Continue' }] });
    bridge.responses['resolveLocator'] = { ok: false, reason: 'ambiguous' };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });

    const out = await run(world, 'browser_click', { locator: { role: 'button', name: 'Continue' } });
    expect(out.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'click')).toBe(false);
  });

  it('clicks a like and returns the page after it', async () => {
    let approvalQuestion = '';
    const { world, bridge, taskJournalFile } = await make({
      self: { actions: true },
      ask: async (question) => { approvalQuestion = question; return 'yes'; },
    });
    const video = { url: 'https://www.bilibili.com/video/BV1test', title: '测试视频' };
    const account = { ref: 'https://www.bilibili.com/user/1', label: '测试账号' };
    const before = page({
      snapshotId: 'like-snapshot', current: video, account,
      elements: [{ id: 2, label: '点赞 12' }],
    });
    const after = page({
      snapshotId: 'like-snapshot-2', current: video, account,
      elements: [{ id: 2, label: '已点赞' }],
      content: '[2]<div title=已点赞>13 />',
    });
    bridge.responses.open = before;
    bridge.responses.read = before;
    bridge.responses.click = { answer: { success: true }, state: after };
    await run(world, 'browser_open', { url: before.url });
    bridge.element = element({ snapshotId: 'like-snapshot' });
    const out = await run(world, 'browser_click', { index: 2 });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('点了「点赞 12');
    expect(out.text).toContain('13');
    expect(approvalQuestion).toContain('测试账号');
    expect(approvalQuestion).toContain('BV1test');
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))[0].phase).toBe('verified');
  });

  it('requires a known inactive state before a Douyin like and never toggles an active one off', async () => {
    let asked = 0;
    const { world, bridge } = await make({ self: { actions: true }, ask: async () => { asked++; return 'yes'; } });
    const video = {
      url: 'https://www.douyin.com/video/123', title: '海边的下午', itemId: '123',
      authorRef: 'https://www.douyin.com/user/creator-1', authorLabel: '阿青', contentSnippet: '海边的下午',
      containerIdentity: 'article:video-card:123:article', playing: true, observedAt: Date.now(),
    };
    const account = { ref: 'https://www.douyin.com/user/1', label: '我的主页' };
    const state = page({ url: video.url, snapshotId: 'douyin-like', current: video, account, elements: [{ id: 2, label: '点赞' }] });
    bridge.responses.open = state;
    bridge.responses.read = state;
    await run(world, 'browser_open', { url: state.url });
    bridge.element = element({ id: 2, tag: 'button', label: '点赞', text: '点赞', title: '', snapshotId: state.snapshotId });
    const unknown = await run(world, 'browser_click', { index: 2 });
    expect(unknown.failed).toBe(true);
    expect(unknown.text).toContain('current toggle state');

    bridge.element = element({ id: 2, tag: 'button', label: '点赞', text: '点赞', title: '', pressed: true, snapshotId: state.snapshotId });
    const active = await run(world, 'browser_click', { index: 2 });
    expect(active.failed).toBe(true);
    expect(active.text).toContain('现在已经是');
    expect(asked).toBe(0);
    expect(bridge.calls.some((call) => call.op === 'click')).toBe(false);
  });

  it('confirms a Douyin like only after aria-pressed changes from false to true', async () => {
    const { world, bridge, taskJournalFile } = await make({ self: { actions: true }, ask: async () => 'yes' });
    const video = {
      url: 'https://www.douyin.com/video/123', title: '海边的下午', itemId: '123',
      authorRef: 'https://www.douyin.com/user/creator-1', authorLabel: '阿青', contentSnippet: '海边的下午',
      containerIdentity: 'article:video-card:123:article', playing: true, observedAt: Date.now(),
    };
    const account = { ref: 'https://www.douyin.com/user/1', label: '我的主页' };
    const before = page({ url: video.url, snapshotId: 'douyin-like-before', current: video, account, elements: [{ id: 2, label: '点赞', pressed: false }] });
    const after = page({ url: video.url, snapshotId: 'douyin-like-after', current: video, account, elements: [{ id: 2, label: '点赞', pressed: true }] });
    bridge.responses.open = before;
    bridge.responses.read = before;
    bridge.responses.click = { answer: { success: true }, state: after };
    await run(world, 'browser_open', { url: before.url });
    bridge.element = element({ id: 2, tag: 'button', label: '点赞', text: '点赞', title: '', pressed: false, snapshotId: before.snapshotId });

    const out = await run(world, 'browser_click', { index: 2 });
    expect(out.failed).toBeUndefined();
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))[0]).toMatchObject({ phase: 'verified', outcome: 'ui-observed' });
  });

  it('does not retry an approved toggle whose changed state could not be confirmed', async () => {
    let prompts = 0;
    const { world, bridge, taskJournalFile } = await make({
      self: { actions: true },
      ask: async () => { prompts++; return 'yes'; },
    });
    const video = { url: 'https://www.bilibili.com/video/BV1test', title: '测试视频' };
    const account = { ref: 'https://www.bilibili.com/user/1', label: '测试账号' };
    const state = page({
      snapshotId: 'like-snapshot', current: video, account,
      elements: [{ id: 2, label: '点赞 12' }],
    });
    bridge.responses.open = state;
    bridge.responses.read = state;
    bridge.responses.click = { answer: { success: true }, state };
    await run(world, 'browser_open', { url: state.url });
    bridge.element = element({ snapshotId: 'like-snapshot' });
    const first = await run(world, 'browser_click', { index: 2 });
    const second = await run(world, 'browser_click', { index: 2 });
    expect(first.failed).toBe(true);
    expect(second.failed).toBe(true);
    expect(prompts).toBe(1);
    expect(bridge.calls.filter((call) => call.op === 'click')).toHaveLength(1);
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))[0].phase).toBe('unknown');
  });

  it('hovers an element and returns the controls it reveals', async () => {
    const { world, bridge } = await make({ self: { actions: true } });
    bridge.responses.open = page();
    bridge.responses.hover = { state: page({ content: '[2]<div title=点赞>12 />\n[3]<button >使用 />' }) };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element();
    const out = await run(world, 'browser_hover', { index: 2 });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('鼠标移到「点赞 12');
    expect(out.text).toContain('使用');
  });

  it('opens the share panel and returns its options', async () => {
    const { world, bridge } = await make({ self: { actions: true } });
    bridge.responses.open = page();
    bridge.responses.share = { state: page({ content: '[3]<button >复制链接 />' }) };
    await run(world, 'browser_open', { url: 'https://www.douyin.com/' });
    const out = await run(world, 'browser_share', {});
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('分享面板');
    expect(out.text).toContain('复制链接');
    expect(bridge.calls.some((c) => c.op === 'share')).toBe(true);
  });

  it('refuses to share while actions are off', async () => {
    const { world, bridge } = await make({ self: { actions: false } });
    bridge.responses.open = page();
    await run(world, 'browser_open', { url: 'https://www.douyin.com/' });
    const out = await run(world, 'browser_share', {});
    expect(out.failed).toBe(true);
    expect(out.text).toContain('没有执行');
    expect(bridge.calls.some((c) => c.op === 'share')).toBe(false);
  });

  it('refuses a password field and types into a search box', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    bridge.responses.input = { answer: { success: true }, state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element({ type: 'password', placeholder: '密码', text: '', label: '' });
    const refused = await run(world, 'browser_type', { index: 2, text: 'secret' });
    expect(refused.failed).toBe(true);
    expect(bridge.calls.some((c) => c.op === 'input')).toBe(false);
    bridge.element = element({ type: 'search', placeholder: '搜索', text: '', label: '' });
    const typed = await run(world, 'browser_type', { index: 2, text: '猫' });
    expect(typed.failed).toBeUndefined();
    expect(bridge.calls.some((c) => c.op === 'input')).toBe(true);
  });

  it('keeps likes out when actions are off, and still searches', async () => {
    const { world, bridge, setSelf } = await make({ self: { actions: false } });
    bridge.responses.open = page();
    bridge.responses.input = { answer: { success: true }, state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element();
    const liked = await run(world, 'browser_click', { index: 2 });
    expect(liked.failed).toBe(true);
    expect(liked.text).toContain('没有执行');
    const hovered = await run(world, 'browser_hover', { index: 2 });
    expect(hovered.failed).toBe(true);
    expect(hovered.text).toContain('没有执行');
    bridge.element = element({ type: 'search', placeholder: '搜索', text: '', label: '' });
    const searched = await run(world, 'browser_type', { index: 2, text: '猫' });
    expect(searched.failed).toBeUndefined();
    setSelf({ actions: true });
  });

  it('applies the read-only click guard to Enter and Space on an indexed element', async () => {
    const { world, bridge } = await make({ self: { actions: false } });
    bridge.responses.open = page();
    bridge.responses.press = { state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element();
    const enter = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    const space = await run(world, 'browser_press', { index: 2, key: 'Space' });
    expect(enter.failed).toBe(true);
    expect(space.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('checks the actual focused element when Enter has no index', async () => {
    const { world, bridge } = await make({ self: { actions: false } });
    bridge.responses.open = page();
    bridge.responses.press = { state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.active = element();
    const blocked = await run(world, 'browser_press', { key: 'Enter' });
    expect(blocked.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
    bridge.active = element({ tag: 'input', text: '', label: '', title: '', type: 'search', placeholder: '搜索' });
    const allowed = await run(world, 'browser_press', { key: 'Enter' });
    expect(allowed.failed).toBeUndefined();
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(true);
    bridge.active = null;
    const unknown = await run(world, 'browser_press', { key: 'Space' });
    expect(unknown.failed).toBe(true);
  });

  it('refuses keyboard activation of payment and account controls even when actions are on', async () => {
    const { world, bridge } = await make({ self: { actions: true } });
    bridge.responses.open = page();
    bridge.responses.press = { state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element({ text: '立即购买', label: '立即购买', title: '' });
    const buy = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    bridge.element = element({ text: '退出登录', label: '退出登录', title: '' });
    const signOut = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(buy.failed).toBe(true);
    expect(signOut.failed).toBe(true);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('allows Enter on a write control when actions are explicitly on', async () => {
    const { world, bridge } = await make({ self: { actions: true } });
    bridge.responses.open = page();
    bridge.responses.press = { state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element();
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBeUndefined();
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(true);
  });

  it('takes a screenshot and attaches it when the model accepts images', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    const captured = page({ snapshotId: 'screenshot-snapshot' });
    bridge.responses.screenshot = {
      base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732,
      viewportWidth: 1100, viewportHeight: 732, captureId: 'capture-1', state: captured,
    };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_screenshot', {});
    expect(out.text).toContain('截图');
    expect(out.text).toContain('capture-1');
    expect(out.blobs?.[0]).toMatchObject({ mime: 'image/jpeg' });
    expect(out.blobs?.[0]?.fallbackText).toContain('1100×732');
    expect(out.blobs?.[0]?.fallbackText).not.toContain('看不了');
  });

  it('requires one-step approval for a screenshot point and records the dispatched result as unknown', async () => {
    const questions: string[] = [];
    const state = page({ snapshotId: 'visual-snapshot' });
    const { world, bridge, taskJournalFile } = await make({
      self: { actions: true },
      ask: async (question) => { questions.push(question); return 'yes'; },
    });
    bridge.responses.open = state;
    bridge.responses.read = state;
    bridge.responses.screenshot = {
      base64: Buffer.from('jpeg').toString('base64'), width: 550, height: 366,
      viewportWidth: 1100, viewportHeight: 732, captureId: 'capture-visual-1', state,
    };
    bridge.responses['inspect-screenshot-point'] = {
      ok: true,
      target: {
        token: 'opaque-target-token', label: 'Open menu', tag: 'button', role: 'button', href: '',
        disabled: false, filePicker: false, snapshotId: state.snapshotId,
      },
    };
    bridge.responses['click-screenshot-point'] = {
      answer: { success: true }, state: page({ snapshotId: 'visual-after-click' }),
    };
    await run(world, 'browser_open', { url: state.url });
    await run(world, 'browser_screenshot', {});

    const out = await run(world, 'browser_click', {
      point: { x: 25, y: 40, captureId: 'capture-visual-1', description: 'the open menu button' },
    });
    expect(out.text).toContain('结果未知');
    expect(out.text).toContain('不要重试');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('capture-visual-1');
    expect(questions[0]).toContain('25, 40');
    expect(bridge.calls.filter((call) => call.op === 'click-screenshot-point')).toHaveLength(1);
    expect(bridge.calls.some((call) => call.op === 'click')).toBe(false);
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))[0]).toMatchObject({ phase: 'unknown', outcome: 'unknown' });

    const reused = await run(world, 'browser_click', {
      point: { x: 25, y: 40, captureId: 'capture-visual-1', description: 'the open menu button' },
    });
    expect(reused.failed).toBe(true);
    expect(questions).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.op === 'click-screenshot-point')).toHaveLength(1);

    const after = page({ snapshotId: 'visual-after-click' });
    bridge.responses.screenshot = {
      base64: Buffer.from('jpeg').toString('base64'), width: 550, height: 366,
      viewportWidth: 1100, viewportHeight: 732, captureId: 'capture-visual-2', state: after,
    };
    bridge.responses['inspect-screenshot-point'] = {
      ok: true,
      target: {
        token: 'new-element-token', label: 'Open menu', tag: 'button', role: 'button', href: '',
        disabled: false, filePicker: false, snapshotId: after.snapshotId,
      },
    };
    await run(world, 'browser_screenshot', {});
    const duplicate = await run(world, 'browser_click', {
      point: { x: 24, y: 39, captureId: 'capture-visual-2', description: 'the open menu button' },
    });
    expect(duplicate.text).toContain('没有重发');
    expect(questions).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.op === 'click-screenshot-point')).toHaveLength(1);
  });

  it('refuses screenshot coordinates without a readable live DOM label', async () => {
    const state = page({ snapshotId: 'visual-no-label' });
    let asked = 0;
    const { world, bridge } = await make({ self: { actions: true }, ask: async () => { asked++; return 'yes'; } });
    bridge.responses.open = state;
    bridge.responses.read = state;
    bridge.responses.screenshot = {
      base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732,
      viewportWidth: 1100, viewportHeight: 732, captureId: 'capture-no-label', state,
    };
    bridge.responses['inspect-screenshot-point'] = {
      ok: true,
      target: {
        token: 'opaque-unlabelled-target', label: '', tag: 'canvas', role: 'generic', href: '',
        disabled: false, filePicker: false, snapshotId: state.snapshotId,
      },
    };
    await run(world, 'browser_open', { url: state.url });
    await run(world, 'browser_screenshot', {});

    const out = await run(world, 'browser_click', {
      point: { x: 20, y: 20, captureId: 'capture-no-label', description: 'a button on the canvas' },
    });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('no readable label');
    expect(asked).toBe(0);
    expect(bridge.calls.some((call) => call.op === 'click-screenshot-point')).toBe(false);
  });

  it('keeps screenshot clicks out of destructive, personal-data and checkout targets', async () => {
    for (const target of [
      { label: 'Delete', type: '', description: 'the delete button' },
      { label: 'Password', type: 'password', description: 'the password field' },
      { label: 'Continue', type: '', description: 'the continue button', url: 'https://www.bilibili.com/checkout' },
    ]) {
      let asked = 0;
      const state = page({ snapshotId: `visual-block-${target.type || target.label}`, ...(target.url ? { url: target.url } : {}) });
      const { world, bridge } = await make({ self: { actions: true }, ask: async () => { asked++; return 'yes'; } });
      bridge.responses.open = state;
      bridge.responses.read = state;
      bridge.responses.screenshot = {
        base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732,
        viewportWidth: 1100, viewportHeight: 732, captureId: `capture-block-${target.type || target.label}`, state,
      };
      bridge.responses['inspect-screenshot-point'] = {
        ok: true,
        target: {
          token: `target-${target.type || target.label}`, label: target.label, tag: target.type ? 'input' : 'button',
          role: target.type ? 'textbox' : 'button', type: target.type, placeholder: '', href: '',
          disabled: false, filePicker: false, snapshotId: state.snapshotId,
        },
      };
      await run(world, 'browser_open', { url: state.url });
      await run(world, 'browser_screenshot', {});
      const out = await run(world, 'browser_click', {
        point: { x: 20, y: 20, captureId: `capture-block-${target.type || target.label}`, description: target.description },
      });
      expect(out.failed).toBe(true);
      expect(asked).toBe(0);
      expect(bridge.calls.some((call) => call.op === 'click-screenshot-point')).toBe(false);
    }
  });

  it('says the model cannot see images only when it does not accept them', async () => {
    const { world, bridge } = await make({ sees: false });
    bridge.responses.open = page();
    bridge.responses.screenshot = { base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732, state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_screenshot', {});
    expect(out.blobs).toBeUndefined();
    expect(out.text).toContain('当前模型看不了图片');
  });

  it('watches for a second and reports the video position', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    bridge.responses.screenshot = {
      base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732,
      state: page({ video: { current: 3, duration: 60, paused: false, muted: true, volume: 0, width: 640, height: 360, src: 'blob:x' } }),
    };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_watch', { seconds: 1, frames: 2 });
    expect(out.text).toContain('看了 1 秒');
    expect(out.text).toContain('截了 2 帧');
    expect(out.text).toContain('播放中 0:03 / 1:00, 静音');
    expect(out.blobs).toHaveLength(2);
    expect(out.blobs?.[1]?.fallbackText).toContain('第 1 秒');
    expect(bridge.calls.filter((call) => call.op === 'screenshot')).toHaveLength(2);
  });

  it('turns the watched sound into text', async () => {
    let heard: Int16Array | null = null;
    const { world, bridge } = await make({
      transcribe: async (pcm) => { heard = pcm; return { text: '你好' }; },
    });
    bridge.responses.open = page();
    bridge.responses.screenshot = { base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732, state: page() };
    bridge.responses['audio-start'] = { ok: true };
    bridge.responses['audio-stop'] = { ok: true, wav: wav(1600), seconds: 0.1 };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_watch', { seconds: 1, frames: 1 });
    expect(out.text).toContain('声音里听到:你好');
    expect(heard).not.toBeNull();
    expect(heard!.length).toBe(1600);
    expect(bridge.calls.map((call) => call.op)).toEqual(expect.arrayContaining(['audio-start', 'audio-stop']));
  });

  it('keeps the frames when the sound cannot be recorded', async () => {
    const { world, bridge } = await make({ transcribe: async () => ({ text: '你好' }) });
    bridge.responses.open = page();
    bridge.responses.screenshot = { base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732, state: page() };
    bridge.responses['audio-start'] = { ok: false, error: 'no audio' };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_watch', { seconds: 1, frames: 1 });
    expect(out.text).toContain('声音没能转成文字:no audio');
    expect(out.blobs).toHaveLength(1);
    expect(bridge.calls.some((call) => call.op === 'audio-stop')).toBe(false);
  });

  it('skips the sound when audio is false', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    bridge.responses.screenshot = { base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732, state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_watch', { seconds: 1, frames: 1, audio: false });
    expect(out.text).not.toContain('声音');
    expect(bridge.calls.some((call) => call.op === 'audio-start')).toBe(false);
  });

  it('tells her when the person closes the window', async () => {
    const pushed: Array<Record<string, unknown>> = [];
    const { world, bridge } = await make({ pushed });
    bridge.responses.open = page();
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.emit('closed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushed.map((e) => e.type)).toContain('browser.closed');
  });

  it('closes the window and ends the session', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_close', {});
    expect(out.text).toContain('关上了');
    expect(bridge.calls.some((c) => c.op === 'close')).toBe(true);
  });

  it('has an env prompt that names the session and the allowed actions', async () => {
    const { world, setSelf } = await make();
    const value = (name: string) => {
      const entry = world.envPromptVars()![name];
      return typeof entry === 'string' ? entry : entry.text;
    };
    expect(value('browser.session')).toBe('最多 20 分钟');
    setSelf({ sessionUnlimited: true });
    expect(value('browser.session')).toBe('不限时长');
    setSelf({ sessionUnlimited: false });
    expect(value('browser.actions')).toContain('常规互动已关闭');
    setSelf({ actions: true });
    expect(value('browser.actions')).toContain('常规互动已开启');
    expect(value('browser.actions')).toContain('网页生图已关闭');
    setSelf({ imageGeneration: true, imageSaving: true, mediaUpload: true });
    expect(value('browser.actions')).toContain('网页生图已开启');
    expect(value('browser.actions')).toContain('保存生成图片已开启');
    expect(value('browser.actions')).toContain('素材上传已开启');
    const doc = world.webUi!('zh').promptDocs?.find((d) => d.role === 'envPrompt');
    expect(doc?.path).toBeTruthy();
    expect(existsSync(doc!.path)).toBe(true);
    const template = readFileSync(doc!.path, 'utf8');
    expect(template).toContain('{{browser.session}}');
    expect(template).toContain('{{browser.actions}}');
    expect(template).toContain('{{browser.audio}}');
  });

  it('renders the environment prompt into the prefix with the live settings', async () => {
    const { world, setSelf } = await make();
    const { text } = await renderWorldEnvPrompt(world);
    expect(text).toContain('## 你自己的浏览器');
    expect(text).toContain('最多 20 分钟');
    expect(text).toContain('常规互动已关闭');
    expect(text).toContain('静音');
    expect(text).not.toContain('{{browser.');
    setSelf({ actions: true });
    const { text: allowed } = await renderWorldEnvPrompt(world);
    expect(allowed).toContain('常规互动已开启');
    expect(allowed).toContain('网页生图已关闭');
    expect(allowed).toContain('素材上传已关闭');
    expect(allowed).toContain('browser_upload_media');
  });

  it('describes the tools and the closed event', () => {
    const def = browserDefinition({
      bridge: new FakeBridge(),
      selfTime: () => SELF_TIME_DEFAULTS,
      modelLanguage: () => 'zh',
      language: () => 'zh',
    });
    expect(def.defaults()).toEqual({ enabled: false });
    expect(def.describe?.tools.map((t) => t.name)).toContain('browser_open');
    expect(def.describe?.tools.map((t) => t.name)).toContain('browser_hover');
    expect(def.describe?.tools.map((t) => t.name)).toContain('browser_share');
    expect(def.describe?.events.map((e) => e.type)).toContain('browser.closed');
  });
});
