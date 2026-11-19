/**
 * Absolute dates in a recall question, resolved to one local calendar day.
 *
 * Recall's semantic and keyword arms see the text of a memory unit. A dated source can have an
 * unambiguous `mentioned_at` while its body carries no readable date, so a question that names
 * the date needs a date-indexed lookup as well as text retrieval. This module only resolves the
 * date; it does not read the bank and does not decide a source's trust.
 */

export type RecallRecordKind = 'journal' | 'record' | 'none';

export interface RecallDateContext {
  /** The local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Inclusive UTC instant of local midnight. */
  start: string;
  /** Exclusive UTC instant of the next local midnight. */
  end: string;
  /** What the question asks for, when it names a kind of record. */
  recordKind: RecallRecordKind;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const RECORD_WORDS = /(?:日记|日志|手记|记录|记下|写下|写了|写过|记了|记过|journal|diary|logbook|wrote|written|write|recorded|record)/iu;
const JOURNAL_WORDS = /(?:日记(?!录)|日志|手记|journal|diary)/iu;
const QUESTION_WORDS = /(?:什么|哪|谁|为什么|怎么|多少|几|吗|呢|是否|what|which|who|when|how|did|does|was|were)/iu;

function validDate(value: CalendarDate): boolean {
  if (value.year < 1900 || value.year > 2200 || value.month < 1 || value.month > 12 || value.day < 1 || value.day > 31) return false;
  const check = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return check.getUTCFullYear() === value.year && check.getUTCMonth() === value.month - 1 && check.getUTCDate() === value.day;
}

function dayParts(timeZone: string, at: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function offsetMs(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - instant;
}

function localMidnightUtc(value: CalendarDate, timeZone: string): number {
  const wall = Date.UTC(value.year, value.month - 1, value.day);
  let instant = wall;
  // Two passes settle a DST boundary: the offset belongs to the local instant, not the guess.
  for (let pass = 0; pass < 2; pass += 1) instant = wall - offsetMs(timeZone, instant);
  return instant;
}

function addDay(value: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function yearForMonthDay(month: number, day: number, now: CalendarDate): number {
  const candidate = new Date(Date.UTC(now.year, month - 1, day));
  const today = new Date(Date.UTC(now.year, now.month - 1, now.day));
  return candidate.getTime() > today.getTime() + 86_400_000 ? now.year - 1 : now.year;
}

function calendarFromMatch(match: RegExpMatchArray, now: CalendarDate): CalendarDate | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = { year, month, day };
  return validDate(value) ? value : null;
}

function findCalendarDate(input: string, now: CalendarDate): CalendarDate | null {
  // 2026年10月25日 / 2026 年 10 月 25 号
  const chinese = input.match(/((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u);
  if (chinese) return calendarFromMatch(chinese, now);
  // 2026-10-25, 2026/10/25, 2026.10.25
  const numeric = input.match(/((?:19|20)\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/u);
  if (numeric) return calendarFromMatch(numeric, now);
  // October 25, 2026 / 25 October 2026
  const monthName = input.match(new RegExp(`(?:(${Object.keys(MONTHS).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+((?:19|20)\\d{2}))|(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${Object.keys(MONTHS).join('|')})[,]?\\s+((?:19|20)\\d{2}))`, 'iu'));
  if (monthName) {
    const month = MONTHS[(monthName[1] ?? monthName[5] ?? '').toLocaleLowerCase()];
    const day = Number(monthName[2] ?? monthName[4]);
    const year = Number(monthName[3] ?? monthName[6]);
    const value = { year, month: month ?? 0, day };
    return validDate(value) ? value : null;
  }
  // 10月25日 / 10月25号 (the year comes from the question time)
  const monthDay = input.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    const value = { year: yearForMonthDay(month, day, now), month, day };
    return validDate(value) ? value : null;
  }
  return null;
}

function relativeDay(input: string, now: CalendarDate): CalendarDate | null {
  const today = new Date(Date.UTC(now.year, now.month - 1, now.day));
  if (/(?:今天|today)/iu.test(input)) return { ...now };
  if (/(?:昨天|yesterday)/iu.test(input)) today.setUTCDate(today.getUTCDate() - 1);
  else if (/(?:前天)/u.test(input)) today.setUTCDate(today.getUTCDate() - 2);
  else return null;
  return { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1, day: today.getUTCDate() };
}

/** Resolves an absolute (or bare today/yesterday) date in the person's timezone. */
export function recallDateContext(input: string, opts: { now?: Date; timeZone?: string } = {}): RecallDateContext | null {
  const text = input.trim();
  if (!text) return null;
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const at = opts.now ?? new Date();
  const now = dayParts(timeZone, at);
  const date = findCalendarDate(text, now) ?? relativeDay(text, now);
  if (!date) return null;
  // A future calendar day cannot be a historical record; it stays ordinary planning.
  if (Date.UTC(date.year, date.month - 1, date.day) > Date.UTC(now.year, now.month - 1, now.day)) return null;
  // A bare month/day is a date only when a day cue is present; `10月25` is often a heading.
  if (!/(?:年|[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}|月\s*\d{1,2}\s*[日号]|(?:19|20)\d{2}|today|yesterday|tomorrow)/iu.test(text)) return null;
  const recordKind: RecallRecordKind = JOURNAL_WORDS.test(text) ? 'journal'
    : RECORD_WORDS.test(text) ? 'record' : 'none';
  const start = localMidnightUtc(date, timeZone);
  const end = localMidnightUtc(addDay(date), timeZone);
  const iso = `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  return { date: iso, start: new Date(start).toISOString(), end: new Date(end).toISOString(), recordKind };
}

/** True when a question about the named date asks for a record rather than ordinary conversation. */
export function recallDateNeedsHistory(context: RecallDateContext | null, input: string): boolean {
  if (!context) return false;
  return context.recordKind !== 'none' || QUESTION_WORDS.test(input);
}

/** The single retrieval query that names the day in a form BM25 can index. */
export function recallDateQuery(context: RecallDateContext): string {
  return context.recordKind === 'journal' ? `${context.date} journal` : context.date;
}

/** Keeps an exact date from being split into unrelated numbers by the generic topic compactor. */
export function recallDateLiteral(input: string): string | null {
  const context = recallDateContext(input);
  return context?.date ?? null;
}
