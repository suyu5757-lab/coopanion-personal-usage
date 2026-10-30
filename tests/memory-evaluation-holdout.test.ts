import { describe, expect, it } from 'vitest';
import { createDevelopmentMemoryEvaluationSet } from './fixtures/memory-evaluation.ts';
import { createMemoryEvaluationHoldoutSet } from './fixtures/memory-evaluation-holdout.ts';
import { createMemoryEvaluationHoldoutGold, validateMemoryEvaluationHoldoutGold } from './fixtures/memory-evaluation-holdout-gold.ts';

describe('memory evaluation sealed holdout', () => {
  it('contains a separate synthetic 100/40 corpus with source-linked answers', () => {
    const cases = createMemoryEvaluationHoldoutSet();
    const gold = createMemoryEvaluationHoldoutGold();
    const developmentIds = new Set(createDevelopmentMemoryEvaluationSet().map((item) => item.id));

    expect(cases).toHaveLength(140);
    expect(cases.filter((item) => item.answerable)).toHaveLength(100);
    expect(cases.filter((item) => !item.answerable)).toHaveLength(40);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(cases.every((item) => item.documents.every((document) => document.sourceId.startsWith('src-holdout-')))).toBe(true);
    expect(cases.some((item) => item.category === 'low_activation_cue' && item.documents.some((document) => document.activationWeight === 0.05))).toBe(true);
    expect(cases.some((item) => item.category === 'low_activation_multihop')).toBe(true);
    expect(cases.some((item) => item.category === 'user_correction')).toBe(true);
    expect(cases.filter((item) => item.category === 'qualified_user_mentions').every((item) => item.mentionEvents?.some((event) => event.deliveryAttempts === 10))).toBe(true);
    expect(cases.filter((item) => item.category === 'explicitly_deleted').every((item) => item.deletedSourceIds?.every((sourceId) => item.documents.some((document) => document.sourceId === sourceId && document.state === 'deleted')))).toBe(true);
    expect(cases.some((item) => developmentIds.has(item.id))).toBe(false);
    expect(() => validateMemoryEvaluationHoldoutGold(cases, gold)).not.toThrow();
  });
});
