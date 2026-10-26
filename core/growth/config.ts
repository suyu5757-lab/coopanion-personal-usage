/** `companion.growth`: whether Coo reviews herself on a schedule, and how often. */
import { getByPath } from 'cortico/core/config-schema.ts';

export interface GrowthConfig {
  enabled: boolean;
  /** Days between self-reviews. */
  everyDays: number;
}

export const GROWTH_DEFAULTS: GrowthConfig = {
  enabled: true,
  everyDays: 7,
};

/** Minutes without an external event before a due review may run. */
export const GROWTH_QUIET_MINUTES = 15;
/** A failed review is retried after this long; the next regular review is not skipped. */
export const GROWTH_RETRY_MINUTES = 60;

export function readGrowth(config: unknown): GrowthConfig {
  const raw = getByPath(config as Record<string, unknown>, 'companion.growth') as Partial<GrowthConfig> | undefined;
  const everyDays = typeof raw?.everyDays === 'number' && Number.isFinite(raw.everyDays)
    ? Math.min(60, Math.max(1, Math.round(raw.everyDays)))
    : GROWTH_DEFAULTS.everyDays;
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : GROWTH_DEFAULTS.enabled,
    everyDays,
  };
}
