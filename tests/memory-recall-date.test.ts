import { describe, expect, it } from 'vitest';
import { recallDateContext, recallDateNeedsHistory, recallDateQuery } from '../core/memory/recall-date.ts';
import { planRecallQueries } from '../core/memory/recall-query.ts';
import { planRecall } from '../core/memory/router.ts';

const now = new Date('2026-11-16T04:00:00.000Z');
const shanghai = { now, timeZone: 'Asia/Shanghai' };

describe('dated recall questions', () => {
  it.each([
    '2026年10月25日的日记',
    '2026-10-25 的日记',
    '2026/10/25 的日记',
    '大肥鱼在2026年10月25日记录了什么',
    'October 25, 2026 journal',
  ])('resolves the calendar day in %s', (query) => {
    const context = recallDateContext(query, shanghai);
    expect(context?.date).toBe('2026-10-25');
    expect(context?.start).toBe('2026-10-24T16:00:00.000Z');
    expect(context?.end).toBe('2026-10-25T16:00:00.000Z');
  });

  it('infers the year for a month and day in the recent past', () => {
    const context = recallDateContext('10月25号大肥鱼的日记', shanghai);
    expect(context?.date).toBe('2026-10-25');
    expect(context?.recordKind).toBe('journal');
  });

  it('keeps the local day boundary across a different timezone', () => {
    const context = recallDateContext('2026-10-25', { now, timeZone: 'UTC' });
    expect(context?.start).toBe('2026-10-25T00:00:00.000Z');
    expect(context?.end).toBe('2026-10-26T00:00:00.000Z');
  });

  it('distinguishes a journal request from a general record request', () => {
    expect(recallDateContext('2026年10月25日的日记', shanghai)?.recordKind).toBe('journal');
    expect(recallDateContext('大肥鱼在2026年10月25日记录了什么', shanghai)?.recordKind).toBe('record');
    expect(recallDateContext('2026年10月25日', shanghai)?.recordKind).toBe('none');
  });

  it('does not invent a date from a bare month or an unrelated number', () => {
    expect(recallDateContext('10月的计划是什么', shanghai)).toBeNull();
    expect(recallDateContext('预算 25 和 10', shanghai)).toBeNull();
    expect(recallDateContext('2025年10月25日的日记', shanghai)?.date).toBe('2025-10-25');
  });

  it('names the day in an indexable form without splitting the date into numbers', () => {
    const context = recallDateContext('2026年10月25日的日记', shanghai)!;
    expect(recallDateQuery(context)).toBe('2026-10-25 journal');
    expect(recallDateQuery({ ...context, recordKind: 'record' })).toBe('2026-10-25');
  });

  it('routes a dated record question to the history route', () => {
    for (const query of [
      '2026年10月25日的日记',
      '2026-10-25 的日记',
      '10月25号大肥鱼的日记',
      '大肥鱼在2026年10月25日记录了什么',
      'What did Coo write in the private journal on 2026-10-25?',
    ]) {
      expect(planRecall(query).route, query).toBe('deep');
      expect(recallDateNeedsHistory(recallDateContext(query, shanghai), query), query).toBe(true);
    }
  });

  it('does not treat a dated plan without a record or question as history', () => {
    expect(planRecall('2026年10月25日').route).not.toBe('deep');
  });

  it('adds the untouched ISO date to the supplemental queries', () => {
    const plan = planRecallQueries('2026年10月25日的日记');
    expect(plan.dateContext?.date).toBe('2026-10-25');
    expect(plan.supplementalQueries[0]).toBe('2026-10-25 journal');
    expect(plan.supplementalQueries.some((query) => query.includes('2026-10-25 diary'))).toBe(true);
  });
});
