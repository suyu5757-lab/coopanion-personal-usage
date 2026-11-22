import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox, requestHashFor } from '../core/memory/outbox.ts';
import { OutboxDelivery } from '../core/memory/delivery.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function bankServer() {
  const documents = new Map<string, { text: string; metadata: Record<string, string> }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'POST' && url.pathname.endsWith('/memories')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          items?: Array<{ content?: string; document_id?: string; metadata?: Record<string, string>; timestamp?: string; tags?: string[] }>;
        };
        for (const item of body.items ?? []) {
          if (item.document_id && typeof item.content === 'string') documents.set(item.document_id, { text: item.content, metadata: item.metadata ?? {} });
        }
        send({ success: true, items_count: body.items?.length ?? 0, async: false });
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/memories/list')) {
        const start = url.searchParams.get('start_date');
        const end = url.searchParams.get('end_date');
        const items = [...documents.entries()].flatMap(([documentId, document]) => {
          const mentionedAt = document.metadata.said_at ?? '2026-10-24T16:00:00.000Z';
          if (start && mentionedAt < start) return [];
          if (end && mentionedAt >= end) return [];
          return [{
            id: `unit-${documentId}`, text: document.text, context: '', document_id: documentId,
            fact_type: 'world', mentioned_at: mentionedAt, occurred_start: null, occurred_end: null,
            metadata: document.metadata, tags: ['source:journal', 'scope:affection', 'journal:generated'],
          }];
        });
        send({ items, total: items.length, limit: Number(url.searchParams.get('limit') ?? 50), offset: 0 });
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/memories/recall')) {
        send({ results: [], source_facts: {}, source_facts_truncated: false });
        return;
      }
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      if (req.method === 'GET' && url.pathname.includes('/documents/')) {
        const document = documents.get(id);
        if (!document) { send({ error: 'missing' }, 404); return; }
        send({
          id, bank_id: 'fixture-bank', original_text: document.text,
          content_hash: createHash('sha256').update(document.text, 'utf8').digest('hex'),
          created_at: '2026-10-25T00:00:00.000Z', updated_at: '2026-10-25T00:00:00.000Z',
          document_metadata: document.metadata, memory_unit_count: 1,
        });
        return;
      }
      send({ error: 'not found' }, 404);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, documents };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coo-generated-journal-'));
  roots.push(root);
  const server = await bankServer();
  server.documents.set('journal-parent', { text: 'The person shared a quiet moment on October 24.', metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2026-10-24T10:00:00Z' } });
  const store = openMemoryStateStore(join(root, 'state.sqlite'));
  const outbox = new MemoryOutbox(store);
  const ledger = new ForgetLedger(store);
  const memory = new HindsightMemory();
  const config = loadHindsightConfig(root, {
    enabled: true, autostart: false, apiUrl: server.baseUrl, bankId: 'fixture-bank',
    retain: { async: false },
  });
  Object.assign(memory, {
    config,
    client: new HindsightClient({ baseUrl: server.baseUrl, maxAttempts: 1 }),
    stateStore: store,
    outbox,
    ledger,
    ready: true,
    unavailableUntil: 0,
  });
  const delivery = new OutboxDelivery(outbox, (memory as unknown as { deliveryOps(): ConstructorParameters<typeof OutboxDelivery>[1] }).deliveryOps(), {
    target: () => ({ bankId: 'fixture-bank', endpoint: server.baseUrl }),
    forgotten: (item) => !memory.sourceVisible(item.documentId),
  });
  return { root, memory, outbox, ledger, delivery, store, server };
}

describe('generated relationship journal durability', () => {
  it('preserves a verified legacy affinity event when startup replays it with newer metadata', async () => {
    const { memory, outbox, store } = await fixture();
    const event = { subject: 'fixture', score: 21, delta: 1, kind: 'happy', reason: 'shared tea', at: '2026-10-25T09:00:00Z' };
    memory.retainAffinityChange(event);
    const item = outbox.due(new Date(), 1)[0]!;
    const legacy = { ...item, metadata: undefined };
    legacy.requestHash = requestHashFor(legacy);
    store.saveOutbox(legacy);
    outbox.reload();
    outbox.markDone(item.id);
    outbox.markVerified(item.id);
    const verified = outbox.get(item.id)!;
    store.saveOutbox({ ...verified, id: item.id + '-legacy-duplicate', operationId: item.operationId + '-duplicate' });
    outbox.reload();
    const before = JSON.stringify(store.loadOutbox());
    memory.retainAffinityChange(event);
    expect(JSON.stringify(store.loadOutbox())).toBe(before);
    expect(outbox.persistenceReason()).toBeNull();
    expect(outbox.itemsForDocument(item.documentId, item.bankId!, item.endpoint!).map((entry) => entry.state)).toEqual(['verified', 'verified']);
  });

  it('promotes one user event, corrects it, reopens state and persists its Forget fence', async () => {
    const { memory, outbox, delivery, store, root, server } = await fixture();
    const timestamp = '2026-10-25T09:00:00Z';
    const original = memory.retainUser('Please remember that my workshop is in the north room.', { session: 'first', cursor: 1, timestamp })!;
    expect(original).toBeTruthy();
    expect(memory.remember('The workshop is in the north room.', { sourceDocumentId: original })).toBe('queued');
    expect(memory.retainUser('Please remember that my workshop is in the north room.', { session: 'first', cursor: 1, timestamp })).toBe(original);
    expect(outbox.due(new Date(), 20)).toHaveLength(1);
    expect((await delivery.drain()).verified).toBe(1);
    const corrected = memory.retainUser('Correction: my workshop is now in the south room.', { session: 'second', cursor: 2, timestamp })!;
    expect(await memory.correct('The workshop is now in the south room.', [original], { sourceDocumentId: corrected })).toBe('queued');
    expect((await delivery.drain()).verified).toBe(1);
    expect(store.supersededSources('fixture-bank', server.baseUrl).has(original)).toBe(true);
    expect(memory.sourceCurrentForContext(original)).toBe(false);
    expect((await memory.readExactSourceEvidence(corrected))?.storedText).toContain('south room');
    (memory as unknown as { unavailableUntil: number }).unavailableUntil = Date.now() + 60_000;
    expect((await memory.forgetDocument(corrected)).acceptance).toBe('accepted');
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(join(root, 'state.sqlite'));
    const ledger = new ForgetLedger(reopened.stateStore!);
    expect(ledger.forgotten('fixture-bank', server.baseUrl, corrected)).toBe(true);
    expect(reopened.stateForDocument(corrected, 'fixture-bank', server.baseUrl)).toBe('verified');
    Object.assign(memory, { stateStore: reopened.stateStore, ledger, outbox: reopened, unavailableUntil: 0 });
    expect(await memory.readExactSourceEvidence(corrected)).toBeNull();
    expect(memory.remember('The workshop is now in the south room.', { sourceDocumentId: corrected })).toBe('forgotten');
    expect(server.documents.size).toBe(3);
  });

  it('requests reflection provenance and refuses missing or mixed evidence', async () => {
    const { memory } = await fixture();
    let response: unknown = { text: 'A supported reflection.', based_on: { memories: [{ document_id: 'journal-parent', type: 'world', text: 'A quiet moment.' }] } };
    let requested: Record<string, unknown> = {};
    (memory as unknown as { client: { reflect: (...args: unknown[]) => Promise<unknown> } }).client.reflect = async (...args) => { requested = args[2] as Record<string, unknown>; return response; };
    const read = await memory.reflectDetailed('Reflect on the day.', { requireSources: true });
    expect(read.status).toBe('found');
    expect(read.sourceSegments?.map((source) => source.documentId)).toEqual(['journal-parent']);
    expect(requested).toMatchObject({ includeFacts: true, excludeMentalModels: true, factTypes: ['world', 'experience'] });
    response = { text: 'An unsupported reflection.' };
    expect((await memory.reflectDetailed('Reflect.', { requireSources: true })).status).toBe('unavailable');
    response = { text: 'Mixed reflection.', based_on: { memories: [{ document_id: 'journal-parent', type: 'world' }, { type: 'observation' }] } };
    expect((await memory.reflectDetailed('Reflect.', { requireSources: true })).status).toBe('unavailable');
  });

  it('queues one Coo-authored document with an active local artifact and verifies the exact Bank readback', async () => {
    const { memory, outbox, delivery, server } = await fixture();
    const text = 'Synthetic generated journal: the day was quiet, and I stayed with the person.';
    expect(await memory.retainJournal(text, '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('queued');
    const queued = outbox.due(new Date(), 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.documentId).toMatch(/^journal:generated:2026-10-25:[a-f0-9]{16}$/);
    expect(queued[0]!.documentId).not.toBe('journal:2026-10-25');
    expect(queued[0]!.metadata).toMatchObject({ source_actor: 'coo', kind: 'reflection', status: 'candidate', journal_day: '2026-10-25' });
    const artifact = (memory as unknown as { stateStore: { getDerivedArtifact(id: string): { lifecycleState: string; lineageState: string; bodyDigest: string } | null } })
      .stateStore.getDerivedArtifact(`journal-output:${queued[0]!.documentId}`);
    expect(artifact).toMatchObject({ lifecycleState: 'active', lineageState: 'complete' });
    expect(artifact?.bodyDigest).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));

    const result = await delivery.drain();
    expect(result.verified).toBe(1);
    expect(server.documents.get(queued[0]!.documentId)?.text).toBe(text);
    expect(memory.sourceVisible(queued[0]!.documentId)).toBe(true);
    expect(outbox.stateForDocument(queued[0]!.documentId, 'fixture-bank', server.baseUrl)).toBe('verified');
  });

  it('requires source evidence and withholds a journal after its parent is forgotten', async () => {
    const { memory, outbox, delivery, ledger, server } = await fixture();
    expect(await memory.retainJournal('Unsupported claim.', '2026-10-25')).toBe('source-unavailable');
    expect(outbox.status().active).toBe(0);
    expect(await memory.retainJournal('A reflection on the shared moment.', '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('queued');
    const item = outbox.due(new Date(), 1)[0]!;
    ledger.beginIntents([{ bankId: 'fixture-bank', endpoint: server.baseUrl, documentId: 'journal-parent', reason: 'synthetic parent Forget' }], 'synthetic parent Forget');
    expect(memory.sourceVisible(item.documentId)).toBe(false);
    await delivery.drain();
    expect(server.documents.has(item.documentId)).toBe(false);
    expect(outbox.get(item.id)?.state).toBe('cancelled');
  });

  it('revalidates source digests before exposing an already delivered journal', async () => {
    const { memory, outbox, delivery, server } = await fixture();
    expect(await memory.retainJournal('A reflection on the shared moment.', '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('queued');
    const item = outbox.due(new Date(), 1)[0]!;
    await delivery.drain();
    server.documents.get('journal-parent')!.text = 'A revised source with a different account.';
    expect(await memory.verifyDerivedArtifact(`journal-output:${item.documentId}`, 'A reflection on the shared moment.')).toBe(false);
    const read = await memory.recallForTurn('2026年10月25日的日记', { captureTrace: true });
    const evidence = await memory.evidenceForSegments(read.text, read.trace?.format.sourceSegments ?? []);
    expect(evidence.every((source) => source.validationStatus === 'validated')).toBe(false);
  });

  it('does not overwrite an existing remote journal with conflicting provenance', async () => {
    const { memory, outbox, delivery, server } = await fixture();
    expect(await memory.retainJournal('New reflection.', '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('queued');
    const item = outbox.due(new Date(), 1)[0]!;
    server.documents.set(item.documentId, { text: 'Protected prior journal.', metadata: { source_actor: 'coo' } });
    await delivery.drain();
    expect(server.documents.get(item.documentId)?.text).toBe('Protected prior journal.');
    expect(outbox.get(item.id)?.state).toBe('dead');
  });

  it('does not send a queued journal after its parent body changes remotely', async () => {
    const { memory, outbox, delivery, server } = await fixture();
    expect(await memory.retainJournal('Queued reflection.', '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('queued');
    const item = outbox.due(new Date(), 1)[0]!;
    server.documents.get('journal-parent')!.text = 'Changed account.';
    await delivery.drain();
    expect(server.documents.has(item.documentId)).toBe(false);
    expect(outbox.get(item.id)?.state).toBe('dead');
  });

  it('fences the generated journal when Forget targets its supporting source', async () => {
    const { memory, outbox, delivery, ledger, server } = await fixture();
    expect(await memory.retainJournal('A linked generated reflection.', '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('queued');
    const item = outbox.due(new Date(), 1)[0]!;
    await delivery.drain();
    (memory as unknown as { unavailableUntil: number }).unavailableUntil = Date.now() + 60_000;
    expect((await memory.forgetDocument('journal-parent')).acceptance).toBe('accepted');
    expect(ledger.forgotten('fixture-bank', server.baseUrl, item.documentId)).toBe(true);
    expect(memory.sourceVisible(item.documentId)).toBe(false);
  });

  it('recalls the delivered journal through the dated arm with exact SourceProof', async () => {
    const { memory, delivery } = await fixture();
    const text = 'Synthetic generated journal for recall: we watched the rain and said nothing.';
    expect(await memory.retainJournal(text, '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('queued');
    expect((await delivery.drain()).verified).toBe(1);
    const read = await memory.recallForTurn('2026年10月25日的日记', { captureTrace: true });
    expect(read.status).toBe('found');
    expect(read.dateFocused).toBe(true);
    expect(read.text).toContain(text);
    const evidence = await memory.evidenceForSegments(read.text, read.trace?.format.sourceSegments ?? []);
    expect(evidence.length).toBe(1);
    expect(evidence[0]?.documentId).toMatch(/^journal:generated:2026-10-25:/);
    expect(evidence[0]?.validationStatus).toBe('validated');
    expect(evidence[0]?.revisionState).toBe('current');
  });

  it('deduplicates the same operation and keeps two different same-day operations distinct', async () => {
    const { memory, outbox, server } = await fixture();
    expect(await memory.retainJournal('First synthetic journal.', '2026-10-25', { sourceIds: ['journal-parent'], operationId: 'journal-op-a' })).toBe('queued');
    expect(await memory.retainJournal('First synthetic journal.', '2026-10-25', { sourceIds: ['journal-parent'], operationId: 'journal-op-a' })).toBe('exists');
    expect(await memory.retainJournal('Second synthetic journal.', '2026-10-25', { sourceIds: ['journal-parent'], operationId: 'journal-op-b' })).toBe('queued');
    expect(await memory.retainJournal('Different content for the same operation.', '2026-10-25', { sourceIds: ['journal-parent'], operationId: 'journal-op-a' })).toBe('conflict');
    expect(outbox.due(new Date(), 10)).toHaveLength(2);
    expect(new Set(outbox.due(new Date(), 10).map((item) => item.documentId)).size).toBe(2);
    expect([...server.documents.keys()]).toEqual(['journal-parent']);
  });

  it('does not queue a generated journal whose source is already forgotten', async () => {
    const { memory } = await fixture();
    (memory as unknown as { ledger: { forgotten(): boolean; damaged(): boolean } }).ledger = {
      forgotten: () => true,
      damaged: () => false,
    };
    expect(await memory.retainJournal('Synthetic forgotten journal.', '2026-10-25', { sourceIds: ['journal-parent'] })).toBe('forgotten');
    expect((memory as unknown as { outbox: MemoryOutbox }).outbox.due(new Date(), 10)).toHaveLength(0);
  });

  it('does not deliver after a Forget fence and never makes the source visible again', async () => {
    const { memory, outbox, store, server } = await fixture();
    expect(await memory.retainJournal('Synthetic journal to be fenced.', '2026-10-25', { sourceIds: ['journal-parent'], operationId: 'journal-fence' })).toBe('queued');
    const item = outbox.due(new Date(), 10)[0]!;
    store.importForget({
      v: 2, tasks: [],
      tombstones: [{ bankId: 'fixture-bank', endpoint: server.baseUrl, documentId: item.documentId, reason: 'synthetic test forget', at: '2026-10-25T01:00:00.000Z' }],
      epochs: {}, stale: [],
    }, false);
    const fencedLedger = new ForgetLedger(store);
    (memory as unknown as { ledger: ForgetLedger }).ledger = fencedLedger;
    const delivery = new OutboxDelivery(outbox, (memory as unknown as { deliveryOps(): ConstructorParameters<typeof OutboxDelivery>[1] }).deliveryOps(), {
      target: () => ({ bankId: 'fixture-bank', endpoint: server.baseUrl }),
      forgotten: (entry) => fencedLedger.forgotten('fixture-bank', server.baseUrl, entry.documentId),
    });
    await delivery.drain();
    expect([...server.documents.keys()]).toEqual(['journal-parent']);
    expect(memory.historySourceStatus(item.documentId)).toBe('forgotten');
    expect(outbox.stateForDocument(item.documentId, 'fixture-bank', server.baseUrl)).toBe('cancelled');
  });

  it('keeps the pending outbox row across a reopen without duplicating it', async () => {
    const { root, memory, outbox, server } = await fixture();
    expect(await memory.retainJournal('Synthetic persisted journal.', '2026-10-25', { sourceIds: ['journal-parent'], operationId: 'journal-persist' })).toBe('queued');
    expect(outbox.due(new Date(), 10)).toHaveLength(1);
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(root + '/state.sqlite');
    expect(reopened.due(new Date(), 10)).toHaveLength(1);
    expect(reopened.due(new Date(), 10)[0]!.documentId).toMatch(/^journal:generated:2026-10-25:/);
    const reopenedMemory = new HindsightMemory();
    Object.assign(reopenedMemory, {
      config: loadHindsightConfig(root, { enabled: true, autostart: false, apiUrl: server.baseUrl, bankId: 'fixture-bank' }),
      client: new HindsightClient({ baseUrl: server.baseUrl, maxAttempts: 1 }),
      stateStore: reopened.stateStore, outbox: reopened,
      ledger: new ForgetLedger(reopened.stateStore!), ready: true, unavailableUntil: 0,
    });
    expect(await reopenedMemory.retainJournal('Synthetic persisted journal.', '2026-10-25', { sourceIds: ['journal-parent'], operationId: 'journal-persist' })).toBe('exists');
  });
});

describe('relationship journal caller', () => {
  it('advances the journal marker only after the generated record is durably queued', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-journal-caller-'));
    roots.push(root);
    const { RelationshipJournal } = await import('../core/memory/journal.ts');
    const calls: string[] = [];
    let status: 'queued' | 'full' = 'queued';
    const memory = {
      enabled: () => true,
      settled: () => true,
      journalDayRecorded: () => false,
      evidenceEpoch: () => 'epoch',
      reflectDetailed: async () => ({ status: 'found', text: 'Synthetic journal answer.', sourceSegments: [{ documentId: 'journal-parent' }] }),
      retainJournal: async (_text: string, day: string) => { calls.push(day); return status; },
      refreshModel: async () => {},
    };
    const journal = new RelationshipJournal();
    journal.configure({ memory: memory as never, rootDir: root, timezone: 'UTC', enabled: true, now: () => new Date('2026-10-26T12:00:00.000Z') });
    writeFileSync(join(root, 'journal.json'), '{"lastDay":"2026-10-24"}\n');
    await journal.runDue();
    expect(calls).toEqual(['2026-10-25']);
    expect(readFileSync(join(root, 'journal.json'), 'utf8')).toContain('2026-10-25');

    calls.length = 0;
    status = 'full';
    writeFileSync(join(root, 'journal.json'), '{"lastDay":"2026-10-24"}\n');
    await journal.runDue();
    expect(calls).toEqual(['2026-10-25']);
    expect(readFileSync(join(root, 'journal.json'), 'utf8')).toContain('2026-10-24');
  });
});

describe('scoped single-document delivery', () => {
  it('submits only the exact target even when 74 other production-like items are pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-scoped-delivery-'));
    roots.push(root);
    const store = openMemoryStateStore(join(root, 'state.sqlite'));
    const outbox = new MemoryOutbox(store);
    for (let i = 0; i < 75; i += 1) {
      expect(outbox.add({
        bankId: 'bank-test', endpoint: 'http://hindsight.test', documentId: i === 0 ? 'target-doc' : `other-${i}`,
        content: `synthetic ${i}`, context: 'synthetic', tags: ['scope:life'], priority: 'normal',
      })).toBe('queued');
    }
    const calls: string[] = [];
    const delivery = new OutboxDelivery(outbox, {
      retain: async (item) => { calls.push(item.documentId); return { async: false, operationId: null }; },
      status: async () => 'completed',
      verify: async (item) => item.documentId === 'target-doc',
      retry: async () => {}, cancel: async () => {},
    }, { target: () => ({ bankId: 'bank-test', endpoint: 'http://hindsight.test' }) });
    const result = await delivery.drainScoped({ documentId: 'target-doc' });
    expect(result).toMatchObject({ status: 'verified', submitted: true, verified: true });
    expect(calls).toEqual(['target-doc']);
    expect(outbox.stateForDocument('target-doc', 'bank-test', 'http://hindsight.test')).toBe('verified');
    for (let i = 1; i < 75; i += 1) {
      expect(outbox.stateForDocument(`other-${i}`, 'bank-test', 'http://hindsight.test')).toBe('pending');
    }
    expect(await delivery.drainScoped({ documentId: 'missing-doc' })).toMatchObject({ status: 'not-found', submitted: false });
    expect(calls).toEqual(['target-doc']);
    expect(await delivery.drainScoped({ documentId: 'target-doc', operationId: 'not-the-item' })).toMatchObject({ status: 'blocked' });
  });
});

describe('scoped delivery failure and restart', () => {
  it('never expands scope after a failed attempt or a reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-scoped-failure-'));
    roots.push(root);
    const path = join(root, 'state.sqlite');
    const outbox = new MemoryOutbox(openMemoryStateStore(path));
    for (let i = 0; i < 75; i += 1) {
      outbox.add({ bankId: 'bank-test', endpoint: 'http://hindsight.test', documentId: i === 0 ? 'target-doc' : `other-${i}`, content: `synthetic ${i}`, context: 'synthetic', tags: ['scope:life'], priority: 'normal' });
    }
    const calls: string[] = [];
    let fail = true;
    const makeDelivery = (box: MemoryOutbox) => new OutboxDelivery(box, {
      retain: async (item) => { calls.push(item.documentId); if (fail && item.documentId === 'target-doc') throw new Error('synthetic transient'); return { async: false, operationId: null }; },
      status: async () => 'completed', verify: async () => true, retry: async () => {}, cancel: async () => {},
    }, { target: () => ({ bankId: 'bank-test', endpoint: 'http://hindsight.test' }) });
    const failed = await makeDelivery(outbox).drainScoped({ documentId: 'target-doc' });
    expect(failed.status).toBe('failed');
    for (let i = 1; i < 75; i += 1) expect(outbox.stateForDocument(`other-${i}`, 'bank-test', 'http://hindsight.test')).toBe('pending');
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path);
    fail = false;
    const result = await makeDelivery(reopened).drainScoped({ documentId: 'target-doc' });
    expect(result.status).toBe('verified');
    expect(calls).toEqual(['target-doc', 'target-doc']);
    for (let i = 1; i < 75; i += 1) expect(reopened.stateForDocument(`other-${i}`, 'bank-test', 'http://hindsight.test')).toBe('pending');
  });
});

describe('authorized local reconciliation', () => {
  it('marks only the exact delivered item verified without touching the other 74', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-reconcile-'));
    roots.push(root);
    const outbox = new MemoryOutbox(openMemoryStateStore(join(root, 'state.sqlite')));
    for (let i = 0; i < 75; i += 1) {
      outbox.add({ bankId: 'bank-test', endpoint: 'http://hindsight.test', documentId: i === 0 ? 'target-doc' : `other-${i}`, content: `synthetic ${i}`, context: 'synthetic', tags: ['scope:life'], priority: 'normal' });
    }
    const target = outbox.itemForDocument('target-doc', 'bank-test', 'http://hindsight.test')!;
    expect(outbox.reconcileVerifiedDelivery({ documentId: 'target-doc', bankId: 'bank-test', endpoint: 'http://hindsight.test', requestHash: 'wrong', receipt: 'r' })).toBe('conflict');
    expect(outbox.reconcileVerifiedDelivery({ documentId: 'target-doc', bankId: 'bank-test', endpoint: 'http://hindsight.test', requestHash: target.requestHash, receipt: 'a'.repeat(64) })).toBe('updated');
    expect(outbox.stateForDocument('target-doc', 'bank-test', 'http://hindsight.test')).toBe('verified');
    expect(outbox.itemForDocument('target-doc', 'bank-test', 'http://hindsight.test')).toMatchObject({ content: '', reconcileReceipt: 'a'.repeat(64) });
    expect(outbox.reconcileVerifiedDelivery({ documentId: 'target-doc', bankId: 'bank-test', endpoint: 'http://hindsight.test', requestHash: target.requestHash, receipt: 'a'.repeat(64) })).toBe('already');
    for (let i = 1; i < 75; i += 1) expect(outbox.stateForDocument(`other-${i}`, 'bank-test', 'http://hindsight.test')).toBe('pending');
  });
});

describe('batch reconciliation transaction', () => {
  it('updates 74 targets atomically, rolls back on one conflict, and is idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-batch-reconcile-'));
    roots.push(root);
    const outbox = new MemoryOutbox(openMemoryStateStore(join(root, 'state.sqlite')));
    for (let i = 0; i < 75; i += 1) {
      outbox.add({ bankId: 'bank-test', endpoint: 'http://hindsight.test', documentId: `doc-${i}`, content: `synthetic ${i}`, context: 'synthetic', tags: ['scope:life'], priority: 'normal' });
    }
    const targetItem = outbox.itemForDocument('doc-0', 'bank-test', 'http://hindsight.test')!;
    const db = (outbox.stateStore as unknown as { db: { prepare(sql: string): { get(id: string): { payload_json: string } } } }).db;
    const eventBefore = db.prepare('select payload_json from memory_events where event_id = ?').get(targetItem.id).payload_json;
    const targets = Array.from({ length: 74 }, (_, i) => {
      const item = outbox.itemForDocument(`doc-${i}`, 'bank-test', 'http://hindsight.test')!;
      return { documentId: item.documentId, bankId: 'bank-test', endpoint: 'http://hindsight.test', requestHash: item.requestHash, receipt: 'b'.repeat(64) };
    });
    const bad = [...targets];
    bad[73] = { ...bad[73]!, requestHash: 'wrong' };
    expect(() => outbox.reconcileVerifiedDeliveries(bad)).toThrow();
    for (let i = 0; i < 75; i += 1) expect(outbox.stateForDocument(`doc-${i}`, 'bank-test', 'http://hindsight.test')).toBe('pending');
    expect(outbox.reconcileVerifiedDeliveries(targets)).toEqual({ updated: 74, already: 0 });
    const eventAfter = db.prepare('select payload_json from memory_events where event_id = ?').get(targetItem.id).payload_json;
    expect(eventAfter).toBe(eventBefore);
    for (let i = 0; i < 74; i += 1) expect(outbox.stateForDocument(`doc-${i}`, 'bank-test', 'http://hindsight.test')).toBe('verified');
    expect(outbox.stateForDocument('doc-74', 'bank-test', 'http://hindsight.test')).toBe('pending');
    expect(outbox.reconcileVerifiedDeliveries(targets)).toEqual({ updated: 0, already: 74 });
  });
});
