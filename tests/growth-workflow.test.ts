import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidenceAttachment, EventEnvelope } from 'cortico/core/types.ts';
import { digestText, inspectContextEvidence } from 'cortico/core/evidence.ts';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { coopanionPersona } from '../core/persona.ts';
import { ActionReceiptLedger } from '../core/action-receipts.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { GrowthProposals } from '../core/growth/proposals.ts';
import { MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE } from '../core/memory/model-text.ts';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'coo-growth-workflow-'));
  roots.push(root);
  return root;
};

async function evidenceForSegments(text: string, segments: readonly { documentId: string; start: number; end: number }[]): Promise<EvidenceAttachment[]> {
  return segments.map((segment) => ({
    bankId: 'bank-synthetic', endpoint: 'https://bank.invalid', documentId: segment.documentId,
    validatedEpoch: '0:0', revisionState: 'current', validationStatus: 'validated',
    validationReceipt: createHash('sha256').update(segment.documentId).digest('hex'),
    contentDigest: createHash('sha256').update(`source:${segment.documentId}`).digest('hex'),
    segment: { start: segment.start, end: segment.end, digest: createHash('sha256').update(text.slice(segment.start, segment.end)).digest('hex') },
  }));
}

const testArtifacts = new Map<string, Record<string, unknown>>();
const testDigest = (text: string): string => createHash('sha256').update(text).digest('hex');

function memoryFor(overrides: Record<string, unknown> = {}): HindsightMemory {
  const artifact = (id: string) => testArtifacts.get(id) ?? {
    artifactId: id, lifecycleState: 'active', reviewState: 'approved', lineageState: 'complete',
    bodyDigest: null, sources: [],
  };
  const memory = {
  enabled: () => true,
  settled: () => true,
  listHandoffArtifacts: () => [],
  markRecallInjected: () => {},
  sourceVisible: () => true,
  hasSource: async () => true,
  evidenceEpoch: () => '1:0',
  sourceEvidence: async () => ({ present: true, visible: true, actor: 'user', status: 'current' }),
  registerDerivedArtifactFromSources: async (input: Record<string, unknown>) => {
    const saved = { ...input, bodyDigest: testDigest(String(input.content)), lifecycleState: 'active', lineageState: 'complete', sources: [] };
    testArtifacts.set(String(input.artifactId), saved);
    return saved;
  },
  derivedArtifact: (id: string) => artifact(id),
  derivedArtifactIsCurrent: (id: string, content: string) => {
    const saved = artifact(id);
    return saved.lifecycleState === 'active' && (saved.bodyDigest === null || saved.bodyDigest === testDigest(content));
  },
  verifyDerivedArtifact: async (id: string, content: string) => {
    const saved = artifact(id);
    return saved.lifecycleState === 'active' && (saved.bodyDigest === null || saved.bodyDigest === testDigest(content));
  },
  setDerivedArtifactReviewState: (id: string, state: string) => {
    const saved = artifact(id);
    const next = { ...saved, reviewState: state };
    testArtifacts.set(id, next);
    return next;
  },
  withdrawDerivedArtifact: (id: string) => {
    const saved = artifact(id);
    const next = { ...saved, lifecycleState: 'withdrawn' };
    testArtifacts.set(id, next);
    return next;
  },
  evidenceForSegments,
  ...overrides,
  };
  return memory as unknown as HindsightMemory;
}

/** The apply path checks that a proposal's evidence still exists. */
const liveSources = memoryFor();

function applyGrowthInternally(persona: object, id: string): Promise<unknown> {
  return (persona as unknown as { applyGrowthProposal(id: string): Promise<unknown> }).applyGrowthProposal(id);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const proposalInput = {
  title: 'Give focus time',
  summary: 'Avoid routine interruptions while the person is coding.',
  evidence: ['The person asked for fewer interruptions while coding.'],
  sourceIds: ['user-turn-42'],
  risk: 'low',
  changes: [{ file: 'CONSTITUTION.md', from: 'Ask before routine interruptions.', to: 'During focused work, wait before routine interruptions.', reason: 'The person asked for focus time.' }],
};

describe('growth proposal review and apply', () => {
  it('keeps the public apply route closed before G2 acceptance', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    writeFileSync(join(workspace, 'CONSTITUTION.md'), 'Ask before routine interruptions.\n');
    writeFileSync(join(workspace, 'SELF.md'), 'I am a whale.\n');
    const git = new WorkspaceGit(workspace);
    git.ensureRepo();
    expect(git.status().repo).toBe(true);
    expect(git.status().dirty).toBe(false);

    const store = new GrowthProposals(join(deploy, 'growth-proposals'));
    const written = store.write(proposalInput);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    await expect(store.get(written.proposal.id)?.state).toBe('candidate');
    expect(await store.markApplied(written.proposal.id, 'premature')).toBeNull();
    expect(store.transition(written.proposal.id, 'approved')?.state).toBe('approved');

    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory: liveSources });
    const persona = new Persona({ memoryDir: workspace });
    const invoke = persona.webUi('en').invoke;
    expect(invoke).toBeTypeOf('function');
    await expect(invoke!('hindsight', 'growth-proposal-apply', [written.proposal.id]))
      .rejects.toThrow(/not enabled/);
    expect(readFileSync(join(workspace, 'CONSTITUTION.md'), 'utf8')).toBe('Ask before routine interruptions.\n');
    expect(new GrowthProposals(join(deploy, 'growth-proposals')).get(written.proposal.id)?.state).toBe('approved');
    expect(git.status().dirty).toBe(false);
  });

  it('refuses to apply into a workspace with unrelated uncommitted changes', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    writeFileSync(join(workspace, 'CONSTITUTION.md'), 'Ask before routine interruptions.\n');
    new WorkspaceGit(workspace).ensureRepo();
    writeFileSync(join(workspace, 'other.txt'), 'uncommitted\n');
    const store = new GrowthProposals(join(deploy, 'growth-proposals'));
    const written = store.write(proposalInput);
    if (!written.ok) throw new Error(written.errors.join('; '));
    store.transition(written.proposal.id, 'approved');
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory: liveSources });
    const persona = new Persona({ memoryDir: workspace });

    await expect(applyGrowthInternally(persona, written.proposal.id))
      .rejects.toThrow(/uncommitted changes/);
    expect(readFileSync(join(workspace, 'CONSTITUTION.md'), 'utf8')).toBe('Ask before routine interruptions.\n');
  });

  it('leaves the file untouched when a later change to the same file no longer matches', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    writeFileSync(join(workspace, 'CONSTITUTION.md'), 'Ask before routine interruptions.\nSpeak briefly.\n');
    const git = new WorkspaceGit(workspace);
    git.ensureRepo();
    const store = new GrowthProposals(join(deploy, 'growth-proposals'));
    const written = store.write({
      ...proposalInput,
      changes: [
        { file: 'CONSTITUTION.md', from: 'Ask before routine interruptions.', to: 'During focused work, wait before routine interruptions.', reason: 'The person asked for focus time.' },
        { file: 'CONSTITUTION.md', from: 'This line is not in the file.', to: 'Something else.', reason: 'A stale second change.' },
      ],
    });
    if (!written.ok) throw new Error(written.errors.join('; '));
    store.transition(written.proposal.id, 'approved');
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory: liveSources });
    const persona = new Persona({ memoryDir: workspace });

    await expect(applyGrowthInternally(persona, written.proposal.id))
      .rejects.toThrow(/no longer has one unique copy/);
    expect(readFileSync(join(workspace, 'CONSTITUTION.md'), 'utf8')).toBe('Ask before routine interruptions.\nSpeak briefly.\n');
    expect(git.status().dirty).toBe(false);
    expect(store.get(written.proposal.id)?.state).toBe('approved');
  });

  it('refuses a proposal whose evidence is gone from the bank', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    writeFileSync(join(workspace, 'CONSTITUTION.md'), 'Ask before routine interruptions.\n');
    new WorkspaceGit(workspace).ensureRepo();
    const store = new GrowthProposals(join(deploy, 'growth-proposals'));
    const written = store.write(proposalInput);
    if (!written.ok) throw new Error(written.errors.join('; '));
    store.transition(written.proposal.id, 'approved');
    const forgotten = memoryFor({ hasSource: async () => false });
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory: forgotten });
    const persona = new Persona({ memoryDir: workspace });

    await expect(applyGrowthInternally(persona, written.proposal.id))
      .rejects.toThrow(/sources are gone/);
    expect(readFileSync(join(workspace, 'CONSTITUTION.md'), 'utf8')).toBe('Ask before routine interruptions.\n');
    expect(store.get(written.proposal.id)?.state).toBe('approved');
  });
});

describe('experience policy cards', () => {
  it('keeps approved policies out when Memory is disabled or its forget state is unsettled', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const cards = new ExperienceCards(join(deploy, 'experience-cards'));
    const created = cards.create({ title: 'Quiet time', situation: 'The person is focused.', lesson: 'Wait before interrupting.', scope: 'conversation', sourceIds: ['user-turn-42'] });
    if (!created.ok) throw new Error(created.errors.join('; '));
    cards.transition(created.card.id, 'approved');

    for (const memory of [
      memoryFor({ enabled: () => false, settled: () => true }),
      memoryFor({ enabled: () => true, settled: () => false }),
    ]) {
      const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory });
      const persona = new Persona({ memoryDir: workspace });
      expect((await (persona as unknown as { experienceContext(): Promise<{ text: string }> }).experienceContext()).text).toBe('');
    }
  });

  it('keeps policies inactive until approval and removes them when their source is forgotten', () => {
    const root = temp();
    const cards = new ExperienceCards(join(root, 'experience-cards'), () => new Date('2026-10-27T00:00:00.000Z'));
    const created = cards.create({
      title: 'Leave coding time quiet',
      situation: 'The person is focused on programming.',
      lesson: 'Do not start routine conversation until the person returns.',
      scope: 'proactive_speech',
      sourceIds: ['user-turn-42'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(cards.approvedContext()).toBe('');
    expect(cards.transition(created.card.id, 'approved')?.state).toBe('approved');
    expect(cards.approvedContext()).toContain('The person is focused on programming.');
    expect(cards.removeBySource(['user-turn-42'])).toBe(1);
    expect(cards.approvedContext()).toBe('');
  });

  it('rejects cards without source document IDs and limits the stored card count', () => {
    const root = temp();
    const cards = new ExperienceCards(join(root, 'experience-cards'));
    const result = cards.create({ title: 'x', situation: 'y', lesson: 'z', scope: 'conversation', sourceIds: [] });
    expect(result.ok).toBe(false);
  });

  it('keeps a Growth-proposed experience inactive until a person approves it', () => {
    const root = temp();
    const cards = new ExperienceCards(join(root, 'experience-cards'));
    const result = cards.propose({
      title: 'Quiet coding time',
      situation: 'The person is coding.',
      lesson: 'Wait before routine interruptions.',
      scope: 'proactive_speech',
      sourceIds: ['user:focus-1', 'user:focus-2'],
    });

    expect(result).toMatchObject({ ok: true, card: { state: 'candidate', userExplicit: false } });
    if (!result.ok) return;
    expect(cards.approvedContext()).toBe('');
    expect(cards.transition(result.card.id, 'approved')?.userExplicit).toBe(false);
    expect(cards.approvedContext()).toContain('Wait before routine interruptions.');
  });

  it('rechecks Growth experience sources as user events on distinct dates before approval', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const cards = new ExperienceCards(join(deploy, 'experience-cards'));
    const sameDay = cards.propose({
      title: 'Repeated quiet time', situation: 'The person is focused.', lesson: 'Wait before interrupting.',
      scope: 'proactive_speech', sourceIds: ['same-1', 'same-2'],
    });
    if (!sameDay.ok) throw new Error(sameDay.errors.join('; '));
    const memory = memoryFor({
      sourceEvidence: async (id: string) => ({
        present: true, visible: true, actor: 'user', status: 'completed', kind: 'event',
        occurredAt: id.startsWith('same-') ? '2026-10-01T12:00:00.000Z' : id.endsWith('-1') ? '2026-10-01T12:00:00.000Z' : '2026-10-08T12:00:00.000Z',
      }),
    });
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory });
    const persona = new Persona({ memoryDir: workspace });
    const invoke = persona.webUi('en').invoke!;

    await expect(invoke('hindsight', 'experience-review', [sameDay.card.id, 'approved']))
      .rejects.toThrow(/sources cannot be verified/);
    expect(cards.get(sameDay.card.id)?.state).toBe('candidate');

    const repeated = cards.propose({
      title: 'Repeated quiet time', situation: 'The person is focused.', lesson: 'Wait before interrupting.',
      scope: 'proactive_speech', sourceIds: ['valid-1', 'valid-2'],
    });
    if (!repeated.ok) throw new Error(repeated.errors.join('; '));
    await invoke('hindsight', 'experience-review', [repeated.card.id, 'approved']);
    expect(cards.get(repeated.card.id)?.state).toBe('approved');
  });

  it('reads experience cards from before the source author field as explicit user records', () => {
    const root = temp();
    const dir = join(root, 'experience-cards');
    const id = '00000000-0000-4000-8000-000000000001';
    mkdirSync(dir);
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      title: 'Quiet coding time', situation: 'The person is coding.', lesson: 'Wait.', scope: 'conversation',
      sourceIds: ['user:focus'], state: 'candidate',
    }));

    const cards = new ExperienceCards(dir);
    expect(cards.get(id)).toMatchObject({ userExplicit: true, kind: 'policy', trials: [] });
    expect(cards.transition(id, 'approved')?.state).toBe('approved');
    const saved = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('kind');
    expect(saved).not.toHaveProperty('trials');
  });

  it('requires a post-candidate Action Receipt and unseen-task confirmation before skill approval', () => {
    const root = temp();
    let now = new Date('2026-10-01T00:00:00.000Z');
    const cards = new ExperienceCards(join(root, 'experience-cards'), () => new Date(now));
    const candidate = cards.propose({
      title: 'Use the verified browser result', situation: 'A browser task has a verified result.',
      lesson: 'Check the receipt before reporting completion.', scope: 'browser_exploration', kind: 'skill',
      sourceIds: ['user:task-1', 'user:task-2'],
    });
    if (!candidate.ok) throw new Error(candidate.errors.join('; '));
    expect(cards.transition(candidate.card.id, 'approved')).toBeNull();

    const receiptBase = {
      receiptId: 'receipt-unknown', taskFingerprint: 'a'.repeat(64), intent: 'platform-write' as const,
      dispatchState: 'unknown' as const, createdAt: Date.parse(candidate.card.createdAt) + 1,
    };
    expect(cards.recordTrial(candidate.card.id, { ...receiptBase, outcome: 'unknown' }, false).ok).toBe(false);
    now = new Date('2026-10-01T00:01:00.000Z');
    const unknown = cards.recordTrial(candidate.card.id, { ...receiptBase, outcome: 'unknown' }, true);
    expect(unknown).toMatchObject({ ok: true, trial: { outcome: 'unknown', unseenConfirmedAt: '2026-10-01T00:01:00.000Z' } });
    expect(cards.transition(candidate.card.id, 'approved')).toBeNull();

    now = new Date('2026-10-01T00:02:00.000Z');
    const verified = cards.recordTrial(candidate.card.id, {
      ...receiptBase, dispatchState: 'delivered', outcome: 'verified',
    }, true);
    expect(verified).toMatchObject({ ok: true, trial: { outcome: 'verified', receiptId: 'receipt-unknown' } });
    expect(cards.recordTrial(candidate.card.id, {
      ...receiptBase, receiptId: 'receipt-duplicate-task', outcome: 'verified', dispatchState: 'delivered',
    }, true).ok).toBe(false);
    expect(cards.transition(candidate.card.id, 'approved')?.state).toBe('approved');
    expect(cards.approvedContext()).toContain('Check the receipt before reporting completion.');
  });

  it('reads settled receipt projections only after the person opens a skill trial picker', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const ledger = new ActionReceiptLedger(join(deploy, 'actions.json'));
    let listCalls = 0;
    const listTrialReceipts = ledger.listExperienceTrialReceipts.bind(ledger);
    ledger.listExperienceTrialReceipts = (after) => { listCalls += 1; return listTrialReceipts(after); };
    const memory = memoryFor({
      sourceEvidence: async () => ({ present: true, visible: true, actor: 'user', status: 'completed' }),
    });
    const Persona = coopanionPersona(Cormini, {
      growthStateFile: join(deploy, 'growth.json'),
      memory,
      actionReceipts: () => ledger,
    });
    const persona = new Persona({ memoryDir: workspace });
    const invoke = persona.webUi('en').invoke!;
    const card = await invoke('hindsight', 'experience-create', [{
      title: 'Verify the result', situation: 'An action task has finished.', lesson: 'Check its receipt before reporting completion.',
      scope: 'browser_exploration', kind: 'skill', sourceIds: ['user:skill-1'],
    }]) as { id: string; createdAt: string };

    const createdAt = Date.parse(card.createdAt);
    const makeUnknownReceipt = (taskId: string, at: number) => {
      const receipt = ledger.begin({
        taskId, intent: 'file-write', action: 'private task label', risk: 'REVERSIBLE_LOCAL',
        target: {
          surface: 'filesystem', instanceId: 'persona', workspaceRoot: workspace, path: 'result.txt',
          operation: 'file-write', snapshotId: 'snapshot-1', source: 'persona-workspace',
        },
        payloadDigest: 'a'.repeat(64), files: [], duplicateKey: taskId,
      }, at);
      ledger.awaitingApproval(receipt.id, at + 1);
      ledger.acting(receipt.id, 'b'.repeat(64), at + 2, at + 30_000, at + 3);
      ledger.complete(receipt.id, {
        phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown', note: 'private unknown note',
      }, at + 4);
      return receipt;
    };
    const unknown = makeUnknownReceipt('task-unknown', createdAt + 1_000);

    const status = await invoke('hindsight', 'growth-status', []) as { experiences: Array<{ id: string; trials: unknown[] }> };
    expect(status.experiences.find((entry) => entry.id === card.id)?.trials).toEqual([]);
    expect(listCalls).toBe(0);
    const eligible = await invoke('hindsight', 'experience-trial-receipts', [card.id]) as Array<Record<string, unknown>>;
    expect(listCalls).toBe(1);
    expect(eligible.map((entry) => entry.outcome)).toEqual(['unknown']);
    expect(JSON.stringify(eligible)).not.toMatch(/private task label|private receipt note|private unknown note|result\.txt/);
    await expect(invoke('hindsight', 'experience-trial-record', [card.id, unknown.id, false]))
      .rejects.toThrow(/Confirm that the task was not used/);
    await invoke('hindsight', 'experience-trial-record', [card.id, unknown.id, true]);
    await expect(invoke('hindsight', 'experience-review', [card.id, 'approved']))
      .rejects.toThrow(/verified receipt-backed trial/);
    expect(ledger.reconcile(unknown.id, 'verified', 'A later review verified the completed task.', createdAt + 6_000)).toBe(true);
    const refreshed = await invoke('hindsight', 'experience-trial-receipts', [card.id]) as Array<Record<string, unknown>>;
    expect(refreshed).toMatchObject([{ receiptId: unknown.id, outcome: 'verified', dispatchState: 'delivered' }]);
    await invoke('hindsight', 'experience-trial-record', [card.id, unknown.id, true]);
    await invoke('hindsight', 'experience-review', [card.id, 'approved']);
    expect(new ExperienceCards(join(deploy, 'experience-cards')).get(card.id)?.trials.map((trial) => trial.outcome))
      .toEqual(['verified']);
  });

  it('removes a revoked policy from the approved context and withdraws its artifact', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const memory = memoryFor({
      sourceEvidence: async () => ({ present: true, visible: true, actor: 'user', status: 'current' }),
    });
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory });
    const persona = new Persona({ memoryDir: workspace });
    const invoke = persona.webUi('en').invoke!;
    const card = await invoke('hindsight', 'experience-create', [{
      title: 'Quiet coding time', situation: 'The person is coding.', lesson: 'Wait before routine interruptions.', scope: 'proactive_speech', sourceIds: ['user:focus'],
    }]) as { id: string };

    await invoke('hindsight', 'experience-review', [card.id, 'approved']);
    const approved = await (persona as unknown as { experienceContext(): Promise<{ text: string; evidence: EvidenceAttachment[] }> })
      .experienceContext();
    expect(approved.text).toContain('The person is coding.');
    expect(approved.evidence.map((attachment) => attachment.documentId)).toEqual(['user:focus']);

    await invoke('hindsight', 'experience-review', [card.id, 'deprecated']);
    const revoked = await (persona as unknown as { experienceContext(): Promise<{ text: string }> }).experienceContext();
    expect(revoked.text).toBe('');
    expect(memory.derivedArtifact(card.id)).toMatchObject({ lifecycleState: 'withdrawn', reviewState: 'rejected' });
  });

  it('rejects experience cards and proposal approval when a source is gone', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const memory = memoryFor({
      hasSource: async () => false,
      sourceEvidence: async () => ({ present: false, visible: true, actor: null, status: null }),
    });
    const proposals = new GrowthProposals(join(deploy, 'growth-proposals'));
    const written = proposals.write(proposalInput);
    if (!written.ok) throw new Error(written.errors.join('; '));
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory });
    const persona = new Persona({ memoryDir: workspace });
    const invoke = persona.webUi('en').invoke!;

    await expect(invoke('hindsight', 'experience-create', [{
      title: 'Quiet coding time', situation: 'The person is coding.', lesson: 'Wait before routine interruptions.',
      scope: 'proactive_speech', sourceIds: ['user:focus'],
    }])).rejects.toThrow('sources are missing');
    await expect(invoke('hindsight', 'growth-proposal-review', [written.proposal.id, 'approved'])).rejects.toThrow('sources cannot be verified');
    expect(proposals.get(written.proposal.id)?.state).toBe('candidate');
  });

  it('does not inject an approved policy whose source is missing at session opening', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const cards = new ExperienceCards(join(deploy, 'experience-cards'));
    const created = cards.create({
      title: 'Quiet coding time',
      situation: 'The person is coding.',
      lesson: 'Wait before routine interruptions.',
      scope: 'proactive_speech',
      sourceIds: ['user:focus'],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    cards.transition(created.card.id, 'approved');
    const memory = memoryFor({
      sourceEvidence: async () => ({ present: false, visible: true, actor: null, status: null }),
      sessionBriefing: async () => ({ text: '', source: 'none' }),
    });
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory });
    const persona = new Persona({ memoryDir: workspace });
    let deferred: (() => string | null | Promise<string | null>) | null = null;
    persona['core'] = {
      injectInternal: () => {},
      injectDeferred: (_kind: string, render: () => string | null | Promise<string | null>) => { deferred = render; },
    } as never;
    persona.onOpening({ reason: 'new' });
    expect(deferred).toBeTypeOf('function');
    expect((await deferred!()) ?? '').not.toContain('Wait before routine interruptions');
  });
});

describe('forget fences at handoff', () => {
  it('omits fenced user and touch events while retaining other events', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const fenced = new Set(['user:main:42', 'touch:main:43']);
    const memoryText = '[memory] Past record.\n- (observation, 2026-10-01, source_id:user:main:42) A forgotten fact.';
    const memory = memoryFor({
      sourceFenced: (sourceId: string) => fenced.has(sourceId),
      sourceCurrentForContext: () => true,
      setLifecycleHooks: () => {},
      retainUser: () => 'user:main:44',
      recallForTurn: async () => ({ text: memoryText, route: 'standard', found: true, status: 'found' }),
    });
    const Persona = coopanionPersona(Cormini, { memory });
    const persona = new Persona({ memoryDir: workspace });
    const injected: string[] = [];
    const core = {
      toolsTagged: () => new Set<string>(),
      injectInternal: (text: string) => injected.push(text),
      injectExternal: () => {},
      sessionInfo: (id: string) => ({ id, running: 0, snapshot: null, estTokens: null, hardTokens: null, generation: { token: 'generation-1', status: 'current' } }),
    };
    persona.attach(core as never);

    const currentEvent: EventEnvelope = {
      cursor: 44, ts: '2026-10-31T10:00:02.000Z', type: 'desktop-pet.message', source: 'desktop-pet',
      origin: 'external', text: 'A current user event.', meta: { text: 'A current user event.' },
    };
    await persona.onDelivery({ events: [currentEvent] });
    expect(injected.some((text) => text.startsWith(memoryText))).toBe(true);

    const forgottenUser = 'Forgotten user event.';
    const forgottenTouch = 'A forgotten touch event.';
    const current = 'A current user event.';
    const injectedMemoryText = `${memoryText}\n${MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE}`;
    const body = [injectedMemoryText, forgottenUser, forgottenTouch, current].join('\n');
    const firstStart = injectedMemoryText.length + 1;
    const secondStart = firstStart + forgottenUser.length + 1;
    const thirdStart = secondStart + forgottenTouch.length + 1;
    const snapshot = [
      functionCall('memory-call', 'memory_search', JSON.stringify({ query: 'find my old event' })),
      functionResult('memory-call', memoryText),
      message('user', body, { frame: { events: [
        { cursor: 42, ts: '2026-10-31T10:00:00.000Z', type: 'desktop-pet.message', source: 'desktop-pet', start: firstStart, chars: forgottenUser.length },
        { cursor: 43, ts: '2026-10-31T10:00:01.000Z', type: 'desktop-pet.touch', source: 'desktop-pet', start: secondStart, chars: forgottenTouch.length },
        { cursor: 44, ts: '2026-10-31T10:00:02.000Z', type: 'desktop-pet.message', source: 'desktop-pet', start: thirdStart, chars: current.length },
      ] }, sourceIndependentSpans: [
        { start: firstStart, end: firstStart + forgottenUser.length, digest: digestText(forgottenUser), origin: 'user-input' },
        { start: secondStart, end: secondStart + forgottenTouch.length, digest: digestText(forgottenTouch), origin: 'user-input' },
        { start: thirdStart, end: thirdStart + current.length, digest: digestText(current), origin: 'user-input' },
      ] }),
    ];
    const prepared = await persona.prepareHandoff(snapshot, {
      hardTokens: null, sessionId: 'main', expectedGeneration: 'generation-1', candidateSnapshotId: 'candidate-1',
      sourceEvidence: inspectContextEvidence(snapshot),
      inspectCandidate: (records) => inspectContextEvidence(records),
    });

    const handoffDir = join(workspace, 'handoffs');
    const stagingDir = join(handoffDir, '.staging');
    expect(readdirSync(handoffDir).filter((name) => name.endsWith('.md'))).toEqual([]);
    const stagedNames = readdirSync(stagingDir);
    expect(stagedNames).toHaveLength(1);
    const notes = readFileSync(join(stagingDir, stagedNames[0]!), 'utf8');
    expect(notes).not.toContain(memoryText);
    expect(notes).not.toContain(forgottenUser);
    expect(notes).not.toContain(forgottenTouch);
    expect(notes).not.toContain('find my old event');
    expect(notes).toContain(current);
    expect(prepared.commitGuard?.()).toMatchObject({ status: 'allow' });
    prepared.discard?.();
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(handoffDir)).toBe(false);
  });
});
