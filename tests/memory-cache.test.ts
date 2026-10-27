import { describe, expect, it, vi } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';

describe('recall cache invalidation', () => {
  it('drops an in-flight result and does not write it into the cache', async () => {
    const memory = new HindsightMemory();
    let resolve!: (result: { text: string; status: 'found' }) => void;
    const recall = vi.fn(async () => await new Promise<{ text: string; status: 'found' }>((done) => { resolve = done; }));
    (memory as unknown as { recallBlockDetailed: typeof recall }).recallBlockDetailed = recall;
    const active = memory.recallForTurn('What should we do tomorrow?');
    memory.invalidateCache();
    resolve({ text: 'old synthetic fact', status: 'found' });
    const first = await active;
    expect(first.text).toBe('');
    expect(first.status).toBe('fenced');
    const recallAgain = vi.fn(async () => ({ text: 'fresh synthetic fact', status: 'found' as const }));
    (memory as unknown as { recallBlockDetailed: typeof recallAgain }).recallBlockDetailed = recallAgain;
    const second = await memory.recallForTurn('What should we do tomorrow?');
    expect(second.text).toBe('fresh synthetic fact');
    expect(second.status).toBe('found');
    expect(recallAgain).toHaveBeenCalledOnce();
  });

  it('discards an in-flight session briefing after a forget', async () => {
    const memory = new HindsightMemory();
    (memory as unknown as { config: unknown }).config = {
      enabled: true,
      bankId: 'bank-test',
      recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] },
    };
    (memory as unknown as { ready: boolean }).ready = true;
    (memory as unknown as { enabled: () => boolean }).enabled = () => true;
    let started!: () => void;
    const startedPromise = new Promise<void>((done) => { started = done; });
    const resolvers: Array<(value: { content: string }) => void> = [];
    (memory as unknown as { client: unknown }).client = {
      getMentalModel: () => {
        started();
        return new Promise<{ content: string }>((done) => resolvers.push(done));
      },
    };
    const active = memory.sessionBriefing();
    await startedPromise;
    memory.invalidateCache();
    for (const resolve of resolvers) resolve({ content: 'old portrait' });
    expect(await active).toEqual({ text: '', source: 'none' });
    expect((memory as unknown as { briefing: unknown }).briefing).toBeNull();
  });
});
