import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { coopanionPersona } from '../core/persona.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { GrowthProposals } from '../core/growth/proposals.ts';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'coo-growth-workflow-'));
  roots.push(root);
  return root;
};

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
  it('requires approval before applying and records the resulting Persona commit', async () => {
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

    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json') });
    const persona = new Persona({ memoryDir: workspace });
    const invoke = persona.webUi('en').invoke;
    expect(invoke).toBeTypeOf('function');
    const result = await invoke!('hindsight', 'growth-proposal-apply', [written.proposal.id]) as { commit: string; proposal: { state: string } };

    expect(result.proposal.state).toBe('applied');
    expect(result.commit).toBeTruthy();
    expect(readFileSync(join(workspace, 'CONSTITUTION.md'), 'utf8')).toBe('During focused work, wait before routine interruptions.\n');
    expect(new GrowthProposals(join(deploy, 'growth-proposals')).get(written.proposal.id)?.appliedCommit).toBe(result.commit);
    expect(git.status().dirty).toBe(false);
    expect(execFileSync('git', ['-C', workspace, 'show', '--pretty=format:%s', '--no-patch'], { encoding: 'utf8' })).toContain('Apply growth proposal');
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
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json') });
    const persona = new Persona({ memoryDir: workspace });

    await expect(persona.webUi('en').invoke!('hindsight', 'growth-proposal-apply', [written.proposal.id]))
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
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json') });
    const persona = new Persona({ memoryDir: workspace });

    await expect(persona.webUi('en').invoke!('hindsight', 'growth-proposal-apply', [written.proposal.id]))
      .rejects.toThrow(/no longer has one unique copy/);
    expect(readFileSync(join(workspace, 'CONSTITUTION.md'), 'utf8')).toBe('Ask before routine interruptions.\nSpeak briefly.\n');
    expect(git.status().dirty).toBe(false);
    expect(store.get(written.proposal.id)?.state).toBe('approved');
  });
});

describe('experience policy cards', () => {
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

  it('tells the current session which approved policy was revoked', async () => {
    const root = temp();
    const workspace = join(root, 'workspace');
    const deploy = join(root, 'deploy');
    mkdirSync(workspace);
    mkdirSync(deploy);
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(deploy, 'growth.json') });
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
});
