import { describe, expect, it } from 'vitest';
import { activationAt } from '../core/memory/activation.ts';
import { DEFAULT_ACTIVATION_RANK_INFLUENCE, formatRecallDetailed, type FormattedRecallResult } from '../core/memory/format.ts';
import { compareMemoryEvaluationRepeats, compareMemoryEvaluations, fingerprintMemoryEvaluationDataset, groupMemoryEvaluationRunRows, observationFromRecallTrace, scoreMemoryEvaluation } from '../scripts/memory-evaluation.ts';
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
      { caseId: 'a', sourceIdsAt5: [['src-a']], visibleSourceIds: ['src-a'], contextSourceIds: ['src-a'], answerOutcome: 'abstained' as const, answerCorrect: false, citationCorrect: false, hallucinationDetected: true, latencyMs: 10, inputTokens: 10, outputTokens: 2, costMicros: 50, costCurrency: 'USD', cpuMs: 12, peakMemoryBytes: 1_000, sqliteDeltaBytes: 600, activationComputations: 2, activationStateRestored: true },
      { caseId: 'b', sourceIdsAt5: [['src-x']], visibleSourceIds: ['src-x'], contextSourceIds: ['src-x'], answerOutcome: 'answered' as const, answerCorrect: true, citationCorrect: true, hallucinationDetected: false, latencyMs: 20, inputTokens: 20, outputTokens: 4, costMicros: 70, costCurrency: 'USD', cpuMs: 20, peakMemoryBytes: 1_500, sqliteDeltaBytes: -100, activationComputations: 3, activationStateRestored: false },
      { caseId: 'c', sourceIdsAt5: [['src-deleted']], visibleSourceIds: ['src-deleted'], contextSourceIds: ['src-deleted'], answerOutcome: 'answered' as const, answerCorrect: false, latencyMs: 30, activationStateRestored: true },
      { caseId: 'd', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [], answerOutcome: 'abstained' as const, answerCorrect: true, latencyMs: 40 },
    ];

    const score = scoreMemoryEvaluation(cases, observations);

    expect(score.sourceRecallAt5).toEqual({ numerator: 1.5, denominator: 2, value: 0.75 });
    expect(score.completeEvidenceAt5).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.visibleComplete).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.contextComplete).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.answerAccuracy).toEqual({ numerator: 2, denominator: 4, value: 0.5 });
    expect(score.citationAccuracy).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.hallucinationRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.noAnswerPrecision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.noAnswerRecall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.unrelatedHistoryAt5).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.unrelatedHistoryInContext).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.deleteLeak).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(score.activationStateRestored).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(score.latencyMs).toEqual({ p50: 20, p95: 40, samples: 4 });
    expect(score.usage).toEqual({ inputTokens: 30, outputTokens: 6, costMicros: 120, costCurrency: 'USD', cpuMs: 32, peakMemoryBytes: 1_500, sqliteDeltaBytes: 500, sqliteDeltaSamples: 2, activationComputations: 5, activationComputationSamples: 2, samples: 2 });
  });

  it('reports an unavailable cross-restart metric when no case records it', () => {
    const score = scoreMemoryEvaluation(
      [{ id: 'case-a', answerable: true, requiredSourceIds: ['src-a'] }],
      [{ caseId: 'case-a', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [] }],
    );

    expect(score.activationStateRestored).toEqual({ numerator: 0, denominator: 0, value: null });
  });

  it('pairs repeated runs by ID and reports sample variance without counting retries as cases', () => {
    const cases = [
      { id: 'answer', answerable: true, requiredSourceIds: ['src-a'] },
      { id: 'no-answer', answerable: false, requiredSourceIds: [] },
    ];
    const observations = (found: boolean) => [
      { caseId: 'answer', sourceIdsAt5: found ? [['src-a']] : [], visibleSourceIds: found ? ['src-a'] : [], contextSourceIds: found ? ['src-a'] : [] },
      { caseId: 'no-answer', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [] },
    ];
    const datasetDigest = fingerprintMemoryEvaluationDataset(cases);
    const metadata = (activationInfluence: number, seed: string) => ({
      modelLabel: 'test-model',
      serviceLabel: 'loopback-service',
      codeRevision: 'test-revision',
      datasetDigest,
      nonActivationConfigDigest: 'test-settings',
      activationEnabled: activationInfluence > 0,
      activationInfluence,
      seed,
    });
    expect(fingerprintMemoryEvaluationDataset([...cases].reverse())).toBe(datasetDigest);

    const result = compareMemoryEvaluationRepeats(cases, [
      { runId: 'seed-1', metadata: metadata(0, 'seed-1'), observations: observations(false) },
      { runId: 'seed-2', metadata: metadata(0, 'seed-2'), observations: observations(true) },
    ], [
      { runId: 'seed-2', metadata: metadata(0.25, 'seed-2'), observations: observations(false) },
      { runId: 'seed-1', metadata: metadata(0.25, 'seed-1'), observations: observations(true) },
    ]);

    expect(result.runs.map((run) => run.runId)).toEqual(['seed-1', 'seed-2']);
    expect(result.baseline.sourceRecallAt5).toEqual({ mean: 0.5, sampleVariance: 0.5, samples: 2 });
    expect(result.activation.sourceRecallAt5).toEqual({ mean: 0.5, sampleVariance: 0.5, samples: 2 });
    expect(result.delta.sourceRecallAt5).toEqual({ mean: 0, sampleVariance: 2, samples: 2 });
    expect(groupMemoryEvaluationRunRows([
      { runId: 'seed-2', runMetadata: metadata(0.25, 'seed-2'), ...observations(false)[0]! },
      { runId: 'seed-1', runMetadata: metadata(0.25, 'seed-1'), ...observations(true)[0]! },
    ]).map((run) => run.runId)).toEqual(['seed-2', 'seed-1']);
    expect(() => groupMemoryEvaluationRunRows([{ runId: ' ', runMetadata: metadata(0, 'seed-1'), ...observations(false)[0]! }])).toThrow('empty run ID');
    expect(() => compareMemoryEvaluationRepeats(cases, [{ runId: 'seed-1', metadata: metadata(0, 'seed-1'), observations: observations(false) }], [])).toThrow('at least one run');
    expect(() => compareMemoryEvaluationRepeats(cases, [{ runId: 'seed-1', metadata: metadata(0, 'seed-1'), observations: observations(false) }], [{ runId: 'seed-2', metadata: metadata(0.25, 'seed-2'), observations: observations(true) }])).toThrow('same run IDs');
    expect(() => compareMemoryEvaluationRepeats(cases, [
      { runId: 'seed-1', metadata: { ...metadata(0, 'seed-1'), datasetDigest: 'different' }, observations: observations(false) },
    ], [{ runId: 'seed-1', metadata: metadata(0.25, 'seed-1'), observations: observations(true) }])).toThrow('dataset digest');
  });

  it('compares paired conditions and reports unrelated-history changes separately', () => {
    const cases = [
      { id: 'answer', answerable: true, requiredSourceIds: ['src-good'], forbiddenSourceIds: ['src-bad'], category: 'single_fact' },
      { id: 'no-answer', answerable: false, requiredSourceIds: [], forbiddenSourceIds: ['src-unrelated'], category: 'no_answer' },
    ];
    const baseline = [
      { caseId: 'answer', sourceIdsAt5: [['src-good'], ['src-bad']], visibleSourceIds: ['src-good', 'src-bad'], contextSourceIds: ['src-good', 'src-bad'], answerOutcome: 'answered' as const, answerCorrect: true, citationCorrect: false, hallucinationDetected: true, activationStateRestored: false, sqliteDeltaBytes: 30, activationComputations: 3 },
      { caseId: 'no-answer', sourceIdsAt5: [], visibleSourceIds: ['src-unrelated'], contextSourceIds: [], answerOutcome: 'answered' as const, answerCorrect: false, citationCorrect: false, hallucinationDetected: false, activationStateRestored: false, sqliteDeltaBytes: 10, activationComputations: 2 },
    ];
    const activation = [
      { caseId: 'answer', sourceIdsAt5: [['src-good']], visibleSourceIds: ['src-good'], contextSourceIds: ['src-good'], answerOutcome: 'answered' as const, answerCorrect: true, citationCorrect: true, hallucinationDetected: false, activationStateRestored: true, sqliteDeltaBytes: 60, activationComputations: 6 },
      { caseId: 'no-answer', sourceIdsAt5: [], visibleSourceIds: [], contextSourceIds: [], answerOutcome: 'abstained' as const, answerCorrect: true, citationCorrect: true, hallucinationDetected: false, activationStateRestored: true, sqliteDeltaBytes: 20, activationComputations: 4 },
    ];

    const comparison = compareMemoryEvaluations(cases, baseline, activation);

    expect(comparison.delta.unrelatedHistoryAt5).toBe(-0.5);
    expect(comparison.delta.unrelatedHistoryInContext).toBe(-0.5);
    expect(comparison.delta.answerAccuracy).toBe(0.5);
    expect(comparison.delta.citationAccuracy).toBe(1);
    expect(comparison.delta.hallucinationRate).toBe(-0.5);
    expect(comparison.delta.activationStateRestored).toBe(1);
    expect(comparison.delta.sqliteDeltaBytes).toBe(40);
    expect(comparison.delta.activationComputations).toBe(5);
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
      sourceFactsTruncated: false, coverageWeight: 0.5, activationInfluence: DEFAULT_ACTIVATION_RANK_INFLUENCE, activationWeights: [], maxChars: 2000, usedChars: 400,
    }, { finalAnswer: 'doc-a and doc-b support the answer.', citationSourceIds: ['doc-a', 'doc-b'], citationCorrect: true, hallucinationDetected: false, sqliteDeltaBytes: 24, activationComputations: 3, activationStateRestored: true });

    expect(observation.sourceIdsAt5).toEqual([['doc-a'], ['doc-b']]);
    expect(observation.visibleSourceIds).toEqual(['doc-a', 'doc-b']);
    expect(observation.contextSourceIds).toEqual(['doc-a', 'doc-b']);
    expect(observation.sqliteDeltaBytes).toBe(24);
    expect(observation.activationComputations).toBe(3);
    expect(observation.activationStateRestored).toBe(true);
    expect(observation.recallTrace?.search.candidateResultIds).toEqual(['observation', 'direct']);
    expect(observation.recallTrace?.search.items[0]?.verifiedSources).toEqual([{ sourceFactId: 'fact-a', documentId: 'doc-a' }]);
    expect(observation.recallTrace?.format.includedSourceDocumentIds).toEqual(['doc-a', 'doc-b']);
    expect(observation.finalAnswer).toBe('doc-a and doc-b support the answer.');
    expect(observation.citationSourceIds).toEqual(['doc-a', 'doc-b']);
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

  it('does not let activation reduce multi-hop coverage under duplicate-result pressure', () => {
    const cases = createDevelopmentMemoryEvaluationSet();
    const now = Date.UTC(2026, 9, 31);
    const age = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const run = (activationInfluence: number) => cases.map((testCase) => {
      const documents = testCase.documents.filter((document) => document.state !== 'deleted');
      const results: FormattedRecallResult[] = [];
      for (const [index, document] of documents.entries()) {
        const isForbidden = testCase.forbiddenSourceIds?.includes(document.sourceId) ?? false;
        const isFirstRequired = testCase.requiredSourceIds[0] === document.sourceId;
        const anchorAt = isFirstRequired || (isForbidden && document.state === 'current') ? age(0) : age(400);
        const activationWeight = document.state === 'current'
          ? activationAt({ weight: anchorAt === age(0) ? 1 : 0.8, at: anchorAt }, now)
          : undefined;
        results.push({
          id: `${testCase.id}-source-${index}`,
          text: document.text,
          type: 'world',
          document_id: document.sourceId,
          metadata: { status: document.state },
          activationWeight,
        });
        if (index === 0) {
          for (let repeat = 1; repeat <= 3; repeat += 1) {
            results.push({
              id: `${testCase.id}-repeat-${repeat}`,
              text: `${document.text} Repeated retrieval record ${repeat}.`,
              type: 'observation',
              document_id: document.sourceId,
              metadata: { status: document.state },
              activationWeight,
            });
          }
        }
      }
      const formatted = formatRecallDetailed(results, { maxItems: 2, activationInfluence });
      return {
        caseId: testCase.id,
        sourceIdsAt5: results.slice(0, 5).map((result) => [result.document_id!]),
        visibleSourceIds: [...new Set(results.map((result) => result.document_id!))],
        contextSourceIds: formatted.trace.includedSourceDocumentIds,
      };
    });
    const comparison = compareMemoryEvaluations(cases, run(0), run(DEFAULT_ACTIVATION_RANK_INFLUENCE));

    expect(comparison.baseline.contextComplete).toEqual({ numerator: 200, denominator: 200, value: 1 });
    expect(comparison.activation.contextComplete).toEqual({ numerator: 200, denominator: 200, value: 1 });
    expect(comparison.delta.contextComplete).toBeGreaterThanOrEqual(-0.02);
    expect(comparison.byCategory.multi_hop?.baseline.contextComplete.value).toBe(1);
    expect(comparison.byCategory.multi_hop?.activation.contextComplete.value).toBe(1);
  });

  it('compares disabled and default activation influence in the same recall formatter', () => {
    const results: FormattedRecallResult[] = [
      { id: 'active-a', text: 'A result from source A.', type: 'world', document_id: 'doc-a', activationWeight: 0.05 },
      { id: 'active-a-repeat', text: 'A second result from source A.', type: 'world', document_id: 'doc-a', activationWeight: 0.05 },
      { id: 'direct-b', text: 'A direct result from a second required source.', type: 'world', document_id: 'doc-b', activationWeight: 1 },
    ];
    const baseline = formatRecallDetailed(results, { maxItems: 2, coverageWeight: 0, activationInfluence: 0 });
    const activation = formatRecallDetailed(results, { maxItems: 2, coverageWeight: 0 });

    expect(baseline.trace.includedResultIds).toEqual(['active-a', 'active-a-repeat']);
    expect(activation.trace.includedResultIds).toEqual(['active-a', 'direct-b']);
    expect(baseline.trace.activationInfluence).toBe(0);
    expect(activation.trace.activationInfluence).toBe(DEFAULT_ACTIVATION_RANK_INFLUENCE);
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
