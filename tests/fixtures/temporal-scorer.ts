export type TemporalField = 'event_time' | 'valid_from' | 'valid_to' | 'said_at' | 'historical_valid_from';
export type TemporalAnswerStatus = 'correct' | 'wrong_field' | 'incorrect' | 'missing' | 'unparseable' | 'multiple_dates' | 'unscorable_ambiguous';

export interface TemporalScorerCase {
  id: string;
  question: string;
  intendedField: TemporalField | null;
  fieldValues: Partial<Record<TemporalField, string>>;
  expectedDate?: string;
  requiredSourceIds: string[];
  supersededSourceIds: string[];
  answerTimeZone: string;
  scoreable: boolean;
  rangeEndInclusive?: boolean;
  ambiguityReason?: string;
}

const oldSource = 'src-v17-planner-old-schedule';
const updateSource = 'src-v17-planner-update-event';
const reportSource = 'src-v17-planner-report-time';

export const TEMPORAL_SCORER_CASES: TemporalScorerCase[] = [
  {
    id: 'event-time', question: 'On what date was the greenhouse visit changed?', intendedField: 'event_time',
    fieldValues: { event_time: '2026-10-11', valid_from: '2027-09-19', valid_to: '2027-09-20', said_at: '2026-10-12', historical_valid_from: '2026-04-12' },
    expectedDate: '2026-10-11', requiredSourceIds: [updateSource], supersededSourceIds: [], answerTimeZone: 'UTC', scoreable: true,
  },
  {
    id: 'event-time-zh', question: '执行改期这项操作的日期是什么？', intendedField: 'event_time',
    fieldValues: { event_time: '2026-10-11', valid_from: '2027-09-19', valid_to: '2027-09-20', said_at: '2026-10-12', historical_valid_from: '2026-04-12' },
    expectedDate: '2026-10-11', requiredSourceIds: [updateSource], supersededSourceIds: [], answerTimeZone: 'Asia/Shanghai', scoreable: true,
  },
  {
    id: 'current-valid-from-after-correction', question: 'What date is the greenhouse visit now scheduled for?', intendedField: 'valid_from',
    fieldValues: { event_time: '2026-10-11', valid_from: '2027-09-19', valid_to: '2027-09-20', said_at: '2026-10-12', historical_valid_from: '2026-04-12' },
    expectedDate: '2027-09-19', requiredSourceIds: [updateSource], supersededSourceIds: [oldSource], answerTimeZone: 'UTC', scoreable: true,
  },
  {
    id: 'valid-to-inclusive-boundary', question: 'Through what date is the updated greenhouse booking valid?', intendedField: 'valid_to',
    fieldValues: { event_time: '2026-10-11', valid_from: '2027-09-19', valid_to: '2027-09-20', said_at: '2026-10-12', historical_valid_from: '2026-04-12' },
    expectedDate: '2027-09-20', requiredSourceIds: [updateSource], supersededSourceIds: [], answerTimeZone: 'UTC', scoreable: true, rangeEndInclusive: true,
  },
  {
    id: 'said-at-report-date', question: 'On what date did Planner 901 tell the companion about the change?', intendedField: 'said_at',
    fieldValues: { event_time: '2026-10-11', valid_from: '2027-09-19', valid_to: '2027-09-20', said_at: '2026-10-12', historical_valid_from: '2026-04-12' },
    expectedDate: '2026-10-12', requiredSourceIds: [reportSource], supersededSourceIds: [], answerTimeZone: 'UTC', scoreable: true,
  },
  {
    id: 'historical-valid-from', question: 'What date was the greenhouse visit originally scheduled for?', intendedField: 'historical_valid_from',
    fieldValues: { event_time: '2026-10-11', valid_from: '2027-09-19', valid_to: '2027-09-20', said_at: '2026-10-12', historical_valid_from: '2026-04-12' },
    expectedDate: '2026-04-12', requiredSourceIds: [oldSource], supersededSourceIds: [], answerTimeZone: 'UTC', scoreable: true,
  },
  {
    id: 'event-time-crosses-utc-day', question: 'On what calendar date was the greenhouse booking changed in Pacific time?', intendedField: 'event_time',
    fieldValues: { event_time: '2026-10-11T23:30:00-07:00', said_at: '2026-10-12T01:00:00-07:00' },
    expectedDate: '2026-10-11', requiredSourceIds: [updateSource], supersededSourceIds: [], answerTimeZone: 'America/Los_Angeles', scoreable: true,
  },
  {
    id: 'ambiguous-reschedule-date',
    question: 'On which date did Planner 901 most recently reschedule the greenhouse visit?',
    intendedField: null,
    fieldValues: { event_time: '2026-10-11', valid_from: '2027-09-19', valid_to: '2027-09-20', said_at: '2026-10-12', historical_valid_from: '2026-04-12' },
    requiredSourceIds: [], supersededSourceIds: [], answerTimeZone: 'UTC', scoreable: false,
    ambiguityReason: 'The wording can ask for the event date or the new appointment date.',
  },
];

export interface TemporalAnswerScore {
  status: TemporalAnswerStatus;
  intendedField: TemporalField | null;
  answerDate: string | null;
  expectedDate: string | null;
  matchingFields: TemporalField[];
}

export interface TemporalCaseScore {
  answer: TemporalAnswerScore;
  retrieval: {
    status: 'complete' | 'missing_required_source' | 'unscorable';
    missingRequiredSourceIds: string[];
    includedSupersededSourceIds: string[];
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function zonedDate(value: Date, timeZone: string): string | null {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(value).map((part) => [part.type, part.value]));
    const result = `${parts.year}-${parts.month}-${parts.day}`;
    return validDate(result) ? result : null;
  } catch {
    return null;
  }
}

export function canonicalTemporalDate(value: string, timeZone: string): string | null {
  const date = value.trim();
  if (validDate(date)) return date;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(date)) return null;
  if (!validDate(date.slice(0, 10))) return null;
  const instant = new Date(date);
  return Number.isFinite(instant.getTime()) ? zonedDate(instant, timeZone) : null;
}

const monthIndex: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function answerDateTokens(answer: string): string[] {
  const tokens: Array<{ index: number; date: string }> = [];
  const iso = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?\b/gi;
  for (const match of answer.matchAll(iso)) tokens.push({ index: match.index ?? 0, date: match[0] });
  const chinese = /\b(\d{4})年(\d{1,2})月(\d{1,2})日?\b/g;
  for (const match of answer.matchAll(chinese)) {
    tokens.push({ index: match.index ?? 0, date: `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}` });
  }
  const monthPattern = /\b(January|Jan\.?|February|Feb\.?|March|Mar\.?|April|Apr\.?|May|June|Jun\.?|July|Jul\.?|August|Aug\.?|September|Sept?\.?|October|Oct\.?|November|Nov\.?|December|Dec\.?)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  for (const match of answer.matchAll(monthPattern)) {
    const month = monthIndex[match[1].toLowerCase().replace('.', '')];
    tokens.push({ index: match.index ?? 0, date: `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}` });
  }
  const dayMonthPattern = /\b(\d{1,2})\s+(January|Jan\.?|February|Feb\.?|March|Mar\.?|April|Apr\.?|May|June|Jun\.?|July|Jul\.?|August|Aug\.?|September|Sept?\.?|October|Oct\.?|November|Nov\.?|December|Dec\.?)\s+(\d{4})\b/gi;
  for (const match of answer.matchAll(dayMonthPattern)) {
    const month = monthIndex[match[2].toLowerCase().replace('.', '')];
    tokens.push({ index: match.index ?? 0, date: `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}` });
  }
  return tokens.sort((a, b) => a.index - b.index).map(({ date }) => date);
}

export function scoreTemporalAnswer(testCase: TemporalScorerCase, answer: string | null | undefined): TemporalAnswerScore {
  const blank = typeof answer !== 'string' || !answer.trim();
  if (!testCase.scoreable || !testCase.intendedField || !testCase.expectedDate) {
    return { status: 'unscorable_ambiguous', intendedField: testCase.intendedField, answerDate: null, expectedDate: null, matchingFields: [] };
  }
  if (blank) return { status: 'missing', intendedField: testCase.intendedField, answerDate: null, expectedDate: testCase.expectedDate, matchingFields: [] };
  const values = answerDateTokens(answer);
  if (values.length > 1) return { status: 'multiple_dates', intendedField: testCase.intendedField, answerDate: null, expectedDate: testCase.expectedDate, matchingFields: [] };
  if (values.length === 0) return { status: 'unparseable', intendedField: testCase.intendedField, answerDate: null, expectedDate: testCase.expectedDate, matchingFields: [] };
  if (/\b\d{4}-\d{2}-\d{2}T/i.test(answer)
    && !/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/i.test(answer)) {
    return { status: 'unparseable', intendedField: testCase.intendedField, answerDate: null, expectedDate: testCase.expectedDate, matchingFields: [] };
  }
  const answerDate = canonicalTemporalDate(values[0], testCase.answerTimeZone);
  const expectedDate = canonicalTemporalDate(testCase.expectedDate, testCase.answerTimeZone);
  if (!answerDate || !expectedDate) return { status: 'unparseable', intendedField: testCase.intendedField, answerDate, expectedDate, matchingFields: [] };
  const matchingFields = (Object.entries(testCase.fieldValues) as Array<[TemporalField, string]>)
    .filter(([, value]) => canonicalTemporalDate(value, testCase.answerTimeZone) === answerDate)
    .map(([field]) => field);
  return {
    status: answerDate === expectedDate ? 'correct' : matchingFields.length ? 'wrong_field' : 'incorrect',
    intendedField: testCase.intendedField,
    answerDate,
    expectedDate,
    matchingFields,
  };
}

export function scoreTemporalCase(testCase: TemporalScorerCase, answer: string | null | undefined, retrievedSourceIds: string[]): TemporalCaseScore {
  const scoreable = testCase.scoreable && testCase.intendedField !== null && !!testCase.expectedDate;
  const retrieved = new Set(retrievedSourceIds);
  const missingRequiredSourceIds = testCase.requiredSourceIds.filter((sourceId) => !retrieved.has(sourceId));
  const includedSupersededSourceIds = testCase.supersededSourceIds.filter((sourceId) => retrieved.has(sourceId));
  return {
    answer: scoreTemporalAnswer(testCase, answer),
    retrieval: {
      status: !scoreable ? 'unscorable' : missingRequiredSourceIds.length ? 'missing_required_source' : 'complete',
      missingRequiredSourceIds,
      includedSupersededSourceIds,
    },
  };
}
