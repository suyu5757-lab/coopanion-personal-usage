/**
 * The durable record of forgetting. A fenced source is kept out of every read, its removal from
 * the service is tracked to a terminal state, and portraits derived from it stay blocked until
 * they have been rebuilt without it. The fence, the tasks and the derived state share one atomic
 * write, so a restart cannot see a fence without the work it implies.
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
  /**
   * Deletions already repeated after the source's retain operation was in flight. The first
   * success only closes that attempt: the document is deleted once more after the window.
   */
  verifications: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForgetTombstone {
  bankId: string;
  endpoint: string;
  documentId: string;
  reason: string;
  at: string;
}

export interface DeletionStatus {
  pending: number;
  done: number;
  failed: number;
  /** Sources that stay out of every read for as long as the ledger lives. */
  tombstones: number;
  /** Banks whose portraits have not been rebuilt since the last fence. */
  staleTargets: number;
  persistenceError: string | null;
}

export interface DeletionLog {
  warn(message: string, data?: unknown): void;
}

export type DeletionInput = Omit<DeletionTask, 'id' | 'state' | 'attempts' | 'verifications' | 'nextAttemptAt' | 'createdAt' | 'updatedAt'>;

interface LedgerFile {
  v: 2;
  tasks: DeletionTask[];
  tombstones: ForgetTombstone[];
  epochs: Record<string, number>;
  /** Target keys whose mental models may still contain a fenced source. */
  stale: string[];
}

/** A retain that was already in flight when the person forgot it can land after the delete. */
export const VERIFY_DELAY_MS = 10 * 60_000;

const key = (bankId: string, endpoint: string): string => JSON.stringify([bankId, endpoint]);

function isTask(value: unknown): value is DeletionTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<DeletionTask>;
  return typeof task.id === 'string'
    && typeof task.bankId === 'string'
    && typeof task.endpoint === 'string'
    && typeof task.documentId === 'string'
    && typeof task.state === 'string'
    && (task.state === 'pending' || task.state === 'done' || task.state === 'failed')
    && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string';
}

function restore(value: unknown): LedgerFile {
  // The previous file was a bare array of tasks; its entries carry no fence, so they are imported
  // as tasks only and the bank stays readable until a new forget writes one.
  if (Array.isArray(value)) {
    return {
      v: 2,
      tasks: value.filter(isTask).map((task) => ({ ...task, verifications: task.verifications ?? 0 })),
      tombstones: [],
      epochs: {},
      stale: [],
    };
  }
  if (!value || typeof value !== 'object') throw new Error('not a forget ledger');
  const file = value as Partial<LedgerFile>;
  return {
    v: 2,
    tasks: Array.isArray(file.tasks) ? file.tasks.filter(isTask).map((task) => ({ ...task, verifications: task.verifications ?? 0 })) : [],
    tombstones: Array.isArray(file.tombstones)
      ? file.tombstones.filter((entry): entry is ForgetTombstone => !!entry
        && typeof entry === 'object'
        && typeof entry.bankId === 'string'
        && typeof entry.endpoint === 'string'
        && typeof entry.documentId === 'string'
        && typeof entry.reason === 'string'
        && typeof entry.at === 'string')
      : [],
    epochs: file.epochs && typeof file.epochs === 'object' && !Array.isArray(file.epochs)
      ? Object.fromEntries(Object.entries(file.epochs).filter(([, epoch]) => typeof epoch === 'number'))
      : {},
    stale: Array.isArray(file.stale) ? file.stale.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}

export class ForgetLedger {
  private file: LedgerFile = { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] };
  private loaded = false;
  private persistenceError: string | null = null;

  constructor(
    private readonly path: string,
    private readonly opts: { now?: () => Date; log?: DeletionLog } = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.file = readState(this.path, restore) ?? { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] };
    } catch (err) {
      this.persistenceError = `could not read the forget ledger: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log?.warn('[memory] could not read the forget ledger', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private persist(): boolean {
    try {
      writeState(this.path, `${JSON.stringify(this.file, null, 2)}\n`);
      this.persistenceError = null;
      return true;
    } catch (err) {
      this.persistenceError = `could not write the forget ledger: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log?.warn('[memory] could not write the forget ledger', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * Fence every source and record the deletions in one write. A source already fenced keeps its
   * tombstone; an open task for it is reused so a repeated forget does not duplicate the work.
   */
  addMany(inputs: readonly DeletionInput[], reason: string): { tasks: DeletionTask[]; failed: number } {
    this.load();
    const before = this.file;
    const at = this.now().toISOString();
    const tasks: DeletionTask[] = [];
    const fresh: DeletionTask[] = [];
    const tombstones = [...this.file.tombstones];
    const epochs = { ...this.file.epochs };
    let changed = false;
    for (const input of inputs) {
      const fenced = tombstones.some((entry) =>
        entry.bankId === input.bankId && entry.endpoint === input.endpoint && entry.documentId === input.documentId);
      if (!fenced) {
        tombstones.push({ bankId: input.bankId, endpoint: input.endpoint, documentId: input.documentId, reason: reason.slice(0, 300), at });
        const target = key(input.bankId, input.endpoint);
        epochs[target] = (epochs[target] ?? 0) + 1;
        changed = true;
      }
      const open = this.file.tasks.find((task) =>
        task.bankId === input.bankId
        && task.endpoint === input.endpoint
        && task.documentId === input.documentId
        && task.state !== 'done');
      if (open) {
        tasks.push(open);
        continue;
      }
      const task: DeletionTask = {
        ...input,
        id: randomUUID(),
        state: 'pending',
        attempts: 0,
        verifications: 0,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      };
      fresh.push(task);
      tasks.push(task);
      changed = true;
    }
    if (!changed) return { tasks, failed: 0 };
    const targetKeys = new Set([...fresh, ...tasks].map((task) => key(task.bankId, task.endpoint)));
    const stale = [...new Set([...this.file.stale, ...targetKeys])];
    this.file = { v: 2, tasks: [...this.file.tasks, ...fresh], tombstones, epochs, stale };
    if (!this.persist()) {
      this.file = before;
      return { tasks: [], failed: Math.max(1, inputs.length) };
    }
    return { tasks, failed: 0 };
  }

  add(input: DeletionInput): DeletionTask | null {
    const { tasks, failed } = this.addMany([input], input.reason);
    return failed === 0 ? tasks[0] ?? null : null;
  }

  /** Is this source fenced out of every read for this bank? */
  forgotten(bankId: string, endpoint: string, documentId: string): boolean {
    this.load();
    return this.file.tombstones.some((entry) =>
      entry.bankId === bankId && entry.endpoint === endpoint && entry.documentId === documentId);
  }

  /** Bumped by every new fence; a read that started before it must not return its result. */
  epoch(bankId: string, endpoint: string): number {
    this.load();
    return this.file.epochs[key(bankId, endpoint)] ?? 0;
  }

  /** Deletions that have not reached a terminal state for this bank. */
  unresolved(bankId: string, endpoint: string): number {
    this.load();
    return this.file.tasks.filter((task) =>
      task.bankId === bankId && task.endpoint === endpoint && task.state !== 'done').length;
  }

  /** Are portraits for this bank older than its last fence? */
  stale(bankId: string, endpoint: string): boolean {
    this.load();
    return this.file.stale.includes(key(bankId, endpoint));
  }

  markFresh(bankId: string, endpoint: string): boolean {
    this.load();
    const target = key(bankId, endpoint);
    if (!this.file.stale.includes(target)) return true;
    const before = this.file;
    this.file = { ...this.file, stale: this.file.stale.filter((entry) => entry !== target) };
    if (!this.persist()) {
      this.file = before;
      return false;
    }
    return true;
  }

  due(now: Date, limit: number, target?: { bankId: string; endpoint: string }): DeletionTask[] {
    this.load();
    return this.file.tasks
      .filter((task) => (task.state === 'pending' || task.state === 'failed') && Date.parse(task.nextAttemptAt) <= now.getTime())
      .filter((task) => !target || (task.bankId === target.bankId && task.endpoint === target.endpoint))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));
  }

  get(id: string): DeletionTask | null {
    this.load();
    return this.file.tasks.find((task) => task.id === id) ?? null;
  }

  /**
   * Record a confirmed deletion. A source whose retain operation was still in flight gets one
   * more deletion after the window; the document is deleted once more rather than trusted.
   */
  markDone(id: string): boolean {
    this.load();
    const index = this.file.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    const before = this.file;
    const at = this.now();
    this.file = {
      ...this.file,
      tasks: this.file.tasks.map((task, position) => {
        if (position !== index) return task;
        const verify = task.operationId !== undefined && task.verifications === 0;
        return {
          ...task,
          state: verify ? 'pending' : 'done',
          verifications: verify ? 1 : task.verifications,
          nextAttemptAt: verify ? new Date(at.getTime() + VERIFY_DELAY_MS).toISOString() : task.nextAttemptAt,
          lastError: undefined,
          updatedAt: at.toISOString(),
        };
      }),
    };
    if (!this.persist()) {
      this.file = before;
      return false;
    }
    return true;
  }

  markFailed(id: string, error: string): boolean {
    this.load();
    const index = this.file.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    const before = this.file;
    const at = this.now();
    this.file = {
      ...this.file,
      tasks: this.file.tasks.map((task, position) => {
        if (position !== index) return task;
        const attempts = task.attempts + 1;
        const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempts, 7));
        return {
          ...task,
          state: 'failed',
          attempts,
          nextAttemptAt: new Date(at.getTime() + delay).toISOString(),
          lastError: error.slice(0, 300),
          updatedAt: at.toISOString(),
        };
      }),
    };
    if (!this.persist()) {
      this.file = before;
      return false;
    }
    return true;
  }

  status(): DeletionStatus {
    this.load();
    const status: DeletionStatus = {
      pending: 0,
      done: 0,
      failed: 0,
      tombstones: this.file.tombstones.length,
      staleTargets: this.file.stale.length,
      persistenceError: this.persistenceError,
    };
    for (const task of this.file.tasks) {
      if (task.state === 'pending') status.pending += 1;
      else if (task.state === 'failed') status.failed += 1;
      else status.done += 1;
    }
    return status;
  }

  /** The whole bank is gone, so its open deletions have nothing left to remove. The fence stays. */
  clearTarget(bankId: string, endpoint: string): boolean {
    this.load();
    const before = this.file;
    const at = this.now().toISOString();
    this.file = {
      ...this.file,
      tasks: this.file.tasks.map((task) => task.bankId === bankId && task.endpoint === endpoint && task.state !== 'done'
        ? { ...task, state: 'done', lastError: undefined, updatedAt: at }
        : task),
      stale: this.file.stale.filter((entry) => entry !== key(bankId, endpoint)),
    };
    if (!this.persist()) {
      this.file = before;
      return false;
    }
    return true;
  }

  /** How a specific set of tasks ended, for the forget receipt. */
  outcome(ids: readonly string[]): { done: number; pending: number; failed: number } {
    this.load();
    const out = { done: 0, pending: 0, failed: 0 };
    for (const id of ids) {
      const task = this.file.tasks.find((candidate) => candidate.id === id);
      if (!task) continue;
      if (task.state === 'done') out.done += 1;
      else if (task.state === 'failed') out.failed += 1;
      else out.pending += 1;
    }
    return out;
  }
}
