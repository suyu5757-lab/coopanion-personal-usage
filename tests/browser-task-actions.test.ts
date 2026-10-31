import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashContent } from '../core/browser/actions.ts';
import { BrowserTaskActionJournal } from '../core/browser/task-actions.ts';
import type { BrowserTargetEvidence } from '../core/task-grants.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const target: BrowserTargetEvidence = {
  surface: 'browser',
  instanceId: 'browser-session-1',
  origin: 'https://creator.douyin.com',
  url: 'https://creator.douyin.com/creator-micro/upload',
  accountRef: 'creator-1',
  snapshotId: 'page-1',
  formId: 'file:88',
  control: 'Upload video (video/mp4, multiple)',
};

function journal() {
  dir = mkdtempSync(join(tmpdir(), 'coopanion-browser-task-journal-'));
  return new BrowserTaskActionJournal(join(dir, 'task-actions.json'));
}

function record(duplicateKey = 'same-task') {
  return {
    taskId: 'session:round-1',
    intent: 'media-upload' as const,
    target,
    payloadDigest: hashContent('approved files'),
    files: [{ path: 'clips/approved.mp4', digest: 'a'.repeat(64), bytes: 100, mime: 'video/mp4' }],
    duplicateKey,
  };
}

describe('BrowserTaskActionJournal', () => {
  it('persists acting before dispatch and blocks the same unknown action after restart', () => {
    const first = journal();
    const action = first.begin(record(), 1_000);
    first.awaitingApproval(action.id, 1_001);
    first.acting(action.id, 'b'.repeat(64), 1_002, 30_000, 1_003);
    first.finish(action.id, 'unknown', 'the page did not confirm the selection', 1_004);

    const reopened = new BrowserTaskActionJournal(join(dir, 'task-actions.json'));
    expect(reopened.hasUnresolved('same-task')).toBe(true);
    expect(() => reopened.begin(record(), 1_005)).toThrow(/needs review/);
  });

  it('allows a completed action to run again after its result was verified', () => {
    const store = journal();
    const action = store.begin(record(), 1_000);
    store.awaitingApproval(action.id, 1_001);
    store.acting(action.id, 'b'.repeat(64), 1_002, 30_000, 1_003);
    store.finish(action.id, 'verified', 'the page displayed the selected file', 1_004);
    expect(store.hasUnresolved('same-task')).toBe(false);
    expect(store.begin(record(), 1_005).phase).toBe('planned');
  });

  it('keeps unresolved receipts when old completed receipts exceed the retention limit', () => {
    journal();
    const file = join(dir, 'task-actions.json');
    const unresolved = [
      { ...record('older-unknown'), id: 'older-unknown', phase: 'unknown', createdAt: 1, updatedAt: 1, outcome: 'unknown' },
      { ...record('older-acting'), id: 'older-acting', phase: 'acting', createdAt: 2, updatedAt: 2 },
    ];
    const completed = Array.from({ length: 500 }, (_, index) => ({
      ...record(`completed-${index}`),
      id: `completed-${index}`,
      phase: 'verified',
      createdAt: index + 3,
      updatedAt: index + 3,
      outcome: 'ui-observed',
    }));
    writeFileSync(file, `${JSON.stringify([...unresolved, ...completed])}\n`);

    const store = new BrowserTaskActionJournal(file);
    store.begin(record('new-action'), 2_000);

    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Array<{ id: string; phase: string }>;
    expect(persisted).toHaveLength(500);
    expect(persisted.find((action) => action.id === 'older-unknown')?.phase).toBe('unknown');
    expect(persisted.find((action) => action.id === 'older-acting')?.phase).toBe('acting');

    const reopened = new BrowserTaskActionJournal(file);
    expect(reopened.hasUnresolved('older-unknown')).toBe(true);
    expect(reopened.hasUnresolved('older-acting')).toBe(true);
    expect(() => reopened.begin(record('older-unknown'), 2_001)).toThrow(/needs review/);
    expect(() => reopened.begin(record('older-acting'), 2_002)).toThrow(/needs review/);
  });

  it('refuses an unreadable journal', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-browser-task-journal-'));
    const path = join(dir, 'task-actions.json');
    writeFileSync(path, '[]broken');
    expect(() => new BrowserTaskActionJournal(path)).toThrow();
  });
});
