import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type FixtureDatabase = InstanceType<typeof DatabaseSync>;

const BASE_SCHEMA = `
  CREATE TABLE memory_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE memory_events (
    event_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, actor TEXT, occurred_at TEXT,
    intent TEXT NOT NULL, status TEXT, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE TABLE memory_operations (
    event_id TEXT PRIMARY KEY REFERENCES memory_events(event_id) ON DELETE CASCADE,
    bank_id TEXT, endpoint TEXT, document_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
    next_poll_at TEXT, updated_at TEXT NOT NULL, payload_hash TEXT NOT NULL, record_json TEXT NOT NULL
  );
  CREATE INDEX memory_operations_due ON memory_operations(state, next_attempt_at, updated_at);
  CREATE INDEX memory_operations_source ON memory_operations(bank_id, endpoint, document_id);
  CREATE TABLE memory_revisions (
    event_id TEXT NOT NULL, bank_id TEXT NOT NULL, endpoint TEXT NOT NULL, document_id TEXT NOT NULL,
    supersedes_document_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(event_id, supersedes_document_id)
  );
  CREATE INDEX memory_revisions_current ON memory_revisions(bank_id, endpoint, supersedes_document_id, state);
  CREATE TABLE memory_deletions (
    task_id TEXT PRIMARY KEY, bank_id TEXT NOT NULL, endpoint TEXT NOT NULL, document_id TEXT NOT NULL,
    operation_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL, verifications INTEGER NOT NULL,
    next_attempt_at TEXT NOT NULL, record_json TEXT NOT NULL
  );
  CREATE INDEX memory_deletions_due ON memory_deletions(state, next_attempt_at);
  CREATE TABLE memory_fences (
    bank_id TEXT NOT NULL, endpoint TEXT NOT NULL, document_id TEXT NOT NULL,
    reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(bank_id, endpoint, document_id)
  );
  CREATE TABLE memory_derived_state (
    bank_id TEXT NOT NULL, endpoint TEXT NOT NULL, epoch INTEGER NOT NULL, stale INTEGER NOT NULL,
    PRIMARY KEY(bank_id, endpoint)
  );
`;

const V3_SCHEMA = `
  CREATE TABLE memory_activation (
    bank_id TEXT NOT NULL, endpoint TEXT NOT NULL, document_id TEXT NOT NULL,
    activation_anchor_weight REAL NOT NULL, activation_anchor_at TEXT NOT NULL,
    half_life_days REAL NOT NULL, epsilon REAL NOT NULL, params_version TEXT NOT NULL,
    last_user_mention_at TEXT, last_reinforced_at TEXT, last_retrieved_at TEXT,
    independent_mention_count INTEGER NOT NULL, source_epoch INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(bank_id, endpoint, document_id)
  );
  CREATE TABLE memory_mention_events (
    mention_event_id TEXT PRIMARY KEY, bank_id TEXT NOT NULL, endpoint TEXT NOT NULL,
    target_document_id TEXT NOT NULL, user_event_document_id TEXT NOT NULL, user_event_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    spacing_bucket TEXT NOT NULL CHECK(spacing_bucket IN ('initial', 'same-turn', 'same-day', 'cross-day')),
    semantic_match REAL NOT NULL CHECK(semantic_match >= 0 AND semantic_match <= 1),
    intensity REAL NOT NULL CHECK(intensity >= 0 AND intensity <= 1),
    source_type TEXT NOT NULL CHECK(source_type = 'user_mention'),
    applied_boost REAL NOT NULL CHECK(applied_boost >= 0 AND applied_boost <= 1),
    source_epoch INTEGER NOT NULL, params_version TEXT NOT NULL,
    UNIQUE(bank_id, endpoint, target_document_id, user_event_document_id)
  );
  CREATE INDEX memory_mention_events_day ON memory_mention_events(bank_id, endpoint, target_document_id, occurred_at);
  CREATE INDEX memory_mention_events_source ON memory_mention_events(bank_id, endpoint, user_event_document_id);
`;

const LEGACY_TABLES = [
  'memory_metadata', 'memory_events', 'memory_operations', 'memory_revisions', 'memory_deletions',
  'memory_fences', 'memory_derived_state', 'memory_activation', 'memory_mention_events',
] as const;

export type LegacyMemorySchemaVersion = 2 | 3;

export function createLegacyMemoryStateDatabase(path: string, version: LegacyMemorySchemaVersion): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(BASE_SCHEMA);
    if (version === 3) db.exec(V3_SCHEMA);
    db.exec(`PRAGMA user_version = ${version}`);
    seedDurableRows(db, version);
  } finally {
    db.close();
  }
}

export function openLegacyMemoryStateDatabase(path: string): FixtureDatabase {
  return new DatabaseSync(path);
}

export function snapshotLegacyDurableRows(db: FixtureDatabase, version: LegacyMemorySchemaVersion): string {
  const tables = version === 3 ? LEGACY_TABLES : LEGACY_TABLES.slice(0, 7);
  return JSON.stringify(tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
  ]));
}

function seedDurableRows(db: FixtureDatabase, version: LegacyMemorySchemaVersion): void {
  const payload = { documentId: 'legacy-doc', content: 'Synthetic retained row.', context: 'fixture', tags: ['scope:test'] };
  const payloadHash = 'a'.repeat(64);
  const record = {
    id: 'legacy-event', bankId: 'legacy-bank', endpoint: 'https://memory.test', documentId: 'legacy-doc',
    operationId: 'legacy-operation', state: 'pending', attempts: 2,
    nextAttemptAt: '2026-11-02T09:00:00.000Z', nextPollAt: null,
    updatedAt: '2026-11-02T09:00:00.000Z', createdAt: '2026-11-02T08:00:00.000Z',
    content: payload.content, context: payload.context, tags: payload.tags, priority: 'critical', requestHash: payloadHash,
  };
  db.prepare('INSERT INTO memory_metadata(key, value) VALUES(?, ?)').run('forget:present', '1');
  db.prepare('INSERT INTO memory_metadata(key, value) VALUES(?, ?)').run('forget:damaged', '0');
  db.prepare(`INSERT INTO memory_events(event_id, document_id, actor, occurred_at, intent, status, payload_hash, payload_json)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-event', 'legacy-doc', 'user', '2026-11-02T08:00:00.000Z', 'explicit', 'pending', payloadHash, JSON.stringify(payload),
  );
  db.prepare(`INSERT INTO memory_operations(event_id, bank_id, endpoint, document_id, operation_id, state, attempts,
    next_attempt_at, next_poll_at, updated_at, payload_hash, record_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-event', 'legacy-bank', 'https://memory.test', 'legacy-doc', 'legacy-operation', 'pending', 2,
      '2026-11-02T09:00:00.000Z', null, '2026-11-02T09:00:00.000Z', payloadHash, JSON.stringify(record));
  db.prepare(`INSERT INTO memory_revisions(event_id, bank_id, endpoint, document_id, supersedes_document_id, state, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-event', 'legacy-bank', 'https://memory.test', 'legacy-doc', 'legacy-prior-doc', 'pending', '2026-11-02T08:00:00.000Z',
  );
  db.prepare(`INSERT INTO memory_deletions(task_id, bank_id, endpoint, document_id, operation_id, state,
    attempts, verifications, next_attempt_at, record_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-delete', 'legacy-bank', 'https://memory.test', 'legacy-forgotten', 'legacy-operation', 'pending', 1, 0,
      '2026-11-02T09:00:00.000Z', JSON.stringify({ id: 'legacy-delete', state: 'pending' }));
  db.prepare('INSERT INTO memory_fences(bank_id, endpoint, document_id, reason, created_at) VALUES(?, ?, ?, ?, ?)')
    .run('legacy-bank', 'https://memory.test', 'legacy-forgotten', 'synthetic fixture fence', '2026-11-02T08:30:00.000Z');
  db.prepare('INSERT INTO memory_derived_state(bank_id, endpoint, epoch, stale) VALUES(?, ?, ?, ?)')
    .run('legacy-bank', 'https://memory.test', 3, 1);
  if (version < 3) return;

  db.prepare(`INSERT INTO memory_activation(bank_id, endpoint, document_id, activation_anchor_weight,
    activation_anchor_at, half_life_days, epsilon, params_version, last_user_mention_at, last_reinforced_at,
    last_retrieved_at, independent_mention_count, source_epoch, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-bank', 'https://memory.test', 'legacy-fact', 0.8, '2026-11-01T08:00:00.000Z', 30, 0.05,
      'activation-v1', '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z', null, 1, 3, '2026-11-01T09:00:00.000Z');
  db.prepare(`INSERT INTO memory_mention_events(mention_event_id, bank_id, endpoint, target_document_id,
    user_event_document_id, user_event_id, occurred_at, spacing_bucket, semantic_match, intensity, source_type,
    applied_boost, source_epoch, params_version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-mention', 'legacy-bank', 'https://memory.test', 'legacy-fact', 'legacy-user-event',
      'legacy-user-event-id', '2026-11-01T09:00:00.000Z', 'initial', 0.9, 0.2, 'user_mention', 0.1, 3, 'activation-v1');
}
