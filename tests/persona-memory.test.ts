import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona } from '../core/persona.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';

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
  const retainTouch = vi.fn();
  const retainAffinityChange = vi.fn();
  const recallBlock = vi.fn(async () => '[memory] you like tea');
  const sessionBriefing = vi.fn(async () => ({ text: '[memory] portrait', source: 'mental-models' as const }));
  const clearMemory = vi.fn(async () => 'long-term memory cleared');
  const memory = {
    enabled: () => true,
    bankId: () => 'coopanion:test',
    retainUser,
    retainTouch,
    retainAffinityChange,
    recallBlock,
    sessionBriefing,
    clear: clearMemory,
  } as unknown as HindsightMemory;
  const Persona = coopanionPersona(Cormini, { memory });
  const p = new Persona({ memoryDir: dir });
  p['core'] = {
    injectInternal: (text: string, kind: string) => calls.push(`${kind}:${text}`),
    injectDeferred: (_kind: string, render: () => string | null | Promise<string | null>) => deferred.push(render),
  } as never;
  return { p, calls, deferred, retainUser, retainTouch, retainAffinityChange, recallBlock, clearMemory };
}

describe('Coo with long-term memory and the affinity extension', () => {
  it('keeps the feeling and the unresolved matter in long-term memory, not the score', () => {
    const memory = new HindsightMemory();
    const calls: Array<{ content: string }> = [];
    (memory as unknown as { enabled: () => boolean }).enabled = () => true;
    (memory as unknown as { enqueue: (item: { content: string }) => void }).enqueue = (item) => calls.push(item);
    memory.retainAffinityChange({
      subject: 7, score: 99, delta: -2, kind: 'angry', reason: 'he forgot the promise',
      emotion: { expression: 'hint', need: 'recognition' }, unresolved: { resolved: false }, at: '2026-10-25T10:00:00Z',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.content).toContain('feeling angry');
    expect(calls[0]!.content).toContain('need recognition');
    expect(calls[0]!.content).toContain('still unresolved');
    expect(calls[0]!.content).not.toContain('99');
    expect(calls[0]!.content).not.toContain('-2');
  });

  it('retains the person’s line, a touch, and an affinity change, then injects recall', async () => {
    const { p, calls, retainUser, retainTouch, retainAffinityChange, recallBlock } = personaWith();
    await p.onDelivery({
      events: [
        event({ type: 'desktop-pet.touch', meta: { touch: { kind: 'pet', count: 2 } } }),
        event({ cursor: 2, type: 'affinity.changed', origin: 'internal', meta: { subject: 7, score: 21, delta: 1, kind: 'happy', reason: 'shared tea' } }),
        event({ cursor: 3, meta: { text: 'I like jasmine tea' } }),
      ],
    });
    expect(retainTouch).toHaveBeenCalledWith({ kind: 'pet', count: 2 }, expect.objectContaining({ session: 'main', cursor: 1 }));
    expect(retainAffinityChange).toHaveBeenCalledWith(expect.objectContaining({ subject: 7, score: 21, delta: 1, kind: 'happy', reason: 'shared tea' }));
    expect(retainUser).toHaveBeenCalledWith('I like jasmine tea', expect.objectContaining({ session: 'main', cursor: 3 }));
    expect(recallBlock).toHaveBeenCalledWith('I like jasmine tea', { timeoutMs: 700 });
    expect(calls).toContain('memory:[memory] you like tea');
  });

  it('injects the portrait at session start', async () => {
    const { p, deferred } = personaWith();
    p.onOpening({ reason: 'new' });
    expect(deferred).toHaveLength(1);
    const text = await deferred[0]!();
    expect(text).toContain('[memory] portrait');
  });

  it('adds long-term memory to the storage page', async () => {
    const { p, clearMemory } = personaWith();
    const storage = p.webUi('en').memory?.storage ?? [];
    const hindsight = storage.find((part) => part.key === 'hindsight')!;
    expect(hindsight.stat()).toContain('coopanion:test');
    expect(await hindsight.clear()).toBe('long-term memory cleared');
    expect(clearMemory).toHaveBeenCalledOnce();
    expect(storage.map((part) => part.key)).not.toContain('affection');
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
