import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { describe, expect, it } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { openMemoryStateStore, closeMemoryStateStores } from '../core/memory/state-store.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';

describe('supporting evidence budgets', () => {
  it('keeps server, parser and formatter coverage distinct as the independent budget increases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-evidence-budget-'));
    const facts = Array.from({ length: 64 }, (_, index) => ({
      id: `fact-${index}`, document_id: `source-${index}`, type: 'world',
      text: `${'Supporting detail. '.repeat(32)}${index === 24 ? 'Necessary evidence is cobalt.' : 'Other detail.'}`,
    }));
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const budget = body.include.source_facts.max_tokens as number;
        const returned = facts.slice(0, Math.floor(budget / 128));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          results: [{ id: 'observation', document_id: 'derived', type: 'observation', text: 'A summary with many supporting facts.', source_fact_ids: facts.map((fact) => fact.id) }],
          source_facts: Object.fromEntries(returned.map((fact) => [fact.id, fact])),
          source_facts_truncated: returned.length < facts.length,
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = openMemoryStateStore(join(root, 'state.sqlite'));
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    const memory = new HindsightMemory();
    Object.assign(memory, {
      config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: baseUrl, bankId: 'fixture-bank' }),
      client: new HindsightClient({ baseUrl, maxAttempts: 1 }),
      stateStore: store, outbox, ledger, ready: true, unavailableUntil: 0,
    });
    try {
      for (const budget of [1024, 4096, 8192]) {
        const read = await memory.recallBlockDetailed('What evidence supports the summary?', { maxTokens: 900, maxSourceFactsTokens: budget, captureTrace: true, activationEnabled: false });
        const count = Math.min(64, budget / 128);
        expect(read.trace?.search.sourceFactCounts).toEqual({ declared: 64, returned: count, valid: count, parsed: count, missing: 64 - count, invalid: 0 });
        expect(read.trace?.search.sourceFactsTokenBudget).toBe(budget);
        expect(read.trace?.search.sourceFactsTruncated).toBe(budget < 8192);
        expect(read.trace?.format.includedSourceDocumentIds).toHaveLength(count);
        expect(read.trace?.format.clippedSourceFactIds).toEqual([]);
        expect(read.text.includes('Necessary evidence is cobalt.')).toBe(budget >= 4096);
        expect(read.text.length).toBeLessThanOrEqual(read.trace!.maxChars);
      }
      const turn = await memory.recallForTurn('What evidence supports the summary?', { activationEnabled: false });
      memory.markRecallInjected(turn.text);
      const receipt = (memory as unknown as { lastRecall: Record<string, unknown> }).lastRecall;
      expect(receipt).toMatchObject({ route: 'standard', status: 'found', sourceFactCounts: { returned: 32, parsed: 32 } });
      expect(receipt.injectedAt).toEqual(expect.any(String));
      expect(JSON.stringify(receipt)).not.toContain('Necessary evidence is cobalt.');
      expect(JSON.stringify(receipt)).not.toContain('source-24');
      ledger.addMany([{ bankId: 'fixture-bank', endpoint: baseUrl, documentId: 'source-24', reason: 'Synthetic deletion check' }], 'Synthetic deletion check');
      const fenced = await memory.recallBlockDetailed('What evidence supports the summary?', { maxSourceFactsTokens: 8192, captureTrace: true, activationEnabled: false });
      expect(fenced.status).toBe('fenced');
      expect(fenced.text).not.toContain('Necessary evidence is cobalt.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeMemoryStateStores();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
