export const DEFAULT_RECALL_TIMEOUT_MS = 8_000;
export const MAX_CONFIGURED_RECALL_TIMEOUT_MS = 10_000;
export const MAX_DEEP_RECALL_TIMEOUT_MS = 15_000;
export const DEFAULT_SOURCE_FACTS_TOKEN_BUDGET = 4_096;
export const DOMAIN_SUPPLEMENT_SOURCE_FACTS_TOKEN_BUDGET = 16_384;
export const MAX_SOURCE_FACTS_TOKEN_BUDGET = 16_384;

export function sourceFactsTokenBudget(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SOURCE_FACTS_TOKEN_BUDGET, Math.max(1, Math.round(value)))
    : DEFAULT_SOURCE_FACTS_TOKEN_BUDGET;
}

export function recallContextCharBudget(recallTokens: number, sourceFactsTokens: number): number {
  return Math.max(800, (recallTokens + sourceFactsTokens) * 6);
}
