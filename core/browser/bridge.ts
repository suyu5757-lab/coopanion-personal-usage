/**
 * The browser World's line to the Electron main process. The Core child sends a
 * `companion:browser` message and the main answers with `companion:browser-result`, relayed by
 * app/core-host.cjs; a window closed by the person arrives as `companion:browser-event`.
 *
 * Tests hand the World a fake transport instead, so the tools run without Electron.
 */
export interface BrowserTransport {
  call(op: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  onEvent(listener: (event: 'closed') => void): () => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Calls time out here as well; the main process has its own, shorter, page deadlines. */
const CALL_TIMEOUT_MS = 60_000;

export class BrowserBridge implements BrowserTransport {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: 'closed') => void>();
  private readonly onMessage = (message: unknown): void => {
    const msg = message as { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string; event?: string };
    if (msg?.type === 'companion:browser-result' && typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.settle(msg.id, pending);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error || 'browser operation failed'));
      return;
    }
    if (msg?.type === 'companion:browser-event' && msg.event === 'closed') {
      for (const listener of this.listeners) listener('closed');
    }
  };

  constructor() {
    process.on('message', this.onMessage);
  }

  call(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (!process.send) return Promise.reject(new Error('browser is only available in the app'));
    const send = (message: object) => process.send!(message);
    if (signal?.aborted) return Promise.reject(new Error('interrupted'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.settle(id, pending);
        reject(new Error(`${op} timed out`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.settle(id, pending);
        reject(new Error('interrupted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, timer, ...(signal ? { signal, abort } : {}) });
      try {
        const sent = send({ type: 'companion:browser', id, op, ...args });
        if (!sent) {
          const pending = this.pending.get(id);
          if (pending) this.settle(id, pending);
          reject(new Error('the app process is not listening'));
        }
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) this.settle(id, pending);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(listener: (event: 'closed') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Refuses what is in flight and stops listening; the Core is going away. */
  close(): void {
    process.off('message', this.onMessage);
    for (const [id, pending] of this.pending) {
      this.settle(id, pending);
      pending.reject(new Error('browser bridge closed'));
    }
    this.listeners.clear();
  }

  private settle(id: number, pending: Pending): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort);
    this.pending.delete(id);
  }
}
