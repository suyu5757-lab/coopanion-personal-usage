import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionReceiptLedger, actionReceiptDuplicateKey } from '../core/action-receipts.ts';
import { hashContent } from '../core/browser/actions.ts';
import { browserDuplicateKey } from '../core/browser/task-actions.ts';
import type { BrowserTargetEvidence, DesktopTargetEvidence, FileSystemTargetEvidence } from '../core/task-grants.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('shared ActionReceiptLedger', () => {
  it('records a media download as a reversible local write', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-action-receipts-'));
    const ledger = new ActionReceiptLedger(join(dir, 'receipts.json'));
    const receipt = ledger.begin({
      taskId: 'browser-download-1', intent: 'media-download', target: {
        surface: 'browser', instanceId: 'browser-1', origin: 'https://example.com',
        url: 'https://example.com/page', accountRef: 'browser-1', snapshotId: 'snapshot-1',
        formId: `media:${'a'.repeat(64)}`, control: `image:${'a'.repeat(64)}`,
      }, payloadDigest: hashContent('asset.png'), files: [], duplicateKey: 'download-1',
    }, 3_000);
    expect(receipt).toMatchObject({ intent: 'media-download', risk: 'REVERSIBLE_LOCAL', phase: 'planned' });
  });

  it('persists non-mutating observations while a media receipt stays unresolved', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-action-receipts-'));
    const file = join(dir, 'receipts.json');
    const ledger = new ActionReceiptLedger(file);
    const target: BrowserTargetEvidence = {
      surface: 'browser', instanceId: 'browser-1', origin: 'https://creator.douyin.com',
      url: 'https://creator.douyin.com/creator-micro/upload', accountRef: 'account-1', snapshotId: 'upload-page-1',
      formId: 'file:88', control: 'upload input',
    };
    const receipt = ledger.begin({
      taskId: 'browser-upload-1', intent: 'media-upload', risk: 'EXTERNAL_MUTATION', target,
      payloadDigest: hashContent('preview.mp4'), files: [], duplicateKey: 'douyin-upload-1',
    }, 1_000);
    ledger.awaitingApproval(receipt.id, 1_001);
    ledger.acting(receipt.id, 'a'.repeat(64), 1_002, 30_000, 1_003);
    ledger.complete(receipt.id, {
      phase: 'acting', dispatchState: 'delivered', outcome: 'delivered', note: 'file selected',
    }, 1_004);

    expect(ledger.observe(receipt.id, [{
      source: 'douyin-upload-status', status: 'uploading', digest: hashContent('正在上传'), observedAt: 1_005,
    }], 'upload progress observed', 1_005)).toBe(true);

    const reopened = new ActionReceiptLedger(file);
    expect(reopened.listUnresolved()).toMatchObject([{
      id: receipt.id,
      phase: 'acting',
      dispatchState: 'delivered',
      note: 'upload progress observed',
      evidence: [expect.objectContaining({ status: 'uploading', digest: hashContent('正在上传') })],
    }]);
    expect(reopened.hasUnresolved('douyin-upload-1')).toBe(true);
  });

  it('keeps a draft-ready media upload reviewable and stores multiple page observations', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-action-receipts-'));
    const file = join(dir, 'receipts.json');
    const ledger = new ActionReceiptLedger(file);
    const target: BrowserTargetEvidence = {
      surface: 'browser', instanceId: 'browser-1', origin: 'https://creator.douyin.com',
      url: 'https://creator.douyin.com/creator-micro/upload', accountRef: 'account-1', snapshotId: 'upload-page-1',
      formId: 'file:88', control: 'upload input',
    };
    const receipt = ledger.begin({
      taskId: 'browser-upload-2', intent: 'media-upload', risk: 'EXTERNAL_MUTATION', target,
      payloadDigest: hashContent('preview.mp4'), files: [], duplicateKey: 'douyin-upload-2',
    }, 2_000);
    ledger.awaitingApproval(receipt.id, 2_001);
    ledger.acting(receipt.id, 'e'.repeat(64), 2_002, 30_000, 2_003);
    ledger.complete(receipt.id, {
      phase: 'draft-ready', dispatchState: 'delivered', outcome: 'draft-ready', note: 'draft is ready',
      evidence: [
        { source: 'douyin-upload-notice', status: 'observed', digest: hashContent('草稿已保存'), observedAt: 2_004 },
        { source: 'douyin-upload-state', status: 'draft_ready', observedAt: 2_004 },
      ],
    }, 2_004);

    const reopened = new ActionReceiptLedger(file);
    expect(reopened.listUnresolved()).toMatchObject([{
      id: receipt.id, phase: 'draft-ready', dispatchState: 'delivered', outcome: 'draft-ready',
    }]);
    expect(reopened.reconcile(receipt.id, 'review-pending', 'The page shows the upload under review.', 2_005)).toBe(true);
    expect(new ActionReceiptLedger(file).listUnresolved()).toMatchObject([{
      id: receipt.id, phase: 'review-pending', outcome: 'review-pending',
    }]);
  });

  it('retains an unresolved clipboard write across restart and blocks another copy', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-action-receipts-'));
    const file = join(dir, 'receipts.json');
    const ledger = new ActionReceiptLedger(file);
    const target: BrowserTargetEvidence = {
      surface: 'browser', instanceId: 'browser-1', origin: 'https://www.example.test',
      url: 'https://www.example.test/item/1', accountRef: 'account-1', snapshotId: 'page-1',
      formId: 'clipboard:https://www.example.test/item/1', control: 'clipboard-copy',
    };
    const payloadDigest = hashContent('https://www.example.test/item/1');
    const duplicateKey = browserDuplicateKey('clipboard-write', target, payloadDigest, undefined, []);
    const receipt = ledger.begin({
      taskId: 'browser-call-copy', intent: 'clipboard-write', action: 'clipboard-copy',
      risk: 'REVERSIBLE_LOCAL', target, payloadDigest, files: [], duplicateKey,
    }, 500);
    ledger.awaitingApproval(receipt.id, 501);
    ledger.acting(receipt.id, 'f'.repeat(64), 502, 30_000, 503);
    ledger.complete(receipt.id, {
      phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown',
      note: 'the page did not confirm whether the link was copied',
    }, 504);

    const reopened = new ActionReceiptLedger(file);
    expect(reopened.hasUnresolved(duplicateKey)).toBe(true);
    const retryTarget = { ...target, instanceId: 'browser-2' };
    const retryKey = browserDuplicateKey('clipboard-write', retryTarget, payloadDigest, undefined, []);
    expect(retryKey).toBe(duplicateKey);
    expect(() => reopened.begin({
      taskId: 'browser-call-copy-retry', intent: 'clipboard-write', action: 'clipboard-copy',
      risk: 'REVERSIBLE_LOCAL', target: retryTarget,
      payloadDigest, files: [], duplicateKey: retryKey,
    }, 505)).toThrow(/needs review/);
  });

  it('persists Browser and desktop receipts with common IDs and distinct evidence states', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-action-receipts-'));
    const file = join(dir, 'receipts.json');
    const ledger = new ActionReceiptLedger(file);
    const browserTarget: BrowserTargetEvidence = {
      surface: 'browser',
      instanceId: 'browser-1',
      origin: 'https://www.example.test',
      url: 'https://www.example.test/item/1',
      accountRef: 'account-1',
      snapshotId: 'page-1',
      formId: 'item:1',
      control: 'comment-submit',
    };
    const browser = ledger.begin({
      taskId: 'browser-call-1',
      intent: 'platform-write',
      risk: 'IRREVERSIBLE_OR_PUBLIC',
      target: browserTarget,
      payloadDigest: hashContent('approved text'),
      files: [],
      duplicateKey: 'browser-duplicate-key',
    }, 1_000);
    ledger.awaitingApproval(browser.id, 1_001);
    ledger.acting(browser.id, 'a'.repeat(64), 1_002, 30_000, 1_003);
    ledger.complete(browser.id, {
      phase: 'verified',
      dispatchState: 'delivered',
      outcome: 'ui-observed',
      note: 'the page showed the editor cleared',
      evidence: { source: 'page-agent', status: 'observed', observedAt: 1_004 },
    }, 1_004);

    const desktopTarget: DesktopTargetEvidence = {
      surface: 'desktop',
      instanceId: 'core-run-1',
      bundleId: 'com.apple.TextEdit',
      executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
      pid: 42,
      ownerPid: 42,
      processStart: '2026-10-31T00:00:00Z',
      windowId: 7,
      bounds: { x: 0, y: 0, width: 700, height: 500 },
      display: null,
      space: null,
      snapshotId: 'window-snapshot-1',
      captureId: 'capture-1',
      route: 'background-window-pixel',
      source: 'cua-driver',
    };
    const payloadDigest = hashContent('pet_cua_type: type "hello"');
    const desktopKey = actionReceiptDuplicateKey('computer-input', desktopTarget, payloadDigest, 'type hello');
    const desktop = ledger.begin({
      taskId: 'cua-call-1',
      intent: 'computer-input',
      risk: 'REVERSIBLE_LOCAL',
      target: desktopTarget,
      payloadDigest,
      files: [],
      duplicateKey: desktopKey,
    }, 2_000);
    ledger.awaitingApproval(desktop.id, 2_001);
    ledger.acting(desktop.id, 'b'.repeat(64), 2_002, 30_000, 2_003);
    ledger.complete(desktop.id, {
      phase: 'unknown',
      dispatchState: 'delivered',
      outcome: 'unknown',
      note: 'the driver returned an unverified effect',
      evidence: { source: 'cua-driver', status: 'unverifiable', observedAt: 2_004 },
    }, 2_004);

    const reopened = new ActionReceiptLedger(file);
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ actionId: browser.id, attemptId: browser.attemptId, action: 'platform-write', risk: 'IRREVERSIBLE_OR_PUBLIC', outcome: 'ui-observed' });
    expect(persisted[1]).toMatchObject({ actionId: desktop.id, attemptId: desktop.attemptId, action: 'computer-input', target: { surface: 'desktop' }, dispatchState: 'delivered', outcome: 'unknown' });
    expect(reopened.hasUnresolved(desktopKey)).toBe(true);
    const restartedTarget: DesktopTargetEvidence = {
      ...desktopTarget,
      instanceId: 'core-run-2',
      pid: 84,
      ownerPid: 84,
      processStart: '2026-10-31T02:00:00Z',
      windowId: 9,
      snapshotId: 'window-snapshot-2',
      captureId: 'capture-2',
    };
    const restartedKey = actionReceiptDuplicateKey('computer-input', restartedTarget, payloadDigest, 'type hello');
    expect(restartedKey).toBe(desktopKey);
    expect(reopened.hasUnresolved(restartedKey)).toBe(true);
    expect(() => reopened.begin({
      taskId: 'cua-call-2',
      intent: 'computer-input',
      risk: 'REVERSIBLE_LOCAL',
      target: restartedTarget,
      payloadDigest,
      files: [],
      duplicateKey: restartedKey,
    }, 2_005)).toThrow(/needs review/);

    const reviewPayload = hashContent('pet_cua_key: press Return');
    const reviewKey = actionReceiptDuplicateKey('computer-input', desktopTarget, reviewPayload, 'press Return');
    const review = reopened.begin({
      taskId: 'cua-call-review',
      intent: 'computer-input',
      action: 'pet_cua_key',
      risk: 'EXTERNAL_MUTATION',
      target: desktopTarget,
      payloadDigest: reviewPayload,
      files: [],
      duplicateKey: reviewKey,
    }, 2_006);
    reopened.awaitingApproval(review.id, 2_007);
    reopened.acting(review.id, 'c'.repeat(64), 2_008, 30_000, 2_009);
    reopened.complete(review.id, {
      phase: 'review-pending',
      dispatchState: 'delivered',
      outcome: 'review-pending',
      note: 'the remote service is reviewing the submitted change',
    }, 2_010);
    const reviewAfterRestart = new ActionReceiptLedger(file);
    expect(reviewAfterRestart.hasUnresolved(reviewKey)).toBe(true);
    expect(() => reviewAfterRestart.begin({
      taskId: 'cua-call-review-retry',
      intent: 'computer-input',
      action: 'pet_cua_key',
      risk: 'EXTERNAL_MUTATION',
      target: desktopTarget,
      payloadDigest: reviewPayload,
      files: [],
      duplicateKey: reviewKey,
    }, 2_011)).toThrow(/needs review/);
  });

  it('keeps an unresolved workspace write from being retried with a changed payload', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-action-receipts-'));
    const file = join(dir, 'receipts.json');
    const ledger = new ActionReceiptLedger(file);
    const target: FileSystemTargetEvidence = {
      surface: 'filesystem',
      instanceId: 'opencode-task-1',
      workspaceRoot: '/tmp/coopanion-work',
      path: 'src/main.ts',
      operation: 'file-write',
      snapshotId: 'before-hash',
      source: 'opencode-acp',
    };
    const originalDigest = hashContent('first version');
    const duplicateKey = actionReceiptDuplicateKey('file-write', target, originalDigest);
    const original = ledger.begin({
      taskId: 'opencode-task-1:file-write-1',
      intent: 'file-write',
      action: 'opencode edit',
      risk: 'REVERSIBLE_LOCAL',
      target,
      payloadDigest: originalDigest,
      files: [{ path: 'src/main.ts', digest: originalDigest, bytes: 13, mime: 'text/plain' }],
      duplicateKey,
    }, 3_000);
    ledger.awaitingApproval(original.id, 3_001);
    ledger.acting(original.id, 'd'.repeat(64), 3_002, 30_000, 3_003);
    ledger.complete(original.id, {
      phase: 'unknown',
      dispatchState: 'delivered',
      outcome: 'unknown',
      note: 'the ACP result was lost after the edit dispatch',
    }, 3_004);

    const reopened = new ActionReceiptLedger(file);
    const changedDigest = hashContent('different version');
    const retryKey = actionReceiptDuplicateKey('file-write', {
      ...target,
      instanceId: 'persona-task-2',
      source: 'persona-workspace',
    }, changedDigest);
    expect(retryKey).toBe(duplicateKey);
    expect(() => reopened.begin({
      taskId: 'opencode-task-2:file-write-1',
      intent: 'file-write',
      action: 'opencode edit',
      risk: 'REVERSIBLE_LOCAL',
      target: { ...target, instanceId: 'opencode-task-2' },
      payloadDigest: changedDigest,
      files: [{ path: 'src/main.ts', digest: changedDigest, bytes: 17, mime: 'text/plain' }],
      duplicateKey: retryKey,
    }, 3_005)).toThrow(/needs review/);
  });

  it('lets an operator reconcile only unresolved receipts with a recorded observation', () => {
    dir = mkdtempSync(join(tmpdir(), 'coopanion-action-receipts-'));
    const file = join(dir, 'receipts.json');
    const ledger = new ActionReceiptLedger(file);
    const target: BrowserTargetEvidence = {
      surface: 'browser', instanceId: 'browser-1', origin: 'https://www.example.test',
      url: 'https://www.example.test/item/1', accountRef: 'account-1', snapshotId: 'page-1',
      formId: 'item:1', control: 'publish',
    };
    const duplicateKey = actionReceiptDuplicateKey('platform-write', target, hashContent('post'));
    const receipt = ledger.begin({
      taskId: 'browser-call-review', intent: 'platform-write', action: 'publish', risk: 'IRREVERSIBLE_OR_PUBLIC',
      target, payloadDigest: hashContent('post'), files: [], duplicateKey,
    }, 4_000);
    ledger.awaitingApproval(receipt.id, 4_001);
    ledger.acting(receipt.id, 'e'.repeat(64), 4_002, 30_000, 4_003);
    ledger.complete(receipt.id, {
      phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown', note: 'the page did not answer after submit',
    }, 4_004);

    expect(ledger.listUnresolved()).toHaveLength(1);
    expect(ledger.reconcile(receipt.id, 'review-pending', 'Creator Center shows the submission under review.', 4_005)).toBe(true);
    expect(ledger.listUnresolved()[0]).toMatchObject({ phase: 'review-pending', dispatchState: 'delivered', outcome: 'review-pending' });
    expect(ledger.reconcile(receipt.id, 'verified', 'The post is visible on the target page.', 4_006)).toBe(true);
    expect(ledger.listUnresolved()).toHaveLength(0);

    const reopened = new ActionReceiptLedger(file);
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(persisted[0]).toMatchObject({ phase: 'verified', outcome: 'verified', evidence: [
      expect.objectContaining({ source: 'operator-review', status: 'review-pending' }),
      expect.objectContaining({ source: 'operator-review', status: 'verified' }),
    ] });
    expect(reopened.reconcile(receipt.id, 'failed', 'no longer unresolved', 4_007)).toBe(false);
  });
});
