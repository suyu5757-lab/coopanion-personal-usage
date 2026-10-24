import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona } from '../core/persona.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import type { AffectionLedger } from '../core/memory/affection.ts';

const event = (over: Partial<EventEnvelope>): EventEnvelope => ({
  cursor: 1,
  type: 'desktop-pet.message',
  ts: '2026-10-24T10:00:00.000Z',
  source: 'desktop-pet',
  origin: 'external',
  text: 'hello',
  ...over,
});

function personaWith() {
  const dir = mkdtempSync(join(tmpdir(), 'coo-persona-memory-'));
  const calls: string[] = [];
  const deferred: Array<() => string | null | Promise<string | null>> = [];
  const retainUser = vi.fn();
  const recordTouch = vi.fn();
  const recallBlock = vi.fn(async () => '[memory] you like tea');
  const sessionBriefing = vi.fn(async () => ({ text: '[memory] portrait', source: 'mental-models' as const }));
  const clearMemory = vi.fn(async () => 'long-term memory cleared');
  const clearAffection = vi.fn(() => 'affection ledger cleared');
  const memory = {
    enabled: () => true,
    bankId: () => 'coopanion:test',
    retainUser,
    recallBlock,
    sessionBriefing,
    clear: clearMemory,
  } as unknown as HindsightMemory;
  const affection = {
    enabled: () => true,
    recordTouch,
    snapshot: () => '[affection] Bond Lv.2',
    state: () => ({ events: 3 }),
    clear: clearAffection,
  } as unknown as AffectionLedger;
  const Persona = coopanionPersona(Cormini, { memory, affection });
  const p = new Persona({ memoryDir: dir });
  p['core'] = {
    injectInternal: (text: string, kind: string) => calls.push(`${kind}:${text}`),
    injectDeferred: (_kind: string, render: () => string | null | Promise<string | null>) => deferred.push(render),
  } as never;
  return { p, calls, deferred, retainUser, recordTouch, recallBlock, clearMemory, clearAffection };
}

describe('Coo with long-term memory', () => {
  it('retains the person’s line, records a touch, and injects a recall block', async () => {
    const { p, calls, retainUser, recordTouch, recallBlock } = personaWith();
    await p.onDelivery({
      events: [
        event({ type: 'desktop-pet.touch', meta: { touch: { kind: 'pet', count: 2 } } }),
        event({ cursor: 2, meta: { text: 'I like jasmine tea' } }),
      ],
    });
    expect(recordTouch).toHaveBeenCalledWith({ kind: 'pet', count: 2 }, expect.objectContaining({ session: 'main', cursor: 1 }));
    expect(retainUser).toHaveBeenCalledWith('I like jasmine tea', expect.objectContaining({ session: 'main', cursor: 2 }));
    expect(recallBlock).toHaveBeenCalledWith('I like jasmine tea', { timeoutMs: 700 });
    expect(calls).toContain('memory:[memory] you like tea');
  });

  it('injects the portrait and affection snapshot at session start', async () => {
    const { p, deferred } = personaWith();
    p.onOpening({ reason: 'new' });
    expect(deferred).toHaveLength(1);
    const text = await deferred[0]!();
    expect(text).toContain('[memory] portrait');
    expect(text).toContain('[affection] Bond Lv.2');
  });

  it('adds long-term memory and the affection ledger to the storage page', async () => {
    const { p, clearMemory, clearAffection } = personaWith();
    const storage = p.webUi('en').memory?.storage ?? [];
    const hindsight = storage.find((part) => part.key === 'hindsight')!;
    const affection = storage.find((part) => part.key === 'affection')!;
    expect(hindsight.stat()).toContain('coopanion:test');
    expect(affection.stat()).toBe('3 events');
    expect(await hindsight.clear()).toBe('long-term memory cleared');
    expect(affection.clear()).toBe('affection ledger cleared');
    expect(clearMemory).toHaveBeenCalledOnce();
    expect(clearAffection).toHaveBeenCalledOnce();
  });

  it('does nothing memory-related when the service is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-persona-memory-'));
    const calls: string[] = [];
    const Persona = coopanionPersona(Cormini);
    const p = new Persona({ memoryDir: dir });
    p['core'] = {
      injectInternal: (text: string, kind: string) => calls.push(`${kind}:${text}`),
      injectDeferred: () => { throw new Error('should not defer'); },
    } as never;
    await p.onDelivery({ events: [event({ meta: { text: 'hello' } })] });
    expect(calls.some((line) => line.startsWith('memory:'))).toBe(false);
  });
});
