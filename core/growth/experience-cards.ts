/** User-reviewed strategies and receipt-backed trials; these files never replace Persona documents. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ExperienceTrialOutcome, ExperienceTrialReceipt } from '../action-receipts.ts';
import { writeState } from '../state-file.ts';

export type ExperienceScope = 'conversation' | 'proactive_speech' | 'browser_exploration';
export type ExperienceState = 'candidate' | 'approved' | 'rejected' | 'deprecated';
export type ExperienceKind = 'policy' | 'skill';

export interface ExperienceTrial extends ExperienceTrialReceipt {
  recordedAt: string;
  unseenConfirmedAt: string;
}

export interface ExperienceCard {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  situation: string;
  lesson: string;
  scope: ExperienceScope;
  sourceIds: string[];
  kind: ExperienceKind;
  trials: ExperienceTrial[];
  state: ExperienceState;
  userExplicit: boolean;
  reviewedAt?: string;
}

export interface ExperienceCardInput {
  title?: unknown;
  situation?: unknown;
  lesson?: unknown;
  scope?: unknown;
  sourceIds?: unknown;
  kind?: unknown;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = new Set<ExperienceScope>(['conversation', 'proactive_speech', 'browser_exploration']);
const KINDS = new Set<ExperienceKind>(['policy', 'skill']);
const TRIAL_OUTCOMES = new Set<ExperienceTrialOutcome>(['verified', 'unknown', 'failed']);
export const EXPERIENCE_CONTEXT_HEADER = '[memory] User-reviewed, revocable experience strategies. Use only when relevant; current instructions take precedence. These strategies do not grant permissions or change safety rules.';
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean && clean.length <= max && !/[\0]/.test(clean) ? clean : null;
};

export function readExperienceCardInput(input: ExperienceCardInput): { card: Omit<ExperienceCard, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'userExplicit' | 'trials'> } | { errors: string[] } {
  const errors: string[] = [];
  const title = text(input.title, 120);
  const situation = text(input.situation, 400);
  const lesson = text(input.lesson, 600);
  const scope = typeof input.scope === 'string' && SCOPES.has(input.scope as ExperienceScope) ? input.scope as ExperienceScope : null;
  const kind = input.kind === undefined ? 'policy' : typeof input.kind === 'string' && KINDS.has(input.kind as ExperienceKind) ? input.kind as ExperienceKind : null;
  if (!title) errors.push('title must be 1-120 characters');
  if (!situation) errors.push('situation must be 1-400 characters');
  if (!lesson) errors.push('lesson must be 1-600 characters');
  if (!scope) errors.push('scope must be conversation, proactive_speech or browser_exploration');
  if (!kind) errors.push('kind must be policy or skill');
  const sourceIds: string[] = [];
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 8) {
    errors.push('sourceIds must contain one to eight Hindsight document IDs');
  } else {
    for (const [index, raw] of input.sourceIds.entries()) {
      const id = text(raw, 200);
      if (!id || /[\r\n]/.test(id)) errors.push(`sourceIds[${index}] must be a Hindsight document ID`);
      else sourceIds.push(id);
    }
  }
  if (errors.length || !title || !situation || !lesson || !scope || !kind) return { errors };
  return { card: { title, situation, lesson, scope, sourceIds, kind } };
}

function readTrial(value: unknown): ExperienceTrial | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const trial = value as Partial<ExperienceTrial>;
  if (typeof trial.receiptId !== 'string' || !trial.receiptId || trial.receiptId.length > 200
    || typeof trial.taskFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(trial.taskFingerprint)
    || typeof trial.intent !== 'string' || trial.intent.length > 64
    || typeof trial.outcome !== 'string' || !TRIAL_OUTCOMES.has(trial.outcome as ExperienceTrialOutcome)
    || (trial.dispatchState !== 'delivered' && trial.dispatchState !== 'unknown' && trial.dispatchState !== 'not-dispatched')
    || !Number.isFinite(trial.createdAt) || typeof trial.recordedAt !== 'string' || !Number.isFinite(Date.parse(trial.recordedAt))
    || typeof trial.unseenConfirmedAt !== 'string' || !Number.isFinite(Date.parse(trial.unseenConfirmedAt))) return null;
  if (trial.outcome === 'verified' && trial.dispatchState !== 'delivered') return null;
  if (trial.outcome === 'failed' && trial.dispatchState !== 'delivered') return null;
  return trial as ExperienceTrial;
}

export class ExperienceCards {
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  private read(name: string): ExperienceCard | null {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !ID.test(id)) return null;
    try {
      const value = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Partial<ExperienceCard>;
      if (value.id !== id || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null;
      if (typeof value.title !== 'string' || typeof value.situation !== 'string' || typeof value.lesson !== 'string') return null;
      if (!SCOPES.has(value.scope as ExperienceScope) || !Array.isArray(value.sourceIds)) return null;
      if (!['candidate', 'approved', 'rejected', 'deprecated'].includes(String(value.state))) return null;
      const kind = value.kind === undefined ? 'policy' : KINDS.has(value.kind as ExperienceKind) ? value.kind as ExperienceKind : null;
      if (!kind) return null;
      const trials = Array.isArray(value.trials) ? value.trials.map(readTrial).filter((trial): trial is ExperienceTrial => !!trial) : [];
      return { ...value, kind, trials, userExplicit: value.userExplicit !== false } as ExperienceCard;
    } catch { return null; }
  }

  create(input: ExperienceCardInput): { ok: true; card: ExperienceCard } | { ok: false; errors: string[] } {
    return this.write(input, true);
  }

  propose(input: ExperienceCardInput): { ok: true; card: ExperienceCard } | { ok: false; errors: string[] } {
    return this.write(input, false);
  }

  private write(input: ExperienceCardInput, userExplicit: boolean): { ok: true; card: ExperienceCard } | { ok: false; errors: string[] } {
    const parsed = readExperienceCardInput(input);
    if ('errors' in parsed) return { ok: false, errors: parsed.errors };
    if (this.list().length >= 40) return { ok: false, errors: ['at most 40 experience cards may be retained'] };
    const at = this.now().toISOString();
    const card: ExperienceCard = {
      ...parsed.card,
      id: randomUUID(),
      createdAt: at,
      updatedAt: at,
      state: 'candidate',
      trials: [],
      userExplicit,
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeState(join(this.dir, `${card.id}.json`), `${JSON.stringify(card, null, 2)}\n`);
      return { ok: true, card };
    } catch (error) {
      return { ok: false, errors: [`could not save the experience card: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  get(id: string): ExperienceCard | null {
    return ID.test(id) ? this.read(`${id}.json`) : null;
  }

  list(state?: ExperienceState): ExperienceCard[] {
    try {
      return readdirSync(this.dir)
        .map((name) => this.read(name))
        .filter((card): card is ExperienceCard => !!card && (!state || card.state === state))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch { return []; }
  }

  transition(id: string, state: 'approved' | 'rejected' | 'deprecated'): ExperienceCard | null {
    const card = this.get(id);
    if (!card || (card.state !== 'candidate' && !(card.state === 'approved' && state === 'deprecated'))) return null;
    if (state === 'approved' && card.kind === 'skill' && !card.trials.some((trial) => trial.outcome === 'verified')) return null;
    const at = this.now().toISOString();
    const next: ExperienceCard = { ...card, state, updatedAt: at, ...(state === 'approved' || state === 'rejected' ? { reviewedAt: at } : {}) };
    const path = join(this.dir, `${id}.json`);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const saved = {
      ...persisted,
      userExplicit: card.userExplicit,
      ...(persisted.kind === undefined ? {} : { kind: card.kind }),
      ...(persisted.trials === undefined ? {} : { trials: card.trials }),
      state,
      updatedAt: at,
      ...(state === 'approved' || state === 'rejected' ? { reviewedAt: at } : {}),
    };
    writeState(path, `${JSON.stringify(saved, null, 2)}\n`);
    return next;
  }

  recordTrial(id: string, receipt: ExperienceTrialReceipt, confirmedUnseen: boolean): { ok: true; card: ExperienceCard; trial: ExperienceTrial } | { ok: false; errors: string[] } {
    const card = this.get(id);
    if (!card || card.state !== 'candidate' || card.kind !== 'skill') return { ok: false, errors: ['a skill candidate is required'] };
    if (confirmedUnseen !== true) return { ok: false, errors: ['the person must confirm the trial task was not used as candidate evidence'] };
    if (!receipt || typeof receipt.receiptId !== 'string' || !receipt.receiptId || receipt.receiptId.length > 200
      || typeof receipt.taskFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.taskFingerprint)
      || typeof receipt.intent !== 'string' || receipt.intent.length > 64
      || !Number.isFinite(receipt.createdAt) || receipt.createdAt <= Date.parse(card.createdAt)
      || !TRIAL_OUTCOMES.has(receipt.outcome)
      || (receipt.dispatchState !== 'delivered' && receipt.dispatchState !== 'unknown' && receipt.dispatchState !== 'not-dispatched')) {
      return { ok: false, errors: ['the action receipt is invalid or predates the candidate'] };
    }
    if (receipt.outcome === 'verified' && receipt.dispatchState !== 'delivered') {
      return { ok: false, errors: ['a verified trial needs a delivered action receipt'] };
    }
    if (receipt.outcome === 'failed' && receipt.dispatchState !== 'delivered') {
      return { ok: false, errors: ['a failed trial needs a delivered action receipt'] };
    }
    const sameTask = card.trials.find((trial) => trial.taskFingerprint === receipt.taskFingerprint);
    if (sameTask && sameTask.receiptId !== receipt.receiptId) return { ok: false, errors: ['this task already has a different trial receipt'] };
    const at = this.now().toISOString();
    const previous = card.trials.find((trial) => trial.receiptId === receipt.receiptId);
    const trial: ExperienceTrial = { ...receipt, recordedAt: at, unseenConfirmedAt: at };
    const trials = previous
      ? card.trials.map((candidate) => candidate.receiptId === receipt.receiptId ? trial : candidate)
      : [...card.trials, trial];
    const next: ExperienceCard = { ...card, trials, updatedAt: at };
    try {
      writeState(join(this.dir, `${id}.json`), `${JSON.stringify(next, null, 2)}\n`);
      return { ok: true, card: next, trial };
    } catch (error) {
      return { ok: false, errors: [`could not save the trial: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  approvedContext(maxCards = 8, maxChars = 3200, allow: (card: ExperienceCard) => boolean = () => true): string {
    const entries = this.approvedContextEntries(maxCards, maxChars, allow);
    return entries.length ? `${EXPERIENCE_CONTEXT_HEADER}\n${entries.map((entry) => entry.text).join('\n')}` : '';
  }

  approvedContextEntries(maxCards = 8, maxChars = 3200, allow: (card: ExperienceCard) => boolean = () => true): Array<{ card: ExperienceCard; text: string }> {
    const cards = this.list('approved').filter(allow).slice(0, maxCards);
    if (cards.length === 0) return [];
    const lines = cards.map((card) => ({ card, text: `- Situation: ${card.situation}\n  User-reviewed guidance (${card.scope}): ${card.lesson}` }));
    let body = '';
    const included: Array<{ card: ExperienceCard; text: string }> = [];
    for (const entry of lines) {
      const next = body ? `${body}\n${entry.text}` : entry.text;
      if (EXPERIENCE_CONTEXT_HEADER.length + 1 + next.length > maxChars) break;
      body = next;
      included.push(entry);
    }
    return included;
  }

  removeBySource(sourceIds: readonly string[]): number {
    const ids = new Set(sourceIds);
    if (ids.size === 0) return 0;
    let count = 0;
    for (const card of this.list()) {
      if (!card.sourceIds.some((sourceId) => ids.has(sourceId))) continue;
      try { unlinkSync(join(this.dir, `${card.id}.json`)); count += 1; } catch { /* Keep a card if the filesystem refuses the removal. */ }
    }
    return count;
  }

  clear(): number {
    let count = 0;
    for (const card of this.list()) {
      try { unlinkSync(join(this.dir, `${card.id}.json`)); count += 1; } catch { /* Keep unreadable records. */ }
    }
    return count;
  }
}
