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
const userEventItem = (documentId: string, at: string, actor = 'user'): RetainItem => ({
  ...retainItem(documentId),
  content: `Synthetic ${actor} event.`,
  timestamp: at,
  priority: 'normal',
  metadata: { source_actor: actor, kind: 'event', said_at: at },
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

  it('migrates schema 2 to 3 without dropping committed delivery records', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    outbox.add(retainItem('existing-source'));
    closeMemoryStateStores();

    const oldSchema = new DatabaseSync(path);
    oldSchema.exec(`
      DROP INDEX memory_mention_events_day;
      DROP INDEX memory_mention_events_source;
      DROP TABLE memory_mention_events;
      DROP TABLE memory_activation;
      PRAGMA user_version = 2;
    `);
    oldSchema.close();

    const migrated = openMemoryStateStore(path);
    const version = new DatabaseSync(path);
    expect((version.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    expect(new MemoryOutbox(migrated).matching(() => true).map((item) => item.documentId)).toEqual(['existing-source']);
    version.close();
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

  it('persists one activation per verified user event and treats a replay as idempotent', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const userDocumentId = 'user:main:101';
    outbox.add(userEventItem(userDocumentId, '2026-10-01T12:00:00.000Z'));
    const input = {
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:old-trip',
      userEventDocumentId: userDocumentId, targetCreatedAt: '2026-09-01T12:00:00.000Z',
      semanticMatch: 0.9, intensity: 0.06,
    };

    const first = store.recordUserMention(input);
    expect(first).toMatchObject({ status: 'applied', activation: { independentMentionCount: 1, sourceEpoch: 0 } });
    expect(store.recordUserMention(input)).toMatchObject({ status: 'duplicate', activation: { independentMentionCount: 1 } });
    store.saveOutbox({
      id: 'user-event-replay', bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: userDocumentId,
      operationId: 'operation-replay', state: 'pending', attempts: 0, nextAttemptAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:00.000Z', createdAt: '2026-10-01T12:00:00.000Z',
      content: 'Synthetic replay.', context: 'test', tags: [], priority: 'normal',
      metadata: { source_actor: 'user', kind: 'event', said_at: '2026-10-01T12:00:00.000Z' },
    });
    expect(store.recordUserMention(input).status).toBe('duplicate');
    const database = new DatabaseSync(path);
    expect((database.prepare('SELECT COUNT(*) AS count FROM memory_mention_events').get() as { count: number }).count).toBe(1);
    database.close();

    closeMemoryStateStores();
    const reopened = openMemoryStateStore(path);
    expect(reopened.loadActivationState('bank-a', 'http://hindsight.test', 'fact:old-trip')).toMatchObject({
      independentMentionCount: 1,
      anchorWeight: first.activation?.anchorWeight,
      lastUserMentionAt: '2026-10-01T12:00:00.000Z',
    });
  });

  it('accepts only persisted user-origin events for mention reinforcement', () => {
    const store = openMemoryStateStore(join(root(), 'memory-state.sqlite'));
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    outbox.add(userEventItem('coo:main:1', '2026-10-01T12:00:00.000Z', 'coo'));
    outbox.add(userEventItem('tool:main:1', '2026-10-01T12:01:00.000Z', 'tool'));
    const request = (userEventDocumentId: string) => store.recordUserMention({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:old-trip',
      userEventDocumentId, targetCreatedAt: '2026-09-01T12:00:00.000Z', semanticMatch: 1, intensity: 0.1,
    });

    expect(request('user:main:missing').status).toBe('source-missing');
    expect(request('coo:main:1').status).toBe('source-missing');
    expect(request('tool:main:1').status).toBe('source-missing');
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:old-trip')).toBeNull();
  });

  it('refuses reinforcement while the durable forget ledger is damaged', () => {
    const store = openMemoryStateStore(join(root(), 'memory-state.sqlite'));
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: true });
    new MemoryOutbox(store).add(userEventItem('user:main:damaged', '2026-10-01T12:00:00.000Z'));

    expect(store.recordUserMention({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:old-trip',
      userEventDocumentId: 'user:main:damaged', targetCreatedAt: '2026-09-01T12:00:00.000Z',
      semanticMatch: 1, intensity: 0.1,
    })).toMatchObject({ status: 'forget-unavailable', activation: null });
  });

  it('caps daily reinforcement and grows stability only across spaced user events', () => {
    const store = openMemoryStateStore(join(root(), 'memory-state.sqlite'));
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const eventDates = [
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z',
      '2026-10-01T02:00:00.000Z',
      '2026-10-01T03:00:00.000Z',
      '2026-10-02T04:00:00.000Z',
    ];
    const results = eventDates.map((at, index) => {
      const documentId = `user:main:daily-${index}`;
      outbox.add(userEventItem(documentId, at));
      return store.recordUserMention({
        bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:old-trip',
        userEventDocumentId: documentId, targetCreatedAt: '2026-09-01T00:00:00.000Z',
        semanticMatch: 1, intensity: 0.1,
      });
    });

    expect(results.slice(0, 3).map((result) => result.status)).toEqual(['applied', 'applied', 'applied']);
    expect(results[3]).toMatchObject({ status: 'daily-cap', appliedBoost: 0 });
    expect(results[4]).toMatchObject({ status: 'applied', spacingBucket: 'cross-day' });
    expect(results[4]?.activation?.halfLifeDays).toBeCloseTo(102.5, 12);
    expect(results[4]?.activation?.independentMentionCount).toBe(5);
  });

  it('removes derived activation and mention history when a target or its user evidence is fenced', () => {
    const store = openMemoryStateStore(join(root(), 'memory-state.sqlite'));
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    const firstDocumentId = 'user:main:201';
    const secondDocumentId = 'user:main:202';
    const survivorDocumentId = 'user:main:203';
    outbox.add(userEventItem(firstDocumentId, '2026-10-01T12:00:00.000Z'));
    outbox.add(userEventItem(secondDocumentId, '2026-10-02T12:00:00.000Z'));
    outbox.add(userEventItem(survivorDocumentId, '2026-10-03T12:00:00.000Z'));
    const input = (targetDocumentId: string, userEventDocumentId: string) => ({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId,
      userEventDocumentId, targetCreatedAt: '2026-09-01T12:00:00.000Z', semanticMatch: 0.9, intensity: 0.1,
    });
    store.recordUserMention(input('fact:forgotten-event', firstDocumentId));
    store.recordUserMention(input('fact:forgotten-evidence', secondDocumentId));
    store.recordUserMention(input('fact:survivor', survivorDocumentId));

    expect(ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: firstDocumentId, reason: 'user forgot source' })).not.toBeNull();
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:forgotten-event')).toBeNull();
    expect(store.recordUserMention(input('fact:forgotten-event', firstDocumentId)).status).toBe('forgotten');
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:survivor')).toMatchObject({ sourceEpoch: 1 });

    expect(ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'fact:forgotten-evidence', reason: 'user forgot target' })).not.toBeNull();
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:forgotten-evidence')).toBeNull();
    expect(store.recordUserMention(input('fact:forgotten-evidence', secondDocumentId)).status).toBe('forgotten');
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:survivor')).toMatchObject({ sourceEpoch: 2 });
    const database = new DatabaseSync(store.path);
    expect((database.prepare('SELECT COUNT(*) AS count FROM memory_mention_events').get() as { count: number }).count).toBe(1);
    database.close();
  });

  it('keeps activation intact when the source fence transaction fails', () => {
    const store = openMemoryStateStore(join(root(), 'memory-state.sqlite'));
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    const userDocumentId = 'user:main:401';
    outbox.add(userEventItem(userDocumentId, '2026-10-01T12:00:00.000Z'));
    store.recordUserMention({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:kept',
      userEventDocumentId: userDocumentId, targetCreatedAt: '2026-09-01T12:00:00.000Z',
      semanticMatch: 0.9, intensity: 0.1,
    });
    const database = new DatabaseSync(store.path);
    database.exec(`CREATE TRIGGER reject_forget BEFORE INSERT ON memory_fences BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
    database.close();

    expect(ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: userDocumentId, reason: 'user forgot source' })).toBeNull();
    expect(ledger.forgotten('bank-a', 'http://hindsight.test', userDocumentId)).toBe(false);
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:kept')).not.toBeNull();
    const after = new DatabaseSync(store.path);
    expect((after.prepare('SELECT COUNT(*) AS count FROM memory_mention_events').get() as { count: number }).count).toBe(1);
    after.close();
  });

  it('clears all activation records for a bank when the whole target is cleared', () => {
    const store = openMemoryStateStore(join(root(), 'memory-state.sqlite'));
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    const documentId = 'user:main:301';
    outbox.add(userEventItem(documentId, '2026-10-01T12:00:00.000Z'));
    store.recordUserMention({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:old-trip',
      userEventDocumentId: documentId, targetCreatedAt: '2026-09-01T12:00:00.000Z',
      semanticMatch: 1, intensity: 0.1,
    });

    expect(ledger.clearTarget('bank-a', 'http://hindsight.test')).toBe(true);
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:old-trip')).toBeNull();
    const database = new DatabaseSync(store.path);
    expect((database.prepare('SELECT COUNT(*) AS count FROM memory_mention_events').get() as { count: number }).count).toBe(0);
    database.close();
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
