/**
 * A small durable queue for retain requests. SQLite commits every state change before the caller
 * can report it. Completed payloads are dropped while status metadata stays for a short audit window.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { openMemoryStateStore, type MemoryStateStore } from './state-store.ts';

export type RetainPriority = 'critical' | 'normal' | 'low';
export type OutboxState = 'pending' | 'sending' | 'sent' | 'done' | 'verified' | 'failed' | 'dead' | 'cancelled' | 'orphaned';

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
  requestHash: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string;
  /** A failed extraction is not polled again before this time. */
  nextPollAt?: string;
  nextVerifyAt?: string;
  verificationAttempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  /** Set only by an authorized local reconciliation after an external exact readback. */
  reconciledAt?: string;
  /** Digest of the external receipt used for that reconciliation. */
  reconcileReceipt?: string;
}

export interface OutboxLog {
  warn(message: string, data?: unknown): void;
}

export interface OutboxStatus {
  pending: number;
  sent: number;
  /** Remote operation completion does not prove the source document can be read. */
  completed: number;
  unverified: number;
  verified: number;
  failed: number;
  dead: number;
  /** Dead items that still hold a payload: a critical fact that never reached the service. */
  deadRetained: number;
  cancelled: number;
  /** Items isolated because their bank or endpoint no longer matches the running config. */
  orphaned: number;
  /** Items that still carry a payload and may be sent, including dead critical facts. */
  active: number;
  full: boolean;
  oldestPendingAt: string | null;
  lastError: string | null;
  /** The last write to the queue file failed; the in-memory state was not published. */
  persistenceError: string | null;
}

export type AddResult = 'queued' | 'full' | 'persistence-error';

const MAX_ACTIVE = 512;
const MAX_TOTAL = 2048;
const MAX_ATTEMPTS = 8;
const RECEIPT_DIGEST = /^[a-f0-9]{64}$/;

const iso = (date: Date) => date.toISOString();

function parseItem(value: unknown): OutboxItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<OutboxItem>;
  if (typeof item.id !== 'string' || typeof item.documentId !== 'string') return null;
  if (typeof item.operationId !== 'string' || typeof item.content !== 'string') return null;
  if (typeof item.context !== 'string' || !Array.isArray(item.tags)) return null;
  if (!item.tags.every((tag) => typeof tag === 'string')) return null;
  if (typeof item.state !== 'string' || !['pending', 'sending', 'sent', 'done', 'verified', 'failed', 'dead', 'cancelled', 'orphaned'].includes(item.state)) return null;
  if (typeof item.attempts !== 'number' || typeof item.nextAttemptAt !== 'string') return null;
  if (typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') return null;
  const priority = item.priority === 'critical' || item.priority === 'low' ? item.priority : 'normal';
  const metadata = item.metadata && typeof item.metadata === 'object'
    ? Object.fromEntries(Object.entries(item.metadata).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    : undefined;
  const parsed: OutboxItem = {
    id: item.id,
    ...(typeof item.bankId === 'string' ? { bankId: item.bankId } : {}),
    ...(typeof item.endpoint === 'string' ? { endpoint: item.endpoint } : {}),
    documentId: item.documentId,
    operationId: item.operationId,
    requestHash: typeof item.requestHash === 'string' ? item.requestHash : '',
    content: item.content,
    context: item.context,
    tags: item.tags,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(typeof item.timestamp === 'string' ? { timestamp: item.timestamp } : {}),
    priority,
    state: item.state as OutboxState,
    attempts: item.attempts,
    verificationAttempts: typeof item.verificationAttempts === 'number' ? item.verificationAttempts : 0,
    nextAttemptAt: item.nextAttemptAt,
    ...(typeof item.nextPollAt === 'string' ? { nextPollAt: item.nextPollAt } : {}),
    ...(typeof item.nextVerifyAt === 'string' ? { nextVerifyAt: item.nextVerifyAt } : {}),
    ...(typeof item.lastError === 'string' ? { lastError: item.lastError } : {}),
    ...(typeof item.reconciledAt === 'string' ? { reconciledAt: item.reconciledAt } : {}),
    ...(typeof item.reconcileReceipt === 'string' ? { reconcileReceipt: item.reconcileReceipt } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  parsed.requestHash ||= requestHashFor(parsed);
  return parsed;
}

export function requestHashFor(item: Pick<OutboxItem, 'bankId' | 'endpoint' | 'documentId' | 'content' | 'context' | 'tags' | 'metadata' | 'timestamp'>): string {
  return createHash('sha256').update(JSON.stringify({
    bankId: item.bankId,
    endpoint: item.endpoint,
    documentId: item.documentId,
    content: item.content,
    context: item.context,
    tags: item.tags,
    metadata: item.metadata ?? null,
    timestamp: item.timestamp ?? null,
  })).digest('hex');
}

export function readLegacyOutbox(file: string, log?: OutboxLog): OutboxItem[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const items = new Map<string, OutboxItem>();
  const operationOwners = new Map<string, string>();
  const documentOwners = new Map<string, string>();
  const refuse = (line: number, reason: string): never => {
    log?.warn('[memory] refusing legacy retain outbox import', { line, reason });
    throw new Error(`invalid legacy retain outbox at line ${line}`);
  };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let record: { v?: unknown; item?: unknown };
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse(index + 1, 'record is not an object');
      record = parsed as { v?: unknown; item?: unknown };
    } catch (error) {
      if (error instanceof SyntaxError) return refuse(index + 1, 'invalid JSON');
      throw error;
    }
    if (record.v !== 1) return refuse(index + 1, 'unsupported record version');
    const item = parseItem(record.item);
    if (!item) return refuse(index + 1, 'invalid item');
    if (item.requestHash !== requestHashFor(item)) return refuse(index + 1, 'request hash does not match its payload');

    const previous = items.get(item.id);
    if (previous) {
      if (previous.operationId !== item.operationId || previous.requestHash !== item.requestHash) {
        return refuse(index + 1, 'event id was reused with a different operation or payload');
      }
      items.set(item.id, item);
      continue;
    }

    const operationOwner = operationOwners.get(item.operationId);
    if (operationOwner && operationOwner !== item.id) return refuse(index + 1, 'operation id is duplicated');
    const documentKey = JSON.stringify([item.bankId ?? null, item.endpoint ?? null, item.documentId]);
    const documentOwner = documentOwners.get(documentKey);
    if (documentOwner && documentOwner !== item.id) return refuse(index + 1, 'document id is duplicated for the same target');
    operationOwners.set(item.operationId, item.id);
    documentOwners.set(documentKey, item.id);

    if (!item.bankId || !item.endpoint) {
      if (item.state === 'pending' || item.state === 'sending' || item.state === 'sent' || item.state === 'done' || item.state === 'failed') {
        item.state = 'orphaned';
        item.lastError = 'this item predates bank/endpoint binding; choose a target before sending it';
      }
    }
    items.set(item.id, item);
  }
  return [...items.values()];
}

export class MemoryOutbox {
  private readonly items = new Map<string, OutboxItem>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log?: OutboxLog;
  private readonly maxActive: number;
  private readonly maxTotal: number;
  private readonly preserveFinished: boolean;
  private loaded = false;
  private persistenceError: string | null = null;
  private readError = false;
  private initializationError: string | null = null;
  /** Runtime-only poll order; fairness does not need a disk write every fifteen seconds. */
  private readonly polledAt = new Map<string, number>();
  readonly stateStore: MemoryStateStore | null;

  constructor(fileOrStore: string | MemoryStateStore, opts: { now?: () => Date; newId?: () => string; log?: OutboxLog; maxActive?: number; maxTotal?: number; preserveFinished?: boolean } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
    this.log = opts.log;
    this.maxActive = Math.max(1, opts.maxActive ?? MAX_ACTIVE);
    this.maxTotal = Math.max(this.maxActive, opts.maxTotal ?? MAX_TOTAL);
    this.preserveFinished = opts.preserveFinished === true;
    try {
      this.stateStore = typeof fileOrStore === 'string' ? openMemoryStateStore(fileOrStore) : fileOrStore;
      if (typeof fileOrStore === 'string' && extname(fileOrStore) === '.jsonl' && !this.stateStore.imported('outbox-v1')) {
        this.stateStore.importOutbox(readLegacyOutbox(fileOrStore, this.log));
      }
    } catch (error) {
      this.stateStore = null;
      this.initializationError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Load committed delivery state and drop finished metadata older than the audit window. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.stateStore) {
      this.loaded = false;
      this.readError = true;
      this.persistenceError = `could not open the memory database: ${this.initializationError ?? 'unavailable'}`;
      return;
    }
    try {
      for (const raw of this.stateStore.loadOutbox()) {
        const item = parseItem(raw);
        if (!item) throw new Error('invalid memory operation row');
        this.items.set(item.id, item);
      }
    } catch (err) {
      this.items.clear();
      this.loaded = false;
      this.readError = true;
      this.persistenceError = `could not read the memory database: ${err instanceof Error ? err.message : String(err)}`;
      this.log?.warn('[memory] could not read the retain outbox', { message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const before = new Map(this.items);
    const dropped = this.preserveFinished ? [] : this.dropExpiredFinished();
    if (dropped.length > 0) {
      try {
        this.stateStore.removeOutbox(dropped);
      } catch (err) {
        this.items.clear();
        for (const [id, item] of before) this.items.set(id, item);
        this.persistenceError = `could not prune finished retain metadata: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  /** Queue one item; it is acknowledged only after its SQLite transaction commits. */
  add(item: RetainItem): AddResult {
    this.load();
    if (!this.loaded) return 'persistence-error';
    if (!item.bankId || !item.endpoint) {
      this.persistenceError = 'the retain item has no bank/endpoint binding';
      this.log?.warn('[memory] retain item has no target binding', { documentId: item.documentId });
      return 'persistence-error';
    }
    // The document id is the source event identity. A replay never creates another remote write.
    for (const existing of this.items.values()) {
      if (existing.documentId !== item.documentId) continue;
      if (existing.bankId !== item.bankId || existing.endpoint !== item.endpoint) continue;
      if (existing.requestHash === requestHashFor({ ...item, bankId: item.bankId, endpoint: item.endpoint })) return 'queued';
      this.persistenceError = 'an event ID was reused with a different retain request';
      return 'persistence-error';
    }
    const at = iso(this.now());
    const active = this.activeCount();
    if (active >= this.maxTotal || (active >= this.maxActive && item.priority !== 'critical')) return 'full';
    const queued: OutboxItem = {
      ...item,
      id: this.newId(),
      documentId: item.documentId,
      operationId: this.newId(),
      bankId: item.bankId,
      endpoint: item.endpoint,
      state: 'pending',
      requestHash: '',
      attempts: 0,
      verificationAttempts: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    };
    queued.requestHash = requestHashFor(queued);
    if (!this.append(queued)) return 'persistence-error';
    this.items.set(queued.id, queued);
    return 'queued';
  }

  /** State of the source event already recorded for this document on the same target. */
  stateForDocument(documentId: string, bankId: string, endpoint: string): OutboxState | null {
    return this.itemForDocument(documentId, bankId, endpoint)?.state ?? null;
  }

  /** The source event already recorded for this document on the same target, or null when ambiguous. */
  itemForDocument(documentId: string, bankId: string, endpoint: string): OutboxItem | null {
    const matches = this.itemsForDocument(documentId, bankId, endpoint);
    return matches.length === 1 ? matches[0]! : null;
  }

  /** Every local identity matching this exact target; used to fail closed on duplicate identities. */
  itemsForDocument(documentId: string, bankId: string, endpoint: string): OutboxItem[] {
    this.load();
    return [...this.items.values()].filter((entry) => entry.documentId === documentId
      && entry.bankId === bankId && entry.endpoint === endpoint);
  }

  /** Promote the source event already recorded for the current user message. */
  promoteDocument(documentId: string, bankId: string, endpoint: string): OutboxState | null {
    this.load();
    const item = [...this.items.values()].find((entry) => entry.documentId === documentId
      && entry.bankId === bankId && entry.endpoint === endpoint);
    if (!item || !this.update(item.id, (current) => ({ ...current, priority: 'critical' }))) return null;
    return this.items.get(item.id)?.state ?? null;
  }

  /** Link the current user event to the earlier sources it corrects without creating a duplicate. */
  linkCorrection(documentId: string, bankId: string, endpoint: string, sourceIds: readonly string[]): OutboxState | null {
    this.load();
    const item = [...this.items.values()].find((entry) => entry.documentId === documentId
      && entry.bankId === bankId && entry.endpoint === endpoint);
    if (!item || ['cancelled', 'dead', 'orphaned'].includes(item.state) || !this.stateStore) return null;
    const before = item;
    try {
      return this.stateStore.transaction(() => {
        if (!this.stateStore!.linkRevision(item.id, sourceIds)) throw new Error('the correction event could not be linked');
        if (!this.update(item.id, (current) => ({ ...current, priority: 'critical' }))) throw new Error('the correction event could not be promoted');
        return this.items.get(item.id)?.state ?? null;
      });
    } catch (error) {
      this.items.set(item.id, before);
      this.persistenceError = `could not link the correction event: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  /** Pending or failed items whose retry time has come, oldest first. */
  due(now: Date, limit: number): OutboxItem[] {
    this.load();
    this.isolateChangedRequests();
    const at = now.getTime();
    return [...this.items.values()]
      .filter((item) => (item.state === 'pending' || item.state === 'failed')
        && item.requestHash === requestHashFor(item)
        && Date.parse(item.nextAttemptAt) <= at)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));
  }

  /** Requests that may have reached the service, least recently polled first. */
  sent(limit: number, now: Date = this.now()): OutboxItem[] {
    this.load();
    this.isolateChangedRequests();
    return [...this.items.values()]
      .filter((item) => (item.state === 'sending' || item.state === 'sent')
        && item.requestHash === requestHashFor(item)
        && (!item.nextPollAt || Date.parse(item.nextPollAt) <= now.getTime()))
      .sort((a, b) => (this.polledAt.get(a.id) ?? 0) - (this.polledAt.get(b.id) ?? 0) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));
  }

  /** Completed operations whose source document has not yet been read back. */
  verificationDue(limit: number, now: Date = this.now()): OutboxItem[] {
    this.load();
    return [...this.items.values()]
      .filter((item) => item.state === 'done' && item.requestHash === requestHashFor(item)
        && (!item.nextVerifyAt || Date.parse(item.nextVerifyAt) <= now.getTime()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, limit));
  }

  /** Move an operation to the back of the poll order. */
  markPolled(id: string): void {
    this.polledAt.set(id, Date.now());
  }

  /** Persist the operation ID before starting a request whose acknowledgement may be lost. */
  markSending(id: string): boolean {
    return this.update(id, (item) => ({ ...item, state: 'sending', lastError: undefined }), ['pending', 'failed']);
  }

  markSent(id: string, operationId: string): boolean {
    return this.update(id, (item) => ({ ...item, operationId, state: 'sent', nextPollAt: undefined, lastError: undefined }), ['pending', 'sending', 'failed']);
  }

  markDone(id: string): boolean {
    const changed = this.update(id, (item) => ({
      ...item,
      state: 'done',
      nextVerifyAt: iso(this.now()),
      verificationAttempts: 0,
      lastError: undefined,
    }), ['pending', 'sending', 'sent', 'failed', 'orphaned']);
    this.polledAt.delete(id);
    return changed;
  }

  markVerified(id: string): boolean {
    return this.update(id, (item) => ({
      ...item, state: 'verified', content: '', metadata: undefined, nextVerifyAt: undefined, lastError: undefined,
    }), ['done']);
  }

  /**
   * Records an already-delivered source after an authorized external reconciliation. This only
   * changes local state; it never contacts the Bank or runs delivery. The exact request hash and
   * target must match, and only one item is touched.
   */
  reconcileVerifiedDelivery(input: {
    documentId: string;
    bankId: string;
    endpoint: string;
    requestHash: string;
    receipt: string;
  }): 'updated' | 'already' | 'not-found' | 'conflict' {
    this.load();
    if (!RECEIPT_DIGEST.test(input.receipt)) return 'conflict';
    const item = this.itemForDocument(input.documentId, input.bankId, input.endpoint);
    if (!item) return 'not-found';
    if (item.requestHash !== input.requestHash) return 'conflict';
    if (item.state === 'verified') return 'already';
    if (!['pending', 'sent', 'done'].includes(item.state)) return 'conflict';
    if (!this.stateStore) return 'conflict';
    const next = this.reconciledItem(item, input.receipt);
    const changed = this.stateStore.updateOutboxRecord(next);
    if (changed) this.items.set(item.id, next);
    return changed ? 'updated' : 'conflict';
  }

  private reconciledItem(item: OutboxItem, receipt: string): OutboxItem {
    return {
      ...item,
      state: 'verified',
      content: '',
      metadata: undefined,
      nextVerifyAt: undefined,
      lastError: undefined,
      reconciledAt: iso(this.now()),
      reconcileReceipt: receipt,
      updatedAt: iso(this.now()),
    };
  }

  /**
   * Applies one authorized reconciliation in a single SQLite transaction. Every target must have
   * an exact identity and request hash; any mismatch rolls the whole batch back. Already-verified
   * rows are counted without a write. This never calls replaceOutbox, delivery or the Bank.
   */
  reconcileVerifiedDeliveries(inputs: ReadonlyArray<{
    documentId: string;
    bankId: string;
    endpoint: string;
    requestHash: string;
    receipt: string;
  }>): { updated: number; already: number } {
    this.load();
    if (!this.stateStore || this.items.size === 0) throw new Error('the memory database is unavailable');
    const prepared: Array<{ id: string; already: boolean; receipt: string }> = [];
    const identities = new Set<string>();
    for (const input of inputs) {
      if (!RECEIPT_DIGEST.test(input.receipt)) throw new Error('the reconciliation receipt is not a SHA-256 digest');
      const matches = this.itemsForDocument(input.documentId, input.bankId, input.endpoint);
      if (matches.length === 0) throw new Error('a reconciliation target is missing');
      if (matches.length > 1) throw new Error('a reconciliation target is ambiguous');
      const item = matches[0]!;
      if (item.requestHash !== input.requestHash) throw new Error('a reconciliation target request hash does not match');
      const identity = JSON.stringify([input.bankId, input.endpoint, input.documentId]);
      if (identities.has(identity)) throw new Error('a reconciliation target is duplicated');
      identities.add(identity);
      if (item.state === 'verified') prepared.push({ id: item.id, already: true, receipt: input.receipt });
      else if (['pending', 'sent', 'done'].includes(item.state)) prepared.push({ id: item.id, already: false, receipt: input.receipt });
      else throw new Error('a reconciliation target is not in a reconcilable state');
    }
    const before = new Map(this.items);
    let updated = 0, already = 0;
    try {
      this.stateStore.transaction(() => {
        for (const entry of prepared) {
          if (entry.already) { already += 1; continue; }
          const current = this.items.get(entry.id);
          if (!current) throw new Error('a reconciliation row disappeared');
          const next = this.reconciledItem(current, entry.receipt);
          if (!this.stateStore!.updateOutboxRecord(next)) throw new Error('a reconciliation row could not be updated');
          this.items.set(entry.id, next);
          updated += 1;
        }
      });
    } catch (error) {
      this.items.clear();
      for (const [id, item] of before) this.items.set(id, item);
      throw error;
    }
    return { updated, already };
  }

  noteVerificationRetry(id: string, error: string): boolean {
    return this.update(id, (item) => {
      const attempts = item.verificationAttempts + 1;
      const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempts, 8));
      return {
        ...item,
        verificationAttempts: attempts,
        nextVerifyAt: iso(new Date(this.now().getTime() + delay)),
        lastError: error.slice(0, 300),
      };
    }, ['done']);
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
    }, ['pending', 'sending', 'sent', 'failed']);
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
    }, ['sending', 'sent']);
  }

  markCancelled(id: string, reason: string): boolean {
    const changed = this.update(id, (item) => ({ ...item, state: 'cancelled', content: '', metadata: undefined, nextVerifyAt: undefined, lastError: reason.slice(0, 300) }), ['pending', 'sending', 'sent', 'done', 'failed', 'orphaned']);
    this.polledAt.delete(id);
    return changed;
  }

  /** Active items matching a predicate, without changing their state. */
  matching(match: (item: OutboxItem) => boolean): OutboxItem[] {
    this.load();
    return [...this.items.values()].filter((item) =>
      (item.state === 'pending' || item.state === 'sending' || item.state === 'failed' || item.state === 'sent' || item.state === 'done' || item.state === 'orphaned') && match(item));
  }

  /**
   * The newest source for a document prefix inside a time window, finished items included. A
   * "don't remember that" request after a restart still finds what it is about.
   */
  recentDocument(prefix: string, since: Date): OutboxItem | null {
    this.load();
    let found: OutboxItem | null = null;
    for (const item of this.items.values()) {
      if (item.state === 'cancelled') continue;
      if (!item.documentId.startsWith(prefix)) continue;
      if (Date.parse(item.createdAt) < since.getTime()) continue;
      if (!found || item.createdAt > found.createdAt) found = item;
    }
    return found;
  }

  /** Cancel queued or in-flight items matching a forget request; returns only persisted cancellations. */
  cancelMatching(match: (item: OutboxItem) => boolean, reason: string): OutboxItem[] {
    this.load();
    const cancelled: OutboxItem[] = [];
    for (const item of this.items.values()) {
      if (item.state !== 'pending' && item.state !== 'sending' && item.state !== 'failed' && item.state !== 'sent' && item.state !== 'done' && item.state !== 'orphaned') continue;
      if (!match(item)) continue;
      if (!this.update(item.id, (current) => ({ ...current, state: 'cancelled', content: '', metadata: undefined, nextVerifyAt: undefined, lastError: reason.slice(0, 300) }))) continue;
      this.polledAt.delete(item.id);
      cancelled.push(item);
    }
    return cancelled;
  }

  cancelAll(reason: string): OutboxItem[] {
    return this.cancelMatching((item) => item.state !== 'verified' && item.state !== 'cancelled' && item.state !== 'dead', reason);
  }

  /** Isolate an item whose persisted target no longer matches the running config. */
  quarantine(id: string, reason: string): boolean {
    return this.update(id, (item) => ({ ...item, state: 'orphaned', nextVerifyAt: undefined, lastError: reason.slice(0, 300) }), ['pending', 'sending', 'sent', 'done', 'failed']);
  }

  /** Explicitly bind an isolated item to a new target; the old operation id is never reused. */
  rebind(id: string, bankId: string, endpoint: string): boolean {
    return this.update(id, (item) => ({
      ...item,
      bankId,
      endpoint,
      operationId: this.newId(),
      requestHash: requestHashFor({ ...item, bankId, endpoint }),
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

  /** Why the last queue write or load failed; null when the queue is healthy or no attempt failed. */
  persistenceReason(): string | null {
    return this.persistenceError;
  }

  get(id: string): OutboxItem | null {
    this.load();
    return this.items.get(id) ?? null;
  }

  readable(): boolean {
    this.load();
    return !!this.stateStore && this.loaded && !this.readError;
  }

  reload(): void {
    this.items.clear();
    this.polledAt.clear();
    this.loaded = false;
    this.persistenceError = null;
    this.readError = false;
  }

  status(): OutboxStatus {
    this.load();
    const counts = { pending: 0, sent: 0, completed: 0, unverified: 0, verified: 0, failed: 0, dead: 0, cancelled: 0, orphaned: 0 };
    let deadRetained = 0;
    let oldest: string | null = null;
    let lastError: string | null = null;
    let lastErrorAt = '';
    for (const item of this.items.values()) {
      if (item.state === 'pending' || item.state === 'failed') counts[item.state] += 1;
      else if (item.state === 'sending' || item.state === 'sent') counts.sent += 1;
      if (item.state === 'done') {
        counts.completed += 1;
        counts.unverified += 1;
      }
      if (item.state === 'verified') counts.verified += 1;
      if (item.state === 'dead') {
        counts.dead += 1;
        if (this.retained(item)) deadRetained += 1;
      }
      if (item.state === 'cancelled') counts.cancelled += 1;
      if (item.state === 'orphaned') counts.orphaned += 1;
      if ((item.state === 'pending' || item.state === 'sending' || item.state === 'done' || item.state === 'failed') && (!oldest || item.createdAt < oldest)) oldest = item.createdAt;
      if (item.lastError && item.updatedAt > lastErrorAt) {
        lastError = item.lastError;
        lastErrorAt = item.updatedAt;
      }
    }
    const active = counts.pending + counts.sent + counts.failed + deadRetained + counts.unverified;
    return {
      ...counts,
      deadRetained,
      active,
      full: active >= this.maxActive,
      oldestPendingAt: oldest,
      lastError,
      persistenceError: this.persistenceError,
    };
  }

  /** Remove expired status rows while retaining every unresolved payload. */
  compact(): boolean {
    this.load();
    if (!this.loaded) return false;
    const before = new Map(this.items);
    if (!this.preserveFinished) this.dropExpiredFinished();
    try {
      if (!this.stateStore) throw new Error(this.initializationError ?? 'memory database is unavailable');
      this.stateStore.replaceOutbox([...this.items.values()]);
      this.persistenceError = null;
      return true;
    } catch (err) {
      this.items.clear();
      for (const [id, item] of before) this.items.set(id, item);
      this.persistenceError = `could not compact the memory database: ${err instanceof Error ? err.message : String(err)}`;
      this.log?.warn('[memory] could not compact the retain outbox', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private activeCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.state === 'pending' || item.state === 'sending' || item.state === 'sent' || item.state === 'failed') count += 1;
      else if (item.state === 'done') count += 1;
      else if (this.retained(item)) count += 1;
    }
    return count;
  }

  /** A dead item whose payload is the only remaining copy of a fact the person asked to keep. */
  private retained(item: OutboxItem): boolean {
    return item.state === 'dead' && item.content.length > 0;
  }

  private isolateChangedRequests(): void {
    for (const item of this.items.values()) {
      if (!['pending', 'sending', 'sent', 'done', 'failed'].includes(item.state) || item.requestHash === requestHashFor(item)) continue;
      this.update(item.id, (current) => ({
        ...current,
        state: 'orphaned',
        lastError: 'the saved retain request does not match its committed hash',
      }));
    }
  }

  /**
   * Delivery rows are the local audit trail for retain, verification and cancellation. A load
   * must not delete a verified or cancelled row merely because it is old: it is the only local
   * proof that the event was delivered once, and the W3 incident showed that losing it invites a
   * second delivery. Explicit console/Forget cleanup owns any later removal.
   */
  private dropExpiredFinished(): string[] {
    return [];
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
    try {
      if (!this.stateStore) throw new Error(this.initializationError ?? 'memory database is unavailable');
      this.stateStore.saveOutbox(item);
      this.persistenceError = null;
      return true;
    } catch (err) {
      this.persistenceError = `could not write the memory database: ${err instanceof Error ? err.message : String(err)}`;
      this.log?.warn('[memory] could not save the retain outbox item', { id: item.id, message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private persistAll(): boolean {
    try {
      if (!this.stateStore) throw new Error(this.initializationError ?? 'memory database is unavailable');
      this.stateStore.replaceOutbox([...this.items.values()]);
      this.persistenceError = null;
      return true;
    } catch (err) {
      this.persistenceError = `could not write the memory database: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }
}
