import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores } from '../core/memory/state-store.ts';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type SourceFact = {
  id: string;
  text: string;
  type: string;
  document_id: string;
  occurred_start: string;
  metadata: Record<string, string>;
};

function userFact(): SourceFact {
  return {
    id: 'fact-user-event',
    text: 'The user said she prefers a quiet start to the day.',
    type: 'world',
    document_id: 'doc-user-event',
    occurred_start: '2026-10-01T10:00:00.000Z',
    metadata: { source_actor: 'user', kind: 'event', status: 'completed' },
  };
}

function cooFact(kind: string, status: string, marker: string): SourceFact {
  return {
    id: 'fact-coo-candidate',
    text: marker,
    type: 'memory',
    document_id: 'coo-growth:synthetic-candidate',
    occurred_start: '2026-10-02T10:00:00.000Z',
    metadata: { source_actor: 'coo', kind, status },
  };
}

function mixedObservation(kind: string, status: string, marker: string, mismatchId = false): unknown {
  const candidate = cooFact(kind, status, marker);
  if (mismatchId) candidate.id = 'fact-some-other-source';
  return {
    results: [{
      id: 'observation-mixed',
      text: 'The user confirmed the claim ' + marker + '.',
      context: 'The synthesized history repeats ' + marker + '.',
      type: 'observation',
      document_id: 'doc-mixed-observation',
      source_fact_ids: ['fact-user-event', 'fact-coo-candidate'],
    }],
    source_facts: {
      'fact-user-event': userFact(),
      'fact-coo-candidate': candidate,
    },
    source_facts_truncated: false,
  };
}

async function configuredMemory(response: unknown): Promise<{
  memory: HindsightMemory;
  ledger: ForgetLedger;
  endpoint: string;
}> {
  const server = createServer((request, result) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'POST' || !path.endsWith('/memories/recall')) {
      request.resume();
      result.writeHead(404);
      result.end();
      return;
    }
    request.resume();
    request.once('end', () => {
      result.writeHead(200, { 'content-type': 'application/json' });
      result.end(JSON.stringify(response));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const endpoint = 'http://127.0.0.1:' + address.port;
  const root = mkdtempSync(join(tmpdir(), 'r27-mixed-recall-'));
  roots.push(root);
  const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
  const ledger = new ForgetLedger(join(root, 'memory-forget.json'));
  const memory = new HindsightMemory();
  Object.assign(memory, {
    config: {
      enabled: true,
      autostart: false,
      apiUrl: endpoint,
      apiToken: '',
      bankId: 'bank-r27-f1',
      recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] },
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
  return { memory, ledger, endpoint };
}

describe('ordinary Recall mixed-source provenance', () => {
  it('keeps a user-only observation readable without a domain assignment', async () => {
    const response = {
      results: [{
        id: 'observation-user-only',
        text: 'The user prefers a quiet start to the day.',
        type: 'observation',
        document_id: 'doc-user-observation',
        source_fact_ids: ['fact-user-event'],
      }],
      source_facts: { 'fact-user-event': userFact() },
      source_facts_truncated: false,
    };
    const { memory } = await configuredMemory(response);

    const search = await memory.searchResultsDetailed('What routine did the user describe?', { captureTrace: true, activationEnabled: false });
    const recall = await memory.recallBlockDetailed('What routine did the user describe?', { captureTrace: true, activationEnabled: false });

    expect(search.status).toBe('found');
    expect(search.results).toHaveLength(1);
    expect(search.results[0]?.sourceFacts?.map((fact) => fact.documentId)).toEqual(['doc-user-event']);
    expect(recall.status).toBe('found');
    expect(recall.text).toContain('The user prefers a quiet start to the day.');
    expect(recall.text).toContain('The user said she prefers a quiet start to the day.');
    expect(recall.trace?.search.items[0]).toMatchObject({ disposition: 'visible', sourceFactsIncomplete: false });
  });

  it.each([
    { kind: 'plan', status: 'candidate', marker: 'R27F1_PLAN_ONLY_4E2A' },
    { kind: 'reflection', status: 'candidate', marker: 'R27F1_REFLECTION_ONLY_8C71' },
    { kind: 'plan', status: 'withdrawn', marker: 'R27F1_WITHDRAWN_PLAN_ONLY_16B9' },
  ])('withholds a mixed observation supported by Coo $kind/$status', async ({ kind, status, marker }) => {
    const { memory } = await configuredMemory(mixedObservation(kind, status, marker));

    const search = await memory.searchResultsDetailed('What did the user confirm?', { captureTrace: true, activationEnabled: false });
    const recall = await memory.recallBlockDetailed('What did the user confirm?', { captureTrace: true, activationEnabled: false });

    expect(recall.text).toBe('');
    expect(search.results).toEqual([]);
    expect(search.status).toBe('incomplete');
    expect(recall.status).toBe('incomplete');
    expect(JSON.stringify({ results: search.results, text: recall.text, format: recall.trace?.format })).not.toContain(marker);
    expect(recall.trace?.search.items[0]).toMatchObject({
      disposition: 'filtered',
      reason: 'unverified-source-fact',
      sourceFactsIncomplete: true,
    });
    expect(recall.trace?.search.candidateResultIds).toEqual([]);
  });

  it('withholds a direct Coo plan candidate from ordinary Recall', async () => {
    const marker = 'R27F1_DIRECT_COO_PLAN_51D0';
    const response = {
      results: [{
        id: 'direct-coo-plan',
        text: marker,
        type: 'world',
        document_id: 'coo-growth:direct-plan',
        metadata: { source_actor: 'coo', kind: 'plan', status: 'candidate' },
        source_fact_ids: [],
      }],
      source_facts: {},
      source_facts_truncated: false,
    };
    const { memory } = await configuredMemory(response);

    const recall = await memory.recallBlockDetailed('What has Coo done?', { captureTrace: true, activationEnabled: false });

    expect(recall.status).toBe('incomplete');
    expect(recall.text).toBe('');
    expect(recall.trace?.search.items[0]).toMatchObject({ disposition: 'filtered', reason: 'unverified-source-fact' });
    expect(recall.trace?.search.candidateResultIds).toEqual([]);
  });

  it('withholds a mixed observation when a declared source-fact identity does not match', async () => {
    const marker = 'R27F1_IDENTITY_MISMATCH_COO_CANDIDATE_3D77';
    const { memory } = await configuredMemory(mixedObservation('reflection', 'candidate', marker, true));

    const search = await memory.searchResultsDetailed('What did the user confirm?', { captureTrace: true, activationEnabled: false });
    const recall = await memory.recallBlockDetailed('What did the user confirm?', { captureTrace: true, activationEnabled: false });

    expect(search.results).toEqual([]);
    expect(recall.text).toBe('');
    expect(search.status).toBe('incomplete');
    expect(recall.text).not.toContain(marker);
    expect(recall.trace?.search.items[0]).toMatchObject({
      disposition: 'filtered',
      reason: 'unverified-source-fact',
      sourceFactsIncomplete: true,
      verifiedSources: [{ sourceFactId: 'fact-user-event', documentId: 'doc-user-event' }],
    });
  });

  it('keeps a parent Forget fence ahead of a mixed-source observation', async () => {
    const marker = 'R27F1_FORGOTTEN_PARENT_MIXED_COO_79AF';
    const { memory, ledger, endpoint } = await configuredMemory(mixedObservation('plan', 'candidate', marker));
    const fence = ledger.add({
      bankId: 'bank-r27-f1',
      endpoint,
      documentId: 'doc-user-event',
      reason: 'synthetic parent Forget',
    });
    expect(fence).not.toBeNull();
    expect(ledger.markDone(fence!.id)).toBe(true);

    const recall = await memory.recallBlockDetailed('What did the user confirm?', { captureTrace: true, activationEnabled: false });

    expect(recall.status).toBe('fenced');
    expect(recall.text).toBe('');
    expect(recall.text).not.toContain(marker);
    expect(recall.trace?.search.items[0]).toMatchObject({ disposition: 'filtered', reason: 'forgotten-support' });
  });
});

