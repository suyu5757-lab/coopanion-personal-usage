import { growthContentIssues } from '../core/growth/autonomous.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi, ForkOptions, GenerationEvidenceEnvelope, TimerEntry, TimersApi, ToolDef } from 'cortico/core/types.ts';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona } from '../core/persona.ts';
import type { HindsightMemory, MemoryTextRead } from '../core/memory/hindsight.ts';
import { GROWTH_DEFAULTS, readGrowth } from '../core/growth/config.ts';
import { SELF_REVIEW_TEXT } from '../core/growth/model-text.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { GROWTH_SESSION, GrowthReview, PROPOSE_EXPERIENCE_TOOL, PROPOSE_GROWTH_TOOL } from '../core/growth/review.ts';
import { GrowthSchedule } from '../core/growth/schedule.ts';
import { GrowthProposals, readProposalInput } from '../core/growth/proposals.ts';
import { createResourcePressureReader } from '../core/resource-pressure.ts';

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

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function tempState(): string {
  return join(tempDir('coo-growth-'), 'growth.json');
}

function memoryRead(sourceIds: string[], text = '[memory] Synthetic dated event records.'): {
  text: string;
  status: 'found';
  sourceSegments: Array<{ documentId: string; start: number; end: number }>;
  trace: { format: { includedSourceDocumentIds: string[]; sourceSegments: Array<{ documentId: string; start: number; end: number }> } };
} {
  const sourceSegments = sourceIds.map((documentId) => ({ documentId, start: 0, end: text.length }));
  return { text, status: 'found', sourceSegments, trace: { format: { includedSourceDocumentIds: sourceIds, sourceSegments } } };
}

function generationEnvelope(toolCallId: string): GenerationEvidenceEnvelope {
  return {
    id: `generation:${toolCallId}`,
    sessionId: GROWTH_SESSION,
    sessionGenerationToken: `generation-token:${toolCallId}`,
    providerGenerationId: `provider-generation:${toolCallId}`,
    providerAttemptId: `provider-attempt:${toolCallId}`,
    responseId: `response:${toolCallId}`,
    responseJoinState: 'matched',
    requestState: 'sent',
    exposedSources: [],
    mappingState: 'complete',
    actualEvidenceUsed: 'unknown',
    outputToolCalls: [{
      toolCallId,
      responseId: `response:${toolCallId}`,
      outputDigest: 'a'.repeat(64),
      joinState: 'matched',
    }],
    items: [{
      itemId: `input:${toolCallId}`,
      disposition: 'provably-source-independent',
      mappingState: 'complete',
      exposedSources: [],
      spans: [{
        start: 0, end: 1, digest: 'b'.repeat(64), origin: 'user-input', mappingState: 'complete',
        exposedSources: [], serializedRanges: [],
      }],
    }],
    serializedBodyDigest: 'c'.repeat(64),
  };
}

function generationMemoryMethods() {
  return {
    evidenceEpoch: () => '0:0',
    evidenceForRead: async (read: MemoryTextRead) => {
      const sourceSegments = read.sourceSegments
        ?? read.trace?.format.sourceSegments.map(({ documentId, start, end }) => ({ documentId, start, end }))
        ?? [];
      return sourceSegments.map((segment) => ({
        bankId: 'bank-synthetic',
        endpoint: 'https://bank.invalid',
        documentId: segment.documentId,
        validatedEpoch: '0:0',
        revisionState: 'current' as const,
        validationStatus: 'validated' as const,
        validationReceipt: createHash('sha256').update(`receipt:${segment.documentId}`).digest('hex'),
        contentDigest: createHash('sha256').update(`source:${segment.documentId}`).digest('hex'),
        segment: {
          start: segment.start,
          end: segment.end,
          digest: createHash('sha256').update(read.text.slice(segment.start, segment.end)).digest('hex'),
        },
      }));
    },
    recordGenerationEvidenceEnvelope: () => true,
    registerDerivedArtifactFromSources: async (input: { artifactId: string }) => ({ artifactId: input.artifactId }),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function schedule(stateFile: string, opts: {
  now: () => Date;
  config?: () => { enabled: boolean; everyDays: number };
  run?: () => Promise<void>;
}) {
  const timers = new FakeTimers();
  const run = vi.fn(opts.run ?? (async () => {}));
  const s = new GrowthSchedule({
    stateFile,
    config: opts.config ?? (() => ({ ...GROWTH_DEFAULTS, enabled: true })),
    timers,
    run,
    now: opts.now,
  });
  return { s, timers, run };
}

describe('the growth config', () => {
  it('defaults to off, every seven days', () => {
    expect(readGrowth({})).toEqual({ enabled: false, everyDays: 7 });
  });

  it('clamps the interval and reads the switch', () => {
    expect(readGrowth({ companion: { growth: { enabled: false, everyDays: 0 } } })).toEqual({ enabled: false, everyDays: 1 });
    expect(readGrowth({ companion: { growth: { everyDays: 200 } } })).toEqual({ enabled: false, everyDays: 60 });
  });
});

describe('the self-review prompt', () => {
  it('carries the portrait, the recent stretch and the date, and English has no Chinese', () => {
    const en = SELF_REVIEW_TEXT.en({ portrait: 'You have been softer lately.', recent: 'Person: hello\nCoo: hi', date: '2026-10-26' });
    expect(en).toContain('You have been softer lately.');
    expect(en).toContain('Person: hello');
    expect(en).toContain('2026-10-26');
    expect(en).toContain('propose_growth');
    expect(en).toContain('propose_experience');
    expect(en).toContain('remain a candidate');
    expect(en).not.toMatch(/\p{Script=Han}/u);
    expect(SELF_REVIEW_TEXT.zh({ portrait: '', recent: '', date: '2026-10-26' })).toContain('2026-10-26');
    expect(SELF_REVIEW_TEXT.zh({ portrait: '', recent: '', date: '2026-10-26' })).toContain('提案');
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

  it('keeps automatic review gated while cancellation and budget support is unavailable', async () => {
    let now = new Date('2026-10-01T00:00:00.000Z');
    const timers = new FakeTimers();
    const run = vi.fn(async () => {});
    const s = new GrowthSchedule({
      stateFile: tempState(),
      config: () => ({ enabled: true, everyDays: 7 }),
      timers,
      run,
      now: () => new Date(now),
      allowed: () => false,
    });
    s.start();
    now = new Date('2026-10-20T00:00:00.000Z');
    expect(s.status()).toMatchObject({ enabled: false, blocked: true });
    expect(await s.check()).toBe(false);
    expect(timers.entries).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('waits while the app is paused', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    let pressureNow = 0;
    let output = 'System-wide memory free percentage: 19%';
    const pressure = createResourcePressureReader({
      platform: 'darwin',
      readMacOutput: () => output,
      readMemory: () => ({ freeBytes: 80, totalBytes: 100 }),
    });
    const timers = new FakeTimers();
    const run = vi.fn(async () => {});
    const s = new GrowthSchedule({
      stateFile: tempState(),
      config: () => ({ ...GROWTH_DEFAULTS, enabled: true }),
      timers,
      run,
      now: () => new Date(now),
      paused: () => pressure(pressureNow).paused,
    });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');
    expect(await s.check()).toBe(false);
    output = 'System-wide memory free percentage: 20%';
    pressureNow = 30_000;
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

  it('records the outcome and proposal count', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    const stateFile = tempState();
    const timers = new FakeTimers();
    const s = new GrowthSchedule({
      stateFile,
      config: () => ({ ...GROWTH_DEFAULTS, enabled: true }),
      timers,
      run: async () => ({ proposals: 1, candidateSourceResults: [], note: 'proposed focus mode', cancelled: false }),
      now: () => new Date(now),
    });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');
    await s.check();
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { lastStatus: string; lastProposalCount: number };
    expect(state.lastStatus).toBe('ok');
    expect(state.lastProposalCount).toBe(1);
  });

  it('records unresolved Core cancellation without describing it as a deadline', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    let now = start;
    const stateFile = tempState();
    const s = new GrowthSchedule({
      stateFile,
      config: () => ({ ...GROWTH_DEFAULTS, enabled: true }),
      timers: new FakeTimers(),
      run: async () => ({ proposals: 0, candidateSourceResults: [], note: '', cancelled: true, cancellationStatus: 'unknown' }),
      now: () => new Date(now),
    });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');

    await s.check();

    expect(s.status()).toMatchObject({
      lastStatus: 'failed',
      lastError: 'Core cancellation timed out; tracked fork work remains unresolved',
    });
  });

  it('does not start a second review while an old fork still runs', async () => {
    let now = new Date('2026-10-01T00:00:00.000Z');
    const timers = new FakeTimers();
    const run = vi.fn(async () => {});
    const s = new GrowthSchedule({
      stateFile: tempState(),
      config: () => ({ ...GROWTH_DEFAULTS, enabled: true }),
      timers,
      run,
      now: () => new Date(now),
      forkRunning: () => true,
    });
    s.start();
    now = new Date('2026-10-08T00:00:00.000Z');
    expect(await s.check()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('marks a review interrupted when the process stopped mid-run', () => {
    const stateFile = tempState();
    const start = '2026-10-01T00:00:00.000Z';
    writeFileSync(stateFile, JSON.stringify({
      lastReviewAt: null,
      nextReviewAt: start,
      activeRunId: 'run-1',
      activeStartedAt: start,
    }));
    const s = new GrowthSchedule({
      stateFile,
      config: () => ({ ...GROWTH_DEFAULTS, enabled: true }),
      timers: new FakeTimers(),
      run: async () => {},
      now: () => new Date(start),
    });
    s.start();
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { lastStatus: string; activeRunId?: string };
    expect(state.lastStatus).toBe('interrupted');
    expect(state.activeRunId).toBeUndefined();
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
  return [message('system', 'CONSTITUTION'), message('user', 'hello', {
    sourceIndependentSpans: [{ start: 0, end: 5, digest: createHash('sha256').update('hello').digest('hex'), origin: 'user-input' }],
  })];
}

describe('the growth review session', () => {
  it('allows scheduled reviews only when long-term memory is available', () => {
    const root = tempDir('coo-growth-opt-in-');
    let memoryAvailable = true;
    const memory = {
      enabled: () => memoryAvailable,
      setLifecycleHooks: vi.fn(),
    } as unknown as HindsightMemory;
    const Persona = coopanionPersona(Cormini, {
      memory,
      growth: () => ({ enabled: true, everyDays: 7 }),
      growthStateFile: join(root, 'growth.json'),
      timezone: () => 'UTC',
    });
    const persona = new Persona({ memoryDir: join(root, 'workspace') });
    const core = {
      timers: new FakeTimers(),
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      log: { info: vi.fn(), warn: vi.fn() },
    } as unknown as CoreApi;
    persona.attach(core);
    const review = persona as unknown as { growthSchedule: GrowthSchedule | null; stopGrowth(): void };

    expect(review.growthSchedule?.status()).toMatchObject({ enabled: true, blocked: false });
    memoryAvailable = false;
    expect(review.growthSchedule?.status()).toMatchObject({ enabled: false, blocked: true });
    review.stopGrowth();
    rmSync(root, { recursive: true, force: true });
  });

  it('feeds the system prefix, the recent stretch and the portrait to a fork with read tools and a proposal tool', async () => {
    const captured: ForkOptions[] = [];
    const spawnFork = vi.fn(async (opts: ForkOptions) => { captured.push(opts); return ''; });
    const core = {
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      generationEvidence: () => [],
      spawnFork,
      spawnForkWithOutcome: vi.fn(async (opts: ForkOptions) => ({ status: 'completed' as const, text: await spawnFork(opts) })),
    } as unknown as CoreApi;
    const memory = {
      enabled: () => true,
      selfPortrait: vi.fn(async () => 'You have been softer lately.'),
    } as unknown as HindsightMemory;
    const proposalsDir = tempDir('coo-growth-proposals-');
    const review = new GrowthReview({
      core: () => core,
      snapshot: prefix,
      tools: () => [tool('read_file'), tool('memory_search')],
      memory: () => memory,
      proposalsDir,
      modelLanguage: () => 'en',
      timezone: () => 'UTC',
      now: () => new Date('2026-10-26T10:00:00.000Z'),
    });
    expect(await review.run()).toMatchObject({ cancelled: false });
    const opts = captured[0]!;
    expect(opts.id).toBe(GROWTH_SESSION);
    expect(opts.messages).toHaveLength(2);
    expect(opts.messages[0]!.item.type === 'message' && opts.messages[0]!.item.role).toBe('system');
    expect(textOf(opts.messages[1]!)).toContain('You have been softer lately.');
    expect(textOf(opts.messages[1]!)).toContain('Person: hello');
    expect(textOf(opts.messages[1]!)).toContain('2026-10-26');
    expect(textOf(opts.messages[1]!)).toContain('propose_experience');
    expect(textOf(opts.messages[1]!)).toContain('remain a candidate for the person\'s review');
    expect(opts.tools?.map((entry) => entry.name)).toEqual(['read_file', 'memory_search', PROPOSE_GROWTH_TOOL, PROPOSE_EXPERIENCE_TOOL, 'finish_review']);
  });

  it('reports an unknown Core cancellation instead of treating an empty fork as a completed review', async () => {
    const core = {
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      generationEvidence: () => [],
      spawnFork: vi.fn(async () => ''),
      spawnForkWithOutcome: vi.fn(async () => ({ status: 'cancelled' as const, invalidationStatus: 'unknown' as const })),
    } as unknown as CoreApi;
    const review = new GrowthReview({
      core: () => core,
      snapshot: prefix,
      tools: () => [],
      memory: () => null,
      proposalsDir: tempDir('coo-growth-proposals-'),
      modelLanguage: () => 'en',
      timezone: () => 'UTC',
    });

    const result = await review.run();

    expect(result).toEqual({ proposals: 0, note: '', cancelled: true, cancellationStatus: 'unknown', candidateSourceResults: [] });
    expect(core.spawnForkWithOutcome).toHaveBeenCalledOnce();
    expect(core.spawnFork).not.toHaveBeenCalled();
  });

  it('does not run a review when Core cannot report fork outcomes', async () => {
    const core = {
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      generationEvidence: () => [],
      spawnFork: vi.fn(async () => ''),
    } as unknown as CoreApi;
    const review = new GrowthReview({
      core: () => core,
      snapshot: prefix,
      tools: () => [],
      memory: () => null,
      proposalsDir: tempDir('coo-growth-proposals-'),
      modelLanguage: () => 'en',
      timezone: () => 'UTC',
    });

    await expect(review.run()).rejects.toThrow('Core does not report fork outcomes');
    expect(core.spawnFork).not.toHaveBeenCalled();
  });

  it('declares a growth session with read and memory tools but no file writes or speaking', () => {
    const Persona = coopanionPersona(Cormini, { growthStateFile: join(tempDir('coo-growth-persona-'), 'growth.json'), timezone: () => 'UTC' });
    const p = new Persona({ memoryDir: tempDir('coo-growth-workspace-') });
    const growth = p.declareSessions().find((session) => session.id === GROWTH_SESSION)!;
    const names = growth.tools().map((entry) => entry.name);
    expect(growth.persistent).toBe(false);
    expect(growth.receivesEvents).toBe(false);
    expect(names).toContain('read_file');
    expect(names).toContain('memory_search');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('append_file');
    expect(names).not.toContain(PROPOSE_GROWTH_TOOL);
    expect(names).not.toContain('pet_say');
    expect(names).not.toContain('delete_file');
    expect(names).not.toContain('save_blob');
  });

  it('saves a proposal as a candidate file and never touches the Persona', async () => {
    const captured: ForkOptions[] = [];
    const spawnFork = vi.fn(async (opts: ForkOptions) => {
      captured.push(opts);
      const search = opts.tools!.find((entry) => entry.name === 'memory_search')!;
      await search.handler({ query: 'coding preferences' }, {} as never);
      const propose = opts.tools!.find((entry) => entry.name === PROPOSE_GROWTH_TOOL)!;
      const finish = opts.tools!.find((entry) => entry.name === 'finish_review')!;
      const result = await propose.handler({
        title: 'Focus mode',
        summary: 'Be quieter while the person is programming.',
        evidence: ['Person: 我写程序的时候别总来打扰'],
        sourceIds: ['user-turn-42'],
        risk: 'low',
        changes: [{ file: 'CONSTITUTION.md', from: 'old line', to: 'new line', reason: 'the person asked for quiet' }],
      }, { role: GROWTH_SESSION, callId: 'growth-proposal-call' } as never);
      expect(typeof result === 'string' ? result : result.text).toBe('[proposal saved]');
      await finish.handler({ note: 'proposed focus mode' }, {} as never);
      return '';
    });
    const core = {
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      generationEvidence: () => [generationEnvelope('growth-proposal-call')],
      spawnFork,
      spawnForkWithOutcome: vi.fn(async (opts: ForkOptions) => ({ status: 'completed' as const, text: await spawnFork(opts) })),
    } as unknown as CoreApi;
    const proposalsDir = tempDir('coo-growth-proposals-');
    const memory = {
      enabled: () => true,
      sourceVisible: () => true,
      hasSource: async () => true,
      recallBlockDetailed: async () => memoryRead(['user-turn-42']),
      selfPortrait: async () => '',
      ...generationMemoryMethods(),
    } as unknown as HindsightMemory;
    const review = new GrowthReview({
      core: () => core,
      snapshot: prefix,
      tools: () => [],
      memory: () => memory,
      proposalsDir,
      modelLanguage: () => 'en',
      timezone: () => 'UTC',
    });
    const result = await review.run();
    expect(result.proposals).toBe(1);
    const stored = new GrowthProposals(proposalsDir).list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toBe('candidate');
    expect(stored[0]!.changes[0]!.file).toBe('CONSTITUTION.md');
    expect(captured[0]!.tools?.some((entry) => ['write_file', 'edit_file', 'append_file'].includes(entry.name))).toBe(false);
  });

  it('stores a repeated experience as an inactive source-linked candidate', async () => {
    const captured: ForkOptions[] = [];
    const spawnFork = vi.fn(async (opts: ForkOptions) => {
      captured.push(opts);
      const search = opts.tools!.find((entry) => entry.name === 'memory_search')!;
      await search.handler({ query: 'repeated experiences' }, {} as never);
      const propose = opts.tools!.find((entry) => entry.name === PROPOSE_EXPERIENCE_TOOL)!;
      const finish = opts.tools!.find((entry) => entry.name === 'finish_review')!;
      const saved = await propose.handler({
        title: 'Quiet coding time',
        situation: 'The person is coding.',
        lesson: 'Wait before routine interruptions.',
        scope: 'proactive_speech',
        sourceIds: ['user:focus-1', 'user:focus-2'],
      }, { role: GROWTH_SESSION, callId: 'experience-proposal-call' } as never);
      expect(typeof saved === 'string' ? saved : saved.text).toBe('[experience candidate saved]');
      expect(await propose.handler({
        title: 'Unsearched source', situation: 'A situation.', lesson: 'A lesson.', scope: 'conversation',
        sourceIds: ['user:not-returned-1', 'user:not-returned-2'],
      }, {} as never)).toContain('was not returned by memory_search');
      hiddenSources.add('user:forgotten');
      expect(await propose.handler({
        title: 'Forgotten source', situation: 'A situation.', lesson: 'A lesson.', scope: 'conversation', sourceIds: ['user:focus-1', 'user:forgotten'],
      }, { role: GROWTH_SESSION, callId: 'experience-forgotten-call' } as never)).toContain('[candidate rejected] Source user:forgotten is missing or fenced.');
      expect(await propose.handler({
        title: 'Same-day repeats', situation: 'A situation.', lesson: 'A lesson.', scope: 'conversation',
        sourceIds: ['user:focus-1', 'user:focus-same-day'],
      }, { role: GROWTH_SESSION, callId: 'experience-same-day-call' } as never)).toContain('[candidate rejected] User-event sources must span different dates.');
      expect(await propose.handler({
        title: 'Undated event', situation: 'A situation.', lesson: 'A lesson.', scope: 'conversation',
        sourceIds: ['user:focus-1', 'user:undated'],
      }, { role: GROWTH_SESSION, callId: 'experience-undated-call' } as never)).toContain('has no verifiable user-event date');
      await finish.handler({ note: 'saved a recurring experience' }, {} as never);
      return '';
    });
    const core = {
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      generationEvidence: () => [
        generationEnvelope('experience-proposal-call'),
        generationEnvelope('experience-forgotten-call'),
        generationEnvelope('experience-same-day-call'),
        generationEnvelope('experience-undated-call'),
      ],
      spawnFork,
      spawnForkWithOutcome: vi.fn(async (opts: ForkOptions) => ({ status: 'completed' as const, text: await spawnFork(opts) })),
    } as unknown as CoreApi;
    const proposalsDir = tempDir('coo-growth-proposals-');
    const experienceCardsDir = join(proposalsDir, 'experience-cards');
    const hiddenSources = new Set<string>();
    const memory = {
      enabled: () => true,
      sourceVisible: (id: string) => !hiddenSources.has(id),
      hasSource: async (id: string) => !hiddenSources.has(id),
      ...generationMemoryMethods(),
      sourceEvidence: async (id: string) => hiddenSources.has(id)
        ? { present: false, visible: false, actor: null, status: null }
        : id === 'user:undated'
          ? { present: true, visible: true, actor: 'user', status: 'completed', kind: 'event' }
        : {
            present: true,
            visible: true,
            actor: 'user',
            status: 'completed',
            kind: 'event',
            occurredAt: id.endsWith('-1') || id.endsWith('-same-day') ? '2026-10-01T12:00:00.000Z' : '2026-10-08T12:00:00.000Z',
          },
      recallBlockDetailed: async () => memoryRead(['user:focus-1', 'user:focus-2', 'user:focus-same-day', 'user:undated', 'user:forgotten']),
      selfPortrait: async () => '',
    } as unknown as HindsightMemory;
    const review = new GrowthReview({
      core: () => core,
      snapshot: prefix,
      tools: () => [],
      memory: () => memory,
      proposalsDir,
      experienceCardsDir,
      modelLanguage: () => 'en',
      timezone: () => 'UTC',
    });

    const result = await review.run();
    const cards = new ExperienceCards(experienceCardsDir).list();

    expect(result.proposals).toBe(1);
    expect(cards).toMatchObject([{
      title: 'Quiet coding time',
      sourceIds: ['user:focus-1', 'user:focus-2'],
      state: 'candidate',
      userExplicit: false,
    }]);
    expect(new GrowthProposals(proposalsDir).list()).toHaveLength(0);
    expect(captured[0]!.tools?.some((entry) => ['write_file', 'edit_file', 'append_file'].includes(entry.name))).toBe(false);
  });

  it('stops accepting proposals after the deadline', async () => {
    const captured: ForkOptions[] = [];
    const read = vi.fn(async () => 'file contents');
    const never = new Promise<string>(() => {});
    const core = {
      sessionInfo: () => ({ snapshot: prefix(), running: 0 }),
      generationEvidence: () => [],
      spawnFork: vi.fn((opts: ForkOptions) => {
        captured.push(opts);
        return never;
      }),
      spawnForkWithOutcome: vi.fn((opts: ForkOptions) => {
        captured.push(opts);
        return new Promise<import('cortico/core/types.ts').ForkOutcome>(() => {});
      }),
    } as unknown as CoreApi;
    const proposalsDir = tempDir('coo-growth-proposals-');
    const review = new GrowthReview({
      core: () => core,
      snapshot: prefix,
      tools: () => [{ ...tool('read_file'), handler: read }],
      memory: () => null,
      proposalsDir,
      modelLanguage: () => 'en',
      timezone: () => 'UTC',
      timeoutMs: 10,
    });
    await expect(review.run()).rejects.toThrow(/timed out/);
    const propose = captured[0]!.tools!.find((entry) => entry.name === PROPOSE_GROWTH_TOOL)!;
    const result = await propose.handler({
      title: 'Late',
      summary: 'Should not be written.',
      evidence: ['person said so'],
      sourceIds: ['user-turn-late'],
      risk: 'low',
      changes: [{ file: 'CONSTITUTION.md', to: 'line', reason: 'because' }],
    }, {} as never);
    expect(result).toContain('[review cancelled]');
    expect(new GrowthProposals(proposalsDir).list()).toHaveLength(0);
    const proposeExperience = captured[0]!.tools!.find((entry) => entry.name === PROPOSE_EXPERIENCE_TOOL)!;
    expect(await proposeExperience.handler({
      title: 'Late card', situation: 'A situation.', lesson: 'A lesson.', scope: 'conversation', sourceIds: ['source-late'],
    }, {} as never)).toContain('[review cancelled]');
    expect(new ExperienceCards(join(proposalsDir, 'experience-cards')).list()).toHaveLength(0);
    const lateRead = captured[0]!.tools!.find((entry) => entry.name === 'read_file')!;
    expect(await lateRead.handler({ path: 'SELF.md' }, {} as never)).toContain('[review cancelled]');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('growth proposal validation', () => {
  it('rejects changes outside the two allowed files and empty evidence', () => {
    const bad = readProposalInput({
      title: 'x',
      summary: 'y',
      evidence: [],
      risk: 'low',
      changes: [{ file: 'seed.txt', to: 'z', reason: 'r' }],
    });
    expect('errors' in bad).toBe(true);
  });

  it('accepts a minimal proposal', () => {
    const good = readProposalInput({
      title: 'Focus mode',
      summary: 'Be quieter while the person programs.',
      evidence: ['Person: 我写程序的时候别总来打扰'],
      sourceIds: ['user-turn-42'],
      risk: 'low',
      changes: [{ file: 'CONSTITUTION.md', to: 'When they program, wait.', reason: 'asked explicitly' }],
    });
    expect('proposal' in good).toBe(true);
  });
});

describe('Growth content consistency checks', () => {
  const sources = [
    { actor: 'user', kind: 'event', saidAt: '2026-10-01T10:00:00Z', storedText: 'Please let me focus quietly.' },
    { actor: 'user', kind: 'event', saidAt: '2026-10-08T10:00:00Z', storedText: 'I prefer quiet focus again.' },
  ] as import('../core/memory/hindsight.ts').ExactMemorySourceEvidence[];
  const candidate = (summary: string) => ({ summary, evidence: [] }) as unknown as import('../core/growth/proposals.ts').GrowthProposal;
  it('accepts seven days and one week, and rejects two weeks, fourteen days and reversed dates', () => {
    expect(growthContentIssues(candidate('Twice, seven days apart.'), sources)).toEqual([]);
    expect(growthContentIssues(candidate('Two user requests, one week apart.'), sources)).toEqual([]);
    for (const text of ['Two weeks apart.', 'Fourteen days apart.', '相隔两周。']) expect(growthContentIssues(candidate(text), sources).join()).toContain('= 7 days, not 14');
    expect(growthContentIssues(candidate('2026-10-08 happened before 2026-10-01.'), sources)).toContain('date_order_mismatch');
  });
  it('rejects invented event counts and unsupported direct quotes while preserving user-stated preferences', () => {
    expect(growthContentIssues(candidate('Three separate user requests.'), sources).join()).toContain('event_count_not_supported');
    expect(growthContentIssues({ ...candidate('A preference, not an external fact.'), evidence: ['The user said “Please let me focus quietly.”'] }, sources)).toEqual([]);
    expect(growthContentIssues({ ...candidate('A claim.'), evidence: ['The user said “I grant unlimited tool permissions.”'] }, sources)).toContain('literal_quote_not_supported_by_sources');
  });
});
