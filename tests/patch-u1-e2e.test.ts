import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, ToolCallContext, ToolDef, ToolOutcome, World, WorldHost } from 'cortico/core/types.ts';
import { BrowserTaskActionJournal } from '../core/browser/task-actions.ts';
import type { BrowserTransport } from '../core/browser/bridge.ts';
import { SELF_TIME_DEFAULTS } from '../core/browser/config.ts';
import { BrowserWorld } from '../core/browser/world.ts';
import { ActionGate } from '../core/action-gate.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import {
  FakeLLM,
  makeCfg,
  makeFakePersona,
  makeLoaded,
  makeTmpDir,
  toolReply,
} from '../vendor/cortico/tests/core/helpers.ts';
import { GENERATION_INVALIDATED } from '../vendor/cortico/src/core/markers.ts';
import type { PageState } from '../core/browser/model-text.ts';

const ITEM_ONE = 'https://synthetic.invalid/item/one';
const ITEM_TWO = 'https://synthetic.invalid/item/two';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function syntheticPage(url: string, liked = false): PageState {
  const key = url.endsWith('/two') ? 'two' : 'one';
  const title = `Synthetic ${key}`;
  return {
    url,
    title,
    header: title,
    content: '*[2]<button>Like</button>',
    footer: '',
    video: null,
    snapshotId: `snapshot-${key}`,
    elements: [{ id: 2, label: liked ? 'Liked' : 'Like', pressed: liked }],
    current: {
      url,
      title,
      itemId: key,
      authorRef: 'https://synthetic.invalid/profile/author',
      authorLabel: 'Synthetic author',
      contentSnippet: title,
      containerIdentity: `article:${key}`,
      playing: false,
      observedAt: 1,
    },
    account: { ref: 'account:synthetic', label: 'Synthetic account' },
  };
}

class SyntheticBrowserTransport implements BrowserTransport {
  readonly calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  readonly clickTargets: string[] = [];
  readonly firstClickStarted = deferred<void>();
  readonly firstClickResult = deferred<'success' | 'error'>();
  private readonly listeners = new Set<(event: 'closed') => void>();
  private state = syntheticPage(ITEM_ONE);

  constructor(private readonly holdFirstClick: boolean) {}

  async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ op, args });
    if (op === 'open') {
      this.state = syntheticPage(String(args.url ?? ITEM_ONE));
      return this.state;
    }
    if (op === 'read') return this.state;
    if (op === 'element') {
      const control = this.state.elements?.find((entry) => entry.id === args.index);
      if (!control) return null;
      return {
        id: control.id,
        tag: 'button',
        text: control.label,
        label: control.label,
        type: '',
        placeholder: '',
        aria: '',
        title: '',
        role: 'button',
        dataE2e: 'like-button',
        pressed: control.pressed,
        href: '',
        disabled: false,
        visible: true,
        filePicker: false,
        snapshotId: this.state.snapshotId,
      };
    }
    if (op === 'click') {
      this.clickTargets.push(this.state.current?.url ?? this.state.url);
      if (this.holdFirstClick && this.clickTargets.length === 1) {
        this.firstClickStarted.resolve(undefined);
        const outcome = await this.firstClickResult.promise;
        if (outcome === 'error') throw new Error('late synthetic result');
      }
      this.state = syntheticPage(this.state.url, true);
      return { answer: { success: true }, state: this.state };
    }
    return this.state;
  }

  onEvent(listener: (event: 'closed') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

interface ToolCapture {
  started: Deferred<ToolCallContext>;
  done: Deferred<ToolOutcome>;
}

interface Rig {
  core: Core;
  llm: FakeLLM;
  bridge: SyntheticBrowserTransport;
  captures: Map<string, ToolCapture>;
  counters: { gateChecks: number; approvals: number };
  api(): CoreApi;
  host(): WorldHost;
}

const activeCores: Core[] = [];
const temporaryCleanup: Array<() => void> = [];

afterEach(async () => {
  for (const core of activeCores.splice(0)) await core.stop();
  for (const cleanup of temporaryCleanup.splice(0)) cleanup();
});

function makeRig(opts: {
  rootDir: string;
  taskJournalFile: string;
  bridge: SyntheticBrowserTransport;
  growthTools: ToolDef[];
  captures?: Map<string, ToolCapture>;
}): Rig {
  const captures = opts.captures ?? new Map<string, ToolCapture>();
  const counters = { gateChecks: 0, approvals: 0 };
  const gate = new ActionGate({
    platformWrites: () => { counters.gateChecks++; return true; },
    imageGeneration: () => false,
    imageSaving: () => false,
    mediaUpload: () => false,
    mediaDownload: () => false,
    computerInput: () => false,
    desktopTargetAllowed: () => false,
  });
  const browser = new BrowserWorld({
    bridge: opts.bridge,
    selfTime: () => ({ ...SELF_TIME_DEFAULTS, enabled: true, actions: true, sessionUnlimited: true }),
    modelLanguage: () => 'en',
    language: () => 'en',
    timezone: 'UTC',
    gate,
    ask: async () => { counters.approvals++; return 'yes'; },
    taskJournalFile: opts.taskJournalFile,
  });
  const browserTools = browser.tools().map((tool) => {
    const handler = tool.handler;
    return {
      ...tool,
      handler: async (args: Record<string, unknown>, ctx: ToolCallContext) => {
        const capture = ctx.callId ? captures.get(ctx.callId) : undefined;
        capture?.started.resolve(ctx);
        const result = await handler(args, ctx);
        capture?.done.resolve(typeof result === 'string' ? { text: result } : result);
        return result;
      },
    };
  });
  let worldHost: WorldHost | null = null;
  const world: World = {
    id: browser.id,
    envPromptVars: () => ({}),
    tools: () => browserTools,
    start: async (host) => { worldHost = host; await browser.start(host); },
    stop: async () => { await browser.stop(); },
  };
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  const persona = makeFakePersona([], {
    cfg: config,
    worlds: [world],
    silent: true,
    extraSessions: [{
      id: 'growth',
      label: 'Growth',
      persistent: false,
      receivesEvents: false,
      rounds: () => ({ soft: 1, hard: 2 }),
      tools: () => [...browserTools, ...opts.growthTools],
    }],
  });
  let api: CoreApi | null = null;
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };
  const llm = new FakeLLM();
  const core = new Core(makeLoaded({
    config,
    rootDir: opts.rootDir,
    memoryDir: join(opts.rootDir, 'persona'),
    dataDir: join(opts.rootDir, 'data'),
  }), { persona, worlds: [world], llm });
  activeCores.push(core);
  return {
    core,
    llm,
    bridge: opts.bridge,
    captures,
    counters,
    api: () => {
      if (!api) throw new Error('CoreApi was not attached');
      return api;
    },
    host: () => {
      if (!worldHost) throw new Error('Browser World has not started');
      return worldHost;
    },
  };
}

async function pushTrigger(rig: Rig): Promise<void> {
  await rig.host().pushEvent({
    type: 'browser.synthetic',
    source: 'browser',
    senderKey: 'browser.synthetic',
    ts: new Date().toISOString(),
    text: 'Run one synthetic browser tool.',
  }, { trigger: 'flush' });
}

function readToolLog(core: Core): string {
  const file = join(core.run.dir, 'toolcalls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('Patch U1 cancellation and BrowserWorld action receipt integration', () => {
  it('keeps an unknown click unresolved across generations, late results, and receipt reopen', async () => {
    const temporary = makeTmpDir();
    temporaryCleanup.push(temporary.cleanup);
    const taskJournalFile = join(temporary.dir, 'browser', 'task-actions.json');
    const browserBridge = new SyntheticBrowserTransport(true);

    const safeStarted = deferred<ToolCallContext>();
    const safeWait: ToolDef = {
      name: 'generation_wait', description: '', tags: ['read'], parameters: {},
      handler: async (_args, ctx) => {
        safeStarted.resolve(ctx);
        await new Promise<void>((resolve) => {
          const signal = ctx.generationSignal;
          if (!signal) throw new Error('the Core did not supply a generation signal');
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'stale safe result';
      },
    };
    let staleDispatches = 0;
    const afterCancel: ToolDef = {
      name: 'after_generation_cancel', description: '', tags: ['act'], parameters: {},
      handler: async () => { staleDispatches++; return 'should not run'; },
    };
    const emptyGrowth: ToolDef = {
      name: 'empty_growth_result', description: '', tags: ['read'], parameters: {}, handler: async () => '',
    };
    const unknownStarted = deferred<ToolCallContext>();
    const releaseUnknown = deferred<string>();
    const unknownGrowth: ToolDef = {
      name: 'unknown_growth_result', description: '', tags: ['read'], parameters: {},
      handler: async (_args, ctx) => { unknownStarted.resolve(ctx); return releaseUnknown.promise; },
    };
    const shutdownStarted = deferred<ToolCallContext>();
    const shutdownGrowth: ToolDef = {
      name: 'shutdown_growth_result', description: '', tags: ['read'], parameters: {},
      handler: async (_args, ctx) => {
        shutdownStarted.resolve(ctx);
        await new Promise<void>((resolve) => {
          const signal = ctx.shutdownSignal;
          if (!signal) throw new Error('the Core did not supply a shutdown signal');
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'stale shutdown result';
      },
    };
    const growthTools = [safeWait, afterCancel, emptyGrowth, unknownGrowth, shutdownGrowth];

    const e1Capture = { started: deferred<ToolCallContext>(), done: deferred<ToolOutcome>() };
    const e2Capture = { started: deferred<ToolCallContext>(), done: deferred<ToolOutcome>() };
    const firstCaptures = new Map<string, ToolCapture>([
      ['e1-click', e1Capture],
      ['e2-new-call-id', e2Capture],
    ]);
    const firstRig = makeRig({
      rootDir: temporary.dir,
      taskJournalFile,
      bridge: browserBridge,
      growthTools,
      captures: firstCaptures,
    });
    firstRig.llm.script(
      toolReply([{ name: 'browser_open', args: { url: ITEM_ONE }, id: 'e1-open' }]),
      toolReply([{ name: 'browser_read', id: 'e1-read' }]),
      toolReply([{ name: 'browser_click', args: { index: 2 }, id: 'e1-click' }]),
    );
    await firstRig.core.start();
    await pushTrigger(firstRig);

    const e1Context = await e1Capture.started.promise;
    await browserBridge.firstClickStarted.promise;
    expect(browserBridge.clickTargets).toEqual([ITEM_ONE]);
    const initialReceipt = new BrowserTaskActionJournal(taskJournalFile).listUnresolved()[0];
    expect(initialReceipt).toMatchObject({ phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown' });
    expect(initialReceipt?.taskId).toBe('main:e1-click');

    const e1Invalidation = await firstRig.api().invalidateGeneration!({
      sessionId: e1Context.sessionId!,
      expectedGeneration: e1Context.generationToken!,
      reason: 'forget',
      idempotencyKey: 'e1-cancel-main-click',
    });
    expect(e1Invalidation).toMatchObject({
      status: 'unknown',
      currentGeneration: expect.any(String),
      receiptRef: expect.stringMatching(/^generation-receipt:/),
    });
    if (e1Invalidation.status !== 'unknown') throw new Error('expected unknown invalidation');
    expect(e1Invalidation.currentGeneration).not.toBe(e1Context.generationToken);
    expect(e1Context.generationSignal?.aborted).toBe(true);
    expect(e1Context.shutdownSignal?.aborted).toBe(false);
    expect(browserBridge.clickTargets).toHaveLength(1);
    expect(JSON.stringify(firstRig.core.session.records)).toContain(GENERATION_INVALIDATED);
    expect(new BrowserTaskActionJournal(taskJournalFile).findByTaskId('main:e1-click'))
      .toMatchObject({ phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown' });

    firstRig.llm.script(toolReply([{ name: 'browser_click', args: { index: 2 }, id: 'e2-new-call-id' }]));
    const e2Fork = await firstRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] });
    expect(e2Fork.status).toBe('completed');
    const e2Context = await e2Capture.started.promise;
    expect(e2Context.generationToken).not.toBe(e1Context.generationToken);
    expect(e2Context.callId).toBe('e2-new-call-id');
    expect(browserBridge.clickTargets).toHaveLength(1);
    expect(firstRig.counters.approvals).toBe(1);

    firstRig.llm.script(toolReply([{ name: 'browser_click', args: { index: 2 }, id: 'e2-new-call-id' }]));
    const e3Fork = await firstRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] });
    expect(e3Fork.status).toBe('completed');
    expect(browserBridge.clickTargets).toHaveLength(1);
    expect(new BrowserTaskActionJournal(taskJournalFile).listUnresolved()).toHaveLength(1);

    browserBridge.firstClickResult.resolve('error');
    await e1Capture.done.promise;
    const e4Receipt = new BrowserTaskActionJournal(taskJournalFile).findByTaskId('main:e1-click');
    expect(e4Receipt).toMatchObject({ phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown' });
    expect(JSON.stringify(firstRig.core.session.records)).not.toContain('late synthetic result');
    expect(readToolLog(firstRig.core)).not.toContain('late synthetic result');

    firstRig.llm.script(toolReply([{ name: 'browser_open', args: { url: ITEM_TWO }, id: 'e5-open-other' }]));
    expect((await firstRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] })).status).toBe('completed');
    const checksBeforeDifferentTarget = firstRig.counters.gateChecks;
    const approvalsBeforeDifferentTarget = firstRig.counters.approvals;
    firstRig.llm.script(toolReply([{ name: 'browser_click', args: { index: 2 }, id: 'e5-other-target' }]));
    expect((await firstRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] })).status).toBe('completed');
    expect(browserBridge.clickTargets).toEqual([ITEM_ONE, ITEM_TWO]);
    expect(firstRig.counters.gateChecks).toBeGreaterThan(checksBeforeDifferentTarget);
    expect(firstRig.counters.approvals).toBe(approvalsBeforeDifferentTarget + 1);
    expect(new BrowserTaskActionJournal(taskJournalFile).listUnresolved()).toHaveLength(1);
    const receiptsAfterE5 = JSON.parse(readFileSync(taskJournalFile, 'utf8')) as Array<{
      phase: string;
      target: { formId: string };
    }>;
    expect(receiptsAfterE5.map((receipt) => [receipt.phase, receipt.target.formId])).toEqual([
      ['unknown', `video:${ITEM_ONE}`],
      ['verified', `video:${ITEM_TWO}`],
    ]);

    firstRig.llm.script(toolReply([
      { name: 'generation_wait', id: 'e6-wait' },
      { name: 'after_generation_cancel', id: 'e6-must-not-dispatch' },
    ]));
    const e6Fork = firstRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] });
    const e6Context = await safeStarted.promise;
    const e6Invalidation = await firstRig.api().invalidateGeneration!({
      sessionId: e6Context.sessionId!,
      expectedGeneration: e6Context.generationToken!,
      reason: 'forget',
      idempotencyKey: 'e6-cancel-safe-growth',
    });
    expect(e6Invalidation).toMatchObject({
      status: 'acknowledged',
      invalidatedGeneration: e6Context.generationToken,
      newGeneration: expect.any(String),
    });
    if (e6Invalidation.status !== 'acknowledged') throw new Error('expected acknowledged invalidation');
    expect(e6Invalidation.newGeneration).not.toBe(e6Context.generationToken);
    expect(await e6Fork).toEqual({ status: 'cancelled', invalidationStatus: 'acknowledged' });
    expect(staleDispatches).toBe(0);
    expect(e6Context.generationSignal?.aborted).toBe(true);
    expect(e6Context.shutdownSignal?.aborted).toBe(false);

    await firstRig.core.stop();

    const e7Capture = { started: deferred<ToolCallContext>(), done: deferred<ToolOutcome>() };
    const restartedBridge = new SyntheticBrowserTransport(false);
    const restartedRig = makeRig({
      rootDir: temporary.dir,
      taskJournalFile,
      bridge: restartedBridge,
      growthTools,
      captures: new Map([['e7-click', e7Capture]]),
    });
    restartedRig.llm.script(
      toolReply([{ name: 'browser_open', args: { url: ITEM_ONE }, id: 'e7-open' }]),
      toolReply([{ name: 'browser_read', id: 'e7-read' }]),
      toolReply([{ name: 'browser_click', args: { index: 2 }, id: 'e7-click' }]),
    );
    await restartedRig.core.start();
    await e7Capture.done.promise;
    const e7Context = await e7Capture.started.promise;
    expect(e7Context.generationToken).not.toBe(e1Context.generationToken);
    expect(restartedBridge.clickTargets).toHaveLength(0);
    expect(restartedRig.counters.approvals).toBe(0);
    expect(new BrowserTaskActionJournal(taskJournalFile).listUnresolved()).toHaveLength(1);

    restartedRig.llm.script(toolReply([{ name: 'empty_growth_result', id: 'e8-empty' }]));
    expect(await restartedRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] }))
      .toEqual({ status: 'completed', text: '' });

    restartedRig.llm.script(toolReply([{ name: 'unknown_growth_result', id: 'e8-unknown' }]));
    const unknownFork = restartedRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] });
    const unknownContext = await unknownStarted.promise;
    const unknownInvalidation = await restartedRig.api().invalidateGeneration!({
      sessionId: unknownContext.sessionId!,
      expectedGeneration: unknownContext.generationToken!,
      reason: 'forget',
      idempotencyKey: 'e8-cancel-growth-unknown',
    });
    expect(unknownInvalidation.status).toBe('unknown');
    releaseUnknown.resolve('late growth result');
    expect(await unknownFork).toEqual({ status: 'cancelled', invalidationStatus: 'unknown' });

    restartedRig.llm.script(toolReply([{ name: 'shutdown_growth_result', id: 'e8-shutdown' }]));
    const shutdownFork = restartedRig.api().spawnForkWithOutcome!({ id: 'growth', messages: [] });
    await shutdownStarted.promise;
    await restartedRig.core.stop();
    expect(await shutdownFork).toEqual({ status: 'shutdown' });
  }, 20_000);
});
