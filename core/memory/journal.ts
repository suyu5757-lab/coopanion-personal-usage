import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeState } from '../state-file.ts';
import type { HindsightMemory } from './hindsight.ts';

export interface JournalLog {
  warn(message: string, data?: unknown): void;
}

export interface JournalOptions {
  memory: HindsightMemory;
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
  private rootDir: string | null = null;
  private timezone = 'UTC';
  private enabled = false;
  private now: () => Date = () => new Date();
  private log: JournalLog | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  configure(opts: JournalOptions): void {
    this.memory = opts.memory;
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
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { lastDay?: unknown };
    if (typeof parsed.lastDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.lastDay)
      || !Number.isFinite(Date.parse(`${parsed.lastDay}T12:00:00Z`))) throw new Error('invalid journal day marker');
    return parsed.lastDay;
  }

  private writeLastDay(day: string): void {
    const file = this.file();
    if (!file) return;
    try {
      writeState(file, `${JSON.stringify({ lastDay: day })}\n`);
    } catch (err) {
      this.log?.warn('[journal] could not save the journal marker', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  async runDue(): Promise<void> {
    if (!this.enabled || this.running) return;
    const memory = this.memory;
    if (!memory?.enabled() || !memory.settled()) return;
    this.running = true;
    try {
      const today = dayIn(this.timezone, this.now());
      const yesterday = addDays(today, -1);
      const saved = this.readLastDay();
      if (!saved) {
        this.writeLastDay(yesterday);
        return;
      }
      let cursor = saved;
      if (cursor < addDays(yesterday, -MAX_CATCH_UP_DAYS)) cursor = addDays(yesterday, -MAX_CATCH_UP_DAYS);
      let wrote = false;
      while (addDays(cursor, 1) <= yesterday) {
        const day = addDays(cursor, 1);
        if (memory.journalDayRecorded(day)) {
          this.writeLastDay(day);
          cursor = day;
          continue;
        }
        const question = `Write Coo's private diary entry for ${day} about the relationship with the person. `
          + 'Use that day\'s affection events, affinity changes and long-term memories. '
          + 'Describe only what the dated sources support; distinguish feelings, plans and claims from verified actions. '
          + 'Two to four sentences, first person, warm and concrete. No diagnosis, no heading, no bullet list.';
        const expectedEpoch = memory.evidenceEpoch();
        if (!expectedEpoch) return;
        const read = await memory.reflectDetailed(question, { tags: ['scope:affection'], tagsMatch: 'any', timeoutMs: 120_000, requireSources: true });
        // A forget during the reflection makes the answer unusable, and a journal entry would
        // carry the forgotten source into a new document.
        if (!memory.settled() || memory.evidenceEpoch() !== expectedEpoch) return;
        if (read.status !== 'found' || !read.text || !read.sourceSegments?.length) return;
        const retained = await memory.retainJournal(read.text, day, {
          sourceIds: read.sourceSegments.map((source) => source.documentId), expectedEpoch,
        });
        if (retained !== 'queued' && retained !== 'verified' && retained !== 'exists') {
          this.log?.warn(`[journal] generated journal was not queued for ${day}: ${retained}`);
          return;
        }
        this.writeLastDay(day);
        cursor = day;
        wrote = true;
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
