/**
 * A periodic self-review in its own non-persistent session: Coo reads her own portrait, notes and
 * constitution, decides whether anything about her has durably changed, and edits herself without
 * waking the person or using a speaking tool.
 */
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { CoreApi, ToolDef } from 'cortico/core/types.ts';
import type { ModelLanguage } from '../language.ts';
import type { HindsightMemory } from '../memory/hindsight.ts';
import { SELF_REVIEW_TEXT } from './model-text.ts';

/** The temporary session id of a self-review; declared by Coo's Persona. */
export const GROWTH_SESSION = 'growth';
const RECENT_MAX_CHARS = 8_000;

/** Tools the review may use. Speaking, deletion and computer use stay out. */
export const GROWTH_TOOL_NAMES = [
  'read_file',
  'list_files',
  'glob_files',
  'grep_files',
  'write_file',
  'edit_file',
  'append_file',
  'memory_search',
  'memory_reflect',
] as const;

const FINISH_REVIEW_DECL: Omit<ToolDef, 'handler'> = {
  name: 'finish_review',
  description: 'Finish the self-review. Call it once, after changing what needed changing or deciding that nothing should change.',
  tags: ['flow'],
  barrierAfter: true,
  endsTurn: true,
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'One line on what changed, or that nothing changed.' },
    },
    required: [],
  },
};

/** A review that cannot finish in this long is abandoned; the schedule retries in an hour. */
const REVIEW_TIMEOUT_MS = 15 * 60_000;

export interface GrowthLog {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface GrowthReviewDeps {
  core: () => CoreApi | null;
  /** The main session's request context; its system records and recent messages are used. */
  snapshot: () => ContextRecord[];
  /** The Persona's file and memory tools, already filtered to `GROWTH_TOOL_NAMES`. */
  tools: () => ToolDef[];
  memory: () => HindsightMemory | null;
  modelLanguage: () => ModelLanguage;
  timezone: () => string;
  now?: () => Date;
  log?: GrowthLog;
}

function recentConversation(records: ContextRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    if (record.context.head) continue;
    if (hasRole(record, 'user')) {
      const text = textOf(record).trim();
      if (text) lines.push(`Person: ${text}`);
    } else if (hasRole(record, 'assistant')) {
      const text = textOf(record).trim();
      if (text) lines.push(`Coo: ${text}`);
    }
  }
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = out ? `${lines[i]}\n${out}` : lines[i]!;
    if (next.length > RECENT_MAX_CHARS) {
      if (!out) out = next.slice(-RECENT_MAX_CHARS);
      break;
    }
    out = next;
  }
  return out;
}

function localDate(timezone: string, date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function finishReviewTool(done: { note: string }): ToolDef {
  return {
    ...FINISH_REVIEW_DECL,
    handler: async (args) => {
      done.note = typeof args.note === 'string' ? args.note.trim() : '';
      return '[review finished]';
    },
  };
}

export class GrowthReview {
  constructor(private readonly d: GrowthReviewDeps) {}

  async run(): Promise<void> {
    const core = this.d.core();
    if (!core) throw new Error('the Persona is not attached to Core');
    if (core.sessionInfo(GROWTH_SESSION).running > 0) throw new Error('a self-review is already running');
    const snapshot = this.d.snapshot();
    const prefix = snapshot.filter((record) => hasRole(record, 'system'));
    if (prefix.length === 0) throw new Error('the main session has no system prefix');
    const memory = this.d.memory();
    const portrait = memory?.enabled() ? await memory.selfPortrait().catch(() => '') : '';
    const now = (this.d.now ?? (() => new Date()))();
    const done = { note: '' };
    const messages = [
      ...prefix,
      message('user', SELF_REVIEW_TEXT[this.d.modelLanguage()]({
        portrait,
        recent: recentConversation(snapshot),
        date: localDate(this.d.timezone(), now),
      })),
    ];
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        core.spawnFork({
          id: GROWTH_SESSION,
          messages,
          tools: [...this.d.tools(), finishReviewTool(done)],
          wrapUpHint: 'Wrap up: call finish_review now. If nothing needed to change, say so there and end.',
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('self-review timed out')), REVIEW_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.d.log?.info('[growth] self-review finished', { note: done.note || null, ms: Date.now() - started });
  }
}
