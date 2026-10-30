import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona } from '../core/persona.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';

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
  const retainUser = vi.fn((_text: string, meta: { cursor?: number } = {}) => `user:main:${meta.cursor ?? 0}:hash`);
  const retainTouch = vi.fn();
  const retainAffinityChange = vi.fn();
  const forgetDocument = vi.fn(async () => ({ local: 1, deleted: 0, pending: 0, failed: 0 }));
  const forgetMostRecent = vi.fn(async () => null);
  const recallForTurn = vi.fn(async () => ({ text: '[memory] you like tea', route: 'standard' as const, found: true }));
  const sessionBriefing = vi.fn(async () => ({ text: '[memory] portrait', source: 'mental-models' as const }));
  const clearMemory = vi.fn(async () => 'long-term memory cleared');
  const memory = {
    enabled: () => true,
    bankId: () => 'coopanion:test',
    retainUser,
    retainTouch,
    retainAffinityChange,
    forgetDocument,
    forgetMostRecent,
    recallForTurn,
    sessionBriefing,
    clear: clearMemory,
  } as unknown as HindsightMemory;
  const Persona = coopanionPersona(Cormini, { memory });
  const p = new Persona({ memoryDir: dir });
  p['core'] = {
    injectInternal: (text: string, kind: string) => calls.push(`${kind}:${text}`),
    injectDeferred: (_kind: string, render: () => string | null | Promise<string | null>) => deferred.push(render),
  } as never;
  return { p, calls, deferred, retainUser, retainTouch, retainAffinityChange, forgetDocument, forgetMostRecent, recallForTurn, clearMemory };
}

describe('Coo with long-term memory and the affinity extension', () => {
  it('retains the person’s line, a touch, and an affinity change, then injects recall', async () => {
    const { p, calls, retainUser, retainTouch, retainAffinityChange, recallForTurn } = personaWith();
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
    const userEventDocumentId = retainUser.mock.results[0]?.value;
    expect(recallForTurn).toHaveBeenCalledWith('I like jasmine tea', { userEventDocumentId });
    expect(calls).toContain('memory:[memory] you like tea');
  });

  it('does not retain a message that asks not to remember, and freezes recent writes', async () => {
    const { p, retainUser, forgetDocument, recallForTurn } = personaWith();
    await p.onDelivery({
      events: [
        event({ cursor: 1, meta: { text: 'I like jasmine tea' } }),
        event({ cursor: 2, meta: { text: '不要记这件事' } }),
      ],
    });
    expect(retainUser).toHaveBeenCalledTimes(1);
    expect(forgetDocument).toHaveBeenCalledWith('user:main:1:hash');
    expect(recallForTurn).not.toHaveBeenCalled();
  });

  it('forgets the newest line from the durable queue when the app restarted since it was said', async () => {
    const { p, forgetMostRecent, retainUser } = personaWith();
    await p.onDelivery({ events: [event({ cursor: 1, meta: { text: '不要记这件事' } })] });
    expect(retainUser).not.toHaveBeenCalled();
    expect(forgetMostRecent).toHaveBeenCalledWith('main', expect.any(Date));
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
