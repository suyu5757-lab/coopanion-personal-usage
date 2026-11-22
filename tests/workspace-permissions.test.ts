import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOW_RISK_RULES,
  WorkspacePermissionStore,
  inspectWorkspacePath,
  type WorkspacePrompt,
  type WorkspaceWriteInput,
} from '../core/workspace-permissions.ts';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function setup(): { root: string; storeFile: string; store: (now?: () => number) => WorkspacePermissionStore } {
  const base = mkdtempSync(join(tmpdir(), 'coop-p5-permissions-'));
  const root = join(base, 'workspace');
  mkdirSync(join(root, 'self-review'), { recursive: true });
  mkdirSync(join(root, 'mind'), { recursive: true });
  const storeFile = join(base, 'state', 'workspace-permissions.json');
  return {
    root,
    storeFile,
    store: (now = () => Date.now()) => new WorkspacePermissionStore({ file: storeFile, now, timezone: () => 'UTC' }),
  };
}

function input(root: string, path: string, overrides: Partial<WorkspaceWriteInput> = {}): WorkspaceWriteInput {
  const body = overrides.payloadDigest === undefined ? 'first draft' : 'first draft';
  return {
    workspaceRoot: root,
    absolutePath: join(root, path),
    path,
    tool: 'Persona write_file',
    operation: 'create',
    targetState: 'absent',
    baseDigest: null,
    payloadDigest: sha(body),
    payloadBytes: Buffer.byteLength(body),
    deltaBytes: Buffer.byteLength(body),
    mime: 'text/markdown',
    source: 'persona-workspace',
    taskId: 'persona:main:one',
    sessionId: 'main',
    background: false,
    ...overrides,
  };
}

const allowPrompt: WorkspacePrompt = async () => 'yes';

describe('workspace write permissions', () => {
  it('refuses a background write without a rule, keeps one pending entry across 20 retries and never prompts', async () => {
    const { root, store: open } = setup();
    const store = open();
    const prompt = vi.fn<WorkspacePrompt>(async () => 'yes');
    for (let i = 0; i < 20; i += 1) {
      const result = await store.authorize(input(root, 'self-review/2026-11-03.md', {
        background: true,
        payloadDigest: sha(`draft ${i}`),
      }), prompt);
      expect(result.decision, `attempt ${i}`).toBe('DEFER');
    }
    expect(prompt).not.toHaveBeenCalled();
    const view = store.snapshot();
    expect(view.pendingCount).toBe(1);
    expect(view.pending[0]).toMatchObject({ path: 'self-review/2026-11-03.md', attempts: 20, status: 'deferred' });

    // A new process reads the same queue; a retry after restart still does not prompt.
    const restarted = open();
    expect(restarted.snapshot().pendingCount).toBe(1);
    await restarted.authorize(input(root, 'self-review/2026-11-03.md', { background: true }), prompt);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('allows one exact content digest after the permission center approves it, and not a changed payload', async () => {
    const { root, store: open } = setup();
    let now = 1_000_000;
    const store = open(() => now);
    await store.authorize(input(root, 'self-review/2026-11-03.md', { background: true, payloadDigest: sha('approved') }), allowPrompt);
    const pending = store.snapshot().pending[0]!;
    expect(store.resolvePending(pending.id, 'allow-once')).toEqual({ ok: true });

    const allowed = await store.authorize(input(root, 'self-review/2026-11-03.md', { background: true, payloadDigest: sha('approved') }), allowPrompt);
    expect(allowed).toMatchObject({ decision: 'AUTO_ALLOW', reason: 'permission-center-once', channel: 'permission-center' });

    now += 2_000;
    const changed = await store.authorize(input(root, 'self-review/2026-11-03.md', { background: true, payloadDigest: sha('changed') }), allowPrompt);
    expect(changed.decision).toBe('DEFER');
    expect(store.snapshot().pending[0]).toMatchObject({ payloadDigest: sha('changed'), status: 'deferred' });
  });

  it('keeps a granted directory rule across a restart and stops on revoke', () => {
    const { root, store: open } = setup();
    const store = open();
    const granted = store.enableDefaults();
    expect(granted.added).toBe(DEFAULT_LOW_RISK_RULES.length);
    const target = input(root, 'self-review/2026-11-04.md', { payloadDigest: sha('daily review') });
    expect(store.evaluate(target)).toMatchObject({ decision: 'AUTO_ALLOW', reason: 'rule-match' });

    const restarted = open();
    expect(restarted.evaluate(target).decision).toBe('AUTO_ALLOW');
    const rule = restarted.snapshot().rules.find((candidate) => candidate.path === 'self-review/')!;
    expect(restarted.revokeRule(rule.id)).toBe(true);
    expect(restarted.evaluate(target)).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'no-rule' });
  });

  it('creates the rule named by an Always answer and allows the next write', async () => {
    const { root, store: open } = setup();
    const store = open();
    const result = await store.authorize(input(root, 'mind/now.md'), async () => 'always');
    expect(result).toMatchObject({ decision: 'AUTO_ALLOW', reason: 'owner-always', channel: 'durable-rule', ruleId: expect.any(String) });
    expect(store.snapshot().rules.some((rule) => rule.path === 'mind/')).toBe(true);
    expect(store.evaluate(input(root, 'mind/next.md', { payloadDigest: sha('next') }))).toMatchObject({ decision: 'AUTO_ALLOW', reason: 'rule-match' });
  });

  it('keeps prompts to one per cooldown after a timeout', async () => {
    const { root, store: open } = setup();
    let now = 1_000_000;
    const store = open(() => now);
    const prompt = vi.fn<WorkspacePrompt>(async () => 'timeout');
    const first = await store.authorize(input(root, 'mind/now.md'), prompt);
    expect(first).toMatchObject({ decision: 'DEFER', reason: 'prompt-timeout' });
    for (let i = 0; i < 10; i += 1) {
      now += 60_000;
      await store.authorize(input(root, 'mind/now.md', { payloadDigest: sha(`changed ${i}`) }), prompt);
    }
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('denies protected names, scripts, hidden segments, traversal, symlinks and hardlinks', () => {
    const { root, store: open } = setup();
    open().enableDefaults();
    const denied = (path: string) => inspectWorkspacePath(root, path);
    for (const path of ['CONSTITUTION.md', 'SELF.md', 'PARTNER.md', 'handoffs/note.md', '.git/config', '.env', 'tool.sh', 'evil.html', '../outside.md', '/tmp/absolute.md', 'self-review/a\u0000b.md']) {
      expect(denied(path).ok, path).toBe(false);
    }
    const outside = mkdtempSync(join(tmpdir(), 'coop-p5-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'secret');
    symlinkSync(outside, join(root, 'linked'));
    expect(denied('linked/secret.md')).toMatchObject({ ok: false, reason: 'symlink' });
    linkSync(join(outside, 'secret.md'), join(root, 'self-review', 'hard.md'));
    expect(denied('self-review/hard.md')).toMatchObject({ ok: false, reason: 'hardlink' });
  });

  it('requires approval for a file over the per-rule or per-append limit', () => {
    const { root, store: open } = setup();
    const store = open();
    store.grantRule({ path: 'self-review/', operations: ['create', 'append', 'update'], extensions: ['.md'], maxBytes: 100 });
    expect(store.evaluate(input(root, 'self-review/large.md', { payloadBytes: 101, deltaBytes: 101 }))).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'rule-size' });
    store.grantRule({ path: 'self-review/', operations: ['create', 'append', 'update'], extensions: ['.md'], maxBytes: 1024 * 1024 });
    expect(store.evaluate(input(root, 'self-review/append.md', { operation: 'append', payloadBytes: 200, deltaBytes: 100, targetState: 'present', baseDigest: sha('old') })))
      .toMatchObject({ decision: 'AUTO_ALLOW' });
    expect(store.evaluate(input(root, 'self-review/append.md', { operation: 'append', payloadBytes: 300_000, deltaBytes: 270_000, targetState: 'present', baseDigest: sha('old') })))
      .toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'append-too-large' });
  });

  it('fails closed when the rule file is invalid', () => {
    const { root, storeFile } = setup();
    mkdirSync(join(storeFile, '..'), { recursive: true });
    writeFileSync(storeFile, '{not json');
    const store = new WorkspacePermissionStore({ file: storeFile });
    expect(store.snapshot().degraded).toBe(true);
    expect(store.evaluate(input(root, 'self-review/2026-11-04.md'))).toMatchObject({ decision: 'DENY', reason: 'store-degraded' });
  });

  it('stops automatic writes at the daily write limit and asks again', async () => {
    const { root, store: open } = setup();
    let now = 2_000_000;
    const store = open(() => now);
    store.enableDefaults();
    const dailyWrites = store.snapshot().limits.dailyWrites;
    for (let i = 0; i < dailyWrites; i += 1) {
      now += 2_000;
      const result = await store.authorize(input(root, `self-review/day-${i}.md`, { payloadDigest: sha(`day ${i}`) }), allowPrompt);
      expect(result.decision, `write ${i}`).toBe('AUTO_ALLOW');
    }
    now += 2_000;
    expect(store.evaluate(input(root, 'self-review/last.md', { payloadDigest: sha('last') }))).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'daily-writes' });
  });

  it('writes no content and keeps the queue bounded by path and operation', async () => {
    const { root, store: open } = setup();
    const store = open();
    for (let i = 0; i < 12; i += 1) {
      await store.authorize(input(root, 'self-review/same.md', { background: true, payloadDigest: sha(`same ${i}`) }), allowPrompt);
    }
    await store.authorize(input(root, 'mind/now.md', { background: true, payloadDigest: sha('mind') }), allowPrompt);
    expect(store.snapshot().pendingCount).toBe(2);
    expect(() => readFileSync(join(root, 'self-review', 'same.md'))).toThrow();
  });
});
