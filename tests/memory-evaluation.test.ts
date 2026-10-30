import { describe, expect, it } from 'vitest';
import { observationFromRecallTrace, scoreMemoryEvaluation } from '../scripts/memory-evaluation.ts';
import { createDevelopmentMemoryEvaluationSet } from './fixtures/memory-evaluation.ts';

describe('memory evaluation contract', () => {
  it('builds a privacy-free development corpus with the specified counts', () => {
    const cases = createDevelopmentMemoryEvaluationSet();
    expect(cases).toHaveLength(250);
    expect(cases.filter((testCase) => testCase.answerable)).toHaveLength(200);
    expect(cases.filter((testCase) => !testCase.answerable)).toHaveLength(50);
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
      { id: 'c', answerable: false, requiredSourceIds: [], deletedSourceIds: ['src-deleted'] },
      { id: 'd', answerable: false, requiredSourceIds: [], deletedSourceIds: ['src-deleted-2'] },
    ];
    const observations = [
      { caseId: 'a', sourceIdsAt5: [['src-a']], visibleSourceIds: ['src-a'], contextSourceIds: ['src-a'], answerOutcome: 'abstained' as const, answerCorrect: false, latencyMs: 10, inputTokens: 10, outputTokens: 2, costMicros: 50, costCurrency: 'USD', cpuMs: 12, peakMemoryBytes: 1_000 },
      { caseId: 'b', sourceIdsAt5: [['src-x']], visibleSourceIds: ['src-x'], contextSourceIds: ['src-x'], answerOutcome: 'answered' as const, answerCorrect: true, latencyMs: 20, inputTokens: 20, outputTokens: 4, costMicros: 70, costCurrency: 'USD', cpuMs: 20, peakMemoryBytes: 1_500 },
      { caseId: 'c', sourceIdsAt5: [], visibleSourceIds: ['src-deleted'], contextSourceIds: ['src-deleted'], answerOutcome: 'answered' as const, answerCorrect: false, latencyMs: 30 },
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
    expect(score.deleteLeak).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.latencyMs).toEqual({ p50: 20, p95: 40, samples: 4 });
    expect(score.usage).toEqual({ inputTokens: 30, outputTokens: 6, costMicros: 120, costCurrency: 'USD', cpuMs: 32, peakMemoryBytes: 1_500, samples: 2 });
  });

  it('turns only verified evidence and final context sources into evaluation observations', () => {
    const observation = observationFromRecallTrace('case-a', {
      status: 'found',
      sourceFactsTruncated: false,
      candidateResultIds: ['observation', 'direct'],
      items: [
        {
          resultId: 'observation', parentDocumentId: 'doc-derived', declaredSourceFactIds: ['fact-a'],
          verifiedSources: [{ sourceFactId: 'fact-a', documentId: 'doc-a' }], disposition: 'visible', sourceFactsIncomplete: false,
        },
        {
          resultId: 'direct', parentDocumentId: 'doc-b', declaredSourceFactIds: [], verifiedSources: [],
          disposition: 'visible', sourceFactsIncomplete: false,
        },
      ],
    }, {
      inputResultIds: ['observation', 'direct'], includedResultIds: ['observation', 'direct'], omittedResultIds: [],
      deduplicatedResultIds: [], includedSourceDocumentIds: ['doc-a', 'doc-b'], omittedSourceDocumentIds: [],
      incompleteResultIds: [], clippedResultIds: [], clippedContextResultIds: [], clippedSourceFactIds: [],
      sourceFactsTruncated: false, maxChars: 2000, usedChars: 400,
    });

    expect(observation.sourceIdsAt5).toEqual([['doc-a'], ['doc-b']]);
    expect(observation.visibleSourceIds).toEqual(['doc-a', 'doc-b']);
    expect(observation.contextSourceIds).toEqual(['doc-a', 'doc-b']);
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
