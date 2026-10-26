/**
 * Coo's own browser as a World. The Electron main process owns the window (`app/browser.cjs`); this
 * class reads and acts on the page through the injected page controller (`app/browser-agent/entry.ts`)
 * and decides what the model may do: spending, private messages, passwords and personal details are
 * refused here, and a session has a time and call budget. Reading is free of the person's mouse; the
 * window is shown without focus.
 *
 * The session starts with `browser_open` or `browser_search`. When `companion.selfTime` is on,
 * Coo's Persona wakes her on the existing heartbeat; the browser does not schedule itself.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { ModelLanguage } from '../language.ts';
import type { BrowserTransport } from './bridge.ts';
import { CONTENT_MAX, SESSION_MAX_CALLS, TEXT_MAX, WATCH_FRAMES_DEFAULT, WATCH_FRAMES_MAX, WATCH_MAX, type SelfTimeConfig } from './config.ts';
import { clickRefusal, isSearchField, isWriteAction, typeRefusal } from './guard.ts';
import { BROWSER_TEXT, type AgentElement, type BrowserText, type PageState, type VideoState } from './model-text.ts';
import { BROWSER_TOOL_DECLS } from './tools.ts';

export const BROWSER_WORLD_ID = 'browser';

const ENV_PROMPT_FILES: Record<ModelLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

export interface BrowserWorldOptions {
  bridge: BrowserTransport;
  /** The live `companion.selfTime` settings. */
  selfTime: () => SelfTimeConfig;
  modelLanguage: () => ModelLanguage;
  /** The deployment's time zone, for event timestamps. */
  timezone: string;
  /** Transcribes one finished 16 kHz mono utterance from the page's audio; absent when speech recognition is unavailable. */
  transcribe?: (pcm: Int16Array) => Promise<{ text: string; error?: string | null }>;
  /** A browsing session ended (closed, timed out or out of calls); Coo's next heartbeat starts from now. */
  onSessionEnd?: () => void;
}

interface Shot { base64: string; width: number; height: number; state: PageState }
interface ClickAnswer { success?: boolean; message?: string }
interface PlayAnswer { ok?: boolean; error?: string; video?: VideoState | null }

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' ? value as Record<string, unknown> : null);

/** When each frame is taken: the whole watch for one frame, both ends and even steps for more. */
function watchTimes(seconds: number, frames: number): number[] {
  if (frames <= 1) return [seconds];
  return Array.from({ length: frames }, (_, index) => Math.round(seconds * index / (frames - 1)));
}

/** The samples of the page's 16 kHz mono 16-bit WAV, or null for anything else. */
function pcm16Wav(base64: string): Int16Array | null {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12, data = -1, size = 0;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const length = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      const format = bytes.readUInt16LE(at + 8), channels = bytes.readUInt16LE(at + 10);
      const rate = bytes.readUInt32LE(at + 12), bits = bytes.readUInt16LE(at + 22);
      if (format !== 1 || channels !== 1 || rate !== 16_000 || bits !== 16) return null;
    }
    if (id === 'data') { data = at + 8; size = Math.min(length, bytes.length - data); break; }
    at += 8 + length + (length % 2);
  }
  if (data < 0 || size < 2) return null;
  const pcm = new Int16Array(Math.floor(size / 2));
  for (let index = 0; index < pcm.length; index++) pcm[index] = bytes.readInt16LE(data + index * 2);
  return pcm;
}

const asVideo = (value: unknown): VideoState | null => {
  const v = asRecord(value);
  if (!v) return null;
  return {
    current: Number(v.current) || 0,
    duration: Number(v.duration) || 0,
    paused: v.paused === true,
    muted: v.muted === true,
    volume: Number(v.volume) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    src: typeof v.src === 'string' ? v.src : '',
  };
};

const asState = (value: unknown): PageState | null => {
  const s = asRecord(value);
  if (!s || typeof s.url !== 'string' || typeof s.title !== 'string' || typeof s.content !== 'string') return null;
  return {
    url: s.url,
    title: s.title,
    header: typeof s.header === 'string' ? s.header : '',
    content: s.content,
    footer: typeof s.footer === 'string' ? s.footer : '',
    video: asVideo(s.video),
  };
};

const asElement = (value: unknown): AgentElement | null => {
  const e = asRecord(value);
  if (!e || typeof e.id !== 'number') return null;
  const text = (key: string) => (typeof e[key] === 'string' ? e[key] as string : '');
  return {
    id: e.id,
    tag: text('tag'),
    text: text('text'),
    label: text('label'),
    type: text('type'),
    placeholder: text('placeholder'),
    aria: text('aria'),
    title: text('title'),
    role: text('role'),
    href: text('href'),
    disabled: e.disabled === true,
    visible: e.visible !== false,
  };
};

const PRESS_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

/** Public http(s) only: not this machine, the local network or the Core's own console. IPv6 literals are refused. */
const PUBLIC = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const httpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '0.0.0.0' || host.startsWith('[')) return false;
    // public sites are named: a single label is an intranet name, and an IP literal is not needed
    if (!host.includes('.') || /^[0-9.]+$/.test(host)) return false;
    if (['localhost', 'local', 'internal', 'lan', 'home'].some((name) => host === name || host.endsWith(`.${name}`))) return false;
    return !PUBLIC.test(host);
  } catch { return false; }
};

export class BrowserWorld implements World {
  readonly id = BROWSER_WORLD_ID;
  private host: WorldHost | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Epoch ms the current browsing session started; null when there is none. */
  private started: number | null = null;
  /** The session's time or call budget ran out; only a new open starts another. */
  private ended = false;
  private calls = 0;
  private timer: NodeJS.Timeout | null = null;
  /** The World is stopping: do not re-arm a heartbeat for a session that ends now. */
  private stopping = false;

  constructor(private readonly opts: BrowserWorldOptions) {}

  private get t(): BrowserText {
    return BROWSER_TEXT[this.opts.modelLanguage()];
  }

  private get self(): SelfTimeConfig {
    return this.opts.selfTime();
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.unsubscribe = this.opts.bridge.onEvent((event) => {
      if (event === 'closed') void this.windowClosed();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const open = this.started !== null;
    this.finish(false);
    if (open) await this.opts.bridge.call('close').catch(() => undefined);
    this.host = null;
    this.stopping = false;
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language !== 'zh' && language !== 'zh-Hant';
    const open = this.started !== null && !this.ended;
    return {
      label: en ? 'Browser' : '浏览器',
      lamps: [{
        label: en ? 'Browser window' : '浏览器窗口',
        state: open ? 'online' : 'offline',
        hint: open ? (en ? 'Open; one browsing session is running.' : '开着,正在一段自己的时间里。') : (en ? 'Closed; opens when Coo does.' : '关着,她打开时才出现。'),
      }],
      promptDocs: [{
        key: 'worlds.browser.envPrompt',
        title: en ? 'Browser environment' : '浏览器环境',
        description: en ? 'Describes her own browser window, its tools and what it refuses.' : '描述她自己的浏览器窗口、工具和不能做的事。',
        path: ENV_PROMPT_FILES[this.opts.modelLanguage()],
        role: 'envPrompt',
        vars: [
          { name: 'browser.session', description: en ? 'How long one stretch may last.' : '一段自己的时间有多长。' },
          { name: 'browser.actions', description: en ? 'What she may do besides look.' : '除了看,她还能做什么。' },
          { name: 'browser.audio', description: en ? 'Whether the window is muted.' : '窗口是否静音。' },
        ],
      }],
    };
  }

  envPromptVars(): Record<string, string> {
    const st = this.self;
    const en = this.opts.modelLanguage() === 'en';
    return {
      'browser.session': st.sessionUnlimited
        ? (en ? 'has no time limit' : '不限时长')
        : (en ? `lasts at most ${st.sessionMinutes} minutes` : `最多 ${st.sessionMinutes} 分钟`),
      'browser.actions': st.actions
        ? (en ? 'likes, favorites, follows, comments, danmaku and sharing are allowed' : '可以点赞、收藏、关注、评论、发弹幕和分享')
        : (en ? 'read only: do not like, favorite, follow, comment, send danmaku or share' : '只允许看:不要点赞、收藏、关注、评论、发弹幕或分享'),
      'browser.audio': st.sound ? (en ? 'sound on' : '有声音') : (en ? 'muted' : '静音'),
    };
  }

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      browser_open: (args, ctx) => this.open(args, ctx),
      browser_search: (args, ctx) => this.search(args, ctx),
      browser_read: (_args, ctx) => this.read(ctx),
      browser_text: (_args, ctx) => this.text(ctx),
      browser_find: (args, ctx) => this.find(args, ctx),
      browser_click: (args, ctx) => this.click(args, ctx),
      browser_hover: (args, ctx) => this.hover(args, ctx),
      browser_share: (_args, ctx) => this.share(ctx),
      browser_type: (args, ctx) => this.type(args, ctx),
      browser_press: (args, ctx) => this.press(args, ctx),
      browser_scroll: (args, ctx) => this.scroll(args, ctx),
      browser_play: (args, ctx) => this.play(args, ctx),
      browser_watch: (args, ctx) => this.watch(args, ctx),
      browser_screenshot: (_args, ctx) => this.screenshot(ctx),
      browser_back: (_args, ctx) => this.back(ctx),
      browser_close: (_args, _ctx) => this.close(),
    };
    return BROWSER_TOOL_DECLS.map((decl) => {
      const handler = handlers[decl.name];
      if (!handler) throw new Error(`no handler for browser tool ${decl.name}`);
      return { ...decl, handler };
    });
  }

  /* ---------- session ---------- */

  /** Starts or continues a session; a reason the call cannot run, or null. */
  private begin(tool: string): ToolOutcome | null {
    const fresh = tool === 'browser_open' || tool === 'browser_search';
    const st = this.self;
    if (this.ended && !fresh) return this.toast(this.t.timeUp, true);
    if (this.started === null) {
      if (!fresh) return this.toast(this.t.notOpen, true);
      this.ended = false;
      this.started = Date.now();
      this.calls = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (!st.sessionUnlimited) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.finish(true);
        }, st.sessionMinutes * 60_000);
        this.timer.unref?.();
      }
    }
    if (!st.sessionUnlimited && Date.now() - this.started > st.sessionMinutes * 60_000) {
      this.finish(true);
      return this.toast(this.t.timeUp, true);
    }
    if (this.calls >= SESSION_MAX_CALLS) {
      this.finish(true);
      return this.toast(this.t.budget, true);
    }
    this.calls++;
    return null;
  }

  private finish(close: boolean): void {
    const active = this.started !== null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.started = null;
    this.ended = true;
    this.calls = 0;
    if (close) void this.opts.bridge.call('close').catch(() => undefined);
    if (active && !this.stopping) {
      try { this.opts.onSessionEnd?.(); } catch { /* arming the next heartbeat is a convenience */ }
    }
  }

  private async windowClosed(): Promise<void> {
    const wasOpen = this.started !== null && !this.ended;
    this.finish(false);
    if (!wasOpen || !this.host) return;
    await this.host.pushEvent({
      type: 'browser.closed',
      source: this.id,
      senderKey: 'browser.closed',
      ts: nowIso(this.opts.timezone),
      text: this.t.closedEvent,
    }, { trigger: 'debounce' }).catch(() => undefined);
  }

  /* ---------- tools ---------- */

  private async open(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_open', ctx, async () => {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!httpUrl(url)) return this.toast(this.t.failed('browser_open', 'the address must be a public http:// or https:// page'), true);
      return this.openUrl(url, this.t.opened(url), ctx, 'browser_open');
    });
  }

  private async search(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_search', ctx, async () => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return this.toast(this.t.failed('browser_search', 'the query is empty'), true);
      const site = args.site === 'bilibili' ? 'bilibili' : args.site === 'douyin' ? 'douyin' : 'web';
      const url = site === 'bilibili'
        ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`
        : site === 'douyin'
          ? `https://www.douyin.com/search/${encodeURIComponent(query)}`
          : `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const where = this.opts.modelLanguage() === 'en'
        ? site === 'bilibili' ? 'Bilibili' : site === 'douyin' ? 'Douyin' : 'the web'
        : site === 'bilibili' ? 'B站' : site === 'douyin' ? '抖音' : '网上';
      return this.openUrl(url, this.t.searched(query, where), ctx, 'browser_search');
    });
  }

  private async openUrl(url: string, lead: string, ctx: ToolCallContext, tool: string): Promise<ToolOutcome> {
    const blocked = this.begin(tool);
    if (blocked) return blocked;
    const state = asState(await this.call('open', { url, muted: !this.self.sound }, ctx.signal));
    if (!state) return this.toast(this.t.failed(tool, 'the browser returned no page'), true);
    return this.toast(this.full(state, lead));
  }

  private async read(ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_read', ctx, async () => {
      const blocked = this.begin('browser_read');
      if (blocked) return blocked;
      const state = asState(await this.call('read', {}, ctx.signal));
      if (!state) return this.toast(this.t.failed('browser_read', 'the page returned no state'), true);
      return this.toast(this.full(state));
    });
  }

  private async text(ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_text', ctx, async () => {
      const blocked = this.begin('browser_text');
      if (blocked) return blocked;
      const raw = asRecord(await this.call('text', {}, ctx.signal));
      if (!raw || typeof raw.text !== 'string') return this.toast(this.t.failed('browser_text', 'the page returned no text'), true);
      const body = raw.text.length > TEXT_MAX ? `${raw.text.slice(0, TEXT_MAX)}\n${this.t.truncated}` : raw.text;
      return this.toast([
        this.t.textPage,
        this.t.pageLine(String(raw.title ?? ''), String(raw.url ?? '')),
        body,
        this.t.video(asVideo(raw.video)),
      ].filter(Boolean).join('\n'));
    });
  }

  private async find(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_find', ctx, async () => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return this.toast(this.t.failed('browser_find', 'the query is empty'), true);
      const blocked = this.begin('browser_find');
      if (blocked) return blocked;
      const state = asState(await this.call('read', {}, ctx.signal));
      if (!state) return this.toast(this.t.failed('browser_find', 'the page returned no state'), true);
      let hits = this.findLines(state.content.replace(/^(\s*)\*\[/gm, '$1[').split('\n'), query);
      if (!hits.length) {
        const raw = asRecord(await this.call('text', {}, ctx.signal));
        if (raw && typeof raw.text === 'string') hits = this.findLines(raw.text.split('\n'), query);
      }
      if (!hits.length) return this.toast(this.t.none(query));
      return this.toast([this.t.found(query, hits.length), ...hits.map((hit) => `${hit.line}: ${hit.text}`)].join('\n'));
    });
  }

  private async click(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_click', ctx, async () => {
      const hasIndex = args.index !== undefined;
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (hasIndex === !!text) return this.toast(this.t.failed('browser_click', 'give either an element number or its visible text'), true);
      let index: number | null = null;
      if (hasIndex) {
        index = this.indexArg(args.index);
        if (index === null) return this.toast(this.t.failed('browser_click', 'index must be a whole number of at least 0'), true);
      }
      const blocked = this.begin('browser_click');
      if (blocked) return blocked;
      let label = text;
      if (index !== null) {
        const element = asElement(await this.call('element', { index }, ctx.signal));
        if (!element) return this.toast(this.t.noElement(index), true);
        label = this.labelOf(element);
      }
      const refused = clickRefusal(label);
      if (refused) return this.toast(this.t.refusedClick(label, refused), true);
      if (!this.self.actions && isWriteAction(label)) return this.toast(this.t.lookOnly(label), true);
      const result = asRecord(await this.call('click', index !== null ? { index } : { text }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_click', 'the page did not answer after the click'), true);
      const answer = asRecord(result?.answer) as ClickAnswer | null;
      if (answer?.success === false) return this.toast(this.t.failed('browser_click', answer.message || 'the click failed'), true);
      return this.toast(this.full(state, this.t.clicked(label || `#${index}`)));
    });
  }

  private async hover(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_hover', ctx, async () => {
      const index = this.indexArg(args.index);
      if (index === null) return this.toast(this.t.failed('browser_hover', 'index must be a whole number of at least 0'), true);
      const blocked = this.begin('browser_hover');
      if (blocked) return blocked;
      const element = asElement(await this.call('element', { index }, ctx.signal));
      if (!element) return this.toast(this.t.noElement(index), true);
      const label = this.labelOf(element);
      if (!this.self.actions && isWriteAction(label)) return this.toast(this.t.lookOnly(label), true);
      const result = asRecord(await this.call('hover', { index }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_hover', 'the page did not answer after hovering'), true);
      return this.toast(this.full(state, this.t.hovered(label || `#${index}`)));
    });
  }

  private async share(ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_share', ctx, async () => {
      const blocked = this.begin('browser_share');
      if (blocked) return blocked;
      if (!this.self.actions) return this.toast(this.t.lookOnly('分享'), true);
      const result = asRecord(await this.call('share', {}, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_share', 'the page did not answer after opening the share panel'), true);
      return this.toast(this.full(state, this.t.shared));
    });
  }

  private async type(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_type', ctx, async () => {
      const index = this.indexArg(args.index);
      const text = typeof args.text === 'string' ? args.text : '';
      if (index === null) return this.toast(this.t.failed('browser_type', 'index must be a whole number of at least 0'), true);
      if (!text.trim()) return this.toast(this.t.failed('browser_type', 'the text is empty'), true);
      if (text.length > 1000) return this.toast(this.t.failed('browser_type', 'the text is longer than 1000 characters'), true);
      const blocked = this.begin('browser_type');
      if (blocked) return blocked;
      const element = asElement(await this.call('element', { index }, ctx.signal));
      if (!element) return this.toast(this.t.noElement(index), true);
      const label = this.labelOf(element);
      const refused = typeRefusal(element);
      if (refused) return this.toast(this.t.refusedType(label), true);
      if (!this.self.actions && !isSearchField(element)) return this.toast(this.t.lookOnly(label), true);
      const result = asRecord(await this.call('input', { index, text }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_type', 'the page did not answer after typing'), true);
      const answer = asRecord(result?.answer) as ClickAnswer | null;
      if (answer?.success === false) return this.toast(this.t.failed('browser_type', answer.message || 'typing failed'), true);
      return this.toast(this.full(state, this.t.typed(label || `#${index}`)));
    });
  }

  private async press(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_press', ctx, async () => {
      const key = typeof args.key === 'string' ? args.key : '';
      if (!PRESS_KEYS.has(key)) return this.toast(this.t.failed('browser_press', `unsupported key ${key || '(empty)'}`), true);
      const index = args.index === undefined ? undefined : this.indexArg(args.index);
      if (index === null) return this.toast(this.t.failed('browser_press', 'index must be a whole number of at least 0'), true);
      const blocked = this.begin('browser_press');
      if (blocked) return blocked;
      const result = asRecord(await this.call('press', { key, ...(index === undefined ? {} : { index }) }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_press', 'the page returned no state'), true);
      return this.toast(this.full(state, this.t.pressed(key)));
    });
  }

  private async scroll(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_scroll', ctx, async () => {
      const down = args.down !== false;
      const pages = typeof args.pages === 'number' && Number.isFinite(args.pages) ? Math.min(10, Math.max(1, Math.round(args.pages))) : 1;
      const index = args.index === undefined ? undefined : this.indexArg(args.index);
      if (index === null) return this.toast(this.t.failed('browser_scroll', 'index must be a whole number of at least 0'), true);
      const blocked = this.begin('browser_scroll');
      if (blocked) return blocked;
      const result = asRecord(await this.call('scroll', { down, pages, ...(index === undefined ? {} : { index }) }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_scroll', 'the page returned no state'), true);
      return this.toast(this.full(state, this.t.scrolled(down, pages)));
    });
  }

  private async play(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_play', ctx, async () => {
      const pause = args.pause === true;
      const blocked = this.begin('browser_play');
      if (blocked) return blocked;
      const result = asRecord(await this.call('play', { pause }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_play', 'the page returned no state'), true);
      const answer = asRecord(result?.answer) as PlayAnswer | null;
      if (answer?.ok === false) return this.toast(this.t.videoProblem(answer.error || 'unknown'), true);
      return this.toast(this.brief(state, this.t.played(pause)));
    });
  }

  private async watch(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_watch', ctx, async () => {
      const seconds = typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? Math.min(WATCH_MAX, Math.max(1, Math.round(args.seconds))) : 10;
      const asked = typeof args.frames === 'number' && Number.isFinite(args.frames) ? Math.round(args.frames) : WATCH_FRAMES_DEFAULT;
      const frames = Math.min(WATCH_FRAMES_MAX, Math.max(1, asked), seconds + 1);
      const times = watchTimes(seconds, frames);
      const blocked = this.begin('browser_watch');
      if (blocked) return blocked;
      const audioWanted = args.audio !== false && !!this.opts.transcribe;
      let audioOpen = false;
      let audioNote = '';
      try {
        if (audioWanted) {
          try {
            const opened = asRecord(await this.call('audio-start', {}, ctx.signal));
            audioOpen = opened?.ok === true;
            if (!audioOpen) audioNote = this.t.audioProblem(typeof opened?.error === 'string' ? opened.error : 'the page did not start recording');
          } catch (error) {
            audioNote = this.t.audioProblem(error instanceof Error ? error.message : String(error));
          }
        }
        const started = Date.now();
        const shots: Shot[] = [];
        for (const at of times) {
          const wait = started + at * 1000 - Date.now();
          if (wait > 0) await sleep(wait, undefined, { signal: ctx.signal }).catch(() => undefined);
          if (ctx.signal?.aborted) return this.toast(this.t.interrupted);
          if (this.ended) return this.toast(this.t.timeUp, true);
          const shot = asRecord(await this.call('screenshot', {}, ctx.signal));
          const state = asState(shot?.state);
          if (!shot || !state || typeof shot.base64 !== 'string') {
            if (!shots.length) return this.toast(this.t.failed('browser_watch', 'the page produced no image'), true);
            break;
          }
          shots.push({ base64: shot.base64, width: Number(shot.width) || 0, height: Number(shot.height) || 0, state });
        }
        if (audioOpen) {
          try {
            const stopped = asRecord(await this.call('audio-stop', {}, undefined));
            audioOpen = false;
            audioNote = await this.heard(stopped);
          } catch (error) {
            audioNote = this.t.audioProblem(error instanceof Error ? error.message : String(error));
          }
        }
        return this.frames(shots, seconds, times, audioNote);
      } finally {
        if (audioOpen) await this.call('audio-stop', {}, undefined).catch(() => undefined);
      }
    });
  }

  /** The transcript line for one audio-stop answer, or why there is none. */
  private async heard(stopped: Record<string, unknown> | null): Promise<string> {
    if (stopped?.ok !== true || typeof stopped.wav !== 'string') {
      return this.t.audioProblem(typeof stopped?.error === 'string' ? stopped.error : 'the page produced no audio');
    }
    const pcm = pcm16Wav(stopped.wav);
    if (!pcm) return this.t.audioProblem('the recording was not 16 kHz mono PCM');
    const result = await this.opts.transcribe!(pcm);
    if (result.text) return this.t.heard(result.text);
    return result.error ? this.t.audioProblem(result.error) : this.t.noSpeech;
  }

  private async screenshot(ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_screenshot', ctx, async () => {
      const blocked = this.begin('browser_screenshot');
      if (blocked) return blocked;
      const shot = asRecord(await this.call('screenshot', {}, ctx.signal));
      const state = asState(shot?.state);
      if (!shot || !state || typeof shot.base64 !== 'string') return this.toast(this.t.failed('browser_screenshot', 'the page produced no image'), true);
      return this.image({ base64: shot.base64, width: Number(shot.width) || 0, height: Number(shot.height) || 0, state }, this.t.screenshot);
    });
  }

  private async back(ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_back', ctx, async () => {
      const blocked = this.begin('browser_back');
      if (blocked) return blocked;
      const result = asRecord(await this.call('back', {}, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_back', 'the page returned no state'), true);
      if (result?.back === false) return this.toast(this.brief(state, this.t.noBack));
      return this.toast(this.full(state));
    });
  }

  private async close(): Promise<ToolOutcome> {
    this.finish(true);
    return this.toast(this.t.closed);
  }

  /* ---------- helpers ---------- */

  private async call(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    return this.opts.bridge.call(op, args, signal);
  }

  private async run(tool: string, ctx: ToolCallContext, work: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
    if (ctx.signal?.aborted) return this.toast(this.t.interrupted);
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'interrupted' || ctx.signal?.aborted) return this.toast(this.t.interrupted);
      if (/window is closed|not open/i.test(message)) return this.toast(this.t.noWindow, true);
      return this.toast(this.t.failed(tool, message), true);
    }
  }

  private toast(text: string, failed = false): ToolOutcome {
    return failed ? { text, failed: true } : { text };
  }

  private indexArg(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  private labelOf(element: AgentElement): string {
    const parts = [element.label, element.text, element.aria, element.title, element.placeholder]
      .filter((part) => typeof part === 'string' && part.trim())
      .map((part) => part.trim());
    return [...new Set(parts)].join(' · ').slice(0, 160);
  }

  private findLines(lines: string[], query: string): Array<{ line: number; text: string }> {
    const needle = query.toLowerCase();
    const hits: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length && hits.length < 20; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) hits.push({ line: i + 1, text: lines[i]!.slice(0, 600) });
    }
    return hits;
  }

  private full(state: PageState, lead = ''): string {
    const content = state.content.replace(/^(\s*)\*\[/gm, '$1[');
    const body = content.length > CONTENT_MAX ? `${content.slice(0, CONTENT_MAX)}\n${this.t.truncated}` : content;
    const header = state.header.length > 1600 ? `${state.header.slice(0, 1600)}…` : state.header;
    return [lead, header, body, state.footer.slice(0, 400), this.t.video(state.video)].filter(Boolean).join('\n');
  }

  private brief(state: PageState, lead = ''): string {
    return [lead, this.t.pageLine(state.title, state.url), this.t.video(state.video)].filter(Boolean).join('\n');
  }

  private image(shot: Shot, lead: string): ToolOutcome {
    const text = [lead, this.t.pageLine(shot.state.title, shot.state.url), this.t.video(shot.state.video)].filter(Boolean).join('\n');
    if (!(this.host?.modelFacts.accepts('image/jpeg') ?? true)) return this.toast(`${text}\n${this.t.noImage}`);
    return {
      text,
      blobs: [{
        bytes: Buffer.from(shot.base64, 'base64'),
        mime: 'image/jpeg',
        name: 'page.jpg',
        fallbackText: this.t.imageFallback(shot.width, shot.height),
      }],
    };
  }

  private frames(shots: Shot[], seconds: number, times: number[], audioNote = ''): ToolOutcome {
    const last = shots[shots.length - 1]!;
    const shown = times.slice(0, shots.length);
    const text = [this.t.watched(seconds, shots.length, shown), this.t.pageLine(last.state.title, last.state.url), this.t.video(last.state.video), audioNote]
      .filter(Boolean).join('\n');
    if (!(this.host?.modelFacts.accepts('image/jpeg') ?? true)) return this.toast(`${text}\n${this.t.noImage}`);
    return {
      text,
      blobs: shots.map((shot, index) => ({
        bytes: Buffer.from(shot.base64, 'base64'),
        mime: 'image/jpeg',
        name: `frame-${index + 1}.jpg`,
        fallbackText: this.t.frameFallback(shot.width, shot.height, shown[index]!),
      })),
    };
  }
}
