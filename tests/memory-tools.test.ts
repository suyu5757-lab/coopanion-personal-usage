import { describe, expect, it } from 'vitest';
import { memoryTools } from '../core/memory/tools.ts';
import { formatRecall } from '../core/memory/format.ts';
import { MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE } from '../core/memory/model-text.ts';
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
      forget: async () => ({ acceptance: 'accepted', local: 0, deleted: 1, pending: 0, failed: 0, activeContextInvalidated: false }),
    } as unknown as HindsightMemory;
    const tool = memoryTools({ memory: () => memory }).find((entry) => entry.name === 'memory_forget')!;
    const result = await tool.handler({ query: 'the old route' }, {} as never);

    expect(result).toContain('[forget accepted]');
    expect(result).toContain('active conversation may still contain this source');
    expect(result).toContain('Do not recover it from workspace files, Handoff notes or Git history.');
  });

  it('separates a failed Forget request from an accepted deletion retry', async () => {
    const memory = {
      enabled: () => true,
      forget: async () => ({ acceptance: 'not-accepted', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false }),
    } as unknown as HindsightMemory;
    const tool = memoryTools({ memory: () => memory }).find((entry) => entry.name === 'memory_forget')!;
    const result = await tool.handler({ query: 'the old route' }, {} as never);

    expect(result).toContain('[forget not accepted]');
    expect(result).toContain('retry is required');
  });
});

describe('memory read status', () => {
  it('tells the bot to check original sources when supporting evidence is incomplete', async () => {
    const text = formatRecall([{ id: 'f1', text: 'A related memory, with incomplete supporting facts.', type: 'observation' }], { sourceFactsTruncated: true });
    const memory = {
      enabled: () => true,
      recallBlockDetailed: async () => ({ text, status: 'found', sourceFactsTruncated: true }),
      evidenceForRead: async () => [],
    } as unknown as HindsightMemory;
    const tool = memoryTools({ memory: () => memory }).find((entry) => entry.name === 'memory_search')!;
    const result = await tool.handler({ query: 'What happened before?' }, {} as never);

    expect(result).toContain('Supporting source evidence is incomplete or truncated');
    expect(result).toContain('sources=true');
    expect(result).toContain('original retained text');
    expect(typeof result).toBe('string');
    if (typeof result !== 'string') throw new Error('Expected a text result.');
    expect(result.split(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE)).toHaveLength(2);
  });

  it('describes semantic recall and literal source lookup as separate query contracts', () => {
    const tool = memoryTools({ memory: () => null }).find((entry) => entry.name === 'memory_search')!;
    const properties = tool.parameters.properties as Record<string, { description?: string }>;
    const query = properties.query?.description ?? '';
    const sources = properties.sources?.description ?? '';
    expect(query).toContain('semantic recall');
    expect(query).toContain('natural language');
    expect(query).toContain('short literal phrase');
    expect(query).toContain('verbatim');
    expect(sources).toContain('literal phrase');
  });

  it.each([
    ['absent', 'No verified source record matched'],
    ['incomplete', 'could not be fully verified'],
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
