import { describe, expect, it } from 'vitest';
import { createDevelopmentMemoryEvaluationSet } from './fixtures/memory-evaluation.ts';
import {
  createMemoryEvaluationHoldoutCorpus,
  createMemoryEvaluationHoldoutPrompts,
  createMemoryEvaluationHoldoutScoringCases,
  createMemoryEvaluationHoldoutSet,
} from './fixtures/memory-evaluation-holdout.ts';
import { createMemoryEvaluationHoldoutGold, validateMemoryEvaluationHoldoutGold } from './fixtures/memory-evaluation-holdout-gold.ts';

describe('memory evaluation sealed holdout', () => {
  it('contains a separate synthetic 100/40 corpus with source-linked answers', () => {
    const cases = createMemoryEvaluationHoldoutSet();
    const prompts = createMemoryEvaluationHoldoutPrompts();
    const corpus = createMemoryEvaluationHoldoutCorpus();
    const scoringCases = createMemoryEvaluationHoldoutScoringCases();
    const gold = createMemoryEvaluationHoldoutGold();
    const developmentIds = new Set(createDevelopmentMemoryEvaluationSet().map((item) => item.id));

    expect(cases).toHaveLength(140);
    expect(cases.every((item) => !('expectedAnswer' in item))).toBe(true);
    expect(cases.filter((item) => item.answerable)).toHaveLength(100);
    expect(cases.filter((item) => !item.answerable)).toHaveLength(40);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(cases.every((item) => item.documents.every((document) => document.sourceId.startsWith('src-holdout-')))).toBe(true);
    expect(cases.filter((item) => item.category === 'low_activation_cue')).toHaveLength(10);
    expect(cases.filter((item) => item.category === 'natural_recall')).toHaveLength(10);
    expect(cases.filter((item) => item.category === 'natural_recall').every((item) => item.requiredSourceIds.length === 1 && item.forbiddenSourceIds.length === 1)).toBe(true);
    expect(prompts).toHaveLength(cases.length);
    expect(prompts.every((item) => Object.keys(item).sort().join(',') === 'id,query')).toBe(true);
    expect(prompts.filter((item) => item.id.startsWith('holdout-natural-'))).toHaveLength(10);
    expect(prompts.filter((item) => item.id.startsWith('holdout-natural-')).every((item) => !/what did .* choose|what colour did|你之前选|上次选/i.test(item.query))).toBe(true);
    expect(corpus).toHaveLength(cases.length);
    expect(corpus.every((item) => !('query' in item) && !('category' in item) && !('requiredSourceIds' in item) && !('deletedSourceIds' in item) && !('forbiddenSourceIds' in item))).toBe(true);
    expect(scoringCases).toHaveLength(cases.length);
    expect(scoringCases.every((item) => Object.keys(item).sort().join(',') === 'answerable,category,deletedSourceIds,forbiddenSourceIds,id,requiredSourceIds')).toBe(true);
    expect(scoringCases.map(({ id, answerable, requiredSourceIds, deletedSourceIds, forbiddenSourceIds, category }) => ({ id, answerable, requiredSourceIds, deletedSourceIds, forbiddenSourceIds, category }))).toEqual(
      cases.map(({ id, answerable, requiredSourceIds, deletedSourceIds, forbiddenSourceIds, category }) => ({
        id,
        answerable,
        requiredSourceIds,
        deletedSourceIds: deletedSourceIds ?? [],
        forbiddenSourceIds,
        category,
      })),
    );
    expect(scoringCases.every((item) => !('query' in item) && !('documents' in item) && !('expectedAnswer' in item))).toBe(true);
    expect(gold.filter((item) => item.category === 'natural_recall')).toHaveLength(10);
    expect(gold.filter((item) => item.category === 'low_activation_cue')).toHaveLength(10);
    expect(cases.some((item) => item.category === 'low_activation_multihop')).toBe(true);
    expect(cases.some((item) => item.category === 'user_correction')).toBe(true);
    expect(cases.filter((item) => item.category === 'qualified_user_mentions').every((item) => item.mentionEvents?.some((event) => event.deliveryAttempts === 10))).toBe(true);
    expect(cases.filter((item) => item.category === 'explicitly_deleted').every((item) => item.deletedSourceIds?.every((sourceId) => item.documents.some((document) => document.sourceId === sourceId && document.state === 'deleted')))).toBe(true);
    expect(cases.some((item) => developmentIds.has(item.id))).toBe(false);
    expect(() => validateMemoryEvaluationHoldoutGold(cases, gold)).not.toThrow();
  });
});
