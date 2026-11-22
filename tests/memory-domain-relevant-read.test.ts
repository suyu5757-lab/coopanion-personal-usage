import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { readQueryRelevantDomains } from '../core/memory/domain-relevant-read.ts';
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
const bankId = 'bank-d3b-synthetic';

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
  readback: TrustedSourceReadbackProvider;
  seed: (entries: Array<{ source: SyntheticSource; state: 'assigned' | 'unclassified' | 'ambiguous' | 'pending_review'; domains?: DomainId[] }>) => void;
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function key(source: Pick<SyntheticSource, 'bankId' | 'endpoint' | 'documentId'>): string {
  return JSON.stringify([source.bankId, source.endpoint, source.documentId]);
}

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'r27-d3b-s1-'));
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

function factFor(id: string, entry: SyntheticSource): SourceFact {
  return {
    id,
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

function observation(id: string, sourceFactIds: string[], text: string): RecallResult {
  return {
    id,
    text,
    type: 'observation',
    document_id: 'observation:' + id,
    source_fact_ids: sourceFactIds,
  };
}

function responseFor(query: string, entries: Map<string, SyntheticSource>): RecallResponse {
  const addFacts = (ids: Array<[string, string]>): Record<string, SourceFact> =>
    Object.fromEntries(ids.map(([factId, documentId]) => {
      const entry = [...entries.values()].find((item) => item.documentId === documentId)!;
      return [factId, factFor(factId, entry)];
    }));
  if (query.includes('来源预算上限')) {
    const facts = [...entries.values()]
      .filter((entry) => entry.documentId.startsWith('source-budget-'))
      .map((entry, index): [string, string] => [`fact-budget-${index}`, entry.documentId]);
    return {
      results: facts.map(([factId]) => observation(`observation-${factId}`, [factId], 'Synthetic budget result.')),
      source_facts: addFacts(facts),
      source_facts_truncated: false,
    };
  }
  if (query.includes('缺少事实元数据')) {
    const entry = [...entries.values()].find((item) => item.documentId === 'source-project');
    if (!entry) return { results: [], source_facts: {}, source_facts_truncated: false };
    const fact = factFor('fact-missing-metadata', entry);
    fact.metadata = {};
    return {
      results: [observation('observation-missing-metadata', [fact.id], 'Synthetic result without source metadata.')],
      source_facts: { [fact.id]: fact },
      source_facts_truncated: false,
    };
  }
  if (query.includes('把项目决策找回来')) {
    return {
      results: [observation('observation-single-project', ['fact-project'], 'Synthetic project result.')],
      source_facts: addFacts([['fact-project', 'source-project']]),
      source_facts_truncated: false,
    };
  }
  if (query.includes('同名ID')) {
    return {
      results: [observation('observation-same-id', ['fact-same-id'], 'Synthetic namespace result.')],
      source_facts: addFacts([['fact-same-id', 'source-same-id']]),
      source_facts_truncated: false,
    };
  }
  if (query.includes('结果被截断')) {
    return {
      results: [observation('observation-truncated', ['fact-project'], 'Synthetic truncated result.')],
      source_facts: addFacts([['fact-project', 'source-project']]),
      source_facts_truncated: true,
    };
  }
  const crossDomain = query.includes('项目决策') || query.includes('实现做法')
    || query.includes('遇到这类情况') || query.includes('迁移使用');
  const different = query.includes('用户偏好') || query.includes('喜欢什么');
  const fallback = query.includes('未分类') || query.includes('尚未整理');
  const mixed = query.includes('成长计划') || query.includes('用户确认');
  const limited = query.includes('多个来源') || query.includes('限制数量');

  if (crossDomain) {
    const facts: Array<[string, string]> = [
      ['fact-project', 'source-project'],
      ['fact-skill', 'source-skill'],
      ['fact-shared', 'source-shared'],
      ['fact-shared-again', 'source-shared'],
    ];
    return {
      results: [
        observation('observation-cross-a', ['fact-project', 'fact-skill', 'fact-shared'], 'Synthetic combined result.'),
        observation('observation-cross-b', ['fact-shared-again'], 'Synthetic duplicate result.'),
      ],
      source_facts: addFacts(facts),
      source_facts_truncated: false,
    };
  }
  if (different) {
    return {
      results: [observation('observation-different', ['fact-relationship'], 'Synthetic preference result.')],
      source_facts: addFacts([['fact-relationship', 'source-relationship']]),
      source_facts_truncated: false,
    };
  }
  if (fallback) {
    const facts: Array<[string, string]> = [
      ['fact-unclassified', 'source-unclassified'],
      ['fact-ambiguous', 'source-ambiguous'],
      ['fact-pending', 'source-pending'],
    ];
    return {
      results: [observation('observation-fallback', facts.map(([factId]) => factId), 'Synthetic fallback result.')],
      source_facts: addFacts(facts),
      source_facts_truncated: false,
    };
  }
  if (mixed) {
    const sourceFacts: Record<string, SourceFact> = {
      'fact-mixed-user': {
        id: 'fact-mixed-user',
        text: 'The user described a project decision.',
        type: 'world',
        document_id: 'source-project',
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
    };
    return {
      results: [observation('observation-mixed', ['fact-mixed-user', 'fact-coo-candidate'], 'COO_CANDIDATE_PLAN_ONLY')],
      source_facts: sourceFacts,
      source_facts_truncated: false,
    };
  }
  if (limited) {
    const facts: Array<[string, string]> = [
      ['fact-project', 'source-project'],
      ['fact-skill', 'source-skill'],
      ['fact-relationship', 'source-relationship'],
    ];
    return {
      results: facts.map(([factId]) => observation('observation-' + factId, [factId], 'Synthetic bounded result.')),
      source_facts: addFacts(facts),
      source_facts_truncated: false,
    };
  }
  return { results: [], source_facts: {}, source_facts_truncated: false };
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
    classifierVersion: 'synthetic-query-fixture/v1',
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
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'POST' || !path.endsWith('/memories/recall')) {
      request.resume();
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => {
      const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query?: string };
      const query = requestBody.query ?? '';
      requestedQueries.push(query);
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(responseFor(query, entries)));
      };
      if (query.includes('服务延迟')) setTimeout(send, 300);
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
      recall: { maxTokens: 900, budget: 'low', timeoutMs: 1200, types: ['observation'] },
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
    };
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
  return { memory, ledger, store, endpoint, sources: entries, requestedQueries, readback, seed };
}

function queryRead(rig: Rig, query: string, overrides: Partial<Parameters<typeof readQueryRelevantDomains>[0]> = {}) {
  return readQueryRelevantDomains({
    query,
    bankId,
    endpoint: rig.endpoint,
    store: rig.store,
    search: (text, options) => rig.memory.searchResultsDetailed(text, options),
    readbackProvider: rig.readback,
    getEvidenceEpoch: () => rig.memory.evidenceEpoch(),
    ...overrides,
  });
}

function sourceIds(values: Array<{ identity: { documentId: string } }>): string[] {
  return values.map((item) => item.identity.documentId);
}

afterEach(async () => {
  for (const writer of writers.splice(0)) {
    try { writer.close(); } catch { /* already closed */ }
  }
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('query-relevant domain read', () => {
  it('processes a complete recall set above the previous source ceiling', async () => {
    const rig = await createRig();
    const sources = Array.from({ length: 25 }, (_, index) => {
      const documentId = `source-budget-${String(index + 1).padStart(2, '0')}`;
      const excerpt = `verified project span ${String(index + 1).padStart(2, '0')}`;
      return source(rig.endpoint, documentId, `Project decision ${String(index + 1).padStart(2, '0')}: ${excerpt}.`, {
        'project-functional': excerpt,
      });
    });
    rig.seed(sources.map((entry) => ({ source: entry, state: 'assigned' as const, domains: ['project-functional' as const] })));

    const result = await queryRead(rig, '查询来源预算上限');

    expect(result).toMatchObject({
      status: 'complete',
      complete: true,
      coverage: { candidateCount: 25, processed: 25, verified: 25, unprocessed: 0 },
    });
    expect(result.sources).toHaveLength(25);
    expect(result.coverage.sourceFactsTruncated).toBe(false);
  });

  it('uses exact source readback to resolve missing source-fact metadata', async () => {
    const rig = await createRig();
    const project = source(rig.endpoint, 'source-project', 'Project decision: exact source metadata comes from the current document readback.', {
      'project-functional': 'current document readback',
    });
    rig.seed([{ source: project, state: 'assigned', domains: ['project-functional'] }]);

    const result = await queryRead(rig, '请查找缺少事实元数据的项目来源');

    expect(result).toMatchObject({
      status: 'complete',
      complete: true,
      coverage: { candidateCount: 1, processed: 1, verified: 1, excluded: 0, unprocessed: 0 },
    });
    expect(sourceIds(result.sources)).toEqual(['source-project']);
    expect(result.fallbackSources).toEqual([]);
    expect(result.withheldSources).toEqual([]);
  });

  it('uses Chinese natural-language query results across domains and deduplicates a multi-domain source', async () => {
    const rig = await createRig();
    const project = source(rig.endpoint, 'source-project', 'Project decision: keep source reads tied to a verified domain span.', {
      'project-functional': 'keep source reads tied',
    });
    const skill = source(rig.endpoint, 'source-skill', 'Reusable method: compare readback identity before returning a source span.', {
      'skill-methods': 'compare readback identity',
    });
    const shared = source(rig.endpoint, 'source-shared', 'Project and skill method: preserve one verified source across domains.', {
      'project-functional': 'preserve one verified source',
      'skill-methods': 'one verified source across domains',
    });
    const relationship = source(rig.endpoint, 'source-relationship', 'The user said jasmine tea is preferred after dinner.', {
      'user-relationship': 'jasmine tea is preferred',
    });
    rig.seed([
      { source: project, state: 'assigned', domains: ['project-functional'] },
      { source: skill, state: 'assigned', domains: ['skill-methods'] },
      { source: shared, state: 'assigned', domains: ['project-functional', 'skill-methods'] },
      { source: relationship, state: 'assigned', domains: ['user-relationship'] },
    ]);

    const queryOne = '把此前的项目决策和能复用的实现做法一并找出来';
    const queryTwo = '遇到这类情况时我们定了什么，以及有哪些方法可以迁移使用';
    const queryDifferent = '用户偏好什么饮品，通常在什么时候喝';
    const before = await rig.memory.recallBlockDetailed(queryOne, { captureTrace: true, activationEnabled: false });
    const baseline = await rig.memory.searchResultsDetailed(queryOne, { captureTrace: true, activationEnabled: false });
    const first = await queryRead(rig, queryOne);
    const second = await queryRead(rig, queryTwo);
    const different = await queryRead(rig, queryDifferent);
    const after = await rig.memory.recallBlockDetailed(queryOne, { captureTrace: true, activationEnabled: false });

    expect(first.status).toBe('complete');
    expect(first.budget).toMatchObject({
      queryTimeoutMs: 8_000,
      queryMaxTokens: 600,
      sourceFactsMaxTokens: 16_384,
      readbackTimeBudgetMs: 8_000,
    });
    expect(first.sources).toHaveLength(3);
    expect(sourceIds(first.sources)).toEqual(['source-project', 'source-skill', 'source-shared']);
    expect(first.sources.find((item) => item.identity.documentId === 'source-shared')?.domains)
      .toEqual(['project-functional', 'skill-methods']);
    expect(first.sources.find((item) => item.identity.documentId === 'source-shared')?.evidence.map((span) => span.text))
      .toEqual(['preserve one verified source', 'one verified source across domains']);
    expect(second.status).toBe('complete');
    expect(sourceIds(second.sources)).toEqual(sourceIds(first.sources));
    expect(different.status).toBe('complete');
    expect(sourceIds(different.sources)).toEqual(['source-relationship']);
    expect(sourceIds(different.sources)).not.toEqual(sourceIds(first.sources));
    expect(rig.requestedQueries).toContain(queryOne);
    expect(rig.requestedQueries).toContain(queryTwo);
    expect(after.text).toBe(before.text);
    expect(after.trace?.maxTokens).toBe(before.trace?.maxTokens);
    expect(after.trace?.maxChars).toBe(before.trace?.maxChars);
    expect(after.trace?.queryAttempts.map((item) => [item.queryHash, item.status, item.resultCount]))
      .toEqual(before.trace?.queryAttempts.map((item) => [item.queryHash, item.status, item.resultCount]));
    expect(baseline.status).toBe('found');
    const baselineSourceIds = [...new Set(baseline.results.flatMap((item) =>
      item.sourceFacts?.map((fact) => fact.documentId) ?? []))];
    expect(baselineSourceIds).toEqual(['source-project', 'source-skill', 'source-shared']);

    const matrix = [
      { case: 'Q1-cross-domain-and-multi-domain', query: queryOne, expectedSourceIds: ['source-project', 'source-skill', 'source-shared'], baselineSourceIds, result: first },
      { case: 'Q2-Chinese-paraphrase', query: queryTwo, expectedSourceIds: ['source-project', 'source-skill', 'source-shared'], result: second },
      { case: 'Q3-query-changes-sources', query: queryDifferent, expectedSourceIds: ['source-relationship'], result: different },
    ].map((item) => ({
      case: item.case,
      query: item.query,
      expectedSourceIds: item.expectedSourceIds,
      baselineSourceIds: item.baselineSourceIds ?? null,
      candidateSourceIds: item.result.candidates.map((candidate) => candidate.identity.documentId),
      verifiedSourceTuples: item.result.sources.map((sourceItem) => [
        sourceItem.identity.bankId, sourceItem.identity.endpoint, sourceItem.identity.documentId,
      ]),
      domains: item.result.sources.map((sourceItem) => ({
        documentId: sourceItem.identity.documentId,
        domains: sourceItem.domains,
        spans: sourceItem.evidence.map((span) => ({ start: span.start, end: span.end, digest: span.digest, text: span.text })),
      })),
      fallbackSourceTuples: item.result.fallbackSources.map((sourceItem) => [
        sourceItem.identity.bankId, sourceItem.identity.endpoint, sourceItem.identity.documentId,
      ]),
      withheldSourceIds: sourceIds(item.result.withheldSources),
      status: item.result.status,
      complete: item.result.complete,
      coverage: item.result.coverage,
      budget: item.result.budget,
    }));
    console.log('D3B_QUERY_TO_SOURCE_MATRIX=' + JSON.stringify(matrix));
  });

  it('keeps unclassified sources in ordinary Recall and reports them as fallback', async () => {
    const rig = await createRig();
    const unclassified = source(rig.endpoint, 'source-unclassified', 'The user described an important but unclassified project decision.', {});
    const ambiguous = source(rig.endpoint, 'source-ambiguous', 'The user described a project fact with uncertain domain labels.', {});
    const pending = source(rig.endpoint, 'source-pending', 'The user described a project fact awaiting domain review.', {});
    rig.seed([
      { source: unclassified, state: 'unclassified' },
      { source: ambiguous, state: 'ambiguous' },
      { source: pending, state: 'pending_review' },
    ]);
    const query = '列出尚未整理领域但仍重要的用户决定';
    const before = await rig.memory.recallBlockDetailed(query, { captureTrace: true, activationEnabled: false });
    const baseline = await rig.memory.searchResultsDetailed(query, { captureTrace: true, activationEnabled: false });
    const result = await queryRead(rig, query);
    const after = await rig.memory.recallBlockDetailed(query, { captureTrace: true, activationEnabled: false });

    expect(baseline.status).toBe('found');
    expect(baseline.results[0]?.sourceFacts?.map((fact) => fact.documentId))
      .toEqual(['source-unclassified', 'source-ambiguous', 'source-pending']);
    expect(before.status).toBe('found');
    expect(after.text).toBe(before.text);
    expect(after.trace?.maxTokens).toBe(before.trace?.maxTokens);
    expect(result.status).toBe('incomplete');
    expect(result.complete).toBe(false);
    expect(result.sources).toEqual([]);
    expect(result.fallbackSources.map((item) => [item.identity.documentId, item.domainState])).toEqual([
      ['source-unclassified', 'unclassified'],
      ['source-ambiguous', 'ambiguous'],
      ['source-pending', 'pending_review'],
    ]);
    expect(JSON.stringify(result)).not.toContain(unclassified.content);
    console.log('D3B_UNCLASSIFIED_FALLBACK=' + JSON.stringify({
      baselineSourceIds: baseline.results.flatMap((item) => item.sourceFacts?.map((fact) => fact.documentId) ?? []),
      fallback: result.fallbackSources.map((item) => ({ tuple: [item.identity.bankId, item.identity.endpoint, item.identity.documentId], state: item.domainState, reason: item.reason })),
      supplementalStatus: result.status,
      ordinaryRecallTextPreserved: after.text === before.text,
    }));
  });

  it('does not pass mixed user and Coo candidate observations into the domain channel', async () => {
    const rig = await createRig();
    const project = source(rig.endpoint, 'source-project', 'A user source that can be verified for one project domain span.', {
      'project-functional': 'verified for one project domain',
    });
    rig.seed([{ source: project, state: 'assigned', domains: ['project-functional'] }]);
    const query = '用户确认了什么成长计划';
    const baseline = await rig.memory.searchResultsDetailed(query, { captureTrace: true, activationEnabled: false });
    const recall = await rig.memory.recallBlockDetailed(query, { captureTrace: true, activationEnabled: false });
    const result = await queryRead(rig, query);

    expect(baseline.results).toEqual([]);
    expect(baseline.status).toBe('incomplete');
    expect(recall.text).toBe('');
    expect(result.sources).toEqual([]);
    expect(result.status).toBe('incomplete');
    expect(JSON.stringify(result)).not.toContain('COO_CANDIDATE_PLAN_ONLY');
    expect(JSON.stringify(result)).not.toContain('coo-growth:synthetic-plan');
    console.log('D3B_R2_F1_MIXED_SOURCE=' + JSON.stringify({
      recallStatus: baseline.status,
      visibleRecallSourceIds: baseline.results.flatMap((item) => item.sourceFacts?.map((fact) => fact.documentId) ?? []),
      ordinaryRecallText: recall.text,
      supplementalSourceIds: sourceIds(result.sources),
      status: result.status,
      trace: baseline.trace?.items.map((item) => ({ disposition: item.disposition, reason: item.reason, sourceFactsIncomplete: item.sourceFactsIncomplete })),
    }));
  });

  it('withholds revision, namespace and Forget races', async () => {
    const rig = await createRig();
    const project = source(rig.endpoint, 'source-project', 'Project decision source that must keep its verified digest.', {
      'project-functional': 'must keep its verified digest',
    });
    const otherNamespace = source('https://other.example', 'source-same-id', 'Different namespace source with an unrelated domain label.', {
      'skill-methods': 'unrelated domain label',
    }, { bankId: 'bank-other' });
    rig.seed([
      { source: project, state: 'assigned', domains: ['project-functional'] },
      { source: otherNamespace, state: 'assigned', domains: ['skill-methods'] },
    ]);
    const query = '把项目决策找回来';
    const wrongRevision: TrustedSourceReadbackProvider = async (identity, context) => {
      const original = await rig.readback(identity, context);
      if (!original) return null;
      const content = original.content + ' changed during readback';
      return { ...original, content, sourceRevision: hash(content) };
    };
    const revision = await queryRead(rig, query, { readbackProvider: wrongRevision });
    expect(revision.sources).toEqual([]);
    expect(revision.withheldSources[0]?.reason).toBe('revision_mismatch');

    const wrongEndpoint: TrustedSourceReadbackProvider = async (identity, context) => {
      const original = await rig.readback(identity, context);
      return original ? { ...original, endpoint: 'https://wrong.example' } : null;
    };
    const namespace = await queryRead(rig, query, { readbackProvider: wrongEndpoint });
    expect(namespace.sources).toEqual([]);
    expect(namespace.withheldSources[0]?.reason).toBe('identity_mismatch');

    const sameId = await queryRead(rig, '检查同名ID不要从其他Bank继承标签');
    expect(sameId.status).toBe('incomplete');
    expect(sameId.sources).toEqual([]);
    expect(sameId.fallbackSources).toEqual([]);
    expect(sameId.withheldSources[0]?.reason).toBe('record_missing');

    const afterSearch = await queryRead(rig, query, {
      search: async (text, options) => {
        const result = await rig.memory.searchResultsDetailed(text, options);
        rig.ledger.add({ bankId, endpoint: rig.endpoint, documentId: 'source-project', reason: 'synthetic Forget after query' });
        return result;
      },
    });
    expect(afterSearch.status).toBe('fenced');
    expect(afterSearch.sources).toEqual([]);
    expect(afterSearch.fallbackSources).toEqual([]);

    console.log('D3B_TRUST_FORGET=' + JSON.stringify({
      wrongRevision: { status: revision.status, withheld: revision.withheldSources.map((item) => ({ id: item.identity.documentId, reason: item.reason })) },
      wrongNamespaceReadback: { status: namespace.status, withheld: namespace.withheldSources.map((item) => ({ id: item.identity.documentId, reason: item.reason })) },
      sameDocumentIdOtherBank: { status: sameId.status, sources: sourceIds(sameId.sources), withheld: sameId.withheldSources.map((item) => ({ tuple: [item.identity.bankId, item.identity.endpoint, item.identity.documentId], reason: item.reason })) },
      forgetRace: { status: afterSearch.status, stopReason: afterSearch.stopReason, sourceIds: sourceIds(afterSearch.sources) },
      otherNamespaceTuple: [otherNamespace.bankId, otherNamespace.endpoint, otherNamespace.documentId],
    }));
  });

  it('blocks a Forget committed while a source readback is in flight', async () => {
    const rig = await createRig();
    const project = source(rig.endpoint, 'source-project', 'Project decision source that must stay behind the Forget fence.', {
      'project-functional': 'stay behind the Forget fence',
    });
    rig.seed([{ source: project, state: 'assigned', domains: ['project-functional'] }]);
    const forgetDuringReadback: TrustedSourceReadbackProvider = async (identity, context) => {
      const evidence = await rig.readback(identity, context);
      rig.ledger.add({ bankId, endpoint: rig.endpoint, documentId: identity.documentId, reason: 'synthetic Forget during readback' });
      return evidence;
    };
    const result = await queryRead(rig, '把项目决策找回来', { readbackProvider: forgetDuringReadback });

    expect(result.status).toBe('fenced');
    expect(result.sources).toEqual([]);
    expect(result.fallbackSources).toEqual([]);
    console.log('D3B_FORGET_DURING_READBACK=' + JSON.stringify({
      status: result.status,
      stopReason: result.stopReason,
      sourceIds: sourceIds(result.sources),
      forgotten: rig.ledger.forgotten(bankId, rig.endpoint, 'source-project'),
    }));
  });

  it('honors source-count and cancellation limits without claiming absence', async () => {
    const rig = await createRig();
    const project = source(rig.endpoint, 'source-project', 'Project decision source for bounded reads.', { 'project-functional': 'decision source' });
    const skill = source(rig.endpoint, 'source-skill', 'Reusable method source for bounded reads.', { 'skill-methods': 'method source' });
    const relationship = source(rig.endpoint, 'source-relationship', 'A user preference source for bounded reads.', { 'user-relationship': 'user preference' });
    rig.seed([
      { source: project, state: 'assigned', domains: ['project-functional'] },
      { source: skill, state: 'assigned', domains: ['skill-methods'] },
      { source: relationship, state: 'assigned', domains: ['user-relationship'] },
    ]);
    const limited = await queryRead(rig, '多个来源中限制数量', { limits: { maxSources: 1 } });
    expect(limited.status).toBe('incomplete');
    expect(limited.stopReason).toBe('source_limit');
    expect(limited.coverage.candidateCount).toBe(3);
    expect(limited.coverage.processed).toBe(1);
    expect(limited.coverage.unprocessed).toBe(2);

    const controller = new AbortController();
    controller.abort();
    const queryCount = rig.requestedQueries.length;
    const cancelled = await queryRead(rig, '取消这次相关读取', { signal: controller.signal });
    expect(cancelled.status).toBe('incomplete');
    expect(cancelled.stopReason).toBe('cancelled');
    expect(cancelled.sources).toEqual([]);
    expect(rig.requestedQueries).toHaveLength(queryCount);

    const truncated = await queryRead(rig, '结果被截断时仍不能报告完整');
    expect(truncated.status).toBe('incomplete');
    expect(truncated.stopReason).toBe('query_truncated');
    expect(truncated.coverage.sourceFactsTruncated).toBe(true);

    const timedOut = await queryRead(rig, '服务延迟到超过查询期限', { limits: { queryTimeoutMs: 100 } });
    expect(timedOut.status).toBe('unavailable');
    expect(timedOut.stopReason).toBe('query_unavailable');

    const slowReadback: TrustedSourceReadbackProvider = async (identity, context) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return rig.readback(identity, context);
    };
    const readbackTimedOut = await queryRead(rig, '把项目决策找回来', {
      readbackProvider: slowReadback,
      limits: { readbackTimeBudgetMs: 30, providerTimeoutMs: 10 },
    });
    expect(readbackTimedOut.status).toBe('incomplete');
    expect(readbackTimedOut.stopReason).toBe('readback_budget');
    expect(readbackTimedOut.sources).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 90));
  });
});
