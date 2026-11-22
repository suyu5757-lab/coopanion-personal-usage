import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from 'cortico/core/template.ts';
import type { EventEnvelope, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { OPENCODE_DEFAULTS, type OpencodeConfigSection } from '../src/config.ts';
import { OPENCODE, opencodeDefinition } from '../src/definition.ts';
import type { ModelLanguage } from '../src/model-text.ts';
import { OpencodeWorld, type OpencodeActionCompletion, type OpencodeActionRequest, type OpencodeGuestState, type OpencodeWorldOptions } from '../src/world.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const HAN = /\p{Script=Han}/u;

class Host implements WorldHost {
  events: EventEnvelope[] = [];
  private all: EventEnvelope[] = [];

  pushDeferred(): void {}
  store = {
    get: () => undefined,
    latestCursor: () => this.all.length,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  blob = () => null;
  log = {
    child() { return this; },
    debug() {},
    info() {},
    warn() {},
    error() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  async pushEvent(e: Parameters<WorldHost['pushEvent']>[0]): Promise<EventEnvelope> {
    const full = { ...e, origin: 'external', contextDelivery: 'deliver', cursor: this.all.length + 1 } as EventEnvelope;
    this.all.push(full);
    this.events.push(full);
    return full;
  }

  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }

  reportUsage(): void {}
}

const textOf = (out: string | ToolOutcome): string => (typeof out === 'string' ? out : out.text);
const failed = (out: string | ToolOutcome): boolean => typeof out !== 'string' && out.failed === true;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function mounted(
  patch: Partial<OpencodeConfigSection> = {},
  language: ModelLanguage = 'zh',
  authorization: Pick<OpencodeWorldOptions, 'authorizeAction' | 'confirmAction'> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-'));
  const cfg: OpencodeConfigSection = { ...OPENCODE_DEFAULTS, ...patch, enabled: true };
  if (!('workRoots' in patch)) cfg.workRoots = dir;
  const states: OpencodeGuestState[] = [];
  const host = new Host();
  const world = new OpencodeWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    modelLanguage: () => language,
    command: { command: process.execPath, args: [FIXTURE] },
    ...authorization,
    onState: (state) => states.push(state),
  });
  await world.start(host);
  cleanup.push(async () => {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const ctx = { role: 'main', log: host.log };
  const call = (name: string, args: Record<string, unknown>) => world.tools().find((t) => t.name === name)!.handler(args, ctx);
  return { world, host, cfg, dir, states, call };
}

async function waitEvent(host: Host, type: string): Promise<EventEnvelope> {
  await expect.poll(() => host.events.find((e) => e.type === type), { timeout: 10_000 }).toBeTruthy();
  return host.events.find((e) => e.type === type)!;
}

describe('opencode World', () => {
  it('passes the extension dry mount', async () => {
    const report = await dryMountWorld(OPENCODE as never, {
      scratchDir: mkdtempSync(join(tmpdir(), 'opencode-dry-')),
      packageDir: fileURLToPath(new URL('../', import.meta.url)),
      hasWebUiClient: false,
    });
    expect(report.failures).toEqual([]);
  });

  it('runs a prompt and reports the result event', async () => {
    const { host, states, call } = await mounted();
    const started = await call('opencode_task', { task: 'PING' });
    expect(failed(started)).toBe(false);
    expect(textOf(started)).toMatch(/opencode-\d+/);
    const result = await waitEvent(host, 'opencode.result');
    expect(result.text).toContain('pong');
    expect(states.map((s) => s.state)).toEqual(expect.arrayContaining(['boot', 'done']));
  });

  it('relays a permission and writes through the fs method', async () => {
    const { host, dir, states, call } = await mounted();
    const started = await call('opencode_task', { task: 'WRITE hello.txt' });
    expect(failed(started)).toBe(false);
    const permission = await waitEvent(host, 'opencode.permission');
    expect(permission.text).toContain('hello.txt');
    expect((permission.meta as { options?: unknown[] }).options).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'allow_once' }),
      expect.objectContaining({ kind: 'allow_always' }),
      expect.objectContaining({ kind: 'reject_once' }),
    ]));
    const taskId = String((permission.meta as { taskId?: string }).taskId);
    const answer = await call('opencode_answer', { taskId, choice: 'once' });
    expect(failed(answer)).toBe(false);
    const result = await waitEvent(host, 'opencode.result');
    expect(result.text).toContain('Done');
    expect(result.text).toContain('跑过的命令');
    expect(result.text).toContain('先验收');
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hello from opencode');
    expect(states.map((s) => s.state)).toEqual(expect.arrayContaining(['wait', 'done']));

    const review = await call('opencode_review', { taskId, diff: true });
    expect(failed(review)).toBe(false);
    const reviewText = textOf(review);
    expect(reviewText).toContain('hello.txt (+1/-0)');
    expect(reviewText).toContain('printf hello');
    expect(reviewText).toContain('hello from opencode');
    expect(reviewText).toContain('新:');
  });

  it('does not write when the person rejects', async () => {
    const { host, dir, call } = await mounted();
    await call('opencode_task', { task: 'WRITE denied.txt' });
    const permission = await waitEvent(host, 'opencode.permission');
    const taskId = String((permission.meta as { taskId?: string }).taskId);
    await call('opencode_answer', { taskId, choice: 'reject' });
    const result = await waitEvent(host, 'opencode.result');
    expect(result.text).toContain('Denied');
    expect(existsSync(join(dir, 'denied.txt'))).toBe(false);
  });

  it('routes ACP file writes and commands through one Core confirmation and one dispatch receipt', async () => {
    const requests: OpencodeActionRequest[] = [];
    const completions: OpencodeActionCompletion[] = [];
    let consumed = 0;
    let confirmed = 0;
    const authorization: Pick<OpencodeWorldOptions, 'authorizeAction' | 'confirmAction'> = {
      confirmAction: async () => { confirmed++; return true; },
      authorizeAction: async (request, confirmInCoreUi) => {
        requests.push(request);
        if (!await confirmInCoreUi()) return null;
        return {
          consume(target, expectedChange, files) {
            expect(target).toMatchObject({ workspaceRoot: request.target.workspaceRoot, path: request.target.path, operation: request.action });
            expect(expectedChange).toBe(request.expectedChange);
            expect(files).toEqual(request.files);
            consumed++;
            return true;
          },
          revoke() {},
          complete: (result) => completions.push(result),
        };
      },
    };
    const { host, dir, world, call } = await mounted({}, 'zh', authorization);

    const started = await call('opencode_task', { task: 'WRITE guarded.txt' });
    expect(failed(started)).toBe(false);
    const fileResult = await waitEvent(host, 'opencode.result');
    expect(fileResult.text).toContain('Done');
    expect(readFileSync(join(dir, 'guarded.txt'), 'utf8')).toBe('hello from opencode');
    expect(world.tools().some((tool) => tool.name === 'opencode_answer')).toBe(false);
    expect(requests[0]).toMatchObject({ action: 'file-write', target: { path: 'guarded.txt', source: 'opencode-acp' }, files: [{ path: 'guarded.txt', bytes: 19, mime: 'text/plain' }] });
    expect(completions[0]).toMatchObject({ phase: 'verified', dispatchState: 'delivered', outcome: 'ui-observed' });

    const resultsBeforeCommand = host.events.filter((event) => event.type === 'opencode.result').length;
    await call('opencode_task', { task: 'RUN_COMMAND printf hello' });
    await expect.poll(() => host.events.filter((event) => event.type === 'opencode.result').length, { timeout: 10_000 }).toBe(resultsBeforeCommand + 1);
    const commandResult = host.events.filter((event) => event.type === 'opencode.result').at(-1)!;
    expect(commandResult.text).toContain('printf hello');
    expect(requests[1]).toMatchObject({ action: 'command-execution', target: { path: '.', source: 'opencode-acp' }, risk: 'IRREVERSIBLE_OR_PUBLIC' });
    expect(consumed).toBe(2);
    expect(confirmed).toBe(2);
    expect(completions).toContainEqual(expect.objectContaining({ phase: 'verified', outcome: 'remote-acknowledged' }));
  });

  it('does not accept an ACP file permission when Core refuses its one-time grant', async () => {
    const { host, dir, call } = await mounted({}, 'zh', {
      authorizeAction: async (request, confirmInCoreUi) => {
        expect(request.action).toBe('file-write');
        expect(await confirmInCoreUi()).toBe(false);
        return null;
      },
      confirmAction: async () => false,
    });
    await call('opencode_task', { task: 'WRITE refused.txt' });
    await waitEvent(host, 'opencode.result');
    expect(existsSync(join(dir, 'refused.txt'))).toBe(false);
  });

  it('cancels a running task', async () => {
    const { host, states, call } = await mounted();
    const started = await call('opencode_task', { task: 'SLOW' });
    const taskId = /opencode-\d+/.exec(textOf(started))?.[0]!;
    await expect.poll(() => states.some((s) => s.state === 'work'), { timeout: 5_000 }).toBe(true);
    await call('opencode_stop', { taskId });
    const result = await waitEvent(host, 'opencode.result');
    expect(result.text).toContain('cancelled');
  });

  it('refuses a path outside the task directory', async () => {
    const { host, dir, call } = await mounted();
    const outside = `outside-${process.pid}-${Date.now()}.txt`;
    await call('opencode_task', { task: `WRITE ../${outside}` });
    const permission = await waitEvent(host, 'opencode.permission');
    const taskId = String((permission.meta as { taskId?: string }).taskId);
    await call('opencode_answer', { taskId, choice: 'once' });
    const result = await waitEvent(host, 'opencode.result');
    expect(result.text).toContain('Could not write');
    expect(existsSync(join(dir, '..', outside))).toBe(false);
  });

  it('refuses a task with no allowed directory', async () => {
    const { cfg, call } = await mounted({ workRoots: '' });
    expect(cfg.workRoots).toBe('');
    const out = await call('opencode_task', { task: 'PING' });
    expect(failed(out)).toBe(true);
    expect(textOf(out)).toContain('没有允许');
  });

  it('refuses a directory outside the allowed roots', async () => {
    const other = mkdtempSync(join(tmpdir(), 'opencode-other-'));
    try {
      const { call } = await mounted();
      const out = await call('opencode_task', { task: 'PING', dir: other });
      expect(failed(out)).toBe(true);
      expect(textOf(out)).toContain('不在允许');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('asks for a directory when several roots are configured', async () => {
    const other = mkdtempSync(join(tmpdir(), 'opencode-other-'));
    try {
      const { cfg, call } = await mounted();
      cfg.workRoots = `${cfg.workRoots}\n${other}`;
      const out = await call('opencode_task', { task: 'PING' });
      expect(failed(out)).toBe(true);
      expect(textOf(out)).toContain('多个');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('gives the bot no Chinese in English', async () => {
    const { world, dir } = await mounted({}, 'en');
    const doc = world.webUi('en').promptDocs![0]!;
    const prompt = renderTemplate(readFileSync(doc.path, 'utf8'), await world.envPromptVars());
    expect(prompt).not.toMatch(HAN);
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain(dir);
    const decls = world.tools().map(({ handler: _, ...decl }) => decl);
    expect(JSON.stringify(decls)).not.toMatch(HAN);
  });

  it('fills every placeholder of the Chinese environment prompt', async () => {
    const { world, dir } = await mounted();
    const doc = world.webUi().promptDocs![0]!;
    const prompt = renderTemplate(readFileSync(doc.path, 'utf8'), await world.envPromptVars());
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain(dir);
  });

  it('answers only the task that is asking', async () => {
    const { call } = await mounted();
    const out = await call('opencode_answer', { taskId: 'opencode-999', choice: 'once' });
    expect(failed(out)).toBe(true);
    expect(textOf(out)).toContain('没有任务');
  });

  it('has no review before the first task', async () => {
    const { call } = await mounted();
    const out = await call('opencode_review', {});
    expect(failed(out)).toBe(true);
    expect(textOf(out)).toContain('验收');
  });
});

describe('opencode definition', () => {
  it('keeps the World off until the deployment enables it', () => {
    expect(opencodeDefinition().defaults().enabled).toBe(false);
  });
});
