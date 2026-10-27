import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryOutbox, readLegacyOutbox, requestHashFor, type RetainItem } from '../core/memory/outbox.ts';
import { ForgetLedger, readLegacyForget } from '../core/memory/forget-ledger.ts';
import { closeMemoryStateStores, openMemoryStateStore, type ForgetStateSnapshot } from '../core/memory/state-store.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'coo-memory-state-'));
  roots.push(path);
  return path;
};

const emptyForget: ForgetStateSnapshot = { v: 2, tasks: [], tombstones: [], epochs: {}, stale: [] };
const retainItem = (documentId = 'doc-a'): RetainItem => ({
  bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId, content: 'A synthetic fact.',
  context: 'test', tags: ['scope:life'], priority: 'critical',
});

afterEach(() => {
  closeMemoryStateStores();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('the memory transaction database', () => {
  it('keeps the database and SQLite sidecars private to the current user', () => {
    if (process.platform === 'win32') return;
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('reopens committed requests, fences, deletion work and epochs from disk', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    outbox.add(retainItem());
    const queued = outbox.due(new Date(), 1)[0]!;
    expect(outbox.markSending(queued.id)).toBe(true);
    const task = ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-a', operationId: queued.operationId, reason: 'forget' });
    expect(task?.state).toBe('pending');

    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(path);
    const reopenedOutbox = new MemoryOutbox(reopenedStore);
    const reopenedLedger = new ForgetLedger(reopenedStore);
    expect(reopenedOutbox.sent(1)).toMatchObject([{ id: queued.id, operationId: queued.operationId, state: 'sending' }]);
    expect(reopenedLedger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(true);
    expect(reopenedLedger.unresolved('bank-a', 'http://hindsight.test')).toBe(1);
    expect(reopenedLedger.epoch('bank-a', 'http://hindsight.test')).toBe(1);
  });

  it('deduplicates a source event after verification and rejects a changed replay', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const original = retainItem('user:main:42');
    expect(outbox.add(original)).toBe('queued');
    const item = outbox.due(new Date(), 1)[0]!;
    expect(outbox.markSending(item.id)).toBe(true);
    expect(outbox.markSent(item.id, item.operationId)).toBe(true);
    expect(outbox.markDone(item.id)).toBe(true);
    expect(outbox.markVerified(item.id)).toBe(true);

    expect(outbox.add(original)).toBe('queued');
    expect(outbox.add({ ...original, content: 'A different message reused the same cursor.' })).toBe('persistence-error');
    const database = new DatabaseSync(path);
    expect((database.prepare('SELECT COUNT(*) AS count FROM memory_operations').get() as { count: number }).count).toBe(1);
    database.close();
  });

  it('promotes the existing user event and links a correction without creating another document', async () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    const sourceDocumentId = 'user:main:73';
    outbox.add({
      ...retainItem(sourceDocumentId),
      content: 'The person said to Coo: Remember my corrected office location.',
      priority: 'normal',
      metadata: { source_actor: 'user', kind: 'event', status: 'completed', source_event_id: '73' },
    });
    const memory = new HindsightMemory() as unknown as {
      config: { enabled: boolean; bankId: string; apiUrl: string };
      stateStore: typeof store;
      outbox: MemoryOutbox;
      ledger: ForgetLedger;
      enabled: () => boolean;
      hasSource: (documentId: string) => Promise<boolean>;
      remember: (text: string, meta: { session: string; sourceDocumentId: string }) => string;
      correct: (text: string, sourceIds: readonly string[], meta: { session: string; sourceDocumentId: string }) => Promise<string>;
    };
    memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.stateStore = store;
    memory.outbox = outbox;
    memory.ledger = ledger;
    memory.enabled = () => true;
    memory.hasSource = async () => true;

    expect(memory.remember('Remember my corrected office location.', { session: 'main', sourceDocumentId })).toBe('queued');
    expect(await memory.correct('My office is now on Lake Street.', ['old-office'], { session: 'main', sourceDocumentId })).toBe('queued');
    expect(outbox.matching((item) => item.documentId === sourceDocumentId)).toHaveLength(1);
    expect(outbox.matching((item) => item.documentId === sourceDocumentId)[0]?.priority).toBe('critical');
    expect(store.supersededSources('bank-a', 'http://hindsight.test')).toEqual(new Set());

    const item = outbox.due(new Date(), 1)[0]!;
    outbox.markSending(item.id);
    outbox.markSent(item.id, item.operationId);
    outbox.markDone(item.id);
    expect(outbox.markVerified(item.id)).toBe(true);
    expect(store.supersededSources('bank-a', 'http://hindsight.test')).toEqual(new Set(['old-office']));
    expect(store.currentRevisionSources('bank-a', 'http://hindsight.test')).toEqual(new Set([sourceDocumentId]));
    expect(outbox.status().active).toBe(0);
  });

  it('imports legacy delivery and forget state together and leaves the source files intact', () => {
    const dir = root();
    const outboxFile = join(dir, 'memory-outbox.jsonl');
    const forgetFile = join(dir, 'memory-forget.json');
    const deletionsFile = join(dir, 'memory-deletions.json');
    const now = new Date().toISOString();
    const draft = retainItem('legacy-doc');
    const legacyItem = {
      ...draft, id: 'legacy-event', operationId: 'legacy-operation', requestHash: requestHashFor(draft),
      state: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    const task = {
      id: 'legacy-delete', bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'legacy-forgotten',
      reason: 'legacy', state: 'pending', attempts: 0, verifications: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    writeFileSync(outboxFile, `${JSON.stringify({ v: 1, item: legacyItem })}\n`);
    writeFileSync(forgetFile, JSON.stringify({
      v: 2, tasks: [task], tombstones: [{ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'legacy-forgotten', reason: 'legacy', at: now }],
      epochs: { [JSON.stringify(['bank-a', 'http://hindsight.test'])]: 1 }, stale: [JSON.stringify(['bank-a', 'http://hindsight.test'])],
    }));
    writeFileSync(deletionsFile, JSON.stringify([{ ...task, id: 'older-delete' }]));

    const importedForget = readLegacyForget(forgetFile, deletionsFile);
    const store = openMemoryStateStore(join(dir, 'memory-state.sqlite'));
    store.importLegacy({ outbox: readLegacyOutbox(outboxFile), forget: importedForget.state, forgetDamaged: importedForget.damaged });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    expect(outbox.due(new Date(), 1).map((item) => item.documentId)).toEqual(['legacy-doc']);
    expect(ledger.get('legacy-delete')?.state).toBe('pending');
    expect(ledger.get('older-delete')).toBeNull();
    expect(ledger.forgotten('bank-a', 'http://hindsight.test', 'legacy-forgotten')).toBe(true);
    expect(ledger.stale('bank-a', 'http://hindsight.test')).toBe(true);
    expect(store.imported('outbox-v1')).toBe(true);
    expect(store.imported('forget-v1')).toBe(true);
    expect([outboxFile, forgetFile, deletionsFile].every((file) => existsSync(file))).toBe(true);
  });

  it('keeps a legacy completed operation visible until its source document is read back', () => {
    let now = new Date('2026-10-27T00:00:00.000Z');
    const dir = root();
    const file = join(dir, 'memory-outbox.jsonl');
    const draft = { ...retainItem('legacy-completed'), content: '' };
    const legacyItem = {
      ...draft,
      id: 'legacy-completed-event',
      operationId: 'legacy-completed-operation',
      requestHash: requestHashFor(draft),
      state: 'done',
      attempts: 1,
      verificationAttempts: 0,
      nextAttemptAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    writeFileSync(file, `${JSON.stringify({ v: 1, item: legacyItem })}\n`);
    const outbox = new MemoryOutbox(file, { now: () => now });
    expect(outbox.status()).toMatchObject({ completed: 1, unverified: 1, verified: 0, active: 1 });
    expect(outbox.verificationDue(1, now)).toHaveLength(1);

    now = new Date(now.getTime() + 8 * 86_400_000);
    expect(outbox.compact()).toBe(true);
    expect(outbox.get('legacy-completed-event')?.state).toBe('done');
    expect(outbox.markVerified('legacy-completed-event')).toBe(true);
    expect(outbox.status()).toMatchObject({ completed: 0, unverified: 0, verified: 1, active: 0 });
  });

  it('rolls local cancellation back when the source fence cannot commit', async () => {
    const dir = root();
    const path = join(dir, 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    outbox.add(retainItem());
    const queued = outbox.due(new Date(), 1)[0]!;
    const database = new DatabaseSync(path);
    database.exec(`CREATE TRIGGER reject_forget BEFORE INSERT ON memory_fences BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
    database.close();

    const memory = new HindsightMemory() as unknown as {
      config: { enabled: boolean; bankId: string; apiUrl: string };
      outbox: MemoryOutbox;
      ledger: ForgetLedger;
      forgetDocument(documentId: string): Promise<{ local: number; deleted: number; pending: number; failed: number }>;
    };
    memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.outbox = outbox;
    memory.ledger = ledger;

    expect(await memory.forgetDocument('doc-a')).toMatchObject({ local: 0, failed: 1 });
    expect(outbox.get(queued.id)?.state).toBe('pending');
    expect(ledger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(false);
  });

  it('quarantines a queued request whose content no longer matches its committed hash', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    outbox.add(retainItem());
    const database = new DatabaseSync(path);
    const row = database.prepare('SELECT record_json FROM memory_operations').get() as { record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    record.content = 'a changed request';
    database.prepare('UPDATE memory_operations SET record_json = ?').run(JSON.stringify(record));
    database.close();

    closeMemoryStateStores();
    const reopened = new MemoryOutbox(openMemoryStateStore(path));
    expect(reopened.due(new Date(), 1)).toEqual([]);
    expect(reopened.status().orphaned).toBe(1);
  });

  it('keeps correction links after completed queue payloads expire', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    let now = new Date('2026-10-27T00:00:00.000Z');
    const outbox = new MemoryOutbox(store, { now: () => now });
    outbox.add({
      ...retainItem('doc-new'),
      metadata: { source_actor: 'user', kind: 'correction', status: 'current', supersedes_source_ids: '["doc-old"]' },
    });
    const item = outbox.due(new Date(), 1)[0]!;
    outbox.markSending(item.id);
    outbox.markSent(item.id, item.operationId);
    outbox.markDone(item.id);
    expect(outbox.markVerified(item.id)).toBe(true);
    now = new Date(now.getTime() + 8 * 86_400_000);
    expect(outbox.compact()).toBe(true);
    expect(outbox.get(item.id)).toBeNull();
    closeMemoryStateStores();

    const reopened = openMemoryStateStore(path);
    expect(reopened.supersededSources('bank-a', 'http://hindsight.test')).toEqual(new Set(['doc-old']));
  });
});
