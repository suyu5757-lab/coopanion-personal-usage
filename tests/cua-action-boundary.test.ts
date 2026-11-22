import { describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { ActionGate } from '../core/action-gate.ts';
import { Cua, type CuaDesktopTargetEvidence } from '../packages/cortico-world-desktop-pet/src/cua/cua.ts';
import { CUA_DEFAULTS } from '../packages/cortico-world-desktop-pet/src/cua/config.ts';
import type { CuaDriverLike } from '../packages/cortico-world-desktop-pet/src/cua/driver.ts';
import { MODEL_TEXT } from '../packages/cortico-world-desktop-pet/src/cua/model-text.ts';
import { isSupportedCuaTarget } from '../packages/cortico-world-desktop-pet/src/cua/target-policy.ts';
import { cuaText } from '../packages/cortico-world-desktop-pet/src/cua/i18n/index.ts';

const attempts: Array<[string, Record<string, unknown>]> = [
  ['pet_cua_click', { x: 10, y: 10 }],
  ['pet_cua_click', { elementToken: 'snapshot:publish' }],
  ['pet_cua_drag', { fromX: 10, fromY: 10, toX: 20, toY: 20 }],
  ['pet_cua_type', { text: 'submit' }],
  ['pet_cua_key', { keys: 'Tab Enter' }],
  ['pet_cua_key', { keys: 'Enter' }],
  ['pet_cua_key', { keys: 'Space' }],
  ['pet_cua_key', { keys: 'Cmd+Enter' }],
  ['pet_cua_focus', { window: 'another window' }],
  ['pet_cua_move', { x: 10, y: 10 }],
  ['pet_cua_scroll', { down: 1 }],
];

describe('CUA input through the shared action gate', () => {
  it('allows ordinary background operations on trusted apps including newlines while blocking high-risk actions', () => {
    let enabled = true;
    const gate = new ActionGate({
      platformWrites: () => false, imageGeneration: () => false, imageSaving: () => false,
      mediaUpload: () => false, computerInput: () => enabled, desktopTargetAllowed: isSupportedCuaTarget,
    });
    const target: CuaDesktopTargetEvidence = {
      surface: 'desktop', instanceId: 'test', bundleId: 'com.apple.TextEdit',
      executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
      pid: 30, ownerPid: 30, processStart: 'start', windowId: 10, bounds: { x: 0, y: 0, width: 100, height: 100 },
      display: null, space: null, snapshotId: 'snapshot', captureId: 'capture',
      source: 'cua-driver', route: 'background-window-pixel',
    };
    const finderTarget: CuaDesktopTargetEvidence = {
      ...target, bundleId: 'com.apple.finder',
      executablePath: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
      route: 'background-ax',
    };
    const allows = (tool: string, expectedChange: string, t = target) =>
      gate.allowsOrdinaryDesktopStep(tool, { target: t, expectedChange, risk: 'EXTERNAL_MUTATION' });
    expect(allows('pet_cua_type', 'type "hello"')).toBe(true);
    expect(allows('pet_cua_type', 'type ' + JSON.stringify('中文第一行\n第二行 2026'))).toBe(true);
    expect(allows('pet_cua_key', 'press cmd+s')).toBe(true);
    expect(allows('pet_cua_click', 'left click at (40, 40), 1 time', finderTarget)).toBe(true);
    expect(allows('pet_cua_key', 'press cmd+enter')).toBe(false);
    expect(allows('pet_cua_key', 'press cmd+delete')).toBe(false);
    expect(allows('pet_cua_click', 'press button "Send"')).toBe(false);
    expect(allows('pet_cua_click', 'press button "立即支付"')).toBe(false);
    expect(gate.allowsOrdinaryDesktopStep('pet_cua_type', { target, expectedChange: 'type "x"', risk: 'IRREVERSIBLE_OR_PUBLIC' as never })).toBe(false);
    enabled = false;
    expect(allows('pet_cua_type', 'type "hello"')).toBe(false);
  });

  it('refuses ambiguous window titles and allows an exact handle or unique title', async () => {
    const captures: string[] = [];
    const windows = [
      { handle: '101:11', title: 'Coopanion CUA verification.txt', pid: 101 },
      { handle: '101:12', title: 'Coopanion CUA verification.txt — decoy', pid: 101 },
      { handle: '101:13', title: 'Coopanion CUA verification.txt', pid: 101 },
    ];
    const driver = new Proxy({ available: () => true } as CuaDriverLike, {
      get(target, key) {
        if (key === 'available') return target.available;
        if (key === 'capture') return async (pid: number, windowId: number) => {
          captures.push(`${pid}:${windowId}`);
          return {};
        };
        return () => { throw new Error(`unexpected Cua Driver call: ${String(key)}`); };
      },
    });
    const cua = new Cua({
      cfg: () => ({ ...CUA_DEFAULTS, enabled: true, control: true, permission: 'never-ask' }),
      driver: () => driver,
      modelLanguage: () => 'en',
    });
    const internal = cua as unknown as {
      call: (request: { op: string }) => Promise<unknown>;
      windowOutcome: (...args: unknown[]) => Promise<ToolOutcome>;
    };
    internal.call = async (request) => request.op === 'windows' ? windows : [];
    internal.windowOutcome = async () => ({ text: 'synthetic capture' });
    const call = (window: string) => cua.tools().find((tool) => tool.name === 'pet_cua_window')!.handler(
      { window }, {} as ToolCallContext,
    ) as Promise<ToolOutcome>;

    const ambiguousSubstring = await call('verification.txt');
    const ambiguousExactTitle = await call('Coopanion CUA verification.txt');
    expect(ambiguousSubstring.failed).toBe(true);
    expect(ambiguousExactTitle.failed).toBe(true);
    expect(ambiguousSubstring.text).toContain('exact handle');
    expect(captures).toEqual([]);

    expect(await call('101:13')).toMatchObject({ text: 'synthetic capture' });
    expect(await call('decoy')).toMatchObject({ text: 'synthetic capture' });
    const unknownHandle = await call('999:99');
    expect(unknownHandle.failed).toBe(true);
    expect(captures).toEqual(['101:13', '101:12']);
    await cua.stop();
  });

  it.each(attempts)('refuses %s before approval or driver dispatch', async (tool, args) => {
    let dispatched = 0;
    let questions = 0;
    let grantRequests = 0;
    const driver = new Proxy({} as CuaDriverLike, {
      get() { dispatched++; throw new Error('unexpected desktop dispatch'); },
    });
    const cua = new Cua({
      cfg: () => ({ ...CUA_DEFAULTS, enabled: true, control: true, permission: 'never-ask' }),
      driver: () => driver,
      modelLanguage: () => 'en',
      askPermission: async () => { questions++; return 'yes'; },
      instanceId: 'run-test',
      authorizeInput: async () => { grantRequests++; return null; },
    });
    const handler = cua.tools().find((decl) => decl.name === tool)!.handler;
    const outcome = await handler(args, {} as ToolCallContext) as ToolOutcome;
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain(MODEL_TEXT.en.gateDenied);
    expect(dispatched).toBe(0);
    expect(questions).toBe(0);
    expect(grantRequests).toBe(0);
    expect(cua.lamp('en').hint).toContain(cuaText('en').console.viewOnly);
    await cua.stop();
  });

  it('consumes a Core step ticket for the same TextEdit snapshot immediately before dispatch', async () => {
    const events: string[] = [];
    const gate = new ActionGate({
      platformWrites: () => false,
      imageGeneration: () => false,
      imageSaving: () => false,
      mediaUpload: () => false,
      computerInput: () => true,
      desktopTargetAllowed: isSupportedCuaTarget,
    });
    let captures = 0;
    const driver = new Proxy({ available: () => true } as CuaDriverLike, {
      get(target, key) {
        if (key === 'available') return target.available;
        if (key === 'capture') return async (pid: number, windowId: number) => {
          captures++;
          return {
            pid, ownerPid: pid, windowId, title: 'Untitled — TextEdit', width: 400, height: 300, scale: 1,
            captureId: `capture-${captures}`, snapshotId: `snapshot-${captures}`, truncated: false,
            truncationReason: null, elementsComplete: true, elements: [],
            bounds: { x: 0, y: 0, width: 400, height: 300 },
            processIdentity: {
              bundleId: 'com.apple.TextEdit',
              executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
              processStart: 'Tue Oct 28 00:00:00 2026',
            },
            jpeg: Buffer.alloc(0),
          };
        };
        if (key === 'click') return async () => { events.push('dispatch'); return { effect: 'confirmed', summary: 'clicked' }; };
        return () => { throw new Error(`unexpected Cua Driver call: ${String(key)}`); };
      },
    });
    const cfg = { ...CUA_DEFAULTS, enabled: true, control: true, permission: 'never-ask' as const };
    cfg.screenshot.afterAction = false;
    cfg.screenshot.settleMs = 0;
    let alterEvidenceOnConsume = false;
    const cua = new Cua({
      cfg: () => cfg,
      driver: () => driver,
      modelLanguage: () => 'en',
      instanceId: 'run-test',
      askPermission: async () => 'yes',
      authorizeInput: async (request) => {
        const authorization = await gate.requestDesktopStep({
          taskId: request.taskId,
          taskText: request.taskText,
          expectedChange: request.expectedChange,
          risk: request.risk ?? 'EXTERNAL_MUTATION',
          target: request.target as CuaDesktopTargetEvidence,
          expiresInMs: request.expiresInMs,
          maxSteps: 1,
        }, request.confirmInCoreUi);
        if (!authorization) return null;
        return {
          consume(target, expectedChange) {
            const current = target && alterEvidenceOnConsume ? { ...target, snapshotId: 'changed-after-approval' } : target;
            alterEvidenceOnConsume = false;
            const consumed = authorization.consume(current as CuaDesktopTargetEvidence | null, expectedChange);
            events.push(consumed ? 'ticket-consumed' : 'ticket-refused');
            return consumed;
          },
          revoke: () => authorization.revoke(),
          complete: (result) => events.push(`receipt:${result.dispatchState}:${result.outcome}:${result.effect}`),
        };
      },
    });
    const inner = cua as unknown as { call: (request: { op: string }) => Promise<unknown> };
    inner.call = async (request) => request.op === 'windows'
      ? [{ handle: '123:456', title: 'Untitled — TextEdit', pid: 123 }]
      : [];
    const call = (name: string, args: Record<string, unknown>) =>
      cua.tools().find((tool) => tool.name === name)!.handler(args, { role: 'main', log: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as ToolCallContext) as Promise<ToolOutcome>;

    const selected = await call('pet_cua_window', { window: '123:456' });
    const click = await call('pet_cua_click', { x: 10, y: 10 });
    expect(selected.failed).toBeUndefined();
    expect(click.failed).toBeUndefined();
    expect(events).toEqual(['ticket-consumed', 'dispatch', 'receipt:delivered:ui-observed:confirmed']);
    alterEvidenceOnConsume = true;
    const stale = await call('pet_cua_click', { x: 10, y: 10 });
    expect(stale.failed).toBe(true);
    expect(events).toEqual(['ticket-consumed', 'dispatch', 'receipt:delivered:ui-observed:confirmed', 'ticket-refused']);
    await cua.stop();
  });

  it('refuses a Safari target and foreground switching before asking for a grant', async () => {
    const events: string[] = [];
    const driver = new Proxy({ available: () => true } as CuaDriverLike, {
      get(target, key) {
        if (key === 'available') return target.available;
        if (key === 'capture') return async (pid: number, windowId: number) => ({
          pid, ownerPid: pid, windowId, title: 'Safari', width: 400, height: 300, scale: 1,
          captureId: 'capture-1', snapshotId: 'snapshot-1', truncated: false,
          truncationReason: null, elementsComplete: true, elements: [],
          bounds: { x: 0, y: 0, width: 400, height: 300 },
          processIdentity: { bundleId: 'com.apple.Safari', executablePath: '/Applications/Safari.app/Contents/MacOS/Safari', processStart: 'start' },
          jpeg: Buffer.alloc(0),
        });
        events.push(String(key));
        return () => { throw new Error(`unexpected Cua Driver call: ${String(key)}`); };
      },
    });
    const gate = new ActionGate({ platformWrites: () => false, imageGeneration: () => false, imageSaving: () => false, mediaUpload: () => false, computerInput: () => true, desktopTargetAllowed: isSupportedCuaTarget });
    let questions = 0;
    let grantRequests = 0;
    const cfg = { ...CUA_DEFAULTS, enabled: true, control: true, permission: 'never-ask' as const };
    const cua = new Cua({
      cfg: () => cfg,
      driver: () => driver,
      instanceId: 'run-test',
      askPermission: async () => { questions++; return 'yes'; },
      authorizeInput: async (request) => {
        grantRequests++;
        const authorization = await gate.requestDesktopStep({
          taskId: request.taskId, taskText: request.taskText, expectedChange: request.expectedChange,
          risk: request.risk ?? 'EXTERNAL_MUTATION',
          target: request.target as CuaDesktopTargetEvidence, expiresInMs: request.expiresInMs, maxSteps: 1,
        }, request.confirmInCoreUi);
        return authorization ? { ...authorization, complete: () => {} } : null;
      },
    });
    const inner = cua as unknown as { call: (request: { op: string }) => Promise<unknown> };
    inner.call = async (request) => request.op === 'windows'
      ? [{ handle: '123:456', title: 'Safari', pid: 123 }]
      : [];
    const call = (name: string, args: Record<string, unknown>) =>
      cua.tools().find((tool) => tool.name === name)!.handler(args, { role: 'main', log: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as ToolCallContext) as Promise<ToolOutcome>;

    await call('pet_cua_window', { window: '123:456' });
    const click = await call('pet_cua_click', { x: 10, y: 10 });
    const focus = await call('pet_cua_focus', { window: '123:456' });
    expect(click.failed).toBe(true);
    expect(focus.failed).toBe(true);
    expect(questions).toBe(0);
    expect(grantRequests).toBe(0);
    expect(events).toEqual([]);
    await cua.stop();
  });

  it('keeps browser and desktop reads available while desktop input is closed', () => {
    const gate = new ActionGate({ platformWrites: () => true, imageGeneration: () => false, imageSaving: () => false, mediaUpload: () => false, computerInput: () => true, desktopTargetAllowed: () => false });
    expect(gate.check({ surface: 'desktop', tool: 'pet_cua_screenshot', impact: 'read' }).allow).toBe(true);
    expect(gate.check({ surface: 'browser', tool: 'browser_read', impact: 'read' }).allow).toBe(true);
    expect(gate.check({ surface: 'browser', tool: 'browser_type', impact: 'platform-write' }).allow).toBe(true);
    expect(gate.check({ surface: 'desktop', tool: 'pet_cua_click', impact: 'computer-input' }))
      .toMatchObject({ allow: false, refusal: 'unverified-target' });
  });

  it('authorizes multiple low-risk steps under one task grant, requires fresh approval for sensitive keys, and stops after cancellation', async () => {
    const dispatched: string[] = [];
    let promptCount = 0;
    let ordinaryPolicy = false;
    const taskGrantIds = new Map<string, string>();
    const gate = new ActionGate({
      platformWrites: () => false, imageGeneration: () => false, imageSaving: () => false, mediaUpload: () => false,
      computerInput: () => true, desktopTargetAllowed: isSupportedCuaTarget,
    });
    let captures = 0;
    const driver = new Proxy({ available: () => true } as CuaDriverLike, {
      get(target, key) {
        if (key === 'available') return target.available;
        if (key === 'identifyProcess') return async () => ({
          bundleId: 'com.apple.TextEdit',
          executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
          processStart: 'start-1',
        });
        if (key === 'capture') return async (pid: number, windowId: number) => {
          captures++;
          return {
            pid, ownerPid: pid, windowId, title: 'xi-cua-proof.txt — TextEdit', width: 400, height: 300, scale: 1,
            captureId: `cap-${captures}`, snapshotId: `snap-${captures}`, truncated: false,
            truncationReason: null, elementsComplete: true, elements: [],
            bounds: { x: 0, y: 0, width: 400, height: 300 },
            processIdentity: { bundleId: 'com.apple.TextEdit', executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit', processStart: 'start-1' },
            jpeg: Buffer.alloc(0),
          };
        };
        if (key === 'click') return async () => { dispatched.push('click'); return { effect: 'confirmed', summary: 'clicked' }; };
        if (key === 'type') return async () => { dispatched.push('type'); return { effect: 'confirmed', summary: 'typed' }; };
        if (key === 'key') return async () => { dispatched.push('key'); return { effect: 'confirmed', summary: 'pressed' }; };
        return () => { throw new Error(`unexpected Cua Driver call: ${String(key)}`); };
      },
    });
    const cfg = { ...CUA_DEFAULTS, enabled: true, control: true, backgroundOnly: true, permission: 'never-ask' as 'never-ask' | 'ask-before-acting' };
    cfg.screenshot.afterAction = false;
    cfg.screenshot.settleMs = 0;
    const cua = new Cua({
      cfg: () => cfg,
      driver: () => driver,
      modelLanguage: () => 'en',
      instanceId: 'task-grant-test',
      askPermission: async () => { promptCount++; return 'yes'; },
      revokeInputTask: (taskId) => { taskGrantIds.delete(taskId); gate.revokeTask(taskId); },
      allowsOrdinaryInput: (request) => ordinaryPolicy
        && gate.allowsOrdinaryDesktopStep(request.tool, { ...request, risk: 'REVERSIBLE_LOCAL' }),
      authorizeInput: async (request) => {
        const risk = request.risk ?? 'EXTERNAL_MUTATION';
        if (ordinaryPolicy && gate.allowsOrdinaryDesktopStep(request.tool, { ...request, risk })) {
          expect(request.maxSteps).toBe(1);
          expect(request.reuseTaskGrant).toBeUndefined();
          expect(await request.confirmInCoreUi()).toBe(false);
          return gate.requestDesktopStep({ ...request, risk: 'REVERSIBLE_LOCAL', maxSteps: 1 },
            async () => ({ approved: true, channel: 'durable-rule' }));
        }
        if (request.reuseTaskGrant) {
          const grantId = taskGrantIds.get(request.taskId);
          return grantId ? gate.authorizeDesktopTaskStep(grantId, { target: request.target as CuaDesktopTargetEvidence, expectedChange: request.expectedChange, risk }) : null;
        }
        if (request.maxSteps > 1) {
          const handle = await gate.requestDesktopTaskGrant({
            taskId: request.taskId, taskText: request.taskText, risk, target: request.target as CuaDesktopTargetEvidence,
            expiresInMs: request.expiresInMs, maxSteps: request.maxSteps,
          }, request.confirmInCoreUi);
          if (!handle) return null;
          taskGrantIds.set(request.taskId, handle.grantId);
          return gate.authorizeDesktopTaskStep(handle.grantId, { target: request.target as CuaDesktopTargetEvidence, expectedChange: request.expectedChange, risk });
        }
        return gate.requestDesktopStep({
          taskId: request.taskId, taskText: request.taskText, expectedChange: request.expectedChange, risk,
          target: request.target as CuaDesktopTargetEvidence, expiresInMs: request.expiresInMs, maxSteps: 1,
        }, request.confirmInCoreUi);
      },
    });
    const inner = cua as unknown as { call: (request: { op: string }) => Promise<unknown> };
    inner.call = async (request) => request.op === 'windows' ? [{ handle: '123:456', title: 'xi-cua-proof.txt — TextEdit', pid: 123 }] : [];
    const call = (name: string, args: Record<string, unknown>) =>
      cua.tools().find((tool) => tool.name === name)!.handler(args, { role: 'main', log: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as ToolCallContext) as Promise<ToolOutcome>;

    expect((await call('pet_cua_window', { window: '123:456' })).failed).toBeUndefined();
    expect((await call('pet_cua_click', { x: 10, y: 10 })).failed).toBeUndefined();
    expect((await call('pet_cua_type', { text: 'hello' })).failed).toBeUndefined();
    expect((await call('pet_cua_key', { keys: 'cmd+s' })).failed).toBeUndefined();
    expect(promptCount).toBe(1);
    expect(dispatched).toEqual(['click', 'type', 'key']);

    expect((await call('pet_cua_key', { keys: 'cmd+q' })).failed).toBeUndefined();
    expect(promptCount).toBe(2);

    cua.cancelActiveTask();
    expect(taskGrantIds.size).toBe(0);
    ordinaryPolicy = true;
    cfg.permission = 'ask-before-acting';
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (let i = 0; i < 42; i++) {
        time.mockReturnValue(now + i * 30_000);
        expect((await call('pet_cua_type', { text: 'ordinary' })).failed).toBeUndefined();
      }
      expect(promptCount).toBe(2);
      expect(taskGrantIds.size).toBe(0);
      expect(dispatched.slice(-42)).toEqual(Array(42).fill('type'));
    } finally {
      time.mockRestore();
      await cua.stop();
    }
  });

  it('allows explicitly user-authorized native non-browser apps while still blocking browsers and system settings', () => {
    const allowed = new Set(['com.apple.Notes', 'com.apple.Safari', 'com.apple.SystemSettings']);
    expect(isSupportedCuaTarget({
      bundleId: 'com.apple.Notes', executablePath: '/System/Applications/Notes.app/Contents/MacOS/Notes',
      route: 'background-ax', source: 'cua-driver',
    }, allowed)).toBe(true);
    expect(isSupportedCuaTarget({
      bundleId: 'com.apple.Safari', executablePath: '/Applications/Safari.app/Contents/MacOS/Safari',
      route: 'background-ax', source: 'cua-driver',
    }, allowed)).toBe(false);
    expect(isSupportedCuaTarget({
      bundleId: 'com.apple.SystemSettings', executablePath: '/System/Applications/System Settings.app/Contents/MacOS/System Settings',
      route: 'background-ax', source: 'cua-driver',
    }, allowed)).toBe(false);
  });

  it('returns editable/observable elements in pet_cua_accessibility without failing when press elements are absent (R4-A)', async () => {
    const driver = new Proxy({ available: () => true } as CuaDriverLike, {
      get(target, key) {
        if (key === 'available') return target.available;
        if (key === 'identifyProcess') return async () => ({
          bundleId: 'com.apple.TextEdit',
          executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
          processStart: 'start-1',
        });
        if (key === 'capture') return async (pid: number, windowId: number) => ({
          pid, ownerPid: pid, windowId, title: 'blank.txt', width: 600, height: 400, scale: 1,
          captureId: 'cap-ax-1', snapshotId: 'snap-ax-1', truncated: false,
          truncationReason: null, elementsComplete: true,
          elements: [{ token: 'snap-ax-1:1', index: 1, role: 'AXTextArea', label: 'Document', value: '', actions: ['AXShowMenu'], frame: { x: 10, y: 40, width: 580, height: 340 }, parentIndex: 0, depth: 1 }],
          bounds: { x: 0, y: 0, width: 600, height: 400 },
          processIdentity: { bundleId: 'com.apple.TextEdit', executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit', processStart: 'start-1' },
          jpeg: Buffer.alloc(0),
        });
        return () => { throw new Error(`unexpected call: ${String(key)}`); };
      },
    });
    const cua = new Cua({
      cfg: () => ({ ...CUA_DEFAULTS, enabled: true, control: true, backgroundOnly: true, permission: 'never-ask' }),
      driver: () => driver,
      modelLanguage: () => 'en',
      instanceId: 'r4a-ax-test',
    });
    (cua as unknown as { call: (req: { op: string }) => Promise<unknown> }).call = async (req) =>
      req.op === 'windows' ? [{ handle: '55:77', title: 'blank.txt', pid: 55 }] : [];
    const call = (name: string, args: Record<string, unknown>) =>
      cua.tools().find((tool) => tool.name === name)!.handler(args, {} as ToolCallContext) as Promise<ToolOutcome>;
    expect((await call('pet_cua_window', { window: '55:77' })).failed).toBeUndefined();
    const ax = await call('pet_cua_accessibility', {});
    expect(ax.failed).toBeUndefined();
    expect(ax.text).toContain('AXTextArea');
    expect(ax.text).toContain('pet_cua_type');
    await cua.stop();
  });

  it('runs generic non-TextEdit tasks beyond 10 minutes and 40 steps with zero prompts (R4-B2)', async () => {
    let prompts = 0;
    let dispatches = 0;
    const seenTaskIds = new Set<string>();
    const gate = new ActionGate({
      platformWrites: () => false, imageGeneration: () => false, imageSaving: () => false,
      mediaUpload: () => false, computerInput: () => true, desktopTargetAllowed: isSupportedCuaTarget,
    });
    let captures = 0;
    const driver = new Proxy({ available: () => true } as CuaDriverLike, {
      get(target, key) {
        if (key === 'available') return target.available;
        if (key === 'identifyProcess') return async () => ({
          bundleId: 'com.apple.finder',
          executablePath: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
          processStart: 'finder-start',
        });
        if (key === 'capture') return async (pid: number, windowId: number) => ({
          pid, ownerPid: pid, windowId, title: 'Downloads — Finder', width: 800, height: 600, scale: 1,
          captureId: `cap-f-${++captures}`, snapshotId: `snap-f-${captures}`, truncated: false,
          truncationReason: null, elementsComplete: true, elements: [],
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          processIdentity: { bundleId: 'com.apple.finder', executablePath: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', processStart: 'finder-start' },
          jpeg: Buffer.alloc(0),
        });
        if (key === 'scroll') return async () => { dispatches++; return { effect: 'confirmed', summary: 'scrolled' }; };
        return () => { throw new Error(`unexpected call: ${String(key)}`); };
      },
    });
    const cfg = { ...CUA_DEFAULTS, enabled: true, control: true, backgroundOnly: true, permission: 'ask-before-acting' as const };
    cfg.screenshot.afterAction = false;
    cfg.screenshot.settleMs = 0;
    const cua = new Cua({
      cfg: () => cfg,
      driver: () => driver,
      modelLanguage: () => 'en',
      instanceId: 'r4b-long-test',
      askPermission: async () => { prompts++; return 'yes'; },
      allowsOrdinaryInput: (req) => gate.allowsOrdinaryDesktopStep(req.tool, { ...req, risk: 'REVERSIBLE_LOCAL' }),
      authorizeInput: async (req) => {
        seenTaskIds.add(req.taskId);
        return gate.requestDesktopStep({
          taskId: `${req.taskId}:${dispatches}`, taskText: req.tool, expectedChange: req.expectedChange,
          risk: 'REVERSIBLE_LOCAL', target: req.target as CuaDesktopTargetEvidence, expiresInMs: 30_000, maxSteps: 1,
        }, async () => ({ approved: true, channel: 'durable-rule', ruleId: 'desktop-ordinary-background' }));
      },
    });
    (cua as unknown as { call: (req: { op: string }) => Promise<unknown> }).call = async (req) =>
      req.op === 'windows' ? [{ handle: '88:99', title: 'Downloads — Finder', pid: 88 }] : [];
    const call = (name: string, args: Record<string, unknown>) =>
      cua.tools().find((tool) => tool.name === name)!.handler(args, {} as ToolCallContext) as Promise<ToolOutcome>;
    expect((await call('pet_cua_window', { window: '88:99' })).failed).toBeUndefined();
    const baseNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    try {
      for (let i = 0; i < 45; i++) {
        clock.mockReturnValue(baseNow + i * 35_000); // > 25 minutes total, > 40 steps
        expect((await call('pet_cua_scroll', { x: 100, y: 100, down: 2 })).failed).toBeUndefined();
      }
      expect(dispatches).toBe(45);
      expect(prompts).toBe(0);
      expect(seenTaskIds.size).toBe(1);
    } finally {
      clock.mockRestore();
      await cua.stop();
    }
  });
});
