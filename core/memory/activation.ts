export const ACTIVATION_DAY_MS = 86_400_000;

export interface ActivationParameters {
  version: string;
  halfLifeDays: number;
  epsilon: number;
}

export const DEFAULT_ACTIVATION_PARAMETERS: Readonly<ActivationParameters> = Object.freeze({
  version: 'activation-v1',
  halfLifeDays: 100,
  epsilon: 0.001,
});

export interface ActivationAnchor {
  weight: number;
  at: string | number;
}

export type MentionSpacingBucket = 'initial' | 'same-turn' | 'same-day' | 'cross-day';

export interface ReinforcementParameters {
  version: string;
  initialWeight: number;
  defaultMentionIntensity: number;
  detailedMentionIntensity: number;
  extendedMentionIntensity: number;
  emphasizedMentionIntensity: number;
  detailedMentionUnits: number;
  extendedMentionUnits: number;
  minimumSemanticMatch: number;
  maxBoostPerMention: number;
  maxDailyBoost: number;
  maxDailyEvents: number;
  sameTurnWindowMs: number;
  sameTurnFactor: number;
  sameDayFactor: number;
  crossDayFactor: number;
  stabilityGrowthFactor: number;
  maxHalfLifeDays: number;
}

export const DEFAULT_REINFORCEMENT_PARAMETERS: Readonly<ReinforcementParameters> = Object.freeze({
  version: 'mention-v1',
  initialWeight: 0.8,
  defaultMentionIntensity: 0.06,
  detailedMentionIntensity: 0.12,
  extendedMentionIntensity: 0.2,
  emphasizedMentionIntensity: 0.35,
  detailedMentionUnits: 30,
  extendedMentionUnits: 80,
  minimumSemanticMatch: 0.75,
  maxBoostPerMention: 0.35,
  maxDailyBoost: 0.25,
  maxDailyEvents: 3,
  sameTurnWindowMs: 10 * 60_000,
  sameTurnFactor: 0.1,
  sameDayFactor: 0.5,
  crossDayFactor: 1,
  stabilityGrowthFactor: 0.25,
  maxHalfLifeDays: 365,
});

export interface ActivationState {
  anchorWeight: number;
  anchorAt: string;
  halfLifeDays: number;
  epsilon: number;
  paramsVersion: string;
  lastUserMentionAt: string | null;
  lastReinforcedAt: string | null;
  lastRetrievedAt: string | null;
  independentMentionCount: number;
  sourceEpoch: number;
  updatedAt: string;
}

export interface UserMentionEvidence {
  occurredAt: string | number;
  targetCreatedAt: string | number;
  semanticMatch: number;
  intensity: number;
}

export interface DailyReinforcementBudget {
  eventCount: number;
  appliedBoost: number;
}

export interface ReinforcementResult {
  state: ActivationState;
  spacingBucket: MentionSpacingBucket;
  boost: number;
  appliedBoost: number;
  outcome: 'applied' | 'daily-cap' | 'no-match';
}

function timestamp(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError('activation timestamp must be finite');
  return parsed;
}

function isoTimestamp(value: string | number): string {
  return new Date(timestamp(value)).toISOString();
}

function unit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be in the interval [0, 1]`);
  return value;
}

function validateReinforcementParameters(parameters: ReinforcementParameters): void {
  if (!parameters.version) throw new RangeError('reinforcement parameter version is required');
  unit(parameters.initialWeight, 'initial activation weight');
  unit(parameters.defaultMentionIntensity, 'default mention intensity');
  unit(parameters.detailedMentionIntensity, 'detailed mention intensity');
  unit(parameters.extendedMentionIntensity, 'extended mention intensity');
  unit(parameters.emphasizedMentionIntensity, 'emphasized mention intensity');
  unit(parameters.minimumSemanticMatch, 'minimum semantic match');
  if (!Number.isInteger(parameters.detailedMentionUnits) || parameters.detailedMentionUnits < 1
    || !Number.isInteger(parameters.extendedMentionUnits) || parameters.extendedMentionUnits <= parameters.detailedMentionUnits) {
    throw new RangeError('mention detail thresholds must be positive increasing integers');
  }
  unit(parameters.maxBoostPerMention, 'maximum mention boost');
  unit(parameters.maxDailyBoost, 'maximum daily boost');
  unit(parameters.sameTurnFactor, 'same-turn factor');
  unit(parameters.sameDayFactor, 'same-day factor');
  unit(parameters.crossDayFactor, 'cross-day factor');
  if (!Number.isInteger(parameters.maxDailyEvents) || parameters.maxDailyEvents < 1) {
    throw new RangeError('daily mention limit must be a positive integer');
  }
  if (!Number.isFinite(parameters.sameTurnWindowMs) || parameters.sameTurnWindowMs < 0 || parameters.sameTurnWindowMs >= ACTIVATION_DAY_MS) {
    throw new RangeError('same-turn window must be in [0, one day)');
  }
  if (!Number.isFinite(parameters.stabilityGrowthFactor) || parameters.stabilityGrowthFactor < 0) {
    throw new RangeError('stability growth factor must be nonnegative');
  }
  if (!Number.isFinite(parameters.maxHalfLifeDays) || parameters.maxHalfLifeDays <= 0) {
    throw new RangeError('maximum half-life must be greater than zero');
  }
}

/** Estimates user-event depth from the message shape; a semantic match is checked separately. */
export function mentionIntensityForText(
  text: string,
  parameters: ReinforcementParameters = DEFAULT_REINFORCEMENT_PARAMETERS,
): number {
  validateReinforcementParameters(parameters);
  const normalized = text.trim();
  if (/(?:以后|今后|总是|一直|每次|约定|非常重要|对我很重要|请记住|记住这个|记住我|别忘记|不要忘记)|\b(?:from now on|always|every time|please remember|remember this|don't forget|do not forget|keep this in mind|this is (?:very )?important)\b/i.test(normalized)) {
    return parameters.emphasizedMentionIntensity;
  }
  const units = (normalized.match(/[\p{Script=Han}]/gu)?.length ?? 0) + (normalized.match(/[a-z0-9]+/gi)?.length ?? 0);
  if (units >= parameters.extendedMentionUnits) return parameters.extendedMentionIntensity;
  if (units >= parameters.detailedMentionUnits) return parameters.detailedMentionIntensity;
  return parameters.defaultMentionIntensity;
}

function mentionSpacing(lastAt: string | null, occurredAt: number, parameters: ReinforcementParameters): MentionSpacingBucket {
  if (!lastAt) return 'initial';
  const elapsed = occurredAt - timestamp(lastAt);
  if (elapsed < 0) throw new RangeError('mention timestamp precedes the last accepted mention');
  if (elapsed < parameters.sameTurnWindowMs) return 'same-turn';
  if (elapsed < ACTIVATION_DAY_MS) return 'same-day';
  return 'cross-day';
}

/** Applies one already-verified user mention. Persistence supplies identity, fence and daily-budget checks. */
export function reinforceActivation(
  current: ActivationState | null,
  evidence: UserMentionEvidence,
  daily: DailyReinforcementBudget,
  decay: ActivationParameters = DEFAULT_ACTIVATION_PARAMETERS,
  parameters: ReinforcementParameters = DEFAULT_REINFORCEMENT_PARAMETERS,
): ReinforcementResult {
  validateReinforcementParameters(parameters);
  unit(evidence.semanticMatch, 'semantic match');
  unit(evidence.intensity, 'mention intensity');
  if (!Number.isInteger(daily.eventCount) || daily.eventCount < 0) throw new RangeError('daily event count must be a nonnegative integer');
  if (!Number.isFinite(daily.appliedBoost) || daily.appliedBoost < 0) throw new RangeError('daily applied boost must be nonnegative');
  const occurredAtMs = timestamp(evidence.occurredAt);
  const occurredAt = new Date(occurredAtMs).toISOString();
  const initial = current ?? {
    anchorWeight: parameters.initialWeight,
    anchorAt: isoTimestamp(evidence.targetCreatedAt),
    halfLifeDays: decay.halfLifeDays,
    epsilon: decay.epsilon,
    paramsVersion: `${decay.version}+${parameters.version}`,
    lastUserMentionAt: null,
    lastReinforcedAt: null,
    lastRetrievedAt: null,
    independentMentionCount: 0,
    sourceEpoch: 0,
    updatedAt: occurredAt,
  };
  const spacingBucket = mentionSpacing(initial.lastUserMentionAt, occurredAtMs, parameters);
  const currentWeight = activationAt(
    { weight: initial.anchorWeight, at: initial.anchorAt },
    occurredAtMs,
    { halfLifeDays: initial.halfLifeDays, epsilon: initial.epsilon },
  );
  const spacingFactor = spacingBucket === 'same-turn' ? parameters.sameTurnFactor
    : spacingBucket === 'same-day' ? parameters.sameDayFactor : parameters.crossDayFactor;
  const boost = Math.min(parameters.maxBoostPerMention, evidence.semanticMatch * evidence.intensity * spacingFactor);
  const remainingDailyBoost = Math.max(0, parameters.maxDailyBoost - daily.appliedBoost);
  const appliedBoost = daily.eventCount >= parameters.maxDailyEvents ? 0 : Math.min(boost, remainingDailyBoost);
  const outcome = appliedBoost > 0 ? 'applied'
    : daily.eventCount >= parameters.maxDailyEvents || remainingDailyBoost === 0 ? 'daily-cap' : 'no-match';
  const halfLifeDays = spacingBucket === 'cross-day' && appliedBoost > 0
    ? Math.max(initial.halfLifeDays, Math.min(parameters.maxHalfLifeDays, initial.halfLifeDays
      * (1 + parameters.stabilityGrowthFactor * evidence.semanticMatch * evidence.intensity)))
    : initial.halfLifeDays;
  const state: ActivationState = {
    ...initial,
    anchorWeight: appliedBoost > 0 ? Math.min(1, currentWeight + (1 - currentWeight) * appliedBoost) : initial.anchorWeight,
    anchorAt: appliedBoost > 0 ? occurredAt : initial.anchorAt,
    halfLifeDays,
    paramsVersion: `${decay.version}+${parameters.version}`,
    lastUserMentionAt: occurredAt,
    lastReinforcedAt: appliedBoost > 0 ? occurredAt : initial.lastReinforcedAt,
    independentMentionCount: initial.independentMentionCount + 1,
    updatedAt: occurredAt,
  };
  return { state, spacingBucket, boost, appliedBoost, outcome };
}

/** Computes a soft retrieval weight; it does not change a source, fact status or stored record. */
export function activationAt(
  anchor: ActivationAnchor,
  now: string | number,
  parameters: Pick<ActivationParameters, 'halfLifeDays' | 'epsilon'> = DEFAULT_ACTIVATION_PARAMETERS,
): number {
  if (!Number.isFinite(anchor.weight)) throw new RangeError('activation anchor weight must be finite');
  if (!Number.isFinite(parameters.halfLifeDays) || parameters.halfLifeDays <= 0) {
    throw new RangeError('activation half-life must be greater than zero');
  }
  if (!Number.isFinite(parameters.epsilon) || parameters.epsilon <= 0 || parameters.epsilon > 1) {
    throw new RangeError('activation floor must be in the interval (0, 1]');
  }
  const anchorAt = timestamp(anchor.at);
  const nowAt = timestamp(now);
  const anchorWeight = Math.min(1, Math.max(0, anchor.weight));
  const elapsedDays = Math.max(0, nowAt - anchorAt) / ACTIVATION_DAY_MS;
  const weight = anchorWeight * 2 ** (-elapsedDays / parameters.halfLifeDays);
  return Math.max(parameters.epsilon, Math.min(1, weight));
}
