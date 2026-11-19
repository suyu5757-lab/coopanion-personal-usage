import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
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
const at = '2026-11-10T06:00:00.000Z';
const bankId = 'bank-d3b-s2-synthetic';

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

interface Rig {
  memory: HindsightMemory;
  ledger: ForgetLedger;
  store: MemoryStateStore;
  endpoint: string;
  sources: Map<string, SyntheticSource>;
  requestedQueries: string[];
  readbackCalls: number;
  readback: TrustedSourceReadbackProvider;
  setResponder: (responder: (query: string) => RecallResponse) => void;
  setDelay: (delay: (query: string) => number) => void;
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
  const path = mkdtempSync(join(tmpdir(), 'r27-d3b-s2-'));
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
  overrides: Partial<SyntheticSource> = {},
): SyntheticSource {
  return {
    bankId,
    endpoint,
    documentId,
    content,
    sourceEpoch: 0,
    sourceActor: 'user',
    sourceKind: 'event',
    sourceStatus: 'completed',
    excerpts,
    ...overrides,
  };
}

function factFor(factId: string, entry: SyntheticSource): SourceFact {
  return {
    id: factId,
    text: entry.content,
    type: 'world',
    document_id: entry.documentId,
    occurred_start: at,
    metadata: {
      source_actor: entry.sourceActor,
      kind: entry.sourceKind,
      status: entry.sourceStatus,
    },
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

function mixedCooResponse(): RecallResponse {
  return {
    results: [{
      id: 'observation-mixed',
      text: 'COO_CANDIDATE_PLAN_ONLY',
      type: 'observation',
      document_id: 'observation:mixed',
      source_fact_ids: ['fact-mixed-user', 'fact-coo-candidate'],
    }],
    source_facts: {
      'fact-mixed-user': {
        id: 'fact-mixed-user',
        text: 'The user described a project decision.',
        type: 'world',
        document_id: 'source-mixed-user',
        occurred_start: at,
        metadata: { source_actor: 'user', kind: 'event', status: 'completed' },
      },
      'fact-coo-candidate': {
        id: 'fact-coo-candidate',
        text: 'COO_CANDIDATE_PLAN_ONLY',
        type: 'memory',
        document_id: 'coo-growth:synthetic-plan',
        occurred_start: at,
        metadata: { source_actor: 'coo', kind: 'plan', status: 'candidate' },
      },
    },
    source_facts_truncated: false,
  };
}

function linkFor(entry: SyntheticSource, domainId: DomainId, excerpt: string): SourceDomainLinkInput {
  const start = entry.content.indexOf(excerpt);
  if (start < 0) throw new Error('synthetic evidence span is not present in the source');
  const end = start + excerpt.length;
  return {
    domainId,
    linkState: 'confirmed',
    confidence: 0.95,
    ruleId: 'synthetic-approved-span',
    evidenceStart: start,
    evidenceEnd: end,
    evidenceDigest: hash(excerpt),
    claimVerification: 'user_verified',
  };
}

function classificationFor(
  entry: SyntheticSource,
  state: 'assigned' | 'unclassified' | 'ambiguous' | 'pending_review',
  domains: DomainId[] = [],
): SourceDomainClassificationInput {
  let links: SourceDomainLinkInput[] = [];
  if (state === 'assigned') {
    links = domains.map((domainId) => {
      const excerpt = entry.excerpts[domainId];
      if (!excerpt) throw new Error('an assigned synthetic domain requires a source span');
      return linkFor(entry, domainId, excerpt);
    });
  } else if (state === 'ambiguous') {
    links = [{
      domainId: 'project-functional',
      linkState: 'candidate',
      confidence: 0.5,
      ruleId: 'synthetic-unconfirmed',
      evidenceStart: null,
      evidenceEnd: null,
      evidenceDigest: null,
      claimVerification: 'external_unverified',
    }];
  }
  return {
    bankId: entry.bankId,
    endpoint: entry.endpoint,
    documentId: entry.documentId,
    state,
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: 'synthetic-consume-fixture/v1',
    confidence: state === 'assigned' ? 0.95 : null,
    sourceEpoch: entry.sourceEpoch,
    sourceRevision: hash(entry.content),
    classifiedAt: at,
    updatedAt: at,
    links,
  };
}

async function createRig(): Promise<Rig> {
  const entries = new Map<string, SyntheticSource>();
  const requestedQueries: string[] = [];
  let responder: (query: string) => RecallResponse = () => ({ results: [], source_facts: {}, source_facts_truncated: false });
  let delay: (query: string) => number = () => 0;
  let readbackCalls = 0;
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
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query?: string };
      const query = body.query ?? '';
      requestedQueries.push(query);
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(responder(query)));
      };
      const wait = delay(query);
      if (wait > 0) setTimeout(send, wait);
      else send();
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
      recall: { maxTokens: 900, budget: 'low', timeoutMs: 1200, types: ['observation', 'world', 'experience'] },
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
    readbackCalls += 1;
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
        bankId: entry.bankId,
        endpoint: entry.endpoint,
        documentId: entry.documentId,
        content: entry.content,
        sourceEpoch: entry.sourceEpoch,
        sourceActor: entry.sourceActor,
        sourceKind: entry.sourceKind,
        sourceStatus: entry.sourceStatus,
      } satisfies SourceDomainEvidence : null;
    };
    const writer = new MemoryStateStore(store.path, { sourceDomainEvidence: provider });
    writers.push(writer);
    for (const value of values) writer.putSourceDomainClassification(classificationFor(value.source, value.state, value.domains));
    writer.close();
    writers.splice(writers.indexOf(writer), 1);
  };
  return {
    memory,
    ledger,
    store,
    endpoint,
    sources: entries,
    requestedQueries,
    get readbackCalls() { return readbackCalls; },
    readback,
    setResponder: (value) => { responder = value; },
    setDelay: (value) => { delay = value; },
    seed,
  };
}

async function recallBaseline(rig: Rig, query: string): Promise<BaselineCapture> {
  const recall = await rig.memory.recallForTurn(query, { captureTrace: true, activationEnabled: false });
  const segments = recall.trace?.format.sourceSegments ?? [];
  const evidence = recall.text && segments.length > 0
    ? await rig.memory.evidenceForSegments(recall.text, segments)
    : [];
  return { recall, evidence };
}

async function consume(
  rig: Rig,
  query: string,
  baseline: BaselineCapture,
  overrides: Partial<DomainRelevantConsumeInput> = {},
): Promise<ConsumptionCapture> {
  const delivered: CoreMemoryConsumption[] = [];
  const result = await consumeDomainRelevantMemory({
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
    ...overrides,
  });
  return { result, delivered };
}

function containsTuple(
  values: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
  expected: { bankId: string; endpoint: string; documentId: string },
): boolean {
  return values.some((item) => item.bankId === expected.bankId
    && item.endpoint === expected.endpoint
    && item.documentId === expected.documentId);
}

function requiredCoverage(
  required: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
  baseline: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
  final: ReadonlyArray<{ bankId: string; endpoint: string; documentId: string }>,
): { baselineRequiredConsumed: number; finalRequiredConsumed: number; newRequiredCovered: number; baselineRequiredPreserved: boolean } {
  const baselineRequired = required.filter((item) => containsTuple(baseline, item)).length;
  const finalRequired = required.filter((item) => containsTuple(final, item)).length;
  return {
    baselineRequiredConsumed: baselineRequired,
    finalRequiredConsumed: finalRequired,
    newRequiredCovered: finalRequired - baselineRequired,
    baselineRequiredPreserved: required.every((item) => !containsTuple(baseline, item) || containsTuple(final, item)),
  };
}

const GAIN_QUERY = '请整理项目功能方面的重点决定以及可以重复使用的实现方法，并列出各自适用范围和判断依据，供本轮回答使用';

function noiseSources(endpoint: string): SyntheticSource[] {
  return Array.from({ length: 11 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return source(
      endpoint,
      `source-noise-${number}`,
      `Synthetic project note ${number}: the user recorded a routine project preference that remains visible in baseline recall.`,
      { 'project-functional': 'routine project preference' },
    );
  });
}

function twelveNoiseSources(endpoint: string): SyntheticSource[] {
  return [
    ...noiseSources(endpoint),
    source(
      endpoint,
      'source-noise-12',
      'Synthetic project note 12: the user recorded another routine project preference that remains visible in baseline recall.',
      { 'project-functional': 'another routine project preference' },
    ),
  ];
}

function gainSources(endpoint: string): {
  ordered: SyntheticSource[];
  earlyShared: SyntheticSource;
  lateShared: SyntheticSource;
  lateProject: SyntheticSource;
} {
  const noise = noiseSources(endpoint);
  const earlyShared = source(
    endpoint,
    'source-early-shared',
    'Project and method note: a verified source can carry both a project decision and a reusable method span.',
    {
      'project-functional': 'a verified source can carry',
      'skill-methods': 'a reusable method span',
    },
  );
  const lateShared = source(
    endpoint,
    'source-late-shared',
    'Project and method: when a source readback changes, verify the new digest before presenting the span.',
    {
      'project-functional': 'when a source readback changes',
      'skill-methods': 'verify the new digest before presenting',
    },
  );
  const lateProject = source(
    endpoint,
    'source-late-project',
    'Project decision: compare the fresh source digest before using a remembered implementation choice.',
    { 'project-functional': 'compare the fresh source digest' },
  );
  const ordered = [
    ...noise.slice(0, 2),
    earlyShared,
    ...noise.slice(2),
    lateShared,
    lateProject,
  ];
  return { ordered, earlyShared, lateShared, lateProject };
}

afterEach(async () => {
  for (const writer of writers.splice(0)) {
    try { writer.close(); } catch { /* already closed */ }
  }
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('opt-in domain relevant Core consumption', () => {
  it('is an exact no-op when the explicit switch is off', async () => {
    const delivered: CoreMemoryConsumption[] = [];
    const result = await consumeDomainRelevantMemory({
      enabled: false,
      query: '项目决策',
      bankId: 'bank-synthetic',
      endpoint: 'http://synthetic.invalid',
      store: {} as MemoryStateStore,
      baseline: { text: '[memory] Baseline recall text stays exactly as supplied.', status: 'found' },
      search: () => { throw new Error('the supplement search must not run while disabled'); },
      readbackProvider: async () => { throw new Error('the supplement readback must not run while disabled'); },
      getEvidenceEpoch: () => { throw new Error('the epoch must not be read while disabled'); },
      deliver: (block) => { delivered.push(block); },
    });

    expect(result.mode).toBe('disabled');
    expect(result.status).toBe('baseline_only');
    expect(result.text).toBe('[memory] Baseline recall text stays exactly as supplied.');
    expect(result.evidence).toEqual([]);
    expect(result.supplement.queried).toBe(false);
    expect(result.supplement.budget.queryCalls).toBe(0);
    expect(result.supplement.budget.readbackCalls).toBe(0);
    expect(result.supplement.budget.finalReadbackCalls).toBe(0);
    expect(result.deliveries).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe(result.text);
    expect(delivered[0]?.evidence).toEqual([]);
    console.log('D3B_S2_DEFAULT_OFF=' + JSON.stringify({
      mode: result.mode,
      status: result.status,
      deliveredTextChars: result.text.length,
      queryCalls: result.supplement.budget.queryCalls,
      readbackCalls: result.supplement.budget.readbackCalls,
      deliveries: result.deliveries,
    }));
  });

  it('does not start a supplement when the baseline Recall is fenced', async () => {
    const delivered: CoreMemoryConsumption[] = [];
    const result = await consumeDomainRelevantMemory({
      enabled: true,
      query: '项目决策',
      bankId: 'bank-synthetic',
      endpoint: 'http://synthetic.invalid',
      store: {} as MemoryStateStore,
      baseline: { text: '[memory] fenced baseline source_id:source-fenced', status: 'fenced' },
      search: () => { throw new Error('a fenced baseline must not start a supplement query'); },
      getEvidenceEpoch: () => 'synthetic-epoch',
      deliver: (block) => { delivered.push(block); },
    });

    expect(result.status).toBe('fenced');
    expect(result.stopReason).toBe('baseline_fenced');
    expect(result.supplement.queried).toBe(false);
    expect(result.supplement.budget.queryCalls).toBe(0);
    expect(result.text).toBe('[memory] fenced baseline source_id:source-fenced');
    expect(result.consumedSources).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe(result.text);
    console.log('D3B_S2_FENCED_BASELINE=' + JSON.stringify({
      status: result.status,
      stopReason: result.stopReason,
      queried: result.supplement.queried,
      queryCalls: result.supplement.budget.queryCalls,
      deliveries: result.deliveries,
    }));
  });

  it('appends verified cross-domain sources that baseline formatting omitted, without changing baseline text', async () => {
    const rig = await createRig();
    const { ordered, earlyShared, lateShared, lateProject } = gainSources(rig.endpoint);
    rig.seed(ordered.map((entry) => ({ source: entry, state: 'assigned' as const, domains: Object.keys(entry.excerpts) as DomainId[] })));
    rig.setResponder(() => responseForDocs(ordered));

    const baselineStartedAt = Date.now();
    const baseline = await recallBaseline(rig, GAIN_QUERY);
    const baselineElapsedMs = Math.max(0, Date.now() - baselineStartedAt);
    expect(baseline.recall.route).toBe('standard');
    expect(baseline.recall.status).toBe('found');
    expect(baseline.recall.trace?.format.includedResultIds).toHaveLength(12);
    expect(baseline.recall.trace?.format.omittedResultIds).toHaveLength(2);
    expect(baseline.recall.text).not.toContain(lateShared.content);
    expect(baseline.recall.text).not.toContain(lateProject.content);
    expect(baseline.recall.text).toContain(earlyShared.content);

    const { result, delivered } = await consume(rig, GAIN_QUERY, baseline);
    const required = [lateShared, lateProject].map((entry) => ({ bankId: entry.bankId, endpoint: entry.endpoint, documentId: entry.documentId }));
    const coverage = requiredCoverage(required, result.baseline.sourceTuples, result.finalSourceTuples);

    expect(result.status).toBe('supplemented');
    expect(result.supplement.queried).toBe(true);
    expect(result.supplement.readStatus).toBe('complete');
    expect(result.supplement.candidateCount).toBe(14);
    expect(result.supplement.verifiedCount).toBe(14);
    expect(result.supplement.deduplicatedAgainstBaseline).toBe(12);
    expect(result.supplement.consumedCount).toBe(2);
    expect(result.addedSourceTuples.map((item) => item.documentId)).toEqual(['source-late-shared', 'source-late-project']);
    expect(result.text.startsWith(baseline.recall.text)).toBe(true);
    expect(result.baseline.preserved).toBe(true);
    expect(result.text).toContain(lateShared.excerpts['project-functional']!);
    expect(result.text).toContain(lateShared.excerpts['skill-methods']!);
    expect(result.text).toContain(lateProject.excerpts['project-functional']!);
    expect(result.text.length).toBeGreaterThan(baseline.recall.text.length);
    expect(coverage.baselineRequiredConsumed).toBe(0);
    expect(coverage.finalRequiredConsumed).toBe(2);
    expect(coverage.newRequiredCovered).toBe(2);
    expect(coverage.baselineRequiredPreserved).toBe(true);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe(result.text);
    expect(delivered[0]?.evidence).toHaveLength(baseline.evidence.length + 3);
    const supplementAttachments = delivered[0]!.evidence.slice(baseline.evidence.length);
    expect(supplementAttachments).toHaveLength(3);
    for (const attachment of supplementAttachments) {
      expect(attachment.validationStatus).toBe('validated');
      expect(attachment.revisionState).toBe('current');
      expect(hash(result.text.slice(attachment.segment.start, attachment.segment.end))).toBe(attachment.segment.digest);
    }
    expect(result.consumedSources.map((item) => item.identity.documentId)).not.toContain('source-early-shared');
    const lateSharedConsumed = result.consumedSources.find((item) => item.identity.documentId === 'source-late-shared');
    expect(lateSharedConsumed?.domains).toEqual(['project-functional', 'skill-methods']);
    expect(lateSharedConsumed?.spans).toHaveLength(2);
    // Consumed spans index the exact Provider-facing block, not the labelled receipt view.
    const coreText = result.coreText ?? '';
    for (const source of result.consumedSources) {
      for (const span of source.spans) {
        expect(coreText.slice(span.start, span.end)).toBe(span.text);
        expect(hash(span.text)).toBe(span.digest);
      }
    }
    expect(new Set(result.finalSourceTuples.map((item) => item.documentId)).size).toBe(14);
    expect(result.supplement.budget.queryCalls).toBe(1);
    expect(result.supplement.budget.readbackCalls).toBe(14);
    expect(result.supplement.budget.finalReadbackCalls).toBe(2);

    const after = await recallBaseline(rig, GAIN_QUERY);
    expect(after.recall.text).toBe(baseline.recall.text);
    expect(after.recall.trace?.format.includedResultIds).toEqual(baseline.recall.trace?.format.includedResultIds);
    expect(after.recall.trace?.format.omittedResultIds).toEqual(baseline.recall.trace?.format.omittedResultIds);
    expect(after.recall.trace?.maxTokens).toBe(baseline.recall.trace?.maxTokens);
    expect(after.recall.trace?.maxChars).toBe(baseline.recall.trace?.maxChars);

    console.log('D3B_S2_GAIN_MATRIX=' + JSON.stringify({
      query: GAIN_QUERY,
      route: baseline.recall.route,
      requiredSourceTuples: required.map(tuple),
      baseline: {
        status: baseline.recall.status,
        textChars: baseline.recall.text.length,
        elapsedMs: baselineElapsedMs,
        candidateResultIds: baseline.recall.trace?.format.candidateResultIds,
        includedResultIds: baseline.recall.trace?.format.includedResultIds,
        omittedResultIds: baseline.recall.trace?.format.omittedResultIds,
        sourceTuples: result.baseline.sourceTuples.map(tuple),
        requiredConsumed: coverage.baselineRequiredConsumed,
        evidenceAttachments: baseline.evidence.length,
        maxTokens: baseline.recall.trace?.maxTokens,
        maxChars: baseline.recall.trace?.maxChars,
      },
      supplement: {
        status: result.supplement.readStatus,
        stopReason: result.supplement.stopReason,
        candidateCount: result.supplement.candidateCount,
        verifiedCount: result.supplement.verifiedCount,
        fallbackCount: result.supplement.fallbackCount,
        withheldCount: result.supplement.withheldCount,
        deduplicatedAgainstBaseline: result.supplement.deduplicatedAgainstBaseline,
        consumedCount: result.supplement.consumedCount,
        readbackCalls: result.supplement.budget.readbackCalls,
        finalReadbackCalls: result.supplement.budget.finalReadbackCalls,
        supplementChars: result.supplement.budget.supplementChars,
        maxSupplementChars: result.supplement.budget.maxSupplementChars,
        elapsedMs: result.supplement.budget.elapsedMs,
      },
      final: {
        status: result.status,
        textChars: result.text.length,
        sourceTuples: result.finalSourceTuples.map(tuple),
        addedSourceTuples: result.addedSourceTuples.map(tuple),
        requiredConsumed: coverage.finalRequiredConsumed,
        newRequiredCovered: coverage.newRequiredCovered,
        baselineRequiredPreserved: coverage.baselineRequiredPreserved,
        evidenceAttachments: delivered[0]?.evidence.length ?? 0,
        elapsedMs: result.elapsedMs,
      },
      consumedSources: result.consumedSources.map((item) => ({
        tuple: tuple(item.identity),
        domains: item.domains,
        contentDigest: item.contentDigest,
        spans: item.spans.map((span) => ({
          start: span.start,
          end: span.end,
          digest: span.digest,
          text: span.text,
          visible: result.text.slice(span.start, span.end),
          domains: span.domains,
        })),
      })),
      ordinaryRecallPreserved: after.recall.text === baseline.recall.text,
    }));
  });

  it('keeps unclassified sources visible through ordinary Recall and never manufactures domain evidence', async () => {
    const rig = await createRig();
    const unclassified = source(rig.endpoint, 'source-unclassified', 'The user described an important but unclassified project decision.', {});
    const ambiguous = source(rig.endpoint, 'source-ambiguous', 'The user described a project fact with uncertain domain labels.', {});
    const pending = source(rig.endpoint, 'source-pending', 'The user described a project fact awaiting domain review.', {});
    const ordered = [unclassified, ambiguous, pending];
    rig.seed([
      { source: unclassified, state: 'unclassified' },
      { source: ambiguous, state: 'ambiguous' },
      { source: pending, state: 'pending_review' },
    ]);
    rig.setResponder(() => responseForDocs(ordered));

    const query = '列出尚未整理领域但仍重要的用户决定，并说明这些内容是否仍然可以安全使用';
    const baseline = await recallBaseline(rig, query);
    expect(baseline.recall.status).toBe('found');
    expect(baseline.recall.text).toContain(unclassified.content);
    expect(baseline.recall.text).toContain(ambiguous.content);
    expect(baseline.recall.text).toContain(pending.content);

    const { result, delivered } = await consume(rig, query, baseline);
    expect(result.status).toBe('baseline_only');
    expect(result.supplement.readStatus).toBe('incomplete');
    expect(result.supplement.verifiedCount).toBe(0);
    expect(result.supplement.fallbackCount).toBe(3);
    expect(result.supplement.consumedCount).toBe(0);
    expect(result.consumedSources).toEqual([]);
    expect(result.addedSourceTuples).toEqual([]);
    expect(result.text).toBe(baseline.recall.text);
    expect(result.baseline.preserved).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe(baseline.recall.text);
    expect(delivered[0]?.evidence).toEqual(baseline.evidence);
    expect(result.supplement.fallback.map((item) => [item.identity.documentId, item.domainState, item.reason])).toEqual([
      ['source-unclassified', 'unclassified', 'classification_unassigned'],
      ['source-ambiguous', 'ambiguous', 'classification_unassigned'],
      ['source-pending', 'pending_review', 'classification_unassigned'],
    ]);

    console.log('D3B_S2_UNCLASSIFIED_CONSUMPTION=' + JSON.stringify({
      baselineSourceIds: baseline.recall.trace?.format.includedSourceDocumentIds,
      baselineTextPreserved: result.text === baseline.recall.text,
      supplementStatus: result.supplement.readStatus,
      fallback: result.supplement.fallback.map((item) => ({
        tuple: tuple(item.identity),
        domainState: item.domainState,
        reason: item.reason,
      })),
      consumedSourceIds: result.consumedSources.map((item) => item.identity.documentId),
      deliveries: result.deliveries,
    }));
  });

  it('does not pass a mixed user and Coo candidate observation into Core consumption', async () => {
    const rig = await createRig();
    rig.setResponder(() => mixedCooResponse());
    const query = '用户确认了什么成长计划';
    const baseline = await recallBaseline(rig, query);
    expect(baseline.recall.text).toBe('');
    expect(baseline.recall.status).toBe('incomplete');

    const { result, delivered } = await consume(rig, query, baseline);
    expect(result.status).toBe('baseline_only');
    expect(result.text).toBe('');
    expect(result.consumedSources).toEqual([]);
    expect(result.addedSourceTuples).toEqual([]);
    expect(result.supplement.verifiedCount).toBe(0);
    expect(result.deliveries).toBe(0);
    expect(delivered).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('COO_CANDIDATE_PLAN_ONLY');
    expect(JSON.stringify(result)).not.toContain('coo-growth:synthetic-plan');

    console.log('D3B_S2_MIXED_COO_CONSUMPTION=' + JSON.stringify({
      baselineStatus: baseline.recall.status,
      baselineTextChars: baseline.recall.text.length,
      supplementStatus: result.supplement.readStatus,
      consumedSourceIds: result.consumedSources.map((item) => item.identity.documentId),
      deliveries: result.deliveries,
      ordinaryRecallText: baseline.recall.text,
    }));
  });

  it('withholds a source when Forget or a revision change lands at the consumption boundary', async () => {
    const buildRaceRig = async (): Promise<{ rig: Rig; baseline: BaselineCapture; target: SyntheticSource; query: string }> => {
      const rig = await createRig();
      const noise = twelveNoiseSources(rig.endpoint);
      const target = source(
        rig.endpoint,
        'source-race-target',
        'Project decision: the consumption boundary must recheck the source before appending its span.',
        { 'project-functional': 'recheck the source before appending' },
      );
      const ordered = [...noise, target];
      rig.seed(ordered.map((entry) => ({ source: entry, state: 'assigned' as const, domains: Object.keys(entry.excerpts) as DomainId[] })));
      rig.setResponder(() => responseForDocs(ordered));
      const query = GAIN_QUERY;
      const baseline = await recallBaseline(rig, query);
      expect(baseline.recall.trace?.format.includedResultIds).toHaveLength(12);
      expect(baseline.recall.text).not.toContain(target.content);
      return { rig, baseline, target, query };
    };

    const forgetRace = await buildRaceRig();
    const forgetProvider: TrustedSourceReadbackProvider = async (identity, context) => {
      const evidence = await forgetRace.rig.readback(identity, context);
      forgetRace.rig.ledger.add({
        bankId,
        endpoint: forgetRace.rig.endpoint,
        documentId: identity.documentId,
        reason: 'synthetic Forget at the Core consumption boundary',
      });
      return evidence;
    };
    const forget = await consume(forgetRace.rig, forgetRace.query, forgetRace.baseline, { finalReadbackProvider: forgetProvider });
    expect(forget.result.status).toBe('fenced');
    expect(forget.result.stopReason).toBe('final_epoch_changed');
    expect(forget.result.text).toBe(forgetRace.baseline.recall.text);
    expect(forget.result.consumedSources).toEqual([]);
    expect(forget.result.addedSourceTuples).toEqual([]);
    expect(forget.delivered).toHaveLength(1);
    expect(forget.delivered[0]?.text).toBe(forgetRace.baseline.recall.text);
    expect(forget.result.supplement.withheld.some((item) => item.identity.documentId === 'source-race-target'
      && ['record_missing', 'epoch_mismatch', 'final_epoch_changed'].includes(item.reason))).toBe(true);

    const epochRace = await buildRaceRig();
    const epochProvider: TrustedSourceReadbackProvider = async (identity, context) => {
      const evidence = await epochRace.rig.readback(identity, context);
      // A Forget fence elsewhere in the same bank moves the namespace epoch without revoking
      // this source; a proof minted before it is stale.
      epochRace.rig.ledger.add({ bankId, endpoint: epochRace.rig.endpoint, documentId: 'source-race-other', reason: 'synthetic epoch move' });
      return evidence;
    };
    const epoch = await consume(epochRace.rig, epochRace.query, epochRace.baseline, { finalReadbackProvider: epochProvider });
    expect(epoch.result.status).toBe('fenced');
    expect(epoch.result.stopReason).toBe('final_epoch_changed');
    expect(epoch.result.text).toBe(epochRace.baseline.recall.text);
    expect(epoch.result.consumedSources).toEqual([]);

    const revisionRace = await buildRaceRig();
    const revisionProvider: TrustedSourceReadbackProvider = async (identity, context) => {
      const evidence = await revisionRace.rig.readback(identity, context);
      if (!evidence) return null;
      const changed = evidence.content + ' changed at the consumption boundary';
      return { ...evidence, content: changed, sourceRevision: hash(changed) };
    };
    const revision = await consume(revisionRace.rig, revisionRace.query, revisionRace.baseline, { finalReadbackProvider: revisionProvider });
    expect(revision.result.status).toBe('baseline_only');
    expect(revision.result.text).toBe(revisionRace.baseline.recall.text);
    expect(revision.result.consumedSources).toEqual([]);
    expect(revision.result.supplement.withheld.some((item) => item.identity.documentId === 'source-race-target' && item.reason === 'revision_mismatch')).toBe(true);
    expect(revision.result.text).not.toContain('changed at the consumption boundary');

    console.log('D3B_S2_RACE_CONSUMPTION=' + JSON.stringify({
      forget: {
        status: forget.result.status,
        stopReason: forget.result.stopReason,
        baselineTextPreserved: forget.result.text === forgetRace.baseline.recall.text,
        consumedSourceIds: forget.result.consumedSources.map((item) => item.identity.documentId),
        withheld: forget.result.supplement.withheld.map((item) => ({ id: item.identity.documentId, reason: item.reason })),
        forgotten: forgetRace.rig.ledger.forgotten(bankId, forgetRace.rig.endpoint, 'source-race-target'),
      },
      epoch: {
        status: epoch.result.status,
        stopReason: epoch.result.stopReason,
        baselineTextPreserved: epoch.result.text === epochRace.baseline.recall.text,
        consumedSourceIds: epoch.result.consumedSources.map((item) => item.identity.documentId),
        withheld: epoch.result.supplement.withheld.map((item) => ({ id: item.identity.documentId, reason: item.reason })),
      },
      revision: {
        status: revision.result.status,
        stopReason: revision.result.stopReason,
        baselineTextPreserved: revision.result.text === revisionRace.baseline.recall.text,
        consumedSourceIds: revision.result.consumedSources.map((item) => item.identity.documentId),
        withheld: revision.result.supplement.withheld.map((item) => ({ id: item.identity.documentId, reason: item.reason })),
      },
    }));
  });

  it('keeps baseline Recall when the supplement query, readback, cancellation or budget fails', async () => {
    const rig = await createRig();
    const noise = twelveNoiseSources(rig.endpoint);
    const target = source(
      rig.endpoint,
      'source-failure-target',
      'Project decision: a failed supplement must never remove the legitimate baseline source.',
      { 'project-functional': 'never remove the legitimate baseline source' },
    );
    const ordered = [...noise, target];
    rig.seed(ordered.map((entry) => ({ source: entry, state: 'assigned' as const, domains: Object.keys(entry.excerpts) as DomainId[] })));
    rig.setResponder(() => responseForDocs(ordered));
    const query = GAIN_QUERY;
    const baseline = await recallBaseline(rig, query);
    expect(baseline.recall.status).toBe('found');
    expect(baseline.recall.text).not.toContain(target.content);

    const queryFailure = await consume(rig, query, baseline, {
      search: async () => { throw new Error('synthetic query failure'); },
    });
    expect(queryFailure.result.status).toBe('unavailable');
    expect(queryFailure.result.stopReason).toBe('query_unavailable');
    expect(queryFailure.result.text).toBe(baseline.recall.text);
    expect(queryFailure.delivered[0]?.text).toBe(baseline.recall.text);

    const readbackFailure = await consume(rig, query, baseline, {
      readbackProvider: rig.readback,
      finalReadbackProvider: async () => null,
    });
    expect(readbackFailure.result.status).toBe('baseline_only');
    expect(readbackFailure.result.text).toBe(baseline.recall.text);
    expect(readbackFailure.result.consumedSources).toEqual([]);
    expect(readbackFailure.result.supplement.withheldCount).toBeGreaterThan(0);
    expect(readbackFailure.result.supplement.withheld.some((item) => item.reason === 'evidence_missing')).toBe(true);

    const budget = await consume(rig, query, baseline, { limits: { maxSupplementChars: 200 } });
    expect(budget.result.status).toBe('baseline_only');
    expect(budget.result.stopReason).toBe('supplement_output_budget');
    expect(budget.result.text).toBe(baseline.recall.text);
    expect(budget.result.consumedSources).toEqual([]);
    expect(budget.result.supplement.withheldCount).toBeGreaterThan(0);
    expect(budget.result.supplement.withheld.some((item) => item.reason === 'supplement_output_budget')).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await consume(rig, query, baseline, { signal: controller.signal });
    expect(cancelled.result.status).toBe('baseline_only');
    expect(cancelled.result.stopReason).toBe('cancelled');
    expect(cancelled.result.text).toBe(baseline.recall.text);
    expect(cancelled.result.consumedSources).toEqual([]);
    expect(cancelled.delivered[0]?.text).toBe(baseline.recall.text);

    const delayed = await createRig();
    const delayedNoise = twelveNoiseSources(delayed.endpoint);
    const delayedTarget = source(
      delayed.endpoint,
      'source-timeout-target',
      'Project decision: a timed-out supplement is unknown, not absent.',
      { 'project-functional': 'a timed-out supplement is unknown' },
    );
    const delayedOrdered = [...delayedNoise, delayedTarget];
    delayed.seed(delayedOrdered.map((entry) => ({ source: entry, state: 'assigned' as const, domains: Object.keys(entry.excerpts) as DomainId[] })));
    delayed.setResponder(() => responseForDocs(delayedOrdered));
    delayed.setDelay(() => 500);
    const delayedBaseline = await recallBaseline(delayed, query);
    const timeout = await consume(delayed, query, delayedBaseline, { limits: { queryTimeoutMs: 100 } });
    expect(timeout.result.status).toBe('unavailable');
    expect(timeout.result.stopReason).toBe('query_unavailable');
    expect(timeout.result.text).toBe(delayedBaseline.recall.text);
    expect(timeout.result.text).not.toContain('no memory');
    expect(timeout.result.text).not.toContain('absent');

    console.log('D3B_S2_FAILURE_CONSUMPTION=' + JSON.stringify({
      queryFailure: { status: queryFailure.result.status, stopReason: queryFailure.result.stopReason, baselinePreserved: queryFailure.result.text === baseline.recall.text },
      readbackFailure: { status: readbackFailure.result.status, stopReason: readbackFailure.result.stopReason, baselinePreserved: readbackFailure.result.text === baseline.recall.text, withheld: readbackFailure.result.supplement.withheld.map((item) => ({ id: item.identity.documentId, reason: item.reason })) },
      budget: { status: budget.result.status, stopReason: budget.result.stopReason, baselinePreserved: budget.result.text === baseline.recall.text, withheld: budget.result.supplement.withheld.map((item) => ({ id: item.identity.documentId, reason: item.reason })) },
      cancelled: { status: cancelled.result.status, stopReason: cancelled.result.stopReason, baselinePreserved: cancelled.result.text === baseline.recall.text },
      queryTimeout: { status: timeout.result.status, stopReason: timeout.result.stopReason, baselinePreserved: timeout.result.text === delayedBaseline.recall.text, queryCalls: timeout.result.supplement.budget.queryCalls },
    }));
  });
});
