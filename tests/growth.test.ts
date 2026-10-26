import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CoreApi, ForkOptions, TimerEntry, TimersApi, ToolDef } from 'cortico/core/types.ts';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona } from '../core/persona.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';
import { GROWTH_DEFAULTS, readGrowth } from '../core/growth/config.ts';
import { SELF_REVIEW_TEXT } from '../core/growth/model-text.ts';
import { GROWTH_SESSION, GrowthReview } from '../core/growth/review.ts';
import { GrowthSchedule } from '../core/growth/schedule.ts';

class FakeTimers implements TimersApi {
  entries: TimerEntry[] = [];
  private handler: ((entry: TimerEntry) => void) | null = null;
  private next = 1;

  set(atIso: string, payload: Record<string, unknown> = {}): { ok: true; id: string } | { ok: false; error: string } {
    const id = `t${this.next++}`;
    this.entries.push({ id, atIso, payload });
    return { ok: true, id };
  }

  cancel(id: string): boolean {
    const at = this.entries.findIndex((entry) => entry.id === id);
    if (at < 0) return false;
    this.entries.splice(at, 1);
    return true;
  }

  list(): ReadonlyArray<TimerEntry> {
    return this.entries;
  }

  clearAll(): number {
    const count = this.entries.length;
    this.entries = [];
    return count;
  }

  onDue(handler: (entry: TimerEntry) => void): void {
    this.handler = handler;
  }
}

function tempState(): string {
  return join(mkdtempSync(join(tmpdir(), 'coo-growth-')), 'growth.json');
}

function schedule(stateFile: string, opts: {
  now: () => Date;
  config?: () => { enabled: boolean; everyDays: number };
  run?: () => Promise<void>;
}) {
  const timers = new FakeTimers();
  const run = vi.fn(opts.run ?? (async () => {}));
  const s = new GrowthSchedule({
    stateFile,
    config: opts.config ?? (() => ({ ...GROWTH_DEFAULTS })),
    timers,
    run,
    now: opts.now,
  });
  return { s, timers, run };
}

describe('the growth config', () => {
  it('defaults to on, every seven days', () => {
    expect(readGrowth({})).toEqual({ enabled: true, everyDays: 7 });
  });

  it('clamps the interval and reads the switch', () => {
    expect(readGrowth({ companion: { growth: { enabled: false, everyDays: 0 } } })).toEqual({ enabled: false, everyDays: 1 });
    expect(readGrowth({ companion: { growth: { everyDays: 200 } } })).toEqual({ enabled: true, everyDays: 60 });
  });
});

describe('the self-review prompt', () => {
  it('carries the portrait, the recent stretch and the date, and English has no Chinese', () => {
    const en = SELF_REVIEW_TEXT.en({ portrait: 'You have been softer lately.', recent: 'Person: hello\nCoo: hi', date: '2026-10-26' });
    expect(en).toContain('You have been softer lately.');
    expect(en).toContain('Person: hello');
    expect(en).toContain('2026-10-26');
    expect(en).not.toMatch(/\p{Script=Han}/u);
    expect(SELF_REVIEW_TEXT.zh({ portrait: '', recent: '', date: '2026-10-26' })).toContain('2026-10-26');
  });
});

describe('the growth schedule', () => {
  it('waits a whole interval before the first review', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    const { s, timers, run } = schedule(tempState(), { now: () => new Date(now) });
    s.start();
    expect(run).not.toHaveBeenCalled();
    expect(timers.entries).toHaveLength(1);
    expect(timers.entries[0]!.atIso).toBe('2026-10-08T00:00:00.000Z');
    now = new Date('2026-10-07T23:00:00.000Z');
    expect(await s.check()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs once due and quiet, then sets the next interval', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    const stateFile = tempState();
    const { s, timers, run } = schedule(stateFile, { now: () => new Date(now) });
    s.start();
    now = new Date('2026-10-08T00:01:00.000Z');
    expect(await s.check()).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { lastReviewAt: string; nextReviewAt: string };
    expect(state.lastReviewAt).toBe(now.toISOString());
    expect(state.nextReviewAt).toBe('2026-10-15T00:01:00.000Z');
    expect(timers.entries[0]!.atIso).toBe(state.nextReviewAt);
  });

  it('waits for quiet after the person was active', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    const { s, run } = schedule(tempState(), { now: () => new Date(now) });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');
    s.noteActivity();
    now = new Date('2026-10-08T00:14:00.000Z');
    expect(await s.check()).toBe(false);
    now = new Date('2026-10-08T00:16:00.000Z');
    expect(await s.check()).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('retries an hour after a failed review and keeps the last successful date', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    const stateFile = tempState();
    const run = vi.fn(async () => { throw new Error('model unavailable'); });
    const { s } = schedule(stateFile, { now: () => new Date(now), run });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');
    expect(await s.check()).toBe(true);
    const failed = JSON.parse(readFileSync(stateFile, 'utf8')) as { lastReviewAt: string | null; nextReviewAt: string };
    expect(failed.lastReviewAt).toBeNull();
    expect(failed.nextReviewAt).toBe('2026-10-08T01:00:00.000Z');
    now = new Date('2026-10-08T00:59:00.000Z');
    expect(await s.check()).toBe(false);
    now = new Date('2026-10-08T01:01:00.000Z');
    expect(await s.check()).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the switch is off', async () => {
    let now = new Date('2026-10-01T00:00:00.000Z');
    const { s, timers, run } = schedule(tempState(), {
      now: () => new Date(now),
      config: () => ({ enabled: false, everyDays: 7 }),
    });
    s.start();
    expect(timers.entries).toHaveLength(0);
    now = new Date('2026-10-20T00:00:00.000Z');
    expect(await s.check()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('waits while the app is paused', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    let paused = true;
    const timers = new FakeTimers();
    const run = vi.fn(async () => {});
    const s = new GrowthSchedule({
      stateFile: tempState(),
      config: () => ({ ...GROWTH_DEFAULTS }),
      timers,
      run,
      now: () => new Date(now),
      paused: () => paused,
    });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');
    expect(await s.check()).toBe(false);
    paused = false;
    expect(await s.check()).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('recomputes the next date when the interval changes', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    let config = { enabled: true, everyDays: 7 };
    const { s, run } = schedule(tempState(), { now: () => new Date(now), config: () => config });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');
    await s.check();
    config = { enabled: true, everyDays: 1 };
    now = new Date('2026-10-09T00:00:00.000Z');
    s.restart();
    expect(await s.check()).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

const tool = (name: string): ToolDef => ({
  name,
  description: name,
  tags: ['read'],
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => `[${name}]`,
});

function prefix(): ContextRecord[] {
  return [message('system', 'CONSTITUTION'), message('user', 'hello')];
}

describe('the growth review session', () => {
  it('feeds the system prefix, the recent stretch and the portrait to a fork with file tools and no speaking tool', async () => {
    const captured: ForkOptions[] = [];
    const core = {
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      spawnFork: vi.fn(async (opts: ForkOptions) => { captured.push(opts); return ''; }),
    } as unknown as CoreApi;
    const memory = {
      enabled: () => true,
      selfPortrait: vi.fn(async () => 'You have been softer lately.'),
    } as unknown as HindsightMemory;
    const review = new GrowthReview({
      core: () => core,
      snapshot: prefix,
      tools: () => [tool('read_file')],
      memory: () => memory,
      modelLanguage: () => 'en',
      timezone: () => 'UTC',
      now: () => new Date('2026-10-26T10:00:00.000Z'),
    });
    await review.run();
    const opts = captured[0]!;
    expect(opts.id).toBe(GROWTH_SESSION);
    expect(opts.messages).toHaveLength(2);
    expect(opts.messages[0]!.item.type === 'message' && opts.messages[0]!.item.role).toBe('system');
    expect(textOf(opts.messages[1]!)).toContain('You have been softer lately.');
    expect(textOf(opts.messages[1]!)).toContain('Person: hello');
    expect(textOf(opts.messages[1]!)).toContain('2026-10-26');
    expect(opts.tools?.map((entry) => entry.name)).toEqual(['read_file', 'finish_review']);
  });

  it('declares a growth session with no speaking, deletion or computer use', () => {
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(mkdtempSync(join(tmpdir(), 'coo-growth-persona-')), 'growth.json'), timezone: () => 'UTC' });
    const p = new Persona({ memoryDir: mkdtempSync(join(tmpdir(), 'coo-growth-workspace-')) });
    const growth = p.declareSessions().find((session) => session.id === GROWTH_SESSION)!;
    const names = growth.tools().map((entry) => entry.name);
    expect(growth.persistent).toBe(false);
    expect(growth.receivesEvents).toBe(false);
    expect(names).toContain('edit_file');
    expect(names).toContain('memory_search');
    expect(names).not.toContain('pet_say');
    expect(names).not.toContain('delete_file');
    expect(names).not.toContain('save_blob');
  });
});
