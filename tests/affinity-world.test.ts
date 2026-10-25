import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { AFFINITY_DEFAULTS } from '../extensions/cortico-world-affinity-alont1/src/config.ts';
import { AffinityWorld } from '../extensions/cortico-world-affinity-alont1/src/world.ts';

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'coo-affinity-'));
  const events: Array<Record<string, unknown>> = [];
  const host = {
    pushEvent: async (event: Record<string, unknown>) => { events.push(event); return event as never; },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as WorldHost;
  const w = new AffinityWorld({
    cfg: { ...AFFINITY_DEFAULTS, enabled: true, masterId: 0, subjectId: 7, startScore: 20 },
    dataDir: dir,
    timezone: 'Asia/Shanghai',
    botDir: dir,
  });
  const tool = (name: string) => w.tools().find((t) => t.name === name)!;
  return { w, host, events, tool };
}

const call = (tool: ReturnType<typeof world>['tool'], name: string, args: Record<string, unknown> = {}) =>
  tool(name).handler(args, {} as never) as Promise<string>;

describe('affinity as a felt sense', () => {
  it('gives the model feelings and unresolved matters, not a scoreboard', async () => {
    const { w, host, events, tool } = world();
    await w.start(host);
    const felt = await call(tool, 'affinity_get');
    expect(felt).toContain('你们现在');
    expect(felt).not.toMatch(/\/ 100|%|好感 \d|再涨 \d|聊过 \d/);

    const recorded = await call(tool, 'affinity_feel', {
      kind: 'angry', intensity: 0.8, reason: '他忘了约定', target: 'him', need: 'recognition', expression: 'hint', unresolved: true,
    });
    expect(recorded).toContain('有火');
    expect(recorded).toContain('还没过去');
    expect(recorded).not.toMatch(/\d+%/);

    const withOpen = await call(tool, 'affinity_get');
    expect(withOpen).toContain('还没过去的事');
    expect(w.envPromptVars()['affinity.emotions']).toContain('他忘了约定');
    expect(withOpen).toContain('他忘了约定');
    expect(withOpen).toContain('可以漏一点');
    expect(withOpen).not.toMatch(/\/ 100|%/);

    const repaired = await call(tool, 'affinity_repair', { which: '忘了约定', note: '道歉了', relief: 1 });
    expect(repaired).toContain('过去了');
    const after = await call(tool, 'affinity_get');
    expect(after).not.toContain('还没过去的事');

    const moved = await call(tool, 'affinity_adjust', { delta: 1, reason: '一起喝茶' });
    expect(moved).toContain('近了一点');
    expect(moved).not.toMatch(/→|\/ 100|%/);

    const changed = events.filter((e) => e.type === 'affinity.changed');
    expect(changed.length).toBeGreaterThanOrEqual(3);
    for (const event of changed) expect(String(event.text)).not.toMatch(/→|\/ 100|%/);
    await w.stop();
  });
});
