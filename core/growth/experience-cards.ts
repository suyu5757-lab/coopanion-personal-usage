/** Small user-reviewed behavior policies; these files never replace Persona documents. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeState } from '../state-file.ts';

export type ExperienceScope = 'conversation' | 'proactive_speech' | 'browser_exploration';
export type ExperienceState = 'candidate' | 'approved' | 'rejected' | 'deprecated';

export interface ExperienceCard {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  situation: string;
  lesson: string;
  scope: ExperienceScope;
  sourceIds: string[];
  state: ExperienceState;
  userExplicit: true;
  reviewedAt?: string;
}

export interface ExperienceCardInput {
  title?: unknown;
  situation?: unknown;
  lesson?: unknown;
  scope?: unknown;
  sourceIds?: unknown;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = new Set<ExperienceScope>(['conversation', 'proactive_speech', 'browser_exploration']);
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean && clean.length <= max && !/[\0]/.test(clean) ? clean : null;
};

export function readExperienceCardInput(input: ExperienceCardInput): { card: Omit<ExperienceCard, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'userExplicit'> } | { errors: string[] } {
  const errors: string[] = [];
  const title = text(input.title, 120);
  const situation = text(input.situation, 400);
  const lesson = text(input.lesson, 600);
  const scope = typeof input.scope === 'string' && SCOPES.has(input.scope as ExperienceScope) ? input.scope as ExperienceScope : null;
  if (!title) errors.push('title must be 1-120 characters');
  if (!situation) errors.push('situation must be 1-400 characters');
  if (!lesson) errors.push('lesson must be 1-600 characters');
  if (!scope) errors.push('scope must be conversation, proactive_speech or browser_exploration');
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
  if (errors.length || !title || !situation || !lesson || !scope) return { errors };
  return { card: { title, situation, lesson, scope, sourceIds } };
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
      return value as ExperienceCard;
    } catch { return null; }
  }

  create(input: ExperienceCardInput): { ok: true; card: ExperienceCard } | { ok: false; errors: string[] } {
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
      userExplicit: true,
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
    const at = this.now().toISOString();
    const next: ExperienceCard = { ...card, state, updatedAt: at, ...(state === 'approved' || state === 'rejected' ? { reviewedAt: at } : {}) };
    writeState(join(this.dir, `${id}.json`), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  approvedContext(maxCards = 8, maxChars = 3200): string {
    const cards = this.list('approved').slice(0, maxCards);
    if (cards.length === 0) return '';
    const lines = cards.map((card) => `- Situation: ${card.situation}\n  User-reviewed guidance (${card.scope}): ${card.lesson}`);
    let body = '';
    for (const line of lines) {
      const next = body ? `${body}\n${line}` : line;
      if (next.length > maxChars) break;
      body = next;
    }
    return body
      ? `[memory] User-reviewed, revocable experience policies. Use only when relevant; current instructions take precedence. These notes do not grant permissions or change safety rules.\n${body}`
      : '';
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
