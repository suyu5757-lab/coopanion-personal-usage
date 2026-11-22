/** The confirmation and durable recovery record for one public browser write. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Phase = 'planned' | 'awaiting-approval' | 'acting' | 'verified' | 'unknown' | 'cancelled' | 'failed';
export type Outcome = 'ui-observed' | 'unknown';

export interface ActionTarget {
  surface: 'browser';
  origin: string;
  url: string;
  videoUrl: string;
  videoTitle: string;
  snapshotId: string;
  accountRef?: string;
  accountLabel?: string;
  commentFingerprint?: string;
  control: string;
}

export interface Approval {
  digest: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
}

export interface PublicAction {
  taskId: string;
  intent: 'send-text';
  phase: Phase;
  target: ActionTarget;
  contentHash: string;
  contentLength: number;
  expectedEffect: string;
  approval?: Approval;
  createdAt: number;
  updatedAt: number;
  outcome?: Outcome;
  note?: string;
}

export const APPROVAL_MINUTES = 5;
const UNRESOLVED: ReadonlySet<Phase> = new Set(['planned', 'awaiting-approval', 'acting', 'unknown']);
const PHASES: readonly Phase[] = ['planned', 'awaiting-approval', 'acting', 'verified', 'unknown', 'cancelled', 'failed'];
const HASH = /^[a-f0-9]{64}$/;

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The approval binds the current account, page snapshot, video, optional comment, control and exact text. */
export function actionDigest(target: ActionTarget, content: string): string {
  const digestInput = [
    target.surface, target.origin, target.url, target.videoUrl, target.snapshotId,
    target.accountRef ?? '', target.commentFingerprint ?? '', target.control, hashContent(content),
  ];
  return createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
}

export function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

export function newAction(target: ActionTarget, content: string, expectedEffect: string, now = Date.now()): PublicAction {
  return {
    taskId: randomUUID(),
    intent: 'send-text',
    phase: 'planned',
    target,
    contentHash: hashContent(content),
    contentLength: [...content].length,
    expectedEffect,
    createdAt: now,
    updatedAt: now,
  };
}

/** Stores only unresolved action metadata and a digest; the message text stays in the live page and approval bubble. */
export class ActionJournal {
  constructor(private readonly file: string) {}

  load(): PublicAction[] {
    if (!existsSync(this.file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(usable)) throw new Error('The browser action journal is not a valid action list');
    return parsed;
  }

  save(actions: PublicAction[]): void {
    const kept = actions.filter((action) => UNRESOLVED.has(action.phase));
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* no temporary file was created */ }
      throw error;
    }
  }
}

export interface RepliedComment {
  fingerprint: string;
  sentAt: number;
}

/** Stores hashed comment identities so a completed reply cannot be sent twice after restart. */
export class ReplyJournal {
  private get initializedFile(): string { return `${this.file}.initialized`; }

  constructor(private readonly file: string) {}

  load(): RepliedComment[] {
    if (!existsSync(this.file)) {
      if (existsSync(this.initializedFile)) throw new Error('The browser reply journal is missing');
      this.save([]);
      this.writeInitialized();
      return [];
    }
    const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(usableReply)) throw new Error('The browser reply journal is not a valid reply list');
    if (existsSync(this.initializedFile)) {
      const initialized: unknown = JSON.parse(readFileSync(this.initializedFile, 'utf8'));
      if (!initialized || typeof initialized !== 'object' || (initialized as { version?: unknown }).version !== 1) {
        throw new Error('The browser reply journal marker is invalid');
      }
    } else {
      this.writeInitialized();
    }
    return parsed;
  }

  has(fingerprint: string): boolean {
    return this.load().some((reply) => reply.fingerprint === fingerprint);
  }

  add(fingerprint: string, sentAt = Date.now()): void {
    if (!HASH.test(fingerprint) || !Number.isFinite(sentAt)) throw new Error('The browser reply record is invalid');
    const replies = this.load();
    if (replies.some((reply) => reply.fingerprint === fingerprint)) return;
    this.save([...replies, { fingerprint, sentAt }]);
  }

  private save(replies: RepliedComment[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(replies, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* no temporary file was created */ }
      throw error;
    }
  }

  private writeInitialized(): void {
    mkdirSync(dirname(this.initializedFile), { recursive: true });
    const temp = `${this.initializedFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ version: 1, createdAt: Date.now() })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, this.initializedFile);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* no temporary file was created */ }
      throw error;
    }
  }
}

const usableReply = (value: unknown): value is RepliedComment => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reply = value as Partial<RepliedComment>;
  return typeof reply.fingerprint === 'string' && HASH.test(reply.fingerprint)
    && typeof reply.sentAt === 'number' && Number.isFinite(reply.sentAt);
};

const usable = (value: unknown): value is PublicAction => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Partial<PublicAction>;
  const target = action.target as Partial<ActionTarget> | null | undefined;
  const approval = action.approval as Partial<Approval> | undefined;
  return typeof action.taskId === 'string' && action.taskId.length > 0
    && action.intent === 'send-text'
    && typeof action.phase === 'string' && PHASES.includes(action.phase)
    && !!target && typeof target === 'object' && target.surface === 'browser'
    && typeof target.origin === 'string' && typeof target.url === 'string'
    && typeof target.videoUrl === 'string' && typeof target.videoTitle === 'string'
    && typeof target.snapshotId === 'string' && target.snapshotId.length > 0
    && typeof target.control === 'string'
    && (target.accountRef === undefined || typeof target.accountRef === 'string')
    && (target.accountLabel === undefined || typeof target.accountLabel === 'string')
    && (target.commentFingerprint === undefined || (typeof target.commentFingerprint === 'string' && HASH.test(target.commentFingerprint)))
    && typeof action.contentHash === 'string' && HASH.test(action.contentHash)
    && typeof action.contentLength === 'number' && Number.isInteger(action.contentLength) && action.contentLength >= 0
    && typeof action.expectedEffect === 'string'
    && typeof action.createdAt === 'number' && Number.isFinite(action.createdAt)
    && typeof action.updatedAt === 'number' && Number.isFinite(action.updatedAt)
    && (approval === undefined || (typeof approval.digest === 'string' && HASH.test(approval.digest)
      && typeof approval.issuedAt === 'number' && Number.isFinite(approval.issuedAt)
      && typeof approval.expiresAt === 'number' && Number.isFinite(approval.expiresAt)
      && typeof approval.used === 'boolean'))
    && (action.outcome === undefined || action.outcome === 'ui-observed' || action.outcome === 'unknown')
    && (action.note === undefined || typeof action.note === 'string');
};
