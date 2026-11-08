import { describe, expect, it } from 'vitest';
import { scoreTemporalAnswer, scoreTemporalCase, TEMPORAL_SCORER_CASES } from './fixtures/temporal-scorer.ts';

const byId = (id: string) => {
  const testCase = TEMPORAL_SCORER_CASES.find((item) => item.id === id);
  if (!testCase) throw new Error(`missing temporal case ${id}`);
  return testCase;
};

describe('temporal scorer contract', () => {
  it.each(TEMPORAL_SCORER_CASES.filter((testCase) => testCase.scoreable))('scores the intended temporal field for $id', (testCase) => {
    const result = scoreTemporalCase(testCase, testCase.expectedDate, testCase.requiredSourceIds);
    expect(result.answer.status).toBe('correct');
    expect(result.answer.intendedField).toBe(testCase.intendedField);
    expect(result.retrieval).toMatchObject({ status: 'complete', missingRequiredSourceIds: [] });
  });

  it('separates a changed booking date from the date when it changed', () => {
    const testCase = byId('current-valid-from-after-correction');
    expect(scoreTemporalAnswer(testCase, 'October 11, 2026')).toMatchObject({
      status: 'wrong_field', intendedField: 'valid_from', answerDate: '2026-10-11', matchingFields: ['event_time'],
    });
  });

  it('scores the stated inclusive valid-to boundary without shifting it by one day', () => {
    const testCase = byId('valid-to-inclusive-boundary');
    expect(testCase.rangeEndInclusive).toBe(true);
    expect(scoreTemporalAnswer(testCase, '2027-09-20').status).toBe('correct');
    expect(scoreTemporalAnswer(testCase, '2027-09-19')).toMatchObject({ status: 'wrong_field', matchingFields: ['valid_from'] });
  });

  it('scores local dates after converting an offset timestamp into the case timezone', () => {
    const testCase = byId('event-time-crosses-utc-day');
    expect(scoreTemporalAnswer(testCase, '2026-10-12T06:30:00Z')).toMatchObject({
      status: 'correct', answerDate: '2026-10-11', expectedDate: '2026-10-11',
    });
    expect(scoreTemporalAnswer(testCase, '2026-10-12')).toMatchObject({ status: 'wrong_field', matchingFields: ['said_at'] });
    expect(scoreTemporalAnswer(testCase, '2026-10-11T23:30:00')).toMatchObject({ status: 'unparseable' });
  });

  it('accepts an explicit Chinese year-month-day answer without inferring a missing year', () => {
    expect(scoreTemporalAnswer(byId('event-time-zh'), '2026年10月11日')).toMatchObject({ status: 'correct', answerDate: '2026-10-11' });
    expect(scoreTemporalAnswer(byId('event-time-zh'), '10月11日').status).toBe('unparseable');
  });

  it('keeps answer correctness separate from required-source retrieval and superseded-source inclusion', () => {
    const testCase = byId('current-valid-from-after-correction');
    const result = scoreTemporalCase(testCase, '2027-09-19', ['src-v17-planner-old-schedule']);
    expect(result.answer.status).toBe('correct');
    expect(result.retrieval).toEqual({
      status: 'missing_required_source',
      missingRequiredSourceIds: ['src-v17-planner-update-event'],
      includedSupersededSourceIds: ['src-v17-planner-old-schedule'],
    });
  });

  it('does not depend on source input order', () => {
    const testCase = byId('current-valid-from-after-correction');
    const first = scoreTemporalCase(testCase, '2027-09-19', ['src-v17-planner-old-schedule', 'src-v17-planner-update-event']);
    const reversed = scoreTemporalCase(testCase, '2027-09-19', ['src-v17-planner-update-event', 'src-v17-planner-old-schedule']);
    expect(reversed).toEqual(first);
  });

  it('leaves the ambiguous N3.6 wording out of the score denominator', () => {
    const testCase = byId('ambiguous-reschedule-date');
    expect(testCase.ambiguityReason).toBeTruthy();
    expect(scoreTemporalCase(testCase, '2026-10-11', [])).toEqual({
      answer: { status: 'unscorable_ambiguous', intendedField: null, answerDate: null, expectedDate: null, matchingFields: [] },
      retrieval: { status: 'unscorable', missingRequiredSourceIds: [], includedSupersededSourceIds: [] },
    });
  });

  it('requires one explicit calendar date and rejects missing, malformed or multiple dates', () => {
    const testCase = byId('event-time');
    expect(scoreTemporalAnswer(testCase, '').status).toBe('missing');
    expect(scoreTemporalAnswer(testCase, 'sometime next week').status).toBe('unparseable');
    expect(scoreTemporalAnswer(testCase, '2026-02-30').status).toBe('unparseable');
    expect(scoreTemporalAnswer(testCase, '2026-02-30T12:00:00Z').status).toBe('unparseable');
    expect(scoreTemporalAnswer(testCase, '2026-10-11 and 2027-09-19').status).toBe('multiple_dates');
  });
});
