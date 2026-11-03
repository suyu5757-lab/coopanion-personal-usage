/**
 * The durable record of forgetting. A source stays out of reads while its remote deletion is
 * tracked to a terminal state and dependent portraits are rebuilt. A durable intent blocks reads
 * before the fence, retry task and derived invalidation commit together.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { openMemoryStateStore, type ForgetIntentTarget, type ForgetStateSnapshot, type MemoryStateStore } from './state-store.ts';
import { readState } from '../state-file.ts';

export type DeletionState = 'intent' | 'pending' | 'done' | 'failed';

export type ForgetIntentAcceptance = 'accepted' | 'not-accepted' | 'unknown-blocked';

export interface ForgetIntentResult {
  acceptance: ForgetIntentAcceptance;
  tasks: DeletionTask[];
  failed: number;
}

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

export interface LedgerFile extends ForgetStateSnapshot {
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
const sourceKey = (target: Pick<ForgetIntentTarget, 'bankId' | 'endpoint' | 'documentId'>): string =>
  JSON.stringify([target.bankId, target.endpoint, target.documentId]);

function sameKeys(left: readonly string[] | null, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((entry, index) => entry === sortedRight[index]);
}

function isTask(value: unknown): value is DeletionTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<DeletionTask>;
  return typeof task.id === 'string'
    && typeof task.bankId === 'string'
    && typeof task.endpoint === 'string'
    && typeof task.documentId === 'string'
    && typeof task.state === 'string'
    && (task.state === 'intent' || task.state === 'pending' || task.state === 'done' || task.state === 'failed')
    && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string';
}

export function restoreLedger(value: unknown): LedgerFile {
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

export function readLegacyForget(path: string, legacyFile?: string, log?: DeletionLog): { state: LedgerFile; damaged: boolean } {
  const present = existsSync(path);
  const source = present ? path : legacyFile && existsSync(legacyFile) ? legacyFile : null;
  if (!source) return { state: { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] }, damaged: false };
  try {
    const saved = readState(source, restoreLedger);
    if (!saved) return { state: { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] }, damaged: present };
    return {
      state: present
        ? saved
        : { v: 2, tasks: saved.tasks, tombstones: [], epochs: {}, stale: [] },
      damaged: false,
    };
  } catch (error) {
    log?.warn('[memory] could not read a legacy forget ledger', { message: error instanceof Error ? error.message : String(error) });
    return { state: { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] }, damaged: true };
  }
}

export class ForgetLedger {
  private file: LedgerFile = { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] };
  private loaded = false;
  private damagedLedger = false;
  private persistenceBlocked = false;
  private persistenceError: string | null = null;
  private initializationError: string | null = null;
  private blockedTargetKeys: string[] | null = null;
  private retryableFailureTargetKeys: string[] | null = null;
  readonly stateStore: MemoryStateStore | null;

  constructor(
    pathOrStore: string | MemoryStateStore,
    private readonly opts: { now?: () => Date; log?: DeletionLog; legacyFile?: string } = {},
  ) {
    try {
      this.stateStore = typeof pathOrStore === 'string' ? openMemoryStateStore(pathOrStore) : pathOrStore;
      if (typeof pathOrStore === 'string' && !this.stateStore.imported('forget-v1')) {
        const imported = readLegacyForget(pathOrStore, this.opts.legacyFile, this.opts.log);
        this.stateStore.importForget(imported.state, imported.damaged);
      }
    } catch (error) {
      this.stateStore = null;
      this.initializationError = error instanceof Error ? error.message : String(error);
      this.damagedLedger = true;
      this.persistenceError = `could not open the memory database: ${this.initializationError}`;
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.stateStore) return;
    try {
      const saved = this.stateStore.loadForgetState();
      if (saved.state) this.file = saved.state as LedgerFile;
      this.damagedLedger = saved.damaged;
      this.persistenceBlocked ||= saved.blocked;
      this.blockedTargetKeys = saved.blockedTargets?.map(sourceKey).sort() ?? null;
      if (!this.damagedLedger && this.file.tasks.some((task) => task.state === 'intent')) this.promoteIntents();
    } catch (err) {
      this.damagedLedger = true;
      this.persistenceError = `could not read the memory database: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log?.warn('[memory] could not read the forget ledger', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private persist(): boolean {
    if (this.damagedLedger || !this.stateStore) {
      this.persistenceError ??= `could not write the memory database: ${this.initializationError ?? 'forget state is damaged'}`;
      return false;
    }
    try {
      this.stateStore.saveForgetState(this.file);
      this.damagedLedger = false;
      return true;
    } catch (err) {
      this.persistenceError = `could not write the memory database: ${err instanceof Error ? err.message : String(err)}`;
      this.persistenceBlocked = true;
      try { this.stateStore?.markForgetWriteBlocked(); } catch { /* The in-memory block still closes reads. */ }
      this.opts.log?.warn('[memory] could not write the forget ledger', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private promoteIntents(): boolean {
    if (this.damagedLedger || !this.stateStore) return false;
    const intents = this.file.tasks.filter((task) => task.state === 'intent');
    if (intents.length === 0) return !this.persistenceBlocked;
    const before = this.file;
    const tombstones = [...this.file.tombstones];
    const epochs = { ...this.file.epochs };
    const stale = new Set(this.file.stale);
    const at = this.now().toISOString();
    for (const task of intents) {
      const exists = tombstones.some((entry) => entry.bankId === task.bankId
        && entry.endpoint === task.endpoint && entry.documentId === task.documentId);
      if (!exists) {
        tombstones.push({ bankId: task.bankId, endpoint: task.endpoint, documentId: task.documentId, reason: task.reason.slice(0, 300), at });
        const target = key(task.bankId, task.endpoint);
        epochs[target] = (epochs[target] ?? 0) + 1;
      }
      stale.add(key(task.bankId, task.endpoint));
    }
    const intentIds = new Set(intents.map((task) => task.id));
    this.file = {
      ...this.file,
      tasks: this.file.tasks.map((task) => intentIds.has(task.id)
        ? { ...task, state: 'pending', updatedAt: at }
        : task),
      tombstones,
      epochs,
      stale: [...stale],
    };
    if (!this.persist()) {
      this.file = before;
      this.persistenceBlocked = true;
      return false;
    }
    this.persistenceBlocked = false;
    this.persistenceError = null;
    this.blockedTargetKeys = null;
    this.retryableFailureTargetKeys = null;
    return true;
  }

  private persistClearedTarget(bankId: string, endpoint: string): boolean {
    if (this.damagedLedger || !this.stateStore) {
      this.persistenceError ??= `could not write the memory database: ${this.initializationError ?? 'forget state is damaged'}`;
      return false;
    }
    try {
      this.stateStore.clearMemoryTarget(bankId, endpoint, this.file);
      this.damagedLedger = false;
      return true;
    } catch (err) {
      this.persistenceError = `could not write the memory database: ${err instanceof Error ? err.message : String(err)}`;
      this.persistenceBlocked = true;
      try { this.stateStore?.markForgetWriteBlocked(); } catch { /* The in-memory block still closes reads. */ }
      this.opts.log?.warn('[memory] could not write the cleared target state', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Persist the acceptance record before cancelling the local queue or applying fences. */
  beginIntents(inputs: readonly DeletionInput[], reason: string): ForgetIntentResult {
    this.load();
    const unique = [...new Map(inputs.filter((input) => input.bankId && input.endpoint && input.documentId)
      .map((input) => [sourceKey(input), input])).values()];
    const requestedKeys = unique.map(sourceKey).sort();
    if (unique.length === 0) return { acceptance: 'not-accepted', tasks: [], failed: 0 };
    if (this.damagedLedger || !this.stateStore) {
      this.persistenceError ??= `could not write the memory database: ${this.initializationError ?? 'forget state is damaged'}`;
      return { acceptance: 'unknown-blocked', tasks: [], failed: unique.length };
    }
    if (this.persistenceBlocked
      && !sameKeys(this.blockedTargetKeys, requestedKeys)
      && !sameKeys(this.retryableFailureTargetKeys, requestedKeys)) {
      return { acceptance: 'unknown-blocked', tasks: [], failed: unique.length };
    }

    const tasks: DeletionTask[] = [];
    const fresh: DeletionTask[] = [];
    const at = this.now().toISOString();
    for (const input of unique) {
      const fenced = this.file.tombstones.some((entry) => entry.bankId === input.bankId
        && entry.endpoint === input.endpoint && entry.documentId === input.documentId);
      const existing = fenced ? this.file.tasks.find((task) => task.bankId === input.bankId && task.endpoint === input.endpoint
        && task.documentId === input.documentId && task.state !== 'done') : undefined;
      if (existing) {
        tasks.push(existing);
        continue;
      }
      const acknowledged = fenced ? this.file.tasks.find((task) => task.bankId === input.bankId && task.endpoint === input.endpoint
        && task.documentId === input.documentId && task.state === 'done') : undefined;
      if (acknowledged) {
        tasks.push(acknowledged);
        continue;
      }
      const task: DeletionTask = {
        ...input,
        id: randomUUID(),
        reason: reason.slice(0, 300),
        state: 'intent',
        attempts: 0,
        verifications: 0,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      };
      fresh.push(task);
      tasks.push(task);
    }
    if (fresh.length === 0) return { acceptance: 'accepted', tasks, failed: 0 };

    this.persistenceBlocked = true;
    const retryTargets: ForgetIntentTarget[] = unique.map((input) => ({ ...input, reason: reason.slice(0, 300) }));
    try {
      this.stateStore.saveForgetIntents(fresh);
      this.file = { ...this.file, tasks: [...this.file.tasks, ...fresh] };
      this.blockedTargetKeys = null;
      this.retryableFailureTargetKeys = null;
      this.persistenceError = null;
      return { acceptance: 'accepted', tasks, failed: 0 };
    } catch (error) {
      this.retryableFailureTargetKeys = requestedKeys;
      this.persistenceError = `could not write the memory database: ${error instanceof Error ? error.message : String(error)}`;
      try { this.stateStore.markForgetWriteBlocked(retryTargets); } catch { /* The process-local block still closes Memory. */ }
      this.opts.log?.warn('[memory] could not persist the forget intent', { message: error instanceof Error ? error.message : String(error) });
      try {
        const saved = this.stateStore.loadForgetState();
        const savedTasks = (saved.state?.tasks ?? []).filter(isTask);
        const persisted = fresh.every((intent) => savedTasks.some((task) => task.id === intent.id && task.state === 'intent'));
        if (persisted) {
          this.file = saved.state as LedgerFile;
          this.persistenceBlocked = true;
          return { acceptance: 'accepted', tasks: fresh, failed: 0 };
        }
        this.blockedTargetKeys = saved.blockedTargets?.map(sourceKey).sort() ?? null;
        return { acceptance: 'not-accepted', tasks: [], failed: Math.max(1, unique.length) };
      } catch {
        return { acceptance: 'unknown-blocked', tasks: [], failed: Math.max(1, unique.length) };
      }
    }
  }

  /** Apply persisted intents as fences and retry tasks in one SQLite transaction. */
  finalizeIntents(): boolean {
    this.load();
    if (this.damagedLedger || !this.stateStore) return false;
    return this.promoteIntents();
  }

  /**
   * Fence every source and record the deletions in one write. A source already fenced keeps its
   * tombstone; an open task for it is reused so a repeated forget does not duplicate the work.
   */
  addMany(inputs: readonly DeletionInput[], reason: string): { tasks: DeletionTask[]; failed: number } {
    this.load();
    if (this.damagedLedger || this.persistenceBlocked || !this.stateStore) {
      this.persistenceError ??= `could not write the memory database: ${this.initializationError ?? 'forget state is damaged'}`;
      return { tasks: [], failed: Math.max(1, inputs.length) };
    }
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
    this.persistenceBlocked = false;
    this.persistenceError = null;
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
      entry.bankId === bankId && entry.endpoint === endpoint
      && (entry.documentId === documentId || entry.documentId === '*'));
  }

  /** Whether any source in this bank has a durable forget fence. */
  hasFencedSources(bankId: string, endpoint: string): boolean {
    this.load();
    return this.file.tombstones.some((entry) => entry.bankId === bankId && entry.endpoint === endpoint);
  }

  bankClearPending(bankId: string, endpoint: string): boolean {
    this.load();
    return this.file.tombstones.some((entry) =>
      entry.bankId === bankId && entry.endpoint === endpoint && entry.documentId === '*');
  }

  /** The file exists but could not be read, so its tombstones are unknown. */
  damaged(): boolean {
    this.load();
    return this.damagedLedger || this.persistenceBlocked;
  }

  /** Keep reads and activation closed after a forget transaction failed outside the ledger write. */
  markUnavailable(message: string): void {
    this.persistenceBlocked = true;
    this.persistenceError ??= message.slice(0, 300);
    try { this.stateStore?.markForgetWriteBlocked(); } catch { /* The in-memory block still closes reads. */ }
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
    if (this.persistenceBlocked || this.damagedLedger) return false;
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

  reload(): void {
    this.file = { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] };
    this.loaded = false;
    this.damagedLedger = false;
    if (!this.persistenceBlocked) this.persistenceError = null;
  }

  /**
   * Record a confirmed deletion. A source whose retain operation was still in flight gets one
   * more deletion after the window; the document is deleted once more rather than trusted.
   */
  markDone(id: string): boolean {
    this.load();
    if (this.persistenceBlocked || this.damagedLedger) return false;
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
    if (this.persistenceBlocked || this.damagedLedger) return false;
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
      else if (task.state === 'done') status.done += 1;
      else status.pending += 1;
    }
    return status;
  }

  /** Block every source in a bank before the remote clear begins. */
  beginClearTarget(bankId: string, endpoint: string): boolean {
    this.load();
    if (this.damagedLedger || this.persistenceBlocked || !this.stateStore) return false;
    const before = this.file;
    const at = this.now().toISOString();
    const target = key(bankId, endpoint);
    const hasWildcard = this.file.tombstones.some((entry) =>
      entry.bankId === bankId && entry.endpoint === endpoint && entry.documentId === '*');
    const tombstones = hasWildcard ? this.file.tombstones : [
      ...this.file.tombstones,
      { bankId, endpoint, documentId: '*', reason: 'the memory bank is being cleared', at },
    ];
    const epochs = hasWildcard ? this.file.epochs : { ...this.file.epochs, [target]: (this.file.epochs[target] ?? 0) + 1 };
    this.file = {
      ...this.file,
      tombstones,
      epochs,
      stale: [...new Set([...this.file.stale, target])],
    };
    if (!this.persistClearedTarget(bankId, endpoint)) {
      this.file = before;
      return false;
    }
    this.persistenceBlocked = false;
    this.persistenceError = null;
    return true;
  }

  /** The remote clear succeeded; release the wildcard only after its result is known. */
  finishClearTarget(bankId: string, endpoint: string): boolean {
    this.load();
    if (this.damagedLedger || this.persistenceBlocked || !this.stateStore) return false;
    const before = this.file;
    const at = this.now().toISOString();
    const target = key(bankId, endpoint);
    const hasWildcard = this.file.tombstones.some((entry) =>
      entry.bankId === bankId && entry.endpoint === endpoint && entry.documentId === '*');
    this.file = {
      ...this.file,
      tasks: this.file.tasks.map((task) => task.bankId === bankId && task.endpoint === endpoint && task.state !== 'done'
        ? { ...task, state: 'done', lastError: undefined, updatedAt: at }
        : task),
      tombstones: this.file.tombstones.filter((entry) =>
        !(entry.bankId === bankId && entry.endpoint === endpoint && entry.documentId === '*')),
      epochs: hasWildcard
        ? { ...this.file.epochs, [target]: (this.file.epochs[target] ?? 0) + 1 }
        : this.file.epochs,
      stale: [...new Set([...this.file.stale, target])],
    };
    if (!this.persistClearedTarget(bankId, endpoint)) {
      this.file = before;
      return false;
    }
    this.persistenceBlocked = false;
    this.persistenceError = null;
    return true;
  }

  /** Compatibility entry point for callers whose remote clear has already completed. */
  clearTarget(bankId: string, endpoint: string): boolean {
    return this.beginClearTarget(bankId, endpoint) && this.finishClearTarget(bankId, endpoint);
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
