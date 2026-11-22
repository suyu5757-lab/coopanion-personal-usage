import { createHash } from 'node:crypto';
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
  category?: string;
}

export interface MemoryEvaluationObservation {
  caseId: string;
  sourceIdsAt5: string[][];
  visibleSourceIds: string[];
  contextSourceIds: string[];
  deletedSourceIds?: string[];
  answerOutcome?: 'answered' | 'abstained';
  answerCorrect?: boolean;
  finalAnswer?: string;
  citationSourceIds?: string[];
  citationCorrect?: boolean;
  hallucinationDetected?: boolean;
  recallTrace?: { search: MemorySearchTrace; format: RecallFormatTrace };
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
  costCurrency?: string;
  cpuMs?: number;
  peakMemoryBytes?: number;
  sqliteDeltaBytes?: number;
  activationComputations?: number;
  activationStateRestored?: boolean;
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
  citationAccuracy: MemoryEvaluationRate;
  hallucinationRate: MemoryEvaluationRate;
  noAnswerPrecision: MemoryEvaluationRate;
  noAnswerRecall: MemoryEvaluationRate;
  /** Case rates; denominator includes only cases with at least one forbidden source. */
  unrelatedHistoryAt5: MemoryEvaluationRate;
  unrelatedHistoryInContext: MemoryEvaluationRate;
  deleteLeak: MemoryEvaluationRate;
  activationStateRestored: MemoryEvaluationRate;
  latencyMs: { p50: number | null; p95: number | null; samples: number };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costMicros: number | null;
    costCurrency: string | null;
    cpuMs: number | null;
    peakMemoryBytes: number | null;
    sqliteDeltaBytes: number | null;
    sqliteDeltaSamples: number;
    activationComputations: number | null;
    activationComputationSamples: number;
    samples: number;
  };
}

export interface MemoryEvaluationDelta {
  sourceRecallAt5: number | null;
  completeEvidenceAt5: number | null;
  visibleComplete: number | null;
  contextComplete: number | null;
  answerAccuracy: number | null;
  citationAccuracy: number | null;
  hallucinationRate: number | null;
  noAnswerPrecision: number | null;
  noAnswerRecall: number | null;
  unrelatedHistoryAt5: number | null;
  unrelatedHistoryInContext: number | null;
  deleteLeak: number | null;
  activationStateRestored: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  cpuMs: number | null;
  peakMemoryBytes: number | null;
  sqliteDeltaBytes: number | null;
  activationComputations: number | null;
}

export interface MemoryEvaluationComparison {
  baseline: MemoryEvaluationScore;
  activation: MemoryEvaluationScore;
  delta: MemoryEvaluationDelta;
  byCategory: Record<string, {
    baseline: MemoryEvaluationScore;
    activation: MemoryEvaluationScore;
    delta: MemoryEvaluationDelta;
  }>;
}

export interface MemoryEvaluationRun {
  runId: string;
  metadata: MemoryEvaluationRunMetadata;
  observations: readonly MemoryEvaluationObservation[];
}

export interface MemoryEvaluationRunMetadata {
  modelLabel: string;
  serviceLabel: string;
  codeRevision: string;
  datasetDigest: string;
  nonActivationConfigDigest: string;
  activationEnabled: boolean;
  activationInfluence: number;
  seed?: string | number;
}

export interface MemoryEvaluationRunObservation extends MemoryEvaluationObservation {
  runId: string;
  runMetadata: MemoryEvaluationRunMetadata;
}

export interface MemoryEvaluationMetricSpread {
  mean: number | null;
  sampleVariance: number | null;
  samples: number;
}

export interface MemoryEvaluationRepeatedComparison {
  runs: Array<{ runId: string; comparison: MemoryEvaluationComparison }>;
  baseline: Record<keyof MemoryEvaluationDelta, MemoryEvaluationMetricSpread>;
  activation: Record<keyof MemoryEvaluationDelta, MemoryEvaluationMetricSpread>;
  delta: Record<keyof MemoryEvaluationDelta, MemoryEvaluationMetricSpread>;
}

const ratio = (numerator: number, denominator: number): MemoryEvaluationRate => ({
  numerator,
  denominator,
  value: denominator > 0 ? numerator / denominator : null,
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function fingerprintMemoryEvaluationDataset(cases: readonly MemoryEvaluationCase[]): string {
  const ordered = [...cases].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return createHash('sha256').update(canonicalJson(ordered)).digest('hex');
}

function percentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
}

export function observationFromRecallTrace(
  caseId: string,
  search: MemorySearchTrace,
  format: RecallFormatTrace,
  extras: Pick<MemoryEvaluationObservation, 'deletedSourceIds' | 'answerOutcome' | 'answerCorrect' | 'finalAnswer' | 'citationSourceIds' | 'citationCorrect' | 'hallucinationDetected' | 'latencyMs' | 'inputTokens' | 'outputTokens' | 'costMicros' | 'costCurrency' | 'cpuMs' | 'peakMemoryBytes' | 'sqliteDeltaBytes' | 'activationComputations' | 'activationStateRestored'> = {},
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
    recallTrace: { search, format },
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
  let citationCorrect = 0;
  let citationCount = 0;
  let hallucinationCount = 0;
  let hallucinationLabeledCount = 0;
  let noAnswerTruePositive = 0;
  let abstentionPredictions = 0;
  let unrelatedHistoryCases = 0;
  let unrelatedHistoryAt5 = 0;
  let unrelatedHistoryInContext = 0;
  let deletedCaseCount = 0;
  let deleteLeaks = 0;
  let restartStateCases = 0;
  let restartStateRestored = 0;
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let cpuMs = 0;
  let sqliteDeltaBytes = 0;
  let activationComputations = 0;
  let inputTokenSamples = 0;
  let outputTokenSamples = 0;
  let costSamples = 0;
  let cpuSamples = 0;
  let sqliteDeltaSamples = 0;
  let activationComputationSamples = 0;
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
    if (typeof observation.citationCorrect === 'boolean') {
      citationCount += 1;
      if (observation.citationCorrect) citationCorrect += 1;
    }
    if (typeof observation.hallucinationDetected === 'boolean') {
      hallucinationLabeledCount += 1;
      if (observation.hallucinationDetected) hallucinationCount += 1;
    }
    if (!testCase.answerable && observation.answerOutcome) {
      if (observation.answerOutcome === 'abstained' && observation.answerCorrect === true) noAnswerTruePositive += 1;
    }
    const deleted = new Set([...(testCase.deletedSourceIds ?? []), ...(observation.deletedSourceIds ?? [])]);
    if (deleted.size > 0) {
      deletedCaseCount += 1;
      if ([...deleted].some((id) => visible.has(id) || context.has(id))) deleteLeaks += 1;
    }
    if (typeof observation.activationStateRestored === 'boolean') {
      restartStateCases += 1;
      if (observation.activationStateRestored) restartStateRestored += 1;
    }
    if (typeof observation.latencyMs === 'number' && Number.isFinite(observation.latencyMs) && observation.latencyMs >= 0) {
      latencies.push(observation.latencyMs);
    }
    const hasUsage = [observation.inputTokens, observation.outputTokens, observation.costMicros, observation.cpuMs, observation.peakMemoryBytes, observation.activationComputations]
      .some((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const hasSqliteDelta = typeof observation.sqliteDeltaBytes === 'number' && Number.isFinite(observation.sqliteDeltaBytes);
    if (hasUsage || hasSqliteDelta) {
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
      if (hasSqliteDelta) {
        sqliteDeltaBytes += observation.sqliteDeltaBytes!;
        sqliteDeltaSamples += 1;
      }
      if (typeof observation.activationComputations === 'number' && Number.isFinite(observation.activationComputations) && observation.activationComputations >= 0) {
        activationComputations += observation.activationComputations;
        activationComputationSamples += 1;
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
    citationAccuracy: ratio(citationCorrect, citationCount),
    hallucinationRate: ratio(hallucinationCount, hallucinationLabeledCount),
    noAnswerPrecision: ratio(noAnswerTruePositive, abstentionPredictions),
    noAnswerRecall: ratio(noAnswerTruePositive, noAnswer.length),
    unrelatedHistoryAt5: ratio(unrelatedHistoryAt5, unrelatedHistoryCases),
    unrelatedHistoryInContext: ratio(unrelatedHistoryInContext, unrelatedHistoryCases),
    deleteLeak: ratio(deleteLeaks, deletedCaseCount),
    activationStateRestored: ratio(restartStateRestored, restartStateCases),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), samples: latencies.length },
    usage: {
      inputTokens: inputTokenSamples > 0 ? inputTokens : null,
      outputTokens: outputTokenSamples > 0 ? outputTokens : null,
      costMicros: costSamples > 0 ? costMicros : null,
      costCurrency: costSamples > 0 ? [...currencies][0] ?? null : null,
      cpuMs: cpuSamples > 0 ? cpuMs : null,
      peakMemoryBytes,
      sqliteDeltaBytes: sqliteDeltaSamples > 0 ? sqliteDeltaBytes : null,
      sqliteDeltaSamples,
      activationComputations: activationComputationSamples > 0 ? activationComputations : null,
      activationComputationSamples,
      samples: usageSamples,
    },
  };
}

function delta(current: number | null, baseline: number | null): number | null {
  return current === null || baseline === null ? null : current - baseline;
}

function compareScores(baseline: MemoryEvaluationScore, activation: MemoryEvaluationScore): MemoryEvaluationDelta {
  return {
    sourceRecallAt5: delta(activation.sourceRecallAt5.value, baseline.sourceRecallAt5.value),
    completeEvidenceAt5: delta(activation.completeEvidenceAt5.value, baseline.completeEvidenceAt5.value),
    visibleComplete: delta(activation.visibleComplete.value, baseline.visibleComplete.value),
    contextComplete: delta(activation.contextComplete.value, baseline.contextComplete.value),
    answerAccuracy: delta(activation.answerAccuracy.value, baseline.answerAccuracy.value),
    citationAccuracy: delta(activation.citationAccuracy.value, baseline.citationAccuracy.value),
    hallucinationRate: delta(activation.hallucinationRate.value, baseline.hallucinationRate.value),
    noAnswerPrecision: delta(activation.noAnswerPrecision.value, baseline.noAnswerPrecision.value),
    noAnswerRecall: delta(activation.noAnswerRecall.value, baseline.noAnswerRecall.value),
    unrelatedHistoryAt5: delta(activation.unrelatedHistoryAt5.value, baseline.unrelatedHistoryAt5.value),
    unrelatedHistoryInContext: delta(activation.unrelatedHistoryInContext.value, baseline.unrelatedHistoryInContext.value),
    deleteLeak: delta(activation.deleteLeak.value, baseline.deleteLeak.value),
    activationStateRestored: delta(activation.activationStateRestored.value, baseline.activationStateRestored.value),
    p50LatencyMs: delta(activation.latencyMs.p50, baseline.latencyMs.p50),
    p95LatencyMs: delta(activation.latencyMs.p95, baseline.latencyMs.p95),
    inputTokens: delta(activation.usage.inputTokens, baseline.usage.inputTokens),
    outputTokens: delta(activation.usage.outputTokens, baseline.usage.outputTokens),
    costMicros: delta(activation.usage.costMicros, baseline.usage.costMicros),
    cpuMs: delta(activation.usage.cpuMs, baseline.usage.cpuMs),
    peakMemoryBytes: delta(activation.usage.peakMemoryBytes, baseline.usage.peakMemoryBytes),
    sqliteDeltaBytes: delta(activation.usage.sqliteDeltaBytes, baseline.usage.sqliteDeltaBytes),
    activationComputations: delta(activation.usage.activationComputations, baseline.usage.activationComputations),
  };
}

export function compareMemoryEvaluations(
  cases: readonly MemoryEvaluationCase[],
  baselineObservations: readonly MemoryEvaluationObservation[],
  activationObservations: readonly MemoryEvaluationObservation[],
): MemoryEvaluationComparison {
  const baseline = scoreMemoryEvaluation(cases, baselineObservations);
  const activation = scoreMemoryEvaluation(cases, activationObservations);
  const baselineCurrency = baseline.usage.costCurrency;
  const activationCurrency = activation.usage.costCurrency;
  if (baselineCurrency && activationCurrency && baselineCurrency !== activationCurrency) {
    throw new Error('paired evaluation contains different cost currencies');
  }
  const categories = new Map<string, MemoryEvaluationCase[]>();
  for (const testCase of cases) {
    const category = testCase.category?.trim() || 'uncategorized';
    const grouped = categories.get(category) ?? [];
    grouped.push(testCase);
    categories.set(category, grouped);
  }
  const byCategory = Object.fromEntries([...categories].map(([category, group]) => {
    const ids = new Set(group.map((testCase) => testCase.id));
    const categoryBaseline = scoreMemoryEvaluation(group, baselineObservations.filter((item) => ids.has(item.caseId)));
    const categoryActivation = scoreMemoryEvaluation(group, activationObservations.filter((item) => ids.has(item.caseId)));
    return [category, {
      baseline: categoryBaseline,
      activation: categoryActivation,
      delta: compareScores(categoryBaseline, categoryActivation),
    }];
  }));
  return {
    baseline,
    activation,
    delta: compareScores(baseline, activation),
    byCategory,
  };
}

function scoreMetrics(score: MemoryEvaluationScore): Record<keyof MemoryEvaluationDelta, number | null> {
  return {
    sourceRecallAt5: score.sourceRecallAt5.value,
    completeEvidenceAt5: score.completeEvidenceAt5.value,
    visibleComplete: score.visibleComplete.value,
    contextComplete: score.contextComplete.value,
    answerAccuracy: score.answerAccuracy.value,
    citationAccuracy: score.citationAccuracy.value,
    hallucinationRate: score.hallucinationRate.value,
    noAnswerPrecision: score.noAnswerPrecision.value,
    noAnswerRecall: score.noAnswerRecall.value,
    unrelatedHistoryAt5: score.unrelatedHistoryAt5.value,
    unrelatedHistoryInContext: score.unrelatedHistoryInContext.value,
    deleteLeak: score.deleteLeak.value,
    activationStateRestored: score.activationStateRestored.value,
    p50LatencyMs: score.latencyMs.p50,
    p95LatencyMs: score.latencyMs.p95,
    inputTokens: score.usage.inputTokens,
    outputTokens: score.usage.outputTokens,
    costMicros: score.usage.costMicros,
    cpuMs: score.usage.cpuMs,
    peakMemoryBytes: score.usage.peakMemoryBytes,
    sqliteDeltaBytes: score.usage.sqliteDeltaBytes,
    activationComputations: score.usage.activationComputations,
  };
}

function metricSpread(values: readonly (number | null)[]): MemoryEvaluationMetricSpread {
  const samples = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (samples.length === 0) return { mean: null, sampleVariance: null, samples: 0 };
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const squaredError = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return {
    mean,
    sampleVariance: samples.length > 1 ? squaredError / (samples.length - 1) : null,
    samples: samples.length,
  };
}

function summarizeMetricRows(
  rows: readonly Record<keyof MemoryEvaluationDelta, number | null>[],
): Record<keyof MemoryEvaluationDelta, MemoryEvaluationMetricSpread> {
  const keys = Object.keys(rows[0] ?? {}) as Array<keyof MemoryEvaluationDelta>;
  return Object.fromEntries(keys.map((key) => [key, metricSpread(rows.map((row) => row[key]))])) as Record<keyof MemoryEvaluationDelta, MemoryEvaluationMetricSpread>;
}

export function compareMemoryEvaluationRepeats(
  cases: readonly MemoryEvaluationCase[],
  baselineRuns: readonly MemoryEvaluationRun[],
  activationRuns: readonly MemoryEvaluationRun[],
): MemoryEvaluationRepeatedComparison {
  if (baselineRuns.length === 0 || activationRuns.length === 0) throw new Error('paired evaluation requires at least one run');
  const datasetDigest = fingerprintMemoryEvaluationDataset(cases);
  const runMap = (runs: readonly MemoryEvaluationRun[], condition: string) => {
    const map = new Map<string, MemoryEvaluationRun>();
    for (const run of runs) {
      const id = run.runId.trim();
      if (!id || map.has(id)) throw new Error(`${condition} evaluation has a duplicate or empty run ID: ${run.runId}`);
      const metadata = run.metadata;
      if (!metadata || typeof metadata !== 'object') throw new Error(`${condition} evaluation run has incomplete metadata: ${id}`);
      const { modelLabel, serviceLabel, codeRevision, datasetDigest: runDatasetDigest, nonActivationConfigDigest, activationEnabled, activationInfluence } = metadata;
      if (![modelLabel, serviceLabel, codeRevision, runDatasetDigest, nonActivationConfigDigest]
        .every((value) => typeof value === 'string' && value.trim().length > 0)) {
        throw new Error(`${condition} evaluation run has incomplete metadata: ${id}`);
      }
      if (runDatasetDigest !== datasetDigest) throw new Error(`${condition} evaluation dataset digest does not match the cases: ${id}`);
      if (typeof activationEnabled !== 'boolean') throw new Error(`${condition} evaluation run has an invalid activation flag: ${id}`);
      if (!Number.isFinite(activationInfluence) || activationInfluence < 0 || activationInfluence > 1) {
        throw new Error(`${condition} evaluation run has an invalid activation influence: ${id}`);
      }
      if (metadata.seed !== undefined && typeof metadata.seed !== 'string' && typeof metadata.seed !== 'number') {
        throw new Error(`${condition} evaluation run has an invalid seed: ${id}`);
      }
      if (typeof metadata.seed === 'string' && !metadata.seed.trim()) throw new Error(`${condition} evaluation run has an empty seed: ${id}`);
      if (typeof metadata.seed === 'number' && !Number.isFinite(metadata.seed)) throw new Error(`${condition} evaluation run has an invalid seed: ${id}`);
      map.set(id, run);
    }
    return map;
  };
  const baselineById = runMap(baselineRuns, 'baseline');
  const activationById = runMap(activationRuns, 'activation');
  if (baselineById.size !== activationById.size || [...baselineById.keys()].some((id) => !activationById.has(id))) {
    throw new Error('baseline and activation evaluations do not contain the same run IDs');
  }
  const commonSignature = (metadata: MemoryEvaluationRunMetadata) => canonicalJson({
    modelLabel: metadata.modelLabel,
    serviceLabel: metadata.serviceLabel,
    codeRevision: metadata.codeRevision,
    datasetDigest: metadata.datasetDigest,
    nonActivationConfigDigest: metadata.nonActivationConfigDigest,
  });
  const allMetadata = [...baselineById.values(), ...activationById.values()].map((run) => run.metadata);
  if (new Set(allMetadata.map(commonSignature)).size !== 1) {
    throw new Error('paired evaluation changed the model, service, code, dataset or non-activation configuration');
  }
  const baselineInfluences = new Set([...baselineById.values()].map((run) => run.metadata.activationInfluence));
  const activationInfluences = new Set([...activationById.values()].map((run) => run.metadata.activationInfluence));
  const baselineActivation = new Set([...baselineById.values()].map((run) => run.metadata.activationEnabled));
  const activeActivation = new Set([...activationById.values()].map((run) => run.metadata.activationEnabled));
  if (baselineActivation.size !== 1 || !baselineActivation.has(false) || baselineInfluences.size !== 1 || !baselineInfluences.has(0)) {
    throw new Error('baseline evaluation must disable activation and use influence 0 for every run');
  }
  if (activeActivation.size !== 1 || !activeActivation.has(true) || activationInfluences.size !== 1 || [...activationInfluences][0] === 0) {
    throw new Error('activation evaluation must enable activation with one nonzero influence for every run');
  }
  for (const [runId, baseline] of baselineById) {
    if (baseline.metadata.seed !== activationById.get(runId)!.metadata.seed) {
      throw new Error(`paired evaluation run has different seeds: ${runId}`);
    }
  }
  const runs = [...baselineById].map(([runId, baseline]) => ({
    runId,
    comparison: compareMemoryEvaluations(cases, baseline.observations, activationById.get(runId)!.observations),
  }));
  return {
    runs,
    baseline: summarizeMetricRows(runs.map(({ comparison }) => scoreMetrics(comparison.baseline))),
    activation: summarizeMetricRows(runs.map(({ comparison }) => scoreMetrics(comparison.activation))),
    delta: summarizeMetricRows(runs.map(({ comparison }) => comparison.delta)),
  };
}

export function groupMemoryEvaluationRunRows(rows: readonly MemoryEvaluationRunObservation[]): MemoryEvaluationRun[] {
  const runs = new Map<string, { metadata: MemoryEvaluationRunMetadata; observations: MemoryEvaluationObservation[] }>();
  for (const row of rows) {
    const runId = row.runId.trim();
    if (!runId) throw new Error('evaluation observation has an empty run ID');
    const run = runs.get(runId);
    if (run && canonicalJson(run.metadata) !== canonicalJson(row.runMetadata)) {
      throw new Error(`evaluation run metadata changes between observations: ${runId}`);
    }
    const metadata = run?.metadata ?? row.runMetadata;
    const observations = run?.observations ?? [];
    const { runId: _runId, runMetadata: _runMetadata, ...observation } = row;
    observations.push(observation);
    runs.set(runId, { metadata, observations });
  }
  return [...runs].map(([runId, run]) => ({ runId, ...run }));
}

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

function runCli(): void {
  const args = process.argv.slice(2);
  const [casesPath, observationsPath, activationObservationsPath] = args;
  if (!casesPath || !observationsPath) {
    process.stderr.write('usage: tsx scripts/memory-evaluation.ts <cases.jsonl> <baseline.jsonl> [activation.jsonl]\n');
    process.stderr.write('   or: tsx scripts/memory-evaluation.ts <cases.jsonl> --repeats <baseline-runs.jsonl> <activation-runs.jsonl>\n');
    process.exitCode = 2;
    return;
  }
  const cases = readJsonLines<MemoryEvaluationCase>(resolve(casesPath));
  if (observationsPath === '--repeats') {
    if (!activationObservationsPath || args.length !== 4) {
      process.stderr.write('usage: tsx scripts/memory-evaluation.ts <cases.jsonl> --repeats <baseline-runs.jsonl> <activation-runs.jsonl>\n');
      process.exitCode = 2;
      return;
    }
    const baselineRuns = groupMemoryEvaluationRunRows(readJsonLines<MemoryEvaluationRunObservation>(resolve(args[2]!)));
    const activationRuns = groupMemoryEvaluationRunRows(readJsonLines<MemoryEvaluationRunObservation>(resolve(args[3]!)));
    process.stdout.write(`${JSON.stringify(compareMemoryEvaluationRepeats(cases, baselineRuns, activationRuns), null, 2)}\n`);
    return;
  }
  const baseline = readJsonLines<MemoryEvaluationObservation>(resolve(observationsPath));
  const result = activationObservationsPath
    ? compareMemoryEvaluations(cases, baseline, readJsonLines<MemoryEvaluationObservation>(resolve(activationObservationsPath)))
    : scoreMemoryEvaluation(cases, baseline);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
