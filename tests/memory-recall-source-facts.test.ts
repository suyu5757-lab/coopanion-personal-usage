import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import { HindsightMemory, type MemoryTextRead } from '../core/memory/hindsight.ts';
import { DEFAULT_ACTIVATION_RANK_INFLUENCE } from '../core/memory/format.ts';
import { growthMemorySearchTool } from '../core/growth/review.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, type MemoryStateStore } from '../core/memory/state-store.ts';
import { DEFAULT_SOURCE_FACTS_TOKEN_BUDGET } from '../core/memory/recall-limits.ts';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function hindsightServer(response: unknown): Promise<{ baseUrl: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function bankHindsightServer(): Promise<{ baseUrl: string }> {
  const server = createServer((req, res) => {
    req.resume();
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const bankId = /\/banks\/([^/]+)\/memories\/recall$/.exec(path)?.[1];
    const marker = bankId === 'bank-a' ? 'A' : bankId === 'bank-b' ? 'B' : null;
    if (!marker) {
      res.writeHead(404);
      res.end();
      return;
    }
    const id = `fact-${marker}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ id: `observation-${marker}`, text: `Bank ${marker} observation.`, type: 'observation', document_id: `doc-observation-${marker}`, source_fact_ids: [id] }],
      source_facts: { [id]: { id, text: `Bank ${marker} source fact.`, type: 'world', document_id: `doc-${marker}` } },
      source_facts_truncated: false,
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function deferredHindsightServer(response: unknown): Promise<{
  baseUrl: string;
  requestReceived: Promise<void>;
  releaseResponse: () => void;
}> {
  let received!: () => void;
  let release!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const responseReleased = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      received();
      void responseReleased.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requestReceived, releaseResponse: release };
}

function historicalEventResponse(at: string, actor = 'user', semanticScore = 0.95): unknown {
  return {
    results: [{
      id: 'observation-old-event',
      text: 'The person described an earlier trip.',
      type: 'observation',
      document_id: 'doc-derived-trip',
      source_fact_ids: ['fact-old-event'],
      metadata: { source_actor: 'inference', kind: 'fact', status: 'current' },
      scores: { semantic: semanticScore },
    }],
    source_facts: {
      'fact-old-event': {
        id: 'fact-old-event',
        text: 'The person visited a coastal town.',
        type: 'experience',
        document_id: 'doc-old-event',
        occurred_start: at,
        metadata: { source_actor: actor, kind: 'event', status: 'completed', said_at: at },
      },
    },
    source_facts_truncated: false,
  };
}

describe('Hindsight source-fact recall', () => {
  it('passes visible observations with their context and source facts to the memory reader', async () => {
    const api = await hindsightServer({
      results: [{
        id: 'observation-plan',
        text: 'Lin and Wei worked together on the planning document.',
        context: 'The observation links the coordination and review records.',
        type: 'observation',
        document_id: 'doc-observation',
        source_fact_ids: ['fact-coordination', 'fact-review'],
      }],
      source_facts: {
        'fact-coordination': {
          id: 'fact-coordination',
          text: 'Lin coordinated the shared materials.',
          type: 'world',
          document_id: 'doc-coordination',
        },
        'fact-review': {
          id: 'fact-review',
          text: 'Wei reviewed the shared plan.',
          type: 'experience',
          document_id: 'doc-review',
        },
      },
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-source-facts-'));
    roots.push(root);
    const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'memory-forget.json'));
    const memory = new HindsightMemory() as unknown as {
      config: {
        enabled: boolean;
        autostart: boolean;
        apiUrl: string;
        apiToken: string;
        bankId: string;
        recall: { maxTokens: number; budget: 'low'; timeoutMs: number; types: string[] };
        retain: { async: boolean };
        portrait: { maxTokens: number };
        affection: { enabled: boolean; dailyPositive: number; dailyNegative: number };
      };
      client: HindsightClient;
      outbox: MemoryOutbox;
      ledger: ForgetLedger;
      stateStore: MemoryOutbox['stateStore'];
      ready: boolean;
      unavailableUntil: number;
      recallBlockDetailed: (query: string, opts?: { captureTrace?: boolean }) => Promise<MemoryTextRead>;
    };
    memory.config = {
      enabled: true,
      autostart: false,
      apiUrl: api.baseUrl,
      apiToken: '',
      bankId: 'bank-test',
      recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] },
      retain: { async: true },
      portrait: { maxTokens: 500 },
      affection: { enabled: false, dailyPositive: 10, dailyNegative: 5 },
    };
    memory.client = new HindsightClient({ baseUrl: api.baseUrl, maxAttempts: 1 });
    memory.outbox = outbox;
    memory.ledger = ledger;
    memory.stateStore = outbox.stateStore;
    memory.ready = true;
    memory.unavailableUntil = 0;

    const read = await memory.recallBlockDetailed('What planning work did Lin and Wei share?', { captureTrace: true });

    expect(read.status).toBe('found');
    expect(read.text).toContain('The observation links the coordination and review records.');
    expect(read.text).toContain('Lin coordinated the shared materials.');
    expect(read.text).toContain('Wei reviewed the shared plan.');
    expect(read.trace?.search.items).toEqual([{
      resultIndex: 0,
      resultId: 'observation-plan',
      parentDocumentId: 'doc-observation',
      declaredSourceFactIds: ['fact-coordination', 'fact-review'],
      verifiedSources: [
        { sourceFactId: 'fact-coordination', documentId: 'doc-coordination' },
        { sourceFactId: 'fact-review', documentId: 'doc-review' },
      ],
      disposition: 'visible',
      sourceFactsIncomplete: false,
      retrievalScores: {
        source: 'hindsight-recall',
        inputRank: 0,
        final: { status: 'missing' },
        reranker: { status: 'missing' },
        semantic: { status: 'missing' },
        keyword: { status: 'missing' },
      },
    }]);
    expect(read.trace?.search.candidateResultIndexes).toEqual([0]);
    expect(read.trace?.search.candidateResultIds).toEqual(['observation-plan']);
    expect(read.trace?.format.includedSourceDocumentIds).toEqual(['doc-coordination', 'doc-review']);
    expect(JSON.stringify(read.trace)).not.toContain('Lin coordinated the shared materials.');
    expect(api.requests).toHaveLength(1);
    const include = api.requests[0]?.include as { source_facts?: { max_tokens?: number } } | undefined;
    expect(include?.source_facts?.max_tokens).toBeGreaterThan(0);
    expect(include?.source_facts?.max_tokens).toBe(DEFAULT_SOURCE_FACTS_TOKEN_BUDGET);
  });

  it('keeps a low-activation user event retrievable by an explicit past-event question', async () => {
    const now = Date.now();
    const oldAt = new Date(now - 400 * 86_400_000).toISOString();
    const api = await hindsightServer(historicalEventResponse(oldAt));
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-low-activation-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const runtime = memory as unknown as HindsightMemory;
    const store = (memory as unknown as { stateStore: MemoryStateStore }).stateStore;
    const sourceEvent = runtime.retainUser('I visited a coastal town.', { cursor: 9101, timestamp: oldAt });
    expect(sourceEvent).not.toBeNull();
    store.recordUserMention({
      bankId: 'bank-test', endpoint: api.baseUrl, targetDocumentId: 'doc-old-event',
      userEventDocumentId: sourceEvent!, targetCreatedAt: oldAt, semanticMatch: 0.9, intensity: 0,
    });

    const baselineRead = await runtime.recallForTurn('What did I tell you last time?', { captureTrace: true, activationEnabled: false });
    const baselineActivation = store.loadActivationState('bank-test', api.baseUrl, 'doc-old-event');
    const read = await runtime.recallForTurn('What did I tell you last time?', { captureTrace: true });
    const activation = store.loadActivationState('bank-test', api.baseUrl, 'doc-old-event');

    expect(baselineRead.status).toBe('found');
    expect(baselineRead.text).toContain('The person visited a coastal town.');
    expect(baselineRead.trace?.format.activationInfluence).toBe(0);
    expect(baselineRead.trace?.search.items[0]?.activationWeight).toBeUndefined();
    expect(baselineActivation).toMatchObject({ independentMentionCount: 1, lastRetrievedAt: null });
    expect(read.status).toBe('found');
    expect(read.text).toContain('The person visited a coastal town.');
    expect(read.trace?.search.items[0]?.activationWeight).toBeCloseTo(0.05, 2);
    expect(read.trace?.format.activationWeights).toEqual([
      { resultId: 'observation-old-event', weight: read.trace?.search.items[0]?.activationWeight },
    ]);
    expect(read.trace?.format.activationInfluence).toBe(DEFAULT_ACTIVATION_RANK_INFLUENCE);
    expect(activation).toMatchObject({ anchorAt: oldAt, independentMentionCount: 1 });
    expect(activation?.anchorWeight).toBe(0.8);
    expect(activation?.lastRetrievedAt).not.toBeNull();
  });

  it('holds user remention state fixed in the no-activation baseline', async () => {
    const now = new Date();
    const oldAt = new Date(now.getTime() - 400 * 86_400_000).toISOString();
    const currentAt = now.toISOString();
    const api = await hindsightServer(historicalEventResponse(oldAt));
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-no-activation-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const runtime = memory as unknown as HindsightMemory;
    const store = (memory as unknown as { stateStore: MemoryStateStore }).stateStore;
    const oldSource = runtime.retainUser('I visited a coastal town.', { cursor: 9151, timestamp: oldAt });
    expect(oldSource).not.toBeNull();
    store.recordUserMention({
      bankId: 'bank-test', endpoint: api.baseUrl, targetDocumentId: 'doc-old-event',
      userEventDocumentId: oldSource!, targetCreatedAt: oldAt, semanticMatch: 0.9, intensity: 0,
    });
    const currentSource = runtime.retainUser('What did I tell you last time?', { cursor: 9152, timestamp: currentAt });
    expect(currentSource).not.toBeNull();

    const baseline = await runtime.recallForTurn('What did I tell you last time?', {
      userEventDocumentId: currentSource!, activationEnabled: false, captureTrace: true,
    });
    const afterBaseline = store.loadActivationState('bank-test', api.baseUrl, 'doc-old-event');
    const activation = await runtime.recallForTurn('What did I tell you last time?', {
      userEventDocumentId: currentSource!, captureTrace: true,
    });
    const afterActivation = store.loadActivationState('bank-test', api.baseUrl, 'doc-old-event');

    expect(baseline.trace?.format.activationInfluence).toBe(0);
    expect(baseline.trace?.search.items[0]?.activationWeight).toBeUndefined();
    expect(afterBaseline).toMatchObject({ anchorAt: oldAt, independentMentionCount: 1, lastRetrievedAt: null });
    expect(activation.trace?.format.activationInfluence).toBe(DEFAULT_ACTIVATION_RANK_INFLUENCE);
    expect(activation.status).toBe('found');
    expect(afterActivation).toMatchObject({ anchorAt: currentAt, independentMentionCount: 2 });
    expect(afterActivation?.lastRetrievedAt).not.toBeNull();
  });

  it('boosts and re-times one verified personal event on a strong user remention', async () => {
    const now = new Date();
    const oldAt = new Date(now.getTime() - 400 * 86_400_000).toISOString();
    const currentAt = now.toISOString();
    const api = await hindsightServer(historicalEventResponse(oldAt));
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-remention-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const runtime = memory as unknown as HindsightMemory;
    const store = (memory as unknown as { stateStore: MemoryStateStore }).stateStore;
    const oldSource = runtime.retainUser('I visited a coastal town.', { cursor: 9201, timestamp: oldAt });
    expect(oldSource).not.toBeNull();
    store.recordUserMention({
      bankId: 'bank-test', endpoint: api.baseUrl, targetDocumentId: 'doc-old-event',
      userEventDocumentId: oldSource!, targetCreatedAt: oldAt, semanticMatch: 0.9, intensity: 0,
    });
    const currentSource = runtime.retainUser('What did I tell you last time?', { cursor: 9202, timestamp: currentAt });
    expect(currentSource).not.toBeNull();

    const recalled = await runtime.recallForTurn('What did I tell you last time?', { userEventDocumentId: currentSource! });
    const activation = store.loadActivationState('bank-test', api.baseUrl, 'doc-old-event');

    expect(recalled.status).toBe('found');
    expect(recalled.text).toContain('The person visited a coastal town.');
    expect(activation).toMatchObject({
      anchorAt: currentAt,
      lastUserMentionAt: currentAt,
      independentMentionCount: 2,
    });
    expect(activation?.anchorWeight).toBeGreaterThan(0.05);
    expect(activation?.anchorWeight).toBeLessThan(0.2);
    expect(activation?.halfLifeDays).toBeGreaterThan(100);
  });

  it('does not choose an arbitrary source when a rementioned observation links multiple user events', async () => {
    const firstAt = '2026-09-01T12:00:00.000Z';
    const secondAt = '2026-09-20T12:00:00.000Z';
    const api = await hindsightServer({
      results: [{
        id: 'observation-two-events',
        text: 'The person visited a coastal town and a forest reserve.',
        type: 'observation',
        document_id: 'doc-derived-two-events',
        source_fact_ids: ['fact-first-event', 'fact-second-event'],
        scores: { semantic: 0.99 },
      }, {
        id: 'observation-lower-ranked-event',
        text: 'The person visited a mountain trail.',
        type: 'observation',
        document_id: 'doc-derived-fallback-event',
        source_fact_ids: ['fact-fallback-event'],
        scores: { semantic: 0.8 },
      }],
      source_facts: {
        'fact-first-event': {
          id: 'fact-first-event', text: 'The person visited a coastal town.', type: 'experience', document_id: 'doc-first-event',
          occurred_start: firstAt,
          metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: firstAt },
        },
        'fact-second-event': {
          id: 'fact-second-event', text: 'The person visited a forest reserve.', type: 'experience', document_id: 'doc-second-event',
          occurred_start: secondAt,
          metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: secondAt },
        },
        'fact-fallback-event': {
          id: 'fact-fallback-event', text: 'The person visited a mountain trail.', type: 'experience', document_id: 'doc-fallback-event',
          occurred_start: secondAt,
          metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: secondAt },
        },
      },
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-ambiguous-event-sources-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const runtime = memory as unknown as HindsightMemory;
    const store = (memory as unknown as { stateStore: MemoryStateStore }).stateStore;
    const currentAt = new Date().toISOString();
    const currentEvent = runtime.retainUser('Can you remind me about the places I visited?', { cursor: 9311, timestamp: currentAt });
    expect(currentEvent).not.toBeNull();

    const recalled = await runtime.recallForTurn('Can you remind me about the places I visited?', {
      userEventDocumentId: currentEvent!, captureTrace: true,
    });

    expect(recalled.status).toBe('found');
    expect(recalled.trace?.search.items[0]?.activationWeight).toBeDefined();
    for (const documentId of ['doc-first-event', 'doc-second-event', 'doc-fallback-event']) {
      expect(store.loadActivationState('bank-test', api.baseUrl, documentId)).toMatchObject({
        independentMentionCount: 0,
        lastUserMentionAt: null,
      });
    }
  });

  it('does not apply event activation to a stable user fact', async () => {
    const createdAt = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const api = await hindsightServer({
      results: [{
        id: 'fact-preference',
        text: 'The person prefers turquoise.',
        type: 'world',
        document_id: 'doc-preference',
        created_at: createdAt,
        metadata: { source_actor: 'user', kind: 'fact', status: 'current' },
        scores: { semantic: 0.99 },
      }],
      source_facts: {},
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-stable-user-fact-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const runtime = memory as unknown as HindsightMemory;
    const store = (memory as unknown as { stateStore: MemoryStateStore }).stateStore;
    const currentEvent = runtime.retainUser('Which color do I prefer?', { cursor: 9312 });
    expect(currentEvent).not.toBeNull();

    const recalled = await runtime.recallForTurn('Which color do I prefer?', {
      userEventDocumentId: currentEvent!, captureTrace: true,
    });

    expect(recalled.status).toBe('found');
    expect(recalled.text).toContain('The person prefers turquoise.');
    expect(recalled.trace?.search.items[0]?.activationWeight).toBeUndefined();
    expect(store.loadActivationState('bank-test', api.baseUrl, 'doc-preference')).toBeNull();
  });

  it('does not reinforce a weak association or decay a tool source', async () => {
    const currentAt = new Date().toISOString();
    const weakApi = await hindsightServer(historicalEventResponse(currentAt, 'user', 0.6));
    const weakRoot = mkdtempSync(join(tmpdir(), 'coo-recall-weak-match-'));
    roots.push(weakRoot);
    const weak = await configuredMemory(weakApi.baseUrl, weakRoot);
    const weakRuntime = weak.memory as unknown as HindsightMemory;
    const weakStore = (weak.memory as unknown as { stateStore: MemoryStateStore }).stateStore;
    const weakEvent = weakRuntime.retainUser('What did I tell you last time?', { cursor: 9301, timestamp: currentAt });
    expect(weakEvent).not.toBeNull();
    expect((await weakRuntime.recallForTurn('What did I tell you last time?', { userEventDocumentId: weakEvent! })).status).toBe('found');
    expect(weakStore.loadActivationState('bank-test', weakApi.baseUrl, 'doc-old-event')).toMatchObject({
      anchorAt: currentAt,
      independentMentionCount: 0,
      lastUserMentionAt: null,
    });

    const toolApi = await hindsightServer(historicalEventResponse(currentAt, 'tool', 0.99));
    const toolRoot = mkdtempSync(join(tmpdir(), 'coo-recall-tool-source-'));
    roots.push(toolRoot);
    const tool = await configuredMemory(toolApi.baseUrl, toolRoot);
    const toolRuntime = tool.memory as unknown as HindsightMemory;
    const toolStore = (tool.memory as unknown as { stateStore: MemoryStateStore }).stateStore;
    const toolEvent = toolRuntime.retainUser('What did I tell you last time?', { cursor: 9302, timestamp: currentAt });
    expect(toolEvent).not.toBeNull();
    const recalledTool = await toolRuntime.recallForTurn('What did I tell you last time?', { userEventDocumentId: toolEvent! });

    expect(recalledTool.status).toBe('found');
    expect(toolStore.loadActivationState('bank-test', toolApi.baseUrl, 'doc-old-event')).toBeNull();
  });
async function configuredMemory(baseUrl: string, root: string, bankId = 'bank-test'): Promise<{
  memory: {
    config: {
      enabled: boolean;
      autostart: boolean;
      apiUrl: string;
      apiToken: string;
      bankId: string;
      recall: { maxTokens: number; budget: 'low'; timeoutMs: number; types: string[] };
      retain: { async: boolean };
      portrait: { maxTokens: number };
      affection: { enabled: boolean; dailyPositive: number; dailyNegative: number };
    };
    client: HindsightClient;
    outbox: MemoryOutbox;
    ledger: ForgetLedger;
    stateStore: MemoryOutbox['stateStore'];
    ready: boolean;
    unavailableUntil: number;
    recallBlockDetailed: (query: string) => Promise<{ text: string; status: string }>;
  };
  ledger: ForgetLedger;
}> {
  const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
  const ledger = new ForgetLedger(join(root, 'memory-forget.json'));
  const memory = new HindsightMemory() as unknown as {
    config: {
      enabled: boolean;
      autostart: boolean;
      apiUrl: string;
      apiToken: string;
      bankId: string;
      recall: { maxTokens: number; budget: 'low'; timeoutMs: number; types: string[] };
      retain: { async: boolean };
      portrait: { maxTokens: number };
      affection: { enabled: boolean; dailyPositive: number; dailyNegative: number };
    };
    client: HindsightClient;
    outbox: MemoryOutbox;
    ledger: ForgetLedger;
    stateStore: MemoryOutbox['stateStore'];
    ready: boolean;
    unavailableUntil: number;
    recallBlockDetailed: (query: string) => Promise<{ text: string; status: string }>;
  };
  memory.config = {
    enabled: true,
    autostart: false,
    apiUrl: baseUrl,
    apiToken: '',
    bankId,
    recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] },
    retain: { async: true },
    portrait: { maxTokens: 500 },
    affection: { enabled: false, dailyPositive: 10, dailyNegative: 5 },
  };
  memory.client = new HindsightClient({ baseUrl, maxAttempts: 1 });
  memory.outbox = outbox;
  memory.ledger = ledger;
  memory.stateStore = outbox.stateStore;
  memory.ready = true;
  memory.unavailableUntil = 0;
  return { memory, ledger };
}

  it('uses the shared source-fact formatter in the Growth memory search', async () => {
    const api = await hindsightServer({
      results: [{
        id: 'observation-growth',
        text: 'Two verified events describe the shared work.',
        type: 'observation',
        document_id: 'doc-observation',
        source_fact_ids: ['fact-one', 'fact-two'],
      }],
      source_facts: {
        'fact-one': { id: 'fact-one', text: 'Lin coordinated the materials.', type: 'world', document_id: 'doc-one' },
        'fact-two': { id: 'fact-two', text: 'Wei reviewed the plan.', type: 'experience', document_id: 'doc-two' },
      },
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-growth-memory-search-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const observedSourceIds = new Set<string>();
    const tool = growthMemorySearchTool(() => memory as unknown as HindsightMemory, observedSourceIds);
    const result = await tool.handler!({ query: 'What shared work was recorded?', max_tokens: 600 }, {} as never);

    expect(result).toContain('source_id:doc-one');
    expect(result).toContain('source_id:doc-two');
    expect(result).not.toContain('source_id:doc-observation');
    expect(observedSourceIds).toEqual(new Set(['doc-one', 'doc-two']));
    expect(result).toContain('Lin coordinated the materials.');
    expect(result).toContain('Wei reviewed the plan.');
    expect(api.requests).toHaveLength(1);
  });

  it('uses a user event said_at as its evidence date and does not substitute ingestion time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-source-evidence-date-'));
    roots.push(root);
    const { memory } = await configuredMemory('http://127.0.0.1:1', root);
    const client = memory.client as unknown as {
      getDocument: (bankId: string, documentId: string, options?: unknown) => Promise<unknown>;
    };
    client.getDocument = async (_bankId, documentId) => ({
      id: documentId,
      bank_id: 'bank-test',
      created_at: '2026-10-31T12:00:00.000Z',
      document_metadata: documentId === 'doc-dated'
        ? { source_actor: 'user', kind: 'event', said_at: '2026-10-01T12:00:00.000Z' }
        : { source_actor: 'user', kind: 'event' },
    });
    const source = memory as unknown as HindsightMemory;

    await expect(source.sourceEvidence('doc-dated')).resolves.toMatchObject({ occurredAt: '2026-10-01T12:00:00.000Z' });
    await expect(source.sourceEvidence('doc-no-said-at')).resolves.toMatchObject({ kind: 'event' });
    await expect(source.sourceEvidence('doc-no-said-at')).resolves.not.toHaveProperty('occurredAt');
  });

  it('keeps the source-fact request budget independent from the recall token budget', async () => {
    const api = await hindsightServer({ results: [], source_facts: {}, source_facts_truncated: false });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-source-budget-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const read = await (memory as unknown as HindsightMemory).searchResultsDetailed('Find one synthetic record.', {
      maxTokens: 300,
      maxSourceFactsTokens: 5000,
      captureTrace: true,
    });
    const include = api.requests[0]?.include as { source_facts?: { max_tokens?: number } } | undefined;

    expect(read.status).toBe('absent');
    expect(read.trace?.recallTokenBudget).toBe(300);
    expect(read.trace?.sourceFactsTokenBudget).toBe(5000);
    expect(include?.source_facts?.max_tokens).toBe(5000);
    expect(api.requests[0]?.max_tokens).toBe(300);
  });

  it('passes Hindsight scores through the memory reader while preserving service order and matchScore', async () => {
    const api = await hindsightServer({
      results: [
        { id: 'first', text: 'The first synthetic result.', type: 'observation', document_id: 'doc-first', scores: { final: 0.1, reranker: 0.2, semantic: null, keyword: 3 } },
        { id: 'second', text: 'The second synthetic result.', type: 'observation', document_id: 'doc-second', scores: { final: 0.99, reranker: 0.98, semantic: 0.97, keyword: null } },
      ],
      source_facts: {},
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-score-evidence-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const runtime = memory as unknown as HindsightMemory;
    const search = await runtime.searchResultsDetailed('Find the synthetic results.', { captureTrace: true, activationEnabled: false });
    const read = await runtime.recallBlockDetailed('Find the synthetic results.', { captureTrace: true, activationEnabled: false, maxItems: 1 });
    const noTrace = await runtime.recallBlockDetailed('Find the synthetic results.', { activationEnabled: false, maxItems: 1 });

    expect(search.results[0]).toMatchObject({
      id: 'first',
      matchScore: 0.2,
      retrievalScores: {
        source: 'hindsight-recall', inputRank: 0,
        final: { status: 'present', value: 0.1 },
        reranker: { status: 'present', value: 0.2 },
        semantic: { status: 'missing' },
        keyword: { status: 'present', value: 3 },
      },
    });
    expect(search.trace?.items[0]?.retrievalScores).toEqual(search.results[0]?.retrievalScores);
    expect(read.trace?.format.candidateResultIndexes).toEqual([0, 1]);
    expect(read.trace?.format.includedResultIndexes).toEqual([0]);
    expect(read.trace?.format.retrievalScores[0]).toMatchObject({ resultId: 'first', inputRank: 0, final: { value: 0.1 } });
    expect(read.trace?.format.retrievalScores[1]).toMatchObject({ resultId: 'second', inputRank: 1, final: { value: 0.99 } });
    expect(read.trace?.format.retrievalScores[0]).not.toHaveProperty('route');
    expect(noTrace.status).toBe('found');
    expect(noTrace.trace).toBeUndefined();
    expect(noTrace.text).toContain('The first synthetic result.');
    expect(noTrace.text).not.toContain('The second synthetic result.');
    expect(read.text).toBe(noTrace.text);
  });

  it('keeps source facts isolated when two banks recall the same question', async () => {
    const api = await bankHindsightServer();
    const rootA = mkdtempSync(join(tmpdir(), 'coo-recall-bank-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'coo-recall-bank-b-'));
    roots.push(rootA, rootB);
    const { memory: bankA } = await configuredMemory(api.baseUrl, rootA, 'bank-a');
    const { memory: bankB } = await configuredMemory(api.baseUrl, rootB, 'bank-b');

    const [readA, readB] = await Promise.all([
      bankA.recallBlockDetailed('What did the project record?'),
      bankB.recallBlockDetailed('What did the project record?'),
    ]);

    expect(readA.status).toBe('found');
    expect(readA.text).toContain('Bank A source fact.');
    expect(readA.text).not.toContain('Bank B source fact.');
    expect(readB.status).toBe('found');
    expect(readB.text).toContain('Bank B source fact.');
    expect(readB.text).not.toContain('Bank A source fact.');
  });

  it('discards a recall response that arrives after Memory is disabled', async () => {
    const api = await deferredHindsightServer({
      results: [{
        id: 'observation-revoked',
        text: 'Synthetic content received after permission was revoked.',
        type: 'observation',
        document_id: 'doc-observation',
        source_fact_ids: ['fact-revoked'],
      }],
      source_facts: {
        'fact-revoked': { id: 'fact-revoked', text: 'Synthetic source that must not be returned.', type: 'world', document_id: 'doc-revoked' },
      },
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-revoked-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);
    const pending = memory.recallBlockDetailed('What did the source say?');

    try {
      await api.requestReceived;
      (memory as unknown as HindsightMemory).configure(root, { warn: () => {} }, {
        enabled: false,
        apiUrl: api.baseUrl,
        bankId: 'bank-test',
      });
    } finally {
      api.releaseResponse();
    }

    const read = await pending;
    expect(read).toEqual({ text: '', status: 'fenced' });
    expect(read.text).not.toContain('Synthetic source that must not be returned.');
  });

  it('fences a derived result when the linked source map value has a different id', async () => {
    const api = await hindsightServer({
      results: [{
        id: 'observation-mismatch',
        text: 'A synthetic observation derived from a forgotten source.',
        context: 'The observation points at a deleted fact.',
        type: 'observation',
        document_id: 'doc-observation',
        source_fact_ids: ['fact-linked'],
      }],
      source_facts: {
        'fact-linked': {
          id: 'fact-unrelated',
          text: 'Unrelated synthetic fact returned under the wrong key.',
          type: 'world',
          document_id: 'doc-unrelated',
        },
      },
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-mismatched-id-fenced-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    const fence = ledger.add({
      bankId: 'bank-test',
      endpoint: api.baseUrl,
      documentId: 'doc-linked',
      reason: 'synthetic forget',
    });
    expect(fence).not.toBeNull();
    expect(ledger.markDone(fence!.id)).toBe(true);

    const read = await memory.recallBlockDetailed('What project is the observation about?');

    expect(read).toEqual({ text: '', status: 'fenced' });
  });

  it('omits a mismatched source fact and marks the parent result incomplete when no fence exists', async () => {
    const api = await hindsightServer({
      results: [{
        id: 'observation-mismatch-no-fence',
        text: 'A synthetic observation with unverified support.',
        context: 'The parent context remains visible.',
        type: 'observation',
        document_id: 'doc-observation',
        source_fact_ids: ['fact-linked'],
      }],
      source_facts: {
        'fact-linked': {
          id: 'fact-unrelated',
          text: 'Unrelated synthetic text must not enter the prompt.',
          type: 'world',
          document_id: 'doc-unrelated',
        },
      },
      source_facts_truncated: false,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-mismatched-id-open-'));
    roots.push(root);
    const { memory } = await configuredMemory(api.baseUrl, root);

    const read = await memory.recallBlockDetailed('What project is the observation about?');

    expect(read.status).toBe('found');
    expect(read.text).toContain('A synthetic observation with unverified support.');
    expect(read.text).toContain('Supporting source facts are incomplete for this result.');
    expect(read.text).not.toContain('Unrelated synthetic text must not enter the prompt.');
  });

  it.each(['pending', 'done'] as const)('withholds an unlinked observation while its bank has a %s deletion fence', async (state) => {
    const api = await hindsightServer({
      results: [{
        id: 'observation-unlinked',
        text: 'A derived relationship that may contain forgotten information.',
        context: 'The supporting source is not identified.',
        type: 'observation',
        document_id: 'doc-derived',
      }],
      source_facts: {},
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-unlinked-fenced-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    const fence = ledger.add({ bankId: 'bank-test', endpoint: api.baseUrl, documentId: 'doc-forgotten', reason: 'synthetic forget' });
    expect(fence).not.toBeNull();
    if (state === 'done') expect(ledger.markDone(fence!.id)).toBe(true);

    expect(await memory.recallBlockDetailed('What relationship was recorded?')).toEqual({ text: '', status: 'fenced' });
  });

  it.each([{ sourceFactIds: null }, { sourceFactIds: [] }])('treats $sourceFactIds source links as unverified after a completed deletion', async ({ sourceFactIds }) => {
    const api = await hindsightServer({
      results: [{ id: 'observation-empty-links', text: 'An unlinked derived fact.', type: 'observation', document_id: 'doc-derived', source_fact_ids: sourceFactIds }],
      source_facts: {},
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-empty-links-fenced-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    const fence = ledger.add({ bankId: 'bank-test', endpoint: api.baseUrl, documentId: 'doc-forgotten', reason: 'synthetic forget' });
    expect(ledger.markDone(fence!.id)).toBe(true);

    expect(await memory.recallBlockDetailed('What was derived?')).toEqual({ text: '', status: 'fenced' });
  });

  it('withholds an unlinked observation whose attachment cannot identify its supporting source', async () => {
    const api = await hindsightServer({
      results: [{
        id: 'observation-attachment', text: 'An unlinked derived fact.', type: 'observation', document_id: 'doc-derived',
        attachments: [{ id: 'attachment-test', hash: 'a'.repeat(64), kind: 'file', media_type: 'text/plain', byte_size: 32, filename: 'source.txt', url: '/api/v1/banks/bank-test/attachments/attachment-test' }],
      }],
      source_facts: {},
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-attachment-fenced-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    const fence = ledger.add({ bankId: 'bank-test', endpoint: api.baseUrl, documentId: 'doc-forgotten', reason: 'synthetic forget' });
    expect(ledger.markDone(fence!.id)).toBe(true);

    expect(await memory.recallBlockDetailed('What did the attachment establish?')).toEqual({ text: '', status: 'fenced' });
  });

  it.each(['no fence', 'another bank', 'another endpoint'] as const)('keeps an unlinked observation available with %s', async (scope) => {
    const api = await hindsightServer({
      results: [{ id: 'observation-visible', text: 'An observation in the current bank.', type: 'observation', document_id: 'doc-derived' }],
      source_facts: {},
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-unlinked-fence-scope-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    if (scope !== 'no fence') {
      const fence = ledger.add({
        bankId: scope === 'another bank' ? 'bank-other' : 'bank-test',
        endpoint: scope === 'another endpoint' ? 'http://127.0.0.1:1' : api.baseUrl,
        documentId: 'doc-forgotten', reason: 'synthetic forget',
      });
      expect(ledger.markDone(fence!.id)).toBe(true);
    }

    const read = await memory.recallBlockDetailed('What does this bank record?');

    expect(read.status).toBe('found');
    expect(read.text).toContain('An observation in the current bank.');
  });

  it('keeps direct facts and verified observations while withholding unlinked observations from a fenced bank', async () => {
    const api = await hindsightServer({
      results: [
        { id: 'fact-direct', text: 'A direct fact from a visible document.', type: 'world', document_id: 'doc-direct' },
        { id: 'observation-linked', text: 'A relationship with verified support.', type: 'observation', document_id: 'doc-derived-linked', source_fact_ids: ['fact-support'] },
        { id: 'observation-unlinked', text: 'An unsupported relationship.', context: 'Unsupported relationship context.', type: 'observation', document_id: 'doc-derived-unlinked' },
      ],
      source_facts: { 'fact-support': { id: 'fact-support', text: 'The supporting fact is still visible.', type: 'world', document_id: 'doc-support' } },
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-mixed-source-fence-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    const fence = ledger.add({ bankId: 'bank-test', endpoint: api.baseUrl, documentId: 'doc-forgotten', reason: 'synthetic forget' });
    expect(ledger.markDone(fence!.id)).toBe(true);

    const read = await memory.recallBlockDetailed('What facts and relationships remain visible?');

    expect(read.status).toBe('found');
    expect(read.text).toContain('A direct fact from a visible document.');
    expect(read.text).toContain('A relationship with verified support.');
    expect(read.text).toContain('The supporting fact is still visible.');
    expect(read.text).not.toContain('An unsupported relationship.');
    expect(read.text).not.toContain('Unsupported relationship context.');
  });

  it('keeps an unlinked observation fenced after reopening the local state store', async () => {
    const api = await hindsightServer({
      results: [{ id: 'observation-after-reopen', text: 'A derived fact returned after restart.', type: 'observation', document_id: 'doc-derived' }],
      source_facts: {},
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-unlinked-fence-reopen-'));
    roots.push(root);
    const { ledger } = await configuredMemory(api.baseUrl, root);
    const fence = ledger.add({ bankId: 'bank-test', endpoint: api.baseUrl, documentId: 'doc-forgotten', reason: 'synthetic forget' });
    expect(ledger.markDone(fence!.id)).toBe(true);
    closeMemoryStateStores();
    const { memory } = await configuredMemory(api.baseUrl, root);

    expect(await memory.recallBlockDetailed('What remains after restart?')).toEqual({ text: '', status: 'fenced' });
  });

  it.each([
    { state: 'pending', truncated: false },
    { state: 'done', truncated: false },
    { state: 'pending', truncated: true },
    { state: 'done', truncated: true },
  ])('keeps parentless observations whose declared sources are all verified with a $state fence and truncated=$truncated', async ({ state, truncated }) => {
    const api = await hindsightServer({
      results: [{ id: 'supported-parentless', text: 'Lin coordinated and Wei reviewed the plan.', type: 'observation', document_id: null, source_fact_ids: ['fact-a', 'fact-b'] }],
      source_facts: {
        'fact-a': { id: 'fact-a', text: 'Lin coordinated the materials.', type: 'world', document_id: 'doc-a' },
        'fact-b': { id: 'fact-b', text: 'Wei reviewed the shared plan.', type: 'world', document_id: 'doc-b' },
      },
      source_facts_truncated: truncated,
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-parentless-supported-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    const fence = ledger.add({ bankId: 'bank-test', endpoint: api.baseUrl, documentId: 'doc-unrelated', reason: 'synthetic unrelated forget' });
    expect(fence).not.toBeNull();
    if (state === 'done') expect(ledger.markDone(fence!.id)).toBe(true);

    const read = await memory.recallBlockDetailed('What planning work did Lin and Wei share?');

    expect(read.status).toBe('found');
    expect(read.text).toContain('Lin coordinated the materials.');
    expect(read.text).toContain('Wei reviewed the shared plan.');
    expect(read.text).toContain('source_id:doc-a');
    expect(read.text).toContain('source_id:doc-b');
  });

  it('does not share verified support between results with the same response ID', async () => {
    const api = await hindsightServer({
      results: [
        { id: 'shared-id', text: 'A supported relationship.', type: 'observation', document_id: null, source_fact_ids: ['fact-a'] },
        { id: 'shared-id', text: 'An unsupported source-free claim.', type: 'world', document_id: null },
      ],
      source_facts: { 'fact-a': { id: 'fact-a', text: 'A verified source event.', type: 'world', document_id: 'doc-a' } },
    });
    const root = mkdtempSync(join(tmpdir(), 'coo-support-result-identity-'));
    roots.push(root);
    const { memory, ledger } = await configuredMemory(api.baseUrl, root);
    ledger.add({ bankId: 'bank-test', endpoint: api.baseUrl, documentId: 'doc-unrelated', reason: 'synthetic unrelated forget' });

    const read = await memory.recallBlockDetailed('What relationship was recorded?');

    expect(read.status).toBe('found');
    expect(read.text).toContain('A supported relationship.');
    expect(read.text).not.toContain('An unsupported source-free claim.');
  });

});
