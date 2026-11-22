/** `companion.growth`: whether Coo reviews herself on a schedule, and how often. */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getByPath } from 'cortico/core/config-schema.ts';
import { asRecord, InvalidState, readState, writeState } from '../state-file.ts';

export interface GrowthConfig {
  enabled: boolean;
  autoApply?: boolean;
  /** Days between self-reviews. */
  everyDays: number;
}

export const GROWTH_DEFAULTS: GrowthConfig = {
  enabled: false,
  everyDays: 7,
};

/** Minutes without an external event before a due review may run. */
export const GROWTH_QUIET_MINUTES = 15;
/** A failed review is retried after this long; the next regular review is not skipped. */
export const GROWTH_RETRY_MINUTES = 60;

/** Stop an old scheduled review setting from opening the unaccepted G2 path on upgrade. */
export function migrateLegacyGrowthConfig(
  rootDir: string,
  config: unknown,
  log?: { warn(message: string, data?: unknown): void },
): boolean {
  const markerFile = join(rootDir, 'memory-config-migrations.json');
  const applied = readState(markerFile, (value) => {
    const record = asRecord(value);
    if (record.v !== 1 || record.growthDisabledBeforeG2 !== true) throw new InvalidState('unknown memory config migration');
    return true;
  });
  if (applied) return false;

  const configFile = join(rootDir, 'config.json');
  const saved = existsSync(configFile) ? asRecord(JSON.parse(readFileSync(configFile, 'utf8'))) : {};
  const companion = saved.companion && typeof saved.companion === 'object' && !Array.isArray(saved.companion)
    ? saved.companion as Record<string, unknown>
    : {};
  const growth = companion.growth && typeof companion.growth === 'object' && !Array.isArray(companion.growth)
    ? companion.growth as Record<string, unknown>
    : {};
  const disabled = growth.enabled === true;
  if (disabled) {
    const liveGrowth = getByPath(config as Record<string, unknown>, 'companion.growth') as Record<string, unknown> | undefined;
    if (liveGrowth) liveGrowth.enabled = false;
    try {
      const backupFile = join(rootDir, 'config.json.pre-v23-growth');
      if (existsSync(configFile) && !existsSync(backupFile)) copyFileSync(configFile, backupFile);
      saved.companion = { ...companion, growth: { ...growth, enabled: false } };
      writeState(configFile, `${JSON.stringify(saved, null, 2)}\n`);
    } catch (error) {
      log?.warn('[growth] could not persist the disabled legacy setting; reviews stay off for this run', {
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  try {
    writeState(markerFile, `${JSON.stringify({ v: 1, growthDisabledBeforeG2: true })}\n`);
  } catch (error) {
    log?.warn('[growth] could not save the config migration marker', { message: error instanceof Error ? error.message : String(error) });
  }
  return disabled;
}

export function readGrowth(config: unknown): GrowthConfig {
  const raw = getByPath(config as Record<string, unknown>, 'companion.growth') as Partial<GrowthConfig> | undefined;
  const everyDays = typeof raw?.everyDays === 'number' && Number.isFinite(raw.everyDays)
    ? Math.min(60, Math.max(1, Math.round(raw.everyDays)))
    : GROWTH_DEFAULTS.everyDays;
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : GROWTH_DEFAULTS.enabled,
    everyDays,
    ...(raw?.autoApply === true ? { autoApply: true } : {}),
  };
}
