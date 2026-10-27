import { describe, expect, it, vi } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';

const result = (documentId: string) => ({
  id: `fact-${documentId}`,
  text: 'A synthetic remembered fact.',
  type: 'observation',
  document_id: documentId,
  occurred_start: '2026-10-27T00:00:00.000Z',
});

function memoryFor(recall: () => Promise<{ results: ReturnType<typeof result>[] }>, options: {
  forgotten?: (id: string) => boolean;
  unresolved?: number;
} = {}) {
  const memory = new HindsightMemory() as unknown as Record<string, unknown>;
  Object.assign(memory, {
    config: {
      enabled: true,
      bankId: 'test-bank',
      apiUrl: 'http://hindsight.test',
      recall: { types: ['observation'], maxTokens: 900, budget: 'low', timeoutMs: 500 },
    },
    client: { recall: vi.fn(recall) },
    stateStore: { supersededSources: () => new Set<string>(), currentRevisionSources: () => new Set<string>() },
    ledger: {
      damaged: () => false,
      unresolved: () => options.unresolved ?? 0,
      forgotten: (_bank: string, _endpoint: string, id: string) => options.forgotten?.(id) ?? false,
    },
    enabled: () => true,
    canTry: () => true,
    ensureStarted: async () => true,
  });
  return memory as unknown as HindsightMemory;
}

describe('memory recall outcomes', () => {
  it('distinguishes no matching source from service failure', async () => {
    const absent = memoryFor(async () => ({ results: [] }));
    const unavailable = memoryFor(async () => { throw new Error('synthetic service failure'); });

    expect(await absent.searchResultsDetailed('a past fact')).toMatchObject({ results: [], status: 'absent' });
    expect(await unavailable.searchResultsDetailed('a past fact')).toMatchObject({ results: [], status: 'unavailable' });
  });

  it('reports source-fenced results as restricted and preserves visible evidence', async () => {
    const fenced = memoryFor(async () => ({ results: [result('source-old')] }), { forgotten: (id) => id === 'source-old' });
    const visible = memoryFor(async () => ({ results: [result('source-current')] }));

    expect(await fenced.searchResultsDetailed('a past fact')).toMatchObject({ results: [], status: 'fenced' });
    expect(await visible.searchResultsDetailed('a past fact')).toMatchObject({
      status: 'found',
      results: [{ documentId: 'source-current' }],
    });
  });

  it('treats unscoped results as restricted while deletion work is unresolved', async () => {
    const unscoped = memoryFor(async () => ({
      results: [{ id: 'fact-no-source', text: 'A stale unscoped fact.', type: 'observation', occurred_start: '' } as ReturnType<typeof result>],
    }), { unresolved: 1 });

    expect(await unscoped.searchResultsDetailed('a past fact')).toMatchObject({ results: [], status: 'fenced' });
  });
});
