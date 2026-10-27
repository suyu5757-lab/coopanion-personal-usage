import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgetLedger, VERIFY_DELAY_MS } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox, type RetainItem } from '../core/memory/outbox.ts';
import { OutboxDelivery } from '../core/memory/delivery.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'coo-forget-'));
let docs = 0;
const item = (over: Partial<RetainItem> = {}): RetainItem => ({
  bankId: 'bank-a',
  endpoint: 'http://hindsight.test',
  documentId: `doc-${++docs}`,
  content: 'synthetic trip',
  context: 'test',
  tags: ['scope:life'],
  priority: 'normal',
  ...over,
});

interface FakeClient {
  deleteDocument?: (bankId: string, documentId: string) => Promise<void>;
  recall?: (bankId: string, query: string) => Promise<{ results: Array<{ id: string; text: string; type: string; document_id?: string | null }> }>;
  getMentalModel?: (bankId: string, id: string) => Promise<{ content: string }>;
  clearMentalModel?: (bankId: string, id: string) => Promise<unknown>;
  refreshMentalModel?: (bankId: string, id: string, options?: { mode?: 'full' }) => Promise<unknown>;
  reflect?: (bankId: string, question: string) => Promise<{ text: string }>;
  listMemories?: (bankId: string) => Promise<{ items: Array<{ id: string; text: string; date: string; fact_type: string; document_id?: string | null }> }>;
}

function memoryWith(outbox: MemoryOutbox, ledger: ForgetLedger, client: FakeClient) {
  const memory = new HindsightMemory() as unknown as {
    config: Record<string, unknown>;
    client: FakeClient;
    outbox: MemoryOutbox;
    ledger: ForgetLedger;
    delivery: OutboxDelivery;
    ready: boolean;
    unavailableUntil: number;
    drain: () => Promise<void>;
    forget: (query: string) => Promise<{ local: number; deleted: number; pending: number; failed: number }>;
    forgetDocument: (documentId: string) => Promise<{ local: number; deleted: number; pending: number; failed: number }>;
    searchResults: (query: string) => Promise<Array<{ text: string; documentId: string | null }>>;
    sessionBriefing: () => Promise<{ text: string; source: string }>;
    reflect: (question: string) => Promise<string>;
    remember: (text: string) => string;
    settled: () => boolean;
    setLifecycleHooks: (hooks: { forgetSources: (sourceIds: readonly string[]) => void; clearDerived: () => void }) => void;
  };
  memory.config = {
    enabled: true,
    bankId: 'bank-a',
    apiUrl: 'http://hindsight.test',
    recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] },
    retain: { async: true },
  };
  memory.client = {
    clearMentalModel: async () => ({}),
    refreshMentalModel: async () => ({}),
    getMentalModel: async () => ({ content: '' }),
    recall: async () => ({ results: [] }),
    deleteDocument: async () => {},
    ...client,
  };
  memory.outbox = outbox;
  memory.ledger = ledger;
  memory.delivery = new OutboxDelivery(outbox, {
    retain: async (entry) => ({ async: true, operationId: entry.operationId }),
    status: async () => 'processing',
    retry: async () => {},
    cancel: async () => {},
  });
  memory.ready = true;
  memory.unavailableUntil = 0;
  return memory;
}

describe('persistence acknowledgement', () => {
  it('reports a disk failure instead of remembering a fact', () => {
    const memory = new HindsightMemory() as unknown as {
      config: Record<string, unknown>;
      client: Record<string, unknown>;
      outbox: MemoryOutbox;
      remember: (text: string) => string;
      retainUser: (text: string, meta: { session?: string; cursor?: number }) => string | null;
    };
    memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.client = {};
    memory.outbox = new MemoryOutbox(join(dir(), 'missing', 'outbox.jsonl'));
    expect(memory.remember('synthetic fact')).toBe('persistence-error');
    expect(memory.retainUser('synthetic line', { session: 'main', cursor: 1 })).toBeNull();
  });

  it('answers an explicit fact with the local state, not with a confirmed save', () => {
    const outbox = new MemoryOutbox(join(dir(), 'outbox.jsonl'));
    const memory = memoryWith(outbox, new ForgetLedger(join(dir(), 'forget.json')), {});
    expect(memory.remember('synthetic preference')).toBe('queued');
    expect(outbox.status().active).toBe(1);
  });
});

describe('the forget ledger', () => {
  it('survives a reopen with its fence and its open tasks', () => {
    const file = join(dir(), 'forget.json');
    const ledger = new ForgetLedger(file);
    const task = ledger.add({ bankId: 'bank-a', endpoint: 'http://a', documentId: 'doc-1', reason: 'forget' })!;
    expect(task.state).toBe('pending');
    const reopened = new ForgetLedger(file);
    expect(reopened.get(task.id)?.state).toBe('pending');
    expect(reopened.forgotten('bank-a', 'http://a', 'doc-1')).toBe(true);
    expect(reopened.forgotten('bank-a', 'http://a', 'doc-2')).toBe(false);
    expect(reopened.epoch('bank-a', 'http://a')).toBe(1);
    expect(reopened.markFailed(task.id, 'offline')).toBe(true);
    expect(reopened.status()).toMatchObject({ pending: 0, failed: 1, tombstones: 1 });
    expect(reopened.markDone(task.id)).toBe(true);
    expect(reopened.outcome([task.id])).toEqual({ done: 1, pending: 0, failed: 0 });
  });

  it('imports the previous file of deletion tasks', () => {
    const file = join(dir(), 'forget.json');
    const at = '2026-10-01T00:00:00.000Z';
    // The previous version wrote a bare array; the import keeps those tasks, and the fence starts
    // empty because the old file never recorded one.
    writeFileSync(file, JSON.stringify([{ id: 'old', bankId: 'bank-a', endpoint: 'http://a', documentId: 'doc-old', reason: 'forget', state: 'pending', attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at }]));
    const imported = new ForgetLedger(file);
    expect(imported.get('old')?.state).toBe('pending');
    expect(imported.forgotten('bank-a', 'http://a', 'doc-old')).toBe(false);
    expect(imported.add({ bankId: 'bank-a', endpoint: 'http://a', documentId: 'doc-new', reason: 'forget' })?.state).toBe('pending');
    expect(imported.forgotten('bank-a', 'http://a', 'doc-new')).toBe(true);
  });

  it('repeats a deletion once when the source had a retain in flight', () => {
    let now = new Date('2026-10-27T00:00:00.000Z');
    const ledger = new ForgetLedger(join(dir(), 'forget.json'), { now: () => now });
    const task = ledger.add({ bankId: 'bank-a', endpoint: 'http://a', documentId: 'doc-1', operationId: 'op-1', reason: 'forget' })!;
    ledger.markDone(task.id);
    expect(ledger.get(task.id)?.state).toBe('pending');
    expect(ledger.unresolved('bank-a', 'http://a')).toBe(1);
    now = new Date(now.getTime() + VERIFY_DELAY_MS + 1);
    expect(ledger.due(now, 10)).toHaveLength(1);
    ledger.markDone(task.id);
    expect(ledger.get(task.id)?.state).toBe('done');
    expect(ledger.unresolved('bank-a', 'http://a')).toBe(0);
  });
});

describe('remote deletion tasks', () => {
  it('keeps an offline deletion pending and deletes it after the service returns', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    outbox.add(item({ documentId: 'trip' }));
    let deletes = 0;
    const client: FakeClient = { deleteDocument: async () => { deletes += 1; } };
    const memory = memoryWith(outbox, ledger, client);
    memory.unavailableUntil = Date.now() + 60_000;
    const result = await memory.forget('trip');
    expect(result).toMatchObject({ local: 1, deleted: 0, pending: 1, failed: 0 });
    expect(deletes).toBe(0);
    memory.unavailableUntil = 0;
    await memory.drain();
    expect(deletes).toBe(1);
    expect(ledger.status()).toMatchObject({ pending: 0, failed: 0, done: 1 });
  });

  it('deletes only the named source event', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    outbox.add(item({ documentId: 'birthday', content: 'synthetic birthday' }));
    outbox.add(item({ documentId: 'preference', content: 'unrelated synthetic preference' }));
    let deletes = 0;
    const memory = memoryWith(outbox, ledger, {
      recall: async () => ({ results: [] }),
      deleteDocument: async () => { deletes += 1; },
    });
    const result = await memory.forget('synthetic birthday');
    expect(result).toMatchObject({ local: 1, deleted: 1, pending: 0, failed: 0 });
    expect(deletes).toBe(1);
    expect(outbox.status().active).toBe(1);
    expect([...outbox.matching((entry) => entry.state === 'pending')].map((entry) => entry.documentId)).toContain('preference');
  });

  it('removes experience policies linked to the exact forgotten source document', async () => {
    const root = dir();
    const cards = new ExperienceCards(join(root, 'experience-cards'));
    const created = cards.create({ title: 'Quiet coding time', situation: 'The person is programming.', lesson: 'Wait before routine interruptions.', scope: 'proactive_speech', sourceIds: ['user:focus'] });
    if (!created.ok) throw new Error(created.errors.join('; '));
    cards.transition(created.card.id, 'approved');
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const memory = memoryWith(outbox, ledger, { deleteDocument: async () => {} });
    memory.setLifecycleHooks({
      forgetSources: (ids) => { cards.removeBySource(ids); },
      clearDerived: () => { cards.clear(); },
    });

    const result = await memory.forgetDocument('user:focus');
    expect(result).toMatchObject({ deleted: 1, pending: 0, failed: 0 });
    expect(cards.approvedContext()).toBe('');
    expect(cards.list()).toEqual([]);
  });
});

describe('the fence covers reads and writes', () => {
  it('does not return a source the service hands back after the deletion', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    outbox.add(item({ documentId: 'trip', content: 'synthetic trip to Hangzhou' }));
    const client: FakeClient = {
      recall: async () => ({ results: [{ id: 'm1', text: 'synthetic trip to Hangzhou', type: 'observation', document_id: 'trip' }] }),
      deleteDocument: async () => {},
    };
    const memory = memoryWith(outbox, ledger, client);
    expect(await memory.searchResults('trip')).toHaveLength(1);
    await memory.forget('synthetic trip');
    expect(await memory.searchResults('trip')).toEqual([]);
  });

  it('drops a result with no source while a deletion is unresolved', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const client: FakeClient = {
      recall: async () => ({ results: [{ id: 'm1', text: 'synthetic observation', type: 'observation', document_id: null }] }),
      deleteDocument: async () => { throw new Error('offline'); },
    };
    const memory = memoryWith(outbox, ledger, client);
    await memory.forgetDocument('remote-only');
    expect(ledger.unresolved('bank-a', 'http://hindsight.test')).toBe(1);
    expect(await memory.searchResults('anything')).toEqual([]);
    expect(await memory.sessionBriefing()).toEqual({ text: '', source: 'none' });
  });

  it('does not queue a redelivered event whose source was forgotten', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const memory = memoryWith(outbox, ledger, { deleteDocument: async () => {} });
    const typed = memory as unknown as {
      retainUser: (text: string, meta: { session: string; cursor: number }) => string | null;
      forgetDocument: (documentId: string) => Promise<unknown>;
    };
    const documentId = typed.retainUser('synthetic line', { session: 'main', cursor: 7 });
    expect(documentId).toBeTruthy();
    await typed.forgetDocument(documentId!);
    expect(typed.retainUser('synthetic line', { session: 'main', cursor: 7 })).toBeNull();
    expect(outbox.status().active).toBe(0);
  });

  it('clears the portraits on forget and serves none until they are rebuilt', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    let cleared = false;
    const client: FakeClient = {
      deleteDocument: async () => {},
      getMentalModel: async () => ({ content: cleared ? '' : 'The person plans to move to Hangzhou.' }),
      clearMentalModel: async () => { cleared = true; return {}; },
      recall: async () => ({ results: [] }),
    };
    const memory = memoryWith(outbox, ledger, client);
    expect((await memory.sessionBriefing()).text).toContain('Hangzhou');
    await memory.forgetDocument('trip');
    expect(cleared).toBe(true);
    expect(await memory.sessionBriefing()).toEqual({ text: '', source: 'none' });
    expect(memory.settled()).toBe(true);
  });

  it('refuses a reflection that ran across a forget', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    let answer!: (value: { text: string }) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((done) => { started = done; });
    const client: FakeClient = {
      deleteDocument: async () => {},
      getMentalModel: async () => ({ content: '' }),
      clearMentalModel: async () => ({}),
      recall: async () => ({ results: [] }),
      reflect: async () => {
        started();
        return new Promise((done) => { answer = done; });
      },
    };
    const memory = memoryWith(outbox, ledger, client);
    const active = memory.reflect('What did the person plan?');
    await startedPromise;
    await memory.forgetDocument('trip');
    answer({ text: 'The person plans to move to Hangzhou.' });
    expect(await active).toBe('');
  });
});
