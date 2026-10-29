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
});
