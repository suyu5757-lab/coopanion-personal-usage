import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { coopanionPersona } from '../core/persona.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { GrowthProposals } from '../core/growth/proposals.ts';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'coo-growth-workflow-'));
  roots.push(root);
  return root;
};

/** The apply path checks that a proposal's evidence still exists. */
const liveSources = {
  enabled: () => true,
  sourceVisible: () => true,
  hasSource: async () => true,
  sourceEvidence: async () => ({ present: true, visible: true, actor: 'user', status: 'current' }),
} as unknown as HindsightMemory;

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
    const forgotten = { enabled: () => true, hasSource: async () => false } as unknown as HindsightMemory;
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
      { enabled: () => false, settled: () => true, sourceVisible: () => true },
      { enabled: () => true, settled: () => false, sourceVisible: () => true },
    ]) {
      const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory: memory as unknown as HindsightMemory });
      const persona = new Persona({ memoryDir: workspace });
      expect(await (persona as unknown as { experienceContext(): Promise<string> }).experienceContext()).toBe('');
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
    const memory = {
      enabled: () => true,
      settled: () => true,
      sourceVisible: () => true,
      sourceEvidence: async (id: string) => ({
        present: true, visible: true, actor: 'user', status: 'completed', kind: 'event',
        occurredAt: id.startsWith('same-') ? '2026-10-01T12:00:00.000Z' : id.endsWith('-1') ? '2026-10-01T12:00:00.000Z' : '2026-10-08T12:00:00.000Z',
      }),
    } as unknown as HindsightMemory;
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

    expect(new ExperienceCards(dir).get(id)?.userExplicit).toBe(true);
  });

  it('tells the current session which approved policy was revoked', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const memory = {
      enabled: () => true, settled: () => true, sourceVisible: () => true, hasSource: async () => true,
      sourceEvidence: async () => ({ present: true, visible: true, actor: 'user', status: 'current' }),
    } as unknown as HindsightMemory;
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json'), memory });
    const persona = new Persona({ memoryDir: workspace });
    const injected: string[] = [];
    persona['core'] = { injectInternal: (text: string) => injected.push(text) } as never;
    const invoke = persona.webUi('en').invoke!;
    const card = await invoke('hindsight', 'experience-create', [{
      title: 'Quiet coding time', situation: 'The person is coding.', lesson: 'Wait before routine interruptions.', scope: 'proactive_speech', sourceIds: ['user:focus'],
    }]) as { id: string };

    await invoke('hindsight', 'experience-review', [card.id, 'approved']);
    await invoke('hindsight', 'experience-review', [card.id, 'deprecated']);
    expect(injected.at(-1)).toContain('Quiet coding time');
    expect(injected.at(-1)).toContain('Do not follow it anymore');
    expect(injected.at(-1)).toContain('No approved experience policies remain active.');
  });

  it('rejects experience cards and proposal approval when a source is gone', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const memory = {
      enabled: () => true,
      settled: () => true,
      sourceVisible: () => true,
      hasSource: async () => false,
      sourceEvidence: async () => ({ present: false, visible: true, actor: null, status: null }),
    } as unknown as HindsightMemory;
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
    const memory = {
      enabled: () => true,
      settled: () => true,
      sourceVisible: () => true,
      sourceEvidence: async () => ({ present: false, visible: true, actor: null, status: null }),
      sessionBriefing: async () => ({ text: '', source: 'none' }),
    } as unknown as HindsightMemory;
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
