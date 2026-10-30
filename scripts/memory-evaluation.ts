import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecallFormatTrace } from '../core/memory/format.ts';
import type { MemorySearchTrace } from '../core/memory/hindsight.ts';

export interface MemoryEvaluationCase {
  id: string;
  answerable: boolean;
  requiredSourceIds: string[];
  deletedSourceIds?: string[];
  forbiddenSourceIds?: string[];
}

export interface MemoryEvaluationObservation {
  caseId: string;
  sourceIdsAt5: string[][];
  visibleSourceIds: string[];
  contextSourceIds: string[];
  deletedSourceIds?: string[];
  answerOutcome?: 'answered' | 'abstained';
  answerCorrect?: boolean;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
  costCurrency?: string;
  cpuMs?: number;
  peakMemoryBytes?: number;
}

export interface MemoryEvaluationRate {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface MemoryEvaluationScore {
  cases: number;
  answerableCases: number;
  noAnswerCases: number;
  sourceRecallAt5: MemoryEvaluationRate;
  completeEvidenceAt5: MemoryEvaluationRate;
  visibleComplete: MemoryEvaluationRate;
  contextComplete: MemoryEvaluationRate;
  answerAccuracy: MemoryEvaluationRate;
  noAnswerPrecision: MemoryEvaluationRate;
  noAnswerRecall: MemoryEvaluationRate;
  /** Case rates; denominator includes only cases with at least one forbidden source. */
  unrelatedHistoryAt5: MemoryEvaluationRate;
  unrelatedHistoryInContext: MemoryEvaluationRate;
  deleteLeak: MemoryEvaluationRate;
  latencyMs: { p50: number | null; p95: number | null; samples: number };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costMicros: number | null;
    costCurrency: string | null;
    cpuMs: number | null;
    peakMemoryBytes: number | null;
    samples: number;
  };
}

const ratio = (numerator: number, denominator: number): MemoryEvaluationRate => ({
  numerator,
  denominator,
  value: denominator > 0 ? numerator / denominator : null,
});

function percentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
}

export function observationFromRecallTrace(
  caseId: string,
  search: MemorySearchTrace,
  format: RecallFormatTrace,
  extras: Pick<MemoryEvaluationObservation, 'deletedSourceIds' | 'answerOutcome' | 'answerCorrect' | 'latencyMs' | 'inputTokens' | 'outputTokens' | 'costMicros' | 'costCurrency' | 'cpuMs' | 'peakMemoryBytes'> = {},
): MemoryEvaluationObservation {
  const visible = search.items.filter((item) => item.disposition === 'visible');
  const sourcesFor = (item: MemorySearchTrace['items'][number]): string[] => {
    if (item.verifiedSources.length > 0) return item.verifiedSources.map((source) => source.documentId);
    if (item.declaredSourceFactIds.length > 0 || item.sourceFactsIncomplete) return [];
    return item.parentDocumentId ? [item.parentDocumentId] : [];
  };
  return {
    caseId,
    sourceIdsAt5: visible.slice(0, 5).map(sourcesFor),
    visibleSourceIds: visible.flatMap(sourcesFor),
    contextSourceIds: [...format.includedSourceDocumentIds],
    ...extras,
  };
}

export function scoreMemoryEvaluation(
  cases: readonly MemoryEvaluationCase[],
  observations: readonly MemoryEvaluationObservation[],
): MemoryEvaluationScore {
  const casesById = new Map<string, MemoryEvaluationCase>();
  for (const testCase of cases) {
    if (!testCase.id || casesById.has(testCase.id)) throw new Error(`duplicate or empty evaluation case id: ${testCase.id}`);
    casesById.set(testCase.id, testCase);
  }
  const observationsById = new Map<string, MemoryEvaluationObservation>();
  for (const observation of observations) {
    if (!observation.caseId || observationsById.has(observation.caseId)) throw new Error(`duplicate or empty observation case id: ${observation.caseId}`);
    if (!casesById.has(observation.caseId)) throw new Error(`observation has no evaluation case: ${observation.caseId}`);
    observationsById.set(observation.caseId, observation);
  }
  for (const id of casesById.keys()) {
    if (!observationsById.has(id)) throw new Error(`evaluation case has no observation: ${id}`);
  }

  const answerable = cases.filter((testCase) => testCase.answerable && testCase.requiredSourceIds.length > 0);
  const noAnswer = cases.filter((testCase) => !testCase.answerable);
  let recallSum = 0;
  let completeAt5 = 0;
  let visibleComplete = 0;
  let contextComplete = 0;
  let answerCorrect = 0;
  let answerCount = 0;
  let noAnswerTruePositive = 0;
  let abstentionPredictions = 0;
  let unrelatedHistoryCases = 0;
  let unrelatedHistoryAt5 = 0;
  let unrelatedHistoryInContext = 0;
  let deletedCaseCount = 0;
  let deleteLeaks = 0;
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let cpuMs = 0;
  let inputTokenSamples = 0;
  let outputTokenSamples = 0;
  let costSamples = 0;
  let cpuSamples = 0;
  let peakMemoryBytes: number | null = null;
  let usageSamples = 0;
  const currencies = new Set<string>();

  for (const testCase of cases) {
    const observation = observationsById.get(testCase.id)!;
    const required = new Set(testCase.requiredSourceIds);
    const top5 = new Set(observation.sourceIdsAt5.slice(0, 5).flat());
    const visible = new Set(observation.visibleSourceIds);
    const context = new Set(observation.contextSourceIds);
    const forbidden = new Set(testCase.forbiddenSourceIds ?? []);
    if (forbidden.size > 0) {
      unrelatedHistoryCases += 1;
      if ([...forbidden].some((id) => top5.has(id))) unrelatedHistoryAt5 += 1;
      if ([...forbidden].some((id) => context.has(id))) unrelatedHistoryInContext += 1;
    }
    if (testCase.answerable && required.size > 0) {
      const found = [...required].filter((id) => top5.has(id)).length;
      recallSum += found / required.size;
      if (found === required.size) completeAt5 += 1;
      if ([...required].every((id) => visible.has(id))) visibleComplete += 1;
      if ([...required].every((id) => context.has(id))) contextComplete += 1;
    }
    if (observation.answerOutcome) {
      answerCount += 1;
      if (observation.answerCorrect === true) answerCorrect += 1;
      if (observation.answerOutcome === 'abstained') abstentionPredictions += 1;
    }
    if (!testCase.answerable && observation.answerOutcome) {
      if (observation.answerOutcome === 'abstained' && observation.answerCorrect === true) noAnswerTruePositive += 1;
    }
    const deleted = new Set([...(testCase.deletedSourceIds ?? []), ...(observation.deletedSourceIds ?? [])]);
    if (deleted.size > 0) {
      deletedCaseCount += 1;
      if ([...deleted].some((id) => visible.has(id) || context.has(id))) deleteLeaks += 1;
    }
    if (typeof observation.latencyMs === 'number' && Number.isFinite(observation.latencyMs) && observation.latencyMs >= 0) {
      latencies.push(observation.latencyMs);
    }
    const hasUsage = [observation.inputTokens, observation.outputTokens, observation.costMicros, observation.cpuMs, observation.peakMemoryBytes]
      .some((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (hasUsage) {
      usageSamples += 1;
      if (typeof observation.inputTokens === 'number' && Number.isFinite(observation.inputTokens) && observation.inputTokens >= 0) {
        inputTokens += observation.inputTokens;
        inputTokenSamples += 1;
      }
      if (typeof observation.outputTokens === 'number' && Number.isFinite(observation.outputTokens) && observation.outputTokens >= 0) {
        outputTokens += observation.outputTokens;
        outputTokenSamples += 1;
      }
      if (typeof observation.costMicros === 'number' && Number.isFinite(observation.costMicros) && observation.costMicros >= 0) {
        if (!observation.costCurrency?.trim()) throw new Error(`cost currency is missing for case: ${testCase.id}`);
        currencies.add(observation.costCurrency.trim().toUpperCase());
        costMicros += observation.costMicros;
        costSamples += 1;
      }
      if (typeof observation.cpuMs === 'number' && Number.isFinite(observation.cpuMs) && observation.cpuMs >= 0) {
        cpuMs += observation.cpuMs;
        cpuSamples += 1;
      }
      if (typeof observation.peakMemoryBytes === 'number' && Number.isFinite(observation.peakMemoryBytes) && observation.peakMemoryBytes >= 0) {
        peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, observation.peakMemoryBytes);
      }
    }
  }
  if (currencies.size > 1) throw new Error('evaluation contains mixed cost currencies');

  return {
    cases: cases.length,
    answerableCases: answerable.length,
    noAnswerCases: noAnswer.length,
    sourceRecallAt5: ratio(recallSum, answerable.length),
    completeEvidenceAt5: ratio(completeAt5, answerable.length),
    visibleComplete: ratio(visibleComplete, answerable.length),
    contextComplete: ratio(contextComplete, answerable.length),
    answerAccuracy: ratio(answerCorrect, answerCount),
    noAnswerPrecision: ratio(noAnswerTruePositive, abstentionPredictions),
    noAnswerRecall: ratio(noAnswerTruePositive, noAnswer.length),
    unrelatedHistoryAt5: ratio(unrelatedHistoryAt5, unrelatedHistoryCases),
    unrelatedHistoryInContext: ratio(unrelatedHistoryInContext, unrelatedHistoryCases),
    deleteLeak: ratio(deleteLeaks, deletedCaseCount),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), samples: latencies.length },
    usage: {
      inputTokens: inputTokenSamples > 0 ? inputTokens : null,
      outputTokens: outputTokenSamples > 0 ? outputTokens : null,
      costMicros: costSamples > 0 ? costMicros : null,
      costCurrency: costSamples > 0 ? [...currencies][0] ?? null : null,
      cpuMs: cpuSamples > 0 ? cpuMs : null,
      peakMemoryBytes,
      samples: usageSamples,
    },
  };
}

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

function runCli(): void {
  const [casesPath, observationsPath] = process.argv.slice(2);
  if (!casesPath || !observationsPath) {
    process.stderr.write('usage: tsx scripts/memory-evaluation.ts <cases.jsonl> <observations.jsonl>\n');
    process.exitCode = 2;
    return;
  }
  const cases = readJsonLines<MemoryEvaluationCase>(resolve(casesPath));
  const observations = readJsonLines<MemoryEvaluationObservation>(resolve(observationsPath));
  process.stdout.write(`${JSON.stringify(scoreMemoryEvaluation(cases, observations), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
