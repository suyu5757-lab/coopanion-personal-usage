import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi } from 'cortico/core/types.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { ForgetLedger, VERIFY_DELAY_MS } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox, type RetainItem } from '../core/memory/outbox.ts';
import { closeMemoryStateStores } from '../core/memory/state-store.ts';
import { OutboxDelivery } from '../core/memory/delivery.ts';
import { HindsightMemory, type MemorySearchRead, type MemoryTextRead } from '../core/memory/hindsight.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { GrowthProposals } from '../core/growth/proposals.ts';
import { partnerProvenancePath, partnerSegmentDigest, partnerSourceScopeDigest, partnerWorkspaceDigest, readPartnerProvenance, writePartnerProvenance } from '../core/memory/partner-provenance.ts';
import { coopanionPersona } from '../core/persona.ts';

const roots: string[] = [];
const dir = () => {
  const root = mkdtempSync(join(tmpdir(), 'coo-forget-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  closeMemoryStateStores();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
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

interface FakeRecallResult {
  id: string;
  text: string;
  type: string;
  document_id?: string | null;
  context?: string | null;
  metadata?: Record<string, string> | null;
  source_fact_ids?: string[] | null;
  occurred_start?: string | null;
  mentioned_at?: string | null;
}

interface FakeClient {
  listDocuments?: (bankId: string, options?: { limit?: number; offset?: number; signal?: AbortSignal }) => Promise<{
    items: Array<{ id: string; bank_id?: string; document_metadata?: Record<string, unknown> | null }>;
    total: number;
  }>;
  getDocument?: (bankId: string, documentId: string) => Promise<unknown | null>;
  deleteDocument?: (bankId: string, documentId: string) => Promise<void>;
  recall?: (bankId: string, query: string, options?: { includeSourceFacts?: boolean; maxSourceFactsTokens?: number }) => Promise<{
    results: FakeRecallResult[];
    source_facts?: Record<string, FakeRecallResult> | null;
    source_facts_truncated?: boolean | null;
  }>;
  getMentalModel?: (bankId: string, id: string) => Promise<{ content: string }>;
  deleteBank?: (bankId: string) => Promise<void>;
  clearMentalModel?: (bankId: string, id: string) => Promise<unknown>;
  refreshMentalModel?: (bankId: string, id: string, options?: { mode?: 'full' }) => Promise<{ operation_id?: string }>;
  reflect?: (bankId: string, question: string) => Promise<{ text: string }>;
  listMemories?: (bankId: string) => Promise<{ items: Array<{ id: string; text: string; date: string; fact_type: string; document_id?: string | null }> }>;
}

function memoryWith(outbox: MemoryOutbox, ledger: ForgetLedger, client: FakeClient) {
  const memory = new HindsightMemory() as unknown as {
    config: Record<string, unknown>;
    client: FakeClient;
    outbox: MemoryOutbox;
    ledger: ForgetLedger;
    stateStore: MemoryOutbox['stateStore'];
    opsClient: { get: (request: unknown) => Promise<unknown> };
    delivery: OutboxDelivery;
    ready: boolean;
    unavailableUntil: number;
    drain: () => Promise<void>;
    forget: (query: string) => Promise<{ local: number; deleted: number; pending: number; failed: number }>;
    forgetDocument: (documentId: string) => Promise<{ local: number; deleted: number; pending: number; failed: number }>;
    searchResults: (query: string) => Promise<Array<{ text: string; documentId: string | null; metadata?: Record<string, string> }>>;
    searchResultsDetailed: (query: string) => Promise<MemorySearchRead>;
    recallBlockDetailed: (query: string) => Promise<MemoryTextRead>;
    recent: () => Promise<Array<{ id: string; text: string; date: string; type: string; documentId: string | null }>>;
    sessionBriefing: () => Promise<{ text: string; source: string }>;
    reflect: (question: string) => Promise<string>;
    remember: (text: string) => string;
    correct: (text: string, sourceIds: readonly string[], meta?: { session?: string }) => Promise<string>;
    clear: () => Promise<string>;
    settled: () => boolean;
    sourceFenced: (documentId: string) => boolean;
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
    listDocuments: async () => ({ items: [], total: 0 }),
    clearMentalModel: async () => ({}),
    refreshMentalModel: async (_bankId: string, id: string) => ({ operation_id: `refresh-${id}` }),
    getMentalModel: async () => ({ content: '' }),
    deleteBank: async () => {},
    recall: async () => ({ results: [] }),
    deleteDocument: async () => {},
    ...client,
  };
  memory.outbox = outbox;
  memory.ledger = ledger;
  memory.stateStore = outbox.stateStore;
  memory.opsClient = { get: async () => ({ data: { status: 'completed' }, response: { status: 200 } }) };
  memory.delivery = new OutboxDelivery(outbox, {
    retain: async (entry) => ({ async: true, operationId: entry.operationId }),
    status: async () => 'processing',
    verify: async () => true,
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
      stateStore: MemoryOutbox['stateStore'];
      remember: (text: string) => string;
      retainUser: (text: string, meta: { session?: string; cursor?: number }) => string | null;
    };
    memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.client = {};
    memory.outbox = new MemoryOutbox(join(dir(), 'missing', 'outbox.jsonl'));
    memory.stateStore = memory.outbox.stateStore;
    expect(memory.remember('synthetic fact')).toBe('persistence-error');
    expect(memory.retainUser('synthetic line', { session: 'main', cursor: 1 })).toBeNull();
  });

  it('answers an explicit fact with the local state, not with a confirmed save', () => {
    const outbox = new MemoryOutbox(join(dir(), 'outbox.jsonl'));
    const memory = memoryWith(outbox, new ForgetLedger(join(dir(), 'forget.json')), {});
    expect(memory.remember('synthetic preference')).toBe('queued');
    expect(outbox.status().active).toBe(1);
  });

  it('links a correction to verified sources and marks the earlier version after delivery', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    let correctionId = '';
    const memory = memoryWith(outbox, ledger, {
      getDocument: async (_bankId, documentId) => documentId === 'doc-old' ? { id: documentId } : null,
      recall: async () => ({ results: [
        { id: 'old', text: 'The person plans to move to Kyoto.', type: 'experience', document_id: 'doc-old', metadata: { source_actor: 'user', kind: 'event', status: 'current', user_verified: 'false' } },
        { id: 'new', text: 'The person plans to move to Osaka.', type: 'experience', document_id: correctionId, metadata: { source_actor: 'user', kind: 'correction', status: 'current', user_verified: 'true' } },
      ] }),
    });
    expect(await memory.correct('The person plans to move to Osaka.', ['doc-old'])).toBe('queued');
    const queued = outbox.matching((entry) => entry.metadata?.kind === 'correction')[0]!;
    correctionId = queued.documentId;
    expect(queued.metadata?.supersedes_source_ids).toBe('["doc-old"]');
    expect(outbox.stateStore?.supersededSources('bank-a', 'http://hindsight.test').size).toBe(0);
    outbox.markSent(queued.id, queued.operationId);
    outbox.markDone(queued.id);
    expect(outbox.markVerified(queued.id)).toBe(true);
    expect(outbox.stateStore?.supersededSources('bank-a', 'http://hindsight.test')).toEqual(new Set(['doc-old']));
    const results = await memory.searchResults('move');
    expect(results.find((result) => result.documentId === 'doc-old')?.metadata?.status).toBe('superseded');
    expect(results.find((result) => result.documentId === correctionId)?.metadata?.status).toBe('current');
  });

  it('fences local correction records when their earlier source is forgotten', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    outbox.add(item({
      documentId: 'doc-correction',
      content: 'corrected synthetic fact',
      priority: 'critical',
      metadata: { source_actor: 'user', kind: 'correction', status: 'current', supersedes_source_ids: '["doc-old"]' },
    }));
    const correction = outbox.due(new Date(), 1)[0]!;
    outbox.markSent(correction.id, correction.operationId);
    outbox.markDone(correction.id);
    outbox.markVerified(correction.id);
    let deleted = 0;
    const memory = memoryWith(outbox, ledger, { deleteDocument: async () => { deleted += 1; } });

    const result = await memory.forgetDocument('doc-old');
    expect(result).toMatchObject({ deleted: 2, pending: 0, failed: 0 });
    expect(deleted).toBe(2);
    expect(ledger.forgotten('bank-a', 'http://hindsight.test', 'doc-old')).toBe(true);
    expect(ledger.forgotten('bank-a', 'http://hindsight.test', 'doc-correction')).toBe(true);
  });

  it('holds recall while a natural-language forget query is resolving source IDs', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    let begin!: () => void;
    let finish!: (value: { results: Array<{ id: string; text: string; type: string; document_id?: string | null }> }) => void;
    let resolving = true;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const memory = memoryWith(outbox, ledger, {
      recall: async () => {
        if (!resolving) return { results: [] };
        resolving = false;
        begin();
        return await new Promise((resolve) => { finish = resolve; });
      },
      deleteDocument: async () => {},
    });

    const forgetting = memory.forget('a remote-only synthetic topic');
    await started;
    expect(await memory.searchResults('another topic')).toEqual([]);
    finish({ results: [] });
    await forgetting;
    expect(await memory.searchResults('another topic')).toEqual([]);
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

  it('imports the previous deletion file once and leaves it in place', () => {
    const root = dir();
    const legacy = join(root, 'memory-deletions.json');
    const at = '2026-10-01T00:00:00.000Z';
    writeFileSync(legacy, JSON.stringify([{ id: 'old', bankId: 'bank-a', endpoint: 'http://a', documentId: 'doc-old', reason: 'forget', state: 'pending', attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at }]));
    const ledger = new ForgetLedger(join(root, 'memory-forget.json'), { legacyFile: legacy });
    expect(ledger.get('old')?.state).toBe('pending');
    expect(existsSync(join(root, 'memory-state.sqlite'))).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    const reopened = new ForgetLedger(join(root, 'memory-forget.json'), { legacyFile: legacy });
    expect(reopened.get('old')?.state).toBe('pending');
  });

  it('marks an unreadable ledger and leaves a missing one healthy', () => {    const missing = new ForgetLedger(join(dir(), 'forget.json'));
    expect(missing.damaged()).toBe(false);
    const broken = join(dir(), 'forget.json');
    writeFileSync(broken, '{not json');
    expect(new ForgetLedger(broken).damaged()).toBe(true);
  });

  it('repeats a deletion once when the source had a retain in flight', () => {    let now = new Date('2026-10-27T00:00:00.000Z');
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
  it('verifies a retain operation that was still pending when the person forgot it', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    outbox.add(item({ documentId: 'in-flight', content: 'synthetic trip' }));
    const queued = outbox.due(new Date(), 1)[0]!;
    const ledgerPath = join(root, 'forget.json');
    let now = new Date();
    const ledger = new ForgetLedger(ledgerPath, { now: () => now });
    let began!: () => void;
    let finish!: (accepted: { async: boolean; operationId: string | null }) => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let deletes = 0;
    let cancellations = 0;
    const memory = memoryWith(outbox, ledger, { deleteDocument: async () => { deletes += 1; } });
    memory.delivery = new OutboxDelivery(outbox, {
      retain: async () => {
        began();
        return await new Promise((resolve) => { finish = resolve; });
      },
      status: async () => 'processing',
      verify: async () => true,
      retry: async () => {},
      cancel: async () => { cancellations += 1; throw new Error('cancel refused'); },
    });

    const delivery = memory.delivery.drain();
    await started;
    const result = await memory.forgetDocument(queued.documentId);
    const task = ledger.stateStore?.loadForgetState().state?.tasks[0] as { operationId?: string; state: string; verifications: number } | undefined;
    expect(task).toBeDefined();
    expect(result).toMatchObject({ deleted: 0, pending: 1, failed: 0 });
    expect(task).toMatchObject({ operationId: queued.operationId, state: 'pending', verifications: 1 });
    expect(deletes).toBe(1);

    finish({ async: true, operationId: queued.operationId });
    await delivery;
    expect(cancellations).toBe(2);
    now = new Date(now.getTime() + VERIFY_DELAY_MS + 1);
    expect(ledger.due(now, 8)).toHaveLength(1);
  });

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

  it('revokes source-linked Growth state without discarding files or completed receipts', async () => {
    const root = dir();
    const sourceId = 'user:focus';
    const otherSourceId = 'user:other';
    const workspace = join(root, 'workspace');
    const partnerSidecar = partnerProvenancePath(root, workspace);
    const sourceScopeDigest = partnerSourceScopeDigest('bank-a', 'http://hindsight.test');
    writePartnerProvenance(partnerSidecar, {
      v: 1,
      workspaceDigest: partnerWorkspaceDigest(workspace),
      entries: [
        {
          id: 'a'.repeat(32),
          segmentDigest: partnerSegmentDigest('Paragraph derived from the forgotten source.'),
          origin: 'derived',
          sourceIds: [sourceId],
          sourceScopeDigest,
          state: 'current',
        },
        {
          id: 'b'.repeat(32),
          segmentDigest: partnerSegmentDigest('Paragraph derived from another source.'),
          origin: 'derived',
          sourceIds: [otherSourceId],
          sourceScopeDigest,
          state: 'current',
        },
        {
          id: 'c'.repeat(32),
          segmentDigest: partnerSegmentDigest('A direct user-authored paragraph.'),
          origin: 'user-authored',
          sourceIds: [],
          sourceScopeDigest: null,
          state: 'current',
        },
      ],
    });
    const cards = new ExperienceCards(join(root, 'experience-cards'));
    const created = cards.create({ title: 'Quiet coding time', situation: 'The person is programming.', lesson: 'Wait before routine interruptions.', scope: 'proactive_speech', sourceIds: [sourceId] });
    if (!created.ok) throw new Error(created.errors.join('; '));
    cards.transition(created.card.id, 'approved');
    const proposals = new GrowthProposals(join(root, 'growth-proposals'));
    const proposal = proposals.write({
      title: 'Leave coding time quiet', summary: 'Wait during focused work.', evidence: ['The person asked for focus time.'],
      sourceIds: [sourceId], risk: 'low',
      changes: [{ file: 'CONSTITUTION.md', to: 'Wait during focused work.', reason: 'The person asked for focus time.' }],
    });
    if (!proposal.ok) throw new Error(proposal.errors.join('; '));
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const memory = memoryWith(outbox, ledger, { deleteDocument: async () => {} });
    const core = {
      timers: {
        onDue: () => {}, set: () => ({ ok: true as const, id: 'timer' }), cancel: () => true,
        list: () => [], clearAll: () => 0,
      },
      sessionInfo: () => ({ snapshot: [], running: 0 }),
      log: { info: () => {}, warn: () => {} },
      injectInternal: () => {},
    } as unknown as CoreApi;
    const Persona = coopanionPersona(Cormini, {
      growthStateFile: join(root, 'growth.json'),
      memory: memory as unknown as HindsightMemory,
    });
    const persona = new Persona({ memoryDir: workspace });
    persona.attach(core);

    const result = await memory.forgetDocument(sourceId);
    expect(result).toMatchObject({ deleted: 1, pending: 0, failed: 0 });
    expect(cards.list().map((card) => card.id)).toEqual([created.card.id]);
    expect(proposals.list().map((entry) => entry.id)).toEqual([proposal.proposal.id]);
    expect((await (persona as unknown as { experienceContext(): Promise<{ text: string }> }).experienceContext()).text).toBe('');
    expect(memory.sourceFenced(sourceId)).toBe(true);
    const afterForget = readPartnerProvenance(partnerSidecar, partnerWorkspaceDigest(workspace));
    expect(afterForget.status).toBe('ok');
    if (afterForget.status !== 'ok') throw new Error('sidecar should remain readable after source forget');
    expect(afterForget.file.entries.map((entry) => entry.state)).toEqual(['stale', 'current', 'current']);

    const secondCard = cards.create({ title: 'Second card', situation: 'A situation.', lesson: 'A lesson.', scope: 'conversation', sourceIds: ['user:other'] });
    const secondProposal = proposals.write({
      title: 'Second proposal', summary: 'A summary.', evidence: ['An event.'], sourceIds: ['user:other'], risk: 'low',
      changes: [{ file: 'SELF.md', to: 'A line.', reason: 'A reason.' }],
    });
    expect(secondCard.ok && secondProposal.ok).toBe(true);
    await memory.clear();
    expect(cards.list().map((card) => card.id).sort()).toEqual([created.card.id, ...(secondCard.ok ? [secondCard.card.id] : [])].sort());
    expect(proposals.list().map((entry) => entry.id).sort()).toEqual([
      proposal.proposal.id,
      ...(secondProposal.ok ? [secondProposal.proposal.id] : []),
    ].sort());
    expect((await (persona as unknown as { experienceContext(): Promise<{ text: string }> }).experienceContext()).text).toBe('');
    const afterClear = readPartnerProvenance(partnerSidecar, partnerWorkspaceDigest(workspace));
    expect(afterClear.status).toBe('ok');
    if (afterClear.status !== 'ok') throw new Error('sidecar should remain readable after bank clear');
    expect(afterClear.file.entries.map((entry) => entry.state)).toEqual(['stale', 'stale', 'current']);
    persona.stopGrowth();
  });
});

describe('the fence covers reads and writes', () => {
  it('does not call a source visible when Memory is off or its ledger cannot be read', () => {
    const root = dir();
    const file = join(root, 'forget.json');
    writeFileSync(file, '{broken');
    const memory = new HindsightMemory() as unknown as {
      config: Record<string, unknown>;
      client: FakeClient | null;
      ledger: ForgetLedger | null;
      sourceVisible: (documentId: string) => boolean;
    };
    memory.config = { enabled: true, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.client = {};
    memory.ledger = new ForgetLedger(file);
    expect(memory.sourceVisible('doc-1')).toBe(false);

    memory.config = { enabled: false, bankId: 'bank-a', apiUrl: 'http://hindsight.test' };
    memory.client = null;
    memory.ledger = null;
    expect(memory.sourceVisible('doc-1')).toBe(false);
  });

  it('does not return a source the service hands back after the deletion', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    outbox.add(item({ documentId: 'trip', content: 'synthetic trip to Hangzhou' }));
    const client: FakeClient = {
      recall: async () => ({ results: [{ id: 'm1', text: 'synthetic trip to Hangzhou', type: 'world', document_id: 'trip', metadata: { source_actor: 'user', kind: 'event' } }] }),
      deleteDocument: async () => {},
    };
    const memory = memoryWith(outbox, ledger, client);
    expect(await memory.searchResults('trip')).toHaveLength(1);
    await memory.forget('synthetic trip');
    expect(await memory.searchResults('trip')).toEqual([]);
  });

  it('treats the Hindsight SDK missing-document response as a completed deletion', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const memory = memoryWith(outbox, ledger, {
      deleteDocument: async () => { throw new Error('deleteDocument failed: {"detail":"Document not found"}'); },
    });

    const result = await memory.forgetDocument('already-absent');

    expect(result).toMatchObject({ deleted: 1, pending: 0, failed: 0 });
    expect(ledger.unresolved('bank-a', 'http://hindsight.test')).toBe(0);
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

  it('keeps source-less recall results fenced after a deletion settles', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const memory = memoryWith(outbox, ledger, {
      recall: async () => ({ results: [{ id: 'm1', text: 'synthetic observation', type: 'observation', document_id: null }] }),
      deleteDocument: async () => {},
    });

    await memory.forgetDocument('remote-only');

    expect(ledger.unresolved('bank-a', 'http://hindsight.test')).toBe(0);
    expect(ledger.hasFencedSources('bank-a', 'http://hindsight.test')).toBe(true);
    expect(await memory.searchResultsDetailed('anything')).toEqual({ results: [], status: 'fenced' });
  });

  it('hands visible supporting source facts to recall and suppresses derived results backed by forgotten sources', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const fence = ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-forgotten', reason: 'synthetic forget' })!;
    ledger.markDone(fence.id);
    const results: FakeRecallResult[] = [
      {
        id: 'observation-visible',
        text: 'Lin and Wei worked together on a planning document.',
        type: 'observation',
        document_id: 'doc-observation-visible',
        context: 'The observation links the coordination and review events.',
        source_fact_ids: ['fact-coordination', 'fact-review'],
      },
      {
        id: 'observation-derived-from-forgotten-source',
        text: 'The pair planned the forgotten trip.',
        type: 'observation',
        document_id: 'doc-derived',
        source_fact_ids: ['fact-forgotten'],
      },
    ];
    const sourceFacts: Record<string, FakeRecallResult> = {
      'fact-coordination': { id: 'fact-coordination', text: 'Lin coordinated the shared materials.', type: 'world', document_id: 'doc-coordination', metadata: { source_actor: 'user', kind: 'event' } },
      'fact-review': { id: 'fact-review', text: 'Wei reviewed the shared plan.', type: 'experience', document_id: 'doc-review', metadata: { source_actor: 'user', kind: 'event' } },
      'fact-forgotten': { id: 'fact-forgotten', text: 'Lin and Wei planned the forgotten trip.', type: 'world', document_id: 'doc-forgotten', metadata: { source_actor: 'user', kind: 'event' } },
    };
    const memory = memoryWith(outbox, ledger, {
      recall: async (_bank, _query, options) => ({
        results,
        ...(options?.includeSourceFacts ? { source_facts: sourceFacts } : {}),
      }),
    });

    const read = await memory.searchResultsDetailed('What project did Lin and Wei work on?');
    const text = await memory.recallBlockDetailed('What project did Lin and Wei work on?');

    expect(read.status).toBe('found');
    expect(read.results).toHaveLength(1);
    expect(read.results[0]?.sourceFacts?.map((fact) => fact.documentId)).toEqual(['doc-coordination', 'doc-review']);
    expect(text.text).toContain('The observation links the coordination and review events.');
    expect(text.text).toContain('Lin coordinated the shared materials.');
    expect(text.text).toContain('Wei reviewed the shared plan.');
    expect(text.text).not.toContain('forgotten trip');
  });

  it('fences an observation when a truncated source-fact response cannot rule out forgotten support', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const fence = ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-forgotten', reason: 'synthetic forget' })!;
    ledger.markDone(fence.id);
    const memory = memoryWith(outbox, ledger, {
      recall: async (_bank, _query, options) => ({
        results: [{
          id: 'observation-partial',
          text: 'The team planned a trip.',
          type: 'observation',
          document_id: 'doc-observation',
          source_fact_ids: ['fact-visible', 'fact-not-returned'],
        }],
        ...(options?.includeSourceFacts ? {
          source_facts: {
            'fact-visible': { id: 'fact-visible', text: 'The team planned an event.', type: 'world', document_id: 'doc-visible' },
          },
          source_facts_truncated: true,
        } : {}),
      }),
    });

    const read = await memory.searchResultsDetailed('What did the team plan?');

    expect(read).toEqual({ results: [], status: 'fenced' });
  });

  it('does not show source-less recent memories while a deletion is unresolved', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const memory = memoryWith(outbox, ledger, {
      deleteDocument: async () => { throw new Error('offline'); },
      listMemories: async () => ({ items: [{ id: 'memory-1', text: 'synthetic observation', date: '', fact_type: 'observation', document_id: null }] }),
    });
    await memory.forgetDocument('remote-only');
    expect(ledger.unresolved('bank-a', 'http://hindsight.test')).toBe(1);
    expect(await memory.recent()).toEqual([]);
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

  it('withholds mental-model portraits without source mapping and clears them on forget', async () => {
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
    expect(await memory.sessionBriefing()).toEqual({ text: '', source: 'none' });
    await memory.forgetDocument('trip');
    expect(cleared).toBe(true);
    expect(await memory.sessionBriefing()).toEqual({ text: '', source: 'none' });
    expect(memory.settled()).toBe(true);
  });

  it('keeps one forget fence closed until concurrent derived refreshes reach a completed operation', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    const statuses = ['processing', 'completed', 'completed', 'completed', 'completed'];
    let refreshId = 0;
    const client: FakeClient = {
      clearMentalModel: async () => ({}),
      refreshMentalModel: async () => ({ operation_id: `refresh-${++refreshId}` }),
    };
    const memory = memoryWith(outbox, ledger, client);
    const task = ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-a', reason: 'forget' });
    expect(task).toBeTruthy();
    expect(ledger.markDone(task!.id)).toBe(true);
    expect(memory.settled()).toBe(false);

    const typed = memory as unknown as {
      clearDerived: () => Promise<void>;
      opsClient: { get: (request: unknown) => Promise<unknown> };
    };
    typed.opsClient = {
      get: vi.fn(async () => {
        const status = statuses.shift() ?? 'completed';
        if (status === 'processing') expect(ledger.stale('bank-a', 'http://hindsight.test')).toBe(true);
        return { data: { status }, response: { status: 200 } };
      }),
    };

    await Promise.all([typed.clearDerived(), typed.clearDerived()]);

    expect(refreshId).toBe(4);
    expect(ledger.stale('bank-a', 'http://hindsight.test')).toBe(false);
    expect(memory.settled()).toBe(true);
  });

  it('does not resubmit a failed derived refresh for the same fence epoch', async () => {
    const root = dir();
    const outbox = new MemoryOutbox(join(root, 'outbox.jsonl'));
    const ledger = new ForgetLedger(join(root, 'forget.json'));
    let refreshId = 0;
    const client: FakeClient = {
      clearMentalModel: async () => ({}),
      refreshMentalModel: async () => ({ operation_id: `refresh-${++refreshId}` }),
    };
    const memory = memoryWith(outbox, ledger, client);
    const task = ledger.add({ bankId: 'bank-a', endpoint: 'http://hindsight.test', documentId: 'doc-a', reason: 'forget' });
    expect(task).toBeTruthy();
    expect(ledger.markDone(task!.id)).toBe(true);

    const typed = memory as unknown as {
      clearDerived: () => Promise<void>;
      opsClient: { get: (request: unknown) => Promise<unknown> };
    };
    typed.opsClient = {
      get: vi.fn(async () => ({ data: { status: refreshId === 1 ? 'failed' : 'completed' }, response: { status: 200 } })),
    };

    await typed.clearDerived();
    expect(refreshId).toBe(4);
    expect(ledger.stale('bank-a', 'http://hindsight.test')).toBe(true);
    expect(memory.settled()).toBe(false);

    await typed.clearDerived();
    expect(refreshId).toBe(4);
    expect(ledger.stale('bank-a', 'http://hindsight.test')).toBe(true);
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
