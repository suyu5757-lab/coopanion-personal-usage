import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { DocumentResponse, HindsightClient } from '@vectorize-io/hindsight-client';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryStateStore } from '../core/memory/state-store.ts';
import {
  MEMORY_DOMAIN_TAXONOMY,
  type DomainId,
  type SourceDomainClassificationInput,
  type SourceDomainEvidence,
  type SourceDomainEvidenceProvider,
  type SourceDomainLinkInput,
} from '../core/memory/source-domains.ts';
import {
  readVerifiedDomainSources,
  readVerifiedSourceDomain,
  type TrustedSourceReadbackProvider,
} from '../core/memory/source-domain-consumer.ts';
import {
  createSourceDomainReadbackAdapter,
  type HindsightDocumentReader,
} from '../core/memory/source-domain-readback-adapter.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
const stores: MemoryStateStore[] = [];
const at = '2026-11-09T06:00:00.000Z';
const at2 = '2026-11-09T06:05:00.000Z';
const baseContent = 'The person said to Coo: I prefer jasmine tea after dinner.';
const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const spanDigest = (content: string, start: number, end: number) =>
  createHash('sha256').update(content.slice(start, end), 'utf8').digest('hex');

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'coo-source-domain-readback-'));
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

function track(store: MemoryStateStore): MemoryStateStore {
  stores.push(store);
  return store;
}

function openReader(path: string): MemoryStateStore {
  return track(new MemoryStateStore(path));
}

function openWriter(path: string, provider: SourceDomainEvidenceProvider): MemoryStateStore {
  return track(new MemoryStateStore(path, { sourceDomainEvidence: provider }));
}

function identity(entry: { bankId: string; endpoint: string; documentId: string }) {
  return { bankId: entry.bankId, endpoint: entry.endpoint, documentId: entry.documentId };
}

function source(overrides: Partial<SourceDomainEvidence> = {}): SourceDomainEvidence {
  return {
    bankId: 'bank-a',
    endpoint: 'https://memory.test',
    documentId: 'user:d3s2:a',
    content: baseContent,
    sourceEpoch: 0,
    sourceActor: 'user',
    sourceKind: 'event',
    sourceStatus: 'completed',
    ...overrides,
  };
}

function evidenceProvider(initial: SourceDomainEvidence[] = []): SourceDomainEvidenceProvider {
  const entries = new Map(initial.map((entry) => [
    JSON.stringify([entry.bankId, entry.endpoint, entry.documentId]),
    entry,
  ]));
  return (bankId, endpoint, documentId) =>
    entries.get(JSON.stringify([bankId, endpoint, documentId])) ?? null;
}

function confirmedLink(
  domainId: DomainId,
  content = baseContent,
  overrides: Partial<SourceDomainLinkInput> = {},
): SourceDomainLinkInput {
  return {
    domainId,
    linkState: 'confirmed',
    confidence: 0.9,
    ruleId: 'SYNTHETIC-D3S2',
    evidenceStart: 0,
    evidenceEnd: Math.min(24, content.length),
    evidenceDigest: spanDigest(content, 0, Math.min(24, content.length)),
    claimVerification: 'user_verified',
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
    sourceRevision: digest(entry.content),
    classifiedAt: at,
    updatedAt: at,
    links: [confirmedLink('user-relationship', entry.content)],
    ...overrides,
  };
}

function seed(path: string, entries: SourceDomainEvidence[], inputs: SourceDomainClassificationInput[]): void {
  const writer = openWriter(path, evidenceProvider(entries));
  for (const input of inputs) writer.putSourceDomainClassification(input);
  writer.close();
}

function documentFor(entry: SourceDomainEvidence, overrides: Partial<DocumentResponse> = {}): DocumentResponse {
  return {
    id: entry.documentId,
    bank_id: entry.bankId,
    original_text: entry.content,
    content_hash: digest(entry.content),
    created_at: at,
    updated_at: at,
    memory_unit_count: 1,
    document_metadata: {
      source_actor: entry.sourceActor,
      kind: entry.sourceKind,
      status: entry.sourceStatus ?? 'completed',
      said_at: at,
    },
    ...overrides,
  };
}

interface ReaderCall {
  bankId: string;
  documentId: string;
  signal: AbortSignal | undefined;
}

function fakeReader(
  handler: (bankId: string, documentId: string, options?: { signal?: AbortSignal }) => Promise<DocumentResponse | null>,
) {
  const calls: ReaderCall[] = [];
  const reader: HindsightDocumentReader = {
    getDocument(bankId, documentId, options) {
      calls.push({ bankId, documentId, signal: options?.signal });
      return handler(bankId, documentId, options);
    },
  };
  return { reader, calls };
}

function documentsReader(documents: DocumentResponse[] | Map<string, DocumentResponse>) {
  const map = documents instanceof Map ? documents : new Map(documents.map((document) => [document.id, document]));
  return fakeReader(async (_bankId, documentId) => map.get(documentId) ?? null);
}

function adapterFor(
  entry: SourceDomainEvidence,
  reader: HindsightDocumentReader,
  epoch: (bankId: string, endpoint: string) => number = () => 0,
): TrustedSourceReadbackProvider {
  return createSourceDomainReadbackAdapter({
    bankId: entry.bankId,
    endpoint: entry.endpoint,
    client: reader,
    epoch,
  });
}

function context(): { signal: AbortSignal; deadlineAt: number } {
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 1_000 };
}

async function readEvidence(provider: TrustedSourceReadbackProvider, entry: SourceDomainEvidence) {
  return provider(identity(entry), context());
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('D3-S2 Hindsight async source readback adapter', () => {
  it('D3-S2-00 the real HindsightClient satisfies the reader contract', () => {
    expectTypeOf<HindsightClient>().toMatchTypeOf<HindsightDocumentReader>();
  });

  it('D3-S2-01 maps a complete user event into verified evidence', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const ledger = new ForgetLedger(reader, { now: () => new Date(at) });
    const fake = documentsReader([documentFor(entry)]);
    const provider = adapterFor(entry, fake.reader, ledger.epoch.bind(ledger));

    expect(await readEvidence(provider, entry)).toEqual({
      bankId: entry.bankId,
      endpoint: entry.endpoint,
      documentId: entry.documentId,
      content: entry.content,
      sourceEpoch: 0,
      sourceRevision: digest(entry.content),
      sourceActor: 'user',
      sourceKind: 'event',
      sourceStatus: 'completed',
    });
    expect(fake.calls).toEqual([{
      bankId: entry.bankId,
      documentId: entry.documentId,
      signal: expect.any(AbortSignal),
    }]);

    const result = await readVerifiedSourceDomain(reader, provider, identity(entry));
    expect(result).toMatchObject({
      status: 'verified',
      finalBarrier: 'passed',
      item: {
        status: 'verified',
        bankId: entry.bankId,
        endpoint: entry.endpoint,
        documentId: entry.documentId,
        confirmedDomains: ['user-relationship'],
        externalFactsVerified: false,
        classification: {
          state: 'assigned',
          sourceEpoch: 0,
          sourceRevision: digest(entry.content),
        },
      },
    });
  });

  it('D3-S2-02 carries every confirmed domain and its claim through the adapter', async () => {
    const content = '用户说：我喜欢🌸茉莉花茶，晚饭后散步，也在学习 TypeScript。';
    const teaStart = content.indexOf('喜欢🌸');
    const teaEnd = content.indexOf('茶', teaStart) + 1;
    const studyStart = content.indexOf('学习');
    const studyEnd = content.length - 1;
    const entry = source({ documentId: 'user:d3s2:multi', content });
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry, {
      links: [
        confirmedLink('self-growth', content, {
          evidenceStart: studyStart,
          evidenceEnd: studyEnd,
          evidenceDigest: spanDigest(content, studyStart, studyEnd),
        }),
        confirmedLink('user-relationship', content, {
          evidenceStart: teaStart,
          evidenceEnd: teaEnd,
          evidenceDigest: spanDigest(content, teaStart, teaEnd),
        }),
      ],
    })]);
    const reader = openReader(path);
    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, documentsReader([documentFor(entry)]).reader),
      identity(entry),
    );

    expect(result).toMatchObject({
      status: 'verified',
      item: {
        confirmedDomains: ['user-relationship', 'self-growth'],
        claims: [
          { domainId: 'user-relationship', claimVerification: 'user_verified' },
          { domainId: 'self-growth', claimVerification: 'user_verified' },
        ],
      },
    });
  });

  it('D3-S2-03 accepts the Hindsight current status as an active user source', async () => {
    const entry = source({ documentId: 'user:d3s2:current', sourceStatus: 'current' });
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, documentsReader([documentFor(entry)]).reader),
      identity(entry),
    );
    expect(result).toMatchObject({ status: 'verified', item: { documentId: entry.documentId } });
  });

  it('D3-S2-03b accepts a synthetic user correction with current status', async () => {
    const entry = source({
      documentId: 'user:d3s2:user-correction',
      sourceKind: 'correction',
      sourceStatus: 'current',
    });
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, documentsReader([documentFor(entry)]).reader),
      identity(entry),
    );
    expect(result).toMatchObject({
      status: 'verified',
      item: { documentId: entry.documentId, classification: { state: 'assigned' } },
    });
  });

  it('D3-S2-04 refuses a same-id document returned for another bank', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const fake = documentsReader([documentFor(entry, { bank_id: 'bank-b' })]);

    const result = await readVerifiedSourceDomain(reader, adapterFor(entry, fake.reader), identity(entry));
    expect(result).toMatchObject({ status: 'blocked', reason: 'evidence_missing', item: null });
    expect(fake.calls).toHaveLength(1);
  });

  it('D3-S2-05 refuses a response for a different document id', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const fake = documentsReader([documentFor(entry, { id: 'user:d3s2:other' })]);

    const result = await readVerifiedSourceDomain(reader, adapterFor(entry, fake.reader), identity(entry));
    expect(result).toMatchObject({ status: 'blocked', reason: 'evidence_missing', item: null });
  });

  it('D3-S2-06 refuses another bank or endpoint before calling the client', async () => {
    const entry = source();
    const fake = documentsReader([documentFor(entry)]);
    const provider = adapterFor(entry, fake.reader);

    expect(await provider({ ...identity(entry), bankId: 'bank-b' }, context())).toBeNull();
    expect(await provider({ ...identity(entry), endpoint: 'https://other.test' }, context())).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('D3-S2-07 refuses a summary-only or empty document', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    for (const document of [
      documentFor(entry, { original_text: null }),
      documentFor(entry, { original_text: '' }),
      documentFor(entry, { original_text: '   \n  ' }),
    ]) {
      const result = await readVerifiedSourceDomain(
        reader,
        adapterFor(entry, documentsReader([document]).reader),
        identity(entry),
      );
      expect(result).toMatchObject({ status: 'blocked', reason: 'evidence_missing', item: null });
    }
  });

  it('D3-S2-08 does not infer a missing actor, kind or status', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    const cases: Array<[Record<string, string>, string]> = [
      [{ kind: 'event', status: 'completed' }, 'actor_invalid'],
      [{ source_actor: 'user', status: 'completed' }, 'kind_invalid'],
      [{ source_actor: 'user', kind: 'event' }, 'status_invalid'],
    ];
    for (const [metadata, reason] of cases) {
      const result = await readVerifiedSourceDomain(
        reader,
        adapterFor(entry, documentsReader([documentFor(entry, { document_metadata: metadata })]).reader),
        identity(entry),
      );
      expect(result, reason).toMatchObject({ status: 'blocked', reason, item: null });
    }
  });

  it('D3-S2-09 refuses a non-user actor, an unrelated kind and an inactive status', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    const cases: Array<[Record<string, string>, string]> = [
      [{ source_actor: 'coo', kind: 'event', status: 'completed' }, 'actor_invalid'],
      [{ source_actor: 'inference', kind: 'correction', status: 'current' }, 'actor_invalid'],
      [{ source_actor: 'user', kind: 'observation', status: 'completed' }, 'kind_invalid'],
      [{ source_actor: 'user', kind: 'event', status: 'superseded' }, 'status_invalid'],
      [{ source_actor: 'user', kind: 'event', status: 'disputed' }, 'status_invalid'],
      [{ source_actor: 'user', kind: 'event', status: 'unknown' }, 'status_invalid'],
    ];
    for (const [metadata, reason] of cases) {
      const result = await readVerifiedSourceDomain(
        reader,
        adapterFor(entry, documentsReader([documentFor(entry, { document_metadata: metadata })]).reader),
        identity(entry),
      );
      expect(result, reason).toMatchObject({ status: 'blocked', reason, item: null });
    }
  });

  it('D3-S2-10 refuses a changed body as a revision mismatch', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const changed = documentFor(entry, { original_text: `${entry.content} tampered` });

    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, documentsReader([changed]).reader),
      identity(entry),
    );
    expect(result).toMatchObject({ status: 'blocked', reason: 'revision_mismatch', item: null });
  });

  it('D3-S2-11 reports the durable epoch instead of copying the classification epoch', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, documentsReader([documentFor(entry)]).reader, () => 1),
      identity(entry),
    );
    expect(result).toMatchObject({ status: 'blocked', reason: 'epoch_mismatch', item: null });
  });

  it('D3-S2-12 refuses a non-integer or negative epoch', async () => {
    const entry = source();
    const fake = documentsReader([documentFor(entry)]);
    for (const value of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const provider = adapterFor(entry, fake.reader, () => value);
      expect(await readEvidence(provider, entry), String(value)).toBeNull();
    }
  });

  it('D3-S2-13 keeps the UTF-16 span digest check in force', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const raw = new DatabaseSync(path);
    try {
      raw.prepare(`
        UPDATE source_domain_link SET evidence_digest = ?
        WHERE bank_id = ? AND endpoint = ? AND document_id = ? AND domain_id = 'user-relationship'
      `).run('a'.repeat(64), entry.bankId, entry.endpoint, entry.documentId);
    } finally { raw.close(); }

    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, documentsReader([documentFor(entry)]).reader),
      identity(entry),
    );
    expect(result).toMatchObject({ status: 'blocked', reason: 'evidence_digest_mismatch', item: null });
  });

  it('D3-S2-14 drops an earlier verified item when a later readback forgets it', async () => {
    const a = source({ documentId: 'user:d3s2:race-a' });
    const b = source({ documentId: 'user:d3s2:race-b' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);
    const ledger = new ForgetLedger(reader, { now: () => new Date(at) });
    let forgot = false;
    const fake = fakeReader(async (_bankId, documentId) => {
      if (documentId === b.documentId && !forgot) {
        forgot = true;
        expect(ledger.add({
          bankId: a.bankId, endpoint: a.endpoint, documentId: a.documentId, reason: 'D3-S2 B readback forget',
        })).not.toBeNull();
      }
      return documentFor(documentId === a.documentId ? a : b);
    });

    const result = await readVerifiedDomainSources(
      reader,
      adapterFor(a, fake.reader, ledger.epoch.bind(ledger)),
      { bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'] },
    );

    expect(forgot).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.finalBarrier).toBe('passed');
    expect(result.items).toEqual([]);
    expect(result.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: a.documentId,
        reason: expect.stringMatching(/record_missing|classification_changed/),
      }),
    ]));
    expect(reader.getSourceDomainClassification(a.bankId, a.endpoint, a.documentId)).toBeNull();
    expect(reader.getSourceDomainClassification(b.bankId, b.endpoint, b.documentId)).toBeNull();
  });

  it('D3-S2-15 lets a local revision supersede a source whose retained status is completed', async () => {
    const a = source({ documentId: 'user:d3s2:superseded' });
    const b = source({ documentId: 'user:d3s2:correction' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);
    const raw = new DatabaseSync(path);
    try {
      raw.prepare(`
        INSERT INTO memory_revisions(event_id, bank_id, endpoint, document_id, supersedes_document_id, state, created_at)
        VALUES(?, ?, ?, ?, ?, 'active', ?)
      `).run('synthetic-d3s2-correction', a.bankId, a.endpoint, b.documentId, a.documentId, at);
    } finally { raw.close(); }
    const fake = documentsReader([documentFor(a)]);

    const result = await readVerifiedSourceDomain(reader, adapterFor(a, fake.reader), identity(a));
    expect(result).toMatchObject({ status: 'blocked', reason: 'record_missing', item: null });
    expect(fake.calls).toHaveLength(0);
  });

  it('D3-S2-16 refuses a classification row deleted during readback', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const fake = fakeReader(async () => {
      const raw = new DatabaseSync(path);
      try {
        raw.prepare(`
          DELETE FROM source_domain_record WHERE bank_id = ? AND endpoint = ? AND document_id = ?
        `).run(entry.bankId, entry.endpoint, entry.documentId);
      } finally { raw.close(); }
      return documentFor(entry);
    });

    const result = await readVerifiedSourceDomain(reader, adapterFor(entry, fake.reader), identity(entry));
    expect(result).toMatchObject({ status: 'blocked', reason: 'record_missing', item: null, finalBarrier: 'passed' });
  });

  it('D3-S2-17 refuses a same-revision link change during readback', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const mutator = openWriter(path, evidenceProvider([entry]));
    const fake = fakeReader(async () => {
      mutator.putSourceDomainClassification(classificationFor(entry, {
        updatedAt: at2,
        links: [confirmedLink('skill-methods', entry.content, { ruleId: 'CHANGED-DURING-READBACK' })],
      }));
      return documentFor(entry);
    });

    const result = await readVerifiedSourceDomain(reader, adapterFor(entry, fake.reader), identity(entry));
    expect(result).toMatchObject({ status: 'blocked', reason: 'classification_changed', item: null });
  });

  it('D3-S2-18 returns provider_timeout and ignores a late document', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    let release!: (document: DocumentResponse) => void;
    const fake = fakeReader(() => new Promise((resolve) => { release = resolve; }));

    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, fake.reader),
      identity(entry),
      { providerTimeoutMs: 5, timeBudgetMs: 1_000 },
    );
    expect(result).toMatchObject({
      status: 'unavailable', reason: 'provider_timeout', item: null, finalBarrier: 'not_run',
    });

    release(documentFor(entry));
    await Promise.resolve();
    await Promise.resolve();
    expect(reader.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).not.toBeNull();

    const fresh = documentsReader([documentFor(entry)]);
    const second = await readVerifiedSourceDomain(reader, adapterFor(entry, fresh.reader), identity(entry));
    expect(second.status).toBe('verified');
    expect(fresh.calls).toHaveLength(1);
  });

  it('D3-S2-19 returns cancelled and ignores a late document', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const controller = new AbortController();
    let release!: (document: DocumentResponse) => void;
    const fake = fakeReader(async () => {
      controller.abort();
      return new Promise((resolve) => { release = resolve; });
    });

    const result = await readVerifiedSourceDomain(
      reader,
      adapterFor(entry, fake.reader),
      identity(entry),
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      status: 'unavailable', reason: 'cancelled', item: null, finalBarrier: 'not_run',
    });

    release(documentFor(entry));
    await Promise.resolve();
    await Promise.resolve();
    expect(reader.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).not.toBeNull();
  });

  it('D3-S2-20 withholds a client error and a missing document without verifying', async () => {
    const a = source({ documentId: 'user:d3s2:error-a' });
    const b = source({ documentId: 'user:d3s2:missing-b' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);
    const fake = fakeReader(async (_bankId, documentId) => {
      if (documentId === a.documentId) throw new Error('synthetic readback failure');
      return null;
    });

    const result = await readVerifiedDomainSources(
      reader,
      adapterFor(a, fake.reader),
      { bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'] },
    );
    expect(result.status).toBe('blocked');
    expect(result.items).toEqual([]);
    expect(result.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: a.documentId, status: 'blocked', reason: 'provider_error' }),
      expect.objectContaining({ documentId: b.documentId, status: 'blocked', reason: 'evidence_missing' }),
    ]));
  });

  it('D3-S2-21 does not retry or cache a failed read', async () => {
    const entry = source();
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    let calls = 0;
    const failing = fakeReader(async () => {
      calls += 1;
      throw new Error('synthetic readback failure');
    });

    const first = await readVerifiedSourceDomain(reader, adapterFor(entry, failing.reader), identity(entry));
    expect(first).toMatchObject({ status: 'blocked', reason: 'provider_error', item: null });
    expect(calls).toBe(1);

    const good = documentsReader([documentFor(entry)]);
    const second = await readVerifiedSourceDomain(reader, adapterFor(entry, good.reader), identity(entry));
    expect(second.status).toBe('verified');
    expect(good.calls).toHaveLength(1);
  });

  it('D3-S2-22 refuses an already-cancelled signal before calling the client', async () => {
    const entry = source();
    const fake = documentsReader([documentFor(entry)]);
    const provider = adapterFor(entry, fake.reader);
    const controller = new AbortController();
    controller.abort();

    expect(await provider(identity(entry), { signal: controller.signal, deadlineAt: Date.now() + 1_000 })).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('D3-S2-23 uses the body SHA-256, not the server content_hash or updated_at, as the revision', async () => {
    const entry = source();
    const fake = documentsReader([documentFor(entry, {
      content_hash: 'f'.repeat(64),
      updated_at: '2026-11-10T00:00:00.000Z',
    })]);
    const evidence = await readEvidence(adapterFor(entry, fake.reader), entry);

    expect(evidence?.sourceRevision).toBe(digest(entry.content));
    expect(evidence?.sourceRevision).not.toBe('f'.repeat(64));
  });

  it('D3-S2-24 rejects incomplete adapter wiring', () => {
    const entry = source();
    const fake = documentsReader([documentFor(entry)]);
    expect(() => createSourceDomainReadbackAdapter({
      bankId: '', endpoint: entry.endpoint, client: fake.reader, epoch: () => 0,
    })).toThrow(/bankId/);
    expect(() => createSourceDomainReadbackAdapter({
      bankId: entry.bankId, endpoint: '', client: fake.reader, epoch: () => 0,
    })).toThrow(/endpoint/);
    expect(() => createSourceDomainReadbackAdapter({
      bankId: entry.bankId, endpoint: entry.endpoint, client: {} as HindsightDocumentReader, epoch: () => 0,
    })).toThrow(/getDocument/);
    expect(() => createSourceDomainReadbackAdapter({
      bankId: entry.bankId, endpoint: entry.endpoint, client: fake.reader,
      epoch: undefined as unknown as (bankId: string, endpoint: string) => number,
    })).toThrow(/epoch/);
  });
});
