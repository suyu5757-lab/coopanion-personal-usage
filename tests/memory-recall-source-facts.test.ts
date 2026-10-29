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
      recallBlockDetailed: (query: string) => Promise<{ text: string; status: string }>;
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

    const read = await memory.recallBlockDetailed('What planning work did Lin and Wei share?');

    expect(read.status).toBe('found');
    expect(read.text).toContain('The observation links the coordination and review records.');
    expect(read.text).toContain('Lin coordinated the shared materials.');
    expect(read.text).toContain('Wei reviewed the shared plan.');
    expect(api.requests).toHaveLength(1);
    const include = api.requests[0]?.include as { source_facts?: { max_tokens?: number } } | undefined;
    expect(include?.source_facts?.max_tokens).toBeGreaterThan(0);
    expect(include?.source_facts?.max_tokens).toBeLessThanOrEqual(1024);
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

});
