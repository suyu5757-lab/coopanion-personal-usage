import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplyJournal } from '../core/browser/actions.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const journalAt = () => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-replies-'));
  dirs.push(dir);
  return { dir, journal: new ReplyJournal(join(dir, 'replies.json')) };
};

describe('reply journal', () => {
  it('initializes once and keeps only the hashed comment identity across restarts', () => {
    const { dir, journal } = journalAt();
    const fingerprint = 'a'.repeat(64);
    expect(journal.load()).toEqual([]);
    journal.add(fingerprint, 1234);
    journal.add(fingerprint, 5678);
    expect(new ReplyJournal(join(dir, 'replies.json')).has(fingerprint)).toBe(true);
    expect(readFileSync(join(dir, 'replies.json'), 'utf8')).toContain(fingerprint);
    expect(readFileSync(join(dir, 'replies.json'), 'utf8')).not.toContain('comment text');
    expect(JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8'))).toEqual([{ fingerprint, sentAt: 1234 }]);
  });

  it('refuses to initialize again after an initialized journal disappears', () => {
    const { dir, journal } = journalAt();
    journal.load();
    const file = join(dir, 'replies.json');
    unlinkSync(file);
    expect(() => journal.load()).toThrow(/missing/);
  });

  it('rejects malformed and un-hashed entries', () => {
    const { dir, journal } = journalAt();
    journal.load();
    const file = join(dir, 'replies.json');
    const marker = `${file}.initialized`;
    expect(existsSync(marker)).toBe(true);
    writeFileSync(file, JSON.stringify([{ fingerprint: 'plain comment', sentAt: 1 }]));
    expect(() => journal.load()).toThrow(/valid reply list/);
  });
});
