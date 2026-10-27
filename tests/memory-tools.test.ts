import { describe, expect, it } from 'vitest';
import { memoryTools } from '../core/memory/tools.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';

describe('memory correction tool', () => {
  it('passes the cited source IDs and reports the local queue state', async () => {
    const correct = async (text: string, sourceIds: readonly string[], meta?: { session?: string; sourceDocumentId?: string }) =>
      text.includes('Osaka') && sourceIds.includes('doc-old') && meta?.session === 'main' && meta.sourceDocumentId === 'user:main:3' ? 'queued' as const : 'source-missing' as const;
    const memory = { enabled: () => true, correct } as unknown as HindsightMemory;
    const tool = memoryTools({ memory: () => memory, currentUserSource: () => 'user:main:3' }).find((entry) => entry.name === 'memory_correct')!;
    const result = await tool.handler({ text: 'The current plan is Osaka.', source_ids: ['doc-old'] }, { role: 'main' } as never);

    expect(result).toContain('[correction queued]');
    expect(result).toContain('current user event was linked');
  });

  it('promotes the current user event without creating another memory record', async () => {
    let promoted: { session?: string; sourceDocumentId?: string } | undefined;
    const memory = {
      enabled: () => true,
      remember: (_text: string, meta: { session?: string; sourceDocumentId?: string }) => {
        promoted = meta;
        return 'verified' as const;
      },
    } as unknown as HindsightMemory;
    const tool = memoryTools({ memory: () => memory, currentUserSource: () => 'user:main:9' }).find((entry) => entry.name === 'memory_remember')!;
    const result = await tool.handler({ text: 'I prefer jasmine tea.' }, { role: 'main' } as never);

    expect(promoted).toEqual({ session: 'main', sourceDocumentId: 'user:main:9' });
    expect(result).toContain('no second memory was created');
  });

  it('does not imply an active conversation was cleared by a forget request', async () => {
    const memory = {
      enabled: () => true,
      forget: async () => ({ local: 0, deleted: 1, pending: 0, failed: 0, activeContextInvalidated: false }),
    } as unknown as HindsightMemory;
    const tool = memoryTools({ memory: () => memory }).find((entry) => entry.name === 'memory_forget')!;
    const result = await tool.handler({ query: 'the old route' }, {} as never);

    expect(result).toContain('active conversation may still contain this source');
  });
});

describe('memory read status', () => {
  it.each([
    ['absent', 'No verified source record matched'],
    ['unavailable', 'This does not mean the record is absent'],
    ['fenced', 'Historical memory is restricted'],
  ] as const)('reports %s separately from an empty result', async (status, expected) => {
    const memory = {
      enabled: () => true,
      recallBlockDetailed: async () => ({ text: '', status }),
    } as unknown as HindsightMemory;
    const tool = memoryTools({ memory: () => memory }).find((entry) => entry.name === 'memory_search')!;
    const result = await tool.handler({ query: 'What happened before?' }, {} as never);

    expect(result).toContain(expected);
  });
});
