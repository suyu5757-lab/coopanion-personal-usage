import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { hindsightConfigGroup } from '../core/memory/config-group.ts';
import { DEFAULT_RECALL_TIMEOUT_MS, MAX_CONFIGURED_RECALL_TIMEOUT_MS, MAX_DEEP_RECALL_TIMEOUT_MS } from '../core/memory/recall-limits.ts';
import { planRecall } from '../core/memory/router.ts';

describe('memory recall timeouts', () => {
  it('keeps the configured range aligned with the runtime default', () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-recall-timeout-'));
    try {
      expect(loadHindsightConfig(root).recall.timeoutMs).toBe(DEFAULT_RECALL_TIMEOUT_MS);
      writeFileSync(join(root, 'hindsight.json'), JSON.stringify({ enabled: true, recall: { timeoutMs: MAX_CONFIGURED_RECALL_TIMEOUT_MS + 1 } }));
      expect(loadHindsightConfig(root).recall.timeoutMs).toBe(MAX_CONFIGURED_RECALL_TIMEOUT_MS);
      expect(hindsightConfigGroup('en').schema.properties['hindsight.recall.timeoutMs'].maximum)
        .toBe(MAX_CONFIGURED_RECALL_TIMEOUT_MS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the longer default after measured Hindsight latency exceeded the old route budgets', () => {
    expect(planRecall('你觉得我适合养猫吗？').timeoutMs).toBe(DEFAULT_RECALL_TIMEOUT_MS);
  });

  it('allows deep recall to wait up to its larger bounded deadline', () => {
    const plan = planRecall('你还记得我上次说的那个计划吗？', {
      timeoutMs: MAX_CONFIGURED_RECALL_TIMEOUT_MS,
      maxTokens: 900,
      budget: 'low',
    });
    expect(plan.timeoutMs).toBe(MAX_DEEP_RECALL_TIMEOUT_MS);
  });
});
