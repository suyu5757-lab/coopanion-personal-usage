import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { describe, expect, it } from 'vitest';
import { HindsightMemory, SOURCE_LOOKUP_LIMITS, type SourceLookupReceipt } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { memoryTools } from '../core/memory/tools.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';

describe('original source lookup', () => {
  for (const forgetInFlight of [false, true]) {
    it(forgetInFlight
      ? 'withholds a source excerpt when a forget fence changes during read-back'
      : 'recovers details beyond summary clips while excluding current questions, echoes and forgotten sources', async () => {
      const root = mkdtempSync(join(tmpdir(), 'coo-source-lookup-'));
      const metadata = { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2024-05-01T10:00:00Z' };
      const documents = [
        { id: 'current-question', original_text: 'The departure question suggests an unverified number.', document_metadata: metadata },
        { id: 'forgotten-source', original_text: 'The departure detail must remain forgotten.', document_metadata: metadata },
        { id: 'echo', original_text: 'The departure echo is not a user source.', document_metadata: { ...metadata, source_actor: 'coo' } },
        { id: 'sensitive-source', original_text: 'departure password: fixture-only-sensitive-value', document_metadata: metadata },
        { id: 'old-source', original_text: 'Original source context. '.repeat(30) + 'The departure time is 09:42.', document_metadata: metadata },
        { id: 'long-source', original_text: 'A departure detail. '.repeat(700), document_metadata: metadata },
      ];
      let received!: () => void, release!: () => void;
      const sourceRequested = new Promise<void>(resolve => { received = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      const server = createServer((req, res) => {
        req.resume(); req.once('end', () => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const send = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
          if (url.pathname.endsWith('/documents') && !url.searchParams.has('q')) {
            const offset = Number(url.searchParams.get('offset') ?? 0);
            const page = offset === 0 ? documents.slice(0, 4) : documents.slice(4);
            send({ items: page.map(d => ({ id: d.id, bank_id: 'fixture-bank' })), total: documents.length, limit: SOURCE_LOOKUP_LIMITS.pageSize, offset });
            return;
          }
          const doc = documents.find(d => url.pathname.endsWith('/documents/' + d.id));
          if (!doc) { res.writeHead(404); res.end(); return; }
          const body = { ...doc, bank_id: 'fixture-bank', created_at: metadata.said_at, updated_at: metadata.said_at, content_hash: null, memory_unit_count: 1 };
          if (doc.id === 'old-source' && forgetInFlight) { received(); void released.then(() => send(body)); }
          else send(body);
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const store = openMemoryStateStore(join(root, 'state.sqlite')), outbox = new MemoryOutbox(store), ledger = new ForgetLedger(store), memory = new HindsightMemory();
      Object.assign(memory, { config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: baseUrl, bankId: 'fixture-bank' }), client: new HindsightClient({ baseUrl, maxAttempts: 1 }), stateStore: store, outbox, ledger, ready: true, unavailableUntil: 0 });
      ledger.addMany([{ bankId: 'fixture-bank', endpoint: baseUrl, documentId: 'forgotten-source', reason: 'Fixture forget' }], 'Fixture forget');
      const tool = memoryTools({ memory: () => memory, currentUserSource: () => 'current-question' }).find(t => t.name === 'memory_search')!;
      try {
        const pending = tool.handler({ query: 'departure', sources: true }, { role: 'main' } as never);
        if (forgetInFlight) {
          await sourceRequested;
          ledger.addMany([{ bankId: 'fixture-bank', endpoint: baseUrl, documentId: 'old-source', reason: 'Fixture in-flight forget' }], 'Fixture in-flight forget');
          release();
        }
        const read = await pending as string;
        const receipt = (memory as unknown as { lastSourceLookup: SourceLookupReceipt }).lastSourceLookup;
        expect(receipt.status).toBe(forgetInFlight ? 'fenced' : 'found');
        if (forgetInFlight) expect(read).not.toContain('09:42');
        else {
          expect(read).toContain('09:42');
          expect(read).toContain('[Source excerpt truncated.]');
          expect(read.length).toBeLessThanOrEqual(SOURCE_LOOKUP_LIMITS.maxChars);
          expect(read).not.toContain('unverified number');
          expect(read).not.toContain('must remain forgotten');
          expect(read).not.toContain('not a user source');
          expect(read).not.toContain('fixture-only-sensitive-value');
          expect(receipt.sourceDocumentHashes).toHaveLength(2);
          expect(receipt.clippedSourceDocumentHashes).toHaveLength(1);
        }
        expect(JSON.stringify(receipt)).not.toContain('09:42');
        expect(JSON.stringify(receipt)).not.toContain('old-source');
      } finally {
        release();
        await new Promise<void>(resolve => server.close(() => resolve()));
        closeMemoryStateStores(); rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
