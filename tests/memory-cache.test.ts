import { describe, expect, it, vi } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';

describe('recall cache invalidation', () => {
  it('drops an in-flight result and does not write it into the cache', async () => {
    const memory = new HindsightMemory();
    let resolve!: (text: string) => void;
    const recall = vi.fn(async () => await new Promise<string>((done) => { resolve = done; }));
    (memory as unknown as { recallBlock: typeof recall }).recallBlock = recall;
    const active = memory.recallForTurn('What should we do tomorrow?');
    memory.invalidateCache();
    resolve('old synthetic fact');
    const first = await active;
    expect(first.text).toBe('');
    const recallAgain = vi.fn(async () => 'fresh synthetic fact');
    (memory as unknown as { recallBlock: typeof recallAgain }).recallBlock = recallAgain;
    const second = await memory.recallForTurn('What should we do tomorrow?');
    expect(second.text).toBe('fresh synthetic fact');
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
