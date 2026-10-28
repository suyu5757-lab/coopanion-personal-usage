import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('refuses an unreadable journal', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-browser-task-journal-'));
    const path = join(dir, 'task-actions.json');
    writeFileSync(path, '[]broken');
    expect(() => new BrowserTaskActionJournal(path)).toThrow();
  });
});
