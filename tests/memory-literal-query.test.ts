import { describe, expect, it } from 'vitest';
import { literalSourceQueries } from '../core/memory/tools.ts';

describe('literal source query candidates', () => {
  it('keeps a short literal phrase unchanged', () => {
    expect(literalSourceQueries('讲故事')[0]).toBe('讲故事');
    expect(literalSourceQueries('列表')[0]).toBe('列表');
  });

  it('pulls short CJK tokens out of a natural phrase', () => {
    const values = literalSourceQueries('云海视频 文案 讲故事');
    expect(values).toContain('讲故事');
    expect(values).toContain('文案');
    expect(values.every((value) => [...value].length >= 2 && [...value].length <= 4)).toBe(true);
  });

  it('falls back to a short suffix when there are no spaces', () => {
    expect(literalSourceQueries('抖音话题列表')).toContain('列表');
    expect(literalSourceQueries('云海视频文案灵感')).toContain('文案');
  });

  it('does not emit duplicates or arbitrarily long candidates', () => {
    const values = literalSourceQueries('云海 云海 讲故事 讲故事');
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeLessThanOrEqual(6);
    expect(values).not.toContain('云海视频文案灵感');
  });
});
