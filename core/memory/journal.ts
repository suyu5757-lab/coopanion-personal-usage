import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AffectionLedger } from './affection.ts';
import type { HindsightMemory } from './hindsight.ts';

export interface JournalLog {
  warn(message: string, data?: unknown): void;
}

export interface JournalOptions {
  memory: HindsightMemory;
  affection: AffectionLedger;
  rootDir: string;
  timezone: string;
  enabled: boolean;
  now?: () => Date;
  log?: JournalLog;
}

const HOUR = 3_600_000;
const MAX_CATCH_UP_DAYS = 3;

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayIn(timezone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export class RelationshipJournal {
  private memory: HindsightMemory | null = null;
  private affection: AffectionLedger | null = null;
  private rootDir: string | null = null;
  private timezone = 'UTC';
  private enabled = false;
  private now: () => Date = () => new Date();
  private log: JournalLog | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  configure(opts: JournalOptions): void {
    this.memory = opts.memory;
    this.affection = opts.affection;
    this.rootDir = opts.rootDir;
    this.timezone = opts.timezone;
    this.enabled = opts.enabled;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.runDue();
    this.timer = setInterval(() => void this.runDue(), HOUR);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private file(): string | null {
    return this.rootDir ? join(this.rootDir, 'journal.json') : null;
  }

  private readLastDay(): string | null {
    const file = this.file();
    if (!file || !existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { lastDay?: unknown };
      return typeof parsed.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.lastDay) ? parsed.lastDay : null;
    } catch {
      return null;
    }
  }

  private writeLastDay(day: string): void {
    const file = this.file();
    if (!file) return;
    try {
      writeFileSync(file, `${JSON.stringify({ lastDay: day })}\n`, 'utf8');
    } catch (err) {
      this.log?.warn('[journal] could not save the journal marker', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  async runDue(): Promise<void> {
    if (!this.enabled || this.running) return;
    const memory = this.memory;
    const affection = this.affection;
    if (!memory?.enabled() || !affection?.enabled()) return;
    this.running = true;
    try {
      const today = dayIn(this.timezone, this.now());
      const yesterday = addDays(today, -1);
      const saved = this.readLastDay();
      if (!saved) {
        const quiet = affection.eventsOn(yesterday).length === 0;
        this.writeLastDay(yesterday);
        if (quiet) return;
      }
      let cursor = saved ?? addDays(yesterday, -1);
      if (cursor < addDays(yesterday, -MAX_CATCH_UP_DAYS + 1)) cursor = addDays(yesterday, -MAX_CATCH_UP_DAYS + 1);
      let wrote = false;
      while (addDays(cursor, 1) <= yesterday) {
        const day = addDays(cursor, 1);
        const events = affection.eventsOn(day);
        if (events.length > 0) {
          const summary = affection.summary(day);
          const question = `Write Coo's private diary entry for ${day} about the relationship with the person. `
            + `Use these affection events and the day's long-term memories: ${summary}. `
            + 'Mention what the person did, how Coo responded, and anything worth carrying forward. '
            + 'Two to four sentences, first person, warm and concrete. No diagnosis, no heading, no bullet list.';
          const answer = await memory.reflect(question, { tags: ['scope:affection'], tagsMatch: 'any', timeoutMs: 120_000 });
          const text = answer || `Today: ${summary}.`;
          memory.retainJournal(text, day);
          wrote = true;
        } else if (day === yesterday) {
          memory.retainJournal(`A quiet day. ${affection.snapshot() || 'No affection events were recorded.'}`, day);
          wrote = true;
        }
        this.writeLastDay(day);
        cursor = day;
      }
      if (wrote) {
        await memory.refreshModel('relationship');
        this.log?.warn(`[journal] relationship journal refreshed through ${yesterday}`);
      }
    } catch (err) {
      this.log?.warn('[journal] daily relationship journal failed', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }
}
