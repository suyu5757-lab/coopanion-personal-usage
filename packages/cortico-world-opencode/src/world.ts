/**
 * opencode as a World. A task starts an `opencode acp` child in one of the person's allowed
 * directories, sends one prompt and returns at once. Core authorizes each command and file payload
 * before dispatch and records the result; standalone use relays ACP permissions through its tool.
 * The turn ends with an event, and the World reports its avatar state to the app.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { AcpClient, type AcpCommand, type AcpPermissionOutcome, type AcpPermissionRequest, type AcpToolCall, type AcpUpdate } from './acp.ts';
import { OPENCODE_CONFIG_GROUP, insideRoot, readConfig, workRoots, type OpencodeConfigSection } from './config.ts';
import { MODEL_TEXT, type ModelLanguage } from './model-text.ts';
import type { ReviewCommand, TaskReview } from './review.ts';
import { OPENCODE_TOOL_DECLS } from './tools.ts';

export const OPENCODE_ID = 'opencode';

export type OpencodeGuestPhase = 'boot' | 'work' | 'wait' | 'done' | 'oops';

/** The avatar state the app shows beside the pet. */
export interface OpencodeGuestState {
  show: boolean;
  state?: OpencodeGuestPhase;
  taskId?: string;
}

export interface OpencodeWorldOptions {
  /** The live `worlds.opencode` section. */
  cfg: OpencodeConfigSection;
  /** The deployment's time zone, for event timestamps. */
  timezone: string;
  modelLanguage: () => ModelLanguage;
  /** The app's guest avatar channel; omitted when the avatar is not in use. */
  onState?: (state: OpencodeGuestState) => void;
  /** Tests run this instead of the configured binary; the session still picks its own cwd. */
  command?: AcpCommand;
  /** Extra child environment, mostly for tests. */
  env?: NodeJS.ProcessEnv;
  /** Coopanion Core grants one ACP file or command side effect at a time. */
  authorizeAction?: (request: OpencodeActionRequest, confirmInCoreUi: () => Promise<boolean>) => Promise<OpencodeActionAuthorization | null>;
  confirmAction?: (request: OpencodeActionRequest) => Promise<boolean>;
}

export interface OpencodeFileTargetEvidence {
  surface: 'filesystem';
  instanceId: string;
  workspaceRoot: string;
  path: string;
  operation: 'file-write' | 'command-execution';
  snapshotId: string;
  source: 'opencode-acp';
}

export type OpencodeActionFile = { path: string; digest: string; bytes: number; mime: string };

export interface OpencodeActionRequest {
  taskId: string;
  taskText: string;
  actionName: string;
  expectedChange: string;
  payloadDigest: string;
  risk: 'REVERSIBLE_LOCAL' | 'IRREVERSIBLE_OR_PUBLIC';
  target: OpencodeFileTargetEvidence;
  action: 'file-write' | 'command-execution';
  files: OpencodeActionFile[];
  expiresInMs: 30_000;
  maxSteps: 1;
}

interface OpencodeActionCompletionDetails {
  note: string;
  evidence?: { source: string; status: string; summary?: string; digest?: string; observedAt: number };
}

export type OpencodeActionCompletion =
  | (OpencodeActionCompletionDetails & { phase: 'acting'; dispatchState: 'delivered'; outcome: 'delivered' })
  | (OpencodeActionCompletionDetails & { phase: 'verified'; dispatchState: 'delivered'; outcome: 'ui-observed' | 'remote-acknowledged' | 'verified' })
  | (OpencodeActionCompletionDetails & { phase: 'unknown'; dispatchState: 'not-dispatched' | 'delivered' | 'unknown'; outcome: 'unknown' })
  | (OpencodeActionCompletionDetails & { phase: 'cancelled'; dispatchState: 'not-dispatched'; outcome: 'cancelled' });

export interface OpencodeActionAuthorization {
  consume(target: OpencodeFileTargetEvidence, expectedChange: string, files: readonly OpencodeActionFile[]): boolean;
  revoke(): void;
  complete(result: OpencodeActionCompletion): void;
}

interface PermissionPending {
  id: string;
  request: AcpPermissionRequest;
  resolve: (outcome: AcpPermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

interface AuthorizedAction {
  toolCallId: string;
  request: OpencodeActionRequest;
  authorization: OpencodeActionAuthorization;
  consumed: boolean;
}

interface Task {
  id: string;
  dir: string;
  sessionId: string;
  text: string;
  startedAt: number;
  client: AcpClient;
  permission: PermissionPending | null;
  actions: Map<string, AuthorizedAction>;
  files: Set<string>;
  diffs: Map<string, { oldText: string; newText: string }>;
  commands: Map<string, ReviewCommand>;
  summary: string;
  stopTimer: NodeJS.Timeout | null;
}

const ENV_PROMPT_FILES: Record<ModelLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

/** How long the avatar lingers after a task before it folds away. */
const GUEST_LINGER_MS = 4500;
/** How long the boot screen stays before the work screen, matching the page's unfold. */
const GUEST_BOOT_MS = 950;
/** How long a stopped task waits for opencode to acknowledge the cancel before the child is closed. */
const STOP_GRACE_MS = 10_000;
/** How long the ACP child may sit idle between tasks before it is closed. */
const CLIENT_IDLE_MS = 15 * 60_000;
/** The files and the summary the result event carries. */
const SUMMARY_MAX = 2400;
const FILES_MAX = 20;
const DETAIL_MAX = 1600;
const COMMAND_OUTPUT_MAX = 1200;
const COMMANDS_MAX = 20;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** The permission baseline when `askSensitive` is on: everything that changes, fetches or launches asks. */
const ASK_PERMISSIONS = {
  bash: 'ask',
  edit: 'ask',
  external_directory: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  task: 'ask',
  skill: 'ask',
};

const noopLogger = {
  child() { return this; },
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
  emit() {},
} as unknown as Logger;

export class OpencodeWorld implements World {
  readonly id = OPENCODE_ID;
  private readonly opts: OpencodeWorldOptions;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private client: AcpClient | null = null;
  private clientKey = '';
  private clientSession: string | null = null;
  private starting: Promise<AcpClient> | null = null;
  private task: Task | null = null;
  private lastSession: { dir: string; sessionId: string } | null = null;
  private review: TaskReview | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private permissionSeq = 0;
  private startingTask = false;
  private stopped = false;

  constructor(opts: OpencodeWorldOptions) {
    this.opts = opts;
  }

  private get t() {
    return MODEL_TEXT[this.opts.modelLanguage()];
  }

  private cfg(): OpencodeConfigSection {
    return readConfig(this.opts.cfg);
  }

  async start(host: WorldHost): Promise<void> {
    this.stopped = false;
    this.host = host;
    this.log = host.log.child('opencode');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.task) {
      const task = this.task;
      this.settleAuthorizedActions(task);
      this.task = null;
      if (task.stopTimer) clearTimeout(task.stopTimer);
      this.settlePermission(task, { outcome: 'cancelled' });
      task.client.cancel(task.sessionId);
    }
    await this.closeClient();
    this.guest({ show: false });
    this.host = null;
    this.log = null;
  }

  async envPromptVars(): Promise<Record<string, string>> {
    const cfg = this.cfg();
    const roots = workRoots(cfg);
    const permissionFlow = this.opts.authorizeAction
      ? this.opts.modelLanguage() === 'en'
        ? 'Coopanion Core asks the person directly before each file write or command and records one action receipt. Do not call opencode_answer; wait for the authorized operation to continue.'
        : 'Coopanion Core 会在每次写文件或运行命令前直接询问本人并记录单次动作回执。不要调用 opencode_answer；等待获准的操作继续。'
      : this.opts.modelLanguage() === 'en'
        ? 'Relay the permission request through pet_ask and call opencode_answer with the person’s choice. Never approve it yourself.'
        : '通过 pet_ask 转述权限请求，再用 opencode_answer 提交本人的选择。不要代替本人批准。';
    return {
      'opencode.roots': this.t.roots(roots),
      'opencode.task': String(cfg.taskMinutes),
      'opencode.permission': String(cfg.permissionMinutes),
      'opencode.permissionFlow': permissionFlow,
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language !== 'zh' && language !== 'zh-Hant';
    const lamp: WorldLamp = {
      label: 'opencode',
      state: this.task ? 'online' : this.client?.alive ? 'online' : this.starting ? 'loading' : this.client ? 'error' : 'offline',
    };
    return {
      label: 'opencode',
      lamps: [lamp],
      config: [OPENCODE_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.opencode.envPrompt',
        title: en ? 'opencode environment' : 'opencode 环境',
        description: en
          ? 'How Coo summons opencode, what it may work on and how permissions are relayed.'
          : 'Coo 如何召唤 opencode、它能在哪些目录工作,以及权限如何转述。',
        path: ENV_PROMPT_FILES[this.opts.modelLanguage()],
        role: 'envPrompt',
        vars: [
          { name: 'opencode.roots', description: en ? 'The directories opencode may work in.' : 'opencode 可以工作的目录。' },
          { name: 'opencode.task', description: en ? 'The longest one task may run, in minutes.' : '一个任务最多跑多少分钟。' },
          { name: 'opencode.permission', description: en ? 'How long a permission request waits, in minutes.' : '权限请求最多等多少分钟。' },
          { name: 'opencode.permissionFlow', description: en ? 'How file and command permissions are confirmed.' : '文件和命令权限如何确认。' },
        ],
      }],
    };
  }

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      opencode_task: (args) => this.startTask(args),
      opencode_answer: async (args) => this.answer(args),
      opencode_stop: async (args) => this.stopTask(args),
      opencode_status: async () => this.status(),
      opencode_review: async (args) => this.reviewTool(args),
    };
    return OPENCODE_TOOL_DECLS.filter((decl) => !this.opts.authorizeAction || decl.name !== 'opencode_answer').map((decl) => {
      const handler = handlers[decl.name];
      if (!handler) throw new Error(`no handler for opencode tool ${decl.name}`);
      return { ...decl, handler };
    });
  }

  /* ---------- tasks ---------- */

  private async startTask(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (this.stopped) return { text: this.t.stopping, failed: true };
    if (this.task) return { text: this.t.busy(this.task.id), failed: true };
    if (this.startingTask) return { text: this.t.starting, failed: true };
    this.startingTask = true;
    try {
      return await this.beginTask(args);
    } finally {
      this.startingTask = false;
    }
  }

  private async beginTask(args: Record<string, unknown>): Promise<ToolOutcome> {
    const t = this.t;
    const cfg = this.cfg();
    const text = typeof args.task === 'string' ? args.task.trim() : '';
    if (!text) return { text: t.emptyTask, failed: true };

    const configured = workRoots(cfg);
    if (!configured.length) return { text: t.noRoots, failed: true };
    const roots = configured.map((root) => { try { return realpathSync(root); } catch { return root; } });

    let dir: string;
    try {
      dir = this.pickDir(args.dir, roots, configured);
    } catch (error) {
      return { text: t.taskRefused(error instanceof Error ? error.message : String(error)), failed: true };
    }

    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    let client: AcpClient;
    try {
      client = await this.ensureClient(dir);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log?.warn(`opencode did not start: ${reason}`);
      return { text: t.missingBinary(cfg.bin, reason), failed: true };
    }

    let sessionId: string;
    try {
      const resume = args.resume === true;
      if (resume && this.lastSession?.dir === dir) {
        sessionId = this.lastSession.sessionId;
        if (this.clientSession !== sessionId) {
          await client.resumeSession(sessionId, dir);
          this.clientSession = sessionId;
        }
      } else {
        sessionId = await client.newSession(dir);
        this.clientSession = sessionId;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log?.warn(`opencode session failed: ${reason}`);
      await this.closeClient();
      return { text: t.sessionFailed(reason), failed: true };
    }

    if (this.stopped) {
      await this.closeClient();
      return { text: t.stopping, failed: true };
    }

    const task: Task = {
      id: `opencode-${++this.seq}`,
      dir,
      sessionId,
      text,
      startedAt: Date.now(),
      client,
      permission: null,
      actions: new Map(),
      files: new Set(),
      diffs: new Map(),
      commands: new Map(),
      summary: '',
      stopTimer: null,
    };
    this.task = task;
    this.lastSession = { dir, sessionId };
    this.guest({ show: true, state: 'boot', taskId: task.id });
    setTimeout(() => {
      if (this.task === task && !task.permission) this.guest({ show: true, state: 'work', taskId: task.id });
    }, GUEST_BOOT_MS).unref();
    void this.run(task);
    return { text: t.taskStarted(task.id, dir) };
  }

  private pickDir(raw: unknown, roots: readonly string[], configured: readonly string[]): string {
    const t = this.t;
    let dir: string;
    if (typeof raw === 'string' && raw.trim()) {
      let path = raw.trim();
      if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = homedir() + path.slice(1);
      if (!isAbsolute(path)) throw new Error(t.badDir(path, configured));
      dir = resolve(path);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(t.badDir(dir, configured));
      dir = realpathSync(dir);
      if (!insideRoot(roots, dir)) throw new Error(t.badDir(dir, configured));
      return dir;
    }
    if (configured.length === 1) {
      const only = roots[0];
      if (!only || !existsSync(only) || !statSync(only).isDirectory()) throw new Error(t.badDir(configured[0] ?? '', configured));
      return realpathSync(only);
    }
    throw new Error(t.dirRequired(configured));
  }

  private async run(task: Task): Promise<void> {
    const t = this.t;
    const cfg = this.cfg();
    try {
      const result = await task.client.prompt(task.sessionId, task.text, cfg.taskMinutes * 60_000);
      if (this.task !== task) return;
      const stop = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';
      if (stop === 'end_turn') {
        const review = this.reviewOf(task, stop, true);
        const files = review.files.map((file) => `${file.path} (+${file.added}/-${file.removed})`);
        const commands = review.commands.map((command) => `${command.command} [${command.status}] ${command.output.slice(-240)}`);
        this.finishTask(task, 'result', t.result(task.id, task.dir, stop, review.summary, files, task.sessionId, commands), 'done', review);
      } else if (stop === 'cancelled') {
        const review = this.reviewOf(task, stop, false);
        const files = review.files.map((file) => `${file.path} (+${file.added}/-${file.removed})`);
        const commands = review.commands.map((command) => `${command.command} [${command.status}] ${command.output.slice(-240)}`);
        this.finishTask(task, 'result', t.result(task.id, task.dir, stop, review.summary, files, task.sessionId, commands), 'oops', review);
      } else {
        this.failTask(task, stop, stop);
      }
    } catch (error) {
      if (this.task !== task) return;
      const message = error instanceof Error ? error.message : String(error);
      const reason = /timed out/.test(message) ? t.timeout(cfg.taskMinutes) : message;
      if (/timed out/.test(message)) void this.closeClient();
      this.failTask(task, reason, 'failed');
    }
  }

  private failTask(task: Task, reason: string, stop: string): void {
    if (this.task !== task) return;
    const review = this.reviewOf(task, stop, false);
    this.finishTask(task, 'failed', this.t.failed(task.id, task.dir, reason), 'oops', review);
  }

  private reviewOf(task: Task, stop: string, ok: boolean): TaskReview {
    const diffs = [...task.diffs].map(([path, text]) => ({ path, oldText: text.oldText, newText: text.newText }));
    const paths = [...new Set([...task.files, ...diffs.map((diff) => diff.path)])];
    const files = paths.map((path) => {
      const diff = diffs.find((item) => item.path === path);
      const stat = diff ? changedLines(diff.oldText, diff.newText) : { added: 0, removed: 0 };
      return { path, ...stat };
    });
    return {
      taskId: task.id,
      dir: task.dir,
      sessionId: task.sessionId,
      stop,
      ok,
      summary: task.summary.slice(-SUMMARY_MAX),
      files,
      commands: [...task.commands.values()],
      diffs,
    };
  }

  private finishTask(task: Task, kind: 'result' | 'failed', text: string, phase: 'done' | 'oops', review: TaskReview): void {
    if (this.task !== task) return;
    this.settleAuthorizedActions(task);
    this.task = null;
    this.review = review;
    if (task.stopTimer) clearTimeout(task.stopTimer);
    task.stopTimer = null;
    this.settlePermission(task, { outcome: 'cancelled' });
    const type = kind === 'result' ? 'opencode.result' : 'opencode.failed';
    void this.host?.pushEvent({
      type,
      source: this.id,
      senderKey: type,
      ts: nowIso(this.opts.timezone),
      text,
      meta: { taskId: task.id, sessionId: task.sessionId, dir: task.dir, stop: review.stop, files: review.files.map((file) => file.path) },
    }, { trigger: 'preempt' }).catch(() => undefined);
    this.guest({ show: true, state: phase, taskId: task.id });
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.guest({ show: false, taskId: task.id });
    }, GUEST_LINGER_MS);
    this.hideTimer.unref?.();
    this.scheduleIdleClose(task.client);
  }

  private scheduleIdleClose(client: AcpClient): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.task && this.client === client) void this.closeClient();
    }, CLIENT_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private guest(state: OpencodeGuestState): void {
    try {
      this.opts.onState?.(state);
    } catch {
      // the avatar is optional; a broken page must not stop the task
    }
  }

  /* ---------- ACP ---------- */

  private async ensureClient(dir: string): Promise<AcpClient> {
    const cfg = this.cfg();
    const command = this.opts.command ?? { command: cfg.bin, args: ['acp', '--cwd', dir] };
    const key = `${command.command}\u0000${command.args.join('\u0000')}`;
    if (this.client?.alive && this.clientKey === key) return this.client;
    await this.closeClient();
    if (this.starting) return this.starting;
    const env: NodeJS.ProcessEnv = {
      ...this.opts.env,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CLIENT: 'coopanion',
      ...(cfg.askSensitive ? { OPENCODE_PERMISSION: JSON.stringify(ASK_PERMISSIONS) } : {}),
    };
    const client = new AcpClient({
      command,
      cwd: dir,
      env,
      log: this.log ?? noopLogger,
      handlers: {
        onUpdate: (sessionId, update) => this.onUpdate(sessionId, update),
        onPermission: (request) => this.onPermission(request),
        readFile: (path) => this.readFile(path),
        writeFile: (path, content) => this.writeFile(path, content),
        onExit: (error) => this.onExit(client, error),
      },
    });
    this.client = client;
    this.clientKey = key;
    this.clientSession = null;
    this.starting = client.start().then(
      async () => {
        if (this.stopped) {
          await client.close().catch(() => undefined);
          throw new Error('opencode stopped');
        }
        return client;
      },
      async (error) => {
        if (this.client === client) {
          this.client = null;
          this.clientKey = '';
        }
        await client.close().catch(() => undefined);
        throw error;
      },
    ).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientKey = '';
    this.clientSession = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await client?.close().catch(() => undefined);
  }

  private onExit(client: AcpClient, error: Error | null): void {
    if (this.client !== client) return;
    this.client = null;
    this.clientKey = '';
    this.clientSession = null;
    if (this.task) {
      const task = this.task;
      const reason = error?.message ?? this.t.exited('0');
      this.failTask(task, reason, 'exited');
    }
  }

  private onUpdate(sessionId: string, update: AcpUpdate): void {
    const task = this.task;
    if (!task || task.sessionId !== sessionId) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === 'text' && typeof content.text === 'string') {
        task.summary = (task.summary + content.text).slice(-SUMMARY_MAX);
      }
      return;
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const tool = update as AcpToolCall;
    const activeAction = tool.toolCallId ? task.actions.get(tool.toolCallId) : undefined;
    if (activeAction && update.sessionUpdate === 'tool_call_update' && typeof tool.status === 'string') {
      if (activeAction.request.action === 'command-execution' && tool.status === 'completed') {
        const output = outputOf(tool);
        this.completeAuthorizedAction(task, activeAction, {
          phase: 'verified',
          dispatchState: 'delivered',
          outcome: 'remote-acknowledged',
          note: 'the ACP tool reported the command completed',
          evidence: { source: 'opencode-acp', status: 'completed', summary: 'command completion reported', ...(output ? { digest: sha256(output) } : {}), observedAt: Date.now() },
        });
      } else if (activeAction.request.action === 'command-execution' && ['failed', 'cancelled'].includes(tool.status)) {
        const output = outputOf(tool);
        this.completeAuthorizedAction(task, activeAction, {
          phase: 'unknown',
          dispatchState: 'delivered',
          outcome: 'unknown',
          note: `the ACP tool ended with status ${tool.status}`,
          evidence: { source: 'opencode-acp', status: tool.status, ...(output ? { digest: sha256(output) } : {}), observedAt: Date.now() },
        });
      } else if (activeAction.request.action === 'file-write' && !activeAction.consumed && ['completed', 'failed', 'cancelled'].includes(tool.status)) {
        this.completeAuthorizedAction(task, activeAction, {
          phase: 'unknown',
          dispatchState: 'delivered',
          outcome: 'unknown',
          note: 'the ACP edit ended without the guarded filesystem callback',
          evidence: { source: 'opencode-acp', status: tool.status, summary: 'no client filesystem write receipt was received', observedAt: Date.now() },
        });
      }
    }
    for (const location of tool.locations ?? []) if (typeof location.path === 'string') task.files.add(location.path);
    const raw = tool.rawInput;
    if (raw && typeof raw === 'object') {
      const input = raw as Record<string, unknown>;
      for (const key of ['filePath', 'path', 'filename']) if (typeof input[key] === 'string') task.files.add(input[key] as string);
    }
    const content = tool.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const diff = part as { type?: string; path?: string; oldText?: string; newText?: string };
        if (diff.type === 'diff' && typeof diff.path === 'string' && typeof diff.newText === 'string') {
          if (task.diffs.size >= FILES_MAX && !task.diffs.has(diff.path)) {
            const first = task.diffs.keys().next().value;
            if (first) task.diffs.delete(first);
          }
          task.diffs.set(diff.path, { oldText: typeof diff.oldText === 'string' ? diff.oldText : '', newText: diff.newText });
          task.files.add(diff.path);
        }
      }
    }
    const command = commandOf(tool);
    const commandId = tool.toolCallId ?? (command ? `command-${task.commands.size}` : '');
    if (commandId && (command || task.commands.has(commandId))) {
      if (task.commands.size >= COMMANDS_MAX && !task.commands.has(commandId)) {
        const first = task.commands.keys().next().value;
        if (first) task.commands.delete(first);
      }
      const current = task.commands.get(commandId) ?? { command, status: '', output: '' };
      if (command) current.command = command;
      if (typeof tool.status === 'string') current.status = tool.status;
      const output = outputOf(tool);
      if (output) current.output = output.slice(-COMMAND_OUTPUT_MAX);
      if (current.command) task.commands.set(commandId, current);
    }
    if (task.files.size > FILES_MAX) {
      const keep = [...task.files].slice(-FILES_MAX);
      task.files.clear();
      for (const file of keep) task.files.add(file);
    }
  }

  private fileTarget(task: Task, path: string, instanceId: string): { target: OpencodeFileTargetEvidence; absolutePath: string } | null {
    try {
      const absolutePath = this.checkedPath(task.dir, path);
      if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) return null;
      const filePath = relative(task.dir, absolutePath).replace(/\\/g, '/');
      if (!filePath || filePath === '..' || filePath.startsWith('../')) return null;
      const snapshotId = existsSync(absolutePath) ? sha256(readFileSync(absolutePath)) : sha256('absent');
      return {
        absolutePath,
        target: {
          surface: 'filesystem',
          instanceId,
          workspaceRoot: realpathSync(task.dir),
          path: filePath,
          operation: 'file-write',
          snapshotId,
          source: 'opencode-acp',
        },
      };
    } catch {
      return null;
    }
  }

  private permissionAction(task: Task, request: AcpPermissionRequest, permissionId: string): OpencodeActionRequest | null {
    const tool = request.toolCall ?? {};
    const input = tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput as Record<string, unknown> : {};
    const rawPayload = JSON.stringify([tool.kind ?? '', tool.title ?? '', tool.rawInput ?? null, tool.locations ?? []]);
    const payloadDigest = sha256(rawPayload);
    const actionName = tool.title || `OpenCode ${tool.kind || 'workspace'} action`;
    const details = this.permissionDetail(tool);
    const command = commandOf(tool);
    if (tool.kind === 'execute' || command) {
      if (!command) return null;
      const instanceId = `${task.id}:${tool.toolCallId ?? permissionId}`;
      return {
        taskId: `${task.id}:${tool.toolCallId ?? permissionId}`,
        taskText: `Run this command once in ${task.dir}:\n${details || command}`,
        actionName,
        expectedChange: `execute ${command}`,
        payloadDigest,
        risk: 'IRREVERSIBLE_OR_PUBLIC',
        target: {
          surface: 'filesystem',
          instanceId,
          workspaceRoot: realpathSync(task.dir),
          path: '.',
          operation: 'command-execution',
          snapshotId: sha256(JSON.stringify([task.dir, task.startedAt, tool.toolCallId ?? permissionId])),
          source: 'opencode-acp',
        },
        action: 'command-execution',
        files: [],
        expiresInMs: 30_000,
        maxSteps: 1,
      };
    }

    const paths = new Set<string>();
    for (const location of tool.locations ?? []) if (typeof location.path === 'string' && location.path.trim()) paths.add(location.path);
    for (const key of ['filePath', 'path', 'filename']) if (typeof input[key] === 'string' && input[key].trim()) paths.add(input[key] as string);
    if (tool.kind !== 'edit' && paths.size === 0) return null;
    if (paths.size !== 1) return null;
    const path = [...paths][0]!;
    const instanceId = `${task.id}:${tool.toolCallId ?? permissionId}`;
    const file = this.fileTarget(task, path, instanceId);
    if (!file) return null;
    const newText = [input.content, input.newText, input.new_string]
      .find((value): value is string => typeof value === 'string');
    const files = newText === undefined ? [] : [{
      path: file.target.path,
      digest: sha256(newText),
      bytes: Buffer.byteLength(newText),
      mime: 'text/plain',
    }];
    return {
      taskId: `${task.id}:${tool.toolCallId ?? permissionId}`,
      taskText: `Write one file in ${task.dir}:\n${details || file.target.path}`,
      actionName,
      expectedChange: `write ${file.target.path}; ACP request sha256:${payloadDigest}`,
      payloadDigest,
      risk: 'REVERSIBLE_LOCAL',
      target: file.target,
      action: 'file-write',
      files,
      expiresInMs: 30_000,
      maxSteps: 1,
    };
  }

  private async authorizedPermission(task: Task, request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const id = `p${++this.permissionSeq}`;
    let resolve!: (outcome: AcpPermissionOutcome) => void;
    const pendingPromise = new Promise<AcpPermissionOutcome>((done) => { resolve = done; });
    const timer = setTimeout(() => {
      if (task.permission?.id !== id) return;
      task.permission = null;
      resolve({ outcome: 'cancelled' });
      this.failTask(task, this.t.permissionTimeout(this.cfg().permissionMinutes), 'permission-timeout');
      void this.closeClient();
    }, this.cfg().permissionMinutes * 60_000);
    timer.unref?.();
    const pending = { id, request, resolve, timer };
    task.permission = pending;
    this.guest({ show: true, state: 'wait', taskId: task.id });

    const actionRequest = this.permissionAction(task, request, id);
    if (!actionRequest) {
      this.settlePermission(task, { outcome: 'cancelled' });
      return pendingPromise;
    }
    if (actionRequest.action === 'file-write' && actionRequest.files.length === 0) {
      // ACP sends the file body through fs/write_text_file; Core approves that exact payload there.
      const option = (request.options ?? []).find((candidate) => candidate.kind === 'allow_once');
      if (!option) this.settlePermission(task, { outcome: 'cancelled' });
      else this.settlePermission(task, { outcome: 'selected', optionId: option.optionId });
      return pendingPromise;
    }
    void this.opts.authorizeAction!(actionRequest, async () => this.opts.confirmAction?.(actionRequest) ?? false).then((authorization) => {
      if (task.permission !== pending || this.task !== task) {
        authorization?.revoke();
        return;
      }
      if (!authorization) {
        this.settlePermission(task, { outcome: 'cancelled' });
        this.guest({ show: true, state: 'work', taskId: task.id });
        return;
      }
      const option = (request.options ?? []).find((candidate) => candidate.kind === 'allow_once');
      if (!option) {
        authorization.revoke();
        this.settlePermission(task, { outcome: 'cancelled' });
        this.guest({ show: true, state: 'work', taskId: task.id });
        return;
      }
      const toolCallId = request.toolCall?.toolCallId ?? id;
      const active: AuthorizedAction = { toolCallId, request: actionRequest, authorization, consumed: false };
      if (actionRequest.action === 'command-execution') {
        const consumed = authorization.consume(actionRequest.target, actionRequest.expectedChange, actionRequest.files);
        if (!consumed) {
          authorization.revoke();
          this.settlePermission(task, { outcome: 'cancelled' });
          this.guest({ show: true, state: 'work', taskId: task.id });
          return;
        }
        active.consumed = true;
        authorization.complete({
          phase: 'acting', dispatchState: 'delivered', outcome: 'delivered',
          note: 'the authorized ACP command was dispatched',
          evidence: { source: 'opencode-acp', status: 'dispatched', digest: actionRequest.payloadDigest, observedAt: Date.now() },
        });
      }
      task.actions.set(toolCallId, active);
      this.settlePermission(task, { outcome: 'selected', optionId: option.optionId });
      this.guest({ show: true, state: 'work', taskId: task.id });
    }).catch((error) => {
      this.log?.warn(`Core authorization failed: ${error instanceof Error ? error.message : String(error)}`);
      if (task.permission === pending) this.settlePermission(task, { outcome: 'cancelled' });
    });
    return pendingPromise;
  }

  private completeAuthorizedAction(task: Task, action: AuthorizedAction, result: OpencodeActionCompletion): void {
    try { action.authorization.complete(result); }
    catch (error) { this.log?.warn(`Could not save action receipt: ${error instanceof Error ? error.message : String(error)}`); }
    task.actions.delete(action.toolCallId);
  }

  private settleAuthorizedActions(task: Task): void {
    for (const action of [...task.actions.values()]) {
      if (!action.consumed) {
        action.authorization.revoke();
        task.actions.delete(action.toolCallId);
        continue;
      }
      this.completeAuthorizedAction(task, action, {
        phase: 'unknown',
        dispatchState: 'delivered',
        outcome: 'unknown',
        note: 'the task ended before the ACP action result was received',
        evidence: { source: 'opencode-acp', status: 'interrupted', observedAt: Date.now() },
      });
    }
  }

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const task = this.task;
    if (!task || task.sessionId !== request.sessionId) return { outcome: 'cancelled' };
    if (this.opts.authorizeAction) return this.authorizedPermission(task, request);
    if (task.permission) this.settlePermission(task, { outcome: 'cancelled' });
    const id = `p${++this.permissionSeq}`;
    const tool = request.toolCall ?? {};
    const title = tool.title ?? '(no title)';
    const kind = tool.kind ?? '';
    const detail = this.permissionDetail(tool);
    const options = request.options ?? [];
    const text = this.t.permission(task.id, task.dir, title, kind, detail, options);
    this.guest({ show: true, state: 'wait', taskId: task.id });
    void this.host?.pushEvent({
      type: 'opencode.permission',
      source: this.id,
      senderKey: 'opencode.permission',
      ts: nowIso(this.opts.timezone),
      text,
      meta: {
        taskId: task.id, sessionId: task.sessionId, dir: task.dir, permissionId: id,
        tool: { title, kind, input: tool.rawInput, locations: tool.locations ?? [] },
        options,
      },
    }, { trigger: 'preempt' }).catch(() => undefined);
    return new Promise((resolve) => {
      const cfg = this.cfg();
      const timer = setTimeout(() => {
        if (task.permission?.id !== id) return;
        task.permission = null;
        resolve({ outcome: 'cancelled' });
        this.failTask(task, this.t.permissionTimeout(cfg.permissionMinutes), 'permission-timeout');
        void this.closeClient();
      }, cfg.permissionMinutes * 60_000);
      timer.unref?.();
      task.permission = { id, request: { ...request, options }, resolve, timer };
    });
  }

  private permissionDetail(tool: AcpToolCall): string {
    let detail = '';
    if (tool.rawInput !== undefined) {
      try {
        detail = JSON.stringify(tool.rawInput, null, 2);
      } catch {
        detail = String(tool.rawInput);
      }
    }
    const locations = (tool.locations ?? []).map((l) => l.path).filter((p): p is string => typeof p === 'string');
    if (locations.length) detail = `${detail}${detail ? '\n' : ''}paths: ${locations.join(', ')}`;
    return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
  }

  private settlePermission(task: Task, outcome: AcpPermissionOutcome): void {
    const pending = task.permission;
    if (!pending) return;
    task.permission = null;
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  private readFile(path: string): Promise<string> {
    const task = this.task;
    if (!task) return Promise.reject(new Error('no opencode task'));
    const target = this.checkedPath(task.dir, path);
    return Promise.resolve(readFileSync(target, 'utf8'));
  }

  private fileWriteAction(task: Task, path: string, content: string, instanceId: string): OpencodeActionRequest | null {
    const file = this.fileTarget(task, path, instanceId);
    if (!file) return null;
    const digest = sha256(content);
    const bytes = Buffer.byteLength(content);
    const payloadDigest = sha256(JSON.stringify([file.target.path, digest, bytes]));
    return {
      taskId: `${task.id}:fs-write:${++this.permissionSeq}`,
      taskText: `Write ${file.target.path} in ${task.dir}. Content SHA-256: ${digest}; ${bytes} bytes.`,
      actionName: 'OpenCode file write',
      expectedChange: `write ${file.target.path} sha256:${digest}`,
      payloadDigest,
      risk: 'REVERSIBLE_LOCAL',
      target: file.target,
      action: 'file-write',
      files: [{ path: file.target.path, digest, bytes, mime: 'text/plain' }],
      expiresInMs: 30_000,
      maxSteps: 1,
    };
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const task = this.task;
    if (!task) throw new Error('no opencode task');
    const target = this.checkedPath(task.dir, path);
    const relativePath = relative(task.dir, target).replace(/\\/g, '/');
    let action = [...task.actions.values()].find((candidate) => candidate.request.action === 'file-write'
      && candidate.request.target.path === relativePath && !candidate.consumed);
    if (this.opts.authorizeAction && action && action.request.files.length !== 1) {
      action.authorization.revoke();
      task.actions.delete(action.toolCallId);
      action = undefined;
    }
    if (this.opts.authorizeAction && !action) {
      const request = this.fileWriteAction(task, target, content, `${task.id}:fs-write`);
      if (!request) throw new Error('the file target is outside the authorized workspace');
      const authorization = await this.opts.authorizeAction(request, async () => this.opts.confirmAction?.(request) ?? false);
      if (!authorization || this.task !== task) {
        authorization?.revoke();
        throw new Error('Core did not authorize this file write');
      }
      action = { toolCallId: request.taskId, request, authorization, consumed: false };
      task.actions.set(action.toolCallId, action);
    }

    if (this.opts.authorizeAction && !action) throw new Error('no Core file-write authorization is available');
    const exactDigest = sha256(content);
    if (action?.request.files.length) {
      const expected = action.request.files[0];
      if (action.request.files.length !== 1 || expected?.path !== relativePath || expected.digest !== exactDigest
        || expected.bytes !== Buffer.byteLength(content)) {
        action.authorization.revoke();
        task.actions.delete(action.toolCallId);
        throw new Error('the file content differs from the approved payload');
      }
    }
    const current = this.fileTarget(task, target, action?.request.target.instanceId ?? `${task.id}:fs-write`);
    if (!current) {
      action?.authorization.revoke();
      if (action) task.actions.delete(action.toolCallId);
      throw new Error('the file target is no longer available');
    }
    if (action) {
      if (!action.authorization.consume(current.target, action.request.expectedChange, action.request.files)) {
        action.authorization.revoke();
        task.actions.delete(action.toolCallId);
        throw new Error('the workspace target changed before file dispatch');
      }
      action.consumed = true;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      const parent = realpathSync(dirname(target));
      if (!insideRoot([task.dir], parent)) throw new Error('path is outside the task directory');
      writeFileSync(target, content, 'utf8');
      const saved = readFileSync(target);
      const digest = sha256(saved);
      if (digest !== exactDigest) throw new Error('the file read-back did not match the approved content');
      if (action) this.completeAuthorizedAction(task, action, {
        phase: 'verified',
        dispatchState: 'delivered',
        outcome: 'ui-observed',
        note: 'the ACP workspace file matched the approved content after write',
        evidence: { source: 'opencode-acp-file-readback', status: 'matched', digest, observedAt: Date.now() },
      });
    } catch (error) {
      if (action) this.completeAuthorizedAction(task, action, {
        phase: 'unknown',
        dispatchState: 'delivered',
        outcome: 'unknown',
        note: `the file result could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'opencode-acp-file-write', status: 'unknown', digest: exactDigest, observedAt: Date.now() },
      });
      throw error;
    }
  }

  private checkedPath(root: string, path: string): string {
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (!insideRoot([root], target)) throw new Error('path is outside the task directory');
    if (existsSync(target)) {
      const real = realpathSync(target);
      if (!insideRoot([root], real)) throw new Error('path is outside the task directory');
      return target;
    }
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('path has no existing workspace parent');
      ancestor = parent;
    }
    const realAncestor = realpathSync(ancestor);
    if (!insideRoot([root], realAncestor)) throw new Error('path is outside the task directory');
    return target;
  }

  /* ---------- tools ---------- */

  private answer(args: Record<string, unknown>): ToolOutcome {
    const t = this.t;
    const task = this.task;
    if (!task) return { text: t.noTask, failed: true };
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    if (task.id !== taskId) return { text: t.stopNoMatch(taskId), failed: true };
    const pending = task.permission;
    if (!pending) return { text: t.noPermission, failed: true };
    const choice = args.choice;
    if (choice !== 'once' && choice !== 'always' && choice !== 'reject') return { text: t.badChoice, failed: true };
    const wanted = choice === 'once' ? ['allow_once'] : choice === 'always' ? ['allow_always'] : ['reject_once', 'reject_always'];
    const option = (pending.request.options ?? []).find((o) => wanted.includes(o.kind));
    if (!option) return { text: t.permissionGone, failed: true };
    this.settlePermission(task, { outcome: 'selected', optionId: option.optionId });
    this.guest({ show: true, state: 'work', taskId: task.id });
    return { text: t.answered(choice) };
  }

  private stopTask(args: Record<string, unknown>): ToolOutcome {
    const t = this.t;
    const task = this.task;
    if (!task) return { text: t.noTask };
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    if (taskId && taskId !== task.id) return { text: t.stopNoMatch(taskId), failed: true };
    this.settlePermission(task, { outcome: 'cancelled' });
    task.client.cancel(task.sessionId);
    if (task.stopTimer) clearTimeout(task.stopTimer);
    task.stopTimer = setTimeout(() => {
      if (this.task !== task) return;
      this.failTask(task, t.stopTimeout(task.id), 'stop-timeout');
      void this.closeClient();
    }, STOP_GRACE_MS);
    task.stopTimer.unref?.();
    return { text: t.stopped(task.id) };
  }

  private reviewTool(args: Record<string, unknown>): ToolOutcome {
    const review = this.review;
    if (!review) return { text: this.t.noReview, failed: true };
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
    if (taskId && taskId !== review.taskId) return { text: this.t.reviewMismatch(taskId, review.taskId), failed: true };
    return { text: this.t.review(review, args.diff === true) };
  }

  private status(): ToolOutcome {
    const task = this.task;
    if (!task) return { text: this.t.statusIdle };
    return { text: this.t.statusTask(task.id, task.dir, new Date(task.startedAt).toISOString(), !!task.permission) };
  }
}

/** The command a tool call ran, when it is a shell command. */
function commandOf(tool: AcpToolCall): string {
  const raw = tool.rawInput;
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    const input = raw as Record<string, unknown>;
    if (typeof input.command === 'string') return input.command.trim();
    if (Array.isArray(input.commands)) return input.commands.filter((item): item is string => typeof item === 'string').join('\n').trim();
  }
  return tool.kind === 'execute' && typeof tool.title === 'string' ? tool.title.trim() : '';
}

/** The tail of a tool call's output; the ACP content text or the raw output. */
function outputOf(tool: AcpToolCall): string {
  const raw = tool.rawOutput;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const output = raw as Record<string, unknown>;
    if (typeof output.output === 'string') return output.output;
    if (typeof output.stdout === 'string') return output.stdout;
  }
  if (!Array.isArray(tool.content)) return '';
  const texts: string[] = [];
  for (const part of tool.content) {
    if (!part || typeof part !== 'object') continue;
    const content = part as { type?: string; content?: { type?: string; text?: string } };
    if (content.type === 'content' && content.content?.type === 'text' && typeof content.content.text === 'string') texts.push(content.content.text);
  }
  return texts.join('\n');
}

/** Lines added and removed between two texts, by a line LCS; large pairs count as whole-file changes. */
function changedLines(oldText: string, newText: string): { added: number; removed: number } {
  const before = oldText ? oldText.split('\n') : [];
  const after = newText ? newText.split('\n') : [];
  if (before.length * after.length > 4_000_000) return { added: after.length, removed: before.length };
  const row = new Array<number>(after.length + 1).fill(0);
  for (let i = 1; i <= before.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= after.length; j++) {
      const previous = row[j]!;
      row[j] = before[i - 1] === after[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
      diagonal = previous;
    }
  }
  const common = row[after.length]!;
  return { added: after.length - common, removed: before.length - common };
}
