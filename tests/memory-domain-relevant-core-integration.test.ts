import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, EvidenceAttachment, WorldHost } from 'cortico/core/types.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeFakePersona, makeLoaded, textReply } from '../vendor/cortico/tests/core/helpers.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import {
  consumeDomainRelevantMemory,
  type CoreMemoryConsumption,
  type DomainRelevantConsumeInput,
} from '../core/memory/domain-relevant-consume.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, MemoryStateStore } from '../core/memory/state-store.ts';
import {
  MEMORY_DOMAIN_TAXONOMY,
  type DomainId,
  type SourceDomainClassificationInput,
  type SourceDomainEvidence,
  type SourceDomainEvidenceProvider,
  type SourceDomainLinkInput,
} from '../core/memory/source-domains.ts';
import type {
  TrustedSourceReadbackEvidence,
  TrustedSourceReadbackProvider,
} from '../core/memory/source-domain-consumer.ts';

const roots: string[] = [];
const servers: Server[] = [];
const writers: MemoryStateStore[] = [];
const bankId = 'bank-d3b-s3-synthetic';
const at = '2026-11-10T08:00:00.000Z';

interface SyntheticSource extends SourceDomainEvidence {
  sourceStatus: string;
  excerpts: Partial<Record<DomainId, string>>;
}

interface SourceFact {
  id: string;
  text: string;
  type: string;
  document_id: string;
  occurred_start: string;
  metadata: Record<string, string>;
}

interface RecallResult {
  id: string;
  text: string;
  type: string;
  document_id: string;
  source_fact_ids: string[];
}

interface RecallResponse {
  results: RecallResult[];
  source_facts: Record<string, SourceFact>;
  source_facts_truncated: boolean;
}

interface RecallRequest {
  query: string;
  budget: string;
  maxTokens: number;
  maxSourceFactsTokens: number | null;
  types?: string[];
}

interface Rig {
  memory: HindsightMemory;
  ledger: ForgetLedger;
  store: MemoryStateStore;
  endpoint: string;
  sources: Map<string, SyntheticSource>;
  requests: RecallRequest[];
  readback: TrustedSourceReadbackProvider;
  setResponder: (responder: (request: RecallRequest) => RecallResponse) => void;
  seed: (entries: Array<{ source: SyntheticSource; state: 'assigned' | 'unclassified' | 'ambiguous' | 'pending_review'; domains?: DomainId[] }>) => void;
}

interface BaselineCapture {
  recall: Awaited<ReturnType<HindsightMemory['recallForTurn']>>;
  evidence: Awaited<ReturnType<HindsightMemory['evidenceForSegments']>>;
}

interface ConsumptionCapture {
  result: Awaited<ReturnType<typeof consumeDomainRelevantMemory>>;
  delivered: CoreMemoryConsumption[];
}

interface CoreRun {
  serializedBodies: string[];
  dispatchedBodies: string[];
  envelope: ReturnType<CoreApi['generationEvidence']>[number] | undefined;
  records: Array<{ itemId: string; text: string }>;
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function key(source: Pick<SyntheticSource, 'bankId' | 'endpoint' | 'documentId'>): string {
  return JSON.stringify([source.bankId, source.endpoint, source.documentId]);
}

function tuple(source: Pick<SyntheticSource, 'bankId' | 'endpoint' | 'documentId'>): [string, string, string] {
  return [source.bankId, source.endpoint, source.documentId];
}

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'r27-d3b-s3-'));
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(tmpdir()) + '/')) throw new Error('synthetic files must stay under the system temporary directory');
  roots.push(path);
  return path;
}

function source(
  endpoint: string,
  documentId: string,
  content: string,
  excerpts: Partial<Record<DomainId, string>>,
): SyntheticSource {
  return {
    bankId, endpoint, documentId, content, sourceEpoch: 0,
    sourceActor: 'user', sourceKind: 'event', sourceStatus: 'completed', excerpts,
  };
}

function factFor(factId: string, entry: SyntheticSource): SourceFact {
  return {
    id: factId,
    text: entry.content,
    type: 'world',
    document_id: entry.documentId,
    occurred_start: at,
    metadata: { source_actor: entry.sourceActor, kind: entry.sourceKind, status: entry.sourceStatus },
  };
}

function responseForDocs(docs: readonly SyntheticSource[]): RecallResponse {
  const results: RecallResult[] = [];
  const sourceFacts: Record<string, SourceFact> = {};
  docs.forEach((entry, index) => {
    const factId = `fact-${entry.documentId}`;
    sourceFacts[factId] = factFor(factId, entry);
    results.push({
      id: `observation-${entry.documentId}`,
      text: `Synthetic recall result ${String(index + 1).padStart(2, '0')}.`,
      type: 'observation',
      document_id: `observation:${entry.documentId}`,
      source_fact_ids: [factId],
    });
  });
  return { results, source_facts: sourceFacts, source_facts_truncated: false };
}

function linkFor(entry: SyntheticSource, domainId: DomainId, excerpt: string): SourceDomainLinkInput {
  const start = entry.content.indexOf(excerpt);
  if (start < 0) throw new Error('synthetic evidence span is not present in the source');
  return {
    domainId,
    linkState: 'confirmed',
    confidence: 0.95,
    ruleId: 'synthetic-approved-span',
    evidenceStart: start,
    evidenceEnd: start + excerpt.length,
    evidenceDigest: hash(excerpt),
    claimVerification: 'user_verified',
  };
}

function classificationFor(entry: SyntheticSource, domains: DomainId[]): SourceDomainClassificationInput {
  return {
    bankId: entry.bankId,
    endpoint: entry.endpoint,
    documentId: entry.documentId,
    state: 'assigned',
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: 'synthetic-s3-fixture/v1',
    confidence: 0.95,
    sourceEpoch: entry.sourceEpoch,
    sourceRevision: hash(entry.content),
    classifiedAt: at,
    updatedAt: at,
    links: domains.map((domainId) => {
      const excerpt = entry.excerpts[domainId];
      if (!excerpt) throw new Error('an assigned synthetic domain requires a source span');
      return linkFor(entry, domainId, excerpt);
    }),
  };
}

async function createRig(stockBudget: 'low' | 'mid' | 'high' = 'mid'): Promise<Rig> {
  const entries = new Map<string, SyntheticSource>();
  const requests: RecallRequest[] = [];
  let responder: (request: RecallRequest) => RecallResponse = () => ({ results: [], source_facts: {}, source_facts_truncated: false });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET') {
      const match = /^\/v1\/default\/banks\/([^/]+)\/documents\/([^/]+)$/.exec(url.pathname);
      if (!match) {
        request.resume();
        response.writeHead(404);
        response.end();
        return;
      }
      const targetBank = decodeURIComponent(match[1]!);
      const documentId = decodeURIComponent(match[2]!);
      const entry = [...entries.values()].find((item) => item.bankId === targetBank && item.documentId === documentId);
      if (!entry) {
        request.resume();
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: 'not found' }));
        return;
      }
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: entry.documentId,
        bank_id: entry.bankId,
        original_text: entry.content,
        content_hash: hash(entry.content),
        created_at: at,
        updated_at: at,
        memory_unit_count: 1,
        document_metadata: {
          source_actor: entry.sourceActor,
          kind: entry.sourceKind,
          status: entry.sourceStatus,
        },
      }));
      return;
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/memories/recall')) {
      request.resume();
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        query?: string; budget?: string; max_tokens?: number; max_source_facts_tokens?: number; types?: string[];
      };
      const observed: RecallRequest = {
        query: body.query ?? '',
        budget: body.budget ?? '',
        maxTokens: Number(body.max_tokens ?? 0),
        maxSourceFactsTokens: body.max_source_facts_tokens === undefined ? null : Number(body.max_source_facts_tokens),
        ...(Array.isArray(body.types) ? { types: body.types } : {}),
      };
      requests.push(observed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responder(observed)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const endpoint = 'http://127.0.0.1:' + address.port;
  const root = tempRoot();
  const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
  if (!outbox.stateStore) throw new Error('synthetic SQLite state store did not open');
  const ledger = new ForgetLedger(outbox.stateStore);
  const memory = new HindsightMemory();
  Object.assign(memory, {
    config: {
      enabled: true,
      autostart: false,
      apiUrl: endpoint,
      apiToken: '',
      bankId,
      recall: { maxTokens: 900, budget: stockBudget, timeoutMs: 1200, types: ['observation', 'world', 'experience'] },
      retain: { async: true },
      portrait: { maxTokens: 500 },
      affection: { enabled: false, dailyPositive: 10, dailyNegative: 5 },
    },
    client: new HindsightClient({ baseUrl: endpoint, maxAttempts: 1 }),
    outbox,
    ledger,
    stateStore: outbox.stateStore,
    ready: true,
    unavailableUntil: 0,
  });
  const store = outbox.stateStore;
  const readback: TrustedSourceReadbackProvider = async (identity, context) => {
    if (context.signal.aborted) return null;
    const entry = entries.get(key(identity));
    if (!entry) return null;
    return {
      bankId: entry.bankId,
      endpoint: entry.endpoint,
      documentId: entry.documentId,
      content: entry.content,
      sourceEpoch: ledger.epoch(entry.bankId, entry.endpoint),
      sourceRevision: hash(entry.content),
      sourceActor: entry.sourceActor,
      sourceKind: entry.sourceKind,
      sourceStatus: entry.sourceStatus,
    } satisfies TrustedSourceReadbackEvidence;
  };
  const seed = (values: Array<{ source: SyntheticSource; state: 'assigned' | 'unclassified' | 'ambiguous' | 'pending_review'; domains?: DomainId[] }>) => {
    for (const value of values) entries.set(key(value.source), value.source);
    const provider: SourceDomainEvidenceProvider = (targetBank, targetEndpoint, documentId) => {
      const entry = entries.get(key({ bankId: targetBank, endpoint: targetEndpoint, documentId }));
      return entry ? {
        bankId: entry.bankId, endpoint: entry.endpoint, documentId: entry.documentId, content: entry.content,
        sourceEpoch: entry.sourceEpoch, sourceActor: entry.sourceActor, sourceKind: entry.sourceKind, sourceStatus: entry.sourceStatus,
      } satisfies SourceDomainEvidence : null;
    };
    const writer = new MemoryStateStore(store.path, { sourceDomainEvidence: provider });
    writers.push(writer);
    for (const value of values) writer.putSourceDomainClassification(classificationFor(value.source, value.domains ?? []));
    writer.close();
    writers.splice(writers.indexOf(writer), 1);
  };
  return { memory, ledger, store, endpoint, sources: entries, requests, readback, setResponder: (value) => { responder = value; }, seed };
}

async function recallBaseline(rig: Rig, query: string): Promise<BaselineCapture> {
  const recall = await rig.memory.recallForTurn(query, { captureTrace: true, activationEnabled: false });
  const segments = recall.trace?.format.sourceSegments ?? [];
  const evidence = recall.text && segments.length > 0
    ? await rig.memory.evidenceForSegments(recall.text, segments)
    : [];
  return { recall, evidence };
}

async function consume(rig: Rig, query: string, baseline: BaselineCapture): Promise<ConsumptionCapture> {
  const delivered: CoreMemoryConsumption[] = [];
  const input: DomainRelevantConsumeInput = {
    enabled: true,
    query,
    bankId,
    endpoint: rig.endpoint,
    store: rig.store,
    baseline: {
      text: baseline.recall.text,
      status: baseline.recall.status,
      trace: baseline.recall.trace,
      evidence: baseline.evidence,
    },
    search: (text, options) => rig.memory.searchResultsDetailed(text, options),
    readbackProvider: rig.readback,
    getEvidenceEpoch: () => rig.memory.evidenceEpoch(),
    deliver: (block) => { delivered.push(block); },
  };
  const result = await consumeDomainRelevantMemory(input);
  return { result, delivered };
}

async function consumeEmptyBaseline(rig: Rig, query: string): Promise<ConsumptionCapture> {
  const delivered: CoreMemoryConsumption[] = [];
  const result = await consumeDomainRelevantMemory({
    enabled: true,
    query,
    bankId,
    endpoint: rig.endpoint,
    store: rig.store,
    baseline: { text: '', status: 'absent' },
    search: (text, options) => rig.memory.searchResultsDetailed(text, options),
    readbackProvider: rig.readback,
    getEvidenceEpoch: () => rig.memory.evidenceEpoch(),
    deliver: (block) => { delivered.push(block); },
  });
  return { result, delivered };
}

function serializedStringAt(body: string, field: string): string {
  const tokens = field.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let value: unknown = JSON.parse(body);
  for (const token of tokens) {
    if (value && typeof value === 'object') value = (value as Record<string, unknown>)[token];
    else throw new Error(`serialized field is not an object at ${token}`);
  }
  if (typeof value !== 'string') throw new Error(`serialized field is not text: ${field}`);
  return value;
}

function emitEvidence(name: string, value: unknown): void {
  const dir = process.env.D3B_S3_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function runCoreBlock(block: CoreMemoryConsumption, options: { requireCompleteEvidence?: boolean } = {}): Promise<CoreRun> {
  const root = tempRoot();
  const cfg = makeCfg();
  cfg.worlds.qq.enabled = false;
  cfg.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  let api: CoreApi | null = null;
  let injected = false;
  const persona = makeFakePersona([], {
    silent: true,
    onDelivery: () => {
      if (injected || !block.text) return;
      injected = true;
      api!.injectInternal(block.text, 'memory', block.evidence);
    },
  });
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };
  const evidenceByTuple = new Map(block.evidence.map((attachment) => [
    JSON.stringify([attachment.bankId, attachment.endpoint, attachment.documentId]),
    attachment,
  ]));
  persona.validateEvidenceForRequest = (sources) => sources.every((source) => {
    const attachment = evidenceByTuple.get(JSON.stringify([source.bankId, source.endpoint, source.documentId]));
    return !!attachment
      && source.validatedEpoch === attachment.validatedEpoch
      && source.revisionState === attachment.revisionState
      && source.validationStatus === attachment.validationStatus
      && source.validationReceipt === attachment.validationReceipt
      && source.contentDigest === attachment.contentDigest;
  });
  const llm = new FakeLLM();
  llm.script(textReply('Synthetic answer.'));
  const serializedBodies: string[] = [];
  const dispatchedBodies: string[] = [];
  const respond = llm.respond.bind(llm);
  llm.respond = (request, providerOptions) => respond(request, {
    ...providerOptions,
    onRequestReady: (info) => {
      if (typeof info.body === 'string') serializedBodies.push(info.body);
      return providerOptions?.onRequestReady?.(info) ?? true;
    },
    onRequestSent: (info) => {
      if (typeof info.body === 'string') dispatchedBodies.push(info.body);
      providerOptions?.onRequestSent?.(info);
    },
  });
  const world = makeFakeIO('core-world');
  let host: WorldHost | null = null;
  world.start = async (value) => { host = value; };
  const core = new Core(makeLoaded({
    config: cfg,
    rootDir: join(root, 'core'),
    memoryDir: join(root, 'persona'),
    dataDir: join(root, 'data'),
  }), {
    persona,
    worlds: [world],
    llm,
    requireCompleteEvidence: options.requireCompleteEvidence ?? true,
    worldEventTrust: (candidate, event) => candidate === world && event.type === 'core.message',
  });
  await core.start();
  try {
    await host!.pushEvent({
      type: 'core.message', source: 'core-world', dependencyOrigin: 'user-input',
      ts: new Date().toISOString(), text: 'Synthetic Core injection question.', meta: { text: 'Synthetic Core injection question.' },
    }, { trigger: 'flush' });
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const evidenceCount = api!.generationEvidence('main').length;
      if (evidenceCount > 0 && core.loop.getStatus().phase.state === 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const envelope = api!.generationEvidence('main').at(-1);
    return {
      serializedBodies,
      dispatchedBodies,
      envelope,
      records: core.session.records.map((record) => ({
        itemId: record.item.id ?? '',
        text: record.item.type === 'message'
          ? typeof record.item.content === 'string' ? record.item.content
            : record.item.content.map((part) => 'text' in part ? part.text : '').join('')
          : record.item.type === 'function_call' ? record.item.arguments
            : record.item.type === 'function_call_output' ? String(record.item.output) : '',
      })),
    };
  } finally {
    await core.stop();
  }
}

function tupleCoverage(
  required: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
  baselineCandidates: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
  discovered: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
  exposed: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
  baselineConsumed: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
): {
  newDiscoveredRequired: number;
  newExposedRequired: number;
  consumptionCoverageGain: number;
  baselineCandidateCount: number;
  baselineConsumedCount: number;
  discoveredCount: number;
  exposedCount: number;
} {
  const has = (values: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>, item: { bankId: string; endpoint: string; documentId: string }) =>
    values.some((value) => value.bankId === item.bankId && value.endpoint === item.endpoint && value.documentId === item.documentId);
  const requiredNew = required.filter((item) => !has(baselineCandidates, item) && !has(baselineConsumed, item));
  return {
    newDiscoveredRequired: requiredNew.filter((item) => has(discovered, item)).length,
    newExposedRequired: requiredNew.filter((item) => has(exposed, item)).length,
    consumptionCoverageGain: required.filter((item) => has(baselineCandidates, item) && !has(baselineConsumed, item) && has(exposed, item)).length,
    baselineCandidateCount: baselineCandidates.length,
    baselineConsumedCount: baselineConsumed.length,
    discoveredCount: discovered.length,
    exposedCount: exposed.length,
  };
}

afterEach(async () => {
  for (const writer of writers.splice(0)) {
    try { writer.close(); } catch { /* already closed */ }
  }
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const QUERY = '请整理项目功能方面的重点决定以及可以重复使用的实现方法，并列出各自适用范围和判断依据，供本轮回答使用';

function noiseSources(endpoint: string, count: number): SyntheticSource[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return source(
      endpoint,
      `source-noise-${number}`,
      `Synthetic project note ${number}: the user recorded a routine project preference that remains visible in baseline recall.`,
      { 'project-functional': 'routine project preference' },
    );
  });
}

describe('D3b-S3 controlled Core injection and semantic discovery', () => {
  it('injects S2 verified source spans through the real Core API and a real serialized Provider request', async () => {
    const rig = await createRig('mid');
    const target = source(
      rig.endpoint,
      'source-core-injected',
      'Project decision: the verified source is injected as a past record and never as an instruction.',
      { 'project-functional': 'Project decision: the verified source is injected as a past record and never as an instruction.' },
    );
    rig.seed([{ source: target, state: 'assigned', domains: ['project-functional'] }]);
    rig.setResponder((request) => request.budget === 'low' ? responseForDocs([target]) : { results: [], source_facts: {}, source_facts_truncated: false });

    const baseline = await recallBaseline(rig, QUERY);
    expect(baseline.recall.text).toBe('');
    expect(baseline.recall.status).toBe('absent');

    const { result, delivered } = await consumeEmptyBaseline(rig, QUERY);
    expect(result.status).toBe('supplemented');
    expect(result.baseline.status).toBe('absent');
    expect(result.supplement.readStatus).toBe('complete');
    expect(result.consumedSources.map((item) => item.identity.documentId)).toEqual(['source-core-injected']);
    expect(result.text).toContain(target.content);
    expect(delivered).toHaveLength(1);

    const block = delivered[0]!;
    const run = await runCoreBlock(block);
    expect(run.serializedBodies).toHaveLength(1);
    expect(run.dispatchedBodies).toHaveLength(1);
    const body = run.serializedBodies[0]!;
    expect(run.envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete', actualEvidenceUsed: 'unknown' });
    expect(run.envelope?.exposedSources.map((source) => source.documentId)).toEqual(['source-core-injected']);
    expect(body).toContain(target.content);

    const itemSpans = run.envelope!.items.flatMap((item) => item.spans)
      .filter((span) => span.origin === 'hindsight-source');
    expect(itemSpans).toHaveLength(1);
    const span = itemSpans[0]!;
    expect(span.mappingState).toBe('complete');
    expect(span.serializedRanges).toHaveLength(1);
    const range = span.serializedRanges[0]!;
    expect(serializedStringAt(body, range.field).slice(range.start, range.end)).toBe(target.content);
    expect(span.exposedSources.map((source) => source.documentId)).toEqual(['source-core-injected']);

    const provenance = {
      layer: 'D3B_S3_CORE_INPUT_PROVENANCE',
      syntheticOnly: true,
      s2: {
        textChars: block.text.length,
        evidenceCount: block.evidence.length,
        sourceTuples: result.finalSourceTuples.map(tuple),
        evidence: block.evidence.map((attachment) => ({
          tuple: [attachment.bankId, attachment.endpoint, attachment.documentId],
          validatedEpoch: attachment.validatedEpoch,
          revisionState: attachment.revisionState,
          validationStatus: attachment.validationStatus,
          validationReceipt: attachment.validationReceipt,
          contentDigest: attachment.contentDigest,
          segment: attachment.segment,
          visibleText: block.text.slice(attachment.segment.start, attachment.segment.end),
        })),
        consumedSources: result.consumedSources.map((item) => ({
          tuple: tuple(item.identity),
          contentDigest: item.contentDigest,
          spans: item.spans.map((entry) => ({
            start: entry.start, end: entry.end, digest: entry.digest, text: entry.text,
          })),
        })),
      },
      core: {
        injectionApi: 'CoreApi.injectInternal(text, memory, evidence)',
        serializedBodyDigest: hash(body),
        serializedBodyIncludesSourceText: body.includes(target.content),
        envelope: {
          requestState: run.envelope!.requestState,
          mappingState: run.envelope!.mappingState,
          actualEvidenceUsed: run.envelope!.actualEvidenceUsed,
          serializedBodyDigest: run.envelope!.serializedBodyDigest,
          exposedSources: run.envelope!.exposedSources,
          itemSpans: itemSpans.map((entry) => ({
            start: entry.start, end: entry.end, origin: entry.origin, mappingState: entry.mappingState,
            serializedRanges: entry.serializedRanges, exposedSources: entry.exposedSources,
          })),
        },
        alignment: block.evidence.map((attachment) => {
          const span = itemSpans.find((entry) => entry.start === attachment.segment.start
            && entry.end === attachment.segment.end
            && entry.exposedSources.some((source) => source.documentId === attachment.documentId));
          const range = span?.serializedRanges[0];
          const serializedText = range ? serializedStringAt(body, range.field).slice(range.start, range.end) : null;
          return {
            tuple: [attachment.bankId, attachment.endpoint, attachment.documentId],
            validatedEpoch: attachment.validatedEpoch,
            revisionState: attachment.revisionState,
            validationStatus: attachment.validationStatus,
            validationReceipt: attachment.validationReceipt,
            contentDigest: attachment.contentDigest,
            segment: attachment.segment,
            coreSpanFound: !!span,
            serializedRange: range ?? null,
            serializedText,
            textMatches: serializedText === block.text.slice(attachment.segment.start, attachment.segment.end),
            digestMatches: serializedText ? hash(serializedText) === attachment.segment.digest : false,
            sourceTupleMatches: !!span && span.exposedSources.some((source) => source.documentId === attachment.documentId
              && source.validatedEpoch === attachment.validatedEpoch
              && source.validationReceipt === attachment.validationReceipt
              && source.contentDigest === attachment.contentDigest),
          };
        }),
        serializedSourceText: serializedStringAt(body, range.field).slice(range.start, range.end),
      },
      verdicts: {
        ACTUALLY_SERIALIZED: body.includes(target.content),
        SOURCE_EXPOSURE_VERIFIED: run.envelope!.requestState === 'sent'
          && run.envelope!.mappingState === 'complete'
          && run.envelope!.exposedSources.some((source) => source.documentId === target.documentId),
        ACTUAL_MODEL_USED: 'UNKNOWN',
      },
      requests: rig.requests,
    };
    for (const alignment of provenance.core.alignment) {
      expect(alignment.coreSpanFound).toBe(true);
      expect(alignment.textMatches).toBe(true);
      expect(alignment.digestMatches).toBe(true);
      expect(alignment.sourceTupleMatches).toBe(true);
    }
    emitEvidence('core-input-provenance.json', provenance);
    console.log('D3B_S3_CORE_INPUT_PROVENANCE=' + JSON.stringify(provenance));

    const baselineCandidates: Array<{ bankId: string; endpoint: string; documentId: string }> = [];
    const exposed = run.envelope!.exposedSources.map((source) => ({ bankId: source.bankId, endpoint: source.endpoint, documentId: source.documentId }));
    const required = [{ bankId: target.bankId, endpoint: target.endpoint, documentId: target.documentId }];
    const coverage = tupleCoverage(required, baselineCandidates, result.supplement.discoveredSourceTuples, exposed, result.baseline.sourceTuples);
    expect(coverage.newDiscoveredRequired).toBe(1);
    expect(coverage.newExposedRequired).toBe(1);
    emitEvidence('empty-baseline-legal.json', {
      baseline: { status: baseline.recall.status, textChars: baseline.recall.text.length },
      s2: {
        queried: result.supplement.queried,
        status: result.status,
        stopReason: result.stopReason,
        discoveredSourceTuples: result.supplement.discoveredSourceTuples.map(tuple),
        verifiedSourceTuples: result.supplement.verifiedSourceTuples.map(tuple),
        consumedSourceTuples: result.consumedSources.map((item) => tuple(item.identity)),
      },
      coverage,
      serialized: provenance.verdicts.ACTUALLY_SERIALIZED,
      exposed: provenance.verdicts.SOURCE_EXPOSURE_VERIFIED,
      requests: rig.requests,
    });
  }, 30000);

  it('finds a required source outside the complete stock Recall candidate set and exposes it through Core', async () => {
    const rig = await createRig('mid');
    const noise = noiseSources(rig.endpoint, 12);
    const lateShared = source(
      rig.endpoint,
      'source-late-shared',
      'Project and method note: a verified source can carry both a project decision and a reusable method span.',
      { 'project-functional': 'a verified source can carry' },
    );
    const lateProject = source(
      rig.endpoint,
      'source-late-project',
      'Project decision: compare the fresh source digest before using a remembered implementation choice.',
      { 'project-functional': 'compare the fresh source digest' },
    );
    const newDiscovery = source(
      rig.endpoint,
      'source-new-discovery',
      'Project decision: the literal migration checkpoint is the evidence that was outside the stock recall candidates.',
      { 'project-functional': 'Project decision: the literal migration checkpoint is the evidence that was outside the stock recall candidates.' },
    );
    const stockOrder = [...noise, lateShared, lateProject];
    const all = [...stockOrder, newDiscovery];
    rig.seed(all.map((entry) => ({ source: entry, state: 'assigned' as const, domains: ['project-functional'] })));
    rig.setResponder((request) => request.budget === 'low' ? responseForDocs(all) : responseForDocs(stockOrder));

    const baseline = await recallBaseline(rig, QUERY);
    expect(baseline.recall.status).toBe('found');
    expect(baseline.recall.trace?.format.includedResultIds).toHaveLength(12);
    expect(baseline.recall.trace?.format.omittedResultIds).toHaveLength(2);
    expect(baseline.recall.text).not.toContain(lateShared.content);
    expect(baseline.recall.text).not.toContain(lateProject.content);
    expect(baseline.recall.text).not.toContain(newDiscovery.content);

    const baselineCandidates = [...new Map(
      (baseline.recall.trace?.search.items ?? []).flatMap((item) => item.verifiedSources.map((source) => {
        const identity = { bankId, endpoint: rig.endpoint, documentId: source.documentId };
        return [JSON.stringify(tuple(identity)), identity] as const;
      })),
    ).values()];
    expect(baselineCandidates.map((item) => item.documentId)).toEqual(expect.arrayContaining(['source-late-shared', 'source-late-project']));
    expect(baselineCandidates.map((item) => item.documentId)).not.toContain('source-new-discovery');

    const { result, delivered } = await consume(rig, QUERY, baseline);
    expect(result.status).toBe('supplemented');
    expect(result.supplement.discoveredSourceTuples.map((item) => item.documentId)).toContain('source-new-discovery');
    expect(result.supplement.discoveredResultIds).toHaveLength(15);
    expect(result.supplement.discoveredResultIds).toContain('observation-source-new-discovery');
    expect(result.supplement.verifiedSourceTuples.map((item) => item.documentId)).toContain('source-new-discovery');
    expect(result.addedSourceTuples.map((item) => item.documentId)).toEqual(expect.arrayContaining([
      'source-late-shared', 'source-late-project', 'source-new-discovery',
    ]));
    expect(result.baseline.preserved).toBe(true);
    expect(result.text.startsWith(baseline.recall.text)).toBe(true);
    expect(result.supplement.deduplicatedAgainstBaseline).toBe(12);
    expect(result.text).toContain(newDiscovery.content);

    const run = await runCoreBlock(delivered[0]!);
    expect(run.dispatchedBodies).toHaveLength(1);
    expect(run.envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete', actualEvidenceUsed: 'unknown' });
    expect(run.serializedBodies[0]).toContain(newDiscovery.content);

    const exposed = run.envelope!.exposedSources.map((source) => ({ bankId: source.bankId, endpoint: source.endpoint, documentId: source.documentId }));
    const required = [lateShared, lateProject, newDiscovery].map((entry) => ({ bankId: entry.bankId, endpoint: entry.endpoint, documentId: entry.documentId }));
    const coverage = tupleCoverage(required, baselineCandidates, result.supplement.discoveredSourceTuples, exposed, result.baseline.sourceTuples);

    expect(coverage.newDiscoveredRequired).toBe(1);
    expect(coverage.newExposedRequired).toBe(1);
    expect(coverage.consumptionCoverageGain).toBe(2);
    expect(coverage.baselineCandidateCount).toBe(14);
    expect(coverage.baselineConsumedCount).toBe(12);
    expect(coverage.exposedCount).toBe(15);

    const matrix = {
      layer: 'D3B_S3_QUERY_DISCOVERY_COVERAGE',
      syntheticOnly: true,
      query: QUERY,
      stockRecallConfig: { budget: 'mid', maxTokens: 900, route: baseline.recall.route },
      requests: rig.requests,
      searchModel: 'mid budget returns the semantic observation top 14; low budget performs the separate literal source-fact search used by D3b-S1',
      requiredSourceTuples: required.map(tuple),
      baselineCandidateResultIds: baseline.recall.trace?.format.candidateResultIds ?? [],
      baselineCandidateTuples: baselineCandidates.map(tuple),
      baselineConsumedTuples: result.baseline.sourceTuples.map(tuple),
      supplementDiscoveredResultIds: result.supplement.discoveredResultIds,
      supplementDiscoveredTuples: result.supplement.discoveredSourceTuples.map(tuple),
      supplementVerifiedResultIds: result.supplement.verifiedResultIds,
      supplementVerifiedTuples: result.supplement.verifiedSourceTuples.map(tuple),
      finalSourceTuples: result.finalSourceTuples.map(tuple),
      serializedExposedTuples: exposed.map(tuple),
      coverage,
      verdicts: {
        SEMANTIC_DISCOVERY_GAIN_SYNTHETIC: coverage.newDiscoveredRequired,
        PROVIDER_SOURCE_EXPOSURE_SYNTHETIC: coverage.newExposedRequired,
        CONSUMPTION_COVERAGE_GAIN_REUSED_FROM_S2: coverage.consumptionCoverageGain,
      },
    };
    emitEvidence('query-discovery-coverage.json', matrix);
    console.log('D3B_S3_QUERY_DISCOVERY_COVERAGE=' + JSON.stringify(matrix));
  }, 30000);

  it('keeps the disabled path at the original baseline and does not inject a supplement', async () => {
    const baselineText = '[memory] Baseline recall text stays exactly as supplied.';
    const delivered: CoreMemoryConsumption[] = [];
    const result = await consumeDomainRelevantMemory({
      enabled: false,
      query: QUERY,
      bankId,
      endpoint: 'http://synthetic.invalid',
      store: {} as MemoryStateStore,
      baseline: { text: baselineText, status: 'found' },
      search: () => { throw new Error('disabled supplement must not search'); },
      readbackProvider: async () => { throw new Error('disabled supplement must not read back'); },
      getEvidenceEpoch: () => { throw new Error('disabled supplement must not read an epoch'); },
      deliver: (block) => { delivered.push(block); },
    });
    expect(result.mode).toBe('disabled');
    expect(result.supplement.queried).toBe(false);
    expect(delivered).toHaveLength(1);
    const run = await runCoreBlock(delivered[0]!);
    expect(run.serializedBodies[0]).toContain(baselineText);
    expect(run.envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });
    expect(run.envelope?.exposedSources).toEqual([]);
    emitEvidence('disabled-path.json', {
      mode: result.mode,
      status: result.status,
      queryCalls: result.supplement.budget.queryCalls,
      readbackCalls: result.supplement.budget.readbackCalls,
      deliveredChars: delivered[0]?.text.length ?? 0,
      serializedBaseline: run.serializedBodies[0]?.includes(baselineText) ?? false,
      exposedSources: run.envelope?.exposedSources ?? [],
    });
  }, 30000);

  it('rejects a forged source digest at the Core evidence gate before dispatch', async () => {
    const rig = await createRig('mid');
    const target = source(
      rig.endpoint,
      'source-forged',
      'Project decision: a forged attachment digest must not reach the provider.',
      { 'project-functional': 'a forged attachment digest must not reach the provider' },
    );
    rig.seed([{ source: target, state: 'assigned', domains: ['project-functional'] }]);
    rig.setResponder((request) => request.budget === 'low' ? responseForDocs([target]) : { results: [], source_facts: {}, source_facts_truncated: false });
    const baseline = await recallBaseline(rig, QUERY);
    const { delivered } = await consume(rig, QUERY, baseline);
    const block = delivered[0]!;
    const forged = structuredClone(block);
    forged.evidence[forged.evidence.length - 1]!.segment.digest = '0'.repeat(64);

    const run = await runCoreBlock(forged);
    expect(run.dispatchedBodies).toHaveLength(0);
    expect(run.envelope).toMatchObject({ requestState: 'unobserved', exposedSources: [] });
    expect(run.envelope?.mappingState).not.toBe('complete');
    emitEvidence('core-evidence-rejection.json', {
      variant: 'forged-segment-digest',
      requestState: run.envelope?.requestState,
      mappingState: run.envelope?.mappingState,
      requestBlockReason: run.envelope?.requestBlockReason,
      exposedSources: run.envelope?.exposedSources,
      dispatchedBodies: run.dispatchedBodies.length,
      serializedBodies: run.serializedBodies.length,
    });
  }, 30000);

  it('fails closed on empty baselines that are fenced, unavailable or incomplete', async () => {
    const observed: Array<{ status: string; resultStatus: string; stopReason: string | null; queried: boolean; queryCalls: number; deliveries: number }> = [];
    for (const status of ['fenced', 'unavailable', 'incomplete'] as const) {
      const delivered: CoreMemoryConsumption[] = [];
      const result = await consumeDomainRelevantMemory({
        enabled: true,
        query: QUERY,
        bankId,
        endpoint: 'http://synthetic.invalid',
        store: {} as MemoryStateStore,
        baseline: { text: '', status },
        search: () => { throw new Error('a non-legal empty baseline must not search'); },
        getEvidenceEpoch: () => 'synthetic-epoch',
        deliver: (block) => { delivered.push(block); },
      });
      observed.push({
        status,
        resultStatus: result.status,
        stopReason: result.stopReason,
        queried: result.supplement.queried,
        queryCalls: result.supplement.budget.queryCalls,
        deliveries: result.deliveries,
      });
      expect(result.supplement.queried).toBe(false);
      expect(result.supplement.budget.queryCalls).toBe(0);
      expect(result.status).toBe(status === 'fenced' ? 'fenced' : status === 'unavailable' ? 'unavailable' : 'baseline_only');
      expect(result.stopReason).toBe(status === 'fenced' ? 'baseline_fenced'
        : status === 'unavailable' ? 'baseline_unavailable' : 'baseline_incomplete');
    }
    const delivered: CoreMemoryConsumption[] = [];
    const epochMissing = await consumeDomainRelevantMemory({
      enabled: true,
      query: QUERY,
      bankId,
      endpoint: 'http://synthetic.invalid',
      store: {} as MemoryStateStore,
      baseline: { text: '', status: 'absent' },
      search: () => { throw new Error('an absent baseline without an epoch must not search'); },
      getEvidenceEpoch: () => null,
      deliver: (block) => { delivered.push(block); },
    });
    expect(epochMissing.status).toBe('unavailable');
    expect(epochMissing.stopReason).toBe('source_epoch_unavailable');
    expect(epochMissing.supplement.queried).toBe(false);
    expect(delivered).toEqual([]);
    observed.push({
      status: 'absent_without_epoch',
      resultStatus: epochMissing.status,
      stopReason: epochMissing.stopReason,
      queried: epochMissing.supplement.queried,
      queryCalls: epochMissing.supplement.budget.queryCalls,
      deliveries: epochMissing.deliveries,
    });
    emitEvidence('empty-baseline-fail-closed.json', { observed });
  });
});
