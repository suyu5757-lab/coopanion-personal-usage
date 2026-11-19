import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
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
import {
  corpus,
  rankingEvidence,
  responseForQuery,
  type D4S1Doc,
  type RankedDoc,
} from './fixtures/d4s1-query-sensitive-recall.ts';

const roots: string[] = [];
const servers: Server[] = [];
const writers: MemoryStateStore[] = [];
const bankId = 'bank-d4-s1-same-source';
const stockTypes = ['observation', 'world', 'experience'] as const;
let currentEndpoint = '';
const supplementTypes = [...stockTypes, 'opinion'] as const;

interface WireDoc {
  doc: D4S1Doc;
  bankId: string;
  endpoint: string;
  sourceEpoch: number;
}

interface RecallRequest {
  query: string;
  budget: string;
  maxTokens: number;
  maxSourceFactsTokens: number | null;
  types: string[] | null;
  ranked: ReturnType<typeof rankingEvidence>;
  returned: string[];
  typeFiltered: string[];
}

interface Rig {
  memory: HindsightMemory;
  ledger: ForgetLedger;
  store: MemoryStateStore;
  endpoint: string;
  docs: Map<string, WireDoc>;
  requests: RecallRequest[];
  readback: TrustedSourceReadbackProvider;
  seed: (values: ReadonlyArray<{ doc: D4S1Doc; state: D4S1Doc['classification']; domains: DomainId[] }>) => void;
  mutateContent: (documentId: string, content: string) => void;
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
}

interface Tuple {
  bankId: string;
  endpoint: string;
  documentId: string;
}

interface Coverage {
  baselineCandidateRequired: number;
  baselineExposedRequired: number;
  supplementDiscoveredRequired: number;
  supplementVerifiedRequired: number;
  finalExposedRequired: number;
  newDiscoveredRequired: number;
  newExposedRequired: number;
  baselineRequiredPreserved: boolean;
  consumptionCoverageGain: number;
  baselineCandidateCount: number;
  baselineConsumedCount: number;
  discoveredCount: number;
  exposedCount: number;
}

interface CaseEvidence {
  id: string;
  query: string;
  purpose: string;
  required: string[];
  forbidden: string[];
  baseline: {
    status: string;
    route: string;
    textChars: number;
    candidateResultIds: string[];
    includedResultIds: string[];
    omittedResultIds: string[];
    candidateTuples: string[][];
    consumedTuples: string[][];
  };
  supplement: {
    status: string;
    stopReason: string | null;
    readStatus: string | null;
    sourceStopReason: string | null;
    queried: boolean;
    candidateCount: number;
    verifiedCount: number;
    fallbackCount: number;
    withheldCount: number;
    consumedCount: number;
    deduplicatedAgainstBaseline: number;
    addedTuples: string[][];
    finalTuples: string[][];
    discoveredTuples: string[][];
    verifiedTuples: string[][];
    withheld: Array<{ documentId: string; reason: string }>;
    fallback: Array<{ documentId: string; domainState: string; reason: string }>;
    budget: Record<string, number>;
  };
  coverage: Coverage;
  exposureBasis: 'core-envelope' | 's2-final-tuples';
  core: {
    run: boolean;
    reusedFrom: string | null;
    requestState: string | null;
    mappingState: string | null;
    actualEvidenceUsed: string | null;
    exposedTuples: string[][];
    requiredSerialized: Record<string, boolean>;
    dispatchedBodies: number;
    serializedBodies: number;
    gate: 'real-sourceEvidenceCurrent-pass' | 'real-sourceEvidenceCurrent-block' | 'not-run';
  } | null;
  rawGate: {
    tested: boolean;
    requestState: string | null;
    mappingState: string | null;
    blockReason: string | null;
    exposedTuples: string[][];
    dispatchedBodies: number;
    reason: string;
  } | null;
  verdicts: {
    baselinePreserved: boolean;
    querySensitive: boolean;
    newDiscovery: boolean;
    consumptionGain: boolean;
    guardsRetained: boolean;
  };
  requests: RecallRequest[];
  ranking: ReturnType<typeof rankingEvidence>;
}

const caseEvidence: CaseEvidence[] = [];

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function tuple(documentId: string, endpoint: string): Tuple {
  return { bankId, endpoint, documentId };
}

function tupleValue(value: Tuple): [string, string, string] {
  return [value.bankId, value.endpoint, value.documentId];
}

function tupleKey(value: Tuple): string {
  return JSON.stringify([value.bankId, value.endpoint, value.documentId]);
}

function hasTuple(values: readonly Tuple[], item: Tuple): boolean {
  return values.some((value) => tupleKey(value) === tupleKey(item));
}

function uniqueTuples(values: readonly Tuple[]): Tuple[] {
  return [...new Map(values.map((value) => [tupleKey(value), value])).values()];
}

function entryOf(docs: Map<string, WireDoc>, documentId: string): WireDoc {
  const entry = docs.get(documentId);
  if (!entry) throw new Error(`unknown synthetic document ${documentId}`);
  return entry;
}

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'r27-d4-s1-'));
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(tmpdir()) + '/')) throw new Error('synthetic files must stay under the system temporary directory');
  roots.push(path);
  return path;
}

function readbackFor(rig: Omit<Rig, 'readback'>): TrustedSourceReadbackProvider {
  return async (identity, context) => {
    if (context.signal.aborted) return null;
    const entry = rig.docs.get(identity.documentId);
    if (!entry || entry.bankId !== identity.bankId || entry.endpoint !== identity.endpoint) return null;
    if (rig.ledger.forgotten(bankId, rig.endpoint, entry.doc.documentId)) return null;
    return {
      bankId: entry.bankId,
      endpoint: entry.endpoint,
      documentId: entry.doc.documentId,
      content: entry.doc.content,
      sourceEpoch: rig.ledger.epoch(entry.bankId, entry.endpoint),
      sourceRevision: hash(entry.doc.content),
      sourceActor: entry.doc.actor,
      sourceKind: entry.doc.kind,
      sourceStatus: entry.doc.status,
    } satisfies TrustedSourceReadbackEvidence;
  };
}

async function createRig(): Promise<Rig> {
  const docs = new Map<string, WireDoc>();
  const requests: RecallRequest[] = [];
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
      const entry = [...docs.values()].find((item) => item.bankId === targetBank && item.doc.documentId === documentId);
      if (!entry) {
        request.resume();
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: 'not found' }));
        return;
      }
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: entry.doc.documentId,
        bank_id: entry.bankId,
        original_text: entry.doc.content,
        content_hash: hash(entry.doc.content),
        created_at: '2026-11-10T09:00:00.000Z',
        updated_at: '2026-11-10T09:00:00.000Z',
        memory_unit_count: 1,
        document_metadata: {
          source_actor: entry.doc.actor,
          kind: entry.doc.kind,
          status: entry.doc.status,
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
        query?: string;
        budget?: string;
        max_tokens?: number;
        max_source_facts_tokens?: number;
        types?: string[];
      };
      const query = body.query ?? '';
      const types = Array.isArray(body.types) ? body.types : null;
      const computed = responseForQuery(query, [...docs.values()].map((item) => item.doc), {
        ...(types ? { types } : {}),
        maxTokens: Number(body.max_tokens ?? 0),
        maxSourceFactsTokens: body.max_source_facts_tokens === undefined ? 0 : Number(body.max_source_facts_tokens),
      });
      requests.push({
        query,
        budget: body.budget ?? '',
        maxTokens: Number(body.max_tokens ?? 0),
        maxSourceFactsTokens: body.max_source_facts_tokens === undefined ? null : Number(body.max_source_facts_tokens),
        types,
        ranked: rankingEvidence(computed.ranked, 24),
        returned: computed.returned,
        typeFiltered: computed.typeFiltered,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(computed.response));
    });
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;
  const endpoint = 'http://127.0.0.1:' + address.port;
  currentEndpoint = endpoint;
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
      recall: { maxTokens: 900, budget: 'low', timeoutMs: 1500, types: [...stockTypes] },
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
  for (const doc of corpus()) {
    docs.set(doc.documentId, { doc, bankId, endpoint, sourceEpoch: 0 });
  }
  const rig: Rig = {
    memory, ledger, store, endpoint, docs, requests,
    readback: async () => null,
    seed: () => {},
    mutateContent: (documentId, content) => {
      const entry = docs.get(documentId);
      if (!entry) throw new Error(`unknown synthetic document ${documentId}`);
      entry.doc.content = content;
    },
  };
  rig.readback = readbackFor(rig);
  rig.seed = (values) => {
    for (const value of values) {
      const entry = docs.get(value.doc.documentId);
      if (!entry) throw new Error(`unknown synthetic document ${value.doc.documentId}`);
      entry.doc.classification = value.state;
      entry.doc.domains = value.domains;
      entry.sourceEpoch = ledger.epoch(bankId, endpoint);
    }
    const provider: SourceDomainEvidenceProvider = (targetBank, targetEndpoint, documentId) => {
      const entry = docs.get(documentId);
      if (!entry || entry.bankId !== targetBank || entry.endpoint !== targetEndpoint) return null;
      return {
        bankId: entry.bankId,
        endpoint: entry.endpoint,
        documentId: entry.doc.documentId,
        content: entry.doc.content,
        sourceEpoch: entry.sourceEpoch,
        sourceActor: entry.doc.actor,
        sourceKind: entry.doc.kind,
        sourceStatus: entry.doc.status,
      } satisfies SourceDomainEvidence;
    };
    const writer = new MemoryStateStore(store.path, { sourceDomainEvidence: provider });
    writers.push(writer);
    for (const value of values) {
      if (ledger.forgotten(bankId, endpoint, value.doc.documentId)) continue;
      writer.putSourceDomainClassification(classificationFor(
        value.doc,
        value.state,
        value.domains,
        value.doc.content,
        entryOf(docs, value.doc.documentId).sourceEpoch,
      ));
    }
    writer.close();
    writers.splice(writers.indexOf(writer), 1);
  };
  return rig;
}

function linkFor(entry: D4S1Doc, domainId: DomainId, excerpt: string, content: string, state: D4S1Doc['classification']): SourceDomainLinkInput {
  const start = content.indexOf(excerpt);
  if (start < 0) throw new Error(`synthetic evidence span is not present in ${entry.documentId}`);
  return {
    domainId,
    linkState: state === 'ambiguous' ? 'candidate' : 'confirmed',
    confidence: 0.95,
    ruleId: 'synthetic-approved-span',
    evidenceStart: start,
    evidenceEnd: start + excerpt.length,
    evidenceDigest: hash(excerpt),
    claimVerification: 'user_verified',
  };
}

function classificationFor(
  entry: D4S1Doc,
  state: D4S1Doc['classification'],
  domains: DomainId[],
  content: string,
  sourceEpoch: number,
): SourceDomainClassificationInput {
  return {
    bankId,
    endpoint: currentEndpoint,
    documentId: entry.documentId,
    state,
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: 'synthetic-d4s1-fixture/v1',
    confidence: state === 'assigned' ? 0.95 : null,
    sourceEpoch,
    sourceRevision: hash(content),
    classifiedAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    links: domains.map((domainId) => {
      const excerpt = entry.excerpts[domainId];
      if (!excerpt) throw new Error(`an assigned synthetic domain requires a source span: ${entry.documentId}/${domainId}`);
      return linkFor(entry, domainId, excerpt, content, state);
    }),
  };
}

function seedAll(rig: Rig): void {
  // A completed synthetic Forget: the tombstone stays, the remote-deletion task is settled.
  const forgetTask = rig.ledger.add({
    bankId,
    endpoint: rig.endpoint,
    documentId: 'source-forgotten-plan',
    reason: 'synthetic D4-S1 Forget fence',
  });
  if (forgetTask) rig.ledger.markDone(forgetTask.id);
  const values = [...rig.docs.values()]
    .filter((entry) => entry.doc.actor === 'user')
    .map((entry) => ({
      doc: entry.doc,
      state: entry.doc.classification,
      domains: entry.doc.classification === 'assigned' || entry.doc.classification === 'ambiguous' ? entry.doc.domains : [],
    }));
  rig.seed(values.map((value) => ({ ...value, doc: value.doc })));
  // Fix the classification identity after the epoch bump; the provider reads the live epoch.
  for (const value of values) {
    const entry = rig.docs.get(value.doc.documentId);
    if (entry) entry.sourceEpoch = rig.ledger.epoch(bankId, rig.endpoint);
  }
  // A classification written with the old body must become stale when the source changes.
  rig.mutateContent(
    'source-stale-cache',
    '缓存策略：首屏加载先读本地缓存，再请求远端；后来又加了一层校验。',
  );
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
    // The domain supplement deliberately asks for all source types. Stock Recall keeps its
    // configured allow-list; the ranked order and scores are otherwise identical.
    search: (text, options) => rig.memory.searchResultsDetailed(text, { ...options, types: [...supplementTypes] }),
    readbackProvider: rig.readback,
    getEvidenceEpoch: () => rig.memory.evidenceEpoch(),
    deliver: (block) => { delivered.push(block); },
  };
  const result = await consumeDomainRelevantMemory(input);
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

async function runCoreBlock(
  block: CoreMemoryConsumption,
  validate: (sources: readonly { bankId: string; endpoint: string; documentId: string }[], inspection?: unknown) => boolean,
): Promise<CoreRun> {
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
  persona.validateEvidenceForRequest = (sources, inspection) => validate(sources, inspection);
  const llm = new FakeLLM();
  llm.script(textReply('Synthetic D4-S1 answer.'));
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
    requireCompleteEvidence: true,
    worldEventTrust: (candidate, event) => candidate === world && event.type === 'core.message',
  });
  await core.start();
  try {
    await host!.pushEvent({
      type: 'core.message', source: 'core-world', dependencyOrigin: 'user-input',
      ts: new Date().toISOString(), text: 'Synthetic D4-S1 Core question.',
      meta: { text: 'Synthetic D4-S1 Core question.' },
    }, { trigger: 'flush' });
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const evidenceCount = api!.generationEvidence('main').length;
      if (evidenceCount > 0 && core.loop.getStatus().phase.state === 'idle') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    return {
      serializedBodies,
      dispatchedBodies,
      envelope: api!.generationEvidence('main').at(-1),
    };
  } finally {
    await core.stop();
  }
}

async function finalizeBlock(
  rig: Rig,
  result: Awaited<ReturnType<typeof consumeDomainRelevantMemory>>,
): Promise<{ block: CoreMemoryConsumption; complete: boolean; rawEvidenceCount: number }> {
  const evidence = result.text
    ? await rig.memory.evidenceForSegments(result.text, result.sourceSegments)
    : [];
  return {
    block: { text: result.text, evidence, sourceSegments: result.sourceSegments },
    complete: evidence.length === result.sourceSegments.length && evidence.length > 0,
    rawEvidenceCount: result.evidence.length,
  };
}

function baselineTuples(baseline: BaselineCapture, endpoint: string): Tuple[] {
  const trace = baseline.recall.trace;
  if (!trace) return [];
  return uniqueTuples([
    ...trace.format.sourceSegments.map((segment) => tuple(segment.documentId, endpoint)),
    ...trace.format.includedSourceDocumentIds.map((documentId) => tuple(documentId, endpoint)),
  ]);
}

function baselineCandidateTuples(baseline: BaselineCapture, endpoint: string): Tuple[] {
  const trace = baseline.recall.trace;
  if (!trace) return [];
  return uniqueTuples(trace.search.items
    .filter((item) => item.disposition === 'visible')
    .flatMap((item) => item.verifiedSources.map((source) => tuple(source.documentId, endpoint))));
}

function coverageOf(
  required: readonly Tuple[],
  baselineCandidates: readonly Tuple[],
  baselineConsumed: readonly Tuple[],
  discovered: readonly Tuple[],
  verified: readonly Tuple[],
  exposed: readonly Tuple[],
): Coverage {
  const requiredNew = required.filter((item) => !hasTuple(baselineCandidates, item) && !hasTuple(baselineConsumed, item));
  return {
    baselineCandidateRequired: required.filter((item) => hasTuple(baselineCandidates, item)).length,
    baselineExposedRequired: required.filter((item) => hasTuple(baselineConsumed, item)).length,
    supplementDiscoveredRequired: required.filter((item) => hasTuple(discovered, item)).length,
    supplementVerifiedRequired: required.filter((item) => hasTuple(verified, item)).length,
    finalExposedRequired: required.filter((item) => hasTuple(exposed, item)).length,
    newDiscoveredRequired: requiredNew.filter((item) => hasTuple(discovered, item)).length,
    newExposedRequired: requiredNew.filter((item) => hasTuple(exposed, item)).length,
    baselineRequiredPreserved: required.filter((item) => hasTuple(baselineConsumed, item))
      .every((item) => hasTuple(exposed, item)),
    consumptionCoverageGain: required.filter((item) =>
      hasTuple(baselineCandidates, item) && !hasTuple(baselineConsumed, item) && hasTuple(exposed, item)).length,
    baselineCandidateCount: baselineCandidates.length,
    baselineConsumedCount: baselineConsumed.length,
    discoveredCount: discovered.length,
    exposedCount: exposed.length,
  };
}

function exposedTuples(run: CoreRun | null, endpoint: string): Tuple[] {
  return uniqueTuples((run?.envelope?.exposedSources ?? []).map((source) => tuple(source.documentId, endpoint)));
}

function requiredSerialized(
  run: CoreRun | null,
  required: readonly D4S1Doc[],
  result: Awaited<ReturnType<typeof consumeDomainRelevantMemory>>,
): Record<string, boolean> {
  const body = run?.serializedBodies[0] ?? '';
  return Object.fromEntries(required.map((doc) => {
    const consumed = result.consumedSources.find((source) => source.identity.documentId === doc.documentId);
    const texts = consumed ? consumed.spans.map((span) => span.text) : Object.values(doc.excerpts);
    return [doc.documentId, texts.length > 0 && texts.every((text) => body.includes(text))];
  }));
}

function emitEvidence(name: string, value: unknown): void {
  const dir = process.env.D4_S1_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

interface CaseSpec {
  id: string;
  query: string;
  purpose: string;
  required: string[];
  forbidden?: string[];
  core: boolean;
  expectAbsent?: boolean;
  expectNewDiscovery?: boolean;
  expectConsumptionGain?: boolean;
  expectFallback?: boolean;
  rawGate?: boolean;
}

const CASES: CaseSpec[] = [
  {
    id: 'Q1',
    query: '请整理项目功能方面的重点决定和判断依据，并说明各自的适用范围和可以重复使用的做法，供本轮回答参考',
    purpose: '项目决定 + 判断依据；opinion 依据来源在 stock 类型过滤之外，另一条项目决定被 formatter 省略',
    required: ['source-project-checkpoint', 'source-values-basis'],
    core: true,
    expectNewDiscovery: true,
    expectConsumptionGain: true,
    rawGate: true,
  },
  {
    id: 'Q2',
    query: '我们定过哪些产品功能上的关键选择？判断理由是什么？哪些实现方式能反复使用，适用在什么范围？',
    purpose: '中文同义改写：产品/选择/理由/反复使用 对应同一组必要来源',
    required: ['source-project-checkpoint', 'source-values-basis'],
    core: true,
    expectNewDiscovery: true,
  },
  {
    id: 'Q3',
    query: '把项目里的决定和可复用的实现方法放在一起，各自的适用范围和入口分别是什么？',
    purpose: '跨 project-functional + skill-methods；多域来源与复核方法',
    required: ['source-multi-domain', 'source-skill-verify'],
    core: true,
  },
  {
    id: 'Q4',
    query: '那个还没归档的想法是什么？先不要下结论。',
    purpose: '合法未分类/歧义/待审回退：普通 Recall 仍可见，补充通道只报 fallback',
    required: ['source-unclassified-idea'],
    core: false,
    expectFallback: true,
  },
  {
    id: 'Q5',
    query: '和朋友相处遇到分歧时，我们怎么沟通？',
    purpose: '不同主题产生不同结果：user-relationship + social-context',
    required: ['source-relationship-repair', 'source-social-gathering'],
    core: false,
  },
  {
    id: 'Q6',
    query: '我为什么看重透明和诚实，而不是只看速度？',
    purpose: '合法空基线 + self-growth opinion 来源：stock 类型过滤后 absent，补充通道发现并进入 Core',
    required: ['source-values-basis'],
    core: true,
    expectAbsent: true,
    expectNewDiscovery: true,
  },
  {
    id: 'Q7',
    query: '旧迁移方案和缓存策略是怎么定的？还有那个成长计划。',
    purpose: 'Forget、过期 revision、Coo plan/reflection、混合来源负例',
    required: [],
    forbidden: ['source-forgotten-plan', 'coo-growth:plan-migration', 'source-mixed-user'],
    core: true,
  },
  {
    id: 'Q8',
    query: '我平时怎么安排早上和晚上的时间？',
    purpose: '不同主题产生不同结果：self-growth 作息来源',
    required: ['source-lifestyle-morning', 'source-lifestyle-walk'],
    core: false,
  },
];

async function runCase(spec: CaseSpec): Promise<CaseEvidence> {
  const rig = await createRig();
  seedAll(rig);
  const baseline = await recallBaseline(rig, spec.query);
  const { result, delivered } = await consume(rig, spec.query, baseline);
  expect(delivered).toHaveLength(1);
  expect(result.baseline.preserved).toBe(true);
  expect(result.text.startsWith(baseline.recall.text)).toBe(true);
  expect(result.supplement.queried).toBe(true);

  const required = spec.required.map((documentId) => tuple(documentId, rig.endpoint));
  const forbidden = (spec.forbidden ?? []).map((documentId) => tuple(documentId, rig.endpoint));
  const baselineCandidates = baselineCandidateTuples(baseline, rig.endpoint);
  const baselineConsumed = baselineTuples(baseline, rig.endpoint);
  const discovered = result.supplement.discoveredSourceTuples.map((item) => tuple(item.documentId, rig.endpoint));
  const verified = result.supplement.verifiedSourceTuples.map((item) => tuple(item.documentId, rig.endpoint));

  let coreRun: CoreRun | null = null;
  let coreGate: CaseEvidence['core'] = null;
  const finalize = await finalizeBlock(rig, result);
  if (spec.core) {
    expect(finalize.complete).toBe(true);
    coreRun = await runCoreBlock(finalize.block, (_sources, inspection) =>
      !!inspection && rig.memory.sourceEvidenceCurrent(inspection as never));
    expect(coreRun.dispatchedBodies).toHaveLength(result.text ? 1 : 0);
    expect(coreRun.envelope?.requestState).toBe(result.text ? 'sent' : 'unobserved');
    if (result.text) {
      expect(coreRun.envelope?.mappingState).toBe('complete');
      expect(coreRun.envelope?.actualEvidenceUsed).toBe('unknown');
    }
  }

  const finalTuples = result.finalSourceTuples.map((item) => tuple(item.documentId, rig.endpoint));
  const exposed = coreRun ? exposedTuples(coreRun, rig.endpoint) : finalTuples;
  const exposureBasis: CaseEvidence['exposureBasis'] = coreRun ? 'core-envelope' : 's2-final-tuples';
  const coverage = coverageOf(required, baselineCandidates, baselineConsumed, discovered, verified, exposed);
  const requiredDocs = spec.required.map((documentId) => rig.docs.get(documentId)!.doc);
  const requiredSerializedMap = coreRun ? requiredSerialized(coreRun, requiredDocs, result) : {};
  if (coreRun) {
    for (const documentId of spec.required) {
      expect(exposed.some((item) => item.documentId === documentId)).toBe(true);
    }
    for (const value of Object.values(requiredSerializedMap)) {
      expect(value).toBe(true);
    }
  }

  let rawGate: CaseEvidence['rawGate'] = null;
  if (spec.rawGate) {
    const rawRun = await runCoreBlock(
      { text: result.text, evidence: result.evidence, sourceSegments: result.sourceSegments },
      (_sources, inspection) => !!inspection && rig.memory.sourceEvidenceCurrent(inspection as never),
    );
    rawGate = {
      tested: true,
      requestState: rawRun.envelope?.requestState ?? null,
      mappingState: rawRun.envelope?.mappingState ?? null,
      blockReason: rawRun.envelope?.requestBlockReason ?? null,
      exposedTuples: exposedTuples(rawRun, rig.endpoint).map(tupleValue),
      dispatchedBodies: rawRun.dispatchedBodies.length,
      reason: 'S2-built attachments have no HindsightMemory sourceProof/readBackProofs; the real Persona gate must be finalized through evidenceForSegments',
    };
    expect(rawRun.dispatchedBodies).toHaveLength(0);
    expect(rawRun.envelope?.requestState).toBe('unobserved');
  }

  for (const item of forbidden) {
    expect(hasTuple(exposed, item)).toBe(false);
    expect(result.text.includes(rig.docs.get(item.documentId)!.doc.content)).toBe(false);
  }
  if (spec.expectAbsent) expect(baseline.recall.status).toBe('absent');
  if (spec.expectNewDiscovery) {
    expect(coverage.newDiscoveredRequired).toBeGreaterThanOrEqual(1);
    if (coreRun) expect(coverage.newExposedRequired).toBeGreaterThanOrEqual(1);
  }
  if (spec.expectConsumptionGain) {
    expect(coverage.consumptionCoverageGain).toBeGreaterThanOrEqual(1);
  }
  if (spec.expectFallback) {
    expect(result.supplement.fallback.length).toBeGreaterThanOrEqual(1);
    expect(result.supplement.consumedCount).toBe(0);
  }
  if (spec.core) {
    coreGate = {
      run: true,
      reusedFrom: null,
      requestState: coreRun?.envelope?.requestState ?? null,
      mappingState: coreRun?.envelope?.mappingState ?? null,
      actualEvidenceUsed: coreRun?.envelope?.actualEvidenceUsed ?? null,
      exposedTuples: exposed.map(tupleValue),
      requiredSerialized: requiredSerializedMap,
      dispatchedBodies: coreRun?.dispatchedBodies.length ?? 0,
      serializedBodies: coreRun?.serializedBodies.length ?? 0,
      gate: 'real-sourceEvidenceCurrent-pass',
    };
  }

  const evidence: CaseEvidence = {
    id: spec.id,
    query: spec.query,
    purpose: spec.purpose,
    required: spec.required,
    forbidden: spec.forbidden ?? [],
    baseline: {
      status: baseline.recall.status,
      route: baseline.recall.route,
      textChars: baseline.recall.text.length,
      candidateResultIds: baseline.recall.trace?.format.candidateResultIds ?? [],
      includedResultIds: baseline.recall.trace?.format.includedResultIds ?? [],
      omittedResultIds: baseline.recall.trace?.format.omittedResultIds ?? [],
      candidateTuples: baselineCandidates.map(tupleValue),
      consumedTuples: baselineConsumed.map(tupleValue),
    },
    supplement: {
      status: result.status,
      stopReason: result.stopReason,
      readStatus: result.supplement.readStatus,
      sourceStopReason: result.supplement.sourceStopReason,
      queried: result.supplement.queried,
      candidateCount: result.supplement.candidateCount,
      verifiedCount: result.supplement.verifiedCount,
      fallbackCount: result.supplement.fallbackCount,
      withheldCount: result.supplement.withheldCount,
      consumedCount: result.supplement.consumedCount,
      deduplicatedAgainstBaseline: result.supplement.deduplicatedAgainstBaseline,
      addedTuples: result.addedSourceTuples.map(tupleValue),
      finalTuples: result.finalSourceTuples.map(tupleValue),
      discoveredTuples: discovered.map(tupleValue),
      verifiedTuples: verified.map(tupleValue),
      withheld: result.supplement.withheld.map((item) => ({ documentId: item.identity.documentId, reason: item.reason })),
      fallback: result.supplement.fallback.map((item) => ({
        documentId: item.identity.documentId,
        domainState: String(item.domainState),
        reason: item.reason,
      })),
      budget: {
        queryCalls: result.supplement.budget.queryCalls,
        readbackCalls: result.supplement.budget.readbackCalls,
        finalReadbackCalls: result.supplement.budget.finalReadbackCalls,
        supplementChars: result.supplement.budget.supplementChars,
        finalContextChars: result.supplement.budget.finalContextChars,
        elapsedMs: result.supplement.budget.elapsedMs,
      },
    },
    coverage,
    exposureBasis,
    core: coreGate,
    rawGate,
    verdicts: {
      baselinePreserved: result.baseline.preserved && result.text.startsWith(baseline.recall.text),
      querySensitive: result.supplement.queried,
      newDiscovery: coverage.newDiscoveredRequired > 0,
      consumptionGain: coverage.consumptionCoverageGain > 0,
      guardsRetained: forbidden.every((item) => !hasTuple(exposed, item)),
    },
    requests: rig.requests,
    ranking: rig.requests.at(-1)?.ranked ?? [],
  };
  caseEvidence.push(evidence);
  emitEvidence(`case-${spec.id}.json`, evidence);
  console.log(`D4S1_CASE=${JSON.stringify({
    id: spec.id,
    baselineStatus: evidence.baseline.status,
    baselineCandidates: evidence.coverage.baselineCandidateCount,
    baselineConsumed: evidence.coverage.baselineConsumedCount,
    supplementStatus: evidence.supplement.status,
    discovered: evidence.coverage.discoveredCount,
    consumed: evidence.supplement.consumedCount,
    coverage: evidence.coverage,
    core: evidence.core ? { requestState: evidence.core.requestState, exposed: evidence.core.exposedTuples.length } : null,
  })}`);
  return evidence;
}

afterEach(async () => {
  for (const writer of writers.splice(0)) {
    try { writer.close(); } catch { /* already closed */ }
  }
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  emitEvidence('same-source-regression-matrix.json', {
    layer: 'D4_S1_SAME_SOURCE_QUERY_SENSITIVE_SYNTHETIC',
    bankId,
    stockTypes: [...stockTypes],
    supplementTypes: [...supplementTypes],
    cases: caseEvidence,
  });
});

describe('D4-S1 same-source query-sensitive regression', () => {
  it('Q1 finds a necessary opinion source outside the stock type filter and a formatter-omitted project source, then exposes both through the real Core gate', async () => {
    const evidence = await runCase(CASES[0]!);
    expect(evidence.baseline.status).toBe('found');
    expect(evidence.coverage.baselineCandidateRequired).toBeGreaterThanOrEqual(1);
    expect(evidence.coverage.baselineExposedRequired).toBeLessThan(evidence.coverage.baselineCandidateRequired);
    expect(evidence.coverage.newDiscoveredRequired).toBeGreaterThanOrEqual(1);
    expect(evidence.coverage.newExposedRequired).toBeGreaterThanOrEqual(1);
    expect(evidence.core?.requestState).toBe('sent');
  }, 60000);

  it('Q2 Chinese synonym rewrite preserves the same necessary sources', async () => {
    const evidence = await runCase(CASES[1]!);
    expect(evidence.coverage.supplementDiscoveredRequired).toBe(2);
    expect(evidence.coverage.finalExposedRequired).toBe(2);
    expect(evidence.verdicts.baselinePreserved).toBe(true);
  }, 60000);

  it('Q3 cross-domain project + skill query keeps the multi-domain source and the reuse method', async () => {
    const evidence = await runCase(CASES[2]!);
    expect(evidence.coverage.baselineCandidateRequired).toBe(2);
    expect(evidence.core?.requestState).toBe('sent');
    expect(evidence.core?.exposedTuples.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('Q4 keeps unclassified, ambiguous and pending sources in ordinary Recall and reports fallback only', async () => {
    const evidence = await runCase(CASES[3]!);
    expect(evidence.baseline.status).toBe('found');
    expect(evidence.supplement.fallback.length).toBe(3);
    expect(evidence.supplement.consumedCount).toBe(0);
  }, 60000);

  it('Q5 different topic selects relationship and social sources instead of project sources', async () => {
    const evidence = await runCase(CASES[4]!);
    const ids = evidence.baseline.consumedTuples.map((item) => item[2]);
    expect(ids).toContain('source-relationship-repair');
    expect(ids).toContain('source-social-gathering');
    expect(ids).not.toContain('source-project-gray');
  }, 60000);

  it('Q6 legal absent baseline discovers an opinion source through the supplement and exposes it to Core', async () => {
    const evidence = await runCase(CASES[5]!);
    expect(evidence.baseline.status).toBe('absent');
    expect(evidence.supplement.status).toBe('supplemented');
    expect(evidence.coverage.newDiscoveredRequired).toBe(1);
    expect(evidence.coverage.newExposedRequired).toBe(1);
    expect(evidence.core?.requestState).toBe('sent');
  }, 60000);

  it('Q7 blocks Forget, stale revision, Coo plan/reflection and mixed-source negatives from Core', async () => {
    const evidence = await runCase(CASES[6]!);
    expect(evidence.supplement.consumedCount).toBe(0);
    expect(evidence.supplement.withheld.some((item) => item.documentId === 'source-stale-cache'
      && item.reason === 'revision_mismatch')).toBe(true);
    expect(evidence.core?.requestState).toBe('sent');
    expect(evidence.verdicts.guardsRetained).toBe(true);
  }, 60000);

  it('Q8 different topic selects the two lifestyle/rhythm sources', async () => {
    const evidence = await runCase(CASES[7]!);
    expect(evidence.coverage.baselineExposedRequired).toBe(2);
    expect(evidence.supplement.consumedCount).toBe(0);
  }, 60000);

  it('keeps query-sensitive rankings distinct and synonym rankings aligned', () => {
    const byId = new Map(caseEvidence.map((item) => [item.id, item]));
    expect(byId.size).toBe(8);
    const top = (id: string) => (byId.get(id)?.requests.at(-1)?.ranked ?? []).slice(0, 8).map((entry) => entry.documentId);
    const q1 = top('Q1');
    const q2 = top('Q2');
    const q5 = top('Q5');
    const q8 = top('Q8');
    const overlap = (left: string[], right: string[]) => left.filter((item) => right.includes(item)).length;
    expect(overlap(q1, q2)).toBeGreaterThanOrEqual(2);
    expect(overlap(q1, q5)).toBeLessThanOrEqual(1);
    expect(overlap(q1, q8)).toBeLessThanOrEqual(1);
    const q2Evidence = byId.get('Q2')!;
    expect(q2Evidence.coverage.supplementDiscoveredRequired).toBe(2);
    emitEvidence('query-sensitivity-summary.json', {
      top8: { Q1: q1, Q2: q2, Q5: q5, Q8: q8 },
      overlap: { Q1_Q2: overlap(q1, q2), Q1_Q5: overlap(q1, q5), Q1_Q8: overlap(q1, q8) },
      verdict: 'QUERY_SENSITIVE_SYNTHETIC',
    });
  });
});
