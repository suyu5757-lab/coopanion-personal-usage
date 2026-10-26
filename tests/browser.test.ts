import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import type { BrowserTransport } from '../core/browser/bridge.ts';
import { readSelfTime, SELF_TIME_DEFAULTS } from '../core/browser/config.ts';
import { browserDefinition } from '../core/browser/definition.ts';
import { clickRefusal, isSearchField, isWriteAction, typeRefusal } from '../core/browser/guard.ts';
import { selfTimeLine } from '../core/browser/model-text.ts';
import { BrowserWorld } from '../core/browser/world.ts';
import { coopanionPersona } from '../core/persona.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';

type Page = {
  url: string; title: string; header: string; content: string; footer: string;
  video: null | { current: number; duration: number; paused: boolean; muted: boolean; volume: number; width: number; height: number; src: string };
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

  async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ op, args });
    if (op === 'element') return this.element;
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
  transcribe?: (pcm: Int16Array) => Promise<{ text: string; error?: string | null }>;
} = {}) => {
  const bridge = opts.bridge ?? new FakeBridge();
  const pushed = opts.pushed ?? [];
  let self = { ...SELF_TIME_DEFAULTS, enabled: true, ...opts.self };
  const world = new BrowserWorld({
    bridge,
    selfTime: () => self,
    modelLanguage: () => 'zh',
    timezone: 'Asia/Shanghai',
    ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
  });
  await world.start(host(pushed, opts.sees ?? true));
  return {
    world, bridge, pushed,
    setSelf: (patch: Partial<typeof self>) => { self = { ...self, ...patch }; },
  };
};

describe('selfTime settings', () => {
  it('reads defaults and clamps hand-edited values', () => {
    expect(readSelfTime(undefined)).toEqual(SELF_TIME_DEFAULTS);
    expect(readSelfTime({ companion: { selfTime: { enabled: true, afterMinutes: 999, sessionMinutes: 1, sessionUnlimited: true, sound: true, actions: false } } }))
      .toEqual({ enabled: true, afterMinutes: 240, sessionMinutes: 5, sessionUnlimited: true, sound: true, actions: false });
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
    expect(line).toContain('上网');
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

  it('clicks a like and returns the page after it', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    bridge.responses.click = { answer: { success: true }, state: page({ content: '[2]<div title=点赞>13 />' }) };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    bridge.element = element();
    const out = await run(world, 'browser_click', { index: 2 });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('点了「点赞 12');
    expect(out.text).toContain('13');
  });

  it('hovers an element and returns the controls it reveals', async () => {
    const { world, bridge } = await make();
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
    const { world, bridge } = await make();
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
    expect(out.text).toContain('只允许看');
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
    expect(liked.text).toContain('只允许看');
    const hovered = await run(world, 'browser_hover', { index: 2 });
    expect(hovered.failed).toBe(true);
    expect(hovered.text).toContain('只允许看');
    bridge.element = element({ type: 'search', placeholder: '搜索', text: '', label: '' });
    const searched = await run(world, 'browser_type', { index: 2, text: '猫' });
    expect(searched.failed).toBeUndefined();
    setSelf({ actions: true });
  });

  it('takes a screenshot and attaches it when the model accepts images', async () => {
    const { world, bridge } = await make();
    bridge.responses.open = page();
    bridge.responses.screenshot = { base64: Buffer.from('jpeg').toString('base64'), width: 1100, height: 732, state: page() };
    await run(world, 'browser_open', { url: 'https://www.bilibili.com/' });
    const out = await run(world, 'browser_screenshot', {});
    expect(out.text).toContain('截图');
    expect(out.blobs?.[0]).toMatchObject({ mime: 'image/jpeg' });
    expect(out.blobs?.[0]?.fallbackText).toContain('1100×732');
    expect(out.blobs?.[0]?.fallbackText).not.toContain('看不了');
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
    expect(world.envPromptVars()).toMatchObject({ 'browser.session': '最多 20 分钟' });
    setSelf({ sessionUnlimited: true });
    expect(world.envPromptVars()).toMatchObject({ 'browser.session': '不限时长' });
    setSelf({ sessionUnlimited: false });
    expect(world.envPromptVars()!['browser.actions']).toContain('点赞');
    const doc = world.webUi!('zh').promptDocs?.find((d) => d.role === 'envPrompt');
    expect(doc?.path).toBeTruthy();
    expect(existsSync(doc!.path)).toBe(true);
    const template = readFileSync(doc!.path, 'utf8');
    expect(template).toContain('{{browser.session}}');
    expect(template).toContain('{{browser.actions}}');
    expect(template).toContain('{{browser.audio}}');
  });

  it('renders the environment prompt into the prefix with the live settings', async () => {
    const { world } = await make();
    const { text } = await renderWorldEnvPrompt(world);
    expect(text).toContain('## 你自己的浏览器');
    expect(text).toContain('最多 20 分钟');
    expect(text).toContain('可以点赞、收藏、关注、评论、发弹幕和分享');
    expect(text).toContain('静音');
    expect(text).not.toContain('{{browser.');
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
