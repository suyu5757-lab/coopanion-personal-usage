/**
 * A small durable queue for retain requests. The file is JSONL, one record per state change;
 * every append is fsynced, so a crash keeps whatever was acknowledged. Completed payloads are
 * dropped from disk, and only their status metadata stays for a short audit window.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { writeState } from '../state-file.ts';

export type RetainPriority = 'critical' | 'normal' | 'low';
export type OutboxState = 'pending' | 'sent' | 'done' | 'failed' | 'dead' | 'cancelled' | 'orphaned';

export interface RetainItem {
  /** The bank and endpoint this payload belongs to; a retry never follows a changed config. */
  bankId?: string;
  endpoint?: string;
  documentId: string;
  content: string;
  context: string;
  tags: string[];
  metadata?: Record<string, string>;
  timestamp?: string;
  priority: RetainPriority;
}

export interface OutboxItem extends RetainItem {
  /** The event that produced this item; stable across retries. */
  id: string;
  /** Sent with the first request and reused on every retry of the same payload. */
  operationId: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string;
  /** A failed extraction is not polled again before this time. */
  nextPollAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxLog {
  warn(message: string, data?: unknown): void;
}

export interface OutboxStatus {
  pending: number;
  sent: number;
  failed: number;
  dead: number;
  cancelled: number;
  /** Items isolated because their bank or endpoint no longer matches the running config. */
  orphaned: number;
  /** Items that still carry a payload and may be sent. */
  active: number;
  full: boolean;
  oldestPendingAt: string | null;
  lastError: string | null;
  /** The last write to the queue file failed; the in-memory state was not published. */
  persistenceError: string | null;
}

export type AddResult = 'queued' | 'full' | 'persistence-error';

interface LogRecord {
  v: 1;
  item: OutboxItem;
}

const MAX_ACTIVE = 512;
const MAX_TOTAL = 2048;
const MAX_ATTEMPTS = 8;
const KEEP_FINISHED_MS = 7 * 86_400_000;
const LINE_MAX = 1_000_000;

const iso = (date: Date) => date.toISOString();

function parseItem(value: unknown): OutboxItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<OutboxItem>;
  if (typeof item.id !== 'string' || typeof item.documentId !== 'string') return null;
  if (typeof item.operationId !== 'string' || typeof item.content !== 'string') return null;
  if (typeof item.context !== 'string' || !Array.isArray(item.tags)) return null;
  if (!item.tags.every((tag) => typeof tag === 'string')) return null;
  if (typeof item.state !== 'string' || !['pending', 'sent', 'done', 'failed', 'dead', 'cancelled', 'orphaned'].includes(item.state)) return null;
  if (typeof item.attempts !== 'number' || typeof item.nextAttemptAt !== 'string') return null;
  if (typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') return null;
  const priority = item.priority === 'critical' || item.priority === 'low' ? item.priority : 'normal';
  const metadata = item.metadata && typeof item.metadata === 'object'
    ? Object.fromEntries(Object.entries(item.metadata).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    : undefined;
  return {
    id: item.id,
    ...(typeof item.bankId === 'string' ? { bankId: item.bankId } : {}),
    ...(typeof item.endpoint === 'string' ? { endpoint: item.endpoint } : {}),
    documentId: item.documentId,
    operationId: item.operationId,
    content: item.content,
    context: item.context,
    tags: item.tags,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(typeof item.timestamp === 'string' ? { timestamp: item.timestamp } : {}),
    priority,
    state: item.state as OutboxState,
    attempts: item.attempts,
    nextAttemptAt: item.nextAttemptAt,
    ...(typeof item.nextPollAt === 'string' ? { nextPollAt: item.nextPollAt } : {}),
    ...(typeof item.lastError === 'string' ? { lastError: item.lastError } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export class MemoryOutbox {
  private readonly items = new Map<string, OutboxItem>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log?: OutboxLog;
  private readonly maxActive: number;
  private readonly maxTotal: number;
  private loaded = false;
  private persistenceError: string | null = null;
  /** Runtime-only poll order; fairness does not need a disk write every fifteen seconds. */
  private readonly polledAt = new Map<string, number>();

  constructor(private readonly file: string, opts: { now?: () => Date; newId?: () => string; log?: OutboxLog; maxActive?: number; maxTotal?: number } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
    this.log = opts.log;
    this.maxActive = Math.max(1, opts.maxActive ?? MAX_ACTIVE);
    this.maxTotal = Math.max(this.maxActive, opts.maxTotal ?? MAX_TOTAL);
  }

  /** Read the log, apply records in order, and drop finished metadata older than the audit window. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      this.loaded = false;
      this.persistenceError = `could not read the queue: ${err instanceof Error ? err.message : String(err)}`;
      this.log?.warn('[memory] could not read the retain outbox', { message: err instanceof Error ? err.message : String(err) });
      return;
    }
    let bad = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Partial<LogRecord>;
        if (record.v !== 1) throw new Error('unknown outbox record');
        const item = parseItem(record.item);
        if (!item) throw new Error('invalid outbox item');
        if (!item.bankId || !item.endpoint) {
          if (item.state === 'pending' || item.state === 'sent' || item.state === 'failed') {
            item.state = 'orphaned';
            item.lastError = 'this item predates bank/endpoint binding; choose a target before sending it';
          }
        }
        this.items.set(item.id, item);
      } catch {
        bad += 1;
      }
    }
    if (bad > 0) this.log?.warn('[memory] skipped unreadable retain outbox lines', { bad, file: this.file });
    this.dropExpiredFinished();
    this.compact();
  }

  /** Queue one item; it is acknowledged only after the append and fsync succeed. */
  add(item: RetainItem): AddResult {
    this.load();
    if (!this.loaded) return 'persistence-error';
    if (!item.bankId || !item.endpoint) {
      this.persistenceError = 'the retain item has no bank/endpoint binding';
      this.log?.warn('[memory] retain item has no target binding', { documentId: item.documentId });
      return 'persistence-error';
    }
    const at = iso(this.now());
    const active = this.activeCount();
    if (active >= this.maxTotal || (active >= this.maxActive && item.priority !== 'critical')) return 'full';
    // The document id is the identity of the source. Re-enqueuing an active item would submit the
    // same document twice and let `replace` delete extraction that is still in flight.
    for (const existing of this.items.values()) {
      if (existing.documentId !== item.documentId) continue;
      if (existing.bankId !== item.bankId || existing.endpoint !== item.endpoint) continue;
      if (existing.state === 'pending' || existing.state === 'sent' || existing.state === 'failed') return 'queued';
    }
    const queued: OutboxItem = {
      ...item,
      id: this.newId(),
      documentId: item.documentId,
      operationId: this.newId(),
      bankId: item.bankId,
      endpoint: item.endpoint,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    };
    if (!this.append(queued)) return 'persistence-error';
    this.items.set(queued.id, queued);
    return 'queued';
  }

  /** Pending or failed items whose retry time has come, oldest first. */
  due(now: Date, limit: number): OutboxItem[] {
    this.load();
    const at = now.getTime();
    return [...this.items.values()]
      .filter((item) => (item.state === 'pending' || item.state === 'failed') && Date.parse(item.nextAttemptAt) <= at)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));
  }

  /** Accepted items whose operation still has to be checked, least recently polled first. */
  sent(limit: number, now: Date = this.now()): OutboxItem[] {
    this.load();
    return [...this.items.values()]
      .filter((item) => item.state === 'sent' && (!item.nextPollAt || Date.parse(item.nextPollAt) <= now.getTime()))
      .sort((a, b) => (this.polledAt.get(a.id) ?? 0) - (this.polledAt.get(b.id) ?? 0) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));
  }

  /** Move an operation to the back of the poll order. */
  markPolled(id: string): void {
    this.polledAt.set(id, Date.now());
  }

  markSent(id: string, operationId: string): boolean {
    return this.update(id, (item) => ({ ...item, operationId, state: 'sent', nextPollAt: undefined, lastError: undefined }), ['pending', 'failed']);
  }

  markDone(id: string): boolean {
    const changed = this.update(id, (item) => ({ ...item, state: 'done', content: '', metadata: undefined, lastError: undefined }), ['pending', 'sent', 'failed', 'orphaned']);
    this.polledAt.delete(id);
    if (changed) this.compact();
    return changed;
  }

  markFailed(id: string, error: string, options: { permanent?: boolean } = {}): boolean {
    return this.update(id, (item) => {
      const attempts = item.attempts + 1;
      const permanent = options.permanent === true || attempts >= MAX_ATTEMPTS;
      const delay = Math.min(10 * 60_000, 5_000 * 2 ** Math.min(attempts, 7));
      return {
        ...item,
        attempts,
        state: permanent ? 'dead' : 'failed',
        ...(permanent ? this.failureOutcome(item) : {}),
        nextAttemptAt: iso(new Date(this.now().getTime() + delay)),
        nextPollAt: undefined,
        lastError: error.slice(0, 300),
      };
    }, ['pending', 'sent', 'failed']);
  }

  /** Record a failed status check. `count` is for an extraction the server itself reported failed. */
  noteRetry(id: string, error: string, options: { count?: boolean } = {}): boolean {
    return this.update(id, (item) => {
      const attempts = item.attempts + (options.count ? 1 : 0);
      const dead = options.count === true && attempts >= MAX_ATTEMPTS;
      return {
        ...item,
        attempts,
        state: dead ? 'dead' : item.state,
        ...(dead ? this.failureOutcome(item) : {}),
        nextPollAt: dead || options.count !== true ? undefined : iso(new Date(this.now().getTime() + Math.min(10 * 60_000, 30_000 * 2 ** Math.min(attempts, 5)))),
        lastError: error.slice(0, 300),
      };
    }, ['sent']);
  }

  markCancelled(id: string, reason: string): boolean {
    const changed = this.update(id, (item) => ({ ...item, state: 'cancelled', content: '', metadata: undefined, lastError: reason.slice(0, 300) }), ['pending', 'sent', 'failed', 'orphaned']);
    this.polledAt.delete(id);
    if (changed) this.compact();
    return changed;
  }

  /** Active items matching a predicate, without changing their state. */
  matching(match: (item: OutboxItem) => boolean): OutboxItem[] {
    this.load();
    return [...this.items.values()].filter((item) =>
      (item.state === 'pending' || item.state === 'failed' || item.state === 'sent' || item.state === 'orphaned') && match(item));
  }

  /** Cancel queued or in-flight items matching a forget request; returns only persisted cancellations. */
  cancelMatching(match: (item: OutboxItem) => boolean, reason: string): OutboxItem[] {
    this.load();
    const cancelled: OutboxItem[] = [];
    for (const item of this.items.values()) {
      if (item.state !== 'pending' && item.state !== 'failed' && item.state !== 'sent' && item.state !== 'orphaned') continue;
      if (!match(item)) continue;
      if (!this.update(item.id, (current) => ({ ...current, state: 'cancelled', content: '', metadata: undefined, lastError: reason.slice(0, 300) }))) continue;
      this.polledAt.delete(item.id);
      cancelled.push(item);
    }
    if (cancelled.length > 0) this.compact();
    return cancelled;
  }

  cancelAll(reason: string): OutboxItem[] {
    return this.cancelMatching((item) => item.state !== 'done' && item.state !== 'cancelled' && item.state !== 'dead', reason);
  }

  /** Isolate an item whose persisted target no longer matches the running config. */
  quarantine(id: string, reason: string): boolean {
    return this.update(id, (item) => ({ ...item, state: 'orphaned', lastError: reason.slice(0, 300) }), ['pending', 'sent', 'failed']);
  }

  /** Explicitly bind an isolated item to a new target; the old operation id is never reused. */
  rebind(id: string, bankId: string, endpoint: string): boolean {
    return this.update(id, (item) => ({
      ...item,
      bankId,
      endpoint,
      operationId: this.newId(),
      state: 'failed',
      attempts: 0,
      nextAttemptAt: iso(this.now()),
      nextPollAt: undefined,
      lastError: undefined,
    }), ['orphaned']);
  }

  /** Put a dead item back on the queue. Its payload is kept only for critical or correction items. */
  retryDead(id: string): boolean {
    const current = this.get(id);
    if (!current || current.state !== 'dead' || !current.content) return false;
    return this.update(id, (item) => ({
      ...item,
      state: 'failed',
      attempts: 0,
      nextAttemptAt: iso(this.now()),
      nextPollAt: undefined,
      lastError: undefined,
    }), ['dead']);
  }

  /** Critical facts and corrections keep their payload when a permanent or exhausted failure isolates them. */
  private failureOutcome(item: OutboxItem): Partial<OutboxItem> {
    return item.priority === 'critical' || item.metadata?.kind === 'correction'
      ? {}
      : { content: '', metadata: undefined };
  }

  get(id: string): OutboxItem | null {
    this.load();
    return this.items.get(id) ?? null;
  }

  status(): OutboxStatus {
    this.load();
    const counts = { pending: 0, sent: 0, failed: 0, dead: 0, cancelled: 0, orphaned: 0 };
    let oldest: string | null = null;
    let lastError: string | null = null;
    let lastErrorAt = '';
    for (const item of this.items.values()) {
      if (item.state === 'pending' || item.state === 'sent' || item.state === 'failed') counts[item.state] += 1;
      if (item.state === 'dead') counts.dead += 1;
      if (item.state === 'cancelled') counts.cancelled += 1;
      if (item.state === 'orphaned') counts.orphaned += 1;
      if ((item.state === 'pending' || item.state === 'failed') && (!oldest || item.createdAt < oldest)) oldest = item.createdAt;
      if (item.lastError && item.updatedAt > lastErrorAt) {
        lastError = item.lastError;
        lastErrorAt = item.updatedAt;
      }
    }
    const active = counts.pending + counts.sent + counts.failed;
    return {
      ...counts,
      active,
      full: active >= this.maxActive,
      oldestPendingAt: oldest,
      lastError,
      persistenceError: this.persistenceError,
    };
  }

  /** Rewrite only the items that still matter. Finished payloads are already empty. */
  compact(): boolean {
    this.load();
    this.dropExpiredFinished();
    const records = [...this.items.values()].map((item) => JSON.stringify({ v: 1, item } satisfies LogRecord));
    try {
      writeState(this.file, records.length ? `${records.join('\n')}\n` : '');
      this.persistenceError = null;
      return true;
    } catch (err) {
      this.persistenceError = `could not compact the queue: ${err instanceof Error ? err.message : String(err)}`;
      this.log?.warn('[memory] could not compact the retain outbox', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private activeCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.state === 'pending' || item.state === 'sent' || item.state === 'failed') count += 1;
    }
    return count;
  }

  private dropExpiredFinished(): void {
    const cutoff = this.now().getTime() - KEEP_FINISHED_MS;
    for (const [id, item] of this.items) {
      if ((item.state === 'done' || item.state === 'cancelled' || item.state === 'dead') && Date.parse(item.updatedAt) < cutoff) this.items.delete(id);
    }
  }

  private update(id: string, change: (item: OutboxItem) => OutboxItem, allowed?: readonly OutboxState[]): boolean {
    this.load();
    const current = this.items.get(id);
    if (!current) return false;
    if (allowed && !allowed.includes(current.state)) return false;
    const next = { ...change(current), updatedAt: iso(this.now()) };
    if (!this.append(next)) return false;
    this.items.set(id, next);
    return true;
  }

  private append(item: OutboxItem): boolean {
    const line = `${JSON.stringify({ v: 1, item } satisfies LogRecord)}\n`;
    if (line.length > LINE_MAX) {
      this.persistenceError = 'the retain item is too large for the queue';
      this.log?.warn('[memory] retain item too large for the outbox', { id: item.id, bytes: line.length });
      return false;
    }
    const bytes = Buffer.from(line, 'utf8');
    let fd: number | null = null;
    try {
      fd = openSync(this.file, 'a');
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('short write');
        offset += written;
      }
      fsyncSync(fd);
      this.persistenceError = null;
      return true;
    } catch (err) {
      this.persistenceError = `could not write the queue: ${err instanceof Error ? err.message : String(err)}`;
      this.log?.warn('[memory] could not append to the retain outbox', { id: item.id, message: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}
