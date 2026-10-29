import { describe, expect, it } from 'vitest';
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
          target: request.target as CuaDesktopTargetEvidence,
          expiresInMs: request.expiresInMs,
          maxSteps: request.maxSteps,
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
    expect(events).toEqual(['ticket-consumed', 'dispatch']);
    alterEvidenceOnConsume = true;
    const stale = await call('pet_cua_click', { x: 10, y: 10 });
    expect(stale.failed).toBe(true);
    expect(events).toEqual(['ticket-consumed', 'dispatch', 'ticket-refused']);
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
      authorizeInput: async (request) => { grantRequests++; return gate.requestDesktopStep({
        taskId: request.taskId, taskText: request.taskText, expectedChange: request.expectedChange,
        target: request.target as CuaDesktopTargetEvidence, expiresInMs: request.expiresInMs, maxSteps: request.maxSteps,
      }, request.confirmInCoreUi); },
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
});
