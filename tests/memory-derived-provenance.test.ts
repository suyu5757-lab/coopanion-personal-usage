import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import {
  closeMemoryStateStores,
  memoryArtifactScope,
  MemoryStateStore,
  openMemoryStateStore,
  type DerivedArtifactInput,
  type GenerationEvidenceInput,
  type MemorySourceDependency,
} from '../core/memory/state-store.ts';
import {
  createLegacyMemoryStateDatabase,
  openLegacyMemoryStateDatabase,
  snapshotLegacyDurableRows,
  type LegacyMemorySchemaVersion,
} from './fixtures/memory-state-legacy.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'coo-derived-provenance-'));
  roots.push(path);
  return path;
};
const databasePath = () => join(root(), 'memory-state.sqlite');
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const digestC = 'c'.repeat(64);
const at = '2026-11-03T02:00:00.000Z';

afterEach(() => {
  closeMemoryStateStores();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function source(overrides: Partial<MemorySourceDependency> = {}): MemorySourceDependency {
  return {
    bankId: 'bank-a', endpoint: 'https://memory-a.test', documentId: 'doc-shared',
    validatedEpoch: 4, validatedFence: null, revision: 'rev-4', contentDigest: digestA,
    segmentDigest: digestB, validationState: 'validated', correlationId: 'read-1',
    ...overrides,
  };
}

function generation(overrides: Partial<GenerationEvidenceInput> = {}): GenerationEvidenceInput {
  return {
    sessionId: 'session-1', generationId: 'generation-1', providerAttemptId: 'attempt-1',
    responseId: 'response-1', toolCorrelationId: null, origin: 'provider-response',
    mappingState: 'unknown', validationReceiptDigest: null, validatedAt: null,
    exceptionReason: 'source ledger unavailable', createdAt: at, sources: [],
    ...overrides,
  };
}

function artifact(overrides: Partial<DerivedArtifactInput> = {}): DerivedArtifactInput {
  return {
    artifactId: 'artifact-1', kind: 'persona-candidate', target: 'persona/profile', scope: 'coopanion:local',
    creatorSessionId: 'session-1', creatorGenerationId: 'generation-1', creatorOperationId: null,
    bodyDigest: digestC, origin: 'model-derived', reviewState: 'unreviewed', lifecycleState: 'pending',
    lineageState: 'unknown', lineageReceiptDigest: null, lineageValidatedAt: null,
    statusReason: 'lineage is incomplete', createdAt: at, updatedAt: at, sources: [],
    ...overrides,
  };
}

function versionOf(path: string): number {
  const db = new DatabaseSync(path);
  try { return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }
  finally { db.close(); }
}

function schemaSnapshot(path: string): string {
  const db = new DatabaseSync(path);
  try {
    return JSON.stringify(db.prepare(`
      SELECT type, name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `).all());
  } finally { db.close(); }
}

function expectIntegrity(path: string): void {
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
}

function expectLegacyRowsUnchanged(path: string, version: LegacyMemorySchemaVersion, before: string): void {
  const db = openLegacyMemoryStateDatabase(path);
  try { expect(snapshotLegacyDurableRows(db, version)).toBe(before); }
  finally { db.close(); }
}

describe('SQLite v4 migration (B01-B06)', () => {
  it('B01 upgrades the historical v3 schema and retains every durable row', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 3);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, 3);
    old.close();

    openMemoryStateStore(path);

    expect(versionOf(path)).toBe(4);
    expectLegacyRowsUnchanged(path, 3, before);
    expectIntegrity(path);
  });

  it('B02 upgrades the historical v2 schema without rebuilding old rows', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 2);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, 2);
    old.close();

    openMemoryStateStore(path);

    expect(versionOf(path)).toBe(4);
    expectLegacyRowsUnchanged(path, 2, before);
    expectIntegrity(path);
  });

  it('B02 leaves an unverified schema 1 marker gated without changing it', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 1');
    db.close();
    const before = schemaSnapshot(path);
    const beforeDigest = createHash('sha256').update(readFileSync(path)).digest('hex');

    expect(() => new MemoryStateStore(path)).toThrow('schema 1 has no verified migration contract');
    expect(versionOf(path)).toBe(1);
    expect(schemaSnapshot(path)).toBe(before);
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(beforeDigest);
  });

  it('B03 initializes an empty database and repeats startup without schema changes', () => {
    const path = databasePath();
    openMemoryStateStore(path);
    const firstSchema = schemaSnapshot(path);
    closeMemoryStateStores();

    openMemoryStateStore(path);

    expect(versionOf(path)).toBe(4);
    expect(schemaSnapshot(path)).toBe(firstSchema);
    expectIntegrity(path);
  });

  it('B05 rolls back a failed v3-to-v4 migration and succeeds on retry', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 3);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, 3);
    old.close();

    expect(() => new MemoryStateStore(path, {
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'after-v4-ddl') throw new Error('injected migration failure');
      },
    })).toThrow('injected migration failure');
    expect(versionOf(path)).toBe(3);
    expectLegacyRowsUnchanged(path, 3, before);
    const afterRollback = openLegacyMemoryStateDatabase(path);
    try {
      const tables = (afterRollback.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%artifact%' ORDER BY name")
        .all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([]);
    } finally { afterRollback.close(); }

    openMemoryStateStore(path);
    expect(versionOf(path)).toBe(4);
    expectLegacyRowsUnchanged(path, 3, before);
    expectIntegrity(path);
  });

  it('B05 rolls user_version=4 back when commit fails after the version write', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 3);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, 3);
    old.close();

    expect(() => new MemoryStateStore(path, {
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'after-v4-version') throw new Error('injected pre-commit failure');
      },
    })).toThrow('injected pre-commit failure');
    expect(versionOf(path)).toBe(3);
    expectLegacyRowsUnchanged(path, 3, before);
    const afterRollback = openLegacyMemoryStateDatabase(path);
    try {
      const tables = (afterRollback.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table'
          AND name IN ('generation_evidence', 'generation_source_dependency', 'derived_artifact', 'derived_artifact_source')
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([]);
    } finally { afterRollback.close(); }

    openMemoryStateStore(path);
    expect(versionOf(path)).toBe(4);
    expectLegacyRowsUnchanged(path, 3, before);
    expectIntegrity(path);
  });

  it('B06 keeps repeated opens and deterministic writes free of duplicate rows and indexes', () => {
    const path = databasePath();
    let store = openMemoryStateStore(path);
    const evidence = generation({
      mappingState: 'complete', validationReceiptDigest: digestC, validatedAt: at,
      exceptionReason: null, sources: [source()],
    });
    expect(store.saveGenerationEvidence(evidence)).toEqual(store.saveGenerationEvidence(evidence));
    const pending = artifact({
      lineageState: 'complete', lineageReceiptDigest: digestC, lineageValidatedAt: at,
      statusReason: null, sources: [source()],
    });
    expect(store.saveDerivedArtifact(pending)).toEqual(store.saveDerivedArtifact(pending));
    const before = schemaSnapshot(path);
    closeMemoryStateStores();

    store = openMemoryStateStore(path);
    expect(store.getGenerationEvidence('session-1', 'generation-1')?.sources).toHaveLength(1);
    expect(store.getDerivedArtifact('artifact-1')?.sources).toHaveLength(1);
    expect(schemaSnapshot(path)).toBe(before);
    expectIntegrity(path);
  });
});

describe('SQLite v4 provenance identities (B07-B11)', () => {
  it('B07 isolates identical document IDs by full bank and endpoint identity', () => {
    const store = openMemoryStateStore(databasePath());
    const variants = [
      source({ bankId: 'bank-a', endpoint: 'https://memory-a.test' }),
      source({ bankId: 'bank-b', endpoint: 'https://memory-a.test' }),
      source({ bankId: 'bank-a', endpoint: 'https://memory-b.test' }),
    ];
    variants.forEach((item, index) => store.saveDerivedArtifact(artifact({
      artifactId: `artifact-${index + 1}`, creatorSessionId: null, creatorGenerationId: null,
      origin: 'user-authored', lineageState: 'complete', lineageReceiptDigest: digestC,
      lineageValidatedAt: at, lifecycleState: 'active', statusReason: null, sources: [item],
    })));

    expect(store.derivedArtifactsForSource('bank-a', 'https://memory-a.test', 'doc-shared').map((item) => item.artifactId))
      .toEqual(['artifact-1']);
    expect(store.derivedArtifactsForSource('bank-b', 'https://memory-a.test', 'doc-shared').map((item) => item.artifactId))
      .toEqual(['artifact-2']);
    expect(store.derivedArtifactsForSource('bank-a', 'https://memory-b.test', 'doc-shared').map((item) => item.artifactId))
      .toEqual(['artifact-3']);
  });

  it('B08 stores zero, one and multiple dependencies without inferring independence', () => {
    const store = openMemoryStateStore(databasePath());
    const noSources = store.saveGenerationEvidence(generation({ sessionId: 'session-zero', generationId: 'generation-zero' }));
    expect(noSources.mappingState).toBe('unknown');
    expect(noSources.sources).toEqual([]);
    expect(() => store.saveGenerationEvidence(generation({
      sessionId: 'session-unproved', generationId: 'generation-unproved', mappingState: 'complete',
      validationReceiptDigest: null, validatedAt: null,
    }))).toThrow('complete source mapping requires a receipt and validation time');

    const one = store.saveGenerationEvidence(generation({
      sessionId: 'session-one', generationId: 'generation-one', mappingState: 'complete',
      validationReceiptDigest: digestC, validatedAt: at, exceptionReason: null, sources: [source()],
    }));
    const multi = store.saveGenerationEvidence(generation({
      sessionId: 'session-many', generationId: 'generation-many', mappingState: 'complete',
      validationReceiptDigest: digestC, validatedAt: at, exceptionReason: null,
      sources: [source(), source({ bankId: 'bank-b' }), source({ endpoint: 'https://memory-b.test' }), source()],
    }));
    expect(one.sources).toHaveLength(1);
    expect(multi.sources).toHaveLength(3);
    expect(store.saveGenerationEvidence(generation({
      sessionId: 'session-independent', generationId: 'generation-independent', mappingState: 'source-independent',
      validationReceiptDigest: digestC, validatedAt: at, exceptionReason: null,
    })).mappingState).toBe('source-independent');
  });

  it('B09 preserves missing and ambiguous lineage through state changes and restart reads', () => {
    const path = databasePath();
    const store = openMemoryStateStore(path);
    store.saveGenerationEvidence(generation({ sessionId: 'session-missing', generationId: 'generation-missing', mappingState: 'missing' }));
    store.saveGenerationEvidence(generation({ sessionId: 'session-ambiguous', generationId: 'generation-ambiguous', mappingState: 'ambiguous' }));
    const unknown = artifact({
      artifactId: 'legacy-or-evicted', creatorSessionId: null, creatorGenerationId: null,
      origin: 'unknown', lifecycleState: 'unknown', lineageState: 'unknown', statusReason: 'source ledger unavailable',
    });
    store.saveDerivedArtifact(unknown);
    expect(() => store.saveDerivedArtifact(artifact({ lifecycleState: 'active' })))
      .toThrow('artifacts with incomplete lineage cannot be active');

    const withheld = store.markDerivedArtifactState('legacy-or-evicted', 'withheld', 'lineage remains unknown', at)!;
    expect(withheld).toMatchObject({ lifecycleState: 'withheld', lineageState: 'unknown', sources: [] });
    closeMemoryStateStores();
    const reopened = openMemoryStateStore(path);
    expect(reopened.getGenerationEvidence('session-missing', 'generation-missing')?.mappingState).toBe('missing');
    expect(reopened.getGenerationEvidence('session-ambiguous', 'generation-ambiguous')?.mappingState).toBe('ambiguous');
    expect(reopened.getDerivedArtifact('legacy-or-evicted')).toMatchObject({ lifecycleState: 'withheld', lineageState: 'unknown' });
  });

  it('B10 makes exact repeats idempotent and reports revision or digest conflicts', () => {
    const store = openMemoryStateStore(databasePath());
    const original = generation({
      mappingState: 'complete', validationReceiptDigest: digestC, validatedAt: at,
      exceptionReason: null, sources: [source()],
    });
    const first = store.saveGenerationEvidence(original);
    expect(store.saveGenerationEvidence(original)).toEqual(first);
    expect(() => store.saveGenerationEvidence(generation({
      mappingState: 'complete', validationReceiptDigest: digestC, validatedAt: at,
      exceptionReason: null, sources: [source({ revision: 'rev-5', contentDigest: digestB })],
    }))).toThrow('generation evidence identity has conflicting metadata');

    const originalArtifact = artifact({
      lineageState: 'complete', lineageReceiptDigest: digestC, lineageValidatedAt: at,
      statusReason: null, sources: [source()],
    });
    const saved = store.saveDerivedArtifact(originalArtifact);
    expect(store.saveDerivedArtifact(originalArtifact)).toEqual(saved);
    expect(() => store.saveDerivedArtifact({ ...originalArtifact, bodyDigest: digestB }))
      .toThrow('derived artifact identity has conflicting metadata');
  });

  it('B11 restores provenance metadata after reopening without storing provider or source bodies', () => {
    const path = databasePath();
    let store = openMemoryStateStore(path);
    const evidence = store.saveGenerationEvidence(generation({
      mappingState: 'complete', validationReceiptDigest: digestC, validatedAt: at,
      exceptionReason: null, sources: [source()],
    }));
    const savedArtifact = store.saveDerivedArtifact(artifact({
      lineageState: 'complete', lineageReceiptDigest: digestC, lineageValidatedAt: at,
      statusReason: null, sources: [source()],
    }));
    closeMemoryStateStores();

    store = openMemoryStateStore(path);
    expect(store.getGenerationEvidence(evidence.sessionId, evidence.generationId)).toEqual(evidence);
    expect(store.getDerivedArtifact(savedArtifact.artifactId)).toEqual(savedArtifact);
    const db = new DatabaseSync(path);
    try {
      const evidenceColumns = (db.prepare('PRAGMA table_info(generation_evidence)').all() as Array<{ name: string }>).map((row) => row.name);
      const artifactColumns = (db.prepare('PRAGMA table_info(derived_artifact)').all() as Array<{ name: string }>).map((row) => row.name);
      expect(evidenceColumns).not.toContain('provider_body');
      expect(evidenceColumns).not.toContain('serialized_request');
      expect(artifactColumns).toContain('body_digest');
      expect(artifactColumns).not.toContain('body');
      expect(db.prepare('SELECT COUNT(*) AS count FROM generation_evidence').get()).toMatchObject({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM derived_artifact').get()).toMatchObject({ count: 1 });
    } finally { db.close(); }
  });
});

describe('SQLite v4 fail-closed schema checks (B12)', () => {
  it('rejects unversioned partial schemas and leaves their user version unchanged', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE memory_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.close();

    expect(() => new MemoryStateStore(path)).toThrow('unversioned memory database is not empty');
    expect(versionOf(path)).toBe(0);
  });

  it('rejects a partial v3 schema without writing v4 tables', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 3);
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE memory_deletions');
    db.close();

    expect(() => new MemoryStateStore(path)).toThrow('unexpected table layout');
    expect(versionOf(path)).toBe(3);
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'generation_%'").all()).toEqual([]);
      expect(after.prepare('SELECT COUNT(*) AS count FROM memory_fences').get()).toMatchObject({ count: 1 });
    } finally { after.close(); }
  });

  it('rejects a database version newer than v4', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();

    expect(() => new MemoryStateStore(path)).toThrow('schema 99 is newer than this application');
    expect(versionOf(path)).toBe(99);
  });
});

describe('C2-C derived artifact revocation', () => {
  const activeArtifact = (
    artifactId: string,
    scope: string,
    sources: MemorySourceDependency[],
  ): DerivedArtifactInput => ({
    artifactId, kind: 'consumer-fixture', target: `consumer/${artifactId}`, scope,
    creatorSessionId: null, creatorGenerationId: null, creatorOperationId: `op-${artifactId}`,
    bodyDigest: digestC, origin: 'user-authored', reviewState: 'approved', lifecycleState: 'active',
    lineageState: sources.length ? 'complete' : 'source-independent', lineageReceiptDigest: digestB,
    lineageValidatedAt: at, statusReason: null, createdAt: at, updatedAt: at, sources,
  });

  it('C2-06 fences one parent and atomically stales only dependent artifacts in that namespace across restart', () => {
    const path = databasePath();
    const store = openMemoryStateStore(path);
    const namespace = memoryArtifactScope('bank-a', 'https://memory-a.test');
    const dependent = store.saveDerivedArtifact(activeArtifact('derived-multi', namespace, [
      source({ documentId: 'doc-shared', validatedEpoch: 4, validatedFence: '4' }),
      source({ documentId: 'doc-second', validatedEpoch: 4, validatedFence: '4' }),
    ]));
    const sameIdElsewhere = store.saveDerivedArtifact(activeArtifact('same-id-other-bank',
      memoryArtifactScope('bank-b', 'https://memory-a.test'),
      [source({ bankId: 'bank-b', validatedEpoch: 4, validatedFence: '4' })]));
    const independent = store.saveDerivedArtifact(activeArtifact('source-free', namespace, []));
    const ledger = new ForgetLedger(store, { now: () => new Date(at) });

    expect(ledger.add({ bankId: 'bank-a', endpoint: 'https://memory-a.test', documentId: 'doc-shared', reason: 'synthetic forget' })).not.toBeNull();

    expect(store.getDerivedArtifact(dependent.artifactId)).toMatchObject({ lifecycleState: 'stale', statusReason: 'source-forgotten' });
    expect(store.getDerivedArtifact(sameIdElsewhere.artifactId)?.lifecycleState).toBe('active');
    expect(store.getDerivedArtifact(independent.artifactId)?.lifecycleState).toBe('active');
    expect(ledger.forgotten('bank-a', 'https://memory-a.test', 'doc-shared')).toBe(true);
    expect(ledger.forgotten('bank-b', 'https://memory-a.test', 'doc-shared')).toBe(false);

    closeMemoryStateStores();
    const reopened = openMemoryStateStore(path);
    expect(reopened.getDerivedArtifact(dependent.artifactId)?.lifecycleState).toBe('stale');
    expect(reopened.getDerivedArtifact(sameIdElsewhere.artifactId)?.lifecycleState).toBe('active');
    expect(reopened.getDerivedArtifact(independent.artifactId)?.lineageState).toBe('source-independent');
    expectIntegrity(path);
  });

  it('C2-07 marks source dependents stale when a verified revision is linked and keeps other scopes active', () => {
    const store = openMemoryStateStore(databasePath());
    const namespace = memoryArtifactScope('bank-a', 'https://memory-a.test');
    const artifactBeforeRevision = store.saveDerivedArtifact(activeArtifact('revision-dependent', namespace,
      [source({ documentId: 'doc-old', validatedEpoch: 4, validatedFence: '4' })]));
    const otherNamespace = store.saveDerivedArtifact(activeArtifact('revision-other-scope',
      memoryArtifactScope('bank-b', 'https://memory-a.test'),
      [source({ bankId: 'bank-b', documentId: 'doc-old', validatedEpoch: 4, validatedFence: '4' })]));
    store.saveOutbox({
      id: 'revision-event', bankId: 'bank-a', endpoint: 'https://memory-a.test', documentId: 'doc-new',
      operationId: 'revision-operation', state: 'verified', attempts: 1, nextAttemptAt: at, updatedAt: at,
      createdAt: at, content: 'synthetic revision', context: 'test', tags: [], metadata: {
        source_actor: 'user', supersedes_source_ids: JSON.stringify(['doc-old']),
      }, timestamp: at,
    });

    expect(store.getDerivedArtifact(artifactBeforeRevision.artifactId)).toMatchObject({
      lifecycleState: 'stale', statusReason: 'source-revised',
    });
    expect(store.getDerivedArtifact(otherNamespace.artifactId)?.lifecycleState).toBe('active');
  });

  it('C2-07 keeps a wildcard clear fence until the remote clear is confirmed and leaves the namespace stale after release', () => {
    const store = openMemoryStateStore(databasePath());
    const namespace = memoryArtifactScope('bank-a', 'https://memory-a.test');
    const artifactBeforeClear = store.saveDerivedArtifact(activeArtifact('clear-dependent', namespace,
      [source({ validatedEpoch: 4, validatedFence: '4' })]));
    const ledger = new ForgetLedger(store, { now: () => new Date(at) });
    const before = ledger.epoch('bank-a', 'https://memory-a.test');

    expect(ledger.beginClearTarget('bank-a', 'https://memory-a.test')).toBe(true);
    expect(ledger.bankClearPending('bank-a', 'https://memory-a.test')).toBe(true);
    expect(ledger.forgotten('bank-a', 'https://memory-a.test', 'unseen-document')).toBe(true);
    expect(ledger.epoch('bank-a', 'https://memory-a.test')).toBe(before + 1);
    expect(store.getDerivedArtifact(artifactBeforeClear.artifactId)?.lifecycleState).toBe('stale');

    expect(ledger.finishClearTarget('bank-a', 'https://memory-a.test')).toBe(true);
    expect(ledger.bankClearPending('bank-a', 'https://memory-a.test')).toBe(false);
    expect(ledger.stale('bank-a', 'https://memory-a.test')).toBe(true);
    expect(store.getDerivedArtifact(artifactBeforeClear.artifactId)?.lifecycleState).toBe('stale');
  });
});
