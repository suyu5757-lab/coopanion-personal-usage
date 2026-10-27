import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface ForgetStateSnapshot {
  v: 2;
  tasks: object[];
  tombstones: object[];
  epochs: Record<string, number>;
  stale: string[];
}

export interface LegacyMemoryImport {
  outbox: object[];
  forget: ForgetStateSnapshot;
  forgetDamaged: boolean;
}

const HASH = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function stateDatabasePath(file: string): string {
  const path = resolve(file);
  return ['.sqlite', '.db'].includes(extname(path)) ? path : resolve(dirname(path), 'memory-state.sqlite');
}

const stores = new Map<string, MemoryStateStore>();

export function openMemoryStateStore(file: string): MemoryStateStore {
  const path = stateDatabasePath(file);
  let store = stores.get(path);
  if (!store) {
    store = new MemoryStateStore(path);
    stores.set(path, store);
  }
  return store;
}

export function closeMemoryStateStores(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}

/** Application-private SQLite state for memory delivery and source visibility. */
export class MemoryStateStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private transactionDepth = 0;
  private closed = false;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
    this.restrictFilePermissions();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 2) {
      this.db.close();
      this.closed = true;
      throw new Error(`memory database schema ${version} is newer than this application`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        actor TEXT,
        occurred_at TEXT,
        intent TEXT NOT NULL,
        status TEXT,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_operations (
        event_id TEXT PRIMARY KEY REFERENCES memory_events(event_id) ON DELETE CASCADE,
        bank_id TEXT,
        endpoint TEXT,
        document_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        next_poll_at TEXT,
        updated_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_operations_due
        ON memory_operations(state, next_attempt_at, updated_at);
      CREATE INDEX IF NOT EXISTS memory_operations_source
        ON memory_operations(bank_id, endpoint, document_id);
      CREATE TABLE IF NOT EXISTS memory_revisions (
        event_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        document_id TEXT NOT NULL,
        supersedes_document_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(event_id, supersedes_document_id)
      );
      CREATE INDEX IF NOT EXISTS memory_revisions_current
        ON memory_revisions(bank_id, endpoint, supersedes_document_id, state);
      CREATE TABLE IF NOT EXISTS memory_deletions (
        task_id TEXT PRIMARY KEY,
        bank_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        document_id TEXT NOT NULL,
        operation_id TEXT,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        verifications INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_deletions_due
        ON memory_deletions(state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS memory_fences (
        bank_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        document_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(bank_id, endpoint, document_id)
      );
      CREATE TABLE IF NOT EXISTS memory_derived_state (
        bank_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        stale INTEGER NOT NULL,
        PRIMARY KEY(bank_id, endpoint)
      );
    `);
    if (version < 2) this.db.exec('PRAGMA user_version = 2;');
    this.restrictFilePermissions();
    const check = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') {
      this.db.close();
      this.closed = true;
      throw new Error(`memory database integrity check failed: ${check?.quick_check ?? 'no result'}`);
    }
  }

  transaction<T>(run: () => T): T {
    this.assertOpen();
    if (this.transactionDepth > 0) return run();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const value = run();
      this.restrictFilePermissions();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* The original database error is the useful one. */ }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  imported(name: 'outbox-v1' | 'forget-v1'): boolean {
    this.assertOpen();
    return this.meta(`legacy:${name}`) === '1';
  }

  importLegacy(imported: LegacyMemoryImport): void {
    this.transaction(() => {
      this.importOutbox(imported.outbox);
      this.importForget(imported.forget, imported.forgetDamaged);
    });
  }

  importOutbox(items: readonly object[]): void {
    this.transaction(() => {
      if (this.meta('legacy:outbox-v1') === '1') return;
      const rowCount = this.db.prepare('SELECT COUNT(*) AS count FROM memory_operations').get() as { count: number };
      if (rowCount.count > 0) throw new Error('memory database has unmarked delivery rows; refusing legacy import');
      for (const item of items) this.writeOutbox(item);
      this.setMeta('legacy:outbox-v1', '1');
    });
  }

  importForget(state: ForgetStateSnapshot, damaged: boolean): void {
    this.transaction(() => {
      if (this.meta('legacy:forget-v1') === '1') return;
      const rowCount = this.db.prepare('SELECT COUNT(*) AS count FROM memory_deletions').get() as { count: number };
      if (rowCount.count > 0) throw new Error('memory database has unmarked deletion rows; refusing legacy import');
      this.writeForgetState(state, damaged);
      this.setMeta('legacy:forget-v1', '1');
    });
  }

  loadOutbox(): Array<Record<string, unknown>> {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT o.record_json, o.payload_hash AS operation_hash, e.payload_hash AS event_hash
      FROM memory_operations o JOIN memory_events e USING(event_id)
      ORDER BY o.updated_at, o.event_id
    `).all() as Array<{ record_json: string; operation_hash: string; event_hash: string }>;
    return rows.map((row) => {
      const item = JSON.parse(row.record_json) as Record<string, unknown>;
      if (item.requestHash !== row.operation_hash || row.operation_hash !== row.event_hash) {
        throw new Error('memory request hash does not match the committed event and operation');
      }
      return item;
    });
  }

  saveOutbox(item: object): void {
    this.transaction(() => this.writeOutbox(item));
  }

  replaceOutbox(items: readonly object[]): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM memory_operations; DELETE FROM memory_events;');
      for (const item of items) this.writeOutbox(item);
    });
  }

  supersededSources(bankId: string, endpoint: string): Set<string> {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT DISTINCT supersedes_document_id FROM memory_revisions
      WHERE bank_id = ? AND endpoint = ? AND state = 'active'
    `).all(bankId, endpoint) as Array<{ supersedes_document_id: string }>;
    return new Set(rows.map((row) => row.supersedes_document_id));
  }

  currentRevisionSources(bankId: string, endpoint: string): Set<string> {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT DISTINCT document_id FROM memory_revisions
      WHERE bank_id = ? AND endpoint = ? AND state = 'active'
    `).all(bankId, endpoint) as Array<{ document_id: string }>;
    const superseded = this.supersededSources(bankId, endpoint);
    return new Set(rows.map((row) => row.document_id).filter((id) => !superseded.has(id)));
  }

  linkRevision(eventId: string, supersededDocumentIds: readonly string[]): boolean {
    return this.transaction(() => {
      const item = this.db.prepare(`
        SELECT bank_id, endpoint, document_id, state, updated_at FROM memory_operations WHERE event_id = ?
      `).get(eventId) as { bank_id: string | null; endpoint: string | null; document_id: string; state: string; updated_at: string } | undefined;
      if (!item?.bank_id || !item.endpoint || supersededDocumentIds.length === 0) return false;
      const state = item.state === 'verified' ? 'active'
        : item.state === 'done' ? 'completed'
        : item.state === 'dead' || item.state === 'cancelled' || item.state === 'orphaned' ? 'failed' : 'pending';
      this.db.prepare('DELETE FROM memory_revisions WHERE event_id = ?').run(eventId);
      const insert = this.db.prepare(`
        INSERT INTO memory_revisions(event_id, bank_id, endpoint, document_id, supersedes_document_id, state, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `);
      for (const sourceId of new Set(supersededDocumentIds.filter(Boolean))) {
        insert.run(eventId, item.bank_id, item.endpoint, item.document_id, sourceId, state, item.updated_at);
      }
      return true;
    });
  }

  revisionDependents(bankId: string, endpoint: string, sourceIds: readonly string[]): string[] {
    this.assertOpen();
    const unique = [...new Set(sourceIds.filter(Boolean))];
    if (unique.length === 0) return [];
    const params = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT DISTINCT document_id FROM memory_revisions
      WHERE bank_id = ? AND endpoint = ? AND supersedes_document_id IN (${params})
    `).all(bankId, endpoint, ...unique) as Array<{ document_id: string }>;
    return rows.map((row) => row.document_id);
  }

  loadForgetState(): { state: ForgetStateSnapshot | null; damaged: boolean } {
    this.assertOpen();
    if (this.meta('forget:present') !== '1') return { state: null, damaged: this.meta('forget:damaged') === '1' };
    if (this.meta('forget:damaged') === '1') return { state: null, damaged: true };
    try {
      const tasks = (this.db.prepare('SELECT record_json FROM memory_deletions ORDER BY task_id').all() as Array<{ record_json: string }>)
        .map((row) => JSON.parse(row.record_json) as Record<string, unknown>);
      const tombstones = this.db.prepare('SELECT bank_id, endpoint, document_id, reason, created_at FROM memory_fences ORDER BY created_at')
        .all() as Array<{ bank_id: string; endpoint: string; document_id: string; reason: string; created_at: string }>;
      const targets = this.db.prepare('SELECT bank_id, endpoint, epoch, stale FROM memory_derived_state').all() as
        Array<{ bank_id: string; endpoint: string; epoch: number; stale: number }>;
      const epochs: Record<string, number> = {};
      const stale: string[] = [];
      for (const target of targets) {
        const id = JSON.stringify([target.bank_id, target.endpoint]);
        if (target.epoch > 0) epochs[id] = target.epoch;
        if (target.stale === 1) stale.push(id);
      }
      return {
        state: {
          v: 2,
          tasks,
          tombstones: tombstones.map((entry) => ({ bankId: entry.bank_id, endpoint: entry.endpoint, documentId: entry.document_id, reason: entry.reason, at: entry.created_at })),
          epochs,
          stale,
        },
        damaged: false,
      };
    } catch {
      return { state: null, damaged: true };
    }
  }

  saveForgetState(state: ForgetStateSnapshot): void {
    this.transaction(() => this.writeForgetState(state, false));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private writeOutbox(raw: object): void {
    const item = raw as {
      id?: unknown; bankId?: unknown; endpoint?: unknown; documentId?: unknown; operationId?: unknown;
      state?: unknown; attempts?: unknown; nextAttemptAt?: unknown; nextPollAt?: unknown; updatedAt?: unknown;
      createdAt?: unknown;
      content?: unknown; context?: unknown; tags?: unknown; metadata?: unknown; timestamp?: unknown;
      priority?: unknown; requestHash?: unknown;
    };
    if (typeof item.id !== 'string' || typeof item.documentId !== 'string'
      || ((typeof item.bankId !== 'string' || typeof item.endpoint !== 'string') && item.state !== 'orphaned')
      || typeof item.operationId !== 'string' || typeof item.state !== 'string'
      || typeof item.nextAttemptAt !== 'string' || typeof item.updatedAt !== 'string') {
      throw new Error('invalid memory operation record');
    }
    const payload = {
      documentId: item.documentId,
      content: typeof item.content === 'string' ? item.content : '',
      context: typeof item.context === 'string' ? item.context : '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      metadata: item.metadata ?? null,
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : null,
    };
    const hash = typeof item.requestHash === 'string' ? item.requestHash : HASH(payload);
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
    const event = this.db.prepare(`
      INSERT INTO memory_events(event_id, document_id, actor, occurred_at, intent, status, payload_hash, payload_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET document_id=excluded.document_id, actor=excluded.actor,
        occurred_at=excluded.occurred_at, intent=excluded.intent, status=excluded.status,
        payload_hash=excluded.payload_hash, payload_json=excluded.payload_json
    `);
    event.run(
      item.id,
      item.documentId,
      typeof metadata.source_actor === 'string' ? metadata.source_actor : null,
      typeof metadata.said_at === 'string' ? metadata.said_at : typeof item.timestamp === 'string' ? item.timestamp : null,
      item.priority === 'critical' ? 'explicit' : 'automatic',
      typeof metadata.status === 'string' ? metadata.status : null,
      hash,
      JSON.stringify(payload),
    );
    this.db.prepare(`
      INSERT INTO memory_operations(event_id, bank_id, endpoint, document_id, operation_id, state, attempts,
        next_attempt_at, next_poll_at, updated_at, payload_hash, record_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET bank_id=excluded.bank_id, endpoint=excluded.endpoint,
        document_id=excluded.document_id, operation_id=excluded.operation_id, state=excluded.state, attempts=excluded.attempts,
        next_attempt_at=excluded.next_attempt_at, next_poll_at=excluded.next_poll_at,
        updated_at=excluded.updated_at, payload_hash=excluded.payload_hash, record_json=excluded.record_json
    `).run(
      item.id, typeof item.bankId === 'string' ? item.bankId : null,
      typeof item.endpoint === 'string' ? item.endpoint : null,
      item.documentId, item.operationId, item.state,
      typeof item.attempts === 'number' ? item.attempts : 0, item.nextAttemptAt,
      typeof item.nextPollAt === 'string' ? item.nextPollAt : null, item.updatedAt, hash, JSON.stringify(raw),
    );
    const sourceIds = typeof metadata.supersedes_source_ids === 'string'
      ? (() => {
          try {
            const value = JSON.parse(metadata.supersedes_source_ids) as unknown;
            return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
          } catch { return []; }
        })()
      : [];
    const revisionState = item.state === 'verified' ? 'active'
      : item.state === 'done' ? 'completed'
      : item.state === 'dead' || item.state === 'cancelled' ? 'failed' : 'pending';
    if (sourceIds.length > 0) this.db.prepare('DELETE FROM memory_revisions WHERE event_id = ?').run(item.id);
    else this.db.prepare('UPDATE memory_revisions SET state = ? WHERE event_id = ?').run(revisionState, item.id);
    const revision = this.db.prepare(`
      INSERT INTO memory_revisions(event_id, bank_id, endpoint, document_id, supersedes_document_id, state, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    for (const sourceId of sourceIds) {
      if (typeof item.bankId !== 'string' || typeof item.endpoint !== 'string') continue;
      revision.run(item.id, item.bankId, item.endpoint, item.documentId, sourceId, revisionState,
        typeof item.createdAt === 'string' ? item.createdAt : item.updatedAt);
    }
  }

  private writeForgetState(state: ForgetStateSnapshot, damaged: boolean): void {
    this.db.exec('DELETE FROM memory_deletions; DELETE FROM memory_fences; DELETE FROM memory_derived_state;');
    const task = this.db.prepare(`
      INSERT INTO memory_deletions(task_id, bank_id, endpoint, document_id, operation_id, state,
        attempts, verifications, next_attempt_at, record_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const raw of state.tasks) {
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.bankId !== 'string' || typeof entry.endpoint !== 'string'
        || typeof entry.documentId !== 'string' || typeof entry.state !== 'string' || typeof entry.nextAttemptAt !== 'string') {
        throw new Error('invalid memory deletion record');
      }
      task.run(entry.id, entry.bankId, entry.endpoint, entry.documentId,
        typeof entry.operationId === 'string' ? entry.operationId : null, entry.state,
        typeof entry.attempts === 'number' ? entry.attempts : 0, typeof entry.verifications === 'number' ? entry.verifications : 0,
        entry.nextAttemptAt, JSON.stringify(entry));
    }
    const fence = this.db.prepare(`
      INSERT INTO memory_fences(bank_id, endpoint, document_id, reason, created_at) VALUES(?, ?, ?, ?, ?)
    `);
    for (const raw of state.tombstones) {
      const entry = raw as Record<string, unknown>;
      if (typeof entry.bankId !== 'string' || typeof entry.endpoint !== 'string' || typeof entry.documentId !== 'string'
        || typeof entry.reason !== 'string' || typeof entry.at !== 'string') throw new Error('invalid memory fence');
      fence.run(entry.bankId, entry.endpoint, entry.documentId, entry.reason, entry.at);
    }
    const targets = new Map<string, { bankId: string; endpoint: string; epoch: number; stale: number }>();
    for (const [encoded, epoch] of Object.entries(state.epochs)) {
      let parts: unknown;
      try { parts = JSON.parse(encoded); } catch { continue; }
      if (!Array.isArray(parts) || typeof parts[0] !== 'string' || typeof parts[1] !== 'string' || typeof epoch !== 'number') continue;
      targets.set(encoded, { bankId: parts[0], endpoint: parts[1], epoch, stale: 0 });
    }
    for (const encoded of state.stale) {
      let parts: unknown;
      try { parts = JSON.parse(encoded); } catch { continue; }
      if (!Array.isArray(parts) || typeof parts[0] !== 'string' || typeof parts[1] !== 'string') continue;
      const target = targets.get(encoded) ?? { bankId: parts[0], endpoint: parts[1], epoch: 0, stale: 0 };
      target.stale = 1;
      targets.set(encoded, target);
    }
    const derived = this.db.prepare('INSERT INTO memory_derived_state(bank_id, endpoint, epoch, stale) VALUES(?, ?, ?, ?)');
    for (const target of targets.values()) derived.run(target.bankId, target.endpoint, target.epoch, target.stale);
    this.setMeta('forget:present', '1');
    this.setMeta('forget:damaged', damaged ? '1' : '0');
  }

  private meta(key: string): string | null {
    this.assertOpen();
    const row = this.db.prepare('SELECT value FROM memory_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO memory_metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory database is closed');
  }

  private restrictFilePermissions(): void {
    if (process.platform === 'win32') return;
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
}
