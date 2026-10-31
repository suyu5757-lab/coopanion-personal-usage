/** Durable receipts for browser actions that need a scoped user grant. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeState } from '../state-file.ts';
import { hashContent, type PublicAction } from './actions.ts';
import type { BrowserTargetEvidence } from '../task-grants.ts';

export type BrowserTaskIntent = 'platform-write' | 'image-generation' | 'image-saving' | 'media-upload';
export type BrowserTaskPhase = 'planned' | 'awaiting-approval' | 'acting' | 'verified' | 'unknown' | 'cancelled';
export type BrowserTaskFile = { path: string; digest: string; bytes: number; mime: string };

export interface BrowserTaskAction {
  id: string;
  taskId: string;
  intent: BrowserTaskIntent;
  phase: BrowserTaskPhase;
  target: BrowserTargetEvidence;
  payloadDigest: string;
  files: BrowserTaskFile[];
  commentFingerprint?: string;
  duplicateKey: string;
  createdAt: number;
  updatedAt: number;
  approvalChannel?: 'core-pet-bubble';
  grantDigest?: string;
  approvedAt?: number;
  expiresAt?: number;
  outcome?: 'ui-observed' | 'unknown';
  note?: string;
}

const PHASES = new Set<BrowserTaskPhase>(['planned', 'awaiting-approval', 'acting', 'verified', 'unknown', 'cancelled']);
const INTENTS = new Set<BrowserTaskIntent>(['platform-write', 'image-generation', 'image-saving', 'media-upload']);
const UNRESOLVED = new Set<BrowserTaskPhase>(['planned', 'awaiting-approval', 'acting', 'unknown']);
const MAX_RECENT_ACTIONS = 500;

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

function usable(value: unknown): value is BrowserTaskAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const target = record.target as Record<string, unknown> | undefined;
  return typeof record.id === 'string' && typeof record.taskId === 'string'
    && INTENTS.has(record.intent as BrowserTaskIntent) && PHASES.has(record.phase as BrowserTaskPhase)
    && !!target && target.surface === 'browser' && typeof target.instanceId === 'string'
    && typeof target.origin === 'string' && typeof target.url === 'string' && typeof target.accountRef === 'string'
    && typeof target.snapshotId === 'string' && typeof target.formId === 'string' && typeof target.control === 'string'
    && typeof record.payloadDigest === 'string' && /^[a-f0-9]{64}$/.test(record.payloadDigest)
    && Array.isArray(record.files) && record.files.every((file) => !!file && typeof file.path === 'string'
      && /^[a-f0-9]{64}$/.test(file.digest) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && typeof file.mime === 'string')
    && (record.commentFingerprint === undefined || (typeof record.commentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.commentFingerprint)))
    && typeof record.duplicateKey === 'string'
    && Number.isFinite(record.createdAt) && Number.isFinite(record.updatedAt);
}

/** Stores unresolved actions and recent receipts; a restart never turns an unknown result into a retry. */
export class BrowserTaskActionJournal {
  private actions: BrowserTaskAction[];

  constructor(private readonly file: string) {
    if (!existsSync(file)) this.actions = [];
    else {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed) || !parsed.every(usable)) throw new Error('the browser task-action journal is invalid');
      this.actions = parsed;
    }
  }

  hasUnresolved(duplicateKey: string): boolean {
    return this.actions.some((action) => UNRESOLVED.has(action.phase) && action.duplicateKey === duplicateKey);
  }

  hasUnresolvedComment(commentFingerprint: string): boolean {
    return this.actions.some((action) => UNRESOLVED.has(action.phase) && action.commentFingerprint === commentFingerprint);
  }

  hasLegacyTextCollision(videoUrl: string, payloadDigest: string, commentFingerprint?: string): boolean {
    return this.actions.some((action) => action.id.startsWith('legacy:')
      && UNRESOLVED.has(action.phase)
      && action.intent === 'platform-write'
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
    if (this.actions.some((candidate) => candidate.id === `legacy:${action.taskId}`)
      || this.hasUnresolved(duplicateKey)) return;
    this.actions.push({
      id: `legacy:${action.taskId}`,
      taskId: action.taskId,
      intent: 'platform-write',
      phase: 'unknown',
      target,
      payloadDigest: action.contentHash,
      files: [],
      ...(action.target.commentFingerprint ? { commentFingerprint: action.target.commentFingerprint } : {}),
      duplicateKey,
      createdAt: action.createdAt,
      updatedAt: now,
      outcome: 'unknown',
      note: 'migrated from the legacy public-text action journal; reconcile before retry',
    });
    this.save();
  }

  recoverInterrupted(now = Date.now()): number {
    let changed = false;
    for (const action of this.actions) {
      if (action.phase === 'acting') {
        action.phase = 'unknown';
        action.outcome = 'unknown';
        action.note = 'the app stopped while the action result was unresolved';
        action.updatedAt = now;
        changed = true;
      } else if (action.phase === 'planned' || action.phase === 'awaiting-approval') {
        action.phase = 'cancelled';
        action.note = 'the app stopped before dispatch';
        action.updatedAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
    return this.actions.filter((action) => action.phase === 'unknown').length;
  }

  begin(input: Omit<BrowserTaskAction, 'id' | 'phase' | 'createdAt' | 'updatedAt'>, now = Date.now()): BrowserTaskAction {
    if (this.hasUnresolved(input.duplicateKey)) throw new Error('an earlier matching browser action needs review');
    const action: BrowserTaskAction = { ...input, id: randomUUID(), phase: 'planned', createdAt: now, updatedAt: now };
    this.actions.push(action);
    this.save();
    return structuredClone(action);
  }

  awaitingApproval(id: string, now = Date.now()): void {
    this.transition(id, 'planned', 'awaiting-approval', now);
  }

  acting(id: string, grantDigest: string, approvedAt: number, expiresAt: number, now = Date.now()): void {
    if (!/^[a-f0-9]{64}$/.test(grantDigest) || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error('the browser action grant is invalid');
    }
    this.transition(id, 'awaiting-approval', 'acting', now, {
      approvalChannel: 'core-pet-bubble', grantDigest, approvedAt, expiresAt,
    });
  }

  finish(id: string, phase: 'verified' | 'unknown' | 'cancelled', note = '', now = Date.now()): void {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action || !UNRESOLVED.has(action.phase)) return;
    action.phase = phase;
    action.updatedAt = now;
    action.note = note.slice(0, 400);
    if (phase === 'verified') action.outcome = 'ui-observed';
    if (phase === 'unknown') action.outcome = 'unknown';
    this.save();
  }

  private transition(
    id: string,
    from: BrowserTaskPhase,
    to: BrowserTaskPhase,
    now: number,
    patch: Partial<BrowserTaskAction> = {},
  ): void {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action || action.phase !== from) throw new Error(`browser action cannot move from ${action?.phase ?? 'missing'} to ${to}`);
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
