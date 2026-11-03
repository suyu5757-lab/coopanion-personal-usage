import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import {
  DEFAULT_ACTIVATION_PARAMETERS,
  DEFAULT_REINFORCEMENT_PARAMETERS,
  reinforceActivation,
  type ActivationParameters,
  type ActivationState,
  type MentionSpacingBucket,
  type ReinforcementParameters,
  type UserMentionEvidence,
} from './activation.ts';

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

export interface UserMentionInput {
  bankId: string;
  endpoint: string;
  targetDocumentId: string;
  userEventDocumentId: string;
  targetCreatedAt: string;
  semanticMatch: number;
  intensity: number;
}

export interface UserMentionResult {
  status: 'applied' | 'daily-cap' | 'no-match' | 'duplicate' | 'forgotten' | 'source-missing' | 'stale-state' | 'forget-unavailable';
  activation: ActivationState | null;
  mentionEventId?: string;
  spacingBucket?: MentionSpacingBucket;
  boost?: number;
  appliedBoost?: number;
}

export type MemorySourceMappingState = 'complete' | 'source-independent' | 'missing' | 'ambiguous' | 'unknown';
export type MemorySourceValidationState = 'validated' | 'unverified' | 'missing' | 'ambiguous' | 'stale' | 'withheld' | 'unknown';
export type MemoryEvidenceOrigin = 'user-input' | 'provider-response' | 'tool-outcome' | 'system-context' | 'unknown';
export type DerivedArtifactOrigin = 'user-authored' | 'trusted-system' | 'model-derived' | 'unknown';
export type DerivedArtifactReviewState = 'unreviewed' | 'approved' | 'rejected' | 'unknown';
export type DerivedArtifactLifecycleState = 'active' | 'pending' | 'stale' | 'withdrawn' | 'withheld' | 'unknown';

export interface MemorySourceDependency {
  bankId: string;
  endpoint: string;
  documentId: string;
  validatedEpoch: number | null;
  validatedFence: string | null;
  revision: string | null;
  contentDigest: string | null;
  segmentDigest: string | null;
  validationState: MemorySourceValidationState;
  correlationId: string | null;
}

export interface GenerationEvidence {
  sessionId: string;
  generationId: string;
  providerAttemptId: string | null;
  responseId: string | null;
  toolCorrelationId: string | null;
  origin: MemoryEvidenceOrigin;
  mappingState: MemorySourceMappingState;
  validationReceiptDigest: string | null;
  validatedAt: string | null;
  exceptionReason: string | null;
  actualEvidenceUsed: 'unknown';
  createdAt: string;
  sources: MemorySourceDependency[];
}

export type GenerationEvidenceInput = Omit<GenerationEvidence, 'actualEvidenceUsed'> & {
  actualEvidenceUsed?: 'unknown';
};

export interface DerivedArtifact {
  artifactId: string;
  kind: string;
  target: string;
  scope: string;
  creatorSessionId: string | null;
  creatorGenerationId: string | null;
  creatorOperationId: string | null;
  bodyDigest: string;
  origin: DerivedArtifactOrigin;
  reviewState: DerivedArtifactReviewState;
  lifecycleState: DerivedArtifactLifecycleState;
  lineageState: MemorySourceMappingState;
  lineageReceiptDigest: string | null;
  lineageValidatedAt: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  sources: MemorySourceDependency[];
}

export type DerivedArtifactInput = Omit<DerivedArtifact, 'sources'> & {
  sources: readonly MemorySourceDependency[];
};

type MemoryStateMigrationCheckpoint = 'after-v4-ddl' | 'after-v4-version';
type MemoryStateMigrationOptions = { onCheckpoint?: (checkpoint: MemoryStateMigrationCheckpoint) => void };

interface ActivationRow {
  activation_anchor_weight: number;
  activation_anchor_at: string;
  half_life_days: number;
  epsilon: number;
  params_version: string;
  last_user_mention_at: string | null;
  last_reinforced_at: string | null;
  last_retrieved_at: string | null;
  independent_mention_count: number;
  source_epoch: number;
  updated_at: string;
}

const HASH = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type StateDatabase = InstanceType<typeof DatabaseSync>;

const BASE_TABLE_COLUMNS: Record<string, readonly string[]> = {
  memory_metadata: ['key', 'value'],
  memory_events: ['event_id', 'document_id', 'actor', 'occurred_at', 'intent', 'status', 'payload_hash', 'payload_json'],
  memory_operations: ['event_id', 'bank_id', 'endpoint', 'document_id', 'operation_id', 'state', 'attempts', 'next_attempt_at', 'next_poll_at', 'updated_at', 'payload_hash', 'record_json'],
  memory_revisions: ['event_id', 'bank_id', 'endpoint', 'document_id', 'supersedes_document_id', 'state', 'created_at'],
  memory_deletions: ['task_id', 'bank_id', 'endpoint', 'document_id', 'operation_id', 'state', 'attempts', 'verifications', 'next_attempt_at', 'record_json'],
  memory_fences: ['bank_id', 'endpoint', 'document_id', 'reason', 'created_at'],
  memory_derived_state: ['bank_id', 'endpoint', 'epoch', 'stale'],
};

const V3_TABLE_COLUMNS: Record<string, readonly string[]> = {
  memory_activation: ['bank_id', 'endpoint', 'document_id', 'activation_anchor_weight', 'activation_anchor_at', 'half_life_days', 'epsilon', 'params_version', 'last_user_mention_at', 'last_reinforced_at', 'last_retrieved_at', 'independent_mention_count', 'source_epoch', 'updated_at'],
  memory_mention_events: ['mention_event_id', 'bank_id', 'endpoint', 'target_document_id', 'user_event_document_id', 'user_event_id', 'occurred_at', 'spacing_bucket', 'semantic_match', 'intensity', 'source_type', 'applied_boost', 'source_epoch', 'params_version'],
};

const V4_TABLE_COLUMNS: Record<string, readonly string[]> = {
  generation_evidence: ['session_id', 'generation_id', 'provider_attempt_id', 'response_id', 'tool_correlation_id', 'origin', 'mapping_state', 'validation_receipt_digest', 'validated_at', 'exception_reason', 'actual_evidence_used', 'created_at'],
  generation_source_dependency: ['session_id', 'generation_id', 'bank_id', 'endpoint', 'document_id', 'validated_epoch', 'validated_fence', 'source_revision', 'content_digest', 'segment_digest', 'validation_state', 'correlation_id'],
  derived_artifact: ['artifact_id', 'kind', 'target', 'scope', 'creator_session_id', 'creator_generation_id', 'creator_operation_id', 'body_digest', 'origin', 'review_state', 'lifecycle_state', 'lineage_state', 'lineage_receipt_digest', 'lineage_validated_at', 'status_reason', 'created_at', 'updated_at'],
  derived_artifact_source: ['artifact_id', 'bank_id', 'endpoint', 'document_id', 'validated_epoch', 'validated_fence', 'source_revision', 'content_digest', 'segment_digest', 'validation_state', 'correlation_id'],
};

const BASE_INDEXES = [
  'memory_operations_due', 'memory_operations_source', 'memory_revisions_current', 'memory_deletions_due',
];
const V3_INDEXES = ['memory_mention_events_day', 'memory_mention_events_source'];
const V4_INDEXES = [
  'generation_evidence_attempt', 'generation_source_dependency_namespace',
  'derived_artifact_lifecycle', 'derived_artifact_source_namespace',
];

const BASE_SCHEMA_SQL = `
  CREATE TABLE memory_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE memory_events (
    event_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    actor TEXT,
    occurred_at TEXT,
    intent TEXT NOT NULL,
    status TEXT,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE memory_operations (
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
  CREATE INDEX memory_operations_due ON memory_operations(state, next_attempt_at, updated_at);
  CREATE INDEX memory_operations_source ON memory_operations(bank_id, endpoint, document_id);
  CREATE TABLE memory_revisions (
    event_id TEXT NOT NULL,
    bank_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    document_id TEXT NOT NULL,
    supersedes_document_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(event_id, supersedes_document_id)
  );
  CREATE INDEX memory_revisions_current ON memory_revisions(bank_id, endpoint, supersedes_document_id, state);
  CREATE TABLE memory_deletions (
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
  CREATE INDEX memory_deletions_due ON memory_deletions(state, next_attempt_at);
  CREATE TABLE memory_fences (
    bank_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    document_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(bank_id, endpoint, document_id)
  );
  CREATE TABLE memory_derived_state (
    bank_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    stale INTEGER NOT NULL,
    PRIMARY KEY(bank_id, endpoint)
  );
`;

const V3_SCHEMA_SQL = `
  CREATE TABLE memory_activation (
    bank_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    document_id TEXT NOT NULL,
    activation_anchor_weight REAL NOT NULL,
    activation_anchor_at TEXT NOT NULL,
    half_life_days REAL NOT NULL,
    epsilon REAL NOT NULL,
    params_version TEXT NOT NULL,
    last_user_mention_at TEXT,
    last_reinforced_at TEXT,
    last_retrieved_at TEXT,
    independent_mention_count INTEGER NOT NULL,
    source_epoch INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(bank_id, endpoint, document_id)
  );
  CREATE TABLE memory_mention_events (
    mention_event_id TEXT PRIMARY KEY,
    bank_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    target_document_id TEXT NOT NULL,
    user_event_document_id TEXT NOT NULL,
    user_event_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    spacing_bucket TEXT NOT NULL CHECK(spacing_bucket IN ('initial', 'same-turn', 'same-day', 'cross-day')),
    semantic_match REAL NOT NULL CHECK(semantic_match >= 0 AND semantic_match <= 1),
    intensity REAL NOT NULL CHECK(intensity >= 0 AND intensity <= 1),
    source_type TEXT NOT NULL CHECK(source_type = 'user_mention'),
    applied_boost REAL NOT NULL CHECK(applied_boost >= 0 AND applied_boost <= 1),
    source_epoch INTEGER NOT NULL,
    params_version TEXT NOT NULL,
    UNIQUE(bank_id, endpoint, target_document_id, user_event_document_id)
  );
  CREATE INDEX memory_mention_events_day ON memory_mention_events(bank_id, endpoint, target_document_id, occurred_at);
  CREATE INDEX memory_mention_events_source ON memory_mention_events(bank_id, endpoint, user_event_document_id);
`;

const V4_SCHEMA_SQL = `
  CREATE TABLE generation_evidence (
    session_id TEXT NOT NULL CHECK(length(trim(session_id)) > 0),
    generation_id TEXT NOT NULL CHECK(length(trim(generation_id)) > 0),
    provider_attempt_id TEXT,
    response_id TEXT,
    tool_correlation_id TEXT,
    origin TEXT NOT NULL CHECK(origin IN ('user-input', 'provider-response', 'tool-outcome', 'system-context', 'unknown')),
    mapping_state TEXT NOT NULL CHECK(mapping_state IN ('complete', 'source-independent', 'missing', 'ambiguous', 'unknown')),
    validation_receipt_digest TEXT CHECK(validation_receipt_digest IS NULL OR (length(validation_receipt_digest) = 64 AND validation_receipt_digest NOT GLOB '*[^0-9a-f]*')),
    validated_at TEXT,
    exception_reason TEXT,
    actual_evidence_used TEXT NOT NULL DEFAULT 'unknown' CHECK(actual_evidence_used = 'unknown'),
    created_at TEXT NOT NULL,
    PRIMARY KEY(session_id, generation_id),
    CHECK(mapping_state NOT IN ('complete', 'source-independent') OR (validation_receipt_digest IS NOT NULL AND validated_at IS NOT NULL))
  );
  CREATE INDEX generation_evidence_attempt
    ON generation_evidence(session_id, provider_attempt_id, response_id, tool_correlation_id);
  CREATE TABLE generation_source_dependency (
    session_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    bank_id TEXT NOT NULL CHECK(length(trim(bank_id)) > 0),
    endpoint TEXT NOT NULL CHECK(length(trim(endpoint)) > 0),
    document_id TEXT NOT NULL CHECK(length(trim(document_id)) > 0),
    validated_epoch INTEGER CHECK(validated_epoch IS NULL OR validated_epoch >= 0),
    validated_fence TEXT,
    source_revision TEXT,
    content_digest TEXT CHECK(content_digest IS NULL OR (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*')),
    segment_digest TEXT CHECK(segment_digest IS NULL OR (length(segment_digest) = 64 AND segment_digest NOT GLOB '*[^0-9a-f]*')),
    validation_state TEXT NOT NULL CHECK(validation_state IN ('validated', 'unverified', 'missing', 'ambiguous', 'stale', 'withheld', 'unknown')),
    correlation_id TEXT,
    PRIMARY KEY(session_id, generation_id, bank_id, endpoint, document_id),
    FOREIGN KEY(session_id, generation_id) REFERENCES generation_evidence(session_id, generation_id) ON DELETE CASCADE,
    CHECK(validation_state != 'validated' OR (validated_epoch IS NOT NULL AND source_revision IS NOT NULL AND content_digest IS NOT NULL AND segment_digest IS NOT NULL))
  );
  CREATE INDEX generation_source_dependency_namespace
    ON generation_source_dependency(bank_id, endpoint, document_id, session_id, generation_id);
  CREATE TABLE derived_artifact (
    artifact_id TEXT PRIMARY KEY CHECK(length(trim(artifact_id)) > 0),
    kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
    target TEXT NOT NULL CHECK(length(trim(target)) > 0),
    scope TEXT NOT NULL CHECK(length(trim(scope)) > 0),
    creator_session_id TEXT,
    creator_generation_id TEXT,
    creator_operation_id TEXT,
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64 AND body_digest NOT GLOB '*[^0-9a-f]*'),
    origin TEXT NOT NULL CHECK(origin IN ('user-authored', 'trusted-system', 'model-derived', 'unknown')),
    review_state TEXT NOT NULL CHECK(review_state IN ('unreviewed', 'approved', 'rejected', 'unknown')),
    lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'pending', 'stale', 'withdrawn', 'withheld', 'unknown')),
    lineage_state TEXT NOT NULL CHECK(lineage_state IN ('complete', 'source-independent', 'missing', 'ambiguous', 'unknown')),
    lineage_receipt_digest TEXT CHECK(lineage_receipt_digest IS NULL OR (length(lineage_receipt_digest) = 64 AND lineage_receipt_digest NOT GLOB '*[^0-9a-f]*')),
    lineage_validated_at TEXT,
    status_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((creator_session_id IS NULL) = (creator_generation_id IS NULL)),
    CHECK(creator_session_id IS NULL OR length(trim(creator_session_id)) > 0),
    CHECK(creator_generation_id IS NULL OR length(trim(creator_generation_id)) > 0),
    CHECK(creator_operation_id IS NULL OR length(trim(creator_operation_id)) > 0),
    CHECK(lineage_state NOT IN ('complete', 'source-independent') OR (lineage_receipt_digest IS NOT NULL AND lineage_validated_at IS NOT NULL)),
    CHECK(origin != 'model-derived' OR creator_session_id IS NOT NULL OR creator_operation_id IS NOT NULL),
    FOREIGN KEY(creator_session_id, creator_generation_id) REFERENCES generation_evidence(session_id, generation_id)
  );
  CREATE INDEX derived_artifact_lifecycle ON derived_artifact(scope, lifecycle_state, kind, target);
  CREATE TABLE derived_artifact_source (
    artifact_id TEXT NOT NULL,
    bank_id TEXT NOT NULL CHECK(length(trim(bank_id)) > 0),
    endpoint TEXT NOT NULL CHECK(length(trim(endpoint)) > 0),
    document_id TEXT NOT NULL CHECK(length(trim(document_id)) > 0),
    validated_epoch INTEGER CHECK(validated_epoch IS NULL OR validated_epoch >= 0),
    validated_fence TEXT,
    source_revision TEXT,
    content_digest TEXT CHECK(content_digest IS NULL OR (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*')),
    segment_digest TEXT CHECK(segment_digest IS NULL OR (length(segment_digest) = 64 AND segment_digest NOT GLOB '*[^0-9a-f]*')),
    validation_state TEXT NOT NULL CHECK(validation_state IN ('validated', 'unverified', 'missing', 'ambiguous', 'stale', 'withheld', 'unknown')),
    correlation_id TEXT,
    PRIMARY KEY(artifact_id, bank_id, endpoint, document_id),
    FOREIGN KEY(artifact_id) REFERENCES derived_artifact(artifact_id) ON DELETE CASCADE,
    CHECK(validation_state != 'validated' OR (validated_epoch IS NOT NULL AND source_revision IS NOT NULL AND content_digest IS NOT NULL AND segment_digest IS NOT NULL))
  );
  CREATE INDEX derived_artifact_source_namespace
    ON derived_artifact_source(bank_id, endpoint, document_id, artifact_id);
`;

function expectedTables(version: number): Record<string, readonly string[]> {
  return {
    ...BASE_TABLE_COLUMNS,
    ...(version >= 3 ? V3_TABLE_COLUMNS : {}),
    ...(version >= 4 ? V4_TABLE_COLUMNS : {}),
  };
}

function expectedIndexes(version: number): string[] {
  return [
    ...BASE_INDEXES,
    ...(version >= 3 ? V3_INDEXES : []),
    ...(version >= 4 ? V4_INDEXES : []),
  ].sort();
}

function schemaObjects(db: StateDatabase): Array<{ name: string; type: string }> {
  return db.prepare(`
    SELECT name, type FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view', 'trigger')
    ORDER BY type, name
  `).all() as Array<{ name: string; type: string }>;
}

function assertStateSchema(db: StateDatabase, version: number): void {
  const expected = expectedTables(version);
  const objects = schemaObjects(db);
  const expectedNames = Object.keys(expected).sort();
  const actualNames = objects.map((item) => item.name).sort();
  if (objects.some((item) => item.type !== 'table') || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`memory database schema ${version} has an unexpected table layout`);
  }
  for (const [table, columns] of Object.entries(expected)) {
    const actual = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...columns].sort())) {
      throw new Error(`memory database schema ${version} has an unexpected ${table} layout`);
    }
  }
  const indexes = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
  if (JSON.stringify(indexes) !== JSON.stringify(expectedIndexes(version))) {
    throw new Error(`memory database schema ${version} has an unexpected index layout`);
  }
  if (version >= 4) {
    assertPrimaryKey(db, 'generation_evidence', ['session_id', 'generation_id']);
    assertPrimaryKey(db, 'generation_source_dependency', ['session_id', 'generation_id', 'bank_id', 'endpoint', 'document_id']);
    assertPrimaryKey(db, 'derived_artifact', ['artifact_id']);
    assertPrimaryKey(db, 'derived_artifact_source', ['artifact_id', 'bank_id', 'endpoint', 'document_id']);
    assertForeignKey(db, 'generation_source_dependency', 'generation_evidence', 'session_id', 'session_id');
    assertForeignKey(db, 'generation_source_dependency', 'generation_evidence', 'generation_id', 'generation_id');
    assertForeignKey(db, 'derived_artifact', 'generation_evidence', 'creator_session_id', 'session_id');
    assertForeignKey(db, 'derived_artifact', 'generation_evidence', 'creator_generation_id', 'generation_id');
    assertForeignKey(db, 'derived_artifact_source', 'derived_artifact', 'artifact_id', 'artifact_id');
  }
}

function assertPrimaryKey(db: StateDatabase, table: string, expected: readonly string[]): void {
  const actual = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; pk: number }>)
    .filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`memory database has an invalid ${table} identity`);
}

function assertForeignKey(db: StateDatabase, table: string, target: string, from: string, to: string): void {
  const rows = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string; from: string; to: string }>;
  if (!rows.some((row) => row.table === target && row.from === from && row.to === to)) {
    throw new Error(`memory database has an invalid ${table} relationship`);
  }
}

function migrateStateSchema(db: StateDatabase, options: MemoryStateMigrationOptions): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 4) throw new Error(`memory database schema ${version} is newer than this application`);
  if (version === 1) throw new Error('memory database schema 1 has no verified migration contract');
  if (version === 4) {
    assertStateSchema(db, 4);
    return;
  }
  if (version === 0) {
    if (schemaObjects(db).length > 0) throw new Error('unversioned memory database is not empty; refusing migration');
  } else {
    assertStateSchema(db, version);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    let current = version;
    if (current === 0) {
      db.exec(BASE_SCHEMA_SQL);
      current = 1;
      db.exec('PRAGMA user_version = 1');
    }
    if (current < 2) {
      db.exec('PRAGMA user_version = 2');
      current = 2;
    }
    if (current < 3) {
      db.exec(V3_SCHEMA_SQL);
      db.exec('PRAGMA user_version = 3');
      current = 3;
    }
    if (current < 4) {
      db.exec(V4_SCHEMA_SQL);
      assertStateSchema(db, 4);
      options.onCheckpoint?.('after-v4-ddl');
      db.exec('PRAGMA user_version = 4');
      options.onCheckpoint?.('after-v4-version');
    }
    assertStateSchema(db, 4);
    const integrity = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>;
    if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') {
      throw new Error(`memory database integrity check failed: ${integrity[0]?.quick_check ?? 'no result'}`);
    }
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) throw new Error('memory database foreign key check failed');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Keep the migration error. */ }
    throw error;
  }
}

const DIGEST = /^[0-9a-f]{64}$/;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
  return value;
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  return requiredText(value, field);
}

function optionalDigest(value: string | null | undefined, field: string): string | null {
  const text = optionalText(value, field);
  if (text !== null && !DIGEST.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return text;
}

function requiredDigest(value: string, field: string): string {
  const digest = optionalDigest(value, field);
  if (!digest) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return digest;
}

function validTimestamp(value: string, field: string): string {
  const timestamp = requiredText(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be a valid timestamp`);
  return timestamp;
}

function normalizeSource(source: MemorySourceDependency): MemorySourceDependency {
  const bankId = requiredText(source.bankId, 'source bankId');
  const endpoint = requiredText(source.endpoint, 'source endpoint');
  const documentId = requiredText(source.documentId, 'source documentId');
  if (source.validatedEpoch !== null && (!Number.isInteger(source.validatedEpoch) || source.validatedEpoch < 0)) {
    throw new Error('source validatedEpoch must be a non-negative integer or null');
  }
  const validationState = source.validationState;
  if (!['validated', 'unverified', 'missing', 'ambiguous', 'stale', 'withheld', 'unknown'].includes(validationState)) {
    throw new Error('source validationState is invalid');
  }
  const normalized: MemorySourceDependency = {
    bankId, endpoint, documentId,
    validatedEpoch: source.validatedEpoch,
    validatedFence: optionalText(source.validatedFence, 'source validatedFence'),
    revision: optionalText(source.revision, 'source revision'),
    contentDigest: optionalDigest(source.contentDigest, 'source contentDigest'),
    segmentDigest: optionalDigest(source.segmentDigest, 'source segmentDigest'),
    validationState,
    correlationId: optionalText(source.correlationId, 'source correlationId'),
  };
  if (validationState === 'validated'
    && (normalized.validatedEpoch === null || normalized.revision === null
      || normalized.contentDigest === null || normalized.segmentDigest === null)) {
    throw new Error('validated source dependencies require epoch, revision and digests');
  }
  return normalized;
}

function normalizeSources(sources: readonly MemorySourceDependency[]): MemorySourceDependency[] {
  const unique = new Map<string, MemorySourceDependency>();
  for (const source of sources) {
    const normalized = normalizeSource(source);
    const identity = JSON.stringify([normalized.bankId, normalized.endpoint, normalized.documentId]);
    const prior = unique.get(identity);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) {
      throw new Error('source dependency identity has conflicting metadata');
    }
    unique.set(identity, normalized);
  }
  return [...unique.values()].sort((a, b) =>
    a.bankId.localeCompare(b.bankId) || a.endpoint.localeCompare(b.endpoint) || a.documentId.localeCompare(b.documentId));
}

function assertMappingReceipt(
  state: MemorySourceMappingState,
  receiptDigest: string | null,
  validatedAt: string | null,
  sources: readonly MemorySourceDependency[],
): void {
  if (!['complete', 'source-independent', 'missing', 'ambiguous', 'unknown'].includes(state)) {
    throw new Error('source mapping state is invalid');
  }
  if ((state === 'complete' || state === 'source-independent') && (!receiptDigest || !validatedAt)) {
    throw new Error('complete source mapping requires a receipt and validation time');
  }
  if (state === 'source-independent' && sources.length > 0) throw new Error('source-independent mapping cannot contain dependencies');
  if (state === 'complete' && sources.some((source) => source.validationState !== 'validated')) {
    throw new Error('complete source mapping requires validated dependencies');
  }
}

function generationIdentity(record: GenerationEvidence): string {
  return JSON.stringify(record);
}

function artifactIdentity(record: DerivedArtifact): string {
  return JSON.stringify(record);
}

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

  constructor(readonly path: string, migrationOptions: MemoryStateMigrationOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
      migrateStateSchema(this.db, migrationOptions);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.restrictFilePermissions();
      const check = this.db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>;
      if (check.length !== 1 || check[0]?.quick_check !== 'ok') {
        throw new Error(`memory database integrity check failed: ${check[0]?.quick_check ?? 'no result'}`);
      }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('memory database foreign key check failed');
      }
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
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

  clearMemoryTarget(bankId: string, endpoint: string, state: ForgetStateSnapshot): void {
    this.transaction(() => {
      this.writeForgetState(state, false);
      this.db.prepare('DELETE FROM memory_activation WHERE bank_id = ? AND endpoint = ?').run(bankId, endpoint);
      this.db.prepare('DELETE FROM memory_mention_events WHERE bank_id = ? AND endpoint = ?').run(bankId, endpoint);
    });
  }

  loadActivationState(bankId: string, endpoint: string, documentId: string): ActivationState | null {
    this.assertOpen();
    if (this.meta('forget:damaged') === '1' || this.isFenced(bankId, endpoint, documentId)) return null;
    const row = this.activationRow(bankId, endpoint, documentId);
    if (!row || row.sourceEpoch !== this.currentEpoch(bankId, endpoint)) return null;
    return row;
  }

  activationForRetrieval(
    bankId: string,
    endpoint: string,
    documentId: string,
    sourceCreatedAt: string,
    retrievedAt = new Date().toISOString(),
  ): ActivationState | null {
    const retrievedTime = Date.parse(retrievedAt);
    const createdTime = Date.parse(sourceCreatedAt);
    if (!Number.isFinite(retrievedTime) || !Number.isFinite(createdTime)) throw new RangeError('activation source and retrieval timestamps must be finite');
    const retrieved = new Date(retrievedTime).toISOString();
    const created = new Date(createdTime).toISOString();
    return this.transaction(() => {
      if (this.meta('forget:damaged') === '1' || this.isFenced(bankId, endpoint, documentId)) return null;
      const epoch = this.currentEpoch(bankId, endpoint);
      const current = this.activationRow(bankId, endpoint, documentId);
      if (current && current.sourceEpoch !== epoch) return null;
      const state: ActivationState = current
        ? { ...current, lastRetrievedAt: retrieved, updatedAt: retrieved }
        : {
            anchorWeight: DEFAULT_REINFORCEMENT_PARAMETERS.initialWeight,
            anchorAt: created,
            halfLifeDays: DEFAULT_ACTIVATION_PARAMETERS.halfLifeDays,
            epsilon: DEFAULT_ACTIVATION_PARAMETERS.epsilon,
            paramsVersion: `${DEFAULT_ACTIVATION_PARAMETERS.version}+${DEFAULT_REINFORCEMENT_PARAMETERS.version}`,
            lastUserMentionAt: null,
            lastReinforcedAt: null,
            lastRetrievedAt: retrieved,
            independentMentionCount: 0,
            sourceEpoch: epoch,
            updatedAt: retrieved,
          };
      this.writeActivation(bankId, endpoint, documentId, state);
      return state;
    });
  }

  recordUserMention(
    input: UserMentionInput,
    decay: ActivationParameters = DEFAULT_ACTIVATION_PARAMETERS,
    reinforcement: ReinforcementParameters = DEFAULT_REINFORCEMENT_PARAMETERS,
  ): UserMentionResult {
    return this.transaction(() => {
      if (this.meta('forget:damaged') === '1') return { status: 'forget-unavailable', activation: null };
      if (this.isFenced(input.bankId, input.endpoint, input.targetDocumentId)
        || this.isFenced(input.bankId, input.endpoint, input.userEventDocumentId)) {
        return { status: 'forgotten', activation: null };
      }

      const source = this.db.prepare(`
        SELECT e.event_id, e.occurred_at
        FROM memory_events e JOIN memory_operations o USING(event_id)
        WHERE o.bank_id = ? AND o.endpoint = ? AND o.document_id = ?
          AND e.document_id = ? AND e.actor = 'user'
          AND o.state NOT IN ('cancelled', 'dead', 'orphaned')
        ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1
      `).get(input.bankId, input.endpoint, input.userEventDocumentId, input.userEventDocumentId) as
        { event_id: string; occurred_at: string | null } | undefined;
      if (!source?.occurred_at) return { status: 'source-missing', activation: null };
      const occurredAtMs = Date.parse(source.occurred_at);
      if (!Number.isFinite(occurredAtMs)) return { status: 'source-missing', activation: null };
      const occurredAt = new Date(occurredAtMs).toISOString();
      const mention = this.db.prepare(`
        SELECT mention_event_id, spacing_bucket, applied_boost
        FROM memory_mention_events
        WHERE bank_id = ? AND endpoint = ? AND target_document_id = ? AND user_event_document_id = ?
      `).get(input.bankId, input.endpoint, input.targetDocumentId, input.userEventDocumentId) as
        { mention_event_id: string; spacing_bucket: string; applied_boost: number } | undefined;
      const epoch = this.currentEpoch(input.bankId, input.endpoint);
      const current = this.activationRow(input.bankId, input.endpoint, input.targetDocumentId);
      if (current && current.sourceEpoch !== epoch) return { status: 'stale-state', activation: null };
      if (mention) {
        return {
          status: 'duplicate',
          activation: current,
          mentionEventId: mention.mention_event_id,
          spacingBucket: mention.spacing_bucket as MentionSpacingBucket,
          boost: mention.applied_boost,
          appliedBoost: mention.applied_boost,
        };
      }
      if (!Number.isFinite(input.semanticMatch) || input.semanticMatch < 0 || input.semanticMatch > 1) {
        throw new RangeError('semantic match must be in the interval [0, 1]');
      }
      if (!Number.isFinite(input.intensity) || input.intensity < 0 || input.intensity > 1) {
        throw new RangeError('mention intensity must be in the interval [0, 1]');
      }
      if (input.semanticMatch < reinforcement.minimumSemanticMatch || input.targetDocumentId === input.userEventDocumentId) {
        return { status: 'no-match', activation: current };
      }

      const dayStart = new Date(occurredAtMs);
      dayStart.setUTCHours(0, 0, 0, 0);
      const startAt = dayStart.toISOString();
      const endAt = new Date(dayStart.getTime() + 86_400_000).toISOString();
      const daily = this.db.prepare(`
        SELECT COUNT(*) AS event_count, COALESCE(SUM(applied_boost), 0) AS applied_boost
        FROM memory_mention_events
        WHERE bank_id = ? AND endpoint = ? AND target_document_id = ? AND occurred_at >= ? AND occurred_at < ?
      `).get(input.bankId, input.endpoint, input.targetDocumentId, startAt, endAt) as
        { event_count: number; applied_boost: number };
      const evidence: UserMentionEvidence = {
        occurredAt,
        targetCreatedAt: input.targetCreatedAt,
        semanticMatch: input.semanticMatch,
        intensity: input.intensity,
      };
      const reinforced = reinforceActivation(current, evidence, {
        eventCount: daily.event_count,
        appliedBoost: daily.applied_boost,
      }, decay, reinforcement);
      const activation: ActivationState = { ...reinforced.state, sourceEpoch: epoch, updatedAt: new Date().toISOString() };
      const mentionEventId = `mention-${HASH([input.bankId, input.endpoint, input.targetDocumentId, source.event_id])}`;
      this.db.prepare(`
        INSERT INTO memory_mention_events(mention_event_id, bank_id, endpoint, target_document_id,
          user_event_document_id, user_event_id, occurred_at, spacing_bucket, semantic_match, intensity,
          source_type, applied_boost, source_epoch, params_version)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_mention', ?, ?, ?)
      `).run(
        mentionEventId, input.bankId, input.endpoint, input.targetDocumentId,
        input.userEventDocumentId, source.event_id, occurredAt, reinforced.spacingBucket,
        input.semanticMatch, input.intensity, reinforced.appliedBoost, epoch, activation.paramsVersion,
      );
      this.writeActivation(input.bankId, input.endpoint, input.targetDocumentId, activation);
      return {
        status: reinforced.outcome,
        activation,
        mentionEventId,
        spacingBucket: reinforced.spacingBucket,
        boost: reinforced.boost,
        appliedBoost: reinforced.appliedBoost,
      };
    });
  }

  saveGenerationEvidence(input: GenerationEvidenceInput): GenerationEvidence {
    const sources = normalizeSources(input.sources);
    const validationReceiptDigest = optionalDigest(input.validationReceiptDigest, 'validationReceiptDigest');
    const validatedAt = input.validatedAt === null ? null : input.validatedAt === undefined ? null : validTimestamp(input.validatedAt, 'validatedAt');
    assertMappingReceipt(input.mappingState, validationReceiptDigest, validatedAt, sources);
    if (input.actualEvidenceUsed !== undefined && input.actualEvidenceUsed !== 'unknown') {
      throw new Error('actualEvidenceUsed must remain unknown');
    }
    if (!['user-input', 'provider-response', 'tool-outcome', 'system-context', 'unknown'].includes(input.origin)) {
      throw new Error('generation evidence origin is invalid');
    }
    const record: GenerationEvidence = {
      sessionId: requiredText(input.sessionId, 'sessionId'),
      generationId: requiredText(input.generationId, 'generationId'),
      providerAttemptId: optionalText(input.providerAttemptId, 'providerAttemptId'),
      responseId: optionalText(input.responseId, 'responseId'),
      toolCorrelationId: optionalText(input.toolCorrelationId, 'toolCorrelationId'),
      origin: input.origin,
      mappingState: input.mappingState,
      validationReceiptDigest,
      validatedAt,
      exceptionReason: optionalText(input.exceptionReason, 'exceptionReason'),
      actualEvidenceUsed: 'unknown',
      createdAt: validTimestamp(input.createdAt, 'createdAt'),
      sources,
    };

    return this.transaction(() => {
      const existing = this.readGenerationEvidence(record.sessionId, record.generationId);
      if (existing) {
        if (generationIdentity(existing) !== generationIdentity(record)) {
          throw new Error('generation evidence identity has conflicting metadata');
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO generation_evidence(session_id, generation_id, provider_attempt_id, response_id,
          tool_correlation_id, origin, mapping_state, validation_receipt_digest, validated_at,
          exception_reason, actual_evidence_used, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)
      `).run(
        record.sessionId, record.generationId, record.providerAttemptId, record.responseId,
        record.toolCorrelationId, record.origin, record.mappingState, record.validationReceiptDigest,
        record.validatedAt, record.exceptionReason, record.createdAt,
      );
      const insertSource = this.db.prepare(`
        INSERT INTO generation_source_dependency(session_id, generation_id, bank_id, endpoint, document_id,
          validated_epoch, validated_fence, source_revision, content_digest, segment_digest, validation_state, correlation_id)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of sources) insertSource.run(
        record.sessionId, record.generationId, source.bankId, source.endpoint, source.documentId,
        source.validatedEpoch, source.validatedFence, source.revision, source.contentDigest,
        source.segmentDigest, source.validationState, source.correlationId,
      );
      return this.readGenerationEvidence(record.sessionId, record.generationId)!;
    });
  }

  getGenerationEvidence(sessionId: string, generationId: string): GenerationEvidence | null {
    this.assertOpen();
    return this.readGenerationEvidence(requiredText(sessionId, 'sessionId'), requiredText(generationId, 'generationId'));
  }

  saveDerivedArtifact(input: DerivedArtifactInput): DerivedArtifact {
    const sources = normalizeSources(input.sources);
    const lineageReceiptDigest = optionalDigest(input.lineageReceiptDigest, 'lineageReceiptDigest');
    const lineageValidatedAt = input.lineageValidatedAt === null
      ? null
      : input.lineageValidatedAt === undefined ? null : validTimestamp(input.lineageValidatedAt, 'lineageValidatedAt');
    if (!['user-authored', 'trusted-system', 'model-derived', 'unknown'].includes(input.origin)) {
      throw new Error('derived artifact origin is invalid');
    }
    if (!['unreviewed', 'approved', 'rejected', 'unknown'].includes(input.reviewState)) {
      throw new Error('derived artifact reviewState is invalid');
    }
    if (!['active', 'pending', 'stale', 'withdrawn', 'withheld', 'unknown'].includes(input.lifecycleState)) {
      throw new Error('derived artifact lifecycleState is invalid');
    }
    const creatorSessionId = optionalText(input.creatorSessionId, 'creatorSessionId');
    const creatorGenerationId = optionalText(input.creatorGenerationId, 'creatorGenerationId');
    if ((creatorSessionId === null) !== (creatorGenerationId === null)) {
      throw new Error('creator session and generation must be provided together');
    }
    const record: DerivedArtifact = {
      artifactId: requiredText(input.artifactId, 'artifactId'),
      kind: requiredText(input.kind, 'kind'),
      target: requiredText(input.target, 'target'),
      scope: requiredText(input.scope, 'scope'),
      creatorSessionId,
      creatorGenerationId,
      creatorOperationId: optionalText(input.creatorOperationId, 'creatorOperationId'),
      bodyDigest: requiredDigest(input.bodyDigest, 'bodyDigest'),
      origin: input.origin,
      reviewState: input.reviewState,
      lifecycleState: input.lifecycleState,
      lineageState: input.lineageState,
      lineageReceiptDigest,
      lineageValidatedAt,
      statusReason: optionalText(input.statusReason, 'statusReason'),
      createdAt: validTimestamp(input.createdAt, 'createdAt'),
      updatedAt: validTimestamp(input.updatedAt, 'updatedAt'),
      sources,
    };
    assertMappingReceipt(record.lineageState, record.lineageReceiptDigest, record.lineageValidatedAt, sources);
    if (record.lifecycleState === 'active' && !['complete', 'source-independent'].includes(record.lineageState)) {
      throw new Error('artifacts with incomplete lineage cannot be active');
    }
    if (['stale', 'withdrawn', 'withheld', 'unknown'].includes(record.lifecycleState) && !record.statusReason) {
      throw new Error('non-active artifact states require a reason');
    }
    if (record.origin === 'model-derived'
      && record.creatorSessionId === null && record.creatorOperationId === null) {
      throw new Error('model-derived artifacts require a generation or operation identity');
    }

    return this.transaction(() => {
      const existing = this.readDerivedArtifact(record.artifactId);
      if (existing) {
        if (artifactIdentity(existing) !== artifactIdentity(record)) {
          throw new Error('derived artifact identity has conflicting metadata');
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO derived_artifact(artifact_id, kind, target, scope, creator_session_id, creator_generation_id,
          creator_operation_id, body_digest, origin, review_state, lifecycle_state, lineage_state,
          lineage_receipt_digest, lineage_validated_at, status_reason, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.artifactId, record.kind, record.target, record.scope, record.creatorSessionId,
        record.creatorGenerationId, record.creatorOperationId, record.bodyDigest, record.origin,
        record.reviewState, record.lifecycleState, record.lineageState, record.lineageReceiptDigest, record.lineageValidatedAt,
        record.statusReason, record.createdAt, record.updatedAt,
      );
      const insertSource = this.db.prepare(`
        INSERT INTO derived_artifact_source(artifact_id, bank_id, endpoint, document_id, validated_epoch,
          validated_fence, source_revision, content_digest, segment_digest, validation_state, correlation_id)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of sources) insertSource.run(
        record.artifactId, source.bankId, source.endpoint, source.documentId, source.validatedEpoch,
        source.validatedFence, source.revision, source.contentDigest, source.segmentDigest,
        source.validationState, source.correlationId,
      );
      return this.readDerivedArtifact(record.artifactId)!;
    });
  }

  getDerivedArtifact(artifactId: string): DerivedArtifact | null {
    this.assertOpen();
    return this.readDerivedArtifact(requiredText(artifactId, 'artifactId'));
  }

  derivedArtifactsForSource(bankId: string, endpoint: string, documentId: string): DerivedArtifact[] {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT artifact_id FROM derived_artifact_source
      WHERE bank_id = ? AND endpoint = ? AND document_id = ?
      ORDER BY artifact_id
    `).all(requiredText(bankId, 'bankId'), requiredText(endpoint, 'endpoint'), requiredText(documentId, 'documentId')) as Array<{ artifact_id: string }>;
    return rows.flatMap(({ artifact_id }) => {
      const artifact = this.readDerivedArtifact(artifact_id);
      return artifact ? [artifact] : [];
    });
  }

  markDerivedArtifactState(
    artifactId: string,
    lifecycleState: Exclude<DerivedArtifactLifecycleState, 'active'>,
    reason: string,
    updatedAt: string,
  ): DerivedArtifact | null {
    if (!['pending', 'stale', 'withdrawn', 'withheld', 'unknown'].includes(lifecycleState)) {
      throw new Error('derived artifact lifecycleState is invalid');
    }
    return this.transaction(() => {
      const current = this.readDerivedArtifact(requiredText(artifactId, 'artifactId'));
      if (!current) return null;
      this.db.prepare(`
        UPDATE derived_artifact SET lifecycle_state = ?, status_reason = ?, updated_at = ?
        WHERE artifact_id = ?
      `).run(lifecycleState, requiredText(reason, 'reason'), validTimestamp(updatedAt, 'updatedAt'), current.artifactId);
      return this.readDerivedArtifact(current.artifactId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private readGenerationEvidence(sessionId: string, generationId: string): GenerationEvidence | null {
    const row = this.db.prepare(`
      SELECT session_id, generation_id, provider_attempt_id, response_id, tool_correlation_id, origin,
        mapping_state, validation_receipt_digest, validated_at, exception_reason, actual_evidence_used, created_at
      FROM generation_evidence WHERE session_id = ? AND generation_id = ?
    `).get(sessionId, generationId) as {
      session_id: string; generation_id: string; provider_attempt_id: string | null; response_id: string | null;
      tool_correlation_id: string | null; origin: string; mapping_state: string; validation_receipt_digest: string | null;
      validated_at: string | null; exception_reason: string | null; actual_evidence_used: string; created_at: string;
    } | undefined;
    if (!row) return null;
    const sourceRows = this.db.prepare(`
      SELECT bank_id, endpoint, document_id, validated_epoch, validated_fence, source_revision,
        content_digest, segment_digest, validation_state, correlation_id
      FROM generation_source_dependency WHERE session_id = ? AND generation_id = ?
      ORDER BY bank_id, endpoint, document_id
    `).all(sessionId, generationId) as Array<{
      bank_id: string; endpoint: string; document_id: string; validated_epoch: number | null;
      validated_fence: string | null; source_revision: string | null; content_digest: string | null;
      segment_digest: string | null; validation_state: string; correlation_id: string | null;
    }>;
    return {
      sessionId: row.session_id,
      generationId: row.generation_id,
      providerAttemptId: row.provider_attempt_id,
      responseId: row.response_id,
      toolCorrelationId: row.tool_correlation_id,
      origin: row.origin as MemoryEvidenceOrigin,
      mappingState: row.mapping_state as MemorySourceMappingState,
      validationReceiptDigest: row.validation_receipt_digest,
      validatedAt: row.validated_at,
      exceptionReason: row.exception_reason,
      actualEvidenceUsed: row.actual_evidence_used as 'unknown',
      createdAt: row.created_at,
      sources: sourceRows.map((source) => ({
        bankId: source.bank_id,
        endpoint: source.endpoint,
        documentId: source.document_id,
        validatedEpoch: source.validated_epoch,
        validatedFence: source.validated_fence,
        revision: source.source_revision,
        contentDigest: source.content_digest,
        segmentDigest: source.segment_digest,
        validationState: source.validation_state as MemorySourceValidationState,
        correlationId: source.correlation_id,
      })),
    };
  }

  private readDerivedArtifact(artifactId: string): DerivedArtifact | null {
    const row = this.db.prepare(`
      SELECT artifact_id, kind, target, scope, creator_session_id, creator_generation_id, creator_operation_id,
        body_digest, origin, review_state, lifecycle_state, lineage_state, lineage_receipt_digest,
        lineage_validated_at, status_reason, created_at, updated_at
      FROM derived_artifact WHERE artifact_id = ?
    `).get(artifactId) as {
      artifact_id: string; kind: string; target: string; scope: string; creator_session_id: string | null;
      creator_generation_id: string | null; creator_operation_id: string | null; body_digest: string; origin: string;
      review_state: string; lifecycle_state: string; lineage_state: string; lineage_receipt_digest: string | null;
      lineage_validated_at: string | null; status_reason: string | null; created_at: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    const sourceRows = this.db.prepare(`
      SELECT bank_id, endpoint, document_id, validated_epoch, validated_fence, source_revision,
        content_digest, segment_digest, validation_state, correlation_id
      FROM derived_artifact_source WHERE artifact_id = ?
      ORDER BY bank_id, endpoint, document_id
    `).all(artifactId) as Array<{
      bank_id: string; endpoint: string; document_id: string; validated_epoch: number | null;
      validated_fence: string | null; source_revision: string | null; content_digest: string | null;
      segment_digest: string | null; validation_state: string; correlation_id: string | null;
    }>;
    return {
      artifactId: row.artifact_id,
      kind: row.kind,
      target: row.target,
      scope: row.scope,
      creatorSessionId: row.creator_session_id,
      creatorGenerationId: row.creator_generation_id,
      creatorOperationId: row.creator_operation_id,
      bodyDigest: row.body_digest,
      origin: row.origin as DerivedArtifactOrigin,
      reviewState: row.review_state as DerivedArtifactReviewState,
      lifecycleState: row.lifecycle_state as DerivedArtifactLifecycleState,
      lineageState: row.lineage_state as MemorySourceMappingState,
      lineageReceiptDigest: row.lineage_receipt_digest,
      lineageValidatedAt: row.lineage_validated_at,
      statusReason: row.status_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sources: sourceRows.map((source) => ({
        bankId: source.bank_id,
        endpoint: source.endpoint,
        documentId: source.document_id,
        validatedEpoch: source.validated_epoch,
        validatedFence: source.validated_fence,
        revision: source.source_revision,
        contentDigest: source.content_digest,
        segmentDigest: source.segment_digest,
        validationState: source.validation_state as MemorySourceValidationState,
        correlationId: source.correlation_id,
      })),
    };
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

  private currentEpoch(bankId: string, endpoint: string): number {
    const row = this.db.prepare(`
      SELECT epoch FROM memory_derived_state WHERE bank_id = ? AND endpoint = ?
    `).get(bankId, endpoint) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  private isFenced(bankId: string, endpoint: string, documentId: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 AS fenced FROM memory_fences WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `).get(bankId, endpoint, documentId);
  }

  private activationRow(bankId: string, endpoint: string, documentId: string): ActivationState | null {
    const row = this.db.prepare(`
      SELECT activation_anchor_weight, activation_anchor_at, half_life_days, epsilon, params_version,
        last_user_mention_at, last_reinforced_at, last_retrieved_at, independent_mention_count,
        source_epoch, updated_at
      FROM memory_activation WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `).get(bankId, endpoint, documentId) as ActivationRow | undefined;
    if (!row) return null;
    return {
      anchorWeight: row.activation_anchor_weight,
      anchorAt: row.activation_anchor_at,
      halfLifeDays: row.half_life_days,
      epsilon: row.epsilon,
      paramsVersion: row.params_version,
      lastUserMentionAt: row.last_user_mention_at,
      lastReinforcedAt: row.last_reinforced_at,
      lastRetrievedAt: row.last_retrieved_at,
      independentMentionCount: row.independent_mention_count,
      sourceEpoch: row.source_epoch,
      updatedAt: row.updated_at,
    };
  }

  private writeActivation(bankId: string, endpoint: string, documentId: string, state: ActivationState): void {
    this.db.prepare(`
      INSERT INTO memory_activation(bank_id, endpoint, document_id, activation_anchor_weight,
        activation_anchor_at, half_life_days, epsilon, params_version, last_user_mention_at,
        last_reinforced_at, last_retrieved_at, independent_mention_count, source_epoch, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bank_id, endpoint, document_id) DO UPDATE SET
        activation_anchor_weight=excluded.activation_anchor_weight,
        activation_anchor_at=excluded.activation_anchor_at,
        half_life_days=excluded.half_life_days,
        epsilon=excluded.epsilon,
        params_version=excluded.params_version,
        last_user_mention_at=excluded.last_user_mention_at,
        last_reinforced_at=excluded.last_reinforced_at,
        last_retrieved_at=excluded.last_retrieved_at,
        independent_mention_count=excluded.independent_mention_count,
        source_epoch=excluded.source_epoch,
        updated_at=excluded.updated_at
    `).run(
      bankId, endpoint, documentId, state.anchorWeight, state.anchorAt, state.halfLifeDays, state.epsilon,
      state.paramsVersion, state.lastUserMentionAt, state.lastReinforcedAt, state.lastRetrievedAt,
      state.independentMentionCount, state.sourceEpoch, state.updatedAt,
    );
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
    const mentionsForSource = this.db.prepare(`
      SELECT DISTINCT target_document_id FROM memory_mention_events
      WHERE bank_id = ? AND endpoint = ? AND user_event_document_id = ?
    `);
    const deleteActivation = this.db.prepare(`
      DELETE FROM memory_activation WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `);
    const deleteMentions = this.db.prepare(`
      DELETE FROM memory_mention_events
      WHERE bank_id = ? AND endpoint = ? AND (target_document_id = ? OR user_event_document_id = ?)
    `);
    for (const raw of state.tombstones) {
      const entry = raw as Record<string, unknown>;
      const bankId = entry.bankId as string;
      const endpoint = entry.endpoint as string;
      const documentId = entry.documentId as string;
      const dependents = mentionsForSource.all(bankId, endpoint, documentId) as Array<{ target_document_id: string }>;
      for (const dependent of dependents) deleteActivation.run(bankId, endpoint, dependent.target_document_id);
      deleteActivation.run(bankId, endpoint, documentId);
      deleteMentions.run(bankId, endpoint, documentId, documentId);
    }
    const bumpActivationEpoch = this.db.prepare(`
      UPDATE memory_activation SET source_epoch = ? WHERE bank_id = ? AND endpoint = ?
    `);
    for (const raw of state.tombstones) {
      const entry = raw as Record<string, unknown>;
      const bankId = entry.bankId as string;
      const endpoint = entry.endpoint as string;
      const encoded = JSON.stringify([bankId, endpoint]);
      bumpActivationEpoch.run(state.epochs[encoded] ?? 0, bankId, endpoint);
    }
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
