import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import { RelationshipJournal } from '../core/memory/journal.ts';

const now = () => new Date('2026-10-24T10:00:00.000Z');

function setup(answer = 'A warm, quiet day with tea and a short chat.') {
  const rootDir = mkdtempSync(join(tmpdir(), 'coo-journal-'));
  const reflect = vi.fn(async () => answer);
  const retainJournal = vi.fn();
  const refreshModel = vi.fn(async () => {});
  const memory = {
    enabled: () => true,
    reflect,
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
    expect(retainJournal).toHaveBeenCalledWith('A warm, quiet day with tea and a short chat.', '2026-10-23');
    expect(refreshModel).toHaveBeenCalledWith('relationship');
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toContain('2026-10-23');
  });

  it('falls back to a quiet entry when reflection is empty', async () => {
    const { journal, rootDir, retainJournal } = setup('');
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-10-22' }));
    await journal.runDue();
    expect(retainJournal).toHaveBeenCalledWith(expect.stringContaining('A quiet day'), '2026-10-23');
  });

  it('does nothing when disabled', async () => {
    const { journal, rootDir, retainJournal } = setup();
    journal.configure({ memory: { enabled: () => true } as unknown as HindsightMemory, rootDir, timezone: 'UTC', enabled: false, now });
    await journal.runDue();
    expect(retainJournal).not.toHaveBeenCalled();
  });
});
