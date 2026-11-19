import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import { RelationshipJournal } from '../core/memory/journal.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = () => new Date('2026-10-24T10:00:00.000Z');

function setup(answer = 'A warm, quiet day with tea and a short chat.') {
  const rootDir = mkdtempSync(join(tmpdir(), 'coo-journal-'));
  roots.push(rootDir);
  const reflect = vi.fn(async () => ({ text: answer, status: answer ? 'found' : 'absent', sourceSegments: answer ? [{ documentId: 'parent', start: 0, end: answer.length, derived: true }] : [] }));
  const retainJournal = vi.fn(async () => 'queued' as const);
  const refreshModel = vi.fn(async () => {});
  const memory = {
    enabled: () => true,
    settled: () => true,
    journalDayRecorded: () => false,
    evidenceEpoch: () => '0:0',
    reflectDetailed: reflect,
    retainJournal,
    refreshModel,
  } as unknown as HindsightMemory;
  const journal = new RelationshipJournal();
  journal.configure({ memory, rootDir, timezone: 'UTC', enabled: true, now });
  return { journal, rootDir, reflect, retainJournal, refreshModel };
}

describe('daily relationship journal', () => {
  it('marks the first quiet run without inventing a journal', async () => {
    const { journal, rootDir, retainJournal } = setup();
    await journal.runDue();
    expect(retainJournal).not.toHaveBeenCalled();
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toContain('2026-10-23');
  });

  it('reflects on the day and writes it into long-term memory', async () => {
    const { journal, rootDir, reflect, retainJournal, refreshModel } = setup();
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-10-22' }));
    await journal.runDue();
    expect(reflect).toHaveBeenCalledWith(expect.stringContaining('2026-10-23'), expect.objectContaining({ tags: ['scope:affection'] }));
    expect(retainJournal).toHaveBeenCalledWith('A warm, quiet day with tea and a short chat.', '2026-10-23', { sourceIds: ['parent'], expectedEpoch: '0:0' });
    expect(refreshModel).toHaveBeenCalledWith('relationship');
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toContain('2026-10-23');
  });

  it('keeps the day retryable when reflection is empty', async () => {
    const { journal, rootDir, retainJournal } = setup('');
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-10-22' }));
    await journal.runDue();
    expect(retainJournal).not.toHaveBeenCalled();
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toContain('2026-10-22');
  });

  it('drops a reflection callback whose source epoch changed while it was running', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'coo-journal-race-'));
    roots.push(rootDir);
    let epoch = '0:0';
    const retainJournal = vi.fn(async () => 'queued' as const);
    const memory = {
      enabled: () => true,
      settled: () => true,
      journalDayRecorded: () => false,
      evidenceEpoch: () => epoch,
      reflectDetailed: async () => { epoch = '0:1'; return { text: 'A reflection from before Forget.', status: 'found', sourceSegments: [{ documentId: 'parent' }] }; },
      retainJournal,
      refreshModel: vi.fn(async () => {}),
    } as unknown as HindsightMemory;
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-10-22' }));
    const journal = new RelationshipJournal();
    journal.configure({ memory, rootDir, timezone: 'UTC', enabled: true, now });

    await journal.runDue();

    expect(retainJournal).not.toHaveBeenCalled();
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toContain('2026-10-22');
  });

  it('resumes a durably queued day without regenerating different text', async () => {
    const { journal, rootDir, reflect, retainJournal } = setup();
    journal.configure({ memory: { enabled: () => true, settled: () => true, journalDayRecorded: () => true } as unknown as HindsightMemory, rootDir, timezone: 'UTC', enabled: true, now });
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-10-22' }));
    await journal.runDue();
    expect(reflect).not.toHaveBeenCalled();
    expect(retainJournal).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(rootDir, 'journal.json'), 'utf8')).lastDay).toBe('2026-10-23');
  });

  it('preserves a corrupt marker rather than skipping unrecorded days', async () => {
    const { journal, rootDir, reflect, retainJournal } = setup();
    writeFileSync(join(rootDir, 'journal.json'), '{broken');
    await journal.runDue();
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toBe('{broken');
    expect(reflect).not.toHaveBeenCalled();
    expect(retainJournal).not.toHaveBeenCalled();
  });

  it('limits catch-up to the last three completed days', async () => {
    const { journal, rootDir, retainJournal } = setup();
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-09-01' }));
    await journal.runDue();
    expect(retainJournal.mock.calls.map((call) => (call as unknown as [string, string])[1])).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  });

  it('does nothing when disabled', async () => {
    const { journal, rootDir, retainJournal } = setup();
    journal.configure({ memory: { enabled: () => true } as unknown as HindsightMemory, rootDir, timezone: 'UTC', enabled: false, now });
    await journal.runDue();
    expect(retainJournal).not.toHaveBeenCalled();
  });
});
