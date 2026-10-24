import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import { AffinitySync } from '../core/memory/affinity-sync.ts';

describe('affinity event sync', () => {
  it('reads complete lines and hands them to Hindsight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-affinity-sync-'));
    const file = join(dir, 'affinity-events.jsonl');
    writeFileSync(file, `${JSON.stringify({ subject: 7, score: 21, delta: 1, kind: 'happy', reason: 'tea', at: '2026-10-24T10:00:00Z' })}\n`);
    const retainAffinityChange = vi.fn();
    const memory = { enabled: () => true, retainAffinityChange } as unknown as HindsightMemory;
    const sync = new AffinitySync();
    sync.configure({ file, memory });
    sync.start();
    expect(retainAffinityChange).toHaveBeenCalledWith(expect.objectContaining({ subject: 7, score: 21, delta: 1 }));
    appendFileSync(file, `${JSON.stringify({ subject: 7, score: 21, slot: '朋友', at: '2026-10-24T11:00:00Z' })}\n`);
    await vi.waitFor(() => expect(retainAffinityChange).toHaveBeenCalledTimes(2), { timeout: 5000 });
    sync.stop();
  });
});
