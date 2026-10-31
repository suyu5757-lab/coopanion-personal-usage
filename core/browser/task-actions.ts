/** Browser migration helpers for the Core-owned action receipt ledger. */
import { hashContent, type PublicAction } from './actions.ts';
import {
  ActionReceiptLedger,
  type ActionReceipt,
  type BrowserTaskFile,
  type BrowserTaskIntent,
} from '../action-receipts.ts';
import type { BrowserTargetEvidence } from '../task-grants.ts';

export {
  ActionReceiptLedger,
  actionReceiptDuplicateKey,
  defaultActionRisk,
} from '../action-receipts.ts';
export type {
  ActionDispatchState,
  ActionIntent,
  ActionReceipt,
  ActionReceiptCompletion,
  ActionReceiptEvidence,
  ActionReceiptOutcome,
  ActionReceiptPhase,
  ActionRisk,
  BrowserTaskAction,
  BrowserTaskFile,
  BrowserTaskIntent,
  BrowserTaskPhase,
  NewActionReceipt,
} from '../action-receipts.ts';

export function browserDuplicateKey(
  intent: BrowserTaskIntent,
  target: BrowserTargetEvidence,
  payloadDigest: string,
  dedupeKey: string | undefined,
  files: readonly BrowserTaskFile[],
): string {
  return hashContent(JSON.stringify([
    intent, target.origin, target.accountRef, target.formId, payloadDigest, dedupeKey ?? files,
  ]));
}

/** Browser-only helpers retained while old public text receipts move into the shared ledger. */
export class BrowserTaskActionJournal extends ActionReceiptLedger {
  hasUnresolvedComment(commentFingerprint: string): boolean {
    return this.hasUnresolvedMatching((action) => action.commentFingerprint === commentFingerprint);
  }

  hasLegacyTextCollision(videoUrl: string, payloadDigest: string, commentFingerprint?: string): boolean {
    return this.hasUnresolvedMatching((action) => action.id.startsWith('legacy:')
      && action.intent === 'platform-write'
      && action.target.surface === 'browser'
      && action.target.formId === `video:${videoUrl}`
      && action.payloadDigest === payloadDigest
      && (!action.commentFingerprint || !commentFingerprint || action.commentFingerprint === commentFingerprint));
  }

  importLegacy(action: PublicAction, now = Date.now()): void {
    const target: BrowserTargetEvidence = {
      surface: 'browser',
      instanceId: 'legacy-browser-action-journal',
      origin: action.target.origin,
      url: action.target.url,
      accountRef: action.target.accountRef ?? 'legacy-unknown-account',
      snapshotId: action.target.snapshotId,
      formId: `video:${action.target.videoUrl}`,
      control: 'text-submit',
    };
    const duplicateKey = browserDuplicateKey('platform-write', target, action.contentHash, action.target.commentFingerprint, []);
    const id = `legacy:${action.taskId}`;
    const receipt: ActionReceipt = {
      id,
      actionId: id,
      attemptId: action.taskId,
      taskId: action.taskId,
      intent: 'platform-write',
      action: 'platform-write:text-submit',
      risk: 'IRREVERSIBLE_OR_PUBLIC',
      phase: 'unknown',
      target,
      payloadDigest: action.contentHash,
      files: [],
      ...(action.target.commentFingerprint ? { commentFingerprint: action.target.commentFingerprint } : {}),
      duplicateKey,
      createdAt: action.createdAt,
      updatedAt: now,
      dispatchState: 'unknown',
      outcome: 'unknown',
      evidence: [{ source: 'legacy-action-journal', status: 'unknown', summary: 'legacy result needs reconciliation', observedAt: now }],
      note: 'migrated from the legacy public-text action journal; reconcile before retry',
    };
    this.importUnresolved(receipt);
  }
}
