import { describe, expect, it } from 'vitest';
import { formatRecallDetailed, type FormattedRecallResult } from '../core/memory/format.ts';
import { compareMemoryEvaluations, observationFromRecallTrace, scoreMemoryEvaluation } from '../scripts/memory-evaluation.ts';
import { createDevelopmentMemoryEvaluationSet } from './fixtures/memory-evaluation.ts';

describe('memory evaluation contract', () => {
  it('builds a privacy-free development corpus with the specified counts', () => {
    const cases = createDevelopmentMemoryEvaluationSet();
    expect(cases).toHaveLength(250);
    expect(cases.filter((testCase) => testCase.answerable)).toHaveLength(200);
    expect(cases.filter((testCase) => !testCase.answerable)).toHaveLength(50);
    expect(cases.filter((testCase) => !testCase.answerable).every((testCase) => (testCase.forbiddenSourceIds?.length ?? 0) > 0)).toBe(true);
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(cases.length);
    expect(cases.every((testCase) => testCase.documents.every((document) => document.sourceId.startsWith('src-dev-')))).toBe(true);
    expect(cases.some((testCase) => testCase.category === 'multi_source')).toBe(true);
    expect(cases.some((testCase) => testCase.category === 'time_update')).toBe(true);
    expect(cases.some((testCase) => testCase.category === 'explicitly_deleted')).toBe(true);
  });

  it('scores evidence, answers, abstentions, deletion leaks and latency with separate denominators', () => {
    const cases = [
      { id: 'a', answerable: true, requiredSourceIds: ['src-a', 'src-b'] },
      { id: 'b', answerable: true, requiredSourceIds: ['src-x'] },
      { id: 'c', answerable: false, requiredSourceIds: [], deletedSourceIds: ['src-deleted'], forbiddenSourceIds: ['src-deleted'] },
      { id: 'd', answerable: false, requiredSourceIds: [], deletedSourceIds: ['src-deleted-2'], forbiddenSourceIds: ['src-deleted-2'] },
    ];
    const observations = [
      { caseId: 'a', sourceIdsAt5: [['src-a']], visibleSourceIds: ['src-a'], contextSourceIds: ['src-a'], answerOutcome: 'abstained' as const, answerCorrect: false, latencyMs: 10, inputTokens: 10, outputTokens: 2, costMicros: 50, costCurrency: 'USD', cpuMs: 12, peakMemoryBytes: 1_000, activationStateRestored: true },
      { caseId: 'b', sourceIdsAt5: [['src-x']], visibleSourceIds: ['src-x'], contextSourceIds: ['src-x'], answerOutcome: 'answered' as const, answerCorrect: true, latencyMs: 20, inputTokens: 20, outputTokens: 4, costMicros: 70, costCurrency: 'USD', cpuMs: 20, peakMemoryBytes: 1_500, activationStateRestored: false },
      { caseId: 'c', sourceIdsAt5: [['src-deleted']], visibleSourceIds: ['src-deleted'], contextSourceIds: ['src-deleted'], answerOutcome: 'answered' as const, answerCorrect: false, latencyMs: 30, activationStateRestored: true },
      { caseId: 'd', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [], answerOutcome: 'abstained' as const, answerCorrect: true, latencyMs: 40 },
    ];

    const score = scoreMemoryEvaluation(cases, observations);

    expect(score.sourceRecallAt5).toEqual({ numerator: 1.5, denominator: 2, value: 0.75 });
    expect(score.completeEvidenceAt5).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.visibleComplete).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.contextComplete).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.answerAccuracy).toEqual({ numerator: 2, denominator: 4, value: 0.5 });
    expect(score.noAnswerPrecision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.noAnswerRecall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.unrelatedHistoryAt5).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.unrelatedHistoryInContext).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.deleteLeak).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.activationStateRestored).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(score.latencyMs).toEqual({ p50: 20, p95: 40, samples: 4 });
    expect(score.usage).toEqual({ inputTokens: 30, outputTokens: 6, costMicros: 120, costCurrency: 'USD', cpuMs: 32, peakMemoryBytes: 1_500, samples: 2 });
  });

  it('reports an unavailable cross-restart metric when no case records it', () => {
    const score = scoreMemoryEvaluation(
      [{ id: 'case-a', answerable: true, requiredSourceIds: ['src-a'] }],
      [{ caseId: 'case-a', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [] }],
    );

    expect(score.activationStateRestored).toEqual({ numerator: 0, denominator: 0, value: null });
  });

  it('compares paired conditions and reports unrelated-history changes separately', () => {
    const cases = [
      { id: 'answer', answerable: true, requiredSourceIds: ['src-good'], forbiddenSourceIds: ['src-bad'], category: 'single_fact' },
      { id: 'no-answer', answerable: false, requiredSourceIds: [], forbiddenSourceIds: ['src-unrelated'], category: 'no_answer' },
    ];
    const baseline = [
      { caseId: 'answer', sourceIdsAt5: [['src-good'], ['src-bad']], visibleSourceIds: ['src-good', 'src-bad'], contextSourceIds: ['src-good', 'src-bad'], answerOutcome: 'answered' as const, answerCorrect: true, activationStateRestored: false },
      { caseId: 'no-answer', sourceIdsAt5: [], visibleSourceIds: ['src-unrelated'], contextSourceIds: [], answerOutcome: 'answered' as const, answerCorrect: false, activationStateRestored: false },
    ];
    const activation = [
      { caseId: 'answer', sourceIdsAt5: [['src-good']], visibleSourceIds: ['src-good'], contextSourceIds: ['src-good'], answerOutcome: 'answered' as const, answerCorrect: true, activationStateRestored: true },
      { caseId: 'no-answer', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [], answerOutcome: 'abstained' as const, answerCorrect: true, activationStateRestored: true },
    ];

    const comparison = compareMemoryEvaluations(cases, baseline, activation);

    expect(comparison.delta.unrelatedHistoryAt5).toBe(-0.5);
    expect(comparison.delta.unrelatedHistoryInContext).toBe(-0.5);
    expect(comparison.delta.answerAccuracy).toBe(0.5);
    expect(comparison.delta.activationStateRestored).toBe(1);
    expect(comparison.byCategory.single_fact.delta.unrelatedHistoryAt5).toBe(-1);
    expect(comparison.byCategory.no_answer.activation.activationStateRestored).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });

  it('turns only verified evidence and final context sources into evaluation observations', () => {
    const observation = observationFromRecallTrace('case-a', {
      status: 'found',
      sourceFactsTruncated: false,
      candidateResultIndexes: [0, 1],
      candidateResultIds: ['observation', 'direct'],
      items: [
        {
          resultIndex: 0, resultId: 'observation', parentDocumentId: 'doc-derived', declaredSourceFactIds: ['fact-a'],
          verifiedSources: [{ sourceFactId: 'fact-a', documentId: 'doc-a' }], disposition: 'visible', sourceFactsIncomplete: false,
        },
        {
          resultIndex: 1, resultId: 'direct', parentDocumentId: 'doc-b', declaredSourceFactIds: [], verifiedSources: [],
          disposition: 'visible', sourceFactsIncomplete: false,
        },
      ],
    }, {
      inputResultIndexes: [0, 1], inputResultIds: ['observation', 'direct'],
      candidateResultIndexes: [0, 1], candidateResultIds: ['observation', 'direct'],
      includedResultIndexes: [0, 1], includedResultIds: ['observation', 'direct'], omittedResultIndexes: [], omittedResultIds: [],
      deduplicatedResultIndexes: [], deduplicatedResultIds: [], includedSourceDocumentIds: ['doc-a', 'doc-b'], omittedSourceDocumentIds: [],
      incompleteResultIds: [], clippedResultIds: [], clippedContextResultIds: [], clippedSourceFactIds: [],
      sourceFactsTruncated: false, coverageWeight: 0.5, activationInfluence: 0.25, activationWeights: [], maxChars: 2000, usedChars: 400,
    }, { activationStateRestored: true });

    expect(observation.sourceIdsAt5).toEqual([['doc-a'], ['doc-b']]);
    expect(observation.visibleSourceIds).toEqual(['doc-a', 'doc-b']);
    expect(observation.contextSourceIds).toEqual(['doc-a', 'doc-b']);
    expect(observation.activationStateRestored).toBe(true);
  });

  it('compares context coverage after a one-variable pack-order change', () => {
    const results: FormattedRecallResult[] = [
      { id: 'a-primary', text: 'The first relevant record.', type: 'world', document_id: 'doc-a' },
      { id: 'a-repeated', text: 'Another record from the same source.', type: 'world', document_id: 'doc-a' },
      { id: 'b-support', text: 'The second required source.', type: 'world', document_id: 'doc-b' },
    ];
    const baseline = formatRecallDetailed(results, { maxItems: 2, coverageWeight: 0 });
    const adjusted = formatRecallDetailed(results, { maxItems: 2, coverageWeight: 0.5 });
    const testCase = { id: 'case-a', answerable: true, requiredSourceIds: ['doc-a', 'doc-b'] };
    const observation = (format: typeof baseline): Parameters<typeof scoreMemoryEvaluation>[1][number] => ({
      caseId: 'case-a',
      sourceIdsAt5: [[ 'doc-a' ], [ 'doc-a' ], [ 'doc-b' ]],
      visibleSourceIds: ['doc-a', 'doc-b'],
      contextSourceIds: format.trace.includedSourceDocumentIds,
    });

    const baselineScore = scoreMemoryEvaluation([testCase], [observation(baseline)]);
    const adjustedScore = scoreMemoryEvaluation([testCase], [observation(adjusted)]);

    expect(baselineScore.completeEvidenceAt5.value).toBe(1);
    expect(baselineScore.contextComplete.value).toBe(0);
    expect(adjustedScore.contextComplete.value).toBe(1);
  });

  it('keeps source coverage ahead of the maximum activation-ranking bonus', () => {
    const results: FormattedRecallResult[] = [
      { id: 'active-a', text: 'An active result from source A.', type: 'world', document_id: 'doc-a', activationWeight: 1 },
      { id: 'active-a-repeat', text: 'Another active result from source A.', type: 'world', document_id: 'doc-a', activationWeight: 1 },
      { id: 'dormant-b', text: 'A directly useful result from source B.', type: 'world', document_id: 'doc-b', activationWeight: 0.001 },
    ];
    const formatted = formatRecallDetailed(results, { maxItems: 2, coverageWeight: 0.5 });

    expect(formatted.trace.includedResultIds).toEqual(['active-a', 'dormant-b']);
    expect(formatted.trace.includedSourceDocumentIds).toEqual(['doc-a', 'doc-b']);
  });

  it('recovers multi-source context coverage across the generated development set under redundant-source pressure', () => {
    const cases = createDevelopmentMemoryEvaluationSet();
    const traces = (coverageWeight: number) => cases.map((testCase) => {
      const documents = testCase.documents.filter((document) => document.state !== 'deleted');
      const firstRequired = testCase.requiredSourceIds.length > 1
        ? documents.find((document) => document.sourceId === testCase.requiredSourceIds[0])
        : undefined;
      const ordered = firstRequired
        ? [firstRequired, { ...firstRequired, text: `${firstRequired.text} A repeated result from the same source.` }, ...documents.filter((document) => document !== firstRequired)]
        : documents;
      const results = ordered.map((document, index): FormattedRecallResult => ({
        id: `${testCase.id}-${index}`,
        text: document.text,
        type: 'world',
        document_id: document.sourceId,
        metadata: { status: document.state },
      }));
      const formatted = formatRecallDetailed(results, { maxItems: 2, coverageWeight });
      return {
        caseId: testCase.id,
        sourceIdsAt5: results.slice(0, 5).map((result) => [result.document_id!]),
        visibleSourceIds: results.map((result) => result.document_id!),
        contextSourceIds: formatted.trace.includedSourceDocumentIds,
        deletedSourceIds: testCase.deletedSourceIds,
      };
    });

    const baseline = scoreMemoryEvaluation(cases, traces(0));
    const coveragePacked = scoreMemoryEvaluation(cases, traces(0.5));

    expect(baseline.contextComplete).toEqual({ numerator: 125, denominator: 200, value: 0.625 });
    expect(coveragePacked.contextComplete).toEqual({ numerator: 200, denominator: 200, value: 1 });
    expect(coveragePacked.contextComplete.value! - baseline.contextComplete.value!).toBeGreaterThanOrEqual(0.25);
    expect(baseline.deleteLeak).toEqual({ numerator: 0, denominator: 25, value: 0 });
    expect(coveragePacked.deleteLeak).toEqual({ numerator: 0, denominator: 25, value: 0 });
  });

  it('rejects missing, duplicate and unpaired evaluation rows', () => {
    expect(() => scoreMemoryEvaluation([{ id: 'a', answerable: true, requiredSourceIds: ['src-a'] }], [])).toThrow('evaluation case has no observation');
    expect(() => scoreMemoryEvaluation([
      { id: 'a', answerable: true, requiredSourceIds: ['src-a'] },
      { id: 'a', answerable: true, requiredSourceIds: ['src-a'] },
    ], [])).toThrow('duplicate or empty evaluation case id');
    expect(() => scoreMemoryEvaluation([], [{ caseId: 'unknown', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [] }])).toThrow('observation has no evaluation case');
  });

  it('does not combine cost values from different currencies', () => {
    const cases = [
      { id: 'a', answerable: true, requiredSourceIds: ['src-a'] },
      { id: 'b', answerable: true, requiredSourceIds: ['src-b'] },
    ];
    const observations = [
      { caseId: 'a', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [], costMicros: 10, costCurrency: 'USD' },
      { caseId: 'b', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [], costMicros: 10, costCurrency: 'CNY' },
    ];
    expect(() => scoreMemoryEvaluation(cases, observations)).toThrow('mixed cost currencies');
  });
});
