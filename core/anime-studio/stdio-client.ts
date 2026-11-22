/**
 * Minimal newline-delimited JSON-RPC 2.0 stdio client for local MCP servers.
 * Keeps one lazy child process alive across calls, auto-reconnects on unexpected exit,
 * and enforces per-call timeouts so long-running local services never wedge Core.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface McpStdioConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpToolCallResult {
  text: string;
  isError: boolean;
  structured?: unknown;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  private stdoutBuf = '';
  private stderrTail = '';
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly getConfig: () => McpStdioConfig) {}

  private failAll(reason: Error): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(reason);
      this.pending.delete(id);
    }
  }

  private teardown(reason?: Error): void {
    const proc = this.child;
    this.child = null;
    this.readyPromise = null;
    this.stdoutBuf = '';
    if (reason) this.failAll(reason);
    if (proc && !proc.killed) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : null;
    if (id === null) return;
    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    clearTimeout(req.timer);
    if (msg.error && typeof msg.error === 'object') {
      const errObj = msg.error as { message?: unknown; code?: unknown };
      req.reject(new Error(`MCP error (${String(errObj.code ?? 'unknown')}): ${String(errObj.message ?? 'request failed')}`));
      return;
    }
    req.resolve(msg.result);
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('MCP stdio process is not running');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
  }

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.child && this.readyPromise) {
      return this.readyPromise;
    }
    const cfg = this.getConfig();
    if (!cfg.command) throw new Error('MCP server command is not configured');

    this.stderrTail = '';
    const child = spawn(cfg.command, cfg.args, {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stdoutBuf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.stdoutBuf += chunk;
      let idx = this.stdoutBuf.indexOf('\n');
      while (idx !== -1) {
        const line = this.stdoutBuf.slice(0, idx);
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        this.handleLine(line);
        idx = this.stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-1200);
    });

    child.on('error', (err) => {
      if (this.child === child) {
        this.teardown(new Error(`MCP process error: ${err.message}`));
      }
    });

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        const detail = this.stderrTail.trim() ? ` (${this.stderrTail.trim().slice(-240)})` : '';
        this.teardown(new Error(`MCP process exited (code=${String(code)}, signal=${String(signal)})${detail}`));
      }
    });

    const timeoutMs = Math.max(5_000, Math.min(cfg.timeoutMs ?? 60_000, 30_000));
    this.readyPromise = (async () => {
      try {
        await this.sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'coopanion-anime-studio', version: '1.0.0' },
        }, timeoutMs);
        this.sendRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
      } catch (err) {
        this.teardown(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    })();

    return this.readyPromise;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMsOverride?: number): Promise<McpToolCallResult> {
    await this.ensureReady();
    const timeoutMs = timeoutMsOverride ?? this.getConfig().timeoutMs ?? 60_000;
    const raw = await this.sendRequest('tools/call', { name, arguments: args }, timeoutMs) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    } | null;

    const parts = Array.isArray(raw?.content)
      ? raw!.content
          .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text as string)
      : [];
    const text = parts.length > 0
      ? parts.join('\n')
      : JSON.stringify(raw?.structuredContent ?? raw ?? {}, null, 2);

    return {
      text,
      isError: raw?.isError === true,
      structured: raw?.structuredContent,
    };
  }

  async close(): Promise<void> {
    this.teardown(new Error('MCP client closed'));
  }
}
