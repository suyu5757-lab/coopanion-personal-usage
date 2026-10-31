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
import { randomUUID } from 'node:crypto';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { ModelLanguage } from '../language.ts';
import { ActionGate, type Impact } from '../action-gate.ts';
import { defaultActionRisk, type ActionReceiptCompletion, type ActionReceiptEvidence, type ActionRisk, type BrowserTaskIntent } from '../action-receipts.ts';
import { coreText } from '../i18n/index.ts';
import { ActionJournal, hashContent, originOf, ReplyJournal, type ActionTarget, type PublicAction } from './actions.ts';
import { BrowserTaskActionJournal, browserDuplicateKey } from './task-actions.ts';
import type { BrowserTargetEvidence, StepRequest } from '../task-grants.ts';
import type { BrowserTransport } from './bridge.ts';
import { CONTENT_MAX, SESSION_MAX_CALLS, TEXT_MAX, WATCH_FRAMES_DEFAULT, WATCH_FRAMES_MAX, WATCH_MAX, type SelfTimeConfig } from './config.ts';
import { clickRefusal, isClipboardCopyControl, isFilePicker, isFinalPublishControl, isSearchField, isSendControl, isShareDismissControl, isShareDestinationControl, isWriteAction, removesState, typeRefusal } from './guard.ts';
import { BROWSER_TEXT, type AgentElement, type BrowserText, type PageState, type VideoState } from './model-text.ts';
import { clipboardCopyConfirmed, commentReplyConfirmed, submissionStatus } from './submission-status.ts';
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
  /** The app language, for the confirmation the person reads; Chinese when absent. */
  language?: () => Language;
  /** The deployment's time zone, for event timestamps. */
  timezone: string;
  /** Decides what may write to a site; the app hands in Core's one gate. Without it the gate reads `selfTime`. */
  gate?: ActionGate;
  /**
   * Asks the person to confirm one public write, in the pet's bubble. Absent: a public write cannot
   * be confirmed and is not sent.
   */
  ask?: (question: string, choices: [yes: string, no: string]) => Promise<ApprovalAnswer>;
  /** The file of unresolved public writes; absent: the records live only in memory. */
  journalFile?: string;
  /** Durable duplicate guard for completed comment replies. */
  replyJournalFile?: string;
  /** Durable transaction log for scoped image and media actions. */
  taskJournalFile?: string;
  /** Core's shared receipt ledger. */
  taskJournal?: BrowserTaskActionJournal;
  /** Transcribes one finished 16 kHz mono utterance from the page's audio; absent when speech recognition is unavailable. */
  transcribe?: (pcm: Int16Array) => Promise<{ text: string; error?: string | null }>;
  /** A browsing session ended (closed, timed out or out of calls); Coo's next heartbeat starts from now. */
  onSessionEnd?: () => void;
}

export type ApprovalAnswer = 'yes' | 'always' | 'no' | 'dismissed' | 'timeout' | 'unavailable';

interface Shot {
  base64: string;
  width: number;
  height: number;
  state: PageState;
  captureId?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}
interface VisualCapture {
  captureId: string;
  url: string;
  snapshotId: string;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  createdAt: number;
  used: boolean;
}
interface BrowserActionAuthorization { journalId: string; grantDigest: string; approvedAt: number; expiresAt: number }
type BrowserActionApproval = { approved: true; authorization: BrowserActionAuthorization } | { approved: false; reason: 'unavailable' | 'not-approved' | 'not-answered' | 'changed' | 'unknown' };
interface SharePanelEvidence { url: string; snapshotId: string; targetUrl: string; targetTitle: string; accountRef: string }
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
  const elements = Array.isArray(s.elements)
    ? s.elements.flatMap((raw) => {
      const e = asRecord(raw);
      return e && typeof e.id === 'number' ? [{ id: e.id, label: typeof e.label === 'string' ? e.label : '' }] : [];
    })
    : undefined;
  const current = asRecord(s.current);
  const account = asRecord(s.account);
  const timestamps = Array.isArray(s.timestamps)
    ? s.timestamps.flatMap((raw) => {
      const value = asRecord(raw);
      return value && typeof value.datetime === 'string'
        ? [{
          text: typeof value.text === 'string' ? value.text : '',
          datetime: value.datetime,
          context: typeof value.context === 'string' ? value.context : '',
        }]
        : [];
    })
    : undefined;
  const fileInputs = Array.isArray(s.fileInputs)
    ? s.fileInputs.flatMap((raw) => {
      const value = asRecord(raw);
      return value && typeof value.id === 'number'
        ? [{
          id: value.id,
          label: typeof value.label === 'string' ? value.label : 'file input',
          accept: typeof value.accept === 'string' ? value.accept : '',
          multiple: value.multiple === true,
          disabled: value.disabled === true,
          visible: value.visible !== false,
        }]
        : [];
    })
    : undefined;
  const statusMessages = Array.isArray(s.statusMessages)
    ? s.statusMessages.filter((message): message is string => typeof message === 'string').slice(0, 20)
    : undefined;
  const replyTargets = Array.isArray(s.replyTargets)
    ? s.replyTargets.flatMap((raw) => {
      const value = asRecord(raw);
      return value && typeof value.boxId === 'number' && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
        && typeof value.evidenceHash === 'string' && /^[a-f0-9]{64}$/.test(value.evidenceHash) && typeof value.author === 'string'
        ? [{
          boxId: value.boxId,
          fingerprint: value.fingerprint,
          evidenceHash: value.evidenceHash,
          author: value.author,
          context: typeof value.context === 'string' ? value.context : '',
          timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
          needsExpand: value.needsExpand === true,
        }]
        : [];
    })
    : undefined;
  return {
    url: s.url,
    title: s.title,
    header: typeof s.header === 'string' ? s.header : '',
    content: s.content,
    footer: typeof s.footer === 'string' ? s.footer : '',
    video: asVideo(s.video),
    ...(elements ? { elements } : {}),
    current: current && typeof current.url === 'string' ? { url: current.url, title: typeof current.title === 'string' ? current.title : '' } : null,
    account: account && typeof account.ref === 'string' && typeof account.label === 'string'
      ? { ref: account.ref, label: account.label }
      : null,
    ...(timestamps ? { timestamps } : {}),
    ...(fileInputs ? { fileInputs } : {}),
    ...(statusMessages ? { statusMessages } : {}),
    ...(replyTargets ? { replyTargets } : {}),
    ...(typeof s.snapshotId === 'string' ? { snapshotId: s.snapshotId } : {}),
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
    dataE2e: text('dataE2e'),
    href: text('href'),
    disabled: e.disabled === true,
    visible: e.visible !== false,
    filePicker: e.filePicker === true,
    ...(typeof e.snapshotId === 'string' ? { snapshotId: e.snapshotId } : {}),
  };
};

const PRESS_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

/** A label without counts and case: a like count ticks up without the element becoming a different one. */
const normalLabel = (value: string): string => value.toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

/** The answer, or `dismissed` when the call is interrupted while the person is deciding. */
function askUnlessAborted(answer: Promise<ApprovalAnswer>, signal?: AbortSignal): Promise<ApprovalAnswer> {
  if (!signal) return answer;
  if (signal.aborted) return Promise.resolve('dismissed');
  return new Promise((resolve) => {
    const stop = () => resolve('dismissed');
    signal.addEventListener('abort', stop, { once: true });
    const settle = (value: ApprovalAnswer) => { signal.removeEventListener('abort', stop); resolve(value); };
    answer.then(settle, () => settle('dismissed'));
  });
}

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

const isChatGPTPage = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com');
  } catch { return false; }
};

const isDouyinPage = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && host === 'creator.douyin.com';
  } catch { return false; }
};

export class BrowserWorld implements World {
  readonly id = BROWSER_WORLD_ID;
  private readonly instanceId = randomUUID();
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
  /** What each element number meant when the model last saw the page; a changed entry means it was renumbered. */
  private shown = new Map<number, string>();
  /** The page those numbers belong to; another address drops them. */
  private shownUrl = '';
  private shownSnapshotId = '';
  /** The last page shown to the model: what a confirmation names as its target. */
  private lastState: PageState | null = null;
  /** The only screenshot coordinate mapping that may authorize one visual click. */
  private lastVisualCapture: VisualCapture | null = null;
  /** The share options returned by browser_share, scoped to their page snapshot. */
  private sharePanel: SharePanelEvidence | null = null;
  /** The unresolved public writes; a resolved one leaves the file as soon as it is written. */
  private actions: PublicAction[] = [];
  private journal: ActionJournal | null = null;
  private replyJournal: ReplyJournal | null = null;
  private taskJournal: BrowserTaskActionJournal | null = null;
  /** One public write at a time: a second Enter while the first awaits an answer is refused. */
  private publishing = false;
  /** What Coo last typed, so a send control knows which text it would publish. */
  private lastTyped: { index: number; text: string; label: string } | null = null;
  private journalUnavailable = false;
  private replyJournalUnavailable = true;

  constructor(private readonly opts: BrowserWorldOptions) {}

  private get t(): BrowserText {
    return BROWSER_TEXT[this.opts.modelLanguage()];
  }

  private get self(): SelfTimeConfig {
    return this.opts.selfTime();
  }

  private fallbackGate: ActionGate | null = null;

  private ensureTaskJournal(): boolean {
    if (this.taskJournal) return true;
    if (this.opts.taskJournal) {
      this.taskJournal = this.opts.taskJournal;
      return true;
    }
    if (!this.opts.taskJournalFile) return false;
    try {
      this.taskJournal = new BrowserTaskActionJournal(this.opts.taskJournalFile);
      return true;
    } catch {
      return false;
    }
  }

  /** Core's gate when the app lent one; otherwise a gate reading this World's own settings. */
  private get gate(): ActionGate {
    return this.opts.gate ?? (this.fallbackGate ??= new ActionGate({
      platformWrites: () => this.self.actions,
      imageGeneration: () => this.self.imageGeneration,
      imageSaving: () => this.self.imageSaving,
      mediaUpload: () => this.self.mediaUpload,
      computerInput: () => true,
      desktopTargetAllowed: () => false,
    }));
  }

  /** Whether an action of this weight may run now. */
  private allowed(impact: Impact, tool: string, target?: string): boolean {
    return this.gate.check({ surface: 'browser', tool, impact, ...(target ? { target } : {}) }).allow;
  }

  /** A Core UI grant binds one browser action to its current page, account or profile, and control. */
  private async approveBrowserAction(
    impact: Extract<Impact, 'platform-write' | 'image-generation' | 'image-saving' | 'media-upload'>,
    taskText: string,
    page: PageState,
    formId: string,
    control: string,
    details: string,
    ctx: ToolCallContext,
    scope: {
      accountRef?: string;
      files?: Array<{ path: string; digest: string; bytes: number; mime: string }>;
      initialEvidence?: ActionReceiptEvidence[];
      dedupeKey?: string;
      actionLabel?: string;
      payloadDigest?: string;
      commentFingerprint?: string;
      risk?: ActionRisk;
      intent?: BrowserTaskIntent;
    } = {},
  ): Promise<BrowserActionApproval> {
    if (!this.ensureTaskJournal() || !this.taskJournal) return { approved: false, reason: 'unavailable' };
    const url = page.url;
    const target: BrowserTargetEvidence = {
      surface: 'browser',
      instanceId: this.instanceId,
      origin: originOf(url),
      url,
      accountRef: scope.accountRef ?? page.account?.ref ?? this.instanceId,
      snapshotId: page.snapshotId ?? '',
      formId,
      control,
    };
    const text = coreText(this.opts.language?.() ?? 'zh').browserAction;
    const taskId = ctx.callId ? `${ctx.role}:${ctx.callId}` : `${ctx.role}:${ctx.round ?? 'direct'}:${randomUUID()}`;
    const files = scope.files ?? [];
    const payloadDigest = scope.payloadDigest ?? hashContent(taskText);
    const risk = scope.risk ?? defaultActionRisk(impact);
    const intent: BrowserTaskIntent = scope.intent ?? impact;
    const duplicateKey = browserDuplicateKey(intent, target, payloadDigest, scope.dedupeKey, files);
    if (this.taskJournal.hasUnresolved(duplicateKey)) return { approved: false, reason: 'unknown' };
    let action: ReturnType<BrowserTaskActionJournal['begin']>;
    try {
      action = this.taskJournal.begin({
        taskId,
        intent,
        action: `${impact}:${control}`,
        target,
        payloadDigest,
        files,
        ...(scope.initialEvidence?.length ? { evidence: scope.initialEvidence } : {}),
        ...(scope.commentFingerprint ? { commentFingerprint: scope.commentFingerprint } : {}),
        risk,
        duplicateKey,
      });
      this.taskJournal.awaitingApproval(action.id);
    } catch {
      return { approved: false, reason: 'unavailable' };
    }
    const finishCancelled = () => this.taskJournal?.finish(action.id, 'cancelled');
    let grant;
    let answer: ApprovalAnswer | null = null;
    try {
      grant = await this.gate.requestTaskGrant({
        taskId,
        taskText,
        risk,
        target,
        actions: [impact],
        ...(scope.files ? { files: scope.files } : {}),
        expiresInMs: 30_000,
        maxSteps: 1,
      }, async () => {
        if (!this.opts.ask) {
          answer = 'unavailable';
          return false;
        }
        answer = await askUnlessAborted(
          this.opts.ask(text.question(scope.actionLabel ?? text[impact === 'platform-write' ? 'platformWrite' : impact === 'image-generation' ? 'imageGeneration' : impact === 'image-saving' ? 'imageSaving' : 'mediaUpload'], `${page.title} (${target.origin})`, details), [text.yes, text.no]),
          ctx.signal,
        );
        return answer === 'yes';
      });
    } catch {
      finishCancelled();
      return { approved: false, reason: 'not-approved' };
    }
    if (!grant || !target.origin || !target.snapshotId) {
      finishCancelled();
      const reason = answer && answer !== 'yes' && answer !== 'no' ? 'not-answered' : 'not-approved';
      return { approved: false, reason };
    }

    const current = asState(await this.call('read', {}, ctx.signal));
    if (!current || current.snapshotId !== target.snapshotId || current.url !== target.url
      || (current.account?.ref ?? this.instanceId) !== target.accountRef) {
      finishCancelled();
      return { approved: false, reason: 'changed' };
    }
    const step: StepRequest = { action: impact, target, expectedChange: taskText, ...(scope.files ? { files: scope.files } : {}) };
    const ticket = this.gate.issueStepTicket(grant.id, step);
    this.taskJournal.acting(action.id, grant.digest, grant.approvedAt, grant.expiresAt);
    if (!ticket || !this.gate.consumeStepTicket(ticket.id, step)) {
      finishCancelled();
      return { approved: false, reason: 'changed' };
    }
    return {
      approved: true,
      authorization: { journalId: action.id, grantDigest: grant.digest, approvedAt: grant.approvedAt, expiresAt: grant.expiresAt },
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.journal = this.opts.journalFile ? new ActionJournal(this.opts.journalFile) : null;
    this.replyJournal = this.opts.replyJournalFile ? new ReplyJournal(this.opts.replyJournalFile) : null;
    try {
      this.actions = this.journal?.load() ?? [];
      this.journalUnavailable = !this.journal;
    } catch {
      this.actions = [];
      this.journalUnavailable = true;
    }
    try {
      this.replyJournal?.load();
      this.replyJournalUnavailable = !this.replyJournal;
    } catch {
      this.replyJournalUnavailable = true;
    }
    this.unsubscribe = this.opts.bridge.onEvent((event) => {
      if (event === 'closed') void this.windowClosed();
    });
    this.ensureTaskJournal();
    const interruptedTaskActions = this.taskJournal?.recoverInterrupted() ?? 0;
    await this.recover();
    if (interruptedTaskActions) {
      const now = Date.now();
      await this.host?.pushEvent({
        type: 'browser.unresolved',
        source: this.id,
        senderKey: 'browser.unresolved',
        ts: nowIso(this.opts.timezone),
        text: this.t.unresolved(interruptedTaskActions),
      }, { trigger: 'debounce' }).catch(() => undefined);
    }
    this.migrateLegacyActions();
  }

  private migrateLegacyActions(): void {
    if (!this.actions.length) return;
    if (!this.journal || !this.taskJournal) {
      this.journalUnavailable = true;
      return;
    }
    try {
      for (const action of this.actions) this.taskJournal.importLegacy(action);
      this.journal.save([]);
      this.actions = [];
    } catch {
      this.journalUnavailable = true;
    }
  }

  /**
   * A record left in `acting` by a crash has an unknown result: no input is re-sent, and Coo is told
   * to check the page before trying again.
   */
  private async recover(): Promise<void> {
    const stuck = this.actions.filter((action) => action.phase === 'acting' || action.phase === 'awaiting-approval' || action.phase === 'planned');
    if (!stuck.length) return;
    const now = Date.now();
    for (const action of stuck) {
      action.phase = 'unknown';
      action.outcome = 'unknown';
      action.note = 'the app stopped before the result was seen';
      action.updatedAt = now;
    }
    try { this.journal?.save(this.actions); } catch { /* the record stays in memory and in the event */ }
    await this.host?.pushEvent({
      type: 'browser.unresolved',
      source: this.id,
      senderKey: 'browser.unresolved',
      ts: nowIso(this.opts.timezone),
      text: this.t.unresolved(stuck.length),
    }, { trigger: 'debounce' }).catch(() => undefined);
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
    const permissions = en ? [
      st.actions ? 'social actions are enabled' : 'social actions are disabled',
      st.imageGeneration ? 'ChatGPT image prompt submission is enabled' : 'ChatGPT image prompt submission is disabled',
      st.imageSaving ? 'saving generated ChatGPT images is enabled' : 'saving generated ChatGPT images is disabled',
      st.mediaUpload ? 'placing eligible media into upload controls is enabled' : 'placing media into upload controls is disabled',
    ] : [
      st.actions ? '常规互动已开启' : '常规互动已关闭',
      st.imageGeneration ? '网页生图已开启' : '网页生图已关闭',
      st.imageSaving ? '保存生成图片已开启' : '保存生成图片已关闭',
      st.mediaUpload ? '素材上传已开启' : '素材上传已关闭',
    ];
    return {
      'browser.session': st.sessionUnlimited
        ? (en ? 'has no time limit' : '不限时长')
        : (en ? `lasts at most ${st.sessionMinutes} minutes` : `最多 ${st.sessionMinutes} 分钟`),
      'browser.actions': permissions.join(en ? '; ' : '；'),
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
      browser_chatgpt_generate_image: (args, ctx) => this.generateChatGPTImage(args, ctx),
      browser_save_chatgpt_image: (args, ctx) => this.saveChatGPTImage(args, ctx),
      browser_upload_media: (args, ctx) => this.uploadMedia(args, ctx),
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
    this.lastTyped = null;
    this.lastState = null;
    this.lastVisualCapture = null;
    this.sharePanel = null;
    this.shown.clear();
    this.shownUrl = '';
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
    this.sharePanel = null;
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

  private async clickScreenshotPoint(point: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    const capture = this.lastVisualCapture;
    const captureId = typeof point.captureId === 'string' ? point.captureId : '';
    const x = typeof point.x === 'number' ? point.x : Number.NaN;
    const y = typeof point.y === 'number' ? point.y : Number.NaN;
    const description = typeof point.description === 'string' ? point.description.trim().slice(0, 160) : '';
    if (!capture || capture.used || capture.captureId !== captureId || Date.now() - capture.createdAt > 30_000
      || !this.lastState || this.lastState.url !== capture.url || this.lastState.snapshotId !== capture.snapshotId) {
      return this.toast(this.t.failed('browser_click', 'the screenshot target is stale; take a new screenshot'), true);
    }
    if (!(this.host?.modelFacts.accepts('image/jpeg') ?? true)) {
      this.lastVisualCapture = null;
      return this.toast(this.t.failed('browser_click', 'this model cannot see the screenshot'), true);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= capture.imageWidth || y >= capture.imageHeight || !description) {
      capture.used = true;
      return this.toast(this.t.failed('browser_click', 'screenshot point needs in-image coordinates and a short target description'), true);
    }
    capture.used = true;

    const pointResult = asRecord(await this.call('inspect-screenshot-point', {
      captureId, x, y, snapshotId: capture.snapshotId,
    }, ctx.signal));
    const target = asRecord(pointResult?.target);
    if (pointResult?.ok !== true || !target || typeof target.token !== 'string'
      || target.snapshotId !== capture.snapshotId) {
      return this.toast(this.t.failed('browser_click', typeof pointResult?.reason === 'string' ? pointResult.reason : 'the screenshot point is not a current interactive target'), true);
    }
    if (target.disabled === true) return this.toast(this.t.failed('browser_click', 'the screenshot target is disabled'), true);
    if (target.filePicker === true) return this.toast(this.t.fileChooserBlocked, true);

    const page = this.lastState;
    const pageLabel = typeof target.label === 'string' ? target.label.trim() : '';
    if (!pageLabel) return this.toast(this.t.failed('browser_click', 'the live DOM target has no readable label; visual-only targets cannot be clicked'), true);
    const pageText = `${page.title} ${page.url}`;
    const sensitivePage = clickRefusal(pageText)
      || isDouyinPage(page.url)
      || /(?:checkout|billing|payment|purchase|order|recharge|wallet|login|log-in|register|oauth|account|security|message|inbox|\bdm\b|\bchat\b|publish|upload|create-post|post\/create|new-post)/i.test(page.url);
    if (sensitivePage) return this.toast(this.t.failed('browser_click', 'screenshot clicks are unavailable on payment, login and account pages'), true);
    if (typeRefusal({
      type: typeof target.type === 'string' ? target.type : '',
      label: pageLabel,
      placeholder: typeof target.placeholder === 'string' ? target.placeholder : '',
    })) return this.toast(this.t.failed('browser_click', 'password and personal-information fields cannot be activated'), true);
    if (/(?:sign in|log in|log-in|login|register|sign up|create account|登录|注册|创建账号|账号登录|账户登录)/i.test(`${pageLabel} ${description}`)) {
      return this.toast(this.t.failed('browser_click', 'login and registration controls must be handled by the person'), true);
    }
    const guardRefusal = clickRefusal(pageLabel) ?? clickRefusal(description);
    if (guardRefusal) return this.toast(this.t.refusedClick(pageLabel || description, guardRefusal), true);
    if (isSendControl(pageLabel) || isSendControl(description) || isFinalPublishControl(pageLabel) || isFinalPublishControl(description)
      || isClipboardCopyControl(pageLabel) || isClipboardCopyControl(description)
      || isShareDestinationControl(pageLabel) || isShareDestinationControl(description)) {
      return this.toast(this.t.failed('browser_click', 'send, publish, share and clipboard controls require their dedicated verified path'), true);
    }
    const write = isWriteAction(pageLabel) || isWriteAction(description);
    if (write && (!page.current?.url || !page.account?.ref || !page.account.label)) {
      return this.toast(this.t.sendTargetUnverified, true);
    }
    if (!this.allowed('platform-write', 'browser_click', `visual target: ${pageLabel || description}`)) {
      return this.toast(this.t.lookOnly(pageLabel || description), true);
    }

    const targetToken = target.token;
    const stableTarget = `${page.url}:${String(target.tag ?? '')}:${String(target.role ?? '')}:${normalLabel(pageLabel)}`;
    const details = [
      `Page: ${page.title} (${page.url})`,
      `Screenshot capture: ${captureId}; image coordinates: ${x}, ${y} of ${capture.imageWidth}×${capture.imageHeight}`,
      `Target identified in the live DOM: ${pageLabel || '(no readable name)'}`,
      `Description from the screenshot: ${description}`,
      'This approval authorizes one click only. The result will remain unknown until checked.',
    ].join('\n');
    const approval = await this.approveBrowserAction(
      'platform-write',
      `Click the screenshot target “${description}” once at (${x}, ${y}) on ${page.url}.`,
      page,
      'visual-screenshot-point',
      `visual:${captureId}:${target.tag || 'element'}:${targetToken}`,
      details,
      ctx,
      {
        payloadDigest: hashContent(JSON.stringify([target.tag, target.role, normalLabel(pageLabel)])),
        dedupeKey: `visual:${stableTarget}`,
        risk: 'IRREVERSIBLE_OR_PUBLIC',
      },
    );
    if (!approval.approved) {
      this.lastVisualCapture = null;
      return this.toast(approval.reason === 'unknown' ? this.t.sendUnknown
        : approval.reason === 'changed' ? this.t.sendChanged
          : approval.reason === 'not-answered' || approval.reason === 'unavailable' ? this.t.sendNotAnswered
            : this.t.lookOnly(pageLabel || description), true);
    }

    const currentPoint = asRecord(await this.call('inspect-screenshot-point', {
      captureId, x, y, snapshotId: capture.snapshotId,
    }, ctx.signal));
    const currentTarget = asRecord(currentPoint?.target);
    if (currentPoint?.ok !== true || currentTarget?.token !== targetToken
      || currentTarget?.snapshotId !== capture.snapshotId) {
      this.taskJournal?.finish(approval.authorization.journalId, 'cancelled', 'the screenshot target changed after approval');
      this.lastVisualCapture = null;
      return this.toast(this.t.sendChanged, true);
    }

    let result: Record<string, unknown> | null;
    try {
      result = asRecord(await this.call('click-screenshot-point', {
        captureId, x, y, snapshotId: capture.snapshotId, targetToken,
      }, ctx.signal));
    } catch (error) {
      this.taskJournal?.complete(approval.authorization.journalId, {
        phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown',
        note: 'the screenshot click result was not received',
        evidence: { source: 'browser-screenshot', status: 'visual-click-result-missing', summary: `capture ${captureId}`, observedAt: Date.now() },
      });
      this.lastVisualCapture = null;
      const detail = error instanceof Error ? error.message : String(error);
      return this.toast(`${this.t.sendUnknown} ${detail}`);
    }
    const state = asState(result?.state);
    const answer = asRecord(result?.answer) as ClickAnswer | null;
    if (answer?.success === false) {
      this.taskJournal?.finish(approval.authorization.journalId, 'cancelled', answer.message || 'the screenshot click was refused');
      this.lastVisualCapture = null;
      return this.toast(this.t.failed('browser_click', answer.message || 'the screenshot click was refused'), true);
    }
    this.taskJournal?.complete(approval.authorization.journalId, {
      phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown',
      note: 'the screenshot click was dispatched without independent business-state verification',
      evidence: { source: 'browser-screenshot', status: 'visual-click-dispatched', summary: `capture ${captureId}; target ${targetToken}`, observedAt: Date.now() },
    });
    this.lastVisualCapture = null;
    if (!state) return this.toast(this.t.sendUnknown);
    return this.toast(this.full(state, this.t.visualClickUnknown(description)));
  }

  private async click(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_click', ctx, async () => {
      const hasIndex = args.index !== undefined;
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      const hasLocator = args.locator !== undefined;
      const hasPoint = args.point !== undefined;
      if ([hasIndex, !!text, hasLocator, hasPoint].filter(Boolean).length !== 1) {
        return this.toast(this.t.failed('browser_click', 'give exactly one of element number, visible text, locator, or a current screenshot point'), true);
      }
      const blocked = this.begin('browser_click');
      if (blocked) return blocked;
      if (hasPoint) {
        const point = asRecord(args.point);
        if (!point) return this.toast(this.t.failed('browser_click', 'screenshot point must include x, y, captureId and description'), true);
        return this.clickScreenshotPoint(point, ctx);
      }
      let index: number | null = null;
      if (hasIndex) {
        index = this.indexArg(args.index);
        if (index === null) return this.toast(this.t.failed('browser_click', 'index must be a whole number of at least 0'), true);
      }
      let label = text;
      let targetSnapshotId: string | undefined;
      if (hasLocator) {
        const expectedSnapshotId = this.shownSnapshotId;
        if (!expectedSnapshotId) return this.toast(this.t.failed('browser_click', 'read the current page before using a locator'), true);
        const resolved = asRecord(await this.call('resolveLocator', { locator: args.locator, expectedSnapshotId }, ctx.signal));
        if (resolved?.ok !== true || this.indexArg(resolved.id) === null || resolved.snapshotId !== expectedSnapshotId) {
          const reason = typeof resolved?.reason === 'string' ? resolved.reason : '';
          const detail = reason === 'ambiguous'
            ? 'the locator matched more than one target; add a unique container'
            : reason === 'stale-snapshot'
              ? 'the page changed; read it again before resolving the locator'
              : reason === 'invalid'
                ? 'the locator needs a supported role, name, or data-e2e field'
                : 'the locator did not resolve to one current target';
          return this.toast(this.t.failed('browser_click', detail), true);
        }
        index = this.indexArg(resolved.id);
        targetSnapshotId = expectedSnapshotId;
      }
      if (index !== null) {
        const element = asElement(await this.call('element', { index }, ctx.signal));
        if (!element) return this.toast(this.t.noElement(index), true);
        if (this.renumbered(index, element)) return this.toast(this.t.stale(index), true);
        if (isFilePicker(element)) return this.toast(this.t.fileChooserBlocked, true);
        targetSnapshotId = element.snapshotId;
        label = this.labelOf(element);
        if (!label && (element.tag === 'button' || element.role === 'button')) {
          return this.toast(this.t.failed('browser_click', 'the button has no readable label'), true);
        }
      }
      const page = this.lastState;
      const sharePanel = this.sharePanel && page?.url === this.sharePanel.url
        ? this.sharePanel
        : null;
      const clipboardWrite = isClipboardCopyControl(label);
      const sharePanelAction = !!sharePanel && !isShareDismissControl(label)
        && (clipboardWrite || isShareDestinationControl(label));
      const externalShare = !clipboardWrite && !isShareDismissControl(label)
        && (sharePanelAction || isShareDestinationControl(label));
      if (isDouyinPage(this.lastState?.url ?? '') && isFinalPublishControl(label)) return this.toast(this.t.manualPublish, true);
      if (index === null && isSendControl(label)) return this.toast(this.t.sendTargetNeedsIndex, true);
      const refused = clickRefusal(label);
      if (removesState(label)) return this.toast(this.t.alreadyDone(label), true);
      if (!this.allowed(refused ? 'sensitive' : (isWriteAction(label) || clipboardWrite || sharePanelAction || isShareDestinationControl(label)) ? 'platform-write' : 'read', 'browser_click', label)) {
        return this.toast(refused ? this.t.refusedClick(label, refused) : this.t.lookOnly(label), true);
      }
      // A send control publishes the text Coo typed: the person confirms that exact text first.
      if (index !== null && isSendControl(label)) {
        const typed = this.lastTyped;
        if (!typed) return this.toast(this.t.sendDraftMissing, true);
        const box = typed.index;
        const content = await this.draftAt(box, ctx.signal);
        if (content === null) return this.toast(this.t.draftUnreadable, true);
        if (content.trim()) {
          return await this.publishText({ tool: 'browser_click', boxIndex: box, controlIndex: index, label, boxLabel: typed.label, content }, ctx, async () => {
            const result = asRecord(await this.call('click', { index, snapshotId: targetSnapshotId }, ctx.signal));
            return asState(result?.state);
          });
        }
        return this.toast(this.t.sendDraftMissing, true);
      }
      let authorization: BrowserActionAuthorization | null = null;
      let receiptIntent: BrowserTaskIntent | null = null;
      if (isWriteAction(label) || clipboardWrite || externalShare) {
        const currentVideo = page?.current;
        const currentAccount = page?.account;
        const shareSnapshotMatches = !!sharePanel && sharePanel.snapshotId === page?.snapshotId;
        const actionTargetUrl = shareSnapshotMatches ? sharePanel!.targetUrl : currentVideo?.url ?? page?.url;
        const actionTargetTitle = shareSnapshotMatches ? sharePanel!.targetTitle : currentVideo?.title ?? page?.title ?? '';
        if (!page?.snapshotId || !actionTargetUrl || (targetSnapshotId && targetSnapshotId !== page.snapshotId)) {
          return this.toast(this.t.sendTargetUnverified, true);
        }
        if ((clipboardWrite || externalShare) && (index === null || targetSnapshotId !== page.snapshotId)) {
          return this.toast(this.t.sendTargetNeedsIndex, true);
        }
        if (isWriteAction(label) && !clipboardWrite && !externalShare
          && (!currentVideo?.url || !currentAccount?.ref || !currentAccount.label)) return this.toast(this.t.sendTargetUnverified, true);
        const accountRef = currentAccount?.ref ?? sharePanel?.accountRef ?? this.instanceId;
        const accountDisplay = currentAccount?.label ? `${currentAccount.label} (${accountRef})` : accountRef;
        const intent: BrowserTaskIntent = clipboardWrite ? 'clipboard-write' : 'platform-write';
        const targetUrl = (() => {
          try { const url = new URL(actionTargetUrl); url.search = ''; url.hash = ''; return url.href; }
          catch { return actionTargetUrl.slice(0, 400); }
        })();
        const taskText = clipboardWrite
          ? `Copy the share link for ${targetUrl} to the local clipboard once.`
          : externalShare
            ? `Share ${targetUrl} through “${label || 'the selected destination'}” once.`
            : `Perform “${label}” once on ${actionTargetTitle || targetUrl} (${targetUrl}).`;
        const browserActionText = coreText(this.opts.language?.() ?? 'zh').browserAction;
        const details = clipboardWrite
          ? browserActionText.clipboardDetails(accountDisplay, `${actionTargetTitle || targetUrl} (${targetUrl})`)
          : externalShare
            ? browserActionText.externalShareDetails(accountDisplay, `${actionTargetTitle || targetUrl} (${targetUrl})`, label)
            : `Account: ${currentAccount!.label} (${accountRef})\nContent: ${actionTargetTitle || targetUrl} (${targetUrl})\nAction: ${label}`;
        const decision = await this.approveBrowserAction(
          'platform-write',
          taskText,
          page,
          `${clipboardWrite ? 'clipboard' : externalShare ? 'share' : 'video'}:${actionTargetUrl}`,
          clipboardWrite ? 'clipboard-copy' : externalShare ? `share:${label || 'destination'}` : label,
          details,
          ctx,
          {
            accountRef,
            ...((clipboardWrite || externalShare) ? { payloadDigest: hashContent(JSON.stringify([actionTargetUrl, label, intent])) } : {}),
            ...(clipboardWrite ? { risk: 'REVERSIBLE_LOCAL' as const, intent, actionLabel: browserActionText.clipboardWrite } : {}),
            ...(externalShare ? { risk: 'IRREVERSIBLE_OR_PUBLIC' as const, actionLabel: browserActionText.externalShare } : {}),
          },
        );
        if (!decision.approved) return this.toast(decision.reason === 'unknown' ? this.t.sendUnknown
          : decision.reason === 'changed' ? this.t.sendChanged : this.t.lookOnly(label), true);
        authorization = decision.authorization;
        receiptIntent = intent;
      }
      let result: Record<string, unknown> | null;
      try {
        result = asRecord(await this.call('click', index !== null ? { index, snapshotId: targetSnapshotId } : { text }, ctx.signal));
      } catch (error) {
        if (authorization) this.taskJournal?.finish(authorization.journalId, 'unknown', 'the click result was not received');
        throw error;
      }
      const state = asState(result?.state);
      const answer = asRecord(result?.answer) as ClickAnswer | null;
      if (answer?.success === false) {
        if (authorization) this.taskJournal?.finish(authorization.journalId, 'cancelled', answer.message || 'the click was refused');
        return this.toast(this.t.failed('browser_click', answer.message || 'the click failed'), true);
      }
      if (!state) {
        if (authorization) this.taskJournal?.finish(authorization.journalId, 'unknown', 'the page did not answer after the click');
        return this.toast(this.t.failed('browser_click', 'the page did not answer after the click'), true);
      }
      if (authorization) {
        if (receiptIntent === 'clipboard-write') {
          const verified = state.url === page?.url && clipboardCopyConfirmed(state.statusMessages ?? []);
          this.taskJournal?.complete(authorization.journalId, verified
            ? { phase: 'verified', dispatchState: 'delivered', outcome: 'ui-observed', note: 'the page confirmed that the link was copied', evidence: { source: 'browser-page-status', status: 'clipboard-copy-confirmed', observedAt: Date.now() } }
            : { phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown', note: 'the page did not confirm whether the link was copied', evidence: { source: 'browser-page-status', status: 'clipboard-copy-unconfirmed', observedAt: Date.now() } });
          if (!verified) return this.toast(this.t.sendUnknown, true);
          return this.toast(this.full(state, this.t.clicked(label || `#${index}`)));
        }
        if (externalShare) {
          const status = submissionStatus(state.statusMessages ?? []);
          const completion: ActionReceiptCompletion = status === 'pending-review'
            ? { phase: 'review-pending', dispatchState: 'delivered', outcome: 'review-pending', note: 'the page shows the share action under review' }
            : status === 'published'
              ? { phase: 'verified', dispatchState: 'delivered', outcome: 'verified', note: 'the page confirms the share action completed' }
              : status === 'submitted'
                ? { phase: 'submitted', dispatchState: 'delivered', outcome: 'remote-acknowledged', note: 'the page acknowledges the share action without a final status' }
                : { phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown', note: 'the page did not confirm the share result' };
          this.taskJournal?.complete(authorization.journalId, completion);
          if (completion.phase !== 'verified') return this.toast(this.t.sendUnknown, true);
          return this.toast(this.full(state, this.t.clicked(label || `#${index}`)));
        }
        const after = state.elements?.find((candidate) => candidate.id === index)?.label ?? '';
        const currentVideo = page?.current;
        const currentAccount = page?.account;
        const verified = !!page && !!currentVideo && !!currentAccount && state.url === page.url
          && state.current?.url === currentVideo.url && state.account?.ref === currentAccount.ref
          && !!after && !removesState(label) && removesState(after);
        this.taskJournal?.finish(authorization.journalId, verified ? 'verified' : 'unknown', verified
          ? `the page changed the control to ${after}`
          : 'the page did not confirm the requested toggle state');
        if (!verified) return this.toast(this.t.sendUnknown, true);
      }
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
      if (this.renumbered(index, element)) return this.toast(this.t.stale(index), true);
      if (isFilePicker(element)) return this.toast(this.t.fileChooserBlocked, true);
      const label = this.labelOf(element);
      if (!this.allowed(isWriteAction(label) ? 'platform-write' : 'read', 'browser_hover', label)) return this.toast(this.t.lookOnly(label), true);
      const result = asRecord(await this.call('hover', { index, snapshotId: element.snapshotId }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_hover', 'the page did not answer after hovering'), true);
      return this.toast(this.full(state, this.t.hovered(label || `#${index}`)));
    });
  }

  private async share(ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_share', ctx, async () => {
      const blocked = this.begin('browser_share');
      if (blocked) return blocked;
      if (!this.allowed('platform-write', 'browser_share', this.t.share)) return this.toast(this.t.lookOnly(this.t.share), true);
      const result = asRecord(await this.call('share', {}, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_share', 'the page did not answer after opening the share panel'), true);
      this.sharePanel = state.snapshotId ? {
        url: state.url,
        snapshotId: state.snapshotId,
        targetUrl: state.current?.url ?? state.url,
        targetTitle: state.current?.title ?? state.title,
        accountRef: state.account?.ref ?? this.instanceId,
      } : null;
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
      if (this.renumbered(index, element)) return this.toast(this.t.stale(index), true);
      if (isFilePicker(element)) return this.toast(this.t.fileChooserBlocked, true);
      const label = this.labelOf(element);
      const refused = typeRefusal(element);
      const actionRefusal = clickRefusal(label);
      if (actionRefusal) return this.toast(this.t.refusedClick(label, actionRefusal), true);
      if (!this.allowed(refused ? 'sensitive' : isSearchField(element) ? 'read' : 'platform-write', 'browser_type', label)) {
        return this.toast(refused ? this.t.refusedType(label) : this.t.lookOnly(label), true);
      }
      const result = asRecord(await this.call('input', { index, text, snapshotId: element.snapshotId }, ctx.signal));
      const state = asState(result?.state);
      if (!state) return this.toast(this.t.failed('browser_type', 'the page did not answer after typing'), true);
      const answer = asRecord(result?.answer) as ClickAnswer | null;
      if (answer?.success === false) return this.toast(this.t.failed('browser_type', answer.message || 'typing failed'), true);
      this.lastTyped = isSearchField(element) ? null : { index, text, label };
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
      let targetSnapshotId: string | undefined;
      // Enter and Space can submit the focused control. Resolve it before the key reaches the page.
      if (key === 'Enter' || key === 'Space') {
        const element = asElement(await this.call(index === undefined ? 'active' : 'element', index === undefined ? {} : { index }, ctx.signal));
        if (!element) return this.toast(this.t.failed('browser_press', 'the focused target could not be verified'), true);
        if (isFilePicker(element)) return this.toast(this.t.fileChooserBlocked, true);
        const label = this.labelOf(element);
        targetSnapshotId = element.snapshotId;
        if (isDouyinPage(this.lastState?.url ?? '') && isFinalPublishControl(label)) return this.toast(this.t.manualPublish, true);
        const refusal = clickRefusal(label);
        if (refusal) return this.toast(this.t.refusedClick(label, refusal), true);
        if (element.id >= 0 && this.renumbered(element.id, element)) return this.toast(this.t.stale(element.id), true);
        if (removesState(label)) return this.toast(this.t.alreadyDone(label), true);
        const tag = String(element.tag ?? '').toLowerCase();
        const textEntry = tag === 'input' || tag === 'textarea' || String(element.role ?? '').toLowerCase() === 'textbox';
        const searchField = isSearchField(element);
        if (!this.self.actions && !searchField) return this.toast(this.t.lookOnly(label || 'unknown focused target'), true);
        if (element.id < 0 && !searchField && !textEntry) {
          return this.toast(this.t.failed('browser_press', 'the focused target needs an element number'), true);
        }
        if (isSendControl(label) && !textEntry) return this.toast(this.t.sendTargetNeedsIndex, true);
        if (!textEntry && (tag === 'button' || tag === 'a' || ['button', 'link'].includes(String(element.role ?? '').toLowerCase()))) {
          return this.toast(this.t.failed('browser_press', 'use browser_click with the numbered control'), true);
        }
        const refused = clickRefusal(label);
        const impact = key === 'Enter' && textEntry && !searchField
          ? 'platform-write'
          : refused ? 'sensitive' : isWriteAction(label) ? 'platform-write' : 'read';
        if (!this.allowed(impact, 'browser_press', label)) {
          return this.toast(refused ? this.t.refusedClick(label, refused) : this.t.lookOnly(label), true);
        }
        if (key === 'Enter' && textEntry && !searchField) {
          // Enter in a text box can publish its contents; approve the exact draft first.
          const box = index ?? element.id;
          const content = box >= 0 ? await this.draftAt(box, ctx.signal) : null;
          if (content === null) return this.toast(this.t.draftUnreadable, true);
          if (content.trim()) {
            return await this.publishText({ tool: 'browser_press', boxIndex: box, controlIndex: box, label, boxLabel: label, content }, ctx, async () => {
              const result = asRecord(await this.call('press', { key, snapshotId: targetSnapshotId, ...(index === undefined ? {} : { index }) }, ctx.signal));
              return asState(result?.state);
            });
          }
          return this.toast(this.t.sendDraftMissing, true);
        }
      } else if (index !== undefined) {
        const element = asElement(await this.call('element', { index }, ctx.signal));
        if (!element) return this.toast(this.t.noElement(index), true);
        if (this.renumbered(index, element)) return this.toast(this.t.stale(index), true);
        if (isFilePicker(element)) return this.toast(this.t.fileChooserBlocked, true);
        targetSnapshotId = element.snapshotId;
      }
      const result = asRecord(await this.call('press', { key, snapshotId: targetSnapshotId, ...(index === undefined ? {} : { index }) }, ctx.signal));
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
      let snapshotId: string | undefined;
      if (index !== undefined) {
        const element = asElement(await this.call('element', { index }, ctx.signal));
        if (!element || this.renumbered(index, element)) return this.toast(this.t.stale(index), true);
        snapshotId = element.snapshotId;
      }
      const result = asRecord(await this.call('scroll', { down, pages, snapshotId, ...(index === undefined ? {} : { index }) }, ctx.signal));
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
      this.lastVisualCapture = null;
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
      const width = Number(shot.width) || 0;
      const height = Number(shot.height) || 0;
      const captureId = typeof shot.captureId === 'string' ? shot.captureId : '';
      const viewportWidth = Number(shot.viewportWidth) || 0;
      const viewportHeight = Number(shot.viewportHeight) || 0;
      if (!(this.host?.modelFacts.accepts('image/jpeg') ?? true)) {
        this.lastVisualCapture = null;
        return this.image({ base64: shot.base64, width, height, state }, this.t.screenshot);
      }
      if (!captureId || width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0 || !state.snapshotId) {
        this.lastVisualCapture = null;
        return this.toast(this.t.failed('browser_screenshot', 'the page could not bind the image to a stable one-use capture'), true);
      }
      this.lastVisualCapture = {
        captureId,
        url: state.url,
        snapshotId: state.snapshotId,
        imageWidth: width,
        imageHeight: height,
        viewportWidth,
        viewportHeight,
        createdAt: Date.now(),
        used: false,
      };
      return this.image({ base64: shot.base64, width, height, state }, this.t.screenshotCapture(captureId, width, height));
    });
  }

  private async generateChatGPTImage(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_chatgpt_generate_image', ctx, async () => {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt || prompt.length > 2000) return this.toast(this.t.failed('browser_chatgpt_generate_image', 'prompt must be 1 to 2000 characters'), true);
      const blocked = this.begin('browser_chatgpt_generate_image');
      if (blocked) return blocked;
      if (!isChatGPTPage(this.lastState?.url ?? '')) return this.toast(this.t.failed('browser_chatgpt_generate_image', 'open the ChatGPT website in this browser first'), true);
      if (!this.allowed('image-generation', 'browser_chatgpt_generate_image', 'ChatGPT image prompt')) return this.toast(this.t.lookOnly('ChatGPT image prompt'), true);
      const page = this.lastState!;
      const composer = asRecord(await this.call('chatgpt-composer', {}, ctx.signal));
      const composerId = typeof composer?.id === 'string' ? composer.id : '';
      const composerSnapshot = typeof composer?.snapshotId === 'string' ? composer.snapshotId : '';
      if (!composerId || !composerSnapshot || composerSnapshot !== page.snapshotId) {
        return this.toast(this.t.failed('browser_chatgpt_generate_image', 'the current image composer does not match the page read'), true);
      }
      const decision = await this.approveBrowserAction(
        'image-generation',
        `Submit this image prompt once through ChatGPT:\n${prompt}`,
        page,
        composerId,
        'ChatGPT image prompt composer',
        prompt,
        ctx,
      );
      if (!decision.approved) return this.toast(decision.reason === 'unknown' ? this.t.sendUnknown
        : decision.reason === 'changed' ? this.t.sendChanged : this.t.lookOnly('ChatGPT image prompt'), true);
      const approval = decision.authorization;
      let result: Record<string, unknown> | null;
      try {
        result = asRecord(await this.call('chatgpt-generate-image', { prompt, composerId, snapshotId: composerSnapshot }, ctx.signal));
      } catch (error) {
        this.taskJournal?.finish(approval.journalId, 'unknown', 'the ChatGPT page did not answer after the approved prompt');
        throw error;
      }
      const state = asState(result?.state);
      const submitted = result?.submitted === true;
      this.taskJournal?.finish(approval.journalId, submitted ? 'verified' : 'unknown', submitted ? 'the ChatGPT page confirmed the submitted prompt' : 'the page did not confirm whether the prompt was submitted');
      const lead = submitted ? this.t.chatGPTImageSubmitted : this.t.chatGPTImageUnknown;
      if (state && typeof result?.base64 === 'string') {
        const shot = { base64: result.base64, width: Number(result.width) || 0, height: Number(result.height) || 0, state };
        return submitted ? this.image(shot, lead) : { ...this.image(shot, lead), failed: true };
      }
      if (state) return submitted ? this.toast(this.full(state, lead)) : this.toast(this.full(state, lead), true);
      return this.toast(lead, !submitted);
    });
  }

  private async saveChatGPTImage(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_save_chatgpt_image', ctx, async () => {
      const index = this.indexArg(args.index);
      if (index === null) return this.toast(this.t.failed('browser_save_chatgpt_image', 'index must be a whole number of at least 0'), true);
      const blocked = this.begin('browser_save_chatgpt_image');
      if (blocked) return blocked;
      if (!isChatGPTPage(this.lastState?.url ?? '')) return this.toast(this.t.failed('browser_save_chatgpt_image', 'open the generated image on the ChatGPT website first'), true);
      if (!this.allowed('image-saving', 'browser_save_chatgpt_image', 'save ChatGPT image')) return this.toast(this.t.lookOnly('save ChatGPT image'), true);
      const page = this.lastState!;
      const element = asElement(await this.call('element', { index }, ctx.signal));
      if (!element) return this.toast(this.t.noElement(index), true);
      if (this.renumbered(index, element)) return this.toast(this.t.stale(index), true);
      if (isFilePicker(element)) return this.toast(this.t.fileChooserBlocked, true);
      const decision = await this.approveBrowserAction(
        'image-saving',
        `Download the visible ChatGPT image at element ${index} to temporary staging for verification; do not save it to the video media folder yet.`,
        page,
        `image-save:${index}`,
        element.label || `image save control ${index}`,
        `${element.role}: ${element.label}`,
        ctx,
        { actionLabel: coreText(this.opts.language?.() ?? 'zh').browserAction.imageStaging },
      );
      if (!decision.approved) return this.toast(decision.reason === 'unknown' ? this.t.sendUnknown
        : decision.reason === 'changed' ? this.t.sendChanged : this.t.lookOnly('save ChatGPT image'), true);
      const stageApproval = decision.authorization;
      let staged: Record<string, unknown> | null;
      try {
        staged = asRecord(await this.call('stage-chatgpt-image', { index, snapshotId: element.snapshotId }, ctx.signal));
      } catch (error) {
        this.taskJournal?.finish(stageApproval.journalId, 'unknown', 'the staged image download result was not received');
        throw error;
      }
      const stageToken = typeof staged?.stageToken === 'string' ? staged.stageToken : '';
      const state = asState(staged?.state);
      const file = typeof staged?.file === 'string' ? staged.file : '';
      const bytes = Number(staged?.bytes);
      const mime = typeof staged?.mime === 'string' ? staged.mime : '';
      const digest = typeof staged?.digest === 'string' ? staged.digest : '';
      const stageIsValid = /^[0-9a-f-]{36}$/i.test(stageToken)
        && /^chatgpt-image-\d+-[0-9a-f-]{36}\.(png|jpg|webp)$/i.test(file)
        && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 40 * 1024 * 1024
        && ['image/png', 'image/jpeg', 'image/webp'].includes(mime)
        && /^[a-f0-9]{64}$/.test(digest)
        && !!state?.snapshotId && isChatGPTPage(state.url);
      if (!staged || !stageIsValid || !state) {
        if (stageToken) await this.call('discard-staged-chatgpt-image', { stageToken }, undefined).catch(() => undefined);
        this.taskJournal?.finish(stageApproval.journalId, 'unknown', 'the staged image metadata or page could not be verified');
        return this.toast(this.t.failed('browser_save_chatgpt_image', 'the staged image could not be verified'), true);
      }
      const fileBinding = [{ path: file, digest, bytes, mime }];
      this.taskJournal?.finish(stageApproval.journalId, 'verified', `staged ${file} (${bytes} bytes, sha256 ${digest})`);
      const imageApprovalText = coreText(this.opts.language?.() ?? 'zh').browserAction;
      const approval = await this.approveBrowserAction(
        'image-saving',
        `Save the verified generated image with SHA-256 ${digest} to the video media folder.`,
        state,
        'video-media-folder',
        `save image sha256:${digest}`,
        imageApprovalText.imageSaveDetails(file, bytes, mime, digest),
        ctx,
        { files: fileBinding, dedupeKey: `${digest}:${bytes}:${mime}` },
      );
      if (!approval.approved) {
        await this.call('discard-staged-chatgpt-image', { stageToken }, undefined).catch(() => undefined);
        return this.toast(approval.reason === 'unknown' ? this.t.sendUnknown
          : approval.reason === 'changed' ? this.t.sendChanged : this.t.lookOnly('save ChatGPT image'), true);
      }
      let committed: Record<string, unknown> | null;
      try {
        committed = asRecord(await this.call('commit-staged-chatgpt-image', {
          stageToken, file, bytes, mime, digest, snapshotId: state.snapshotId,
        }, ctx.signal));
      } catch (error) {
        this.taskJournal?.finish(approval.authorization.journalId, 'unknown', 'the final image save result was not received');
        await this.call('discard-staged-chatgpt-image', { stageToken }, undefined).catch(() => undefined);
        throw error;
      }
      const saved = committed?.file === file && committed.bytes === bytes
        && committed.mime === mime && committed.digest === digest;
      this.taskJournal?.finish(approval.authorization.journalId, saved ? 'verified' : 'unknown', saved
        ? `saved ${file} (${bytes} bytes, sha256 ${digest})`
        : 'the saved image did not match the approved file');
      if (!saved) return this.toast(this.t.failed('browser_save_chatgpt_image', 'the final file did not match the approved image'), true);
      if (typeof staged.base64 === 'string') {
        return this.image({ base64: staged.base64, width: Number(staged.width) || 0, height: Number(staged.height) || 0, state }, this.t.chatGPTImageSaved(file, bytes));
      }
      return this.toast(state ? this.full(state, this.t.chatGPTImageSaved(file, bytes)) : this.t.chatGPTImageSaved(file, bytes));
    });
  }

  private async uploadMedia(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    return this.run('browser_upload_media', ctx, async () => {
      const fileId = this.indexArg(args.fileId);
      const files = Array.isArray(args.files) ? args.files.filter((file): file is string => typeof file === 'string' && !!file.trim()) : [];
      if (fileId === null) return this.toast(this.t.failed('browser_upload_media', 'fileId must be a non-negative page-local file input id'), true);
      if (!files.length || files.length > 20 || files.length !== (Array.isArray(args.files) ? args.files.length : 0)) {
        return this.toast(this.t.failed('browser_upload_media', 'choose 1 to 20 relative media paths'), true);
      }
      const blocked = this.begin('browser_upload_media');
      if (blocked) return blocked;
      const page = this.lastState;
      if (!page || !isDouyinPage(page.url) || !page.snapshotId) return this.toast(this.t.failed('browser_upload_media', 'read the current Douyin page first'), true);
      const input = page.fileInputs?.find((candidate) => candidate.id === fileId);
      if (!input || input.disabled) return this.toast(this.t.failed('browser_upload_media', 'that file input is missing, disabled or from an older page read'), true);
      if (!input.multiple && files.length > 1) return this.toast(this.t.failed('browser_upload_media', 'the page input accepts one file at a time'), true);
      if (!this.allowed('media-upload', 'browser_upload_media', `${files.length} media file(s) into Douyin`)) return this.toast(this.t.lookOnly('Douyin media upload'), true);
      const inspected = asRecord(await this.call('inspect-upload', { fileId, snapshotId: page.snapshotId, files }, ctx.signal));
      const account = asRecord(inspected?.account);
      const approvedFiles = Array.isArray(inspected?.files)
        ? inspected.files.flatMap((value) => {
          const file = asRecord(value);
          return file && typeof file.path === 'string' && Number.isSafeInteger(file.bytes) && Number(file.bytes) > 0
            && typeof file.digest === 'string' && /^[a-f0-9]{64}$/.test(file.digest)
            && typeof file.mime === 'string' && file.mime.includes('/')
            ? [{ path: file.path, bytes: Number(file.bytes), digest: file.digest, mime: file.mime }]
            : [];
        })
        : [];
      if (!inspected || inspected.url !== page.url || inspected.snapshotId !== page.snapshotId
        || inspected.accept !== input.accept || inspected.multiple !== input.multiple
        || typeof account?.ref !== 'string' || !account.ref || typeof account.label !== 'string' || !account.label
        || approvedFiles.length !== files.length || approvedFiles.some((file, index) => file.path !== files[index])) {
        return this.toast(this.t.failed('browser_upload_media', 'the current account, form or media list could not be verified'), true);
      }
      const form = `${input.label} (accept=${input.accept || '*'}, multiple=${input.multiple})`;
      const listed = approvedFiles.map((file) => `${file.path} — ${file.bytes} bytes — ${file.mime} — sha256 ${file.digest}`).join('\n');
      const taskText = `Select these ${approvedFiles.length} media file(s) in the Douyin upload form; do not submit the post.`;
      const decision = await this.approveBrowserAction(
        'media-upload',
        taskText,
        page,
        `file:${fileId}`,
        form,
        `Account: ${account.label} (${account.ref})\nOrigin: ${originOf(page.url)}\nForm: ${form}\nFiles (${approvedFiles.length}):\n${listed}`,
        ctx,
        { accountRef: account.ref, files: approvedFiles },
      );
      if (!decision.approved) return this.toast(decision.reason === 'unknown' ? this.t.sendUnknown
        : decision.reason === 'changed' ? this.t.sendChanged : this.t.lookOnly('Douyin media upload'), true);
      const approval = decision.authorization;
      let currentInspection: Record<string, unknown> | null;
      try {
        currentInspection = asRecord(await this.call('inspect-upload', { fileId, snapshotId: page.snapshotId, files }, ctx.signal));
      } catch (error) {
        this.taskJournal?.finish(approval.journalId, 'cancelled', 'the pre-dispatch media read failed');
        throw error;
      }
      if (!currentInspection || JSON.stringify(currentInspection.files) !== JSON.stringify(approvedFiles)
        || currentInspection.snapshotId !== page.snapshotId || currentInspection.url !== page.url) {
        this.taskJournal?.finish(approval.journalId, 'cancelled', 'the page or media changed before upload');
        return this.toast(this.t.failed('browser_upload_media', 'the page or media changed after approval'), true);
      }
      let result: Record<string, unknown> | null;
      try {
        result = asRecord(await this.call('upload-media', {
          fileId,
          snapshotId: page.snapshotId,
          files,
          expectedFiles: approvedFiles,
        }, ctx.signal));
      } catch (error) {
        this.taskJournal?.finish(approval.journalId, 'unknown', 'the page did not confirm the file selection');
        throw error;
      }
      const selected = Array.isArray(result?.files) ? result.files.filter((file): file is string => typeof file === 'string') : [];
      if (selected.length !== files.length || selected.some((file, index) => file !== files[index])) {
        this.taskJournal?.finish(approval.journalId, 'unknown', 'the selected files did not match the approved file list');
        return this.toast(this.t.failed('browser_upload_media', 'the browser did not confirm the selected media files'), true);
      }
      this.taskJournal?.finish(approval.journalId, 'verified', 'the page confirmed the approved file list in its upload control');
      const state = asState(result?.state);
      return this.toast(state ? this.full(state, this.t.uploadedMedia(selected)) : this.t.uploadedMedia(selected));
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

  /* ---------- public writes ---------- */

  /** The live contents of one text box, or null when the page cannot say. */
  private async draftAt(index: number, signal?: AbortSignal): Promise<string | null> {
    try {
      const value = await this.call('draft', { index }, signal);
      return typeof value === 'string' ? value : null;
    } catch { return null; }
  }

  /**
   * One public write, start to finish: the person confirms this page, target and text; the record
   * reaches the disk before the input leaves; the box is re-read after the confirmation; and the
   * receipt is `verified` only when the page itself shows the box cleared. A dispatch that fails
   * after leaving is `unknown`, never a reason to press again.
   */
  private async publishText(
    input: { tool: string; boxIndex: number; controlIndex: number | null; label: string; boxLabel: string; content: string },
    ctx: ToolCallContext,
    dispatch: () => Promise<PageState | null>,
  ): Promise<ToolOutcome> {
    if (this.publishing) return this.toast(this.t.sendBusy, true);
    if (this.journalUnavailable || !this.journal || !this.ensureTaskJournal()) return this.toast(this.t.sendJournalUnavailable, true);
    this.publishing = true;
    try {
      const targetRefusal = clickRefusal(input.boxLabel) ?? clickRefusal(input.label);
      if (targetRefusal) return this.toast(this.t.refusedClick(input.boxLabel || input.label, targetRefusal), true);
      const page = this.lastState;
      const candidateReplies = page?.replyTargets?.filter((candidate) => candidate.boxId === input.boxIndex) ?? [];
      const replyLabel = /\b(?:reply|respond)\b|回复|回覆|回应/i.test(input.boxLabel);
      const isReply = replyLabel || candidateReplies.length > 0;
      if (isReply && candidateReplies.length !== 1) return this.toast(this.t.sendReplyUnverified, true);
      const replyTarget = isReply ? candidateReplies[0] : undefined;
      if (replyTarget?.needsExpand) return this.toast(this.t.sendReplyNeedsExpand, true);
      const previousReplyNotices = new Set((page?.statusMessages ?? [])
        .filter((message) => commentReplyConfirmed([message]))
        .map((message) => message.replace(/\s+/g, ' ').trim().toLowerCase()));
      if (replyTarget) {
        if (!this.replyJournal || this.replyJournalUnavailable) return this.toast(this.t.sendReplyJournalUnavailable, true);
        try {
          if (this.replyJournal.has(replyTarget.fingerprint)
            || this.actions.some((action) => action.target.commentFingerprint === replyTarget.fingerprint)
            || this.taskJournal?.hasUnresolvedComment(replyTarget.fingerprint)) {
            return this.toast(this.t.sendReplyDuplicate, true);
          }
        } catch {
          this.replyJournalUnavailable = true;
          return this.toast(this.t.sendReplyJournalUnavailable, true);
        }
      }
      const target: ActionTarget = {
        surface: 'browser',
        origin: originOf(page?.url ?? ''),
        url: page?.url ?? '',
        videoUrl: page?.current?.url ?? '',
        videoTitle: page?.current?.title ?? page?.title ?? '',
        snapshotId: page?.snapshotId ?? '',
        accountRef: page?.account?.ref,
        accountLabel: page?.account?.label,
        ...(replyTarget ? { commentFingerprint: replyTarget.fingerprint } : {}),
        control: input.label || `#${input.controlIndex ?? input.boxIndex}`,
      };
      if (!target.videoUrl || !target.snapshotId) return this.toast(this.t.sendTargetUnverified, true);
      if (!target.accountRef || !target.accountLabel) return this.toast(this.t.sendAccountUnverified, true);
      const contentDigest = hashContent(input.content);
      if (this.taskJournal?.hasLegacyTextCollision(target.videoUrl, contentDigest, replyTarget?.fingerprint)) {
        return this.toast(this.t.sendUnknown, true);
      }
      const where = [target.videoTitle, target.videoUrl].filter(Boolean).join(' — ');
      const approvalWhere = replyTarget
        ? `${where}\n回复对象：${replyTarget.author}\n原评论：${replyTarget.context}`
        : where;
      const targetStillBound = async (): Promise<boolean> => {
        try {
          const current = asState(await this.call('read', {}, ctx.signal));
          if (!current || current.snapshotId !== target.snapshotId || !current.account || current.url !== target.url
            || current.current?.url !== target.videoUrl || current.account.ref !== target.accountRef
            || current.account.label !== target.accountLabel) return false;
          if (replyTarget && JSON.stringify(current.statusMessages ?? []) !== JSON.stringify(page?.statusMessages ?? [])) return false;
          const box = asElement(await this.call('element', { index: input.boxIndex }, ctx.signal));
          if (!box || isFilePicker(box) || this.renumbered(input.boxIndex, box)) return false;
          const currentReplies = current.replyTargets?.filter((candidate) => candidate.boxId === input.boxIndex) ?? [];
          if (replyTarget) {
            if (currentReplies.length !== 1 || currentReplies[0]?.fingerprint !== replyTarget.fingerprint
              || currentReplies[0]?.evidenceHash !== replyTarget.evidenceHash || currentReplies[0]?.needsExpand) return false;
          } else if (currentReplies.length || /\b(?:reply|respond)\b|回复|回覆|回应/i.test(input.boxLabel)) return false;
          if (input.controlIndex !== null) {
            const control = asElement(await this.call('element', { index: input.controlIndex }, ctx.signal));
            if (!control || isFilePicker(control) || this.renumbered(input.controlIndex, control)) return false;
            if (normalLabel(this.labelOf(control)) !== normalLabel(input.label)) return false;
            if (input.tool === 'browser_click') {
              const matches = current.elements?.filter((element) => normalLabel(element.label) === normalLabel(input.label)) ?? [];
              if (matches.length !== 1 || matches[0]?.id !== input.controlIndex) return false;
            }
          }
          return true;
        } catch { return false; }
      };
      const accountDisplay = `${target.accountLabel} (${target.accountRef})`;
      const taskText = `Send this exact text once on ${target.videoUrl}: ${input.content}`;
      const decision = await this.approveBrowserAction(
        'platform-write',
        taskText,
        page!,
        `video:${target.videoUrl}`,
        'text-submit',
        `Account: ${accountDisplay}\nTarget: ${approvalWhere}\nControl: ${input.label || input.boxLabel}\nText: ${input.content}`,
        ctx,
        {
          accountRef: target.accountRef,
          dedupeKey: replyTarget?.fingerprint,
          commentFingerprint: replyTarget?.fingerprint,
          payloadDigest: contentDigest,
          risk: 'IRREVERSIBLE_OR_PUBLIC',
        },
      );
      if (!decision.approved) return this.toast(decision.reason === 'unknown' ? this.t.sendUnknown
        : decision.reason === 'changed' ? this.t.sendChanged
          : decision.reason === 'not-answered' ? this.t.sendNotAnswered
            : decision.reason === 'not-approved' ? this.t.sendCancelled
              : this.t.sendJournalUnavailable, true);
      const finish = (result: ActionReceiptCompletion) => {
        try { this.taskJournal?.complete(decision.authorization.journalId, result); } catch { /* acting remains unresolved on disk */ }
      };

      // Re-resolve the page, editor, control and text after the grant reaches the journal.
      if (!await targetStillBound() || await this.draftAt(input.boxIndex, ctx.signal) !== input.content) {
        finish({ phase: 'cancelled', dispatchState: 'not-dispatched', outcome: 'cancelled', note: 'the target or the text changed after approval' });
        return this.toast(this.t.sendChanged, true);
      }

      let state: PageState | null = null;
      try {
        state = await dispatch();
      } catch {
        finish({ phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown', note: 'the page did not answer after the input' });
        return this.toast(this.t.sendUnknown, true);
      }

      const after = await this.draftAt(input.boxIndex);
      if (state && state.url === target.url && state.current?.url === target.videoUrl && state.account?.ref === target.accountRef && after === '') {
        const status = submissionStatus(state.statusMessages ?? []);
        const newReplyNotice = (state.statusMessages ?? []).some((message) => commentReplyConfirmed([message])
          && !previousReplyNotices.has(message.replace(/\s+/g, ' ').trim().toLowerCase()));
        if (replyTarget && (!newReplyNotice || (status !== 'submitted' && status !== 'pending-review' && status !== 'published'))) {
          finish({ phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown', note: 'the reply box cleared without a page confirmation of the comment reply' });
          return this.toast(this.t.sendUnknown, true);
        }
        if (replyTarget) {
          try { this.replyJournal!.add(replyTarget.fingerprint); }
          catch {
            finish({ phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown', note: 'the page confirmed the reply but the duplicate guard could not be saved' });
            return this.toast(this.t.sendUnknown, true);
          }
        }
        if (status === 'pending-review') {
          finish({ phase: 'review-pending', dispatchState: 'delivered', outcome: 'review-pending', note: 'the page shows the submission under review' });
        } else if (status === 'published') {
          finish({ phase: 'verified', dispatchState: 'delivered', outcome: 'verified', note: 'the page shows the submitted item as published' });
        } else if (status === 'submitted' || newReplyNotice) {
          finish({ phase: 'submitted', dispatchState: 'delivered', outcome: 'remote-acknowledged', note: 'the page acknowledges the submission without a final review status' });
        } else {
          finish({ phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown', note: 'the text box cleared but the page gave no submission status' });
        }
        this.lastTyped = null;
        return this.toast(this.full(state, this.t.sent(approvalWhere, status)));
      }
      finish({ phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown', note: 'the box still shows the text, or could not be read' });
      return this.toast(this.t.sendUnknown, true);
    } finally {
      this.publishing = false;
    }
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
      if (/ambiguous share target/.test(message)) return this.toast(this.t.ambiguous(this.t.share), true);
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

  /** Remembers what each number meant on the page the model is about to read. */
  private seen(state: PageState): void {
    if (this.lastVisualCapture && (state.url !== this.lastVisualCapture.url
      || state.snapshotId !== this.lastVisualCapture.snapshotId)) this.lastVisualCapture = null;
    this.lastState = state;
    if (state.url !== this.shownUrl) {
      this.shownUrl = state.url;
      this.shown.clear();
      this.shownSnapshotId = '';
      this.lastTyped = null;
    }
    if (!state.elements) return;
    this.shown = new Map(state.elements.map((element) => [element.id, normalLabel(element.label)]));
    this.shownSnapshotId = state.snapshotId ?? '';
  }

  /** Whether this number is no longer the element the model read; act only after another read. */
  private renumbered(index: number, element: AgentElement): boolean {
    const before = this.shown.get(index);
    if (this.shownSnapshotId && element.snapshotId && this.shownSnapshotId !== element.snapshotId) return true;
    return before !== undefined && before !== normalLabel(element.label || element.text);
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
    this.seen(state);
    const content = state.content.replace(/^(\s*)\*\[/gm, '$1[');
    const body = content.length > CONTENT_MAX ? `${content.slice(0, CONTENT_MAX)}\n${this.t.truncated}` : content;
    const header = state.header.length > 1600 ? `${state.header.slice(0, 1600)}…` : state.header;
    return [lead, header, body, state.footer.slice(0, 400), this.currentVideo(state), this.t.timestamps(state.timestamps ?? []), this.t.fileInputs(state.fileInputs ?? []), this.t.replyTargets(state.replyTargets ?? []), state.statusMessages?.length ? `Page status: ${state.statusMessages.join(' · ')}` : '', this.t.video(state.video)].filter(Boolean).join('\n');
  }

  private brief(state: PageState, lead = ''): string {
    this.seen(state);
    return [lead, this.t.pageLine(state.title, state.url), this.currentVideo(state), this.t.video(state.video)].filter(Boolean).join('\n');
  }

  /** The playing video's own address, when the page names one. */
  private currentVideo(state: PageState): string {
    return state.current ? this.t.currentVideo(state.current.title, state.current.url) : '';
  }

  private image(shot: Shot, lead: string): ToolOutcome {
    this.seen(shot.state);
    const text = [lead, this.t.pageLine(shot.state.title, shot.state.url), this.currentVideo(shot.state), this.t.video(shot.state.video)].filter(Boolean).join('\n');
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
    this.seen(last.state);
    const shown = times.slice(0, shots.length);
    const text = [this.t.watched(seconds, shots.length, shown), this.t.pageLine(last.state.title, last.state.url), this.currentVideo(last.state), this.t.video(last.state.video), audioNote]
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
