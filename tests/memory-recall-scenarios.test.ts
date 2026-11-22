import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface RecallScenario {
  id: string;
  split: 'train' | 'holdout';
  category: string;
  history: string[];
  query: string;
  expected: {
    sourceIds: string[];
    actor: string;
    status: string;
    mustMention: string[];
    mustNotClaim: string[];
  };
}

const scenarios = JSON.parse(readFileSync(new URL('./fixtures/memory-recall-v2.3.json', import.meta.url), 'utf8')) as RecallScenario[];

describe('the frozen memory recall scenario set', () => {
  it('keeps eight scenarios in each slice and reserves the same twelve holdout cases', () => {
    const categories = ['save_recovery', 'correction_time', 'forgetting', 'implicit_history_zh', 'companionship_action', 'growth_permission'];
    const holdout = [
      'save-07', 'save-08', 'correction-07', 'correction-08', 'forget-07', 'forget-08',
      'implicit-07', 'implicit-08', 'daily-07', 'daily-08', 'growth-07', 'growth-08',
    ];
    expect(scenarios).toHaveLength(48);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(48);
    for (const category of categories) expect(scenarios.filter((scenario) => scenario.category === category)).toHaveLength(8);
    expect(scenarios.filter((scenario) => scenario.split === 'holdout').map((scenario) => scenario.id).sort()).toEqual(holdout.sort());
    expect(scenarios.filter((scenario) => scenario.split === 'train')).toHaveLength(36);
  });

  it('uses synthetic source IDs and records evidence and unsupported-answer constraints', () => {
    for (const scenario of scenarios) {
      expect(scenario.history.length).toBeGreaterThan(0);
      expect(scenario.query.trim()).not.toBe('');
      expect(scenario.expected.mustNotClaim.length).toBeGreaterThan(0);
      for (const sourceId of scenario.expected.sourceIds) expect(sourceId).toMatch(/^src-[a-z0-9-]+$/);
    }
  });
});
