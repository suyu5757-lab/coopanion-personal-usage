import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryOutbox, type RetainItem } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';
import { OutboxDelivery, DeliveryError, type DeliveryOps } from '../core/memory/delivery.ts';
import { isForgetRequest, isMemoryForgetRequest, planRecall } from '../core/memory/router.ts';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'coo-outbox-'));
  roots.push(root);
  return root;
};
const file = () => join(temp(), 'memory-outbox.jsonl');
let next = 0;
let docs = 0;
const id = () => `id-${++next}`;

const item = (over: Partial<RetainItem> = {}): RetainItem => ({
  bankId: 'bank-test',
  endpoint: 'http://hindsight.test',
  documentId: `doc-${++docs}`,
  content: 'The person likes jasmine tea.',
  context: 'test',
  tags: ['scope:life', 'source:chat'],
  priority: 'normal',
  ...over,
});

afterEach(() => {
  closeMemoryStateStores();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the retain outbox', () => {
  it('keeps a queued item across a reopen and reuses its operation id', () => {
    const path = file();
    const first = new MemoryOutbox(path, { newId: id });
    expect(first.add(item({ documentId: 'doc-a' }))).toBe('queued');
    const queued = first.due(new Date(), 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.operationId).toBe('id-2');
    first.markSent(queued[0]!.id, queued[0]!.operationId);

    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path, { newId: id });
    expect(reopened.sent(10)).toHaveLength(1);
    expect(reopened.sent(10)[0]!.operationId).toBe('id-2');
  });

  it('persists a sending state before waiting for the retain acknowledgement', async () => {
    const path = file();
    const outbox = new MemoryOutbox(path);
    outbox.add(item());
    const queued = outbox.due(new Date(), 1)[0]!;
    let began!: () => void;
    let finish!: (result: { async: boolean; operationId: string | null }) => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const delivery = new OutboxDelivery(outbox, {
      retain: async () => {
        began();
        return await new Promise((resolve) => { finish = resolve; });
      },
      status: async () => 'processing',
      verify: async () => true,
      retry: async () => {},
      cancel: async () => {},
    });

    const draining = delivery.drain();
    await started;
    expect(outbox.get(queued.id)?.state).toBe('sending');
    const reopened = new MemoryOutbox(path);
    expect(reopened.sent(1)[0]).toMatchObject({ id: queued.id, operationId: queued.operationId, state: 'sending' });
    finish({ async: true, operationId: queued.operationId });
    await draining;
    expect(outbox.get(queued.id)?.state).toBe('sent');
  });

  it('drops the payload only after the source document is verified', () => {
    const path = file();
    const outbox = new MemoryOutbox(path);
    outbox.add(item());
    const queued = outbox.due(new Date(), 1)[0]!;
    outbox.markDone(queued.id);
    outbox.markVerified(queued.id);
    expect(outbox.status().active).toBe(0);
    expect(JSON.stringify(outbox.stateStore?.loadOutbox())).not.toContain('jasmine tea');
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path);
    expect(reopened.get(queued.id)?.state).toBe('verified');
    expect(reopened.get(queued.id)?.content).toBe('');
  });

  it('backs off a failed send and stops after the attempt cap', () => {
    let now = new Date('2026-10-27T00:00:00.000Z');
    const outbox = new MemoryOutbox(file(), { now: () => now });
    outbox.add(item());
    const queued = outbox.due(now, 1)[0]!;
    outbox.markFailed(queued.id, 'network down');
    expect(outbox.due(now, 10)).toHaveLength(0);
    now = new Date(now.getTime() + 60_000);
    expect(outbox.due(now, 10)).toHaveLength(1);
    for (let i = 0; i < 8; i++) outbox.markFailed(queued.id, 'still down');
    expect(outbox.get(queued.id)?.state).toBe('dead');
  });

  it('rejects ordinary items when full but still accepts an explicit memory', () => {
    const outbox = new MemoryOutbox(file(), { maxActive: 2, maxTotal: 3 });
    expect(outbox.add(item())).toBe('queued');
    expect(outbox.add(item())).toBe('queued');
    expect(outbox.add(item())).toBe('full');
    expect(outbox.add(item({ priority: 'critical' }))).toBe('queued');
    expect(outbox.status().full).toBe(true);
  });

  it('does not revive an item that was cancelled while its retain was in flight', () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'in-flight' }));
    const queued = outbox.due(new Date(), 1)[0]!;
    outbox.cancelMatching((entry) => entry.id === queued.id, 'forget');
    outbox.markSent(queued.id, queued.operationId);
    outbox.markDone(queued.id);
    expect(outbox.get(queued.id)?.state).toBe('cancelled');
    expect(outbox.status().active).toBe(0);
  });

  it('cancels matching queued items for a forget request', () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'trip', content: 'The person plans to go to Hangzhou.' }));
    outbox.add(item({ documentId: 'tea', content: 'The person likes jasmine tea.' }));
    const cancelled = outbox.cancelMatching((entry) => entry.content.includes('Hangzhou'), 'forget');
    expect(cancelled.map((entry) => entry.documentId)).toEqual(['trip']);
    expect(outbox.get(cancelled[0]!.id)?.content).toBe('');
    expect(outbox.status().active).toBe(1);
  });

  it('refuses a legacy import with a malformed item and leaves it available for review', () => {
    const path = file();
    const at = new Date().toISOString();
    const legacy = {
      ...item({ documentId: 'kept' }),
      id: 'legacy-event', operationId: 'legacy-operation', state: 'pending', attempts: 0,
      nextAttemptAt: at, createdAt: at, updatedAt: at,
    };
    const legacyLog = `${JSON.stringify({ v: 1, item: legacy })}\n{"v":1,"item":{"broken":true}}\n`;
    writeFileSync(path, legacyLog);
    const reopened = new MemoryOutbox(path);

    expect(reopened.readable()).toBe(false);
    expect(reopened.status().persistenceError).toContain('invalid legacy retain outbox at line 2');
    expect(openMemoryStateStore(path).imported('outbox-v1')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(legacyLog);
  });

  it('reports the oldest pending item and the last error', () => {
    const now = new Date('2026-10-27T00:00:00.000Z');
    const outbox = new MemoryOutbox(file(), { now: () => now });
    outbox.add(item());
    const queued = outbox.due(now, 1)[0]!;
    outbox.markFailed(queued.id, 'service unavailable');
    const status = outbox.status();
    expect(status.oldestPendingAt).toBe(now.toISOString());
    expect(status.lastError).toBe('service unavailable');
  });

  it('preserves expired terminal operations in read-only validation mode', () => {
    let now = new Date('2026-10-27T00:00:00.000Z');
    const path = file();
    const outbox = new MemoryOutbox(path, { now: () => now });
    outbox.add(item({ documentId: 'verified-source' }));
    const verified = outbox.due(now, 1)[0]!;
    outbox.markDone(verified.id);
    outbox.markVerified(verified.id);
    outbox.add(item({ documentId: 'cancelled-source' }));
    const cancelled = outbox.due(now, 1)[0]!;
    outbox.cancelMatching((entry) => entry.id === cancelled.id, 'fixture');

    now = new Date(now.getTime() + 8 * 86_400_000);
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path, { now: () => now, preserveFinished: true });

    expect(reopened.get(verified.id)?.state).toBe('verified');
    expect(reopened.get(cancelled.id)?.state).toBe('cancelled');
    expect(reopened.stateStore?.loadOutbox()).toHaveLength(2);
  });

  it('preserves terminal delivery audit rows by default, not only in read-only mode', () => {
    let now = new Date('2026-10-27T00:00:00.000Z');
    const path = file();
    const outbox = new MemoryOutbox(path, { now: () => now });
    outbox.add(item({ documentId: 'verified-source' }));
    const verified = outbox.due(now, 1)[0]!;
    outbox.markDone(verified.id);
    outbox.markVerified(verified.id);
    outbox.add(item({ documentId: 'cancelled-source' }));
    const cancelled = outbox.due(now, 1)[0]!;
    outbox.cancelMatching((entry) => entry.id === cancelled.id, 'fixture');

    now = new Date(now.getTime() + 8 * 86_400_000);
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path, { now: () => now });

    expect(reopened.get(verified.id)?.state).toBe('verified');
    expect(reopened.get(cancelled.id)?.state).toBe('cancelled');
    expect(reopened.stateStore?.loadOutbox()).toHaveLength(2);
  });

  it('keeps a dead critical fact with its payload past the audit window', () => {
    let now = new Date('2026-10-27T00:00:00.000Z');
    const path = file();
    const outbox = new MemoryOutbox(path, { now: () => now });
    outbox.add(item({ priority: 'critical' }));
    const queued = outbox.due(now, 1)[0]!;
    for (let i = 0; i < 8; i++) outbox.markFailed(queued.id, 'still down');
    expect(outbox.get(queued.id)?.state).toBe('dead');
    expect(outbox.status()).toMatchObject({ dead: 1, deadRetained: 1, active: 1 });
    now = new Date(now.getTime() + 8 * 86_400_000);
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path, { now: () => now });
    expect(reopened.get(queued.id)?.content).toContain('jasmine tea');
    expect(reopened.status()).toMatchObject({ dead: 1, deadRetained: 1, active: 1 });
  });
});

describe('outbox persistence and recovery', () => {
  it('does not acknowledge an item when the append fails', () => {
    const blocked = join(temp(), 'not-a-directory');
    writeFileSync(blocked, 'file');
    const path = join(blocked, 'outbox.jsonl');
    const outbox = new MemoryOutbox(path);
    expect(outbox.add(item())).toBe('persistence-error');
    expect(outbox.status().active).toBe(0);
    expect(outbox.status().persistenceError).toContain('memory database');
    expect(new MemoryOutbox(path).status().active).toBe(0);
  });

  it('does not publish a state change when the append fails', () => {
    const path = file();
    const outbox = new MemoryOutbox(path);
    outbox.add(item());
    const queued = outbox.due(new Date(), 1)[0]!;
    closeMemoryStateStores();
    rmSync(dirname(path), { recursive: true });
    expect(outbox.markSent(queued.id, 'operation')).toBe(false);
    expect(outbox.get(queued.id)?.state).toBe('pending');
    expect(outbox.status().persistenceError).toContain('could not write');
  });

  it('isolates an old item that has no bank/endpoint binding', () => {
    const path = file();
    const at = new Date().toISOString();
    const legacy = { ...item({ documentId: 'legacy' }) };
    delete legacy.bankId;
    delete legacy.endpoint;
    writeFileSync(path, `${JSON.stringify({ v: 1, item: {
      ...legacy, id: 'legacy-id', operationId: 'legacy-operation', state: 'pending',
      attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at,
    } })}\n`);
    const outbox = new MemoryOutbox(path);
    expect(outbox.status().orphaned).toBe(1);
    expect(outbox.status().active).toBe(0);
    expect(outbox.due(new Date(), 10)).toHaveLength(0);
  });

  it('does not submit a later item after it was cancelled during the first send', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'first' }));
    outbox.add(item({ documentId: 'second' }));
    const submitted: string[] = [];
    const delivery = new OutboxDelivery(outbox, {
      retain: async (entry) => {
        submitted.push(entry.documentId);
        if (entry.documentId === 'first') outbox.cancelMatching((candidate) => candidate.documentId === 'second', 'forget');
        return { async: true, operationId: entry.operationId };
      },
      status: async () => 'processing', verify: async () => true, retry: async () => {}, cancel: async () => {},
    });
    await delivery.drain();
    expect(submitted).toEqual(['first']);
    expect(outbox.status().cancelled).toBe(1);
  });

  it('keeps a critical payload after permanent failure and can requeue it', () => {
    const path = file();
    const outbox = new MemoryOutbox(path);
    outbox.add(item({ documentId: 'critical', content: 'critical fact', priority: 'critical' }));
    const entry = outbox.due(new Date(), 1)[0]!;
    for (let i = 0; i < 8; i++) outbox.markFailed(entry.id, 'temporary network outage');
    expect(outbox.get(entry.id)?.state).toBe('dead');
    expect(outbox.get(entry.id)?.content).toBe('critical fact');
    const reopened = new MemoryOutbox(path);
    expect(reopened.get(entry.id)?.content).toBe('critical fact');
    expect(reopened.retryDead(entry.id)).toBe(true);
    expect(reopened.get(entry.id)?.state).toBe('failed');
    expect(reopened.due(new Date(), 10).map((candidate) => candidate.id)).toContain(entry.id);
  });

  it('isolates an item whose bank or endpoint changed and rebinds only explicitly', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'old-bank', bankId: 'bank-a', endpoint: 'http://a.test' }));
    const queued = outbox.due(new Date(), 1)[0]!;
    const retained: string[] = [];
    const delivery = new OutboxDelivery(outbox, {
      retain: async (entry) => { retained.push(entry.bankId ?? ''); return { async: true, operationId: entry.operationId }; },
      status: async () => 'processing', verify: async () => true, retry: async () => {}, cancel: async () => {},
    }, { target: () => ({ bankId: 'bank-b', endpoint: 'http://b.test' }) });
    await delivery.drain();
    expect(retained).toEqual([]);
    expect(outbox.get(queued.id)?.state).toBe('orphaned');
    expect(outbox.rebind(queued.id, 'bank-b', 'http://b.test')).toBe(true);
    expect(outbox.get(queued.id)?.bankId).toBe('bank-b');
    await delivery.drain();
    expect(retained).toEqual(['bank-b']);
    expect(outbox.get(queued.id)?.state).toBe('sent');
  });

  it('backs off a failed extraction instead of polling it every drain', () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'failed-extraction' }));
    const entry = outbox.due(new Date(), 1)[0]!;
    outbox.markSent(entry.id, 'operation');
    expect(outbox.sent(8, new Date())).toHaveLength(1);
    outbox.noteRetry(entry.id, 'extraction failed', { count: true });
    expect(outbox.sent(8, new Date())).toHaveLength(0);
    expect(outbox.sent(8, new Date(Date.now() + 61_000))).toHaveLength(1);
  });

  it('polls a later operation instead of starving behind eight processing ones', async () => {
    const outbox = new MemoryOutbox(file());
    for (let i = 0; i < 9; i++) {
      outbox.add(item({ documentId: `poll-${i}` }));
      const entry = outbox.due(new Date(), 1)[0]!;
      outbox.markSent(entry.id, entry.operationId);
    }
    const last = outbox.sent(9)[8]!;
    const polled = new Set<string>();
    const delivery = new OutboxDelivery(outbox, {
      retain: async () => ({ async: true, operationId: null }),
      status: async (entry) => {
        polled.add(entry.operationId);
        return entry.operationId === last.operationId ? 'completed' : 'processing';
      },
      verify: async () => true,
      retry: async () => {}, cancel: async () => {},
    });
    for (let i = 0; i < 5; i++) await delivery.drain();
    expect(polled.size).toBe(9);
    expect(outbox.get(last.id)?.state).toBe('verified');
  });
});

describe('the outbox delivery worker', () => {
  const ops = (over: Partial<DeliveryOps> = {}): DeliveryOps & { retain: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> } => ({
    retain: vi.fn(async () => ({ async: true, operationId: 'op-1' })),
    status: vi.fn(async () => 'completed' as const),
    verify: vi.fn(async () => true),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    ...over,
  }) as never;

  it('does not mark an async retain done when the server only accepted it', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item());
    const fake = ops({
      status: vi.fn(async () => 'processing' as const),
    });
    const delivery = new OutboxDelivery(outbox, fake);
    await delivery.drain();
    expect(outbox.status().sent).toBe(1);
    expect(outbox.status().active).toBe(1);
    fake.status.mockResolvedValueOnce('completed');
    await delivery.drain();
    expect(outbox.status().sent).toBe(0);
    expect(outbox.status().verified).toBe(1);
    expect(outbox.status().active).toBe(0);
  });

  it('keeps operation completion separate from source read-back verification', async () => {
    let now = new Date('2026-10-27T00:00:00.000Z');
    const outbox = new MemoryOutbox(file(), { now: () => now });
    outbox.add(item());
    const fake = ops({
      status: vi.fn(async () => 'completed' as const),
      verify: vi.fn(async () => false),
    });
    const delivery = new OutboxDelivery(outbox, fake, { now: () => now });

    await delivery.drain();
    expect(outbox.status()).toMatchObject({ completed: 1, unverified: 1, verified: 0, active: 1 });
    expect(outbox.status().lastError).toContain('no matching readable source document');

    now = new Date(now.getTime() + 10_001);
    fake.verify.mockResolvedValueOnce(true);
    await delivery.drain();
    expect(outbox.status()).toMatchObject({ completed: 0, verified: 1 });
  });

  it('retries the same operation instead of submitting a second retain', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item());
    const fake = ops({ retain: vi.fn(async () => { throw new DeliveryError('offline'); }) });
    const delivery = new OutboxDelivery(outbox, fake);
    await delivery.drain();
    expect(fake.retain).toHaveBeenCalledTimes(1);
    const operation = fake.retain.mock.calls[0]![0].operationId;
    expect(outbox.status().active).toBe(1);
    fake.retain.mockResolvedValueOnce({ async: true, operationId: 'op-2' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    // the failed item is not due until its backoff passes
    await delivery.drain();
    expect(fake.retain).toHaveBeenCalledTimes(1);
    expect(outbox.status().active).toBe(1);
    expect(operation).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cancels the operation if the item was cancelled while the retain was in flight', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'in-flight-delivery' }));
    const queued = outbox.due(new Date(), 1)[0]!;
    const fake = ops({
      retain: vi.fn(async () => {
        outbox.cancelMatching((entry) => entry.id === queued.id, 'forget');
        return { async: true, operationId: 'op-late' };
      }),
    });
    const delivery = new OutboxDelivery(outbox, fake);
    await delivery.drain();
    expect(fake.cancel).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'op-late' }));
    expect(outbox.get(queued.id)?.state).toBe('cancelled');
    expect(outbox.status().sent).toBe(0);
  });

  it('marks a synchronous retain done at once', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item());
    const delivery = new OutboxDelivery(outbox, ops({ retain: vi.fn(async () => ({ async: false, operationId: null })) }));
    await delivery.drain();
    expect(outbox.status().active).toBe(0);
    expect(outbox.status().sent).toBe(0);
    expect(outbox.status().verified).toBe(1);
  });

  it('asks the server to retry a failed extraction and keeps polling', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item());
    const fake = ops({ status: vi.fn(async () => 'failed' as const) });
    const delivery = new OutboxDelivery(outbox, fake);
    await delivery.drain();
    expect(fake.retry).toHaveBeenCalledOnce();
    expect(outbox.status().sent).toBe(1);
    expect(outbox.status().active).toBe(1);
  });
});

describe('memory forget requests', () => {
  it('tells a request not to remember apart from ordinary forgetting', () => {
    expect(isMemoryForgetRequest('不要记这件事')).toBe(true);
    expect(isMemoryForgetRequest('忘记刚刚那件事')).toBe(true);
    expect(isMemoryForgetRequest('forget the trip')).toBe(true);
    expect(isMemoryForgetRequest('我忘了带钥匙')).toBe(false);
    expect(isMemoryForgetRequest('我把钥匙忘在办公室了')).toBe(false);
    expect(isMemoryForgetRequest('forget-me-nots are pretty')).toBe(false);
    expect(isMemoryForgetRequest('不要记错我的生日')).toBe(false);
    expect(isForgetRequest('不要记错我的生日')).toBe(false);
    expect(isMemoryForgetRequest('你忘了我的名字吗')).toBe(false);
  });
});

describe('recall routing', () => {
  it('skips Hindsight for greetings and forget requests', () => {
    expect(planRecall('你好').route).toBe('fast');
    expect(planRecall('晚安~').route).toBe('fast');
    expect(planRecall('不要记这件事').route).toBe('fast');
    expect(planRecall('忘记刚刚那件事').route).toBe('fast');
  });

  it('uses a deeper recall for dated and corrected facts', () => {
    expect(planRecall('我们去年几月去的杭州？').route).toBe('deep');
    expect(planRecall('你还记得我上次说的那个计划吗').route).toBe('deep');
    expect(planRecall('我们昨天聊了什么').route).toBe('deep');
    expect(planRecall('I changed my mind about the trip').route).toBe('deep');
    expect(planRecall('What did we talk about yesterday?').route).toBe('deep');
    expect(planRecall('你忘了我们上次约好的事情吗？').route).toBe('deep');
    expect(planRecall('你忘了我的名字吗？').route).toBe('deep');
  });

  it('uses a standard recall for ordinary conversation', () => {
    expect(planRecall('你觉得我适合养猫吗？').route).toBe('standard');
    expect(planRecall('我喜欢什么').route).toBe('standard');
    expect(planRecall('我最喜欢吃什么').route).toBe('standard');
    expect(planRecall('我的名字是什么').route).toBe('standard');
    expect(planRecall('我们一起计划一下下个月的旅行吧，看看去哪里比较好，顺便想想住哪里、吃什么、几天合适').route).toBe('standard');
  });

  it('skips recall for a short new statement; the portrait is already in context', () => {
    expect(planRecall('今天工作有点累').route).toBe('fast');
    expect(planRecall('I had noodles for lunch').route).toBe('fast');
    expect(planRecall('我写程序的时候别总来打扰').route).toBe('fast');
    expect(planRecall('昨天我买了一个新键盘').route).toBe('fast');
    expect(planRecall('I bought a keyboard yesterday').route).toBe('fast');
  });

  it('scales the configured budget instead of ignoring it', () => {
    const deep = planRecall('去年的事', { timeoutMs: 500, maxTokens: 300, budget: 'high' });
    expect(deep.timeoutMs).toBe(1600);
    expect(deep.maxTokens).toBe(1200);
    expect(deep.budget).toBe('high');
    const standard = planRecall('What should we do tomorrow?', { timeoutMs: 500, maxTokens: 300, budget: 'low' });
    expect(standard.timeoutMs).toBe(500);
    expect(standard.maxTokens).toBe(300);
  });
});


describe('scoped delivery isolation and late callbacks', () => {
  it('preserves held historical operations across restart without starving a new eligible write', async () => {
    const path = file();
    const outbox = new MemoryOutbox(path);
    outbox.add(item({ documentId: 'historical-held' }));
    const held = outbox.due(new Date(), 1)[0]!;
    const before = structuredClone(outbox.get(held.id));
    outbox.add(item({ documentId: 'new-eligible' }));
    const delivered: string[] = [];
    const operations: DeliveryOps = {
      retain: async entry => { delivered.push(entry.documentId); return { async: false, operationId: entry.operationId }; },
      status: async () => 'completed', verify: async () => true, retry: async () => {}, cancel: async () => {},
    };
    const options = { batch: 1, held: (entry: { operationId: string }) => entry.operationId === held.operationId };
    const worker = new OutboxDelivery(outbox, operations, options);
    expect((await worker.drainScoped({ documentId: held.documentId })).status).toBe('blocked');
    await worker.drain();
    expect(delivered).toEqual(['new-eligible']);
    expect(outbox.get(held.id)).toEqual(before);
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path);
    await new OutboxDelivery(reopened, operations, options).drain();
    expect(reopened.get(held.id)).toEqual(before);
    expect(delivered).toEqual(['new-eligible']);
  });

  it('serializes scoped work with the background worker and polls the same identity after restart', async () => {
    const path = file();
    const outbox = new MemoryOutbox(path);
    outbox.add(item({ documentId: 'single-target' }));
    const queued = outbox.due(new Date(), 1)[0]!;
    let finish!: (value: { async: boolean; operationId: string | null }) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const delivery = new OutboxDelivery(outbox, {
      retain: async () => { started(); return new Promise((resolve) => { finish = resolve; }); },
      status: async () => 'processing', verify: async () => false, retry: async () => {}, cancel: async () => {},
    }, { target: () => ({ bankId: queued.bankId!, endpoint: queued.endpoint! }) });
    const first = delivery.drainScoped({ documentId: queued.documentId });
    await began;
    expect((await delivery.drainScoped({ documentId: queued.documentId })).status).toBe('blocked');
    expect(await delivery.drain()).toEqual({ submitted: 0, completed: 0, verified: 0, failed: 0 });
    finish({ async: true, operationId: queued.operationId });
    await first;
    closeMemoryStateStores();
    const reopened = new MemoryOutbox(path);
    const calls: string[] = [];
    const recovery = new OutboxDelivery(reopened, {
      retain: async () => { throw new Error('must poll the persisted operation first'); },
      status: async (entry) => { calls.push(entry.operationId); return 'completed'; },
      verify: async () => true, retry: async () => {}, cancel: async () => {},
    }, { target: () => ({ bankId: queued.bankId!, endpoint: queued.endpoint! }) });
    expect((await recovery.drainScoped({ documentId: queued.documentId })).status).toBe('verified');
    expect(calls).toEqual([queued.operationId]);
  });

  it('blocks a caller-selected endpoint that differs from the configured endpoint', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'other-target', endpoint: 'http://other.test' }));
    const delivery = new OutboxDelivery(outbox, {
      retain: async () => { throw new Error('wrong endpoint was contacted'); }, status: async () => 'completed',
      verify: async () => true, retry: async () => {}, cancel: async () => {},
    }, { target: () => ({ bankId: 'bank-test', endpoint: 'http://hindsight.test' }) });
    expect((await delivery.drainScoped({ documentId: 'other-target', bankId: 'bank-test', endpoint: 'http://other.test' })).status).toBe('blocked');
  });

  it('retries a failed scoped extraction using the existing operation identity', async () => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'failed-extraction' }));
    const queued = outbox.due(new Date(), 1)[0]!;
    outbox.markSent(queued.id, queued.operationId);
    let recovered = false;
    const retried: string[] = [];
    const delivery = new OutboxDelivery(outbox, {
      retain: async () => { throw new Error('must retry existing operation'); },
      status: async () => recovered ? 'completed' : 'failed',
      verify: async () => recovered,
      retry: async (entry) => { retried.push(entry.operationId); recovered = true; }, cancel: async () => {},
    }, { target: () => ({ bankId: 'bank-test', endpoint: 'http://hindsight.test' }) });
    expect((await delivery.drainScoped({ documentId: queued.documentId })).status).toBe('sent');
    expect((await delivery.drainScoped({ documentId: queued.documentId })).status).toBe('verified');
    expect(retried).toEqual([queued.operationId]);
  });

  it.each(['status', 'verify'] as const)('does not report success after Forget during %s', async (phase) => {
    const outbox = new MemoryOutbox(file());
    outbox.add(item({ documentId: 'forget-race' }));
    const queued = outbox.due(new Date(), 1)[0]!;
    outbox.markSent(queued.id, queued.operationId);
    const delivery = new OutboxDelivery(outbox, {
      retain: async () => { throw new Error('already submitted'); },
      status: async () => { if (phase === 'status') outbox.markCancelled(queued.id, 'synthetic Forget'); return 'completed'; },
      verify: async () => { outbox.markCancelled(queued.id, 'synthetic Forget'); return true; },
      retry: async () => {}, cancel: async () => {},
    }, { target: () => ({ bankId: 'bank-test', endpoint: 'http://hindsight.test' }) });
    const result = await delivery.drainScoped({ documentId: queued.documentId });
    expect(result.status).toBe('forgotten');
    expect(result.verified).toBe(false);
    expect(outbox.get(queued.id)?.state).toBe('cancelled');
  });
});
