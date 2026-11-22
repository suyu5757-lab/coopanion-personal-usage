import { describe, expect, it } from 'vitest';
import { planRecall } from '../core/memory/router.ts';
import { DEFAULT_ACTIVATION_RANK_INFLUENCE, formatRecallDetailed } from '../core/memory/format.ts';

describe('natural recall and low-activation optimization', () => {
  it('routes implicit preference, continuation and recommendation statements to standard instead of fast', () => {
    expect(planRecall('按老样子继续做抖音图文').route).toBe('standard');
    expect(planRecall('帮我推荐一家咖啡店').route).toBe('standard');
    expect(planRecall('我习惯晚上写完复盘再睡').route).toBe('standard');
    expect(planRecall('continue as usual').route).toBe('standard');
  });

  it('keeps ordinary short greetings and new statements on fast route', () => {
    expect(planRecall('你好').route).toBe('fast');
    expect(planRecall('今天工作有点累').route).toBe('fast');
    expect(planRecall('昨天我买了一个新键盘').route).toBe('fast');
  });

  it('uses calibrated activation influence so a higher-relevance low-activation memory beats a lower-relevance recent item', () => {
    expect(DEFAULT_ACTIVATION_RANK_INFLUENCE).toBe(0.18);
    const formatted = formatRecallDetailed([
      {
        id: 'older-high-rel',
        text: 'User prefers oat milk latte with light ice.',
        type: 'world',
        document_id: 'user:main:100',
        activationWeight: 0.05,
      },
      {
        id: 'older-second',
        text: 'User prefers hand-pour autumn coffee photography.',
        type: 'world',
        document_id: 'user:main:101',
        activationWeight: 0.05,
      },
      {
        id: 'recent-lower-rel',
        text: 'User mentioned drinking water today.',
        type: 'world',
        document_id: 'user:main:999',
        activationWeight: 0.95,
      },
    ], { maxItems: 2, coverageWeight: 0.5 });
    expect(formatted.trace.includedResultIds).toEqual(['older-high-rel', 'older-second']);
  });
});
