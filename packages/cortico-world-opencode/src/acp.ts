/**
 * The line to `opencode acp`: newline-delimited JSON-RPC 2.0 over a child's stdio.
 * This client owns the protocol; the World decides what a permission means and which paths are writable.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'cortico/core/types.ts';

export interface AcpCommand {
  command: string;
  args: string[];
}

export interface AcpInitialize {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string };
}

export interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string; line?: number }>;
  content?: unknown;
}

export interface AcpUpdate {
  sessionUpdate?: string;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: AcpToolCall;
  options: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpHandlers {
  onUpdate(sessionId: string, update: AcpUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  onExit?(error: Error | null): void;
}

export interface AcpClientOptions {
  command: AcpCommand;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  handlers: AcpHandlers;
  log: Logger;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const INIT_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 60_000;

export class AcpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private starting: Promise<AcpInitialize> | null = null;
  private init: AcpInitialize | null = null;

  constructor(private readonly opts: AcpClientOptions) {}

  get info(): AcpInitialize | null {
    return this.init;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  start(): Promise<AcpInitialize> {
    this.starting ??= this.spawnAndInitialize();
    return this.starting;
  }

  async newSession(cwd: string): Promise<string> {
    const result = await this.request('session/new', { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS) as { sessionId?: string } | null;
    if (!result?.sessionId) throw new Error('opencode acp did not return a session id');
    return result.sessionId;
  }

  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    await this.request('session/resume', { sessionId, cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
  }

  prompt(sessionId: string, text: string, timeoutMs: number): Promise<{ stopReason?: string }> {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs) as Promise<{ stopReason?: string }>;
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      child.kill();
      setTimeout(() => {
        if (child.exitCode === null && child.pid) {
          if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          else child.kill('SIGKILL');
        }
        resolve();
      }, 3000).unref();
    });
  }

  private async spawnAndInitialize(): Promise<AcpInitialize> {
    const { command, args } = this.opts.command;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) this.opts.log.debug(line.slice(0, 500));
    });
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => {
      const reason = code === 0 ? 'opencode acp exited' : `opencode acp exited (${code ?? signal ?? '?'})`;
      const error = new Error(reason);
      this.failAll(error);
      if (this.child === child) this.child = null;
      this.opts.handlers.onExit?.(code === 0 ? null : error);
    });
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'coopanion', title: 'Coopanion', version: process.env.COOPANION_VERSION ?? 'dev' },
    }, INIT_TIMEOUT_MS) as AcpInitialize | null;
    if (!init || init.protocolVersion !== 1) {
      const error = new Error(`unsupported ACP protocol version ${String(init?.protocolVersion)}`);
      await this.close();
      throw error;
    }
    this.init = init;
    return init;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.opts.log.debug(`acp: unreadable line ${line.slice(0, 200)}`);
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = message.id;
    if (id !== undefined && typeof message.method === 'string') {
      void this.onRequest(id, message.method, message.params);
      return;
    }
    if (id !== undefined) {
      this.onResponse(id, message);
      return;
    }
    if (typeof message.method === 'string') this.onNotification(message.method, message.params);
  }

  private onResponse(id: unknown, message: Record<string, unknown>): void {
    const key = typeof id === 'number' ? id : Number(id);
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as { message?: string };
      pending.reject(new Error(error.message || `acp ${pending.method} failed`));
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      this.opts.log.debug(`acp: ${method}`);
      return;
    }
    const p = params as { sessionId?: string; update?: AcpUpdate } | null;
    if (p?.sessionId && p.update && typeof p.update === 'object') this.opts.handlers.onUpdate(p.sessionId, p.update);
  }

  private async onRequest(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      if (method === 'session/request_permission') {
        const request = params as AcpPermissionRequest;
        const outcome = await this.opts.handlers.onPermission(request);
        this.respond(id, { outcome });
        return;
      }
      if (method === 'fs/read_text_file') {
        const p = params as { path?: string };
        if (typeof p?.path !== 'string') throw new Error('fs/read_text_file without a path');
        this.respond(id, { content: await this.opts.handlers.readFile(p.path) });
        return;
      }
      if (method === 'fs/write_text_file') {
        const p = params as { path?: string; content?: string };
        if (typeof p?.path !== 'string' || typeof p.content !== 'string') throw new Error('fs/write_text_file without path or content');
        await this.opts.handlers.writeFile(p.path, p.content);
        this.respond(id, null);
        return;
      }
      this.respondError(id, -32601, `client does not implement ${method}`);
    } catch (error) {
      this.respondError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error('opencode acp is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private respond(id: unknown, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: unknown, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private send(message: unknown): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
