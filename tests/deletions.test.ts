import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeletionQueue } from '../core/memory/deletions.ts';
import { MemoryOutbox, type RetainItem } from '../core/memory/outbox.ts';
import { OutboxDelivery } from '../core/memory/delivery.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'coo-deletions-'));
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

function memoryWith(_root: string, outbox: MemoryOutbox, deletions: DeletionQueue, client: Record<string, unknown>) {
  const memory = new HindsightMemory() as unknown as {
    config: Record<string, unknown>;
    client: Record<string, unknown>;
    outbox: MemoryOutbox;
    deletions: DeletionQueue;
    delivery: OutboxDelivery;
    ready: boolean;
    unavailableUntil: number;
    drain: () => Promise<void>;
    forget: (query: string) => Promise<{ local: number; deleted: number; pending: number; failed: number }>;
    forgetDocument: (documentId: string) => Promise<{ local: number; deleted: number; pending: number; failed: number }>;
    setLifecycleHooks: (hooks: { forgetSources: (sourceIds: readonly string[]) => void; clearDerived: () => void }) => void;
  };
  memory.config = {
    enabled: true,
    bankId: 'bank-a',
    apiUrl: 'http://hindsight.test',
    recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] },
    retain: { async: true },
  };
  memory.client = client;
  memory.outbox = outbox;
  memory.deletions = deletions;
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
});

describe('remote deletion tasks', () => {
  it('survives a reopen and reports done, pending and failed separately', () => {
    const file = join(dir(), 'memory-deletions.json');
    const queue = new DeletionQueue(file);
    const task = queue.add({ bankId: 'bank-a', endpoint: 'http://a', documentId: 'doc-1', reason: 'forget' })!;
    expect(task.state).toBe('pending');
    const reopened = new DeletionQueue(file);
    expect(reopened.get(task.id)?.state).toBe('pending');
    expect(reopened.markFailed(task.id, 'offline')).toBe(true);
    expect(reopened.status()).toMatchObject({ pending: 0, failed: 1 });
    expect(reopened.markDone(task.id)).toBe(true);
    expect(reopened.outcome([task.id])).toEqual({ done: 1, pending: 0, failed: 0 });
  });

  it('keeps an offline deletion pending and deletes it after the service returns', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const deletions = new DeletionQueue(join(root, 'deletions.json'));
    outbox.add(item({ documentId: 'trip' }));
    let deletes = 0;
    const client = { deleteDocument: async () => { deletes += 1; } };
    const memory = memoryWith(root, outbox, deletions, client);
    memory.unavailableUntil = Date.now() + 60_000;
    const result = await memory.forget('trip');
    expect(result).toMatchObject({ local: 1, deleted: 0, pending: 1, failed: 0 });
    expect(deletes).toBe(0);
    memory.unavailableUntil = 0;
    await memory.drain();
    expect(deletes).toBe(1);
    expect(deletions.status()).toMatchObject({ pending: 0, failed: 0, done: 1 });
  });

  it('deletes only the named source event', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const deletions = new DeletionQueue(join(root, 'deletions.json'));
    outbox.add(item({ documentId: 'birthday', content: 'synthetic birthday' }));
    outbox.add(item({ documentId: 'preference', content: 'unrelated synthetic preference' }));
    let deletes = 0;
    const memory = memoryWith(root, outbox, deletions, {
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
    const deletions = new DeletionQueue(join(root, 'deletions.json'));
    const memory = memoryWith(root, outbox, deletions, { deleteDocument: async () => {} });
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
