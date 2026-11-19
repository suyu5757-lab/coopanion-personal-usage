import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, MemoryStateStore } from '../core/memory/state-store.ts';
import {
  MEMORY_DOMAIN_TAXONOMY,
  type SourceDomainClassification,
  type SourceDomainClassificationInput,
  type SourceDomainEvidence,
  type SourceDomainEvidenceProvider,
} from '../core/memory/source-domains.ts';
import { readVerifiedDomainSources, readVerifiedSourceDomain } from '../core/memory/source-domain-consumer.ts';
import { createSourceDomainReadStore, type SourceDomainReadStore } from '../core/memory/source-domain-read-store.ts';

const roots: string[] = [];
const stores: MemoryStateStore[] = [];
const bankId = 'bank-d4s3-facade';
const endpoint = 'http://127.0.0.1:8888';
const at = '2026-11-10T10:00:00.000Z';
const content = '项目决定：只读 facade 必须返回同一 Store 的分类与可信回读结果。';

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'r27-d4s3-facade-'));
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(tmpdir()) + '/')) throw new Error('synthetic files must stay under the system temporary directory');
  roots.push(path);
  return path;
}

function entry(): SourceDomainEvidence & { sourceStatus: string } {
  return {
    bankId,
    endpoint,
    documentId: 'source-facade',
    content,
    sourceEpoch: 0,
    sourceActor: 'user',
    sourceKind: 'event',
    sourceStatus: 'completed',
  };
}

function classification(value: SourceDomainEvidence): SourceDomainClassificationInput {
  const start = value.content.indexOf('只读 facade');
  return {
    bankId: value.bankId,
    endpoint: value.endpoint,
    documentId: value.documentId,
    state: 'assigned',
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: 'synthetic-d4s3-fixture/v1',
    confidence: 0.95,
    sourceEpoch: value.sourceEpoch,
    sourceRevision: hash(value.content),
    classifiedAt: at,
    updatedAt: at,
    links: [{
      domainId: 'project-functional',
      linkState: 'confirmed',
      confidence: 0.95,
      ruleId: 'synthetic-d4s3-approved-span',
      evidenceStart: start,
      evidenceEnd: start + '只读 facade'.length,
      evidenceDigest: hash('只读 facade'),
      claimVerification: 'user_verified',
    }],
  };
}

function emitEvidence(name: string, value: unknown): void {
  const dir = process.env.D4S3_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  closeMemoryStateStores();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('D4-S3 restricted domain read store', () => {
  it('exposes only bound readers and keeps classification and trusted readback identical', async () => {
    const root = tempRoot();
    const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
    if (!outbox.stateStore) throw new Error('synthetic SQLite state store did not open');
    const store = outbox.stateStore;
    stores.push(store);
    const value = entry();
    const provider: SourceDomainEvidenceProvider = (targetBank, targetEndpoint, documentId) =>
      targetBank === value.bankId && targetEndpoint === value.endpoint && documentId === value.documentId ? value : null;
    const writer = new MemoryStateStore(store.path, { sourceDomainEvidence: provider });
    stores.push(writer);
    writer.putSourceDomainClassification(classification(value));
    writer.close();
    stores.splice(stores.indexOf(writer), 1);

    const memory = new HindsightMemory();
    Object.assign(memory, {
      config: loadHindsightConfig(root, { enabled: true, apiUrl: endpoint, bankId }),
      client: new HindsightClient({ baseUrl: endpoint, maxAttempts: 1 }),
      outbox,
      ledger: new ForgetLedger(store),
      stateStore: store,
      ready: true,
      unavailableUntil: 0,
    });

    const facade = memory.domainStore();
    expect(facade).not.toBeNull();
    expect(facade).not.toBe(store);
    expect(Object.getPrototypeOf(facade)).toBe(Object.prototype);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.getOwnPropertySymbols(facade)).toEqual([]);
    expect(Object.keys(facade!).sort()).toEqual([
      'domainIndexStats',
      'getSourceDomainClassification',
      'listDomainSources',
    ]);
    expect(Object.getOwnPropertyNames(facade!).sort()).toEqual([
      'domainIndexStats',
      'getSourceDomainClassification',
      'listDomainSources',
    ]);
    for (const forbidden of ['db', 'path', 'transaction', 'close', 'putSourceDomainClassification', 'setSourceDomainClassification',
      'save', 'upsert', 'delete', 'setMeta', 'meta', 'sourceDomainEvidence']) {
      expect(Object.prototype.hasOwnProperty.call(facade, forbidden)).toBe(false);
      expect((facade as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }

    // TypeScript consumers see the reader interface only.
    if (false) {
      // @ts-expect-error the facade has no classification writer
      facade!.putSourceDomainClassification(classification(value));
    }

    const identity = { bankId, endpoint, documentId: value.documentId };
    const readback = async () => ({
      bankId: value.bankId,
      endpoint: value.endpoint,
      documentId: value.documentId,
      content: value.content,
      sourceEpoch: value.sourceEpoch,
      sourceRevision: hash(value.content),
      sourceActor: value.sourceActor,
      sourceKind: value.sourceKind,
      sourceStatus: value.sourceStatus,
    });
    const viaFacade = await readVerifiedSourceDomain(facade as SourceDomainReadStore, readback, identity);
    const viaStore = await readVerifiedSourceDomain(store, readback, identity);
    expect(viaFacade.status).toBe('verified');
    expect(viaStore.status).toBe('verified');
    expect(viaFacade.item?.fingerprint).toBe(viaStore.item?.fingerprint);
    expect(viaFacade.item?.classification.documentId).toBe(value.documentId);

    const facadeClassification = facade!.getSourceDomainClassification(bankId, endpoint, value.documentId);
    const storeClassification = store.getSourceDomainClassification(bankId, endpoint, value.documentId);
    expect(facadeClassification).toEqual(storeClassification);
    expect(facade!.domainIndexStats(bankId, endpoint)).toEqual(store.domainIndexStats(bankId, endpoint));
    expect(facade!.listDomainSources(bankId, endpoint, ['project-functional']))
      .toEqual(store.listDomainSources(bankId, endpoint, ['project-functional']));

    emitEvidence('readonly-facade.json', {
      layer: 'D4S3_READONLY_FACADE_RUNTIME',
      syntheticOnly: true,
      facadeKeys: Object.keys(facade!),
      facadePrototype: 'Object.prototype',
      facadeFrozen: Object.isFrozen(facade),
      ownSymbols: Object.getOwnPropertySymbols(facade).length,
      sameRawStoreInstance: facade === store,
      classificationEqual: facadeClassification,
      statsEqual: facade!.domainIndexStats(bankId, endpoint),
      readback: {
        facadeStatus: viaFacade.status,
        storeStatus: viaStore.status,
        facadeFingerprint: viaFacade.item?.fingerprint ?? null,
        storeFingerprint: viaStore.item?.fingerprint ?? null,
      },
    });
  });

  it('returns null while memory is disabled or the Forget ledger is damaged', () => {
    const root = tempRoot();
    const memory = new HindsightMemory();
    expect(memory.domainStore()).toBeNull();

    const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
    if (!outbox.stateStore) throw new Error('synthetic SQLite state store did not open');
    stores.push(outbox.stateStore);
    const config = loadHindsightConfig(root, { enabled: true, apiUrl: endpoint, bankId });
    Object.assign(memory, {
      config,
      client: new HindsightClient({ baseUrl: endpoint, maxAttempts: 1 }),
      outbox,
      ledger: { damaged: () => false, epoch: () => 0 },
      stateStore: outbox.stateStore,
      ready: true,
      unavailableUntil: 0,
    });
    expect(memory.domainStore()).not.toBeNull();
    Object.assign(memory, { ledger: { damaged: () => true, epoch: () => 0 } });
    expect(memory.domainStore()).toBeNull();
    expect(memory.domainReadbackProvider()).toBeNull();
  });

  it('does not let the facade bypass the synchronous readback guard of its raw store', async () => {
    const root = tempRoot();
    const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
    if (!outbox.stateStore) throw new Error('synthetic SQLite state store did not open');
    const store = outbox.stateStore;
    stores.push(store);
    const value = entry();
    const provider: SourceDomainEvidenceProvider = (targetBank, targetEndpoint, documentId) =>
      targetBank === value.bankId && targetEndpoint === value.endpoint && documentId === value.documentId ? value : null;
    // A real MemoryStateStore configured with a synchronous reentrant readback provider.
    const unsafe = new MemoryStateStore(store.path, { sourceDomainEvidence: provider });
    stores.push(unsafe);
    unsafe.putSourceDomainClassification(classification(value));

    const identity = { bankId, endpoint, documentId: value.documentId };
    const readback = async () => ({
      bankId: value.bankId,
      endpoint: value.endpoint,
      documentId: value.documentId,
      content: value.content,
      sourceEpoch: value.sourceEpoch,
      sourceRevision: hash(value.content),
      sourceActor: value.sourceActor,
      sourceKind: value.sourceKind,
      sourceStatus: value.sourceStatus,
    });
    const raw = await readVerifiedSourceDomain(unsafe, readback, identity);
    const facade = createSourceDomainReadStore(unsafe);
    const viaFacade = await readVerifiedSourceDomain(facade, readback, identity);
    const batch = await readVerifiedDomainSources(facade, readback, {
      bankId,
      endpoint,
      domains: ['project-functional'],
    });

    expect(raw).toMatchObject({ status: 'blocked', reason: 'sync_store_provider_unsupported', item: null });
    expect(viaFacade).toMatchObject({ status: 'blocked', reason: 'sync_store_provider_unsupported', item: null });
    expect(batch).toMatchObject({ status: 'blocked', reason: 'sync_store_provider_unsupported', items: [] });
    expect(viaFacade.finalBarrier).toBe('not_run');

    emitEvidence('facade-sync-guard-negative.json', {
      layer: 'D4S4_FACADE_SYNC_GUARD',
      syntheticOnly: true,
      rawStore: { status: raw.status, reason: raw.reason, item: raw.item },
      facade: { status: viaFacade.status, reason: viaFacade.reason, item: viaFacade.item },
      batch: { status: batch.status, reason: batch.reason, items: batch.items.length },
      facadeStillExposesOnlyReaders: Object.keys(facade).sort(),
    });
  });

  it('re-checks the live store after facade creation instead of trusting a one-time marker', async () => {
    const value = entry();
    const record: SourceDomainClassification = {
      ...classification(value),
      links: classification(value).links.map((link) => ({ ...link })),
    };
    const identity = { bankId, endpoint, documentId: value.documentId };
    const readback = async () => ({
      bankId: value.bankId,
      endpoint: value.endpoint,
      documentId: value.documentId,
      content: value.content,
      sourceEpoch: value.sourceEpoch,
      sourceRevision: hash(value.content),
      sourceActor: value.sourceActor,
      sourceKind: value.sourceKind,
      sourceStatus: value.sourceStatus,
    });
    // A store-shaped reader whose private provider field exists but is still empty.
    const target = {
      sourceDomainEvidence: undefined as SourceDomainEvidenceProvider | undefined,
      getSourceDomainClassification: (targetBank: string, targetEndpoint: string, documentId: string) =>
        targetBank === value.bankId && targetEndpoint === value.endpoint && documentId === value.documentId ? record : null,
      listDomainSources: () => ({ items: [], nextCursor: null, complete: true, filtered: 0, blocked: false }),
      domainIndexStats: () => ({
        records: 0, assigned: 0, ambiguous: 0, pendingReview: 0, unclassified: 0,
        verifiedSources: 0, notIndexed: 0, unattributedSources: 0, blocked: false,
      }),
    };
    const facade = createSourceDomainReadStore(target);
    const before = await readVerifiedSourceDomain(facade, readback, identity);
    expect(before.status).toBe('verified');

    // The provider is installed after the facade already exists and the same bound facade is reused.
    target.sourceDomainEvidence = () => value;
    const after = await readVerifiedSourceDomain(facade, readback, identity);
    expect(after).toMatchObject({ status: 'blocked', reason: 'sync_store_provider_unsupported', item: null });

    // Removing it again restores the same rule the raw store path applies.
    target.sourceDomainEvidence = undefined;
    const restored = await readVerifiedSourceDomain(facade, readback, identity);
    expect(restored.status).toBe('verified');

    // A lookalike reader without the state-store private field is refused, not assumed safe.
    const lookalike: SourceDomainReadStore = {
      getSourceDomainClassification: target.getSourceDomainClassification,
      listDomainSources: target.listDomainSources,
      domainIndexStats: target.domainIndexStats,
    };
    const forged = await readVerifiedSourceDomain(lookalike, readback, identity);
    expect(forged).toMatchObject({ status: 'blocked', reason: 'sync_store_provider_unsupported' });

    // Wrapping the unauditable reader in a facade must not turn it into a trusted store either.
    const forgedFacade = createSourceDomainReadStore(lookalike);
    const forgedViaFacade = await readVerifiedSourceDomain(forgedFacade, readback, identity);
    expect(forgedViaFacade).toMatchObject({ status: 'blocked', reason: 'sync_store_provider_unsupported' });

    emitEvidence('facade-sync-guard-dynamic.json', {
      layer: 'D4S4_FACADE_SYNC_GUARD_DYNAMIC',
      syntheticOnly: true,
      beforeProvider: { status: before.status, reason: before.reason },
      afterProviderInstalled: { status: after.status, reason: after.reason },
      afterProviderRemoved: { status: restored.status, reason: restored.reason },
      lookalikeReader: { status: forged.status, reason: forged.reason },
      lookalikeViaFacade: { status: forgedViaFacade.status, reason: forgedViaFacade.reason },
    });
  });
});
