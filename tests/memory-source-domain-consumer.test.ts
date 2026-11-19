import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryStateStore } from '../core/memory/state-store.ts';
import {
  DOMAIN_IDS,
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
  type TrustedSourceReadbackEvidence,
  type TrustedSourceReadbackProvider,
} from '../core/memory/source-domain-consumer.ts';

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
  const path = mkdtempSync(join(tmpdir(), 'coo-source-domain-consumer-'));
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

function tupleKey(bankId: string, endpoint: string, documentId: string): string {
  return JSON.stringify([bankId, endpoint, documentId]);
}

function identity(entry: { bankId: string; endpoint: string; documentId: string }) {
  return { bankId: entry.bankId, endpoint: entry.endpoint, documentId: entry.documentId };
}

function source(overrides: Partial<SourceDomainEvidence> = {}): SourceDomainEvidence {
  return {
    bankId: 'bank-a',
    endpoint: 'https://memory.test',
    documentId: 'user:d3:a',
    content: baseContent,
    sourceEpoch: 0,
    sourceActor: 'user',
    sourceKind: 'event',
    sourceStatus: 'completed',
    ...overrides,
  };
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
  };
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
  content = baseContent,
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
    sourceRevision: digest(entry.content),
    classifiedAt: at,
    updatedAt: at,
    links: [confirmedLink('user-relationship', entry.content)],
    ...overrides,
  };
}

function seed(path: string, entries: SourceDomainEvidence[], inputs: SourceDomainClassificationInput[]): void {
  const registry = evidenceRegistry(entries);
  const writer = openWriter(path, registry.provider);
  for (const input of inputs) writer.putSourceDomainClassification(input);
  writer.close();
}

function readback(entry: SourceDomainEvidence): TrustedSourceReadbackEvidence {
  return { ...entry, sourceStatus: entry.sourceStatus ?? 'completed' };
}

function providerFor(entry: SourceDomainEvidence): TrustedSourceReadbackProvider {
  return async () => readback(entry);
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('D3-S1 trusted consumer boundary', () => {
  it('D3-S1-01 refuses to turn the raw index into verified memory without a readback provider', async () => {
    const path = databasePath();
    const entry = source();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    expect(reader.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)).not.toBeNull();

    const single = await readVerifiedSourceDomain(reader, undefined, identity(entry));
    expect(single).toMatchObject({
      status: 'unavailable', reason: 'provider_missing', item: null, finalBarrier: 'not_run',
    });
    const batch = await readVerifiedDomainSources(reader, undefined, {
      ...identity(entry), domains: ['user-relationship'],
    });
    expect(batch).toMatchObject({
      status: 'unavailable', reason: 'provider_missing', items: [], finalBarrier: 'not_run',
    });
    expect(batch.items).toEqual([]);

    const absent = await readVerifiedSourceDomain(reader, providerFor(entry), {
      ...identity(entry), documentId: 'user:d3:absent',
    });
    expect(absent).toMatchObject({ status: 'blocked', reason: 'record_missing', item: null });
    expect(absent.status).not.toBe('verified');
  });

  it('D3-S1-02 only promotes assigned sources with confirmed links', async () => {
    const path = databasePath();
    const assigned = source({ documentId: 'user:d3:assigned' });
    const ambiguous = source({ documentId: 'user:d3:ambiguous' });
    const pending = source({ documentId: 'user:d3:pending' });
    const unclassified = source({ documentId: 'user:d3:unclassified' });
    const entries = [assigned, ambiguous, pending, unclassified];
    seed(path, entries, [
      classificationFor(assigned),
      classificationFor(ambiguous, { state: 'ambiguous', links: [candidateLink('social-context', ambiguous.content)] }),
      classificationFor(pending, { state: 'pending_review', links: [candidateLink('project-functional', pending.content)] }),
      classificationFor(unclassified, { state: 'unclassified', links: [] }),
    ]);
    const reader = openReader(path);
    let calls = 0;
    const provider: TrustedSourceReadbackProvider = async (target) => {
      calls += 1;
      const entry = entries.find((candidate) => candidate.documentId === target.documentId)!;
      return readback(entry);
    };

    await expect(readVerifiedSourceDomain(reader, provider, identity(assigned))).resolves.toMatchObject({
      status: 'verified', item: { status: 'verified', confirmedDomains: ['user-relationship'] },
    });
    expect(calls).toBe(1);

    for (const blocked of [ambiguous, pending, unclassified]) {
      const result = await readVerifiedSourceDomain(reader, provider, identity(blocked));
      expect(result).toMatchObject({ status: 'blocked', reason: 'not_assigned', item: null });
    }
    expect(calls).toBe(1);

    const batch = await readVerifiedDomainSources(reader, provider, {
      bankId: assigned.bankId, endpoint: assigned.endpoint, domains: ['user-relationship'],
    });
    expect(batch.items.map((item) => item.documentId)).toEqual(['user:d3:assigned']);
    expect(batch.items[0]?.classification.state).toBe('assigned');
    expect(batch.items[0]?.confirmedDomains).toEqual(['user-relationship']);
  });

  it('D3-S1-03 validates the full identity, epoch, revision, actor, kind, status and UTF-16 span digest', async () => {
    const content = '用户说：我喜欢🌸茉莉花茶，晚饭后喝。';
    const start = content.indexOf('喜欢🌸');
    const end = content.indexOf('茶', start) + 1;
    const entry = source({ documentId: 'user:d3:utf16', content });
    const link = confirmedLink('user-relationship', content, {
      evidenceStart: start,
      evidenceEnd: end,
      evidenceDigest: spanDigest(content, start, end),
    });
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry, { links: [link] })]);
    const reader = openReader(path);

    const verified = await readVerifiedSourceDomain(reader, providerFor(entry), identity(entry));
    expect(verified).toMatchObject({
      status: 'verified',
      item: {
        documentId: entry.documentId,
        confirmedDomains: ['user-relationship'],
        externalFactsVerified: false,
        classification: { sourceRevision: digest(content), sourceEpoch: 0 },
      },
    });

    const completedStatus = await readVerifiedSourceDomain(reader, async () => ({ ...entry, sourceStatus: 'current' }), identity(entry));
    expect(completedStatus.status).toBe('verified');

    const cases: Array<[string, TrustedSourceReadbackProvider, string]> = [
      ['bank identity', async () => ({ ...readback(entry), bankId: 'bank-b' }), 'identity_mismatch'],
      ['endpoint identity', async () => ({ ...readback(entry), endpoint: 'https://other.test' }), 'identity_mismatch'],
      ['document identity', async () => ({ ...readback(entry), documentId: 'user:d3:other' }), 'identity_mismatch'],
      ['epoch', async () => ({ ...readback(entry), sourceEpoch: entry.sourceEpoch + 1 }), 'epoch_mismatch'],
      ['revision', async () => ({ ...readback(entry), content: `${entry.content} tampered` }), 'revision_mismatch'],
      ['explicit revision', async () => ({ ...readback(entry), sourceRevision: 'a'.repeat(64) }), 'revision_mismatch'],
      ['actor', async () => ({ ...readback(entry), sourceActor: 'coo' }), 'actor_invalid'],
      ['kind', async () => ({ ...readback(entry), sourceKind: 'observation' }), 'kind_invalid'],
      ['status', async () => ({ ...readback(entry), sourceStatus: 'superseded' }), 'status_invalid'],
      ['status dispute', async () => ({ ...readback(entry), sourceStatus: 'disputed' }), 'status_invalid'],
      ['empty content', async () => ({ ...readback(entry), content: '' }), 'content_empty'],
      ['missing evidence', async () => null, 'evidence_missing'],
      ['malformed evidence', async () => ({ ...readback(entry), sourceActor: 42 as unknown as string }), 'evidence_invalid'],
    ];
    for (const [label, provider, reason] of cases) {
      const result = await readVerifiedSourceDomain(reader, provider, identity(entry));
      expect(result, label).toMatchObject({ status: 'blocked', reason, item: null });
    }

    expect(await readVerifiedSourceDomain(reader, async () => {
      throw new Error('synthetic provider failure');
    }, identity(entry))).toMatchObject({ status: 'blocked', reason: 'provider_error', item: null });
  });

  it('D3-S1-04 rejects an indexed link that is damaged while the source body is still current', async () => {
    const entry = source({ documentId: 'user:d3:damaged-link' });
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);

    const raw = new DatabaseSync(path);
    try {
      raw.prepare(`
        UPDATE source_domain_link SET evidence_end = evidence_end + 1000
        WHERE bank_id = ? AND endpoint = ? AND document_id = ? AND domain_id = 'user-relationship'
      `).run(entry.bankId, entry.endpoint, entry.documentId);
    } finally { raw.close(); }
    expect(await readVerifiedSourceDomain(reader, providerFor(entry), identity(entry)))
      .toMatchObject({ status: 'blocked', reason: 'span_invalid' });

    const raw2 = new DatabaseSync(path);
    try {
      raw2.prepare(`
        UPDATE source_domain_link SET evidence_end = 24, evidence_digest = ?
        WHERE bank_id = ? AND endpoint = ? AND document_id = ? AND domain_id = 'user-relationship'
      `).run('a'.repeat(64), entry.bankId, entry.endpoint, entry.documentId);
    } finally { raw2.close(); }
    expect(await readVerifiedSourceDomain(reader, providerFor(entry), identity(entry)))
      .toMatchObject({ status: 'blocked', reason: 'evidence_digest_mismatch' });
  });

  it('D3-S1-05 rejects a same-revision classification replacement during readback', async () => {
    const entry = source({ documentId: 'user:d3:reclassified' });
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const mutator = openWriter(path, evidenceRegistry([entry]).provider);

    const result = await readVerifiedSourceDomain(reader, async () => {
      mutator.putSourceDomainClassification(classificationFor(entry, {
        updatedAt: at2,
        links: [confirmedLink('project-functional', entry.content, { ruleId: 'REPLACED-01' })],
      }));
      return readback(entry);
    }, identity(entry));

    expect(result).toMatchObject({ status: 'blocked', reason: 'classification_changed', item: null });
    expect(reader.getSourceDomainClassification(entry.bankId, entry.endpoint, entry.documentId)?.links[0])
      .toMatchObject({ domainId: 'project-functional', ruleId: 'REPLACED-01' });
  });

  it('D3-S1-06 rejects an assigned-to-candidate replacement during readback', async () => {
    const entry = source({ documentId: 'user:d3:downgraded' });
    const path = databasePath();
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const mutator = openWriter(path, evidenceRegistry([entry]).provider);

    const result = await readVerifiedSourceDomain(reader, async () => {
      mutator.putSourceDomainClassification(classificationFor(entry, {
        state: 'ambiguous',
        updatedAt: at2,
        links: [candidateLink('social-context', entry.content)],
      }));
      return readback(entry);
    }, identity(entry));

    expect(result).toMatchObject({ status: 'blocked', reason: 'classification_changed', item: null });
  });

  it('D3-S1-07 batch final barrier removes A when B readback forgets A', async () => {
    const a = source({ documentId: 'user:d3:race-a' });
    const b = source({ documentId: 'user:d3:race-b' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);
    const ledger = new ForgetLedger(reader, { now: () => new Date(at) });
    expect(reader.listDomainSources(a.bankId, a.endpoint, ['user-relationship']).items).toHaveLength(2);
    let forgot = false;

    const result = await readVerifiedDomainSources(reader, async (target) => {
      if (target.documentId === b.documentId && !forgot) {
        forgot = true;
        expect(ledger.add({
          bankId: a.bankId, endpoint: a.endpoint, documentId: a.documentId, reason: 'D3-S1 B readback forget',
        })).not.toBeNull();
      }
      return readback(target.documentId === a.documentId ? a : b);
    }, { bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'] });

    expect(forgot).toBe(true);
    // A Forget bumps the namespace epoch, so B's old index row is also stale.
    // The consumer must not keep the already-verified A, nor pretend B is fresh.
    expect(result.status).toBe('blocked');
    expect(result.finalBarrier).toBe('passed');
    expect(result.items).toEqual([]);
    expect(result.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: a.documentId,
        reason: expect.stringMatching(/record_missing|classification_changed/),
      }),
    ]));
    expect(result.items.some((item) => item.documentId === a.documentId)).toBe(false);
    expect(reader.getSourceDomainClassification(a.bankId, a.endpoint, a.documentId)).toBeNull();
    expect(reader.getSourceDomainClassification(b.bankId, b.endpoint, b.documentId)).toBeNull();
  });

  it('D3-S1-07b batch final barrier removes A when its row is deleted during B readback', async () => {
    const a = source({ documentId: 'user:d3:row-delete-a' });
    const b = source({ documentId: 'user:d3:row-delete-b' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);

    const result = await readVerifiedDomainSources(reader, async (target) => {
      if (target.documentId === b.documentId) {
        const raw = new DatabaseSync(path);
        try {
          raw.exec('PRAGMA busy_timeout = 5000');
          raw.prepare('DELETE FROM source_domain_record WHERE bank_id = ? AND endpoint = ? AND document_id = ?')
            .run(a.bankId, a.endpoint, a.documentId);
        } finally { raw.close(); }
      }
      return readback(target.documentId === a.documentId ? a : b);
    }, { bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'] });

    expect(result.status).toBe('incomplete');
    expect(result.items.map((item) => item.documentId)).toEqual([b.documentId]);
    expect(result.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: a.documentId,
        reason: expect.stringMatching(/record_missing|classification_changed/),
      }),
    ]));
    expect(reader.getSourceDomainClassification(a.bankId, a.endpoint, a.documentId)).toBeNull();
  });

  it('D3-S1-08 batch final barrier removes A when its same-revision links change during B readback', async () => {
    const a = source({ documentId: 'user:d3:race-links-a' });
    const b = source({ documentId: 'user:d3:race-links-b' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);
    const mutator = openWriter(path, evidenceRegistry([a, b]).provider);

    const result = await readVerifiedDomainSources(reader, async (target) => {
      if (target.documentId === b.documentId) {
        mutator.putSourceDomainClassification(classificationFor(a, {
          updatedAt: at2,
          links: [confirmedLink('skill-methods', a.content, { ruleId: 'CHANGED-DURING-B' })],
        }));
      }
      return readback(target.documentId === a.documentId ? a : b);
    }, { bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'] });

    expect(result.status).toBe('incomplete');
    expect(result.items.map((item) => item.documentId)).toEqual([b.documentId]);
    expect(result.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: a.documentId, reason: 'classification_changed' }),
    ]));
  });

  it('D3-S1-09 provider errors and null evidence are withheld without being treated as no memory', async () => {
    const a = source({ documentId: 'user:d3:error-a' });
    const b = source({ documentId: 'user:d3:error-b' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);

    const errorResult = await readVerifiedDomainSources(reader, async (target) => {
      if (target.documentId === a.documentId) throw new Error('synthetic readback failed');
      return readback(b);
    }, { bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'] });
    expect(errorResult.status).toBe('incomplete');
    expect(errorResult.items.map((item) => item.documentId)).toEqual([b.documentId]);
    expect(errorResult.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: a.documentId, status: 'blocked', reason: 'provider_error' }),
    ]));

    const nullResult = await readVerifiedSourceDomain(reader, async () => null, identity(a));
    expect(nullResult).toMatchObject({ status: 'blocked', reason: 'evidence_missing', item: null });
  });

  it('D3-S1-10 timeouts and cancellation fail the whole batch closed', async () => {
    const a = source({ documentId: 'user:d3:timeout-a' });
    const b = source({ documentId: 'user:d3:timeout-b' });
    const path = databasePath();
    seed(path, [a, b], [classificationFor(a), classificationFor(b)]);
    const reader = openReader(path);

    const timedOut = await readVerifiedDomainSources(reader, async (target) => {
      if (target.documentId === b.documentId) return new Promise<never>(() => {});
      return readback(a);
    }, {
      bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'],
    }, { providerTimeoutMs: 10, timeBudgetMs: 1000 });
    expect(timedOut).toMatchObject({
      status: 'unavailable', reason: 'provider_timeout', items: [], finalBarrier: 'not_run',
    });

    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const cancelled = await readVerifiedDomainSources(reader, async () => {
      calls += 1;
      return readback(a);
    }, {
      bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'],
    }, { signal: controller.signal });
    expect(calls).toBe(0);
    expect(cancelled).toMatchObject({
      status: 'unavailable', reason: 'cancelled', items: [], finalBarrier: 'not_run',
    });

    const during = new AbortController();
    const duringResult = await readVerifiedDomainSources(reader, async () => {
      await new Promise((resolveAbort) => {
        during.signal.addEventListener('abort', () => resolveAbort(null), { once: true });
        setTimeout(() => during.abort(), 10);
      });
      return readback(a);
    }, {
      bankId: a.bankId, endpoint: a.endpoint, domains: ['user-relationship'],
    }, { signal: during.signal, providerTimeoutMs: 1000, timeBudgetMs: 1000 });
    expect(duringResult).toMatchObject({
      status: 'unavailable', reason: 'cancelled', items: [], finalBarrier: 'not_run',
    });
  });

  it('D3-S1-11 keeps bank, endpoint and document identity separate and preserves multi-domain and external claims', async () => {
    const sameId = 'user:d3:same-id';
    const a = source({ bankId: 'bank-a', endpoint: 'https://a.test', documentId: sameId, content: 'Bank A endpoint A content.' });
    const b = source({ bankId: 'bank-a', endpoint: 'https://b.test', documentId: sameId, content: 'Bank A endpoint B content.' });
    const c = source({ bankId: 'bank-b', endpoint: 'https://a.test', documentId: sameId, content: 'Bank B endpoint A content.' });
    const multi = source({ bankId: 'bank-multi', endpoint: 'https://multi.test', documentId: 'user:d3:multi' });
    const external = source({ bankId: 'bank-external', endpoint: 'https://external.test', documentId: 'user:d3:external' });
    const path = databasePath();
    seed(path, [a, b, c, multi, external], [
      classificationFor(a),
      classificationFor(b, { links: [confirmedLink('project-functional', b.content)] }),
      classificationFor(c, { links: [confirmedLink('skill-methods', c.content)] }),
      classificationFor(multi, { links: DOMAIN_IDS.map((domain) => confirmedLink(domain, multi.content)) }),
      classificationFor(external, {
        links: [confirmedLink('social-context', external.content, { claimVerification: 'external_unverified' })],
      }),
    ]);
    const reader = openReader(path);
    const registry = evidenceRegistry([a, b, c, multi, external]);
    const provider: TrustedSourceReadbackProvider = async (target) => readback(
      registry.provider(target.bankId, target.endpoint, target.documentId)!,
    );

    for (const [entry, domain] of [[a, 'user-relationship'], [b, 'project-functional'], [c, 'skill-methods']] as const) {
      const result = await readVerifiedDomainSources(reader, provider, {
        bankId: entry.bankId, endpoint: entry.endpoint, domains: [domain],
      });
      expect(result.status).toBe('verified');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        bankId: entry.bankId, endpoint: entry.endpoint, documentId: sameId, confirmedDomains: [domain],
      });
    }

    const multiResult = await readVerifiedDomainSources(reader, provider, {
      bankId: multi.bankId, endpoint: multi.endpoint, domains: ['user-relationship'],
    });
    expect(multiResult.items).toHaveLength(1);
    expect(multiResult.items[0]?.confirmedDomains).toEqual([...DOMAIN_IDS]);
    expect(multiResult.items[0]?.claims).toHaveLength(5);

    const externalResult = await readVerifiedDomainSources(reader, provider, {
      bankId: external.bankId, endpoint: external.endpoint, domains: ['social-context'],
    });
    expect(externalResult.items[0]).toMatchObject({
      externalFactsVerified: false,
      claims: [{ domainId: 'social-context', claimVerification: 'external_unverified' }],
    });
  });

  it('D3-S1-12 pagination, item limits and time budgets report exact coverage', async () => {
    const entries = [
      source({ documentId: 'user:d3:page-a' }),
      source({ documentId: 'user:d3:page-b' }),
      source({ documentId: 'user:d3:page-c' }),
    ];
    const path = databasePath();
    seed(path, entries, entries.map((entry) => classificationFor(entry)));
    const reader = openReader(path);
    const provider: TrustedSourceReadbackProvider = async (target) => readback(
      entries.find((entry) => entry.documentId === target.documentId)!,
    );

    const first = await readVerifiedDomainSources(reader, provider, {
      bankId: 'bank-a', endpoint: 'https://memory.test', domains: ['user-relationship'],
    }, { pageSize: 1, maxItems: 2 });
    expect(first.status).toBe('incomplete');
    expect(first.items.map((item) => item.documentId)).toEqual(['user:d3:page-a', 'user:d3:page-b']);
    expect(first.page).toMatchObject({
      scanned: 2, returned: 2, complete: false, truncated: true, stopReason: 'item_limit',
      nextCursor: 'user:d3:page-b',
    });

    const second = await readVerifiedDomainSources(reader, provider, {
      bankId: 'bank-a', endpoint: 'https://memory.test', domains: ['user-relationship'],
    }, { pageSize: 2, maxItems: 5, cursor: first.page.nextCursor });
    expect(second.status).toBe('verified');
    expect(second.items.map((item) => item.documentId)).toEqual(['user:d3:page-c']);
    expect(second.page).toMatchObject({ complete: true, truncated: false, nextCursor: null });

    let nowMs = 1_000;
    const budgetResult = await readVerifiedDomainSources(reader, async (target) => {
      nowMs += 100;
      return readback(entries.find((entry) => entry.documentId === target.documentId)!);
    }, {
      bankId: 'bank-a', endpoint: 'https://memory.test', domains: ['user-relationship'],
    }, { pageSize: 1, maxItems: 5, timeBudgetMs: 50, now: () => nowMs });
    expect(budgetResult.status).toBe('incomplete');
    expect(budgetResult.items.map((item) => item.documentId)).toEqual(['user:d3:page-a']);
    expect(budgetResult.page).toMatchObject({ stopReason: 'time_budget', complete: false, truncated: true });
  });

  it('D3-S1-13 rejects a store that still has a synchronous reentrant readback provider', async () => {
    const path = databasePath();
    const entry = source({ documentId: 'user:d3:sync-store' });
    const registry = evidenceRegistry([entry]);
    const writer = openWriter(path, registry.provider);
    writer.putSourceDomainClassification(classificationFor(entry));
    const guarded = track(new MemoryStateStore(path, { sourceDomainEvidence: registry.provider }));

    const single = await readVerifiedSourceDomain(guarded, providerFor(entry), identity(entry));
    expect(single).toMatchObject({
      status: 'blocked', reason: 'sync_store_provider_unsupported', item: null, finalBarrier: 'not_run',
    });
    const batch = await readVerifiedDomainSources(guarded, providerFor(entry), {
      ...identity(entry), domains: ['user-relationship'],
    });
    expect(batch).toMatchObject({
      status: 'blocked', reason: 'sync_store_provider_unsupported', items: [], finalBarrier: 'not_run',
    });
  });

  it('D3-S1-14 reports a blocked raw store instead of verified emptiness', async () => {
    const path = databasePath();
    const entry = source({ documentId: 'user:d3:blocked-store' });
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    reader.markForgetWriteBlocked();

    const result = await readVerifiedDomainSources(reader, providerFor(entry), {
      ...identity(entry), domains: ['user-relationship'],
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'store_blocked', items: [], finalBarrier: 'not_run' });
  });

  it('D3-S1-15 validates options instead of running an unbounded or malformed read', async () => {
    const path = databasePath();
    const entry = source({ documentId: 'user:d3:options' });
    seed(path, [entry], [classificationFor(entry)]);
    const reader = openReader(path);
    const provider = providerFor(entry);

    expect(await readVerifiedDomainSources(reader, provider, {
      ...identity(entry), domains: ['user-relationship'],
    }, { pageSize: 0 })).toMatchObject({ status: 'blocked', reason: 'invalid_options', items: [] });
    expect(await readVerifiedDomainSources(reader, provider, {
      ...identity(entry), domains: ['user-relationship'],
    }, { maxItems: 10_000 })).toMatchObject({ status: 'blocked', reason: 'invalid_options', items: [] });
    expect(await readVerifiedDomainSources(reader, provider, {
      ...identity(entry), domains: [],
    })).toMatchObject({ status: 'blocked', reason: 'invalid_query', items: [] });
  });
});
