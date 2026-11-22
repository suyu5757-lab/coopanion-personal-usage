import { ActionGate } from './action-gate.ts';
import { ActionReceiptLedger, actionReceiptDuplicateKey, type ActionReceipt, type ActionReceiptCompletion } from './action-receipts.ts';
import type { FileSystemStepGrantRequest } from './action-gate.ts';
import type { ApprovalChannel, CoreUiApproval } from './task-grants.ts';
import type { WorkspaceWriteOperation } from './workspace-permissions.ts';

export interface FileSystemActionAuthorizationRequest extends FileSystemStepGrantRequest {
  actionName: string;
  payloadDigest: string;
  /** The fields below describe a Persona workspace write; other worlds may omit them. */
  operation?: WorkspaceWriteOperation;
  targetState?: 'absent' | 'present';
  baseDigest?: string | null;
  /** Bytes added or replaced by this write. */
  deltaBytes?: number;
  sessionId?: string;
  /** A self-time, Growth or other turn where no person is expected to see a bubble. */
  background?: boolean;
}

export interface WorkspaceAuthorization {
  decision: 'AUTO_ALLOW' | 'DENY' | 'DEFER';
  reason: string;
  channel?: ApprovalChannel;
  ruleId?: string;
  pendingId?: string;
}

/** Host-owned decision; a World or tool result cannot stand in for it. */
export interface WorkspaceAuthorizer {
  authorize(request: FileSystemActionAuthorizationRequest): Promise<WorkspaceAuthorization>;
}

export interface FileSystemActionAuthorization {
  receipt: ActionReceipt;
  consume(target: FileSystemActionAuthorizationRequest['target'], expectedChange: string, files: FileSystemStepGrantRequest['files']): boolean;
  revoke(): void;
  complete(result: ActionReceiptCompletion): void;
}

export interface FileSystemActionRefusal {
  status: 'denied' | 'deferred';
  reason: string;
  pendingId?: string;
}

export interface AuthorizedFileSystemAction extends FileSystemActionAuthorization {
  status: 'authorized';
}

/** Confirms through the app's own UI; the legacy shape the OpenCode and video worlds accept. */
export type LegacyWorkspaceConfirmation = () => Promise<boolean | CoreUiApproval>;

function normalizeApproval(value: boolean | CoreUiApproval): CoreUiApproval {
  return typeof value === 'boolean' ? { approved: value } : value;
}

function beginReceipt(
  ledger: ActionReceiptLedger,
  request: FileSystemActionAuthorizationRequest,
): ActionReceipt {
  const duplicateKey = actionReceiptDuplicateKey(request.action, request.target, request.payloadDigest, request.expectedChange);
  const receipt = ledger.begin({
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
  return receipt;
}

/**
 * Persists the proposed operation, asks the Host policy, then asks Core for one dispatch.
 * A refusal is reported as data so the Persona tool can tell the model not to retry.
 */
export async function authorizeFileSystemActionEx(
  ledger: ActionReceiptLedger | null,
  gate: ActionGate,
  request: FileSystemActionAuthorizationRequest,
  authorize: WorkspaceAuthorizer,
): Promise<AuthorizedFileSystemAction | FileSystemActionRefusal | null> {
  if (!ledger) return null;
  let receipt: ActionReceipt;
  try {
    receipt = beginReceipt(ledger, request);
  } catch {
    return null;
  }

  let decision: WorkspaceAuthorization;
  try {
    decision = await authorize.authorize(request);
  } catch {
    ledger.finish(receipt.id, 'cancelled', 'the workspace permission decision failed closed');
    return { status: 'denied', reason: 'authorizer-unavailable' };
  }
  if (decision.decision !== 'AUTO_ALLOW') {
    const status = decision.decision === 'DEFER' ? 'deferred' : 'denied';
    ledger.finish(receipt.id, 'cancelled', status === 'deferred'
      ? `deferred to workspace permissions: ${decision.reason}`
      : `denied by workspace policy: ${decision.reason}`);
    return { status, reason: decision.reason, ...(decision.pendingId ? { pendingId: decision.pendingId } : {}) };
  }

  let authorization;
  try {
    authorization = await gate.requestFileSystemStep(
      { ...request, ...(decision.ruleId ? { policyRuleId: decision.ruleId } : {}) },
      async () => ({ approved: true, channel: decision.channel ?? 'durable-rule', ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) }),
    );
  } catch {
    ledger.finish(receipt.id, 'cancelled', 'the Core task grant could not be created');
    return { status: 'denied', reason: 'grant-failed' };
  }
  if (!authorization) {
    ledger.finish(receipt.id, 'cancelled', 'the Core task grant was not approved');
    return { status: 'denied', reason: 'grant-not-approved' };
  }
  try {
    ledger.acting(receipt.id, authorization.grantDigest, authorization.approvedAt, authorization.expiresAt, Date.now(), {
      channel: authorization.approvalChannel,
      ...(authorization.policyRuleId ? { ruleId: authorization.policyRuleId } : {}),
    });
  } catch {
    authorization.revoke();
    ledger.finish(receipt.id, 'cancelled', 'the approved grant could not be recorded');
    return { status: 'denied', reason: 'grant-record-failed' };
  }

  return {
    status: 'authorized',
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

/** The OpenCode and video worlds' contract: a refusal is simply no authorization. */
export async function authorizeFileSystemAction(
  ledger: ActionReceiptLedger | null,
  gate: ActionGate,
  request: FileSystemActionAuthorizationRequest,
  confirmInCoreUi: LegacyWorkspaceConfirmation,
): Promise<FileSystemActionAuthorization | null> {
  const result = await authorizeFileSystemActionEx(ledger, gate, request, {
    async authorize() {
      const approval = normalizeApproval(await confirmInCoreUi());
      return approval.approved
        ? { decision: 'AUTO_ALLOW', reason: 'world-confirmation', channel: approval.channel ?? 'core-pet-bubble', ...(approval.ruleId ? { ruleId: approval.ruleId } : {}) }
        : { decision: 'DENY', reason: 'world-declined' };
    },
  });
  return result && 'status' in result && result.status === 'authorized' ? result : null;
}
