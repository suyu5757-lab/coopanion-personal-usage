import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryOutbox, readLegacyOutbox, requestHashFor, type RetainItem } from '../core/memory/outbox.ts';
import { ForgetLedger, readLegacyForget } from '../core/memory/forget-ledger.ts';
import { OutboxDelivery } from '../core/memory/delivery.ts';
import { closeMemoryStateStores, memoryArtifactScope, openMemoryStateStore, type ForgetStateSnapshot } from '../core/memory/state-store.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { createLegacyMemoryStateDatabase, openLegacyMemoryStateDatabase, snapshotLegacyDurableRows } from './fixtures/memory-state-legacy.ts';

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

  it('migrates the historical schema 2 fixture to 4 without changing committed delivery records', () => {
    const path = join(root(), 'memory-state.sqlite');
    createLegacyMemoryStateDatabase(path, 2);
    const old = openLegacyMemoryStateDatabase(path);
    const before = snapshotLegacyDurableRows(old, 2);
    old.close();

    openMemoryStateStore(path);
    const migrated = new DatabaseSync(path);
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
    expect(snapshotLegacyDurableRows(migrated, 2)).toBe(before);
    migrated.close();
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
    expect(store.activationForRetrieval(
      'bank-a', 'http://hindsight.test', 'fact:old-trip', '2026-09-01T12:00:00.000Z', '2026-10-03T12:00:00.000Z',
    )).toMatchObject({
      anchorWeight: first.activation?.anchorWeight,
      anchorAt: first.activation?.anchorAt,
      independentMentionCount: 1,
      lastRetrievedAt: '2026-10-03T12:00:00.000Z',
    });
    const database = new DatabaseSync(path);
    expect((database.prepare('SELECT COUNT(*) AS count FROM memory_mention_events').get() as { count: number }).count).toBe(1);
    database.close();

    closeMemoryStateStores();
    const reopened = openMemoryStateStore(path);
    expect(reopened.loadActivationState('bank-a', 'http://hindsight.test', 'fact:old-trip')).toMatchObject({
      independentMentionCount: 1,
      anchorWeight: first.activation?.anchorWeight,
      lastUserMentionAt: '2026-10-01T12:00:00.000Z',
      lastRetrievedAt: '2026-10-03T12:00:00.000Z',
    });
  });

  it('restores activation state and keeps a forget fence in a new process after a restart', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const userEventDocumentId = 'user:main:restart-test';
    const occurredAt = '2026-10-01T12:00:00.000Z';
    const retrievedAt = '2026-10-03T12:00:00.000Z';
    outbox.add(userEventItem(userEventDocumentId, occurredAt));
    expect(store.recordUserMention({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:restart-test',
      userEventDocumentId, targetCreatedAt: '2026-09-01T12:00:00.000Z', semanticMatch: 0.9, intensity: 0.12,
    }).status).toBe('applied');
    store.activationForRetrieval('bank-a', 'http://hindsight.test', 'fact:restart-test', '2026-09-01T12:00:00.000Z', retrievedAt);
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:restart-test')).not.toBeNull();

    const keptEventId = 'user:main:kept-test';
    outbox.add({ ...userEventItem(keptEventId, occurredAt), bankId: 'bank-b' });
    expect(store.recordUserMention({
      bankId: 'bank-b', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:kept-test',
      userEventDocumentId: keptEventId, targetCreatedAt: '2026-09-01T12:00:00.000Z', semanticMatch: 0.9, intensity: 0.12,
    }).status).toBe('applied');
    store.activationForRetrieval('bank-b', 'http://hindsight.test', 'fact:kept-test', '2026-09-01T12:00:00.000Z', retrievedAt);
    const kept = store.loadActivationState('bank-b', 'http://hindsight.test', 'fact:kept-test');
    expect(kept).not.toBeNull();

    const ledger = new ForgetLedger(store);
    expect(ledger.add({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'fact:restart-test', reason: 'synthetic restart fence',
    })).not.toBeNull();
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:restart-test')).toBeNull();
    closeMemoryStateStores();

    const stateStoreModule = pathToFileURL(join(process.cwd(), 'core/memory/state-store.ts')).href;
    const childSource = `
      import { closeMemoryStateStores, openMemoryStateStore } from ${JSON.stringify(stateStoreModule)};
      const store = openMemoryStateStore(process.env.COO_TEST_MEMORY_STATE_PATH);
      const forget = store.loadForgetState().state;
      process.stdout.write(JSON.stringify({
        forgotten: store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:restart-test'),
        kept: store.loadActivationState('bank-b', 'http://hindsight.test', 'fact:kept-test'),
        tombstones: forget?.tombstones ?? [],
      }));
      closeMemoryStateStores();
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childSource], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, COO_TEST_MEMORY_STATE_PATH: path },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const restarted = JSON.parse(child.stdout) as { forgotten: unknown; kept: unknown; tombstones: unknown[] };
    expect(restarted.forgotten).toBeNull();
    expect(restarted.kept).toEqual(kept);
    expect(restarted.tombstones).toContainEqual(expect.objectContaining({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'fact:restart-test',
    }));
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

  it('keeps stored activation inaccessible when the source fence transaction fails', () => {
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
    expect(ledger.damaged()).toBe(true);
    expect(store.loadActivationState('bank-a', 'http://hindsight.test', 'fact:kept')).toBeNull();
    const after = new DatabaseSync(store.path);
    expect((after.prepare('SELECT COUNT(*) AS count FROM memory_mention_events').get() as { count: number }).count).toBe(1);
    expect((after.prepare('SELECT COUNT(*) AS count FROM memory_activation WHERE bank_id = ? AND endpoint = ? AND document_id = ?')
      .get('bank-a', 'http://hindsight.test', 'fact:kept') as { count: number }).count).toBe(1);
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

  it('recovers a durable Forget intent after the fence transaction fails', async () => {
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
      client: object | null;
      outbox: MemoryOutbox;
      stateStore: ReturnType<typeof openMemoryStateStore>;
      ledger: ForgetLedger;
      forgetDocument(documentId: string): Promise<{ acceptance: string; local: number; deleted: number; pending: number; failed: number }>;
      sourceVisible(documentId: string): boolean;
    };
    memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.client = {};
    memory.outbox = outbox;
    memory.stateStore = store;
    memory.ledger = ledger;
    expect(memory.sourceVisible('doc-a')).toBe(true);

    expect(await memory.forgetDocument('doc-a')).toMatchObject({ acceptance: 'accepted', local: 0, pending: 1, failed: 0 });
    expect(outbox.get(queued.id)?.state).toBe('pending');
    expect(ledger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(false);
    expect(ledger.damaged()).toBe(true);
    expect(memory.sourceVisible('doc-a')).toBe(false);

    closeMemoryStateStores();
    const reopenedDb = new DatabaseSync(path);
    reopenedDb.exec('DROP TRIGGER reject_forget');
    reopenedDb.close();
    const restartedStore = openMemoryStateStore(path);
    const restartedOutbox = new MemoryOutbox(restartedStore);
    const restartedLedger = new ForgetLedger(restartedStore);
    const restartedMemory = new HindsightMemory() as unknown as {
      config: { enabled: boolean; bankId: string; apiUrl: string };
      client: object | null;
      outbox: MemoryOutbox;
      stateStore: ReturnType<typeof openMemoryStateStore>;
      ledger: ForgetLedger;
      sourceVisible(documentId: string): boolean;
    };
    restartedMemory.config = memory.config;
    restartedMemory.client = {};
    restartedMemory.outbox = restartedOutbox;
    restartedMemory.stateStore = restartedStore;
    restartedMemory.ledger = restartedLedger;
    expect(restartedLedger.damaged()).toBe(false);
    expect(restartedLedger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(true);
    expect(restartedLedger.status()).toMatchObject({ pending: 1, tombstones: 1 });
    expect(restartedMemory.sourceVisible('doc-a')).toBe(false);
  });

  it('reports an unaccepted Forget when the initial intent and fallback block cannot persist', async () => {
    const dir = root();
    const path = join(dir, 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    outbox.add(retainItem());
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER reject_intent BEFORE INSERT ON memory_deletions WHEN new.state = 'intent'
        BEGIN SELECT RAISE(ABORT, 'synthetic intent failure'); END;
      CREATE TRIGGER reject_forget_block BEFORE UPDATE ON memory_metadata WHEN new.key = 'forget:write-blocked'
        BEGIN SELECT RAISE(ABORT, 'synthetic block marker failure'); END;
    `);
    database.close();

    const memory = new HindsightMemory() as unknown as {
      config: { enabled: boolean; bankId: string; apiUrl: string };
      client: object | null;
      outbox: MemoryOutbox;
      stateStore: ReturnType<typeof openMemoryStateStore>;
      ledger: ForgetLedger;
      forgetDocument(documentId: string): Promise<{ acceptance: string; failed: number }>;
      sourceVisible(documentId: string): boolean;
    };
    memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.client = {};
    memory.outbox = outbox;
    memory.stateStore = store;
    memory.ledger = ledger;

    expect(await memory.forgetDocument('doc-a')).toMatchObject({
      acceptance: 'not-accepted', local: 0, deleted: 0, pending: 0, failed: 1,
    });
    expect(ledger.damaged()).toBe(true);
    expect(memory.sourceVisible('doc-a')).toBe(false);

    closeMemoryStateStores();
    const repair = new DatabaseSync(path);
    repair.exec('DROP TRIGGER reject_intent; DROP TRIGGER reject_forget_block;');
    repair.close();
    const restartedStore = openMemoryStateStore(path);
    const restartedOutbox = new MemoryOutbox(restartedStore);
    const restartedLedger = new ForgetLedger(restartedStore);
    const restartedMemory = new HindsightMemory() as unknown as {
      config: { enabled: boolean; bankId: string; apiUrl: string };
      client: object | null;
      outbox: MemoryOutbox;
      stateStore: ReturnType<typeof openMemoryStateStore>;
      ledger: ForgetLedger;
      forgetDocument(documentId: string): Promise<{ acceptance: string }>;
      sourceVisible(documentId: string): boolean;
    };
    restartedMemory.config = memory.config;
    restartedMemory.client = {};
    restartedMemory.outbox = restartedOutbox;
    restartedMemory.stateStore = restartedStore;
    restartedMemory.ledger = restartedLedger;
    expect(restartedLedger.damaged()).toBe(false);
    expect(restartedLedger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(false);
    expect(restartedMemory.sourceVisible('doc-a')).toBe(true);

    expect(await restartedMemory.forgetDocument('doc-a')).toMatchObject({ acceptance: 'accepted', deleted: 0 });
    expect(restartedMemory.sourceVisible('doc-a')).toBe(false);
    closeMemoryStateStores();
    const retryLedger = new ForgetLedger(openMemoryStateStore(path));
    expect(retryLedger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(true);
  });

  it('rolls back fence and epoch when derived invalidation fails, then recovers the intent', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const ledger = new ForgetLedger(store);
    const at = new Date().toISOString();
    store.saveDerivedArtifact({
      artifactId: 'growth-proposal:synthetic',
      kind: 'growth-proposal',
      target: 'growth-proposals/synthetic.json',
      scope: memoryArtifactScope('bank-a', 'http://hindsight.test'),
      creatorSessionId: null,
      creatorGenerationId: null,
      creatorOperationId: 'call-1',
      bodyDigest: 'a'.repeat(64),
      origin: 'model-derived',
      reviewState: 'unreviewed',
      lifecycleState: 'active',
      lineageState: 'complete',
      lineageReceiptDigest: 'b'.repeat(64),
      lineageValidatedAt: at,
      statusReason: null,
      createdAt: at,
      updatedAt: at,
      sources: [{
        bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-a',
        validatedEpoch: 1, validatedFence: 'fence-1', revision: 'revision-1',
        contentDigest: 'c'.repeat(64), segmentDigest: 'd'.repeat(64),
        validationState: 'validated', correlationId: 'memory-search-1',
      }],
    });
    const database = new DatabaseSync(path);
    database.exec(`CREATE TRIGGER reject_derived_invalidation BEFORE UPDATE OF lifecycle_state ON derived_artifact
      WHEN new.lifecycle_state = 'stale' BEGIN SELECT RAISE(ABORT, 'synthetic derived update failure'); END;`);
    database.close();

    const intent = ledger.beginIntents([{
      bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-a', reason: 'user asked to forget',
    }], 'user asked to forget');
    expect(intent.acceptance).toBe('accepted');
    expect(store.activationForRetrieval('bank-a', 'http://hindsight.test', 'fact:blocked', at)).toBeNull();
    expect(store.recordUserMention({
      bankId: 'bank-a', endpoint: 'http://hindsight.test', targetDocumentId: 'fact:blocked',
      userEventDocumentId: 'user:main:blocked', targetCreatedAt: at, semanticMatch: 1, intensity: 0.2,
    }).status).toBe('forget-unavailable');
    expect(ledger.finalizeIntents()).toBe(false);
    expect(ledger.damaged()).toBe(true);
    expect(store.loadForgetState().state).toMatchObject({ tasks: [{ state: 'intent' }], tombstones: [], epochs: {} });
    expect(store.getDerivedArtifact('growth-proposal:synthetic')?.lifecycleState).toBe('active');

    closeMemoryStateStores();
    const repair = new DatabaseSync(path);
    repair.exec('DROP TRIGGER reject_derived_invalidation');
    repair.close();
    const reopenedStore = openMemoryStateStore(path);
    const reopenedLedger = new ForgetLedger(reopenedStore);
    expect(reopenedLedger.damaged()).toBe(false);
    expect(reopenedLedger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(true);
    expect(reopenedLedger.epoch('bank-a', 'http://hindsight.test')).toBe(1);
    expect(reopenedStore.getDerivedArtifact('growth-proposal:synthetic')).toMatchObject({
      lifecycleState: 'stale', statusReason: 'source-forgotten',
    });
  });

  it('retries a failed remote deletion after reopening SQLite', async () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store, { now: () => new Date(0) });
    let deleteCalls = 0;
    const makeMemory = (stateStore: ReturnType<typeof openMemoryStateStore>, queue: MemoryOutbox, forgetLedger: ForgetLedger, deleteDocument: () => Promise<void>) => {
      const memory = new HindsightMemory() as unknown as {
        config: Record<string, unknown>;
        client: Record<string, unknown>;
        outbox: MemoryOutbox;
        stateStore: ReturnType<typeof openMemoryStateStore>;
        ledger: ForgetLedger;
        ready: boolean;
        unavailableUntil: number;
        forgetDocument(documentId: string): Promise<{ acceptance: string; deleted: number; pending: number; failed: number }>;
        drainDeletions(): Promise<void>;
      };
      memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test', recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] } };
      memory.client = {
        deleteDocument,
        clearMentalModel: async () => ({}),
        refreshMentalModel: async () => ({ operation_id: 'refresh-1' }),
      };
      memory.outbox = queue;
      memory.stateStore = stateStore;
      memory.ledger = forgetLedger;
      memory.ready = true;
      memory.unavailableUntil = 0;
      return memory;
    };
    const first = makeMemory(store, outbox, ledger, async () => {
      deleteCalls += 1;
      throw new Error('synthetic service outage');
    });

    expect(await first.forgetDocument('doc-a')).toMatchObject({ acceptance: 'accepted', deleted: 0, pending: 0, failed: 1 });
    expect(deleteCalls).toBe(1);
    expect(ledger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(true);
    expect(ledger.status()).toMatchObject({ failed: 1, pending: 0 });

    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(path);
    const reopenedOutbox = new MemoryOutbox(reopenedStore);
    const reopenedLedger = new ForgetLedger(reopenedStore, { now: () => new Date(0) });
    const restarted = makeMemory(reopenedStore, reopenedOutbox, reopenedLedger, async () => { deleteCalls += 1; });
    await restarted.drainDeletions();

    expect(deleteCalls).toBe(2);
    expect(reopenedLedger.status()).toMatchObject({ done: 1, pending: 0, failed: 0 });
    expect(reopenedLedger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(true);
  });

  it('recovers a durable intent after the process exits before fence promotion', () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    closeMemoryStateStores();
    const stateStoreModule = pathToFileURL(join(process.cwd(), 'core/memory/state-store.ts')).href;
    const ledgerModule = pathToFileURL(join(process.cwd(), 'core/memory/forget-ledger.ts')).href;
    const childSource = `
      import { openMemoryStateStore } from ${JSON.stringify(stateStoreModule)};
      import { ForgetLedger } from ${JSON.stringify(ledgerModule)};
      const store = openMemoryStateStore(process.env.COO_TEST_MEMORY_STATE_PATH);
      const ledger = new ForgetLedger(store);
      const result = ledger.beginIntents([{
        bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-a', reason: 'synthetic process stop',
      }], 'synthetic process stop');
      if (result.acceptance !== 'accepted') process.exit(2);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childSource], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, COO_TEST_MEMORY_STATE_PATH: path },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);

    const reopenedStore = openMemoryStateStore(path);
    const reopenedLedger = new ForgetLedger(reopenedStore);
    expect(reopenedLedger.damaged()).toBe(false);
    expect(reopenedLedger.forgotten('bank-a', 'http://hindsight.test', 'doc-a')).toBe(true);
    expect(reopenedLedger.status()).toMatchObject({ pending: 1, tombstones: 1 });
    expect(reopenedLedger.epoch('bank-a', 'http://hindsight.test')).toBe(1);
  });

  it('blocks a late retain callback while a durable intent awaits fence recovery', async () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    outbox.add(retainItem('doc-late'));
    const item = outbox.due(new Date(), 1)[0]!;
    const ledger = new ForgetLedger(store);
    let resolveRetain!: (value: { async: boolean; operationId: string | null }) => void;
    let beginRetain!: () => void;
    const retainStarted = new Promise<void>((resolve) => { beginRetain = resolve; });
    const cancelled: string[] = [];
    const delivery = new OutboxDelivery(outbox, {
      retain: async () => {
        beginRetain();
        return await new Promise((resolve) => { resolveRetain = resolve; });
      },
      status: async () => 'processing',
      verify: async () => true,
      retry: async () => {},
      cancel: async (entry) => { if (entry.operationId) cancelled.push(entry.operationId); },
    }, {
      target: () => ({ bankId: 'bank-a', endpoint: 'http://hindsight.test' }),
      forgotten: (entry) => ledger.damaged() || ledger.forgotten(entry.bankId ?? 'bank-a', entry.endpoint ?? 'http://hindsight.test', entry.documentId),
    });
    const running = delivery.drain();
    await retainStarted;
    expect(ledger.beginIntents([{
      bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: item.documentId, reason: 'late callback race',
    }], 'late callback race').acceptance).toBe('accepted');

    resolveRetain({ async: true, operationId: 'late-operation' });
    await running;
    expect(cancelled).toContain('late-operation');
    expect(outbox.get(item.id)?.state).toBe('cancelled');
    expect(ledger.damaged()).toBe(true);

    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(path);
    const reopenedLedger = new ForgetLedger(reopenedStore);
    expect(reopenedLedger.damaged()).toBe(false);
    expect(reopenedLedger.forgotten('bank-a', 'http://hindsight.test', item.documentId)).toBe(true);
    expect(reopenedLedger.status()).toMatchObject({ pending: 1, tombstones: 1 });
  });

  it('keeps bank clear fences inside one namespace when document IDs overlap', () => {
    const store = openMemoryStateStore(join(root(), 'memory-state.sqlite'));
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const ledger = new ForgetLedger(store);
    ledger.add({ bankId: 'bank-a', endpoint: 'http://a', documentId: 'same-id', reason: 'forget one namespace' });

    expect(ledger.beginClearTarget('bank-a', 'http://a')).toBe(true);
    expect(ledger.forgotten('bank-a', 'http://a', 'same-id')).toBe(true);
    expect(ledger.forgotten('bank-b', 'http://b', 'same-id')).toBe(false);
    expect(ledger.epoch('bank-a', 'http://a')).toBe(2);
    expect(ledger.epoch('bank-b', 'http://b')).toBe(0);
  });

  it('keeps the wildcard fence after remote bank clear fails and retries only on a later clear call', async () => {
    const path = join(root(), 'memory-state.sqlite');
    const store = openMemoryStateStore(path);
    store.importLegacy({ outbox: [], forget: emptyForget, forgetDamaged: false });
    const outbox = new MemoryOutbox(store);
    const ledger = new ForgetLedger(store);
    const makeMemory = (stateStore: ReturnType<typeof openMemoryStateStore>, queue: MemoryOutbox, forgetLedger: ForgetLedger, deleteBank: () => Promise<void>) => {
      const memory = new HindsightMemory() as unknown as {
        config: Record<string, unknown>;
        client: Record<string, unknown>;
        outbox: MemoryOutbox;
        stateStore: ReturnType<typeof openMemoryStateStore>;
        ledger: ForgetLedger;
        clear(): Promise<string>;
      };
      memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://a', recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] } };
      memory.client = { deleteBank };
      memory.outbox = queue;
      memory.stateStore = stateStore;
      memory.ledger = forgetLedger;
      return memory;
    };
    const first = makeMemory(store, outbox, ledger, async () => { throw new Error('synthetic clear outage'); });

    await expect(first.clear()).rejects.toThrow('synthetic clear outage');
    expect(ledger.bankClearPending('bank-a', 'http://a')).toBe(true);
    expect(ledger.forgotten('bank-a', 'http://a', 'source-a')).toBe(true);
    expect(ledger.forgotten('bank-b', 'http://b', 'source-a')).toBe(false);

    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(path);
    const reopenedOutbox = new MemoryOutbox(reopenedStore);
    const reopenedLedger = new ForgetLedger(reopenedStore);
    expect(reopenedLedger.damaged()).toBe(false);
    expect(reopenedLedger.bankClearPending('bank-a', 'http://a')).toBe(true);
    const restarted = makeMemory(reopenedStore, reopenedOutbox, reopenedLedger, async () => {});
    expect(await restarted.clear()).toBe('long-term memory cleared');
    expect(reopenedLedger.bankClearPending('bank-a', 'http://a')).toBe(false);
    expect(reopenedLedger.forgotten('bank-a', 'http://a', 'source-a')).toBe(false);
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
