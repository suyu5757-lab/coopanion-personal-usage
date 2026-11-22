import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';
import { evidenceCoversSegments } from '../core/memory/source-evidence.ts';

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function datedServer(context = 'Coo wrote this private daily journal for the relationship with the person.') {
  const units = [
    {
      id: 'unit-a', text: 'Synthetic journal paragraph one.\nIt carries a dated detail.',
      context, document_id: 'journal:2026-10-25', fact_type: 'world', mentioned_at: '2026-10-24T16:00:00.000Z',
      metadata: { source_actor: 'coo', kind: 'event', status: 'completed', source_event_id: 'local-journal:path:digest' },
      tags: ['source:journal', 'scope:affection'],
    },
    {
      id: 'unit-b', text: 'Synthetic journal paragraph two.',
      context, document_id: 'journal:2026-10-25', fact_type: 'world', mentioned_at: '2026-10-24T16:00:00.000Z',
      metadata: { source_actor: 'coo', kind: 'event', status: 'completed', source_event_id: 'local-journal:path:digest' },
      tags: ['source:journal', 'scope:affection'],
    },
    {
      id: 'unit-unattributed', text: 'An unattributed synthetic journal paragraph.',
      context, document_id: 'journal:2026-10-25', fact_type: 'world', mentioned_at: '2026-10-24T16:00:00.000Z',
      metadata: {}, tags: ['source:journal'],
    },
    {
      id: 'unit-wrong-day', text: 'A synthetic paragraph from the next day.',
      context, document_id: 'journal:2026-10-26', fact_type: 'world', mentioned_at: '2026-10-25T16:00:00.000Z',
      metadata: { source_actor: 'coo', kind: 'event', status: 'completed', source_event_id: 'local-journal:path:digest' },
      tags: ['source:journal', 'scope:affection'],
    },
  ];
  const original = units.map((unit) => unit.text).join('\n');
  const requests: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname.endsWith('/memories/recall')) {
        send({ results: [], source_facts: {}, source_facts_truncated: false });
        return;
      }
      if (url.pathname.endsWith('/memories/list')) {
        const start = url.searchParams.get('start_date');
        const end = url.searchParams.get('end_date');
        const filtered = units.filter((unit) => (!start || unit.mentioned_at >= start) && (!end || unit.mentioned_at < end));
        send({ items: filtered, total: filtered.length, limit: Number(url.searchParams.get('limit') ?? 0), offset: 0 });
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/documents')) {
        send({ items: [{ id: 'journal:2026-10-25', bank_id: 'fixture-bank' }], total: 1, limit: 250, offset: 0 });
        return;
      }
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      if (id === 'journal:2026-10-25') {
        send({
          id, bank_id: 'fixture-bank', original_text: original,
          document_metadata: { source_actor: 'coo', kind: 'event', status: 'completed', source_event_id: 'local-journal:path:digest' },
          content_hash: null, created_at: '2026-10-24T16:00:00.000Z', updated_at: '2026-10-24T16:00:00.000Z', memory_unit_count: 3,
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coo-dated-recall-'));
  roots.push(root);
  const server = await datedServer();
  const store = openMemoryStateStore(join(root, 'state.sqlite'));
  const memory = new HindsightMemory();
  Object.assign(memory, {
    config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: server.baseUrl, bankId: 'fixture-bank' }),
    client: new HindsightClient({ baseUrl: server.baseUrl, maxAttempts: 1 }),
    stateStore: store,
    outbox: new MemoryOutbox(store),
    ledger: new ForgetLedger(store),
    ready: true,
    unavailableUntil: 0,
  });
  return { memory, requests: server.requests };
}

describe('dated journal recall', () => {
  it('reads the exact local day, keeps source bodies, and proves every segment', async () => {
    const { memory } = await fixture();
    expect(await memory.ensureImportedJournalArtifact('journal:2026-10-25')).toBe('registered');
    const read = await memory.recallForTurn('2026年10月25日的日记', { captureTrace: true });
    expect(read.status).toBe('found');
    expect(read.dateFocused).toBe(true);
    expect(read.text).toContain('Synthetic journal paragraph one.');
    expect(read.text).toContain('It carries a dated detail.');
    // The label uses the journal's own local day, not the UTC date of mentioned_at.
    expect(read.text).toContain('journal:2026-10-25');
    expect(read.text).toContain('2026-10-25');
    expect(read.text).not.toContain('2026-10-24');
    expect(read.text).not.toContain('Synthetic journal paragraph two.');
    expect(read.text).not.toContain('unattributed synthetic');
    expect(read.text).not.toContain('next day');
    const segments = read.trace?.format.sourceSegments ?? [];
    expect(segments.length).toBe(1);
    const evidence = await memory.evidenceForSegments(read.text, segments);
    expect(evidence.length).toBe(1);
    expect(evidenceCoversSegments(read.text, segments, evidence)).toBe(true);
    expect(evidence.every((item) => item.validationStatus === 'validated' && item.revisionState === 'current')).toBe(true);
  });

  it('does not inject a journal whose Bank source was forgotten', async () => {
    const { memory } = await fixture();
    await memory.ensureImportedJournalArtifact('journal:2026-10-25');
    expect(memory.historySourceStatus('journal:2026-10-25')).toBe('visible');
    const store = (memory as unknown as { stateStore: ReturnType<typeof openMemoryStateStore> }).stateStore;
    const endpoint = (memory as unknown as { config: { apiUrl: string } }).config.apiUrl;
    store.importForget({
      v: 2,
      tasks: [],
      tombstones: [{ bankId: 'fixture-bank', endpoint, documentId: 'journal:2026-10-25', reason: 'synthetic test', at: '2026-10-26T00:00:00.000Z' }],
      epochs: {},
      stale: [],
    }, false);
    (memory as unknown as { ledger: ForgetLedger }).ledger = new ForgetLedger(store);
    expect(memory.historySourceStatus('journal:2026-10-25')).toBe('forgotten');
  });
});
