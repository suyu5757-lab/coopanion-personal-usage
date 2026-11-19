import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RECALL_TIMEOUT_MS, MAX_CONFIGURED_RECALL_TIMEOUT_MS, sourceFactsTokenBudget } from './recall-limits.ts';

export type RecallBudget = 'low' | 'mid' | 'high';

export interface HindsightConfig {
  enabled: boolean;
  autostart: boolean;
  readOnly: boolean;
  autostartCommand?: string;
  apiUrl: string;
  apiToken: string;
  bankId: string;
  recall: {
    maxTokens: number;
    budget: RecallBudget;
    timeoutMs: number;
    maxSourceFactsTokens?: number;
    types: string[];
  };
  /**
   * Opt-in domain-memory supplement after the ordinary Recall block. Off by default.
   * Its budget is separate from `recall` and uses the stock `recall.types` allow-list.
   */
  domainSupplement: {
    enabled: boolean;
    timeoutMs: number;
    queryTimeoutMs: number;
    maxSources: number;
    readbackTimeBudgetMs: number;
    maxSupplementSources: number;
    maxSupplementChars: number;
    finalReadbackTimeBudgetMs: number;
  };
  retain: {
    async: boolean;
  };
  portrait: {
    maxTokens: number;
  };
  affection: {
    enabled: boolean;
    dailyPositive: number;
    dailyNegative: number;
  };
}

export interface HindsightFileConfig {
  enabled?: boolean;
  autostart?: boolean;
  autostartCommand?: string;
  apiUrl?: string;
  apiToken?: string;
  bankId?: string;
  recall?: {
    maxTokens?: number;
    budget?: RecallBudget;
    timeoutMs?: number;
    maxSourceFactsTokens?: number;
    types?: string[];
  };
  domainSupplement?: {
    enabled?: boolean;
    timeoutMs?: number;
    queryTimeoutMs?: number;
    maxSources?: number;
    readbackTimeBudgetMs?: number;
    maxSupplementSources?: number;
    maxSupplementChars?: number;
    finalReadbackTimeBudgetMs?: number;
  };
  retain?: {
    async?: boolean;
  };
  portrait?: {
    maxTokens?: number;
  };
  affection?: {
    enabled?: boolean;
    dailyPositive?: number;
    dailyNegative?: number;
  };
}

const DEFAULTS = {
  apiUrl: 'http://127.0.0.1:8888',
  autostart: false,
  recall: { maxTokens: 900, budget: 'low' as RecallBudget, timeoutMs: DEFAULT_RECALL_TIMEOUT_MS, types: ['observation', 'world', 'experience'] },
  domainSupplement: {
    enabled: false,
    timeoutMs: 20_000,
    queryTimeoutMs: 8_000,
    maxSources: 50,
    readbackTimeBudgetMs: 8_000,
    maxSupplementSources: 2,
    maxSupplementChars: 1_200,
    finalReadbackTimeBudgetMs: 3_000,
  },
  retain: { async: true },
  portrait: { maxTokens: 500 },
  affection: { dailyPositive: 10, dailyNegative: 5 },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

const int = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;

const optionalInt = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? clamp(value, min, max) : fallback;

const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

const str = (value: unknown, fallback: string): string => typeof value === 'string' && value.trim() ? value.trim() : fallback;

function readFile(file: string): HindsightFileConfig | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as HindsightFileConfig : null;
  } catch {
    return null;
  }
}

export function bankIdFor(rootDir: string): string {
  return `coopanion:${createHash('sha256').update(rootDir).digest('hex').slice(0, 10)}`;
}

export function loadHindsightConfig(rootDir: string, overrides?: HindsightFileConfig): HindsightConfig {
  const file = readFile(join(rootDir, 'hindsight.json'));
  const envUrl = process.env.COOPANION_HINDSIGHT_URL?.trim();
  const envEnabled = process.env.COOPANION_HINDSIGHT?.trim();
  const envToken = process.env.COOPANION_HINDSIGHT_TOKEN?.trim();
  const envBank = process.env.COOPANION_HINDSIGHT_BANK?.trim();
  const enabled = envEnabled === '0'
    ? false
    : envEnabled === '1'
      ? true
      : typeof overrides?.enabled === 'boolean'
        ? overrides.enabled
        : !!envUrl || (!!file && file.enabled !== false);
  const raw = {
    ...(file ?? {}),
    ...(overrides ?? {}),
    recall: { ...(file?.recall ?? {}), ...(overrides?.recall ?? {}) },
    domainSupplement: { ...(file?.domainSupplement ?? {}), ...(overrides?.domainSupplement ?? {}) },
    retain: { ...(file?.retain ?? {}), ...(overrides?.retain ?? {}) },
    portrait: { ...(file?.portrait ?? {}), ...(overrides?.portrait ?? {}) },
    affection: { ...(file?.affection ?? {}), ...(overrides?.affection ?? {}) },
  };
  const recall = raw.recall ?? {};
  const domainSupplement = raw.domainSupplement ?? {};
  const retain = raw.retain ?? {};
  const portrait = raw.portrait ?? {};
  const affection = raw.affection ?? {};
  const types = Array.isArray(recall.types)
    ? recall.types.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()).slice(0, 3)
    : DEFAULTS.recall.types;
  const budget = recall.budget === 'mid' || recall.budget === 'high' ? recall.budget : 'low';
  return {
    enabled,
    autostart: bool(raw.autostart, DEFAULTS.autostart),
    readOnly: process.env.COOPANION_HINDSIGHT_READ_ONLY === '1',
    ...(str(raw.autostartCommand, '') ? { autostartCommand: str(raw.autostartCommand, '') } : {}),
    apiUrl: str(envUrl ?? overrides?.apiUrl ?? raw.apiUrl, DEFAULTS.apiUrl).replace(/\/+$/, ''),
    apiToken: str(envToken ?? raw.apiToken, ''),
    bankId: str(envBank ?? overrides?.bankId ?? raw.bankId, bankIdFor(rootDir)),
    recall: {
      maxTokens: optionalInt(recall.maxTokens, DEFAULTS.recall.maxTokens, 200, 4000),
      budget,
      timeoutMs: optionalInt(recall.timeoutMs, DEFAULTS.recall.timeoutMs, 100, MAX_CONFIGURED_RECALL_TIMEOUT_MS),
      maxSourceFactsTokens: sourceFactsTokenBudget(recall.maxSourceFactsTokens),
      types: types.length ? types : DEFAULTS.recall.types,
    },
    domainSupplement: {
      enabled: enabled && bool(domainSupplement.enabled, DEFAULTS.domainSupplement.enabled),
      timeoutMs: optionalInt(domainSupplement.timeoutMs, DEFAULTS.domainSupplement.timeoutMs, 100, 20_000),
      queryTimeoutMs: optionalInt(domainSupplement.queryTimeoutMs, DEFAULTS.domainSupplement.queryTimeoutMs, 100, 10_000),
      maxSources: optionalInt(domainSupplement.maxSources, DEFAULTS.domainSupplement.maxSources, 1, 50),
      readbackTimeBudgetMs: optionalInt(domainSupplement.readbackTimeBudgetMs, DEFAULTS.domainSupplement.readbackTimeBudgetMs, 1, 10_000),
      maxSupplementSources: optionalInt(domainSupplement.maxSupplementSources, DEFAULTS.domainSupplement.maxSupplementSources, 1, 10),
      maxSupplementChars: optionalInt(domainSupplement.maxSupplementChars, DEFAULTS.domainSupplement.maxSupplementChars, 200, 4000),
      finalReadbackTimeBudgetMs: optionalInt(domainSupplement.finalReadbackTimeBudgetMs, DEFAULTS.domainSupplement.finalReadbackTimeBudgetMs, 1, 10_000),
    },
    retain: {
      async: bool(retain.async, DEFAULTS.retain.async),
    },
    portrait: {
      maxTokens: optionalInt(portrait.maxTokens, DEFAULTS.portrait.maxTokens, 150, 1500),
    },
    affection: {
      enabled: enabled && bool(affection.enabled, true),
      dailyPositive: int(affection.dailyPositive, DEFAULTS.affection.dailyPositive, 1, 100),
      dailyNegative: int(affection.dailyNegative, DEFAULTS.affection.dailyNegative, 1, 100),
    },
  };
}
