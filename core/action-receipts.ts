/** Durable receipts for side effects that need a scoped user grant. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { writeState } from './state-file.ts';
import type { ActionRisk, ActionTargetEvidence, DesktopTargetEvidence } from './task-grants.ts';

export type ActionIntent = 'platform-write' | 'clipboard-write' | 'image-generation' | 'image-saving' | 'media-upload' | 'media-download' | 'computer-input' | 'file-write' | 'command-execution' | 'platform-api';
export type BrowserTaskIntent = Extract<ActionIntent, 'platform-write' | 'clipboard-write' | 'image-generation' | 'image-saving' | 'media-upload' | 'media-download'>;
export type ActionReceiptPhase = 'planned' | 'awaiting-approval' | 'acting' | 'draft-ready' | 'submitted' | 'review-pending' | 'verified' | 'unknown' | 'cancelled' | 'failed';
export type BrowserTaskPhase = ActionReceiptPhase;
export type BrowserTaskFile = { path: string; digest: string; bytes: number; mime: string };
export type { ActionRisk } from './task-grants.ts';
export type ActionReceiptOutcome = 'delivered' | 'ui-observed' | 'draft-ready' | 'remote-acknowledged' | 'review-pending' | 'verified' | 'unknown' | 'cancelled' | 'failed';
export type ActionDispatchState = 'not-dispatched' | 'delivered' | 'unknown';
export interface ActionReceiptEvidence {
  source: string;
  status: string;
  summary?: string;
  digest?: string;
  observedAt: number;
}
interface ActionReceiptCompletionDetails {
  note: string;
  evidence?: ActionReceiptEvidence | ActionReceiptEvidence[];
}
export type ActionReceiptCompletion =
  | (ActionReceiptCompletionDetails & { phase: 'draft-ready'; dispatchState: 'delivered'; outcome: 'draft-ready' })
  | (ActionReceiptCompletionDetails & { phase: 'review-pending'; dispatchState: 'delivered'; outcome: 'review-pending' })
  | (ActionReceiptCompletionDetails & { phase: 'submitted'; dispatchState: 'delivered'; outcome: 'remote-acknowledged' })
  | (ActionReceiptCompletionDetails & { phase: 'acting'; dispatchState: 'delivered'; outcome: 'delivered' })
  | (ActionReceiptCompletionDetails & { phase: 'verified'; dispatchState: 'delivered'; outcome: 'ui-observed' | 'remote-acknowledged' | 'verified' })
  | (ActionReceiptCompletionDetails & { phase: 'unknown'; dispatchState: ActionDispatchState; outcome: 'unknown' })
  | (ActionReceiptCompletionDetails & { phase: 'cancelled'; dispatchState: 'not-dispatched'; outcome: 'cancelled' })
  | (ActionReceiptCompletionDetails & { phase: 'failed'; dispatchState: ActionDispatchState; outcome: 'failed' });
export type ActionReceiptReviewDecision = 'verified' | 'review-pending' | 'failed';

export type ExperienceTrialOutcome = 'verified' | 'unknown' | 'failed';

/** A content-free receipt projection used when a person records a Growth skill trial. */
export interface ExperienceTrialReceipt {
  receiptId: string;
  taskFingerprint: string;
  intent: ActionIntent;
  outcome: ExperienceTrialOutcome;
  dispatchState: ActionDispatchState;
  createdAt: number;
}

export interface ActionReceipt {
  id: string;
  actionId: string;
  attemptId: string;
  taskId: string;
  intent: ActionIntent;
  action: string;
  risk: ActionRisk;
  phase: ActionReceiptPhase;
  target: ActionTargetEvidence;
  payloadDigest: string;
  files: BrowserTaskFile[];
  dispatchState: ActionDispatchState;
  evidence: ActionReceiptEvidence[];
  commentFingerprint?: string;
  duplicateKey: string;
  createdAt: number;
  updatedAt: number;
  approvalChannel?: 'core-pet-bubble';
  grantDigest?: string;
  approvedAt?: number;
  expiresAt?: number;
  outcome?: ActionReceiptOutcome;
  note?: string;
}

export type BrowserTaskAction = ActionReceipt;
export type NewActionReceipt = Omit<ActionReceipt, 'id' | 'actionId' | 'attemptId' | 'phase' | 'createdAt' | 'updatedAt' | 'risk' | 'dispatchState' | 'evidence' | 'action'>
  & Partial<Pick<ActionReceipt, 'actionId' | 'attemptId' | 'risk' | 'dispatchState' | 'evidence' | 'action'>>;
const PHASES = new Set<ActionReceiptPhase>(['planned', 'awaiting-approval', 'acting', 'draft-ready', 'submitted', 'review-pending', 'verified', 'unknown', 'cancelled', 'failed']);
const INTENTS = new Set<ActionIntent>(['platform-write', 'clipboard-write', 'image-generation', 'image-saving', 'media-upload', 'media-download', 'computer-input', 'file-write', 'command-execution', 'platform-api']);
const UNRESOLVED = new Set<ActionReceiptPhase>(['planned', 'awaiting-approval', 'acting', 'draft-ready', 'submitted', 'review-pending', 'unknown']);
const REVIEWABLE = new Set<ActionReceiptPhase>(['draft-ready', 'submitted', 'review-pending', 'unknown']);
const MAX_RECENT_ACTIONS = 500;
const RISKS = new Set<ActionRisk>(['READ_ONLY', 'REVERSIBLE_LOCAL', 'EXTERNAL_MUTATION', 'IRREVERSIBLE_OR_PUBLIC']);
const DISPATCH_STATES = new Set<ActionDispatchState>(['not-dispatched', 'delivered', 'unknown']);
const OUTCOMES = new Set<ActionReceiptOutcome>(['delivered', 'ui-observed', 'draft-ready', 'remote-acknowledged', 'review-pending', 'verified', 'unknown', 'cancelled', 'failed']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const usableEvidence = (item: unknown): item is ActionReceiptEvidence => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const evidence = item as Record<string, unknown>;
  return typeof evidence.source === 'string' && typeof evidence.status === 'string' && Number.isFinite(evidence.observedAt)
    && (evidence.summary === undefined || typeof evidence.summary === 'string')
    && (evidence.digest === undefined || (typeof evidence.digest === 'string' && /^[a-f0-9]{64}$/.test(evidence.digest)));
};

export const defaultActionRisk = (intent: ActionIntent): ActionRisk => intent === 'image-saving' || intent === 'media-download' || intent === 'file-write' || intent === 'clipboard-write'
  ? 'REVERSIBLE_LOCAL'
  : 'EXTERNAL_MUTATION';

const validBrowserTarget = (target: Record<string, unknown>): boolean =>
  target.surface === 'browser' && typeof target.instanceId === 'string'
  && typeof target.origin === 'string' && typeof target.url === 'string' && typeof target.accountRef === 'string'
  && typeof target.snapshotId === 'string' && typeof target.formId === 'string' && typeof target.control === 'string';

const validDesktopTarget = (target: Record<string, unknown>): boolean => {
  const bounds = target.bounds as Record<string, unknown> | null | undefined;
  const element = target.element as Record<string, unknown> | undefined;
  return target.surface === 'desktop' && typeof target.instanceId === 'string' && !!target.instanceId && typeof target.bundleId === 'string' && !!target.bundleId
    && typeof target.executablePath === 'string' && Number.isSafeInteger(target.pid) && Number(target.pid) > 0
    && Number.isSafeInteger(target.ownerPid) && Number(target.ownerPid) === Number(target.pid) && typeof target.processStart === 'string' && !!target.processStart
    && Number.isSafeInteger(target.windowId) && Number(target.windowId) > 0
    && !!bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every((value) => typeof value === 'number' && Number.isFinite(value))
    && Number(bounds.width) > 0 && Number(bounds.height) > 0
    && (target.display === null || typeof target.display === 'string') && (target.space === null || typeof target.space === 'string')
    && typeof target.snapshotId === 'string' && !!target.snapshotId && typeof target.captureId === 'string' && !!target.captureId
    && (target.route === 'background-ax' || target.route === 'background-window-pixel') && target.source === 'cua-driver'
    && (element === undefined || (typeof element.role === 'string' && !!element.role
      && typeof element.label === 'string' && !!element.label
      && typeof element.token === 'string' && element.token.startsWith(`${target.snapshotId}:`)));
};

const validFileSystemTarget = (target: Record<string, unknown>): boolean =>
  target.surface === 'filesystem' && typeof target.instanceId === 'string' && !!target.instanceId
  && typeof target.workspaceRoot === 'string' && isAbsolute(target.workspaceRoot)
  && typeof target.path === 'string' && !!target.path.trim() && !target.path.includes('\0')
  && !target.path.startsWith('/') && !target.path.startsWith('\\')
  && !target.path.split(/[\\/]/).some((part) => part === '..' || part === '')
  && (target.operation === 'file-write' || target.operation === 'command-execution')
  && typeof target.snapshotId === 'string' && !!target.snapshotId
  && (target.source === 'opencode-acp' || target.source === 'persona-workspace' || target.source === 'video-world');

const receiptRisk = (value: unknown, intent: ActionIntent): ActionRisk => RISKS.has(value as ActionRisk) ? value as ActionRisk : defaultActionRisk(intent);

export function actionReceiptDuplicateKey(
  intent: ActionIntent,
  target: ActionTargetEvidence,
  payloadDigest: string,
  dedupeKey = '',
): string {
  if (target.surface === 'filesystem') {
    const identity = [target.surface, target.workspaceRoot, target.path, target.operation];
    return hash(JSON.stringify([intent, identity]));
  }
  const identity = target.surface === 'desktop'
    // App and window process identifiers change across restarts; unresolved input must still block a retry.
    ? [target.surface, target.bundleId, target.executablePath]
    : [target.surface, target.instanceId, target.origin, target.url, target.accountRef, target.formId, target.control];
  return hash(JSON.stringify([intent, identity, payloadDigest, dedupeKey]));
}

function usable(value: unknown): value is BrowserTaskAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const target = record.target as Record<string, unknown> | undefined;
  const evidence = record.evidence;
  return typeof record.id === 'string' && typeof record.taskId === 'string'
    && (record.actionId === undefined || typeof record.actionId === 'string')
    && (record.attemptId === undefined || typeof record.attemptId === 'string')
    && (record.action === undefined || (typeof record.action === 'string' && !!record.action && record.action.length <= 200))
    && INTENTS.has(record.intent as ActionIntent) && PHASES.has(record.phase as ActionReceiptPhase)
    && (record.risk === undefined || RISKS.has(record.risk as ActionRisk))
    && !!target && (validBrowserTarget(target) || validDesktopTarget(target) || validFileSystemTarget(target))
    && typeof record.payloadDigest === 'string' && /^[a-f0-9]{64}$/.test(record.payloadDigest)
    && Array.isArray(record.files) && record.files.every((file) => !!file && typeof file.path === 'string'
      && /^[a-f0-9]{64}$/.test(file.digest) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.mime === 'string')
    && (record.commentFingerprint === undefined || (typeof record.commentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.commentFingerprint)))
    && (record.dispatchState === undefined || DISPATCH_STATES.has(record.dispatchState as ActionDispatchState))
    && (evidence === undefined || (Array.isArray(evidence) && evidence.every(usableEvidence)))
    && (record.outcome === undefined || OUTCOMES.has(record.outcome as ActionReceiptOutcome))
    && typeof record.duplicateKey === 'string'
    && Number.isFinite(record.createdAt) && Number.isFinite(record.updatedAt);
}

/** Stores receipts for side effects across Browser, desktop and local file surfaces. */
export class ActionReceiptLedger {
  private actions: ActionReceipt[];

  constructor(private readonly file: string) {
    if (!existsSync(file)) this.actions = [];
    else {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed) || !parsed.every(usable)) throw new Error('the action receipt ledger is invalid');
      this.actions = parsed.map((value) => {
        const receipt = value as ActionReceipt;
        return {
          ...receipt,
          actionId: receipt.actionId ?? receipt.id,
          attemptId: receipt.attemptId ?? receipt.taskId,
          action: receipt.action ?? receipt.intent,
          risk: receiptRisk(receipt.risk, receipt.intent),
          dispatchState: receipt.dispatchState ?? (receipt.phase === 'acting' ? 'unknown' : 'not-dispatched'),
          evidence: receipt.evidence ?? [],
        };
      });
    }
  }

  hasUnresolved(duplicateKey: string): boolean {
    return this.actions.some((action) => UNRESOLVED.has(action.phase) && action.duplicateKey === duplicateKey);
  }

  hasUnresolvedMatching(predicate: (action: ActionReceipt) => boolean): boolean {
    return this.actions.some((action) => UNRESOLVED.has(action.phase) && predicate(action));
  }

  listUnresolved(): ActionReceipt[] {
    return structuredClone(this.actions.filter((action) => UNRESOLVED.has(action.phase))
      .sort((a, b) => b.updatedAt - a.updatedAt));
  }

  findByTaskId(taskId: string): ActionReceipt | null {
    const action = [...this.actions].reverse().find((candidate) => candidate.taskId === taskId);
    return action ? structuredClone(action) : null;
  }

  listExperienceTrialReceipts(afterCreatedAt: number): ExperienceTrialReceipt[] {
    if (!Number.isFinite(afterCreatedAt)) return [];
    return this.actions
      .filter((action) => action.createdAt > afterCreatedAt)
      .map(experienceTrialReceipt)
      .filter((receipt): receipt is ExperienceTrialReceipt => !!receipt)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  findExperienceTrialReceipt(id: string, afterCreatedAt: number): ExperienceTrialReceipt | null {
    if (!Number.isFinite(afterCreatedAt)) return null;
    const action = this.actions.find((candidate) => candidate.id === id && candidate.createdAt > afterCreatedAt);
    return action ? experienceTrialReceipt(action) : null;
  }

  reconcile(id: string, decision: ActionReceiptReviewDecision, note: string, now = Date.now()): boolean {
    const action = this.actions.find((candidate) => candidate.id === id);
    const detail = note.trim();
    if (!action || !REVIEWABLE.has(action.phase) || !detail) return false;
    if (decision === 'review-pending' && (action.target.surface !== 'browser' || !['platform-write', 'media-upload'].includes(action.intent))) return false;
    const evidence = {
      source: 'operator-review',
      status: decision,
      summary: detail.slice(0, 200),
      observedAt: now,
    };
    if (decision === 'verified') {
      this.complete(id, { phase: 'verified', dispatchState: 'delivered', outcome: 'verified', note: detail, evidence }, now);
    } else if (decision === 'review-pending') {
      this.complete(id, { phase: 'review-pending', dispatchState: 'delivered', outcome: 'review-pending', note: detail, evidence }, now);
    } else {
      this.complete(id, { phase: 'failed', dispatchState: action.dispatchState, outcome: 'failed', note: detail, evidence }, now);
    }
    return true;
  }

  importUnresolved(receipt: ActionReceipt): void {
    if (!usable(receipt) || !UNRESOLVED.has(receipt.phase)) throw new Error('the imported action receipt must be valid and unresolved');
    if (this.actions.some((action) => action.id === receipt.id) || this.hasUnresolved(receipt.duplicateKey)) return;
    this.actions.push(structuredClone(receipt));
    this.save();
  }

  recoverInterrupted(now = Date.now()): number {
    let changed = false;
    for (const action of this.actions) {
      if (action.phase === 'acting') {
        action.phase = 'unknown';
        action.dispatchState = 'unknown';
        action.outcome = 'unknown';
        action.note = 'the app stopped while the action result was unresolved';
        action.updatedAt = now;
        changed = true;
      } else if (action.intent === 'image-generation' && action.phase === 'submitted') {
        action.phase = 'unknown';
        action.outcome = 'unknown';
        action.note = 'the app stopped before the generated image result could be verified';
        action.updatedAt = now;
        changed = true;
      } else if (action.phase === 'planned' || action.phase === 'awaiting-approval') {
        action.phase = 'cancelled';
        action.outcome = 'cancelled';
        action.note = 'the app stopped before dispatch';
        action.updatedAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
    return this.actions.filter((action) => action.phase === 'unknown').length;
  }

  begin(input: NewActionReceipt, now = Date.now()): ActionReceipt {
    const actionName = input.action ?? input.intent;
    if (!actionName.trim() || actionName.length > 200) throw new Error('the action receipt action is invalid');
    if (this.hasUnresolved(input.duplicateKey)) throw new Error('an earlier matching action needs review');
    const actionId = input.actionId ?? randomUUID();
    const action: ActionReceipt = {
      ...input,
      id: actionId,
      actionId,
      attemptId: input.attemptId ?? randomUUID(),
      action: actionName,
      risk: input.risk ?? defaultActionRisk(input.intent),
      phase: 'planned',
      dispatchState: input.dispatchState ?? 'not-dispatched',
      evidence: input.evidence ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.actions.push(action);
    this.save();
    return structuredClone(action);
  }

  awaitingApproval(id: string, now = Date.now()): void {
    this.transition(id, 'planned', 'awaiting-approval', now);
  }

  acting(id: string, grantDigest: string, approvedAt: number, expiresAt: number, now = Date.now()): void {
    if (!/^[a-f0-9]{64}$/.test(grantDigest) || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error('the action grant is invalid');
    }
    this.transition(id, 'awaiting-approval', 'acting', now, {
      approvalChannel: 'core-pet-bubble', grantDigest, approvedAt, expiresAt,
    });
  }

  delivered(id: string, evidence: ActionReceiptEvidence, now = Date.now()): void {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action || !UNRESOLVED.has(action.phase)) return;
    action.dispatchState = 'delivered';
    action.updatedAt = now;
    action.evidence.push(evidence);
    this.save();
  }

  observe(id: string, evidence: ActionReceiptEvidence[], note?: string, now = Date.now()): boolean {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action || !UNRESOLVED.has(action.phase) || !evidence.length || !evidence.every(usableEvidence)) return false;
    action.evidence.push(...structuredClone(evidence));
    if (note !== undefined) action.note = note.slice(0, 400);
    action.updatedAt = now;
    this.save();
    return true;
  }

  finish(
    id: string,
    phase: 'verified' | 'unknown' | 'cancelled',
    note = '',
    now = Date.now(),
    outcome?: ActionReceiptOutcome,
    evidence?: ActionReceiptEvidence,
  ): void {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action || !UNRESOLVED.has(action.phase)) return;
    action.phase = phase;
    action.updatedAt = now;
    action.note = note.slice(0, 400);
    if (phase === 'verified') {
      action.dispatchState = 'delivered';
      action.outcome = outcome ?? 'ui-observed';
    }
    if (phase === 'unknown') {
      action.outcome = outcome ?? 'unknown';
      if (action.dispatchState === 'not-dispatched') action.dispatchState = 'unknown';
    }
    if (phase === 'cancelled') action.outcome = outcome ?? 'cancelled';
    if (evidence) action.evidence.push(evidence);
    this.save();
  }

  complete(id: string, result: ActionReceiptCompletion, now = Date.now()): void {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action || !UNRESOLVED.has(action.phase)) return;
    action.phase = result.phase;
    action.dispatchState = result.dispatchState;
    action.outcome = result.outcome;
    action.updatedAt = now;
    action.note = result.note.slice(0, 400);
    if (result.evidence) action.evidence.push(...(Array.isArray(result.evidence) ? result.evidence : [result.evidence]));
    this.save();
  }

  private transition(
    id: string,
    from: ActionReceiptPhase,
    to: ActionReceiptPhase,
    now: number,
    patch: Partial<BrowserTaskAction> = {},
  ): void {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action || action.phase !== from) throw new Error(`action receipt cannot move from ${action?.phase ?? 'missing'} to ${to}`);
    Object.assign(action, patch, { phase: to, updatedAt: now });
    this.save();
  }

  private save(): void {
    if (this.actions.length > MAX_RECENT_ACTIONS) {
      const unresolved = this.actions.filter((action) => UNRESOLVED.has(action.phase));
      const settledLimit = Math.max(0, MAX_RECENT_ACTIONS - unresolved.length);
      const settled = settledLimit === 0
        ? []
        : this.actions.filter((action) => !UNRESOLVED.has(action.phase)).slice(-settledLimit);
      const retainedIds = new Set([...unresolved, ...settled].map((action) => action.id));
      this.actions = this.actions.filter((action) => retainedIds.has(action.id));
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeState(this.file, `${JSON.stringify(this.actions, null, 2)}\n`);
  }
}

function experienceTrialReceipt(action: ActionReceipt): ExperienceTrialReceipt | null {
  const outcome = action.outcome;
  if (action.phase === 'verified' && action.dispatchState === 'delivered'
    && (outcome === 'verified' || outcome === 'ui-observed' || outcome === 'remote-acknowledged')) {
    return {
      receiptId: action.id,
      taskFingerprint: hash(action.taskId),
      intent: action.intent,
      outcome: 'verified',
      dispatchState: action.dispatchState,
      createdAt: action.createdAt,
    };
  }
  if (action.phase === 'failed' && action.dispatchState === 'delivered' && outcome === 'failed') {
    return {
      receiptId: action.id,
      taskFingerprint: hash(action.taskId),
      intent: action.intent,
      outcome: 'failed',
      dispatchState: action.dispatchState,
      createdAt: action.createdAt,
    };
  }
  if (action.phase === 'unknown' || action.dispatchState === 'unknown' || outcome === 'unknown') {
    return {
      receiptId: action.id,
      taskFingerprint: hash(action.taskId),
      intent: action.intent,
      outcome: 'unknown',
      dispatchState: action.dispatchState,
      createdAt: action.createdAt,
    };
  }
  return null;
}
