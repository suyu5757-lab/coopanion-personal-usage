/**
 * opencode as a World. A task starts an `opencode acp` child in one of the person's allowed
 * directories, sends one prompt and returns at once. Every file write and command it asks to run
 * is a permission request the bot relays to the person with the original input unchanged; the
 * turn ends with an event. The World also tells the app which avatar state to show.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
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
}

interface PermissionPending {
  id: string;
  request: AcpPermissionRequest;
  resolve: (outcome: AcpPermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

interface Task {
  id: string;
  dir: string;
  sessionId: string;
  text: string;
  startedAt: number;
  client: AcpClient;
  permission: PermissionPending | null;
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
    return {
      'opencode.roots': this.t.roots(roots),
      'opencode.task': String(cfg.taskMinutes),
      'opencode.permission': String(cfg.permissionMinutes),
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
    return OPENCODE_TOOL_DECLS.map((decl) => {
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

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const task = this.task;
    if (!task || task.sessionId !== request.sessionId) return { outcome: 'cancelled' };
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

  private async writeFile(path: string, content: string): Promise<void> {
    const task = this.task;
    if (!task) throw new Error('no opencode task');
    const target = this.checkedPath(task.dir, path);
    mkdirSync(dirname(target), { recursive: true });
    const parent = realpathSync(dirname(target));
    if (!insideRoot([task.dir], parent)) throw new Error('path is outside the task directory');
    writeFileSync(target, content, 'utf8');
  }

  private checkedPath(root: string, path: string): string {
    const target = resolve(path);
    if (!insideRoot([root], target)) throw new Error('path is outside the task directory');
    if (existsSync(target)) {
      const real = realpathSync(target);
      if (!insideRoot([root], real)) throw new Error('path is outside the task directory');
    }
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
