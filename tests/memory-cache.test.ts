import { createHash } from 'node:crypto';
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

  it('withholds a session briefing whose verified segments do not cover its text', async () => {
    const memory = new HindsightMemory();
    Object.assign(memory, {
      config: {
        enabled: true, bankId: 'bank-test', apiUrl: 'http://127.0.0.1:1',
        recall: { maxTokens: 900, budget: 'low', timeoutMs: 800, types: ['observation'] },
        portrait: { maxTokens: 500 },
      },
      ready: true,
      client: { getMentalModel: async () => ({ content: '' }) },
      ledger: null,
    });
    (memory as unknown as { enabled: () => boolean }).enabled = () => true;
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    (memory as unknown as { recallBlockDetailed: unknown }).recallBlockDetailed = async () => ({
      text: 'abc', status: 'found', sourceSegments: [{ documentId: 'user:main:1', start: 0, end: 3 }],
    });
    (memory as unknown as { evidenceForRead: unknown }).evidenceForRead = async () => [{
      bankId: 'bank-test', endpoint: 'http://127.0.0.1:1', documentId: 'user:main:1',
      validatedEpoch: '1', validationReceipt: 'receipt', contentDigest: digest('ab'),
      validationStatus: 'validated', revisionState: 'current',
      segment: { start: 0, end: 2, digest: digest('ab') },
    }];
    expect(await memory.sessionBriefing()).toEqual({ text: '', source: 'none' });
    expect((memory as unknown as { briefing: unknown }).briefing).toBeNull();
  });
});

describe('source evidence epoch', () => {
  it('keeps a source proof valid across a read-cache invalidation and drops it on a forget fence', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { closeMemoryStateStores, openMemoryStateStore } = await import('../core/memory/state-store.ts');
    const { ForgetLedger } = await import('../core/memory/forget-ledger.ts');
    const { loadHindsightConfig } = await import('../core/memory/config.ts');
    const dir = mkdtempSync(join(tmpdir(), 'coopanion-source-epoch-'));
    try {
      const store = openMemoryStateStore(join(dir, 'memory-state.sqlite'));
      const memory = new HindsightMemory();
      Object.assign(memory, {
        config: loadHindsightConfig(dir, { enabled: true, autostart: false, apiUrl: 'http://127.0.0.1:1', bankId: 'epoch-bank' }),
        stateStore: store,
        ledger: new ForgetLedger(store),
      });
      const before = memory.evidenceEpoch();
      expect(before).not.toBeNull();
      memory.invalidateCache();
      expect(memory.evidenceEpoch()).toBe(before);
      const ledger = (memory as unknown as { ledger: InstanceType<typeof ForgetLedger> }).ledger;
      expect(ledger.addMany([{ bankId: 'epoch-bank', endpoint: 'http://127.0.0.1:1', documentId: 'doc-1', reason: 'synthetic' }], 'synthetic').failed).toBe(0);
      expect(memory.evidenceEpoch()).not.toBe(before);
    } finally {
      closeMemoryStateStores();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
