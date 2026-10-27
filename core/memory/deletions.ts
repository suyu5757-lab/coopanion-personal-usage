/**
 * Durable remote-deletion tasks. A forget request cancels queued writes locally, then records
 * which source documents must be removed from which bank. The queue survives restarts and an
 * offline service; the receipt comes from the task state, not from a local cancellation count.
 */
import { randomUUID } from 'node:crypto';
import { readState, writeState } from '../state-file.ts';

export type DeletionState = 'pending' | 'done' | 'failed';

export interface DeletionTask {
  id: string;
  bankId: string;
  endpoint: string;
  documentId: string;
  /** Present when the source may still have an in-flight retain operation. */
  operationId?: string;
  reason: string;
  state: DeletionState;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeletionStatus {
  pending: number;
  done: number;
  failed: number;
  persistenceError: string | null;
}

export interface DeletionLog {
  warn(message: string, data?: unknown): void;
}

export class DeletionQueue {
  private tasks: DeletionTask[] = [];
  private loaded = false;
  private persistenceError: string | null = null;

  constructor(
    private readonly file: string,
    private readonly opts: { now?: () => Date; log?: DeletionLog } = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved = readState(this.file, (value) => {
        if (!Array.isArray(value)) throw new Error('not an array');
        return value.filter((entry): entry is DeletionTask => !!entry && typeof entry === 'object' && typeof (entry as DeletionTask).id === 'string');
      });
      this.tasks = saved ?? [];
    } catch (err) {
      this.persistenceError = `could not read deletion tasks: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log?.warn('[memory] could not read deletion tasks', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private persist(): boolean {
    try {
      writeState(this.file, `${JSON.stringify(this.tasks, null, 2)}\n`);
      this.persistenceError = null;
      return true;
    } catch (err) {
      this.persistenceError = `could not write deletion tasks: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log?.warn('[memory] could not write deletion tasks', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Record a deletion before a remote call; an existing open task for the same source is reused. */
  add(input: Omit<DeletionTask, 'id' | 'state' | 'attempts' | 'nextAttemptAt' | 'createdAt' | 'updatedAt'>): DeletionTask | null {
    this.load();
    const existing = this.tasks.find((task) =>
      task.bankId === input.bankId
      && task.endpoint === input.endpoint
      && task.documentId === input.documentId
      && task.state !== 'done');
    if (existing) return existing;
    const at = this.now().toISOString();
    const task: DeletionTask = {
      ...input,
      id: randomUUID(),
      state: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    };
    const before = this.tasks;
    this.tasks = [...this.tasks, task];
    if (!this.persist()) {
      this.tasks = before;
      return null;
    }
    return task;
  }

  due(now: Date, limit: number, target?: { bankId: string; endpoint: string }): DeletionTask[] {
    this.load();
    return this.tasks
      .filter((task) => (task.state === 'pending' || task.state === 'failed') && Date.parse(task.nextAttemptAt) <= now.getTime())
      .filter((task) => !target || (task.bankId === target.bankId && task.endpoint === target.endpoint))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));
  }

  get(id: string): DeletionTask | null {
    this.load();
    return this.tasks.find((task) => task.id === id) ?? null;
  }

  markDone(id: string): boolean {
    this.load();
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    const before = this.tasks;
    this.tasks = this.tasks.map((task, at) => at === index
      ? { ...task, state: 'done', lastError: undefined, updatedAt: this.now().toISOString() }
      : task);
    if (!this.persist()) {
      this.tasks = before;
      return false;
    }
    return true;
  }

  markFailed(id: string, error: string): boolean {
    this.load();
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    const before = this.tasks;
    this.tasks = this.tasks.map((task, at) => {
      if (at !== index) return task;
      const attempts = task.attempts + 1;
      const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempts, 7));
      return {
        ...task,
        state: 'failed',
        attempts,
        nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
        lastError: error.slice(0, 300),
        updatedAt: this.now().toISOString(),
      };
    });
    if (!this.persist()) {
      this.tasks = before;
      return false;
    }
    return true;
  }

  status(): DeletionStatus {
    this.load();
    const status: DeletionStatus = { pending: 0, done: 0, failed: 0, persistenceError: this.persistenceError };
    for (const task of this.tasks) {
      if (task.state === 'pending') status.pending += 1;
      else if (task.state === 'failed') status.failed += 1;
      else status.done += 1;
    }
    return status;
  }

  /** The whole bank is gone, so its deletion tasks have nothing left to remove. */
  clearTarget(bankId: string, endpoint: string): boolean {
    this.load();
    const before = this.tasks;
    const at = this.now().toISOString();
    this.tasks = this.tasks.map((task) => task.bankId === bankId && task.endpoint === endpoint && task.state !== 'done'
      ? { ...task, state: 'done', lastError: undefined, updatedAt: at }
      : task);
    if (!this.persist()) {
      this.tasks = before;
      return false;
    }
    return true;
  }

  /** How a specific set of tasks ended, for the forget receipt. */
  outcome(ids: readonly string[]): { done: number; pending: number; failed: number } {
    this.load();
    const out = { done: 0, pending: 0, failed: 0 };
    for (const id of ids) {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (!task) continue;
      if (task.state === 'done') out.done += 1;
      else if (task.state === 'failed') out.failed += 1;
      else out.pending += 1;
    }
    return out;
  }
}
