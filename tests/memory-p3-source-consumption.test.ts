import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, World, WorldHost } from 'cortico/core/types.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeFakePersona, makeLoaded, textReply } from '../vendor/cortico/tests/core/helpers.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import {
  consumeDomainRelevantMemory,
  type CoreMemoryConsumption,
  type DomainRelevantConsumeResult,
} from '../core/memory/domain-relevant-consume.ts';
import { MemoryStateStore, closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';
import { createSourceDomainReadStore } from '../core/memory/source-domain-read-store.ts';
import { readVerifiedSourceDomain, type TrustedSourceReadbackEvidence } from '../core/memory/source-domain-consumer.ts';
import {
  MEMORY_DOMAIN_TAXONOMY,
  type SourceDomainClassificationInput,
  type SourceDomainEvidence,
  type SourceDomainEvidenceProvider,
} from '../core/memory/source-domains.ts';
import {
  baselineSourceExcerpts,
  type BaselineRecallConsumption,
} from '../core/memory/domain-relevant-consume.ts';

const bankId = 'p3-fixture-bank';
const endpoint = 'http://127.0.0.1:18888';
const docId = 'user:p3:fixture-1';
const SOURCE_TEXT = 'P3 synthetic source: the person prefers jasmine tea after lunch.';
const SPAN_TEXT = 'the person prefers jasmine tea after lunch';
const spanStart = SOURCE_TEXT.indexOf(SPAN_TEXT);
const roots: string[] = [];
const stores: MemoryStateStore[] = [];

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

afterEach(() => {
  closeMemoryStateStores();
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coo-p3-source-'));
  roots.push(root);
  return root;
}

async function seedClassification(root: string): Promise<{ store: MemoryStateStore; ledger: ForgetLedger }> {
  const store = openMemoryStateStore(join(root, 'memory-state.sqlite'));
  stores.push(store);
  const ledger = new ForgetLedger(store);
  const evidenceProvider: SourceDomainEvidenceProvider = (targetBank, targetEndpoint, documentId) =>
    targetBank === bankId && targetEndpoint === endpoint && documentId === docId
      ? {
        bankId,
        endpoint,
        documentId,
        content: SOURCE_TEXT,
        sourceEpoch: ledger.epoch(bankId, endpoint),
        sourceActor: 'user',
        sourceKind: 'event',
        sourceStatus: 'completed',
      } satisfies SourceDomainEvidence
      : null;
  const writer = new MemoryStateStore(store.path, { sourceDomainEvidence: evidenceProvider });
  stores.push(writer);
  const value: SourceDomainClassificationInput = {
    bankId,
    endpoint,
    documentId: docId,
    state: 'assigned',
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: 'p3-source-consumption-fixture/v1',
    confidence: 0.99,
    sourceEpoch: ledger.epoch(bankId, endpoint),
    sourceRevision: sha(SOURCE_TEXT),
    classifiedAt: '2026-11-15T04:00:00.000Z',
    updatedAt: '2026-11-15T04:00:00.000Z',
    links: [{
      domainId: 'skill-methods',
      linkState: 'confirmed',
      confidence: 0.99,
      ruleId: 'p3-fixture',
      evidenceStart: spanStart,
      evidenceEnd: spanStart + SPAN_TEXT.length,
      evidenceDigest: sha(SPAN_TEXT),
      claimVerification: 'user_verified',
    }],
  };
  writer.putSourceDomainClassification(value);
  writer.close();
  stores.splice(stores.indexOf(writer), 1);
  return { store, ledger };
}

function readback(epoch: number, overrides: Partial<TrustedSourceReadbackEvidence> = {}): TrustedSourceReadbackEvidence {
  return {
    bankId,
    endpoint,
    documentId: docId,
    content: SOURCE_TEXT,
    sourceEpoch: epoch,
    sourceRevision: sha(SOURCE_TEXT),
    sourceActor: 'user',
    sourceKind: 'event',
    sourceStatus: 'completed',
    ...overrides,
  };
}

describe('P3 source consumption chain', () => {
  it('keeps verified user facts when a parentless observation also declares unprovable Coo facts', async () => {
    const root = tempRoot();
    const { HindsightMemory } = await import('../core/memory/hindsight.ts');
    const { loadHindsightConfig } = await import('../core/memory/config.ts');
    const { HindsightClient } = await import('@vectorize-io/hindsight-client');
    const { createServer } = await import('node:http');
    const { createHash } = await import('node:crypto');
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          results: [{
            id: 'observation-p3', type: 'observation', text: 'A derived summary that no source backs.',
            document_id: null, source_fact_ids: ['fact-user', 'fact-coo'],
          }],
          source_facts: {
            'fact-user': {
              id: 'fact-user', text: SOURCE_TEXT, type: 'world', document_id: docId,
              metadata: { source_actor: 'user', kind: 'event', status: 'completed' },
            },
            'fact-coo': {
              id: 'fact-coo', text: 'A Coo output without lineage.', type: 'world',
              document_id: `coo:${createHash('sha256').update('missing').digest('hex').slice(0, 24)}`,
              metadata: { source_actor: 'coo', kind: 'event', status: 'completed' },
            },
          },
          source_facts_truncated: false,
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const store = openMemoryStateStore(join(root, 'memory-state.sqlite'));
    stores.push(store);
    const memory = new HindsightMemory();
    Object.assign(memory, {
      config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: baseUrl, bankId }),
      client: new HindsightClient({ baseUrl, maxAttempts: 1 }),
      stateStore: store,
      outbox: new MemoryOutbox(store),
      ledger: new ForgetLedger(store),
      ready: true,
      unavailableUntil: 0,
    });
    try {
      const read = await memory.recallBlockDetailed('What tea does the person prefer?', {
        maxSourceFactsTokens: 4096, captureTrace: true, activationEnabled: false,
      });
      expect(read.status).toBe('found');
      expect(read.text).toContain(SPAN_TEXT);
      expect(read.text).not.toContain('A derived summary that no source backs.');
      expect(read.text).not.toContain('A Coo output without lineage.');
      expect(read.trace?.search.items[0]?.disposition).toBe('visible');
      expect(read.trace?.search.items[0]?.sourceFactsIncomplete).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('delivers an exact readback through the real consumer and a Core request outside the delivery hook', async () => {
    const root = tempRoot();
    const { store, ledger } = await seedClassification(root);
    const epoch = ledger.epoch(bankId, endpoint);
    const delivered: CoreMemoryConsumption[] = [];
    const baseline: BaselineRecallConsumption = { text: '', status: 'absent' };
    const result: DomainRelevantConsumeResult = await consumeDomainRelevantMemory({
      enabled: true,
      query: 'What tea does the person prefer?',
      bankId,
      endpoint,
      store: createSourceDomainReadStore(store),
      baseline,
      search: async () => ({
        status: 'found',
        results: [{
          id: 'p3-result', text: '', type: 'observation', date: '',
          documentId: null,
          sourceFacts: [{
            id: 'p3-fact', text: SPAN_TEXT, type: 'world', date: '2026-11-15T04:00:00.000Z',
            documentId: docId,
            metadata: { source_actor: 'user', kind: 'event', status: 'completed' },
          }],
        }],
      }),
      readbackProvider: async (identity) => identity.bankId === bankId && identity.endpoint === endpoint
        && identity.documentId === docId ? readback(epoch) : null,
      getEvidenceEpoch: () => `${memoryEpoch(epoch)}:${epoch}`,
      deliver: (block) => { delivered.push(block); },
    });
    expect(result.status).toBe('supplemented');
    expect(result.supplement.consumedCount).toBe(1);
    expect(delivered).toHaveLength(1);
    const block = delivered[0]!;
    const core = { text: block.coreText!, evidence: block.coreEvidence!, sourceSegments: block.coreSegments! };
    expect(core.text).toBe(SPAN_TEXT);
    expect(core.evidence).toHaveLength(1);
    expect(core.evidence[0]!.documentId).toBe(docId);
    expect(block.text).toContain(SPAN_TEXT);
    expect(baselineSourceExcerpts(baseline)).toEqual([]);

    // Injected before any delivery hook, so no process-local dependency proof exists: the exact
    // excerpt block alone must satisfy the Core evidence gate.
    const run = await runStandaloneCore(core);
    expect(run.requestState).toBe('sent');
    expect(run.mappingState).toBe('complete');
    expect(run.exposedSources).toEqual([docId]);
    expect(run.body).toContain(SPAN_TEXT);

    // The same block with a tampered span digest never reaches the Provider.
    const tampered = {
      ...core,
      evidence: [{ ...core.evidence[0]!, segment: { ...core.evidence[0]!.segment, digest: sha('different text') } }],
    };
    const blocked = await runStandaloneCore(tampered);
    expect(blocked.requestState).toBe('unobserved');
    expect(blocked.body).not.toContain(SPAN_TEXT);
  });

  it('rejects forged, revoked, stale, cross-bank and forgotten real sources with exact reasons', async () => {
    const root = tempRoot();
    const { store, ledger } = await seedClassification(root);
    const epoch = ledger.epoch(bankId, endpoint);
    const readStore = createSourceDomainReadStore(store);
    const identity = { bankId, endpoint, documentId: docId };
    const reasonFor = async (evidence: TrustedSourceReadbackEvidence | null) => (await readVerifiedSourceDomain(
      readStore, async () => evidence, identity, { timeBudgetMs: 5000, providerTimeoutMs: 4000 },
    )).reason;

    expect(await reasonFor(readback(epoch))).toBeNull();
    expect(await reasonFor(readback(epoch, { sourceActor: 'coo' }))).toBe('actor_invalid');
    expect(await reasonFor(readback(epoch, { sourceStatus: 'revoked' }))).toBe('status_invalid');
    expect(await reasonFor(readback(epoch, { content: `${SOURCE_TEXT} changed` }))).toBe('revision_mismatch');
    expect(await reasonFor(readback(epoch + 1))).toBe('epoch_mismatch');
    expect(await reasonFor(readback(epoch, { bankId: 'other-bank' }))).toBe('identity_mismatch');
    expect(await reasonFor(null)).toBe('evidence_missing');

    const fence = ledger.add({ bankId, endpoint, documentId: docId, reason: 'P3 synthetic forget' });
    expect(fence).not.toBeNull();
    expect(await reasonFor(readback(epoch))).toBe('record_missing');
  });
});

function memoryEpoch(epoch: number): string {
  return `p3-fixture:${epoch}`;
}

interface StandaloneRun {
  requestState: string | null;
  mappingState: string | null;
  exposedSources: string[];
  body: string;
}

async function runStandaloneCore(block: CoreMemoryConsumption): Promise<StandaloneRun> {
  const root = tempRoot();
  const cfg = makeCfg();
  cfg.worlds.qq.enabled = false;
  cfg.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  let api: CoreApi | null = null;
  const persona = makeFakePersona([], { silent: true });
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };
  persona.validateEvidenceForRequest = () => true;
  const llm = new FakeLLM();
  llm.script(textReply('P3 standalone answer.'));
  const bodies: string[] = [];
  const respond = llm.respond.bind(llm);
  llm.respond = (request, options) => respond(request, {
    ...options,
    onRequestSent: (info) => {
      if (typeof info.body === 'string') bodies.push(info.body);
      options?.onRequestSent?.(info);
    },
  });
  const world: World = makeFakeIO('p3-world');
  let host: WorldHost | null = null;
  world.start = async (value) => { host = value; };
  const core = new Core(makeLoaded({ config: cfg, rootDir: join(root, 'core'), memoryDir: join(root, 'persona'), dataDir: join(root, 'data') }), {
    persona,
    worlds: [world],
    llm,
    requireCompleteEvidence: true,
    worldEventTrust: (candidate, event) => candidate === world && event.type === 'p3.message',
  });
  await core.start();
  try {
    api!.injectInternal(block.text, 'memory', block.evidence);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host!.pushEvent({
      type: 'p3.message', source: 'p3-world', dependencyOrigin: 'user-input',
      ts: new Date().toISOString(), text: 'P3 standalone question.', meta: { text: 'P3 standalone question.' },
    }, { trigger: 'flush' });
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const evidence = api!.generationEvidence('main');
      if (evidence.length > 0 && core.loop.getStatus().phase.state === 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const envelope = api!.generationEvidence('main').at(-1);
    return {
      requestState: envelope?.requestState ?? null,
      mappingState: envelope?.mappingState ?? null,
      exposedSources: (envelope?.exposedSources ?? []).map((source) => source.documentId),
      body: bodies[0] ?? '',
    };
  } finally {
    await core.stop();
  }
}
