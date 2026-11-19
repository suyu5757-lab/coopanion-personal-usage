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
import {
  DOMAIN_IDS,
  MEMORY_DOMAIN_TAXONOMY,
  assertSourceDomainClassification,
  normalizeDomains,
  type CooGrowthCandidateSourceEvidence,
  type DomainId,
  type DomainSourcePage,
  type SourceDomainClassification,
  type SourceDomainClassificationInput,
  type SourceDomainEvidenceProvider,
  type SourceDomainLink,
  type SourceDomainStats,
} from './source-domains.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface ForgetStateSnapshot {
  v: 2;
  tasks: object[];
  tombstones: object[];
  epochs: Record<string, number>;
  stale: string[];
}

export interface ForgetIntentTarget {
  bankId: string;
  endpoint: string;
  documentId: string;
  operationId?: string;
  reason: string;
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

type MemoryStateMigrationCheckpoint = 'after-v4-ddl' | 'after-v4-version' | 'after-v5-ddl' | 'after-v5-version';
type MemoryStateMigrationOptions = { onCheckpoint?: (checkpoint: MemoryStateMigrationCheckpoint) => void };
export interface MemoryStateStoreOptions extends MemoryStateMigrationOptions {
  sourceDomainEvidence?: SourceDomainEvidenceProvider;
}

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

const V5_TABLE_COLUMNS: Record<string, readonly string[]> = {
  source_domain_record: ['bank_id', 'endpoint', 'document_id', 'state', 'taxonomy_version', 'classifier_version', 'confidence', 'source_epoch', 'source_revision', 'classified_at', 'updated_at'],
  source_domain_link: ['bank_id', 'endpoint', 'document_id', 'domain_id', 'link_state', 'taxonomy_version', 'classifier_version', 'confidence', 'rule_id', 'evidence_start', 'evidence_end', 'evidence_digest', 'claim_verification', 'created_at'],
};

const BASE_INDEXES = [
  'memory_operations_due', 'memory_operations_source', 'memory_revisions_current', 'memory_deletions_due',
];
const V3_INDEXES = ['memory_mention_events_day', 'memory_mention_events_source'];
const V4_INDEXES = [
  'generation_evidence_attempt', 'generation_source_dependency_namespace',
  'derived_artifact_lifecycle', 'derived_artifact_source_namespace',
];
const V5_INDEXES = ['source_domain_record_state', 'source_domain_link_domain', 'source_domain_link_namespace'];

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

const DOMAIN_ID_SQL = DOMAIN_IDS.map((domain) => `'${domain}'`).join(', ');

export const V5_SCHEMA_SQL = `
  CREATE TABLE source_domain_record (
    bank_id TEXT NOT NULL CHECK(length(trim(bank_id)) > 0),
    endpoint TEXT NOT NULL CHECK(length(trim(endpoint)) > 0),
    document_id TEXT NOT NULL CHECK(length(trim(document_id)) > 0),
    state TEXT NOT NULL CHECK(state IN ('assigned', 'unclassified', 'ambiguous', 'pending_review')),
    taxonomy_version TEXT NOT NULL CHECK(length(trim(taxonomy_version)) > 0),
    classifier_version TEXT NOT NULL CHECK(length(trim(classifier_version)) > 0),
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    source_epoch INTEGER NOT NULL CHECK(source_epoch >= 0),
    source_revision TEXT NOT NULL CHECK(length(source_revision) = 64 AND source_revision NOT GLOB '*[^0-9a-f]*'),
    classified_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(bank_id, endpoint, document_id)
  );
  CREATE INDEX source_domain_record_state ON source_domain_record(state, updated_at);
  CREATE TABLE source_domain_link (
    bank_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    document_id TEXT NOT NULL,
    domain_id TEXT NOT NULL CHECK(domain_id IN (${DOMAIN_ID_SQL})),
    link_state TEXT NOT NULL CHECK(link_state IN ('confirmed', 'candidate')),
    taxonomy_version TEXT NOT NULL CHECK(length(trim(taxonomy_version)) > 0),
    classifier_version TEXT NOT NULL CHECK(length(trim(classifier_version)) > 0),
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    rule_id TEXT,
    evidence_start INTEGER CHECK(evidence_start IS NULL OR evidence_start >= 0),
    evidence_end INTEGER CHECK(evidence_end IS NULL OR evidence_end > evidence_start),
    evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*')),
    claim_verification TEXT NOT NULL CHECK(claim_verification IN ('user_verified', 'external_unverified')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(bank_id, endpoint, document_id, domain_id),
    FOREIGN KEY(bank_id, endpoint, document_id)
      REFERENCES source_domain_record(bank_id, endpoint, document_id) ON DELETE CASCADE,
    CHECK((evidence_start IS NULL) = (evidence_end IS NULL)),
    CHECK((evidence_start IS NULL) = (evidence_digest IS NULL)),
    CHECK(link_state = 'candidate'
      OR (evidence_start IS NOT NULL AND evidence_end IS NOT NULL AND evidence_digest IS NOT NULL))
  );
  CREATE INDEX source_domain_link_domain
    ON source_domain_link(domain_id, link_state, bank_id, endpoint, document_id);
  CREATE INDEX source_domain_link_namespace
    ON source_domain_link(bank_id, endpoint, document_id);
`;

/** Explicit maintenance fallback for a synthetic or separately approved database. Never run automatically. */
export const V5_DOWN_SCHEMA_SQL = `
  DROP TABLE IF EXISTS source_domain_link;
  DROP TABLE IF EXISTS source_domain_record;
  PRAGMA user_version = 4;
`;

function expectedTables(version: number): Record<string, readonly string[]> {
  return {
    ...BASE_TABLE_COLUMNS,
    ...(version >= 3 ? V3_TABLE_COLUMNS : {}),
    ...(version >= 4 ? V4_TABLE_COLUMNS : {}),
    ...(version >= 5 ? V5_TABLE_COLUMNS : {}),
  };
}

function expectedIndexes(version: number): string[] {
  return [
    ...BASE_INDEXES,
    ...(version >= 3 ? V3_INDEXES : []),
    ...(version >= 4 ? V4_INDEXES : []),
    ...(version >= 5 ? V5_INDEXES : []),
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
    const uniqueIndexes = (db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ origin: string }>)
      .filter((index) => index.origin === 'u');
    if (uniqueIndexes.length > 0 && table !== 'memory_mention_events') {
      throw new Error(`memory database schema ${version} has an unexpected unique index on ${table}`);
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
  if (version >= 5) {
    assertPrimaryKey(db, 'source_domain_record', ['bank_id', 'endpoint', 'document_id']);
    assertPrimaryKey(db, 'source_domain_link', ['bank_id', 'endpoint', 'document_id', 'domain_id']);
    assertForeignKey(db, 'source_domain_link', 'source_domain_record', 'bank_id', 'bank_id', 'CASCADE');
    assertForeignKey(db, 'source_domain_link', 'source_domain_record', 'endpoint', 'endpoint', 'CASCADE');
    assertForeignKey(db, 'source_domain_link', 'source_domain_record', 'document_id', 'document_id', 'CASCADE');
  }
}

function assertPrimaryKey(db: StateDatabase, table: string, expected: readonly string[]): void {
  const actual = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; pk: number }>)
    .filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`memory database has an invalid ${table} identity`);
}

function assertForeignKey(
  db: StateDatabase,
  table: string,
  target: string,
  from: string,
  to: string,
  onDelete?: string,
): void {
  const rows = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
  if (!rows.some((row) => row.table === target && row.from === from && row.to === to
    && (onDelete === undefined || row.on_delete === onDelete))) {
    throw new Error(`memory database has an invalid ${table} relationship`);
  }
}

function migrateStateSchema(db: StateDatabase, options: MemoryStateMigrationOptions): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 5) throw new Error(`memory database schema ${version} is newer than this application`);
  if (version === 1) throw new Error('memory database schema 1 has no verified migration contract');
  if (version === 5) {
    assertStateSchema(db, 5);
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
      current = 4;
      options.onCheckpoint?.('after-v4-version');
    }
    if (current < 5) {
      db.exec(V5_SCHEMA_SQL);
      assertStateSchema(db, 5);
      options.onCheckpoint?.('after-v5-ddl');
      db.exec('PRAGMA user_version = 5');
      options.onCheckpoint?.('after-v5-version');
    }
    assertStateSchema(db, 5);
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

export function memoryArtifactScope(bankId: string, endpoint: string): string {
  return JSON.stringify([requiredText(bankId, 'bankId'), requiredText(endpoint, 'endpoint')]);
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
  private readonly sourceDomainEvidence?: SourceDomainEvidenceProvider;
  private transactionDepth = 0;
  private closed = false;

  constructor(readonly path: string, options: MemoryStateStoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
    this.db = new DatabaseSync(path);
    this.sourceDomainEvidence = options.sourceDomainEvidence;
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
      migrateStateSchema(this.db, options);
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

  /** Bounded, content-free identities for Growth; classifications are discovery hints only. */
  listGrowthSourceIdentities(bankId: string, endpoint: string, limit = 64): string[] {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new RangeError('Growth identity limit must be between 1 and 128');
    const rows = this.db.prepare(`
      SELECT document_id, MAX(updated_at) AS latest FROM (
        SELECT document_id, updated_at FROM memory_operations
        WHERE bank_id = ? AND endpoint = ? AND state = 'verified'
        UNION ALL
        SELECT document_id, updated_at FROM source_domain_record
        WHERE bank_id = ? AND endpoint = ?
      ) GROUP BY document_id ORDER BY latest DESC, document_id LIMIT ?
    `).all(requiredText(bankId, 'bankId'), requiredText(endpoint, 'endpoint'), bankId, endpoint, limit) as Array<{ document_id: string }>;
    return rows.map(row => row.document_id);
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

  /**
   * Updates one existing outbox operation row without rewriting its event. Used by an authorized
   * local reconciliation where the Bank delivery already happened and the event payload must stay
   * untouched.
   */
  updateOutboxRecord(item: object): boolean {
    this.assertOpen();
    const raw = item as { id?: unknown; state?: unknown; updatedAt?: unknown };
    if (typeof raw.id !== 'string' || typeof raw.state !== 'string' || typeof raw.updatedAt !== 'string') return false;
    const result = this.db.prepare(`
      UPDATE memory_operations
      SET state = ?, updated_at = ?, next_poll_at = NULL, record_json = ?
      WHERE event_id = ?
    `).run(raw.state, raw.updatedAt, JSON.stringify(item), raw.id);
    return result.changes === 1;
  }

  replaceOutbox(items: readonly object[]): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM memory_operations; DELETE FROM memory_events;');
      for (const item of items) this.writeOutbox(item);
    });
  }

  /** Removes only the named retain operations and their own events, never unrelated events. */
  removeOutbox(eventIds: readonly string[]): void {
    if (eventIds.length === 0) return;
    this.transaction(() => {
      const deleteOperation = this.db.prepare('DELETE FROM memory_operations WHERE event_id = ?');
      const deleteEvent = this.db.prepare('DELETE FROM memory_events WHERE event_id = ?');
      for (const eventId of eventIds) {
        deleteOperation.run(eventId);
        deleteEvent.run(eventId);
      }
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
        if (state === 'active') {
          this.markDerivedArtifactsForSource(item.bank_id, item.endpoint, sourceId, 'source-revised', item.updated_at);
        }
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

  loadForgetState(): { state: ForgetStateSnapshot | null; damaged: boolean; blocked: boolean; blockedTargets: ForgetIntentTarget[] | null } {
    this.assertOpen();
    const blocked = this.meta('forget:write-blocked') === '1';
    const encodedBlockedTargets = this.meta('forget:blocked-targets');
    let blockedTargets: ForgetIntentTarget[] | null = null;
    if (encodedBlockedTargets) {
      try {
        const parsed = JSON.parse(encodedBlockedTargets) as unknown;
        if (Array.isArray(parsed) && parsed.every((entry) => entry && typeof entry === 'object'
          && typeof (entry as Record<string, unknown>).bankId === 'string'
          && typeof (entry as Record<string, unknown>).endpoint === 'string'
          && typeof (entry as Record<string, unknown>).documentId === 'string'
          && typeof (entry as Record<string, unknown>).reason === 'string')) {
          blockedTargets = parsed as ForgetIntentTarget[];
        }
      } catch { /* The block remains closed when its retry target cannot be read. */ }
    }
    if (this.meta('forget:present') !== '1') return { state: null, damaged: this.meta('forget:damaged') === '1', blocked, blockedTargets };
    if (this.meta('forget:damaged') === '1') return { state: null, damaged: true, blocked, blockedTargets };
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
        blocked,
        blockedTargets,
      };
    } catch {
      return { state: null, damaged: true, blocked, blockedTargets };
    }
  }

  markForgetWriteBlocked(targets?: readonly ForgetIntentTarget[]): void {
    this.transaction(() => {
      this.setMeta('forget:write-blocked', '1');
      if (targets) this.setMeta('forget:blocked-targets', JSON.stringify(targets));
    });
  }

  /** Commits a fail-closed intent before the source fence and deletion retry are finalized. */
  saveForgetIntents(tasks: readonly object[]): void {
    this.transaction(() => {
      this.setMeta('forget:write-blocked', '1');
      this.setMeta('forget:present', '1');
      const insert = this.db.prepare(`
        INSERT INTO memory_deletions(task_id, bank_id, endpoint, document_id, operation_id, state,
          attempts, verifications, next_attempt_at, record_json)
        VALUES(?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?)
      `);
      for (const raw of tasks) {
        const task = raw as Record<string, unknown>;
        if (typeof task.id !== 'string' || typeof task.bankId !== 'string' || typeof task.endpoint !== 'string'
          || typeof task.documentId !== 'string' || typeof task.reason !== 'string'
          || typeof task.nextAttemptAt !== 'string' || typeof task.createdAt !== 'string' || typeof task.updatedAt !== 'string') {
          throw new Error('invalid memory forget intent');
        }
        insert.run(task.id, task.bankId, task.endpoint, task.documentId,
          typeof task.operationId === 'string' ? task.operationId : null,
          typeof task.attempts === 'number' ? task.attempts : 0,
          typeof task.verifications === 'number' ? task.verifications : 0,
          task.nextAttemptAt, JSON.stringify({ ...task, state: 'intent' }));
      }
      this.db.prepare('DELETE FROM memory_metadata WHERE key = ?').run('forget:blocked-targets');
    });
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
      if (this.meta('forget:damaged') === '1' || this.meta('forget:write-blocked') === '1') {
        return { status: 'forget-unavailable', activation: null };
      }
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

  listDerivedArtifacts(kind: string): DerivedArtifact[] {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT artifact_id FROM derived_artifact WHERE kind = ? ORDER BY created_at, artifact_id
    `).all(requiredText(kind, 'kind')) as Array<{ artifact_id: string }>;
    return rows.flatMap(({ artifact_id }) => {
      const artifact = this.readDerivedArtifact(artifact_id);
      return artifact ? [artifact] : [];
    });
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

  activateDerivedArtifact(artifactId: string, creatorOperationId: string, updatedAt: string): DerivedArtifact | null {
    return this.transaction(() => {
      const current = this.readDerivedArtifact(requiredText(artifactId, 'artifactId'));
      if (!current || current.lifecycleState !== 'pending' || current.creatorOperationId !== creatorOperationId) return null;
      this.db.prepare(`
        UPDATE derived_artifact SET lifecycle_state = 'active', status_reason = NULL, updated_at = ?
        WHERE artifact_id = ? AND lifecycle_state = 'pending' AND creator_operation_id = ?
      `).run(validTimestamp(updatedAt, 'updatedAt'), current.artifactId, creatorOperationId);
      return this.readDerivedArtifact(current.artifactId);
    });
  }

  setDerivedArtifactReviewState(
    artifactId: string,
    reviewState: DerivedArtifactReviewState,
    updatedAt: string,
  ): DerivedArtifact | null {
    if (!['unreviewed', 'approved', 'rejected', 'unknown'].includes(reviewState)) {
      throw new Error('derived artifact reviewState is invalid');
    }
    return this.transaction(() => {
      const current = this.readDerivedArtifact(requiredText(artifactId, 'artifactId'));
      if (!current) return null;
      if (reviewState === 'approved' && current.lifecycleState !== 'active') {
        throw new Error('a non-active derived artifact cannot be approved');
      }
      this.db.prepare(`
        UPDATE derived_artifact SET review_state = ?, updated_at = ? WHERE artifact_id = ?
      `).run(reviewState, validTimestamp(updatedAt, 'updatedAt'), current.artifactId);
      return this.readDerivedArtifact(current.artifactId);
    });
  }

  putSourceDomainClassification(input: SourceDomainClassificationInput): SourceDomainClassification {
    assertSourceDomainClassification(input);
    this.assertSourceDomainWritable();
    const provider = this.sourceDomainEvidence;
    if (!provider) throw new Error('source domain evidence provider is not configured; classification writes are disabled');
    const evidence = provider(input.bankId, input.endpoint, input.documentId);
    if (!evidence) throw new Error('verified source evidence is unavailable');
    if (evidence.bankId !== input.bankId || evidence.endpoint !== input.endpoint || evidence.documentId !== input.documentId) {
      throw new Error('verified source evidence identity does not match the classification');
    }
    if (evidence.sourceActor !== 'user' || !['event', 'correction'].includes(evidence.sourceKind)) {
      throw new Error('only verified user events and corrections can be classified');
    }
    if (evidence.sourceStatus === 'superseded' || evidence.sourceStatus === 'disputed') {
      throw new Error('verified source is no longer current');
    }
    if (typeof evidence.content !== 'string' || evidence.content.length === 0) {
      throw new Error('verified source content is empty');
    }
    const revision = createHash('sha256').update(evidence.content, 'utf8').digest('hex');
    const evidenceEpoch = evidence.sourceEpoch;
    if (input.sourceRevision !== revision) throw new Error('source revision does not match the verified source');
    for (const link of input.links) {
      if (link.evidenceStart === null) continue;
      const end = link.evidenceEnd!;
      if (end > evidence.content.length) throw new Error('evidence span is outside the verified source');
      const digest = createHash('sha256').update(evidence.content.slice(link.evidenceStart, end), 'utf8').digest('hex');
      if (digest !== link.evidenceDigest) throw new Error('evidence digest does not match the verified source span');
    }

    return this.transaction(() => {
      this.assertSourceDomainWritable();
      if (this.isFenced(input.bankId, input.endpoint, input.documentId)) {
        throw new Error('source is fenced and cannot be classified');
      }
      const epoch = this.currentEpoch(input.bankId, input.endpoint);
      if (evidenceEpoch !== epoch || input.sourceEpoch !== epoch) throw new Error('source epoch is stale');
      if (this.supersededSources(input.bankId, input.endpoint).has(input.documentId)) {
        throw new Error('source is superseded and cannot be classified');
      }

      this.db.prepare(`
        DELETE FROM source_domain_link WHERE bank_id = ? AND endpoint = ? AND document_id = ?
      `).run(input.bankId, input.endpoint, input.documentId);
      this.db.prepare(`
        DELETE FROM source_domain_record WHERE bank_id = ? AND endpoint = ? AND document_id = ?
      `).run(input.bankId, input.endpoint, input.documentId);
      this.db.prepare(`
        INSERT INTO source_domain_record(bank_id, endpoint, document_id, state, taxonomy_version,
          classifier_version, confidence, source_epoch, source_revision, classified_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.bankId, input.endpoint, input.documentId, input.state, input.taxonomyVersion,
        input.classifierVersion, input.confidence, epoch, revision, input.classifiedAt, input.updatedAt,
      );
      const insert = this.db.prepare(`
        INSERT INTO source_domain_link(bank_id, endpoint, document_id, domain_id, link_state,
          taxonomy_version, classifier_version, confidence, rule_id, evidence_start, evidence_end,
          evidence_digest, claim_verification, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const link of input.links) insert.run(
        input.bankId, input.endpoint, input.documentId, link.domainId, link.linkState,
        input.taxonomyVersion, input.classifierVersion, link.confidence, link.ruleId,
        link.evidenceStart, link.evidenceEnd, link.evidenceDigest, link.claimVerification, input.updatedAt,
      );
      return this.readSourceDomainRecord(input.bankId, input.endpoint, input.documentId)!;
    });
  }

  /** Persist an exact-read Coo candidate in the separate synthetic source-index path. */
  putCooGrowthCandidateClassification(
    input: SourceDomainClassificationInput,
    evidence: CooGrowthCandidateSourceEvidence,
  ): SourceDomainClassification {
    assertSourceDomainClassification(input);
    this.assertSourceDomainWritable();
    this.assertCooGrowthCandidateClassification(input, evidence);
    const revision = createHash('sha256').update(evidence.content, 'utf8').digest('hex');
    if (input.sourceRevision !== revision) throw new Error('Coo candidate source revision does not match exact read-back');

    return this.transaction(() => {
      this.assertSourceDomainWritable();
      if (this.isFenced(input.bankId, input.endpoint, input.documentId)) {
        throw new Error('Coo candidate source is fenced');
      }
      const epoch = this.currentEpoch(input.bankId, input.endpoint);
      if (evidence.sourceEpoch !== epoch || input.sourceEpoch !== epoch) {
        throw new Error('Coo candidate source epoch is stale');
      }
      if (this.supersededSources(input.bankId, input.endpoint).has(input.documentId)) {
        throw new Error('Coo candidate source is superseded');
      }
      const current = this.readSourceDomainRecord(input.bankId, input.endpoint, input.documentId);
      if (current) {
        const same = current.state === input.state
          && current.taxonomyVersion === input.taxonomyVersion
          && current.classifierVersion === input.classifierVersion
          && current.sourceEpoch === epoch
          && current.sourceRevision === revision
          && JSON.stringify(current.links) === JSON.stringify(input.links);
        if (!same) throw new Error('Coo candidate source index identity conflicts with its persisted classification');
        return current;
      }

      this.db.prepare(`
        INSERT INTO source_domain_record(bank_id, endpoint, document_id, state, taxonomy_version,
          classifier_version, confidence, source_epoch, source_revision, classified_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.bankId, input.endpoint, input.documentId, input.state, input.taxonomyVersion,
        input.classifierVersion, input.confidence, epoch, revision, input.classifiedAt, input.updatedAt,
      );
      const insert = this.db.prepare(`
        INSERT INTO source_domain_link(bank_id, endpoint, document_id, domain_id, link_state,
          taxonomy_version, classifier_version, confidence, rule_id, evidence_start, evidence_end,
          evidence_digest, claim_verification, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const link of input.links) insert.run(
        input.bankId, input.endpoint, input.documentId, link.domainId, link.linkState,
        input.taxonomyVersion, input.classifierVersion, link.confidence, link.ruleId,
        link.evidenceStart, link.evidenceEnd, link.evidenceDigest, link.claimVerification, input.updatedAt,
      );
      return this.readSourceDomainRecord(input.bankId, input.endpoint, input.documentId)!;
    });
  }

  /** Read a Coo candidate index row only alongside its current configured-client exact read-back. */
  getCooGrowthCandidateClassification(
    bankId: string,
    endpoint: string,
    documentId: string,
    evidence: CooGrowthCandidateSourceEvidence,
  ): SourceDomainClassification | null {
    this.assertOpen();
    try {
      const record = this.readSourceDomainRecord(
        requiredText(bankId, 'bankId'), requiredText(endpoint, 'endpoint'), requiredText(documentId, 'documentId'),
      );
      if (!record || record.classifierVersion !== 'coo-growth-source/v1'
        || record.documentId !== evidence.documentId || record.sourceRevision !== createHash('sha256').update(evidence.content, 'utf8').digest('hex')
        || !this.sourceDomainRecordCurrent(record)) return null;
      this.assertCooGrowthCandidateClassification({
        bankId: record.bankId,
        endpoint: record.endpoint,
        documentId: record.documentId,
        state: record.state,
        taxonomyVersion: record.taxonomyVersion,
        classifierVersion: record.classifierVersion,
        confidence: record.confidence,
        sourceEpoch: record.sourceEpoch,
        sourceRevision: record.sourceRevision,
        classifiedAt: record.classifiedAt,
        updatedAt: record.updatedAt,
        links: record.links,
      }, evidence);
      return this.sourceDomainRecordCurrent(record) ? record : null;
    } catch {
      return null;
    }
  }

  getSourceDomainClassification(bankId: string, endpoint: string, documentId: string): SourceDomainClassification | null {
    this.assertOpen();
    const record = this.readSourceDomainRecord(
      requiredText(bankId, 'bankId'), requiredText(endpoint, 'endpoint'), requiredText(documentId, 'documentId'),
    );
    return record && this.sourceDomainRecordReadable(record) ? record : null;
  }

  listDomainSources(
    bankId: string,
    endpoint: string,
    domains: readonly DomainId[],
    opts: { limit?: number; cursor?: string | null } = {},
  ): DomainSourcePage {
    this.assertOpen();
    const bank = requiredText(bankId, 'bankId');
    const target = requiredText(endpoint, 'endpoint');
    const selected = normalizeDomains(domains);
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('domain source limit must be an integer between 1 and 200');
    let cursor = opts.cursor ?? '';
    if (typeof cursor !== 'string') throw new Error('domain source cursor must be a string');
    if (this.meta('forget:damaged') === '1' || this.meta('forget:write-blocked') === '1') {
      return { items: [], nextCursor: null, complete: false, filtered: 0, blocked: true };
    }

    const placeholders = selected.map(() => '?').join(', ');
    const query = this.db.prepare(`
      SELECT bank_id, endpoint, document_id
      FROM source_domain_record
      WHERE bank_id = ? AND endpoint = ? AND state = 'assigned' AND document_id > ?
        AND EXISTS (
          SELECT 1 FROM source_domain_link l
          WHERE l.bank_id = source_domain_record.bank_id
            AND l.endpoint = source_domain_record.endpoint
            AND l.document_id = source_domain_record.document_id
            AND l.link_state = 'confirmed'
            AND l.domain_id IN (${placeholders})
        )
      ORDER BY document_id
      LIMIT ?
    `);
    const items: SourceDomainClassification[] = [];
    let filtered = 0;
    let exhausted = false;
    while (items.length < limit) {
      const requested = limit - items.length + 1;
      const rows = query.all(bank, target, cursor, ...selected, requested) as Array<{
        bank_id: string; endpoint: string; document_id: string;
      }>;
      if (rows.length === 0) { exhausted = true; break; }
      for (const row of rows) {
        cursor = row.document_id;
        const record = this.readSourceDomainRecord(row.bank_id, row.endpoint, row.document_id);
        if (!record || !this.sourceDomainRecordReadable(record)) filtered += 1;
        else items.push(record);
        if (items.length === limit) break;
      }
      if (rows.length < requested) { exhausted = true; break; }
    }
    return {
      items,
      nextCursor: exhausted ? null : cursor,
      complete: exhausted,
      filtered,
      blocked: false,
    };
  }

  domainIndexStats(bankId: string, endpoint: string): SourceDomainStats {
    this.assertOpen();
    const bank = requiredText(bankId, 'bankId');
    const target = requiredText(endpoint, 'endpoint');
    const blocked = this.meta('forget:damaged') === '1' || this.meta('forget:write-blocked') === '1';
    const epoch = this.currentEpoch(bank, target);
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count FROM source_domain_record
      WHERE bank_id = ? AND endpoint = ? GROUP BY state
    `).all(bank, target) as Array<{ state: string; count: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state] = row.count;
    const verifiedSources = (this.db.prepare(`
      WITH operation_sources AS (
        SELECT DISTINCT o.document_id
        FROM memory_operations o JOIN memory_events e USING(event_id)
        WHERE o.bank_id = ? AND o.endpoint = ? AND o.state = 'verified' AND e.actor = 'user'
          AND NOT EXISTS (
            SELECT 1 FROM memory_fences f
            WHERE f.bank_id = o.bank_id AND f.endpoint = o.endpoint AND f.document_id IN (o.document_id, '*')
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_revisions r
            WHERE r.bank_id = o.bank_id AND r.endpoint = o.endpoint
              AND r.supersedes_document_id = o.document_id AND r.state = 'active'
          )
      ), indexed_sources AS (
        SELECT DISTINCT r.document_id
        FROM source_domain_record r
        WHERE r.bank_id = ? AND r.endpoint = ? AND r.source_epoch = ?
          AND r.document_id NOT LIKE 'coo-growth:%'
          AND NOT EXISTS (
            SELECT 1 FROM memory_fences f
            WHERE f.bank_id = r.bank_id AND f.endpoint = r.endpoint AND f.document_id IN (r.document_id, '*')
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_revisions rev
            WHERE rev.bank_id = r.bank_id AND rev.endpoint = r.endpoint
              AND rev.supersedes_document_id = r.document_id AND rev.state = 'active'
          )
      )
      SELECT COUNT(*) AS count FROM (
        SELECT document_id FROM operation_sources
        UNION
        SELECT document_id FROM indexed_sources
      )
    `).get(bank, target, bank, target, epoch) as { count: number }).count;
    const notIndexed = (this.db.prepare(`
      SELECT COUNT(DISTINCT o.document_id) AS count FROM memory_operations o JOIN memory_events e USING(event_id)
      WHERE o.bank_id = ? AND o.endpoint = ? AND o.state = 'verified' AND e.actor = 'user'
        AND NOT EXISTS (
          SELECT 1 FROM memory_fences f
          WHERE f.bank_id = o.bank_id AND f.endpoint = o.endpoint AND f.document_id IN (o.document_id, '*')
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_revisions r
          WHERE r.bank_id = o.bank_id AND r.endpoint = o.endpoint
            AND r.supersedes_document_id = o.document_id AND r.state = 'active'
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_domain_record r
          WHERE r.bank_id = o.bank_id AND r.endpoint = o.endpoint AND r.document_id = o.document_id
            AND r.source_epoch = ? AND r.document_id NOT LIKE 'coo-growth:%'
        )
    `).get(bank, target, epoch) as { count: number }).count;
    const unattributedSources = (this.db.prepare(`
      SELECT COUNT(DISTINCT o.document_id) AS count FROM memory_operations o JOIN memory_events e USING(event_id)
      WHERE o.bank_id = ? AND o.endpoint = ? AND o.state = 'verified' AND e.actor IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM memory_fences f
          WHERE f.bank_id = o.bank_id AND f.endpoint = o.endpoint AND f.document_id IN (o.document_id, '*')
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_revisions rev
          WHERE rev.bank_id = o.bank_id AND rev.endpoint = o.endpoint
            AND rev.supersedes_document_id = o.document_id AND rev.state = 'active'
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_domain_record r
          WHERE r.bank_id = o.bank_id AND r.endpoint = o.endpoint AND r.document_id = o.document_id
            AND r.source_epoch = ? AND r.document_id NOT LIKE 'coo-growth:%'
        )
    `).get(bank, target, epoch) as { count: number }).count;
    return {
      records: rows.reduce((total, row) => total + row.count, 0),
      assigned: counts.assigned ?? 0,
      ambiguous: counts.ambiguous ?? 0,
      pendingReview: counts.pending_review ?? 0,
      unclassified: counts.unclassified ?? 0,
      verifiedSources,
      notIndexed,
      unattributedSources,
      blocked,
    };
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

  private readSourceDomainRecord(
    bankId: string,
    endpoint: string,
    documentId: string,
  ): SourceDomainClassification | null {
    const row = this.db.prepare(`
      SELECT bank_id, endpoint, document_id, state, taxonomy_version, classifier_version,
        confidence, source_epoch, source_revision, classified_at, updated_at
      FROM source_domain_record WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `).get(bankId, endpoint, documentId) as {
      bank_id: string; endpoint: string; document_id: string; state: string;
      taxonomy_version: string; classifier_version: string; confidence: number | null;
      source_epoch: number; source_revision: string; classified_at: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    const order = new Map(DOMAIN_IDS.map((domain, index) => [domain, index]));
    const links = (this.db.prepare(`
      SELECT domain_id, link_state, confidence, rule_id, evidence_start, evidence_end,
        evidence_digest, claim_verification
      FROM source_domain_link WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `).all(bankId, endpoint, documentId) as Array<{
      domain_id: string; link_state: string; confidence: number | null; rule_id: string | null;
      evidence_start: number | null; evidence_end: number | null; evidence_digest: string | null;
      claim_verification: string;
    }>).map((link): SourceDomainLink => ({
      domainId: link.domain_id as DomainId,
      linkState: link.link_state as SourceDomainLink['linkState'],
      confidence: link.confidence,
      ruleId: link.rule_id,
      evidenceStart: link.evidence_start,
      evidenceEnd: link.evidence_end,
      evidenceDigest: link.evidence_digest,
      claimVerification: link.claim_verification as SourceDomainLink['claimVerification'],
    })).sort((left, right) => order.get(left.domainId)! - order.get(right.domainId)!);
    return {
      bankId: row.bank_id,
      endpoint: row.endpoint,
      documentId: row.document_id,
      state: row.state as SourceDomainClassification['state'],
      taxonomyVersion: row.taxonomy_version,
      classifierVersion: row.classifier_version,
      confidence: row.confidence,
      sourceEpoch: row.source_epoch,
      sourceRevision: row.source_revision,
      classifiedAt: row.classified_at,
      updatedAt: row.updated_at,
      links,
    };
  }

  private sourceDomainRecordReadable(record: SourceDomainClassification): boolean {
    if (record.documentId.startsWith('coo-growth:')) return false;
    if (!this.sourceDomainRecordCurrent(record)) return false;
    if (!this.sourceDomainEvidence) return true;
    try {
      const evidence = this.sourceDomainEvidence(record.bankId, record.endpoint, record.documentId);
      if (!evidence || evidence.bankId !== record.bankId || evidence.endpoint !== record.endpoint
        || evidence.documentId !== record.documentId || evidence.sourceEpoch !== record.sourceEpoch) return false;
      if (evidence.sourceActor !== 'user' || !['event', 'correction'].includes(evidence.sourceKind)) return false;
      if (evidence.sourceStatus === 'superseded' || evidence.sourceStatus === 'disputed') return false;
      if (typeof evidence.content !== 'string' || evidence.content.length === 0) return false;
      if (createHash('sha256').update(evidence.content, 'utf8').digest('hex') !== record.sourceRevision) return false;
      return this.sourceDomainRecordCurrent(record);
    } catch {
      return false;
    }
  }

  private assertCooGrowthCandidateClassification(
    input: SourceDomainClassificationInput,
    evidence: CooGrowthCandidateSourceEvidence,
  ): void {
    requiredText(evidence.bankId, 'Coo evidence bankId');
    requiredText(evidence.endpoint, 'Coo evidence endpoint');
    requiredText(evidence.documentId, 'Coo evidence documentId');
    requiredText(evidence.candidateId, 'Coo evidence candidateId');
    requiredText(evidence.generationId, 'Coo evidence generationId');
    requiredText(evidence.responseId, 'Coo evidence responseId');
    requiredText(evidence.creatorOperationId, 'Coo evidence creatorOperationId');
    if (evidence.bankId !== input.bankId || evidence.endpoint !== input.endpoint
      || evidence.documentId !== input.documentId || !evidence.documentId.startsWith(`coo-growth:${evidence.candidateId}:`)) {
      throw new Error('Coo candidate source identity does not match its index row');
    }
    if (evidence.sourceActor !== 'coo' || evidence.sourceStatus !== 'candidate' || evidence.candidateState !== 'candidate'
      || !['plan', 'reflection'].includes(evidence.sourceKind)
      || (evidence.candidateType === 'growth_proposal_candidate' ? evidence.sourceKind !== 'plan'
        : evidence.candidateType === 'experience_card_candidate' ? evidence.sourceKind !== 'reflection' : true)) {
      throw new Error('Coo source does not preserve candidate authorship and status');
    }
    for (const [field, value] of [
      ['candidateBodyDigest', evidence.candidateBodyDigest],
      ['candidateSnapshotDigest', evidence.candidateSnapshotDigest],
      ['sourceBodyDigest', evidence.sourceBodyDigest],
      ['generationReceiptDigest', evidence.generationReceiptDigest],
      ['parentSetDigest', evidence.parentSetDigest],
    ] as const) requiredDigest(value, `Coo evidence ${field}`);
    if (typeof evidence.content !== 'string' || !evidence.content
      || evidence.sourceBodyDigest !== createHash('sha256').update(evidence.content, 'utf8').digest('hex')) {
      throw new Error('Coo source body digest does not match exact read-back');
    }
    if (input.state !== 'assigned' || input.taxonomyVersion !== MEMORY_DOMAIN_TAXONOMY
      || input.classifierVersion !== 'coo-growth-source/v1' || input.confidence !== null
      || input.links.length !== 1 || input.links[0]?.domainId !== 'self-growth'
      || input.links[0]?.linkState !== 'confirmed' || input.links[0]?.claimVerification !== 'external_unverified'
      || input.links[0]?.ruleId !== 'coo-growth-candidate' || input.links[0]?.evidenceStart !== 0
      || input.links[0]?.evidenceEnd !== evidence.content.length || input.links[0]?.evidenceDigest !== evidence.sourceBodyDigest) {
      throw new Error('Coo candidate classification must remain an unverified self-growth candidate');
    }
    if (!Number.isInteger(evidence.sourceEpoch) || evidence.sourceEpoch < 0 || input.sourceEpoch !== evidence.sourceEpoch) {
      throw new Error('Coo candidate source epoch is invalid');
    }
  }

  /**
   * The persisted row and Forget state still match the record. Re-run after a readback
   * provider returns, because that call can commit a Forget, revision or row deletion.
   */
  private sourceDomainRecordCurrent(record: SourceDomainClassification): boolean {
    if (this.meta('forget:damaged') === '1' || this.meta('forget:write-blocked') === '1') return false;
    if (this.isFenced(record.bankId, record.endpoint, record.documentId)) return false;
    if (record.sourceEpoch !== this.currentEpoch(record.bankId, record.endpoint)) return false;
    if (this.supersededSources(record.bankId, record.endpoint).has(record.documentId)) return false;
    const row = this.db.prepare(`
      SELECT source_epoch, source_revision FROM source_domain_record
      WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `).get(record.bankId, record.endpoint, record.documentId) as
      { source_epoch: number; source_revision: string } | undefined;
    return !!row && row.source_epoch === record.sourceEpoch && row.source_revision === record.sourceRevision;
  }

  private assertSourceDomainWritable(): void {
    if (this.meta('forget:damaged') === '1') throw new Error('forget ledger is damaged; source domains are read-only');
    if (this.meta('forget:write-blocked') === '1') throw new Error('forget writes are blocked; source domains are read-only');
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
      ON CONFLICT(event_id) DO UPDATE SET document_id=excluded.document_id,
        actor=COALESCE(excluded.actor, memory_events.actor),
        occurred_at=COALESCE(excluded.occurred_at, memory_events.occurred_at),
        intent=excluded.intent, status=COALESCE(excluded.status, memory_events.status),
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
    if (sourceIds.length === 0) {
      const linked = this.db.prepare(`
        UPDATE memory_revisions SET state = ? WHERE event_id = ?
        RETURNING bank_id, endpoint, supersedes_document_id
      `).all(revisionState, item.id) as Array<{ bank_id: string; endpoint: string; supersedes_document_id: string }>;
      if (revisionState === 'active') {
        for (const source of linked) {
          this.markDerivedArtifactsForSource(source.bank_id, source.endpoint, source.supersedes_document_id, 'source-revised', item.updatedAt);
        }
      }
      return;
    }
    this.db.prepare('DELETE FROM memory_revisions WHERE event_id = ?').run(item.id);
    const revision = this.db.prepare(`
      INSERT INTO memory_revisions(event_id, bank_id, endpoint, document_id, supersedes_document_id, state, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    for (const sourceId of sourceIds) {
      if (typeof item.bankId !== 'string' || typeof item.endpoint !== 'string') continue;
      revision.run(item.id, item.bankId, item.endpoint, item.documentId, sourceId, revisionState,
        typeof item.createdAt === 'string' ? item.createdAt : item.updatedAt);
      if (revisionState === 'active') {
        this.markDerivedArtifactsForSource(item.bankId, item.endpoint, sourceId, 'source-revised', item.updatedAt);
      }
    }
  }

  private currentEpoch(bankId: string, endpoint: string): number {
    const row = this.db.prepare(`
      SELECT epoch FROM memory_derived_state WHERE bank_id = ? AND endpoint = ?
    `).get(bankId, endpoint) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  private isFenced(bankId: string, endpoint: string, documentId: string): boolean {
    if (this.meta('forget:write-blocked') === '1') return true;
    return !!this.db.prepare(`
      SELECT 1 AS fenced FROM memory_fences
      WHERE bank_id = ? AND endpoint = ? AND document_id IN (?, '*')
    `).get(bankId, endpoint, documentId);
  }

  private markDerivedArtifactsForSource(
    bankId: string,
    endpoint: string,
    documentId: string,
    reason: string,
    updatedAt: string,
  ): void {
    this.db.prepare(`
      UPDATE derived_artifact SET lifecycle_state = 'stale', status_reason = ?, updated_at = ?
      WHERE lifecycle_state NOT IN ('stale', 'withdrawn')
        AND (target = ? AND scope = ? OR artifact_id IN (
          SELECT artifact_id FROM derived_artifact_source
          WHERE bank_id = ? AND endpoint = ? AND document_id = ?
        ))
    `).run(reason, updatedAt, documentId, memoryArtifactScope(bankId, endpoint), bankId, endpoint, documentId);
  }

  private markDerivedArtifactsForNamespace(
    bankId: string,
    endpoint: string,
    reason: string,
    updatedAt: string,
  ): void {
    this.db.prepare(`
      UPDATE derived_artifact SET lifecycle_state = 'stale', status_reason = ?, updated_at = ?
      WHERE lifecycle_state NOT IN ('stale', 'withdrawn')
        AND (scope = ? OR artifact_id IN (
          SELECT artifact_id FROM derived_artifact_source WHERE bank_id = ? AND endpoint = ?
        ))
    `).run(reason, updatedAt, memoryArtifactScope(bankId, endpoint), bankId, endpoint);
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
    const deleteDomainLinks = this.db.prepare(`
      DELETE FROM source_domain_link WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `);
    const deleteDomainRecord = this.db.prepare(`
      DELETE FROM source_domain_record WHERE bank_id = ? AND endpoint = ? AND document_id = ?
    `);
    const deleteDomainNamespaceLinks = this.db.prepare(`
      DELETE FROM source_domain_link WHERE bank_id = ? AND endpoint = ?
    `);
    const deleteDomainNamespaceRecords = this.db.prepare(`
      DELETE FROM source_domain_record WHERE bank_id = ? AND endpoint = ?
    `);
    for (const raw of state.tombstones) {
      const entry = raw as Record<string, unknown>;
      const bankId = entry.bankId as string;
      const endpoint = entry.endpoint as string;
      const documentId = entry.documentId as string;
      const at = entry.at as string;
      if (documentId === '*') {
        this.markDerivedArtifactsForNamespace(bankId, endpoint, 'bank-cleared', at);
        this.db.prepare('DELETE FROM memory_activation WHERE bank_id = ? AND endpoint = ?').run(bankId, endpoint);
        this.db.prepare('DELETE FROM memory_mention_events WHERE bank_id = ? AND endpoint = ?').run(bankId, endpoint);
        deleteDomainNamespaceLinks.run(bankId, endpoint);
        deleteDomainNamespaceRecords.run(bankId, endpoint);
        continue;
      }
      this.markDerivedArtifactsForSource(bankId, endpoint, documentId, 'source-forgotten', at);
      const dependents = mentionsForSource.all(bankId, endpoint, documentId) as Array<{ target_document_id: string }>;
      for (const dependent of dependents) deleteActivation.run(bankId, endpoint, dependent.target_document_id);
      deleteActivation.run(bankId, endpoint, documentId);
      deleteMentions.run(bankId, endpoint, documentId, documentId);
      deleteDomainLinks.run(bankId, endpoint, documentId);
      deleteDomainRecord.run(bankId, endpoint, documentId);
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
    this.setMeta('forget:write-blocked', '0');
    this.db.prepare('DELETE FROM memory_metadata WHERE key = ?').run('forget:blocked-targets');
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
