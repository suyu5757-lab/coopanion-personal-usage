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

function timestamp(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError('activation timestamp must be finite');
  return parsed;
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
