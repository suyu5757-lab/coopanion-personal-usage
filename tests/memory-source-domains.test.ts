import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import {
  MemoryStateStore,
  V5_DOWN_SCHEMA_SQL,
  type MemoryStateStoreOptions,
} from '../core/memory/state-store.ts';
import {
  DOMAIN_IDS,
  MEMORY_DOMAIN_TAXONOMY,
  assertSourceDomainClassification,
  normalizeDomains,
  type DomainId,
  type SourceDomainClassificationInput,
  type SourceDomainEvidence,
  type SourceDomainEvidenceProvider,
  type SourceDomainLinkInput,
} from '../core/memory/source-domains.ts';
import {
  createLegacyMemoryStateDatabase,
  openLegacyMemoryStateDatabase,
  snapshotLegacyDurableRows,
  type LegacyMemorySchemaVersion,
} from './fixtures/memory-state-legacy.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
const stores: MemoryStateStore[] = [];
const at = '2026-11-09T06:00:00.000Z';
const sourceContent = 'The person said to Coo: I prefer jasmine tea after dinner.';
const sourceDigest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const spanDigest = (content: string, start: number, end: number) =>
  createHash('sha256').update(content.slice(start, end), 'utf8').digest('hex');

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'coo-source-domains-'));
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`unsafe synthetic database root: ${resolved}`);
  }
  roots.push(path);
  return path;
}

function databasePath(): string {
  return join(root(), 'memory-state.sqlite');
}

function openStore(path: string, options: MemoryStateStoreOptions = {}): MemoryStateStore {
  const store = new MemoryStateStore(path, options);
  stores.push(store);
  return store;
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

function source(overrides: Partial<SourceDomainEvidence> = {}): SourceDomainEvidence {
  return {
    bankId: 'bank-a',
    endpoint: 'https://memory.test',
    documentId: 'user:main:1',
    content: sourceContent,
    sourceEpoch: 0,
    sourceActor: 'user',
    sourceKind: 'event',
    sourceStatus: 'completed',
    ...overrides,
  };
}

function tupleKey(bankId: string, endpoint: string, documentId: string): string {
  return JSON.stringify([bankId, endpoint, documentId]);
}

function evidenceRegistry(initial: SourceDomainEvidence[] = []) {
  const entries = new Map(initial.map((entry) => [
    tupleKey(entry.bankId, entry.endpoint, entry.documentId),
    entry,
  ]));
  return {
    provider: ((bankId, endpoint, documentId) =>
      entries.get(tupleKey(bankId, endpoint, documentId)) ?? null) as SourceDomainEvidenceProvider,
    set(entry: SourceDomainEvidence) {
      entries.set(tupleKey(entry.bankId, entry.endpoint, entry.documentId), entry);
    },
    remove(bankId: string, endpoint: string, documentId: string) {
      entries.delete(tupleKey(bankId, endpoint, documentId));
    },
  };
}

function confirmedLink(
  domainId: DomainId,
  content = sourceContent,
  overrides: Partial<SourceDomainLinkInput> = {},
): SourceDomainLinkInput {
  return {
    domainId,
    linkState: 'confirmed',
    confidence: 0.9,
    ruleId: 'SYNTHETIC-01',
    evidenceStart: 0,
    evidenceEnd: Math.min(24, content.length),
    evidenceDigest: spanDigest(content, 0, Math.min(24, content.length)),
    claimVerification: 'user_verified',
    ...overrides,
  };
}

function candidateLink(
  domainId: DomainId,
  content = sourceContent,
  overrides: Partial<SourceDomainLinkInput> = {},
): SourceDomainLinkInput {
  return {
    domainId,
    linkState: 'candidate',
    confidence: 0.4,
    ruleId: null,
    evidenceStart: 0,
    evidenceEnd: Math.min(24, content.length),
    evidenceDigest: spanDigest(content, 0, Math.min(24, content.length)),
    claimVerification: 'external_unverified',
    ...overrides,
  };
}

function classificationFor(
  entry: SourceDomainEvidence,
  overrides: Partial<SourceDomainClassificationInput> = {},
): SourceDomainClassificationInput {
  return {
    bankId: entry.bankId,
    endpoint: entry.endpoint,
    documentId: entry.documentId,
    state: 'assigned',
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: 'synthetic-rules-v1',
    confidence: 0.9,
    sourceEpoch: entry.sourceEpoch,
    sourceRevision: sourceDigest(entry.content),
    classifiedAt: at,
    updatedAt: at,
    links: [confirmedLink('user-relationship', entry.content)],
    ...overrides,
  };
}

function seedVerifiedOutbox(
  store: MemoryStateStore,
  documentId: string,
  options: { actor?: 'user' | 'coo' | null; kind?: 'event' | 'correction' } = {},
): void {
  const outbox = new MemoryOutbox(store);
  outbox.add({
    bankId: 'bank-a',
    endpoint: 'https://memory.test',
    documentId,
    content: 'Synthetic verified source.',
    context: 'synthetic fixture',
    tags: ['scope:test'],
    priority: 'normal',
    metadata: {
      ...(options.actor === null ? {} : { source_actor: options.actor ?? 'user' }),
      kind: options.kind ?? 'event',
      status: 'completed',
      said_at: at,
    },
  });
  const item = outbox.due(new Date(), 1).find((entry) => entry.documentId === documentId)!;
  expect(outbox.markSending(item.id)).toBe(true);
  expect(outbox.markSent(item.id, item.operationId)).toBe(true);
  expect(outbox.markDone(item.id)).toBe(true);
  expect(outbox.markVerified(item.id)).toBe(true);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('SQLite v5 migration and schema', () => {
  it('MIG-01 initializes an empty database at v5 and reopens it without schema changes', () => {
    const path = databasePath();
    const store = openStore(path);
    expect(versionOf(path)).toBe(5);
    const first = schemaSnapshot(path);
    store.close();
    const reopened = openStore(path);
    expect(versionOf(path)).toBe(5);
    expect(schemaSnapshot(path)).toBe(first);
    expect(reopened.listDomainSources('bank-a', 'https://memory.test', ['user-relationship']).items).toEqual([]);
    expectIntegrity(path);
  });

  it.each([2, 3, 4] as const)('MIG-%i upgrades the historical v%i fixture and keeps every durable row', (version) => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, version);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, version);
    old.close();

    openStore(path);

    expect(versionOf(path)).toBe(5);
    expectLegacyRowsUnchanged(path, version, before);
    expectIntegrity(path);
  });

  it('MIG-05 treats a repeated v5 open as a no-op', () => {
    const path = databasePath();
    openStore(path);
    const before = schemaSnapshot(path);
    stores.splice(0).forEach((store) => store.close());
    openStore(path);
    expect(schemaSnapshot(path)).toBe(before);
    expectIntegrity(path);
  });

  it('MIG-06 rejects schema v1 and leaves its file, schema and rows unchanged', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE unknown_records (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      INSERT INTO unknown_records (id, body) VALUES (1, 'synthetic historical data');
    `);
    db.close();
    const before = schemaSnapshot(path);

    expect(() => openStore(path)).toThrow('schema 1 has no verified migration contract');
    expect(versionOf(path)).toBe(1);
    expect(schemaSnapshot(path)).toBe(before);
  });

  it('MIG-07 rejects a future schema version', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();

    expect(() => openStore(path)).toThrow('schema 99 is newer than this application');
    expect(versionOf(path)).toBe(99);
  });

  it('MIG-08 rolls back after v5 DDL when the migration is interrupted', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 4);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, 4);
    old.close();

    expect(() => new MemoryStateStore(path, {
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'after-v5-ddl') throw new Error('injected v5 DDL failure');
      },
    })).toThrow('injected v5 DDL failure');
    expect(versionOf(path)).toBe(4);
    expectLegacyRowsUnchanged(path, 4, before);
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'source_domain_%'").all()).toEqual([]);
    } finally { after.close(); }

    openStore(path);
    expect(versionOf(path)).toBe(5);
    expectLegacyRowsUnchanged(path, 4, before);
    expectIntegrity(path);
  });

  it('MIG-09 rolls user_version back when the v5 version write fails before commit', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 4);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, 4);
    old.close();

    expect(() => new MemoryStateStore(path, {
      onCheckpoint: (checkpoint) => {
        if (checkpoint === 'after-v5-version') throw new Error('injected v5 commit failure');
      },
    })).toThrow('injected v5 commit failure');
    expect(versionOf(path)).toBe(4);
    expectLegacyRowsUnchanged(path, 4, before);
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'source_domain_%'").all()).toEqual([]);
    } finally { after.close(); }

    openStore(path);
    expect(versionOf(path)).toBe(5);
    expectLegacyRowsUnchanged(path, 4, before);
    expectIntegrity(path);
  });

  it('MIG-10 rejects extra or missing schema objects', () => {
    const path = databasePath();
    openStore(path);
    stores.splice(0).forEach((store) => store.close());
    const db = new DatabaseSync(path);
    db.exec(`CREATE TRIGGER unexpected_domain_trigger AFTER INSERT ON source_domain_record
      BEGIN SELECT 1; END;`);
    db.close();
    expect(() => openStore(path)).toThrow('unexpected table layout');

    const repair = new DatabaseSync(path);
    repair.exec('DROP TRIGGER unexpected_domain_trigger; DROP INDEX source_domain_link_domain;');
    repair.close();
    expect(() => openStore(path)).toThrow('unexpected index layout');
  });

  it('MIG-11 downgrades a synthetic v5 database without touching v4 rows or forget state', () => {
    const path = databasePath();
    createLegacyMemoryStateDatabase(path, 4);
    const registry = evidenceRegistry([source({ documentId: 'legacy-live' })]);
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(source({ documentId: 'legacy-live' })));
    store.close();
    const afterIndex = new DatabaseSync(path);
    const beforeDowngrade = snapshotLegacyDurableRows(afterIndex, 4);
    afterIndex.close();

    const db = new DatabaseSync(path);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(V5_DOWN_SCHEMA_SQL);
      db.exec('COMMIT');
    } finally { db.close(); }

    expect(versionOf(path)).toBe(4);
    expectLegacyRowsUnchanged(path, 4, beforeDowngrade);
    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'source_domain_%'").all()).toEqual([]);
      expect(after.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { after.close(); }
  });

  it('SCH-01 keeps exactly two derived tables, three indexes and the full-tuple link identity', () => {
    const path = databasePath();
    openStore(path);
    const db = new DatabaseSync(path);
    try {
      const tables = (db.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'source_domain_%' ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual(['source_domain_link', 'source_domain_record']);
      const indexes = (db.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL
          AND name LIKE 'source_domain_%' ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(indexes).toEqual(['source_domain_link_domain', 'source_domain_link_namespace', 'source_domain_record_state']);
      expect((db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger', 'view')").all() as Array<{ name: string }>)).toEqual([]);
      const primaryKey = (db.prepare('PRAGMA table_info(source_domain_link)').all() as Array<{ name: string; pk: number }>)
        .filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name);
      expect(primaryKey).toEqual(['bank_id', 'endpoint', 'document_id', 'domain_id']);
    } finally { db.close(); }
  });

  it('SCH-02 rejects a confirmed link without a span or digest at the database boundary', () => {
    const path = databasePath();
    const registry = evidenceRegistry([source()]);
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source()));
    const db = new DatabaseSync(path);
    try {
      expect(() => db.prepare(`
        INSERT INTO source_domain_link(bank_id, endpoint, document_id, domain_id, link_state,
          taxonomy_version, classifier_version, confidence, rule_id, evidence_start, evidence_end,
          evidence_digest, claim_verification, created_at)
        VALUES(?, ?, ?, 'project-functional', 'confirmed', ?, ?, 0.9, NULL, NULL, NULL, NULL, 'user_verified', ?)
      `).run(saved.bankId, saved.endpoint, saved.documentId, saved.taxonomyVersion, saved.classifierVersion, at))
        .toThrow(/CHECK constraint failed/);
    } finally { db.close(); }
  });

  it('SCH-03 keeps one link per source and domain regardless of link state', () => {
    const path = databasePath();
    const registry = evidenceRegistry([source()]);
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source()));
    const db = new DatabaseSync(path);
    try {
      expect(() => db.prepare(`
        INSERT INTO source_domain_link(bank_id, endpoint, document_id, domain_id, link_state,
          taxonomy_version, classifier_version, confidence, rule_id, evidence_start, evidence_end,
          evidence_digest, claim_verification, created_at)
        VALUES(?, ?, ?, 'user-relationship', 'candidate', ?, ?, 0.4, NULL, NULL, NULL, NULL, 'external_unverified', ?)
      `).run(saved.bankId, saved.endpoint, saved.documentId, saved.taxonomyVersion, saved.classifierVersion, at))
        .toThrow(/UNIQUE constraint failed/);
    } finally { db.close(); }
  });
});

describe('source domain state and link invariants', () => {
  it('DOM-01 stores assigned with confirmed links and returns it from a clean read', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source()));
    expect(saved).toMatchObject({
      state: 'assigned', sourceEpoch: 0, sourceRevision: sourceDigest(sourceContent),
      links: [{ domainId: 'user-relationship', linkState: 'confirmed' }],
    });
    expect(store.getSourceDomainClassification('bank-a', 'https://memory.test', 'user:main:1')).toEqual(saved);
  });

  it('DOM-02 stores an explicit unclassified conclusion with no links', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source(), {
      state: 'unclassified', links: [],
    }));
    expect(saved.state).toBe('unclassified');
    expect(saved.links).toEqual([]);
    expect(store.listGrowthSourceIdentities('bank-a', 'https://memory.test')).toEqual(['user:main:1']);
    expect(store.listGrowthSourceIdentities('other-bank', 'https://memory.test')).toEqual([]);
    expect(store.domainIndexStats('bank-a', 'https://memory.test')).toMatchObject({
      records: 1, unclassified: 1, assigned: 0,
    });
  });

  it('DOM-03 stores ambiguous with a candidate link but never returns it as a confirmed domain read', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source(), {
      state: 'ambiguous', links: [candidateLink('project-functional')],
    }));
    expect(saved.state).toBe('ambiguous');
    expect(store.getSourceDomainClassification('bank-a', 'https://memory.test', 'user:main:1')?.links[0]?.linkState).toBe('candidate');
    expect(store.listDomainSources('bank-a', 'https://memory.test', ['project-functional']).items).toEqual([]);
  });

  it('DOM-04 stores pending_review with candidates and allows an empty candidate set', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    expect(store.putSourceDomainClassification(classificationFor(source(), {
      state: 'pending_review', links: [candidateLink('social-context')],
    })).state).toBe('pending_review');
    expect(store.putSourceDomainClassification(classificationFor(source(), {
      state: 'pending_review', links: [],
    })).links).toEqual([]);
  });

  it('DOM-05 rejects assigned without a confirmed link', () => {
    expect(() => assertSourceDomainClassification(classificationFor(source(), { links: [] })))
      .toThrow('assigned requires at least one confirmed link');
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      links: [candidateLink('user-relationship')],
    }))).toThrow('assigned requires at least one confirmed link');
  });

  it('DOM-06 rejects ambiguous without a candidate link', () => {
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      state: 'ambiguous', links: [confirmedLink('user-relationship')],
    }))).toThrow('ambiguous requires at least one candidate link');
  });

  it('DOM-07 rejects unknown domains, states, link states and claim bases', () => {
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      links: [{ ...confirmedLink('user-relationship'), domainId: 'unknown-domain' as DomainId }],
    }))).toThrow('unknown memory domain');
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      state: 'pending_classification' as SourceDomainClassificationInput['state'],
    }))).toThrow('source domain state is invalid');
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      links: [{ ...confirmedLink('user-relationship'), linkState: 'maybe' as SourceDomainLinkInput['linkState'] }],
    }))).toThrow('source domain link state is invalid');
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      links: [{ ...confirmedLink('user-relationship'), claimVerification: 'fact' as SourceDomainLinkInput['claimVerification'] }],
    }))).toThrow('claimVerification is invalid');
  });

  it('DOM-08 accepts all five domains and rejects a duplicate domain', () => {
    expect(normalizeDomains(DOMAIN_IDS)).toEqual([...DOMAIN_IDS]);
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      links: DOMAIN_IDS.map((domain) => confirmedLink(domain)),
    }))).not.toThrow();
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      links: [confirmedLink('user-relationship'), confirmedLink('user-relationship')],
    }))).toThrow('duplicate memory domain link');
  });

  it('DOM-09 separates explicit unclassified rows from not-indexed verified sources', () => {
    const registry = evidenceRegistry([
      source({ documentId: 'user:main:indexed' }),
      source({ documentId: 'user:main:unclassified' }),
      source({ documentId: 'user:main:untouched' }),
    ]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    seedVerifiedOutbox(store, 'user:main:indexed');
    seedVerifiedOutbox(store, 'user:main:unclassified');
    seedVerifiedOutbox(store, 'user:main:untouched');
    store.putSourceDomainClassification(classificationFor(source({ documentId: 'user:main:indexed' })));
    store.putSourceDomainClassification(classificationFor(source({ documentId: 'user:main:unclassified' }), {
      state: 'unclassified', links: [],
    }));
    expect(store.domainIndexStats('bank-a', 'https://memory.test')).toEqual({
      records: 2, assigned: 1, ambiguous: 0, pendingReview: 0, unclassified: 1,
      verifiedSources: 3, notIndexed: 1, unattributedSources: 0, blocked: false,
    });
  });

  it('DOM-10 counts exact-readback classifications without inventing missing legacy actors', () => {
    const indexedId = 'user:legacy:indexed';
    const unknownIndexedId = 'user:legacy:unknown-indexed';
    const unknownUnindexedId = 'user:legacy:unknown-unindexed';
    const registry = evidenceRegistry([
      source({ documentId: indexedId }),
      source({ documentId: unknownIndexedId }),
    ]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    seedVerifiedOutbox(store, indexedId);
    seedVerifiedOutbox(store, unknownIndexedId, { actor: null });
    seedVerifiedOutbox(store, unknownUnindexedId, { actor: null });
    store.putSourceDomainClassification(classificationFor(source({ documentId: indexedId })));
    store.putSourceDomainClassification(classificationFor(source({ documentId: unknownIndexedId })));

    expect(store.domainIndexStats('bank-a', 'https://memory.test')).toEqual({
      records: 2, assigned: 2, ambiguous: 0, pendingReview: 0, unclassified: 0,
      verifiedSources: 2, notIndexed: 0, unattributedSources: 1, blocked: false,
    });
  });

  it('LNK-01 isolates identical document IDs by bank and endpoint', () => {
    const entries = [
      source({ bankId: 'bank-a', endpoint: 'https://a.test' }),
      source({ bankId: 'bank-b', endpoint: 'https://a.test' }),
      source({ bankId: 'bank-a', endpoint: 'https://b.test' }),
    ];
    const registry = evidenceRegistry(entries);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    for (const entry of entries) store.putSourceDomainClassification(classificationFor(entry));
    expect(store.getSourceDomainClassification('bank-a', 'https://a.test', 'user:main:1')?.bankId).toBe('bank-a');
    expect(store.getSourceDomainClassification('bank-b', 'https://a.test', 'user:main:1')?.bankId).toBe('bank-b');
    expect(store.getSourceDomainClassification('bank-a', 'https://b.test', 'user:main:1')?.endpoint).toBe('https://b.test');
    expect(store.listDomainSources('bank-a', 'https://a.test', ['user-relationship']).items).toHaveLength(1);
  });

  it('LNK-02 allows different domains to carry different link states on one source', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source(), {
      state: 'ambiguous',
      links: [confirmedLink('user-relationship'), candidateLink('project-functional')],
    }));
    expect(saved.links.map((link) => [link.domainId, link.linkState])).toEqual([
      ['user-relationship', 'confirmed'],
      ['project-functional', 'candidate'],
    ]);
    expect(store.listDomainSources('bank-a', 'https://memory.test', ['user-relationship']).items).toEqual([]);
  });

  it('LNK-03 filters listDomainSources by requested domain and paginates deterministically', () => {
    const entries = [
      source({ documentId: 'user:main:a' }),
      source({ documentId: 'user:main:b' }),
      source({ documentId: 'user:main:c' }),
    ];
    const registry = evidenceRegistry(entries);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(entries[0]!));
    store.putSourceDomainClassification(classificationFor(entries[1]!, {
      links: [confirmedLink('project-functional', entries[1]!.content)],
    }));
    store.putSourceDomainClassification(classificationFor(entries[2]!));

    const first = store.listDomainSources('bank-a', 'https://memory.test', ['user-relationship'], { limit: 1 });
    expect(first.items.map((item) => item.documentId)).toEqual(['user:main:a']);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBe('user:main:a');
    const second = store.listDomainSources('bank-a', 'https://memory.test', ['user-relationship'], {
      limit: 1, cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.documentId)).toEqual(['user:main:c']);
    expect(second.complete).toBe(true);
    expect(second.nextCursor).toBeNull();
    expect(store.listDomainSources('bank-a', 'https://memory.test', ['project-functional']).items.map((item) => item.documentId))
      .toEqual(['user:main:b']);
  });
});

describe('verified source evidence', () => {
  it('EVD-01 requires a configured readback provider and accepts verified user event spans', () => {
    const path = databasePath();
    const noProvider = openStore(path);
    expect(() => noProvider.putSourceDomainClassification(classificationFor(source())))
      .toThrow('source domain evidence provider is not configured');
    noProvider.close();

    const registry = evidenceRegistry([source()]);
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source()));
    expect(saved.sourceRevision).toBe(sourceDigest(sourceContent));
    expect(saved.links[0]).toMatchObject({
      evidenceStart: 0, evidenceEnd: 24, evidenceDigest: spanDigest(sourceContent, 0, 24),
      claimVerification: 'user_verified',
    });
  });

  it('EVD-02 rejects a span digest that does not match the readback body', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    expect(() => store.putSourceDomainClassification(classificationFor(source(), {
      links: [confirmedLink('user-relationship', sourceContent, { evidenceDigest: 'a'.repeat(64) })],
    }))).toThrow('evidence digest does not match the verified source span');
  });

  it('EVD-03 rejects a source revision supplied by the caller that differs from the readback body', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    expect(() => store.putSourceDomainClassification(classificationFor(source(), {
      sourceRevision: sourceDigest('A different body supplied by the caller.'),
    }))).toThrow('source revision does not match the verified source');
  });

  it('EVD-04 rejects a stale epoch asserted by the caller or returned by the provider', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    expect(() => store.putSourceDomainClassification(classificationFor(source(), { sourceEpoch: 9 })))
      .toThrow('source epoch is stale');
    const staleProvider = evidenceRegistry([source({ sourceEpoch: 9 })]);
    const second = openStore(databasePath(), { sourceDomainEvidence: staleProvider.provider });
    expect(() => second.putSourceDomainClassification(classificationFor(source({ sourceEpoch: 9 }))))
      .toThrow('source epoch is stale');
  });

  it('EVD-05 rejects a fenced source and does not let an index row resurrect it', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    const ledger = new ForgetLedger(store, { now: () => new Date(at) });
    expect(ledger.add({
      bankId: 'bank-a', endpoint: 'https://memory.test', documentId: 'user:main:1', reason: 'synthetic forget',
    })).not.toBeNull();
    expect(() => store.putSourceDomainClassification(classificationFor(source())))
      .toThrow('source is fenced and cannot be classified');
    expect(store.getSourceDomainClassification('bank-a', 'https://memory.test', 'user:main:1')).toBeNull();
  });

  it('EVD-06 rejects a superseded source', () => {
    const registry = evidenceRegistry([source({ documentId: 'doc-old' })]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    store.saveOutbox({
      id: 'correction-event', bankId: 'bank-a', endpoint: 'https://memory.test', documentId: 'doc-new',
      operationId: 'correction-operation', state: 'verified', attempts: 1, nextAttemptAt: at, updatedAt: at,
      createdAt: at, content: 'Synthetic correction.', context: 'test', tags: [], timestamp: at,
      metadata: {
        source_actor: 'user', kind: 'correction', status: 'current',
        supersedes_source_ids: JSON.stringify(['doc-old']),
      },
    });
    expect(() => store.putSourceDomainClassification(classificationFor(source({ documentId: 'doc-old' }))))
      .toThrow('source is superseded and cannot be classified');
  });

  it('EVD-07 rejects Coo sources, non-user actors and unavailable readbacks', () => {
    const coo = evidenceRegistry([source({ sourceActor: 'coo' })]);
    expect(() => openStore(databasePath(), { sourceDomainEvidence: coo.provider })
      .putSourceDomainClassification(classificationFor(source())))
      .toThrow('only verified user events and corrections can be classified');

    const observation = evidenceRegistry([source({ sourceKind: 'observation' })]);
    expect(() => openStore(databasePath(), { sourceDomainEvidence: observation.provider })
      .putSourceDomainClassification(classificationFor(source())))
      .toThrow('only verified user events and corrections can be classified');

    const missing = evidenceRegistry([]);
    expect(() => openStore(databasePath(), { sourceDomainEvidence: missing.provider })
      .putSourceDomainClassification(classificationFor(source())))
      .toThrow('verified source evidence is unavailable');
  });

  it('EVD-08 fails closed when the readback revision changes after indexing', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(source()));
    registry.set(source({ content: 'The person changed the source body later.' }));
    expect(store.getSourceDomainClassification('bank-a', 'https://memory.test', 'user:main:1')).toBeNull();
    expect(store.listDomainSources('bank-a', 'https://memory.test', ['user-relationship']).items).toEqual([]);
  });

  it('EVD-09 rejects provider evidence for a different identity', () => {
    const registry = evidenceRegistry([source({ documentId: 'other-doc' })]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    expect(() => store.putSourceDomainClassification(classificationFor(source())))
      .toThrow('verified source evidence is unavailable');
  });

  it('EVD-10 preserves the user-expression versus external-fact distinction', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source(), {
      links: [confirmedLink('social-context', sourceContent, { claimVerification: 'external_unverified' })],
    }));
    expect(saved.links[0]?.claimVerification).toBe('external_unverified');
    expect(store.getSourceDomainClassification('bank-a', 'https://memory.test', 'user:main:1')?.links[0]?.claimVerification)
      .toBe('external_unverified');
  });

  it('EVD-11 rejects out-of-range and zero-length spans', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    expect(() => store.putSourceDomainClassification(classificationFor(source(), {
      links: [confirmedLink('user-relationship', sourceContent, { evidenceStart: 0, evidenceEnd: sourceContent.length + 1 })],
    }))).toThrow('evidence span is outside the verified source');
    expect(() => assertSourceDomainClassification(classificationFor(source(), {
      links: [confirmedLink('user-relationship', sourceContent, { evidenceStart: 4, evidenceEnd: 4 })],
    }))).toThrow('evidenceEnd must be greater than evidenceStart');
  });
});

describe('Forget and index invalidation', () => {
  it('FRG-01 deletes one source record and its links inside the Forget transaction across restart', () => {
    const registry = evidenceRegistry([source({ documentId: 'doc-a' }), source({ documentId: 'doc-b' })]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(source({ documentId: 'doc-a' })));
    store.putSourceDomainClassification(classificationFor(source({ documentId: 'doc-b' })));
    const ledger = new ForgetLedger(store, { now: () => new Date(at) });
    expect(ledger.add({
      bankId: 'bank-a', endpoint: 'https://memory.test', documentId: 'doc-a', reason: 'synthetic forget',
    })).not.toBeNull();
    expect(ledger.forgotten('bank-a', 'https://memory.test', 'doc-a')).toBe(true);
    expect(store.getSourceDomainClassification('bank-a', 'https://memory.test', 'doc-a')).toBeNull();

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_record WHERE document_id = ?').get('doc-a')).toMatchObject({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_link WHERE document_id = ?').get('doc-a')).toMatchObject({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_record WHERE document_id = ?').get('doc-b')).toMatchObject({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_link WHERE document_id = ?').get('doc-b')).toMatchObject({ count: 1 });
    } finally { db.close(); }

    store.close();
    const reopened = openStore(path);
    const reopenedLedger = new ForgetLedger(reopened);
    expect(reopenedLedger.forgotten('bank-a', 'https://memory.test', 'doc-a')).toBe(true);
    expect(reopened.getSourceDomainClassification('bank-a', 'https://memory.test', 'doc-a')).toBeNull();
    expect(reopened.listDomainSources('bank-a', 'https://memory.test', ['user-relationship']).items).toEqual([]);
  });

  it('FRG-02 clears a wildcard namespace without touching another bank', () => {
    const entries = [
      source({ bankId: 'bank-a', endpoint: 'https://memory.test', documentId: 'same-doc' }),
      source({ bankId: 'bank-b', endpoint: 'https://memory.test', documentId: 'same-doc' }),
    ];
    const registry = evidenceRegistry(entries);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    for (const entry of entries) store.putSourceDomainClassification(classificationFor(entry));
    const ledger = new ForgetLedger(store, { now: () => new Date(at) });
    expect(ledger.clearTarget('bank-a', 'https://memory.test')).toBe(true);

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_record WHERE bank_id = ?').get('bank-a')).toMatchObject({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_record WHERE bank_id = ?').get('bank-b')).toMatchObject({ count: 1 });
    } finally { db.close(); }
    expect(store.getSourceDomainClassification('bank-b', 'https://memory.test', 'same-doc')).not.toBeNull();
  });

  it('FRG-03 rolls back fence and index deletion together when the Forget write fails', () => {
    const registry = evidenceRegistry([source()]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(source()));
    const ledger = new ForgetLedger(store, { now: () => new Date(at) });
    const db = new DatabaseSync(path);
    db.exec(`CREATE TRIGGER reject_domain_delete BEFORE DELETE ON source_domain_link
      BEGIN SELECT RAISE(ABORT, 'synthetic domain delete failure'); END;`);
    db.close();

    expect(ledger.beginIntents([{
      bankId: 'bank-a', endpoint: 'https://memory.test', documentId: 'user:main:1', reason: 'synthetic forget',
    }], 'synthetic forget').acceptance).toBe('accepted');
    expect(ledger.finalizeIntents()).toBe(false);
    expect(ledger.damaged()).toBe(true);

    const afterFailure = new DatabaseSync(path);
    try {
      expect(afterFailure.prepare('SELECT COUNT(*) AS count FROM memory_fences').get()).toMatchObject({ count: 0 });
      expect(afterFailure.prepare('SELECT COUNT(*) AS count FROM source_domain_record').get()).toMatchObject({ count: 1 });
      expect(afterFailure.prepare('SELECT COUNT(*) AS count FROM memory_deletions WHERE state = ?').get('intent')).toMatchObject({ count: 1 });
    } finally { afterFailure.close(); }

    store.close();
    const repair = new DatabaseSync(path);
    repair.exec('DROP TRIGGER reject_domain_delete');
    repair.close();

    const reopened = openStore(path);
    const reopenedLedger = new ForgetLedger(reopened);
    expect(reopenedLedger.damaged()).toBe(false);
    expect(reopenedLedger.forgotten('bank-a', 'https://memory.test', 'user:main:1')).toBe(true);
    expect(reopenedLedger.epoch('bank-a', 'https://memory.test')).toBe(1);
    const afterRecovery = new DatabaseSync(path);
    try {
      expect(afterRecovery.prepare('SELECT COUNT(*) AS count FROM source_domain_record').get()).toMatchObject({ count: 0 });
      expect(afterRecovery.prepare('SELECT COUNT(*) AS count FROM source_domain_link').get()).toMatchObject({ count: 0 });
      expect(afterRecovery.prepare('SELECT COUNT(*) AS count FROM memory_fences').get()).toMatchObject({ count: 1 });
    } finally { afterRecovery.close(); }
  });

  it('FRG-04 blocks new classification writes while Forget writes are blocked', () => {
    const registry = evidenceRegistry([source()]);
    const store = openStore(databasePath(), { sourceDomainEvidence: registry.provider });
    store.markForgetWriteBlocked();
    expect(() => store.putSourceDomainClassification(classificationFor(source())))
      .toThrow('forget writes are blocked');
  });
});

describe('storage safety and persistence', () => {
  it('SAF-01 keeps every synthetic database under the system temporary directory', () => {
    const path = databasePath();
    expect(resolve(path).startsWith(resolve(tmpdir()))).toBe(true);
    expect(path.endsWith('memory-state.sqlite')).toBe(true);
  });

  it('SAF-02 never stores the source body or a quote in the index', () => {
    const phrase = 'jasmine tea after dinner';
    const content = `The person said to Coo: I prefer ${phrase}.`;
    const registry = evidenceRegistry([source({ content })]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(source({ content })));

    const db = new DatabaseSync(path);
    try {
      for (const table of ['source_domain_record', 'source_domain_link']) {
        const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name);
        for (const column of columns) {
          const found = db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE CAST("${column}" AS TEXT) LIKE ?`)
            .get(`%${phrase}%`) as { count: number };
          expect(found.count).toBe(0);
        }
      }
    } finally { db.close(); }
  });

  it('PER-01 restores classifications and stats after reopening the store', () => {
    const registry = evidenceRegistry([source()]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(source()));
    store.close();

    const reopened = openStore(path);
    expect(reopened.getSourceDomainClassification('bank-a', 'https://memory.test', 'user:main:1')).toEqual(saved);
    expect(reopened.listDomainSources('bank-a', 'https://memory.test', ['user-relationship']).items).toHaveLength(1);
    expect(reopened.domainIndexStats('bank-a', 'https://memory.test')).toMatchObject({
      records: 1, assigned: 1, ambiguous: 0, pendingReview: 0, unclassified: 0, blocked: false,
    });
  });

  it('SAF-03 rejects invalid state combinations before any row is written', () => {
    const registry = evidenceRegistry([source()]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    expect(() => store.putSourceDomainClassification(classificationFor(source(), { links: [] })))
      .toThrow('assigned requires at least one confirmed link');
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_record').get()).toMatchObject({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_domain_link').get()).toMatchObject({ count: 0 });
    } finally { db.close(); }
  });
});

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function runCrashChild(script: string, database: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: { ...process.env, D2_CRASH_DATABASE: database },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.signal !== 'SIGKILL') {
    throw new Error(`crash child did not die by SIGKILL: status=${result.status} signal=${result.signal}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  const line = result.stdout.split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('{'));
  if (!line) throw new Error(`crash child printed no JSON: stdout=${result.stdout}\nstderr=${result.stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

const committedForgetCrash = `
import { DatabaseSync } from "node:sqlite";
import { MemoryStateStore } from ${JSON.stringify(join(projectRoot, 'core/memory/state-store.ts'))};
import { ForgetLedger } from ${JSON.stringify(join(projectRoot, 'core/memory/forget-ledger.ts'))};
const database = process.env.D2_CRASH_DATABASE;
const store = new MemoryStateStore(database);
const ledger = new ForgetLedger(store, { now: () => new Date("2026-11-09T06:00:00.000Z") });
const task = ledger.add({ bankId: "bank-a", endpoint: "https://memory.test", documentId: "user:main:1", reason: "D2 committed fence crash" });
if (!task) {
  console.error("forget was not accepted");
  process.exit(2);
}
const db = new DatabaseSync(database);
const count = (table) => db.prepare("SELECT COUNT(*) AS count FROM " + table).get().count;
const payload = {
  phase: "after-commit-before-crash",
  journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
  fences: count("memory_fences"),
  records: count("source_domain_record"),
  links: count("source_domain_link"),
  epoch: ledger.epoch("bank-a", "https://memory.test"),
  forgotten: ledger.forgotten("bank-a", "https://memory.test", "user:main:1"),
};
db.close();
console.log(JSON.stringify(payload));
process.kill(process.pid, "SIGKILL");
`;

const uncommittedForgetCrash = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.D2_CRASH_DATABASE);
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO memory_fences(bank_id, endpoint, document_id, reason, created_at) VALUES(?, ?, ?, ?, ?)")
  .run("bank-a", "https://memory.test", "user:main:1", "D2 uncommitted fence crash", "2026-11-09T06:00:00.000Z");
db.prepare("DELETE FROM source_domain_link WHERE bank_id = ? AND endpoint = ? AND document_id = ?")
  .run("bank-a", "https://memory.test", "user:main:1");
db.prepare("DELETE FROM source_domain_record WHERE bank_id = ? AND endpoint = ? AND document_id = ?")
  .run("bank-a", "https://memory.test", "user:main:1");
const count = (table) => db.prepare("SELECT COUNT(*) AS count FROM " + table).get().count;
console.log(JSON.stringify({
  phase: "inside-uncommitted-transaction",
  journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
  fences: count("memory_fences"),
  records: count("source_domain_record"),
  links: count("source_domain_link"),
}));
process.kill(process.pid, "SIGKILL");
`;

describe('D2 delta safety', () => {
  const persistenceCases = [
    { label: 'zero domains (unclassified)', domains: [] as DomainId[], state: 'unclassified' as const },
    { label: 'one assigned domain', domains: ['user-relationship'] as DomainId[], state: 'assigned' as const },
    { label: 'two confirmed assigned domains', domains: ['user-relationship', 'project-functional'] as DomainId[], state: 'assigned' as const },
    { label: 'five confirmed assigned domains', domains: [...DOMAIN_IDS] as DomainId[], state: 'assigned' as const },
  ];

  it.each(persistenceCases)('D2-ID-03/DOM-03/DOM-04 persists $label and restores it after reopen', ({ domains, state }) => {
    const documentId = `user:d2:${domains.length}:${state}`;
    const entry = source({ documentId });
    const registry = evidenceRegistry([entry]);
    const path = databasePath();
    const links = domains.map((domainId) => confirmedLink(domainId, entry.content));
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(entry, { state, links }));

    expect(saved.documentId).toBe(documentId);
    expect(saved.links.map((link) => link.domainId)).toEqual(domains);
    if (domains.length > 0) expect(saved.links.every((link) => link.linkState === 'confirmed')).toBe(true);
    store.close();

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM source_domain_record WHERE document_id = ?').get(documentId))
        .toMatchObject({ count: 1 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM source_domain_link WHERE document_id = ?').get(documentId))
        .toMatchObject({ count: domains.length });
    } finally { raw.close(); }

    const reopened = openStore(path, { sourceDomainEvidence: registry.provider });
    expect(reopened.getSourceDomainClassification(entry.bankId, entry.endpoint, documentId)).toEqual(saved);
    for (const domainId of domains) {
      expect(reopened.listDomainSources(entry.bankId, entry.endpoint, [domainId]).items.map((item) => item.documentId))
        .toEqual([documentId]);
    }
    if (domains.length === 0) {
      expect(reopened.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toEqual([]);
    }
    expect(reopened.domainIndexStats(entry.bankId, entry.endpoint)).toMatchObject({ records: 1, [state]: 1 });
  });

  it('D2-DOM-05 persists two distinct candidates as ambiguous and never lists them as confirmed', () => {
    const entry = source({ documentId: 'user:d2:ambiguous' });
    const registry = evidenceRegistry([entry]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(entry, {
      state: 'ambiguous',
      links: [candidateLink('user-relationship', entry.content), candidateLink('project-functional', entry.content)],
    }));
    expect(saved.state).toBe('ambiguous');
    expect(saved.links.map((link) => [link.domainId, link.linkState])).toEqual([
      ['user-relationship', 'candidate'],
      ['project-functional', 'candidate'],
    ]);
    store.close();

    const reopened = openStore(path, { sourceDomainEvidence: registry.provider });
    expect(reopened.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).toEqual(saved);
    expect(reopened.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toEqual([]);
    expect(reopened.listDomainSources(entry.bankId, entry.endpoint, ['project-functional']).items).toEqual([]);
    expect(reopened.domainIndexStats(entry.bankId, entry.endpoint)).toMatchObject({
      records: 1, assigned: 0, ambiguous: 1,
    });
  });

  it('D2-DOM-08 rejects assigned with only candidate before write and keeps it out of confirmed reads', () => {
    const entry = source({ documentId: 'user:d2:candidate-only' });
    const registry = evidenceRegistry([entry]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    expect(() => store.putSourceDomainClassification(classificationFor(entry, {
      links: [candidateLink('user-relationship', entry.content)],
    }))).toThrow('assigned requires at least one confirmed link');

    const empty = new DatabaseSync(path);
    try {
      expect(empty.prepare('SELECT COUNT(*) AS count FROM source_domain_record WHERE document_id = ?').get(entry.documentId))
        .toMatchObject({ count: 0 });
      expect(empty.prepare('SELECT COUNT(*) AS count FROM source_domain_link WHERE document_id = ?').get(entry.documentId))
        .toMatchObject({ count: 0 });
    } finally { empty.close(); }

    store.putSourceDomainClassification(classificationFor(entry, {
      state: 'ambiguous',
      links: [candidateLink('user-relationship', entry.content)],
    }));
    const tamper = new DatabaseSync(path);
    tamper.prepare('UPDATE source_domain_record SET state = ? WHERE bank_id = ? AND endpoint = ? AND document_id = ?')
      .run('assigned', entry.bankId, entry.endpoint, entry.documentId);
    tamper.close();

    expect(store.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toEqual([]);
    expect(store.domainIndexStats(entry.bankId, entry.endpoint)).toMatchObject({ assigned: 1 });
  });

  it('D2-REV-01 masks an indexed source after a later supersession, including after reopen', () => {
    const oldEntry = source({ documentId: 'doc-old' });
    const registry = evidenceRegistry([oldEntry]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const saved = store.putSourceDomainClassification(classificationFor(oldEntry));
    expect(store.getSourceDomainClassification(oldEntry.bankId, oldEntry.endpoint, oldEntry.documentId)).toEqual(saved);

    store.saveOutbox({
      id: 'd2-correction-event', bankId: 'bank-a', endpoint: 'https://memory.test', documentId: 'doc-new',
      operationId: 'd2-correction-operation', state: 'verified', attempts: 1, nextAttemptAt: at, updatedAt: at,
      createdAt: at, content: 'Synthetic correction.', context: 'test', tags: [], timestamp: at,
      metadata: {
        source_actor: 'user', kind: 'correction', status: 'current',
        supersedes_source_ids: JSON.stringify(['doc-old']),
      },
    });
    expect(store.supersededSources(oldEntry.bankId, oldEntry.endpoint).has(oldEntry.documentId)).toBe(true);
    expect(store.getSourceDomainClassification(oldEntry.bankId, oldEntry.endpoint, oldEntry.documentId)).toBeNull();
    expect(store.listDomainSources(oldEntry.bankId, oldEntry.endpoint, ['user-relationship']).items).toEqual([]);

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM source_domain_record WHERE document_id = ?').get('doc-old'))
        .toMatchObject({ count: 1 });
    } finally { raw.close(); }

    store.close();
    const reopened = openStore(path, { sourceDomainEvidence: registry.provider });
    expect(reopened.getSourceDomainClassification(oldEntry.bankId, oldEntry.endpoint, oldEntry.documentId)).toBeNull();
    expect(reopened.listDomainSources(oldEntry.bankId, oldEntry.endpoint, ['user-relationship']).items).toEqual([]);
  });

  it('D2-EPOCH-01 fails closed when Forget commits during read verification', () => {
    function raceFixture(documentId: string) {
      const entry = source({ documentId });
      const registry = evidenceRegistry([entry]);
      const path = databasePath();
      let store!: MemoryStateStore;
      let ledger!: ForgetLedger;
      let armed = false;
      let fired = false;
      let forgetAccepted: boolean | null = null;
      const provider: SourceDomainEvidenceProvider = (bankId, endpoint, id) => {
        if (armed && !fired) {
          fired = true;
          try {
            forgetAccepted = ledger.add({
              bankId, endpoint, documentId: id, reason: 'D2 read-time forget race',
            }) !== null;
          } catch {
            forgetAccepted = false;
          }
        }
        return registry.provider(bankId, endpoint, id);
      };
      store = openStore(path, { sourceDomainEvidence: provider });
      ledger = new ForgetLedger(store, { now: () => new Date(at) });
      store.putSourceDomainClassification(classificationFor(entry));
      return {
        entry,
        store,
        arm() { armed = true; },
        get forgetAccepted() { return forgetAccepted; },
      };
    }

    const getRace = raceFixture('user:d2:race-get');
    getRace.arm();
    const duringGet = getRace.store.getSourceDomainClassification(
      getRace.entry.bankId, getRace.entry.endpoint, getRace.entry.documentId,
    );
    expect(getRace.forgetAccepted).toBe(true);
    expect(getRace.store.getSourceDomainClassification(
      getRace.entry.bankId, getRace.entry.endpoint, getRace.entry.documentId,
    )).toBeNull();
    expect.soft(duringGet).toBeNull();

    const listRace = raceFixture('user:d2:race-list');
    listRace.arm();
    const duringList = listRace.store.listDomainSources(
      listRace.entry.bankId, listRace.entry.endpoint, ['user-relationship'],
    ).items;
    expect(listRace.forgetAccepted).toBe(true);
    expect(listRace.store.getSourceDomainClassification(
      listRace.entry.bankId, listRace.entry.endpoint, listRace.entry.documentId,
    )).toBeNull();
    expect.soft(duringList).toEqual([]);
  });

  it('D2-FORGET-04a keeps a committed Forget fence after a hard process kill', () => {
    const entry = source();
    const registry = evidenceRegistry([entry]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(entry));
    store.close();

    const child = runCrashChild(committedForgetCrash, path);
    expect(child).toMatchObject({
      phase: 'after-commit-before-crash', fences: 1, records: 0, links: 0, epoch: 1, forgotten: true,
    });

    const reopened = openStore(path);
    const ledger = new ForgetLedger(reopened);
    expect(ledger.forgotten(entry.bankId, entry.endpoint, entry.documentId)).toBe(true);
    expect(ledger.epoch(entry.bankId, entry.endpoint)).toBe(1);
    expect(reopened.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).toBeNull();
    expect(reopened.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toEqual([]);

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM memory_fences').get()).toMatchObject({ count: 1 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM source_domain_record').get()).toMatchObject({ count: 0 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM source_domain_link').get()).toMatchObject({ count: 0 });
    } finally { raw.close(); }
    expectIntegrity(path);
  });

  it('D2-FORGET-04b rolls back an uncommitted Forget-shaped transaction after a hard process kill', () => {
    const entry = source();
    const registry = evidenceRegistry([entry]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    store.putSourceDomainClassification(classificationFor(entry));
    store.close();

    const child = runCrashChild(uncommittedForgetCrash, path);
    expect(child).toMatchObject({ phase: 'inside-uncommitted-transaction', fences: 1, records: 0, links: 0 });

    const reopened = openStore(path, { sourceDomainEvidence: registry.provider });
    const ledger = new ForgetLedger(reopened);
    expect(ledger.forgotten(entry.bankId, entry.endpoint, entry.documentId)).toBe(false);
    expect(ledger.epoch(entry.bankId, entry.endpoint)).toBe(0);
    expect(reopened.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).not.toBeNull();
    expect(reopened.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toHaveLength(1);

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM memory_fences').get()).toMatchObject({ count: 0 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM source_domain_record').get()).toMatchObject({ count: 1 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM source_domain_link').get()).toMatchObject({ count: 1 });
    } finally { raw.close(); }
    expectIntegrity(path);
  });

  it('D2-F1-READ-01 masks a row removed during readback without a fence or epoch change', () => {
    const entry = source({ documentId: 'user:d2:f1-row-deleted' });
    const other = source({ bankId: 'bank-b', documentId: 'user:d2:f1-other-bank' });
    const registry = evidenceRegistry([entry, other]);
    const path = databasePath();
    let armed = false;
    let deleted = false;
    const provider: SourceDomainEvidenceProvider = (bankId, endpoint, id) => {
      if (armed && !deleted) {
        deleted = true;
        const raw = new DatabaseSync(path);
        try {
          raw.exec('PRAGMA busy_timeout = 5000');
          raw.prepare('DELETE FROM source_domain_record WHERE bank_id = ? AND endpoint = ? AND document_id = ?')
            .run(bankId, endpoint, id);
        } finally { raw.close(); }
      }
      return registry.provider(bankId, endpoint, id);
    };
    const store = openStore(path, { sourceDomainEvidence: provider });
    store.putSourceDomainClassification(classificationFor(entry));
    store.putSourceDomainClassification(classificationFor(other));
    armed = true;

    expect(store.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).toBeNull();
    expect(store.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toEqual([]);
    expect(store.getSourceDomainClassification(other.bankId, other.endpoint, other.documentId)).not.toBeNull();
    expect(store.listDomainSources(other.bankId, other.endpoint, ['user-relationship']).items).toHaveLength(1);
  });

  it('D2-F1-READ-02 fails closed when the provider throws and recovers on the next read', () => {
    const entry = source({ documentId: 'user:d2:f1-provider-throw' });
    const registry = evidenceRegistry([entry]);
    let fail = false;
    const provider: SourceDomainEvidenceProvider = (bankId, endpoint, id) => {
      if (fail) throw new Error('synthetic readback failure');
      return registry.provider(bankId, endpoint, id);
    };
    const store = openStore(databasePath(), { sourceDomainEvidence: provider });
    store.putSourceDomainClassification(classificationFor(entry));

    fail = true;
    expect(store.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).toBeNull();
    expect(store.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toEqual([]);

    fail = false;
    expect(store.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).not.toBeNull();
    expect(store.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']).items).toHaveLength(1);
  });

  it('D2-F1-READ-03 fails closed when Forget writes are blocked during readback', () => {
    const entry = source({ documentId: 'user:d2:f1-write-blocked' });
    const registry = evidenceRegistry([entry]);
    let store!: MemoryStateStore;
    let armed = false;
    const provider: SourceDomainEvidenceProvider = (bankId, endpoint, id) => {
      if (armed) {
        armed = false;
        store.markForgetWriteBlocked();
      }
      return registry.provider(bankId, endpoint, id);
    };
    store = openStore(databasePath(), { sourceDomainEvidence: provider });
    store.putSourceDomainClassification(classificationFor(entry));

    armed = true;
    expect(store.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).toBeNull();
    expect(store.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']))
      .toMatchObject({ items: [], blocked: true });
  });

  it('D2-F1-READ-04 fails closed when the Forget ledger becomes damaged during readback', () => {
    const entry = source({ documentId: 'user:d2:f1-damaged' });
    const registry = evidenceRegistry([entry]);
    let store!: MemoryStateStore;
    let armed = false;
    const provider: SourceDomainEvidenceProvider = (bankId, endpoint, id) => {
      if (armed) {
        armed = false;
        store.importForget({ v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] }, true);
      }
      return registry.provider(bankId, endpoint, id);
    };
    store = openStore(databasePath(), { sourceDomainEvidence: provider });
    store.putSourceDomainClassification(classificationFor(entry));

    armed = true;
    expect(store.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).toBeNull();
    expect(store.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']))
      .toMatchObject({ items: [], blocked: true });
  });

  it('D2-F1-READ-05 masks a source superseded during readback', () => {
    const entry = source({ documentId: 'user:d2:f1-old' });
    const registry = evidenceRegistry([entry]);
    let store!: MemoryStateStore;
    let armed = false;
    const provider: SourceDomainEvidenceProvider = (bankId, endpoint, id) => {
      if (armed) {
        armed = false;
        store.saveOutbox({
          id: 'd2-f1-supersede-event', bankId: entry.bankId, endpoint: entry.endpoint,
          documentId: 'user:d2:f1-new', operationId: 'd2-f1-supersede-operation', state: 'verified',
          attempts: 1, nextAttemptAt: at, updatedAt: at, createdAt: at,
          content: 'Synthetic replacement.', context: 'test', tags: [], timestamp: at,
          metadata: {
            source_actor: 'user', kind: 'correction', status: 'current',
            supersedes_source_ids: JSON.stringify([entry.documentId]),
          },
        });
      }
      return registry.provider(bankId, endpoint, id);
    };
    store = openStore(databasePath(), { sourceDomainEvidence: provider });
    store.putSourceDomainClassification(classificationFor(entry));

    armed = true;
    expect(store.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).toBeNull();
    expect(store.listDomainSources(entry.bankId, entry.endpoint, ['user-relationship']))
      .toMatchObject({ items: [], filtered: 1 });
  });

  it('D2-UTF-01 keeps UTF-16 span offsets and digests for Chinese and emoji content', () => {
    const content = '用户说：我喜欢🌸茉莉花茶，晚饭后喝。';
    const start = content.indexOf('喜欢🌸');
    const end = content.indexOf('茶', start) + 1;
    const entry = source({ documentId: 'user:d2:utf16', content });
    const registry = evidenceRegistry([entry]);
    const path = databasePath();
    const store = openStore(path, { sourceDomainEvidence: registry.provider });
    const link = confirmedLink('user-relationship', content, {
      evidenceStart: start,
      evidenceEnd: end,
      evidenceDigest: spanDigest(content, start, end),
    });
    const saved = store.putSourceDomainClassification(classificationFor(entry, { links: [link] }));
    expect(saved.sourceRevision).toBe(sourceDigest(content));
    expect(saved.links[0]).toMatchObject({
      evidenceStart: start, evidenceEnd: end, evidenceDigest: spanDigest(content, start, end),
    });
    store.close();

    const reopened = openStore(path, { sourceDomainEvidence: registry.provider });
    expect(reopened.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)?.links[0])
      .toMatchObject({ evidenceStart: start, evidenceEnd: end, evidenceDigest: spanDigest(content, start, end) });

    expect(() => reopened.putSourceDomainClassification(classificationFor(entry, {
      links: [confirmedLink('user-relationship', content, {
        evidenceStart: start,
        evidenceEnd: end,
        evidenceDigest: spanDigest(content, start + 1, end),
      })],
    }))).toThrow('evidence digest does not match the verified source span');
  });
});

describe('D3-S1 raw list race reproducer', () => {
  it('RAW_LIST_STALE_REPRODUCED keeps A in listDomainSources when B readback forgets A', () => {
    const a = source({ documentId: 'user:d3:raw-list-a' });
    const b = source({ documentId: 'user:d3:raw-list-b' });
    const registry = evidenceRegistry([a, b]);
    const path = databasePath();
    let ledger!: ForgetLedger;
    let armed = false;
    let fired = false;
    const provider: SourceDomainEvidenceProvider = (bankId, endpoint, documentId) => {
      if (armed && !fired && documentId === b.documentId) {
        fired = true;
        ledger.add({
          bankId, endpoint, documentId: a.documentId, reason: 'D3-S1 raw list race reproducer',
        });
      }
      return registry.provider(bankId, endpoint, documentId);
    };
    const store = openStore(path, { sourceDomainEvidence: provider });
    ledger = new ForgetLedger(store, { now: () => new Date(at) });
    store.putSourceDomainClassification(classificationFor(a));
    store.putSourceDomainClassification(classificationFor(b));

    armed = true;
    const page = store.listDomainSources(a.bankId, a.endpoint, ['user-relationship']);
    // This is the D2-F1 static finding now reproduced: A was already appended
    // before B's provider call forgot it, and the raw list has no final barrier.
    // B is filtered because the Forget also bumps the namespace epoch, but A
    // remains in the returned array even though it is now fenced.
    expect(page.items.map((item) => item.documentId)).toEqual([a.documentId]);
    expect(store.getSourceDomainClassification(a.bankId, a.endpoint, a.documentId)).toBeNull();
    expect(store.getSourceDomainClassification(b.bankId, b.endpoint, b.documentId)).toBeNull();
  });
});
