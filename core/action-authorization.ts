import { ActionGate } from './action-gate.ts';
import { ActionReceiptLedger, actionReceiptDuplicateKey, type ActionReceipt, type ActionReceiptCompletion } from './action-receipts.ts';
import type { FileSystemStepGrantRequest } from './action-gate.ts';

export interface FileSystemActionAuthorizationRequest extends FileSystemStepGrantRequest {
  actionName: string;
  payloadDigest: string;
}

export interface FileSystemActionAuthorization {
  receipt: ActionReceipt;
  consume(target: FileSystemActionAuthorizationRequest['target'], expectedChange: string, files: FileSystemStepGrantRequest['files']): boolean;
  revoke(): void;
  complete(result: ActionReceiptCompletion): void;
}

/** Persists the proposed operation before asking Core to grant its one dispatch. */
export async function authorizeFileSystemAction(
  ledger: ActionReceiptLedger | null,
  gate: ActionGate,
  request: FileSystemActionAuthorizationRequest,
  confirmInCoreUi: () => Promise<boolean>,
): Promise<FileSystemActionAuthorization | null> {
  if (!ledger) return null;
  const duplicateKey = actionReceiptDuplicateKey(request.action, request.target, request.payloadDigest, request.expectedChange);
  let receipt: ActionReceipt;
  try {
    receipt = ledger.begin({
      taskId: request.taskId,
      intent: request.action,
      action: request.actionName,
      risk: request.risk,
      target: request.target,
      payloadDigest: request.payloadDigest,
      files: request.files,
      duplicateKey,
    });
    ledger.awaitingApproval(receipt.id);
  } catch {
    return null;
  }

  let authorization;
  try {
    authorization = await gate.requestFileSystemStep(request, confirmInCoreUi);
  } catch {
    ledger.finish(receipt.id, 'cancelled', 'the Core task grant could not be created');
    return null;
  }
  if (!authorization) {
    ledger.finish(receipt.id, 'cancelled', 'the Core task grant was not approved');
    return null;
  }
  try {
    ledger.acting(receipt.id, authorization.grantDigest, authorization.approvedAt, authorization.expiresAt);
  } catch {
    authorization.revoke();
    ledger.finish(receipt.id, 'cancelled', 'the approved grant could not be recorded');
    return null;
  }

  return {
    receipt,
    consume(target, expectedChange, files) {
      const consumed = authorization.consume(target, expectedChange, files);
      if (!consumed) ledger.finish(receipt.id, 'cancelled', 'the workspace target or payload changed before dispatch');
      return consumed;
    },
    revoke() {
      authorization.revoke();
      ledger.finish(receipt.id, 'cancelled', 'the workspace action was revoked before dispatch');
    },
    complete(result) {
      ledger.complete(receipt.id, result);
    },
  };
}
