import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AffectionEvent } from '../core/memory/affection.ts';
import type { AffectionLedger } from '../core/memory/affection.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import { RelationshipJournal } from '../core/memory/journal.ts';

const now = () => new Date('2026-10-24T10:00:00.000Z');
const event = (ts = '2026-10-23T12:00:00.000Z'): AffectionEvent => ({ id: 'p1', ts, kind: 'pet', delta: 1, source: 'touch', reason: 'patted' });

function setup(events: AffectionEvent[] = []) {
  const rootDir = mkdtempSync(join(tmpdir(), 'coo-journal-'));
  const reflect = vi.fn(async () => 'A warm, quiet day with tea and a short chat.');
  const retainJournal = vi.fn();
  const refreshModel = vi.fn(async () => {});
  const memory = {
    enabled: () => true,
    reflect,
    retainJournal,
    refreshModel,
  } as unknown as HindsightMemory;
  const affection = {
    enabled: () => true,
    eventsOn: (day: string) => events.filter((e) => e.ts.startsWith(day)),
    summary: () => 'pet×1 (+1); bond 1/1000, mood +1',
    snapshot: () => '[affection] Bond Lv.1',
  } as unknown as AffectionLedger;
  const journal = new RelationshipJournal();
  journal.configure({ memory, affection, rootDir, timezone: 'UTC', enabled: true, now });
  return { journal, rootDir, reflect, retainJournal, refreshModel };
}

describe('daily relationship journal', () => {
  it('marks the first quiet run without inventing a journal', async () => {
    const { journal, rootDir, retainJournal } = setup();
    await journal.runDue();
    expect(retainJournal).not.toHaveBeenCalled();
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toContain('2026-10-23');
  });

  it('reflects on affection and writes the day into long-term memory', async () => {
    const { journal, rootDir, reflect, retainJournal, refreshModel } = setup([event()]);
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-10-22' }));
    await journal.runDue();
    expect(reflect).toHaveBeenCalledWith(expect.stringContaining('2026-10-23'), expect.objectContaining({ tags: ['scope:affection'] }));
    expect(retainJournal).toHaveBeenCalledWith('A warm, quiet day with tea and a short chat.', '2026-10-23');
    expect(refreshModel).toHaveBeenCalledWith('relationship');
    expect(readFileSync(join(rootDir, 'journal.json'), 'utf8')).toContain('2026-10-23');
  });

  it('writes a quiet day when there are no affection events', async () => {
    const { journal, rootDir, retainJournal } = setup();
    writeFileSync(join(rootDir, 'journal.json'), JSON.stringify({ lastDay: '2026-10-22' }));
    await journal.runDue();
    expect(retainJournal).toHaveBeenCalledWith(expect.stringContaining('A quiet day'), '2026-10-23');
  });

  it('does nothing when disabled', async () => {
    const { journal, rootDir, retainJournal } = setup([event()]);
    journal.configure({ memory: { enabled: () => true } as unknown as HindsightMemory, affection: { enabled: () => true } as unknown as AffectionLedger, rootDir, timezone: 'UTC', enabled: false, now });
    await journal.runDue();
    expect(retainJournal).not.toHaveBeenCalled();
  });
});
