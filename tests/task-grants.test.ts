import { describe, expect, it } from 'vitest';
import { TaskGrantRegistry, type DesktopTargetEvidence, type StepRequest } from '../core/task-grants.ts';

const desktop = (changes: Partial<DesktopTargetEvidence> = {}): DesktopTargetEvidence => ({
  surface: 'desktop',
  instanceId: 'run-1',
  bundleId: 'com.example.Editor',
  executablePath: '/Applications/Editor.app/Contents/MacOS/Editor',
  pid: 41,
  ownerPid: 41,
  processStart: '2026-10-28T00:00:00Z',
  windowId: 7,
  bounds: { x: 20, y: 40, width: 800, height: 600 },
  display: 'display-1',
  space: null,
  snapshotId: 'snapshot-1',
  captureId: 'capture-1',
  route: 'background-ax',
  source: 'cua-driver',
  ...changes,
});

const request = (changes: Partial<StepRequest> = {}): StepRequest => ({
  action: 'type',
  target: desktop(),
  expectedChange: 'insert approved paragraph',
  ...changes,
});

const grantRequest = (changes: Record<string, unknown> = {}) => ({
  taskId: 'session:round-4',
  taskText: 'Insert the approved paragraph in the open editor document.',
  risk: 'REVERSIBLE_LOCAL' as const,
  target: desktop(),
  actions: ['click', 'type', 'key'],
  expiresInMs: 60_000,
  maxSteps: 4,
  ...changes,
});

describe('TaskGrantRegistry', () => {
  it('creates a grant only after the trusted Core UI confirmation resolves yes', async () => {
    const registry = new TaskGrantRegistry('permissions-1');
    const denied = await registry.requestGrant(grantRequest(), async () => false, 1_000);
    expect(denied).toBeNull();
    expect(registry.issueStepTicket('missing', request(), 1_001)).toBeNull();

    const approved = await registry.requestGrant(grantRequest(), async () => true, 2_000);
    expect(approved).toMatchObject({ taskId: 'session:round-4', permissionGeneration: 'permissions-1', stepsUsed: 0, revoked: false });
    expect(approved?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds one-use tickets to the current target snapshot and expected change', async () => {
    const registry = new TaskGrantRegistry('permissions-1');
    const grant = await registry.requestGrant(grantRequest(), async () => true, 1_000);
    expect(grant).not.toBeNull();

    const ticket = registry.issueStepTicket(grant!.id, request(), 1_001);
    expect(ticket).not.toBeNull();
    expect(registry.consumeStepTicket(ticket!.id, request(), 1_002)).toBe(true);
    expect(registry.consumeStepTicket(ticket!.id, request(), 1_003)).toBe(false);

    const stale = registry.issueStepTicket(grant!.id, request(), 1_004);
    expect(registry.consumeStepTicket(stale!.id, request({ target: desktop({ snapshotId: 'snapshot-2', captureId: 'capture-2' }) }), 1_005)).toBe(false);
  });

  it('keeps an approved task grant across expected snapshots while binding each step to a fresh capture', async () => {
    const registry = new TaskGrantRegistry('permissions-1');
    const grant = await registry.requestGrant(grantRequest(), async () => true, 1_000);
    const nextStep = request({ target: desktop({ snapshotId: 'snapshot-2', captureId: 'capture-2', element: { role: 'text field', label: 'Document', token: 'snapshot-2:3' } }) });
    const ticket = registry.issueStepTicket(grant!.id, nextStep, 1_001);
    expect(ticket).not.toBeNull();
    expect(registry.consumeStepTicket(ticket!.id, nextStep, 1_002)).toBe(true);
  });

  it('rejects a changed process, window, target owner or permission generation', async () => {
    const registry = new TaskGrantRegistry('permissions-1');
    const grant = await registry.requestGrant(grantRequest(), async () => true, 1_000);
    expect(registry.issueStepTicket(grant!.id, request({ target: desktop({ processStart: '2026-10-28T00:01:00Z' }) }), 1_001)).toBeNull();
    expect(registry.issueStepTicket(grant!.id, request({ target: desktop({ windowId: 8 }) }), 1_001)).toBeNull();
    expect(registry.issueStepTicket(grant!.id, request({ target: desktop({ ownerPid: 99 }) }), 1_001)).toBeNull();
    const ticket = registry.issueStepTicket(grant!.id, request(), 1_001);
    registry.synchronizePermissionGeneration('permissions-2');
    expect(registry.consumeStepTicket(ticket!.id, request(), 1_002)).toBe(false);
  });

  it('binds the grant to the approved file path and digest list', async () => {
    const file = { path: 'clips/a.mp4', digest: 'a'.repeat(64), bytes: 1200, mime: 'video/mp4' };
    const registry = new TaskGrantRegistry('permissions-1');
    const grant = await registry.requestGrant(grantRequest({ actions: ['upload'], files: [file] }), async () => true, 1_000);
    expect(grant).not.toBeNull();
    expect(registry.issueStepTicket(grant!.id, request({ action: 'upload', files: [file] }), 1_001)).not.toBeNull();
    expect(registry.issueStepTicket(grant!.id, request({ action: 'upload', files: [{ ...file, digest: 'b'.repeat(64) }] }), 1_001)).toBeNull();
    expect(registry.issueStepTicket(grant!.id, request({ action: 'upload', files: [{ ...file, path: 'clips/b.mp4' }] }), 1_001)).toBeNull();
  });

  it('expires, cancels and limits a task grant', async () => {
    const registry = new TaskGrantRegistry('permissions-1');
    const grant = await registry.requestGrant(grantRequest({ expiresInMs: 1_000, maxSteps: 1 }), async () => true, 1_000);
    expect(registry.issueStepTicket(grant!.id, request(), 2_001)).toBeNull();
    const current = await registry.requestGrant({ ...grantRequest({ maxSteps: 1 }), taskId: 'session:round-5' }, async () => true, 3_000);
    const ticket = registry.issueStepTicket(current!.id, request(), 3_001);
    expect(registry.consumeStepTicket(ticket!.id, request(), 3_002)).toBe(true);
    expect(registry.issueStepTicket(current!.id, request(), 3_003)).toBeNull();
    registry.revokeTask('session:round-5');
    expect(registry.issueStepTicket(current!.id, request(), 3_004)).toBeNull();
  });

  it('requires complete window identity and an exact file list', async () => {
    const registry = new TaskGrantRegistry('permissions-1');
    await expect(registry.requestGrant(grantRequest({ target: desktop({ bundleId: '' }) }), async () => true, 1_000)).rejects.toThrow('incomplete');
    await expect(registry.requestGrant(grantRequest({ files: [{ path: '../outside.txt', digest: 'a'.repeat(64), bytes: 12, mime: 'video/mp4' }] }), async () => true, 1_000)).rejects.toThrow('incomplete');
    await expect(registry.requestGrant(grantRequest({ files: [{ path: 'clips/a.mp4', digest: 'not-a-hash', bytes: 12, mime: 'video/mp4' }] }), async () => true, 1_000)).rejects.toThrow('incomplete');
  });
});
