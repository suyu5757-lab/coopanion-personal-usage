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
  it('explains a literal miss and reads sources whose preview metadata is incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-source-literal-'));
    const metadata = { source_actor: 'user', kind: 'event', status: 'completed' };
    const documents = [
      { id: 'source-a', original_text: 'The departure time is 09:42. Meeting note: 河边集合点旁边的石桌。', document_metadata: metadata },
      { id: 'source-b', original_text: 'The departure gate is C7.', document_metadata: metadata },
      { id: 'coo-source', original_text: 'The departure was repeated by Coo.', document_metadata: { ...metadata, source_actor: 'coo' } },
      { id: 'profile-source', original_text: 'The departure is a profile field, not an event.', document_metadata: { ...metadata, kind: 'profile' } },
    ];
    let incompleteScan = false;
    const server = createServer((req, res) => {
      req.resume(); req.once('end', () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const send = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (url.pathname.endsWith('/documents')) {
          if (incompleteScan) send({ items: [], total: documents.length, limit: SOURCE_LOOKUP_LIMITS.pageSize, offset: 0 });
          else send({ items: documents.map((doc, index) => ({
            id: doc.id,
            bank_id: 'fixture-bank',
            document_metadata: index === 0 ? {} : index === 1 ? { source_actor: 'user' } : index === 2 ? { source_actor: 'coo', kind: 'event' } : { source_actor: 'user', kind: 'profile' },
          })), total: documents.length, limit: SOURCE_LOOKUP_LIMITS.pageSize, offset: 0 });
          return;
        }
        const doc = documents.find(item => url.pathname.endsWith('/documents/' + item.id));
        if (!doc) { res.writeHead(404); res.end(); return; }
        send({ ...doc, bank_id: 'fixture-bank', created_at: '2024-05-01T10:00:00Z', updated_at: '2024-05-01T10:00:00Z', content_hash: null, memory_unit_count: 1 });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = openMemoryStateStore(join(root, 'state.sqlite')), memory = new HindsightMemory();
    Object.assign(memory, { config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: baseUrl, bankId: 'fixture-bank' }), client: new HindsightClient({ baseUrl, maxAttempts: 1 }), stateStore: store, outbox: new MemoryOutbox(store), ledger: new ForgetLedger(store), ready: true, unavailableUntil: 0 });
    const tool = memoryTools({ memory: () => memory }).find(item => item.name === 'memory_search')!;
    try {
      const question = '你还记得我们约定在河边集合点旁边见面的具体位置在哪里吗？';
      const shortPhrase = '河边集合点旁边';
      expect(question.length).toBe(28);
      expect(shortPhrase.length).toBe(7);
      const miss = await tool.handler({ query: question, sources: true }, { role: 'main' } as never);
      expect(miss).toContain('literal phrase');
      expect(miss).toContain('Try a shorter');
      expect(miss).toContain('does not establish that the event is absent');
      expect(miss).not.toContain('bank was not searched completely');
      const chineseMatch = await tool.handler({ query: shortPhrase, sources: true }, { role: 'main' } as never);
      expect(chineseMatch).toContain('河边集合点旁边的石桌');
      const caseInsensitiveMatch = await tool.handler({ query: 'DEPARTURE GATE', sources: true }, { role: 'main' } as never);
      expect(caseInsensitiveMatch).toContain('C7');
      const found = await tool.handler({ query: 'departure', sources: true }, { role: 'main' } as never);
      expect(found).toContain('09:42');
      expect(found).toContain('C7');
      expect((memory as unknown as { lastSourceLookup: SourceLookupReceipt }).lastSourceLookup).toMatchObject({ status: 'found', sourceReads: 2, scanIncomplete: false });
      incompleteScan = true;
      const incomplete = await tool.handler({ query: 'unrelated phrase', sources: true }, { role: 'main' } as never);
      expect(incomplete).toContain('bank was not searched completely');
      expect(incomplete).toContain('does not establish that the event is absent');
      expect((memory as unknown as { lastSourceLookup: SourceLookupReceipt }).lastSourceLookup).toMatchObject({ status: 'incomplete', scanIncomplete: true });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      closeMemoryStateStores(); rmSync(root, { recursive: true, force: true });
    }
  });

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
            const page = offset === 0 ? documents.slice(0, 4) : [...documents.slice(4), documents[4]!];
            send({ items: page.map(d => ({ id: d.id, bank_id: 'fixture-bank' })), total: documents.length + 1, limit: SOURCE_LOOKUP_LIMITS.pageSize, offset });
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
          expect(receipt.scannedDocuments).toBe(documents.length);
          expect(receipt.sourceReads).toBe(4);
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

describe('forget with verified sources', () => {
  it('finds original user and Coo events when verified outbox payloads were cleared and recall returns a missing document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-source-forget-'));
    const marker = 'synthetic-forget-marker-4821-'.repeat(5) + 'unique-tail-92';
    const documents = [
      { id: 'old-user-event', original_text: `The person asked Coo to remember ${marker}.`, document_metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2024-05-01T10:00:00Z' } },
      { id: 'coo-echo-event', original_text: `Coo repeated the ${marker} test phrase.`, document_metadata: { source_actor: 'coo', kind: 'event', status: 'completed', said_at: '2024-05-01T10:01:00Z' } },
      { id: 'prefix-only-event', original_text: `A different event contains only this prefix: ${marker.slice(0, 120)}.`, document_metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2024-05-01T10:01:30Z' } },
      { id: 'unrelated-event', original_text: 'A separate event without the test phrase.', document_metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2024-05-01T10:02:00Z' } },
      { id: 'later-unrelated-event', original_text: 'A later page item without the test phrase.', document_metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2024-05-01T10:03:00Z' } },
    ];
    const deleted = new Set<string>();
    const server = createServer((req, res) => {
      req.resume(); req.once('end', () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const send = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (url.pathname.endsWith('/memories/recall')) {
          send({ results: [{ id: 'ghost-result', document_id: 'missing-recall-document', text: 'stale fixture result' }] });
          return;
        }
        if (url.pathname.endsWith('/documents') && req.method === 'GET') {
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const items = documents.map(d => ({
            id: d.id,
            bank_id: 'fixture-bank',
            document_metadata: d.id === 'old-user-event' ? {} : d.id === 'coo-echo-event' ? { source_actor: 'coo' } : d.id === 'prefix-only-event' ? { kind: 'event' } : undefined,
          }));
          send({ items, total: documents.length, limit: SOURCE_LOOKUP_LIMITS.pageSize, offset });
          return;
        }
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        const doc = documents.find(d => d.id === id);
        if (req.method === 'DELETE' && doc) {
          deleted.add(id);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ deleted: true }));
          return;
        }
        if (!doc || deleted.has(id)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: 'Document not found' })); return; }
        send({ ...doc, bank_id: 'fixture-bank', created_at: doc.document_metadata.said_at, updated_at: doc.document_metadata.said_at, content_hash: null, memory_unit_count: 1 });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = openMemoryStateStore(join(root, 'state.sqlite'));
    const outbox = new MemoryOutbox(store), ledger = new ForgetLedger(store), memory = new HindsightMemory();
    Object.assign(memory, { config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: baseUrl, bankId: 'fixture-bank' }), client: new HindsightClient({ baseUrl, maxAttempts: 1 }), stateStore: store, outbox, ledger, ready: true, unavailableUntil: 0 });
    for (const documentId of ['old-user-event', 'coo-echo-event']) {
      expect(outbox.add({ bankId: 'fixture-bank', endpoint: baseUrl, documentId, content: `source ${documentId}`, context: '', tags: [], priority: 'normal' })).toBe('queued');
      const item = outbox.matching(candidate => candidate.documentId === documentId)[0]!;
      expect(outbox.markDone(item.id)).toBe(true);
      expect(outbox.markVerified(item.id)).toBe(true);
    }
    try {
      const result = await memory.forget(marker);
      expect(result).toMatchObject({ local: 0, deleted: 2, pending: 0, failed: 0 });
      expect([...deleted].sort()).toEqual(['coo-echo-event', 'old-user-event']);
      expect(ledger.forgotten('fixture-bank', baseUrl, 'old-user-event')).toBe(true);
      expect(ledger.forgotten('fixture-bank', baseUrl, 'coo-echo-event')).toBe(true);
      expect(ledger.forgotten('fixture-bank', baseUrl, 'prefix-only-event')).toBe(false);
      expect(ledger.forgotten('fixture-bank', baseUrl, 'unrelated-event')).toBe(false);
      expect(ledger.forgotten('fixture-bank', baseUrl, 'later-unrelated-event')).toBe(false);
      expect(ledger.status()).toMatchObject({ pending: 0, failed: 0, staleTargets: 0 });
      expect(await (memory as unknown as { client: HindsightClient }).client.getDocument('fixture-bank', 'prefix-only-event')).not.toBeNull();
      expect(await (memory as unknown as { client: HindsightClient }).client.getDocument('fixture-bank', 'unrelated-event')).not.toBeNull();
      expect(await (memory as unknown as { client: HindsightClient }).client.getDocument('fixture-bank', 'later-unrelated-event')).not.toBeNull();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      closeMemoryStateStores(); rmSync(root, { recursive: true, force: true });
    }
  });
});
