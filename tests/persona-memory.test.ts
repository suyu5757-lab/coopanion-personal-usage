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
  const injections: Array<{ text: string; kind: string; evidence?: unknown[] }> = [];
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
    markRecallInjected: () => {},
    bankId: () => 'coopanion:test',
    retainUser,
    retainTouch,
    retainAffinityChange,
    forgetDocument,
    forgetMostRecent,
    recallForTurn,
    evidenceForSegments: vi.fn(async () => []),
    domainSupplementOptions: () => null,
    sessionBriefing,
    clear: clearMemory,
  } as unknown as HindsightMemory;
  const Persona = coopanionPersona(Cormini, { memory });
  const p = new Persona({ memoryDir: dir });
  p['core'] = {
    injectInternal: (text: string, kind: string, evidence?: unknown[]) => {
      calls.push(`${kind}:${text}`);
      injections.push({ text, kind, ...(evidence ? { evidence } : {}) });
    },
    injectDeferred: (_kind: string, render: () => string | null | Promise<string | null>) => deferred.push(render),
  } as never;
  return { p, calls, injections, deferred, retainUser, retainTouch, retainAffinityChange, forgetDocument, forgetMostRecent, recallForTurn, clearMemory };
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
    expect(recallForTurn).toHaveBeenCalledWith('I like jasmine tea', { userEventDocumentId, captureTrace: true });
    // P2/P3 contract: a Recall summary without a traced, verified source span never enters the
    // request. The fixed incomplete-evidence notice is the only memory-facing text.
    expect(calls.some((call) => call.startsWith('memory:[memory] you like tea'))).toBe(false);
    expect(calls.some((call) => call.startsWith('memory:[memory] Supporting source evidence is incomplete'))).toBe(true);
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

  it('withholds a mental-model portrait that has no source evidence', async () => {
    const { p, deferred, calls, injections } = personaWith();
    p.onOpening({ reason: 'new' });
    expect(deferred).toHaveLength(1);
    const text = await deferred[0]!();
    expect(text).toBeNull();
    expect(calls.some((call) => call.startsWith('memory:[memory] portrait'))).toBe(false);
    expect(injections.find((entry) => entry.text.startsWith('[memory] portrait'))).toBeUndefined();
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

  it('moves workspace browsing to the Persona page and keeps the Memory page for long-term memory', () => {
    const { p } = personaWith();
    const decl = p.webUi('en');
    expect(decl.panels?.map((panel) => panel.id)).toEqual(expect.arrayContaining(['workspace', 'history']));
    expect(decl.memory?.panels?.map((panel) => panel.id) ?? []).not.toContain('workspace');
    expect(decl.memory?.panels?.map((panel) => panel.id) ?? []).not.toContain('history');
    const workspaceStorage = (decl.memory?.storage ?? []).find((part) => part.key === 'workspace')!;
    expect(workspaceStorage.label).toContain('Workspace files');
    expect(workspaceStorage.note).toContain('not long-term memory');
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

  it('reports the domain supplement diagnostics as unavailable without memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-persona-memory-'));
    const Persona = coopanionPersona(Cormini);
    const p = new Persona({ memoryDir: dir });
    const invoke = p.webUi('en').invoke;
    expect(invoke).toBeDefined();
    const diagnostics = await invoke!('hindsight', 'domain-supplement-diagnostics', []) as Record<string, unknown>;
    expect(diagnostics).toMatchObject({
      available: false,
      enabled: false,
      receiptState: 'unavailable',
      receiptPresent: false,
      turnActive: false,
      status: null,
      candidateCount: null,
      scope: 'persona-domain-supplement',
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });
});
