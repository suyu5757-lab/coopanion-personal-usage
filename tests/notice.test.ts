import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { noticeDefinition, releaseNotes, NoticeWorld, type AlarmsState } from '../core/notice.ts';

/** A releases directory with one file per version, each `## 下载` section after its body. */
function releases(versions: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'coo-notes-'));
  for (const v of versions) writeFileSync(join(dir, `v${v}.md`), `# Coopanion v${v}\n\n本版 ${v}\n\n## 下载\n\n- 安装包 ${v}\n`);
  return dir;
}

describe('releaseNotes', () => {
  it('takes the versions after the last one run up to the running one, in version order', () => {
    // 0.1.9 sorts after 0.1.10 as text
    const dir = releases(['0.1.8', '0.1.9', '0.1.10', '0.1.11', '0.1.12']);
    expect(releaseNotes(dir, '0.1.8', '0.1.11').map((n) => n.version)).toEqual(['0.1.9', '0.1.10', '0.1.11']);
  });

  it('takes only the running version when the last one is unknown', () => {
    const dir = releases(['0.1.12', '0.1.13']);
    expect(releaseNotes(dir, null, '0.1.13').map((n) => n.version)).toEqual(['0.1.13']);
  });

  it('reads a version\'s English notes for English model text, its Chinese ones where there are none, each without its download list', () => {
    const dir = releases(['0.1.12', '0.1.13']);
    writeFileSync(join(dir, 'v0.1.13.en.md'), '# Coopanion v0.1.13\n\nThis release 0.1.13\n\n## Download\n\n- installer 0.1.13\n');
    const notes = releaseNotes(dir, '0.1.11', '0.1.13', 'en');
    expect(notes.map((n) => n.version)).toEqual(['0.1.12', '0.1.13']);
    expect(notes[0]!.text).toContain('本版 0.1.12');
    expect(notes[1]!.text).toContain('This release 0.1.13');
    expect(notes[1]!.text).not.toContain('installer');
  });

  it('leaves the download list out', () => {
    const [note] = releaseNotes(releases(['0.1.13']), null, '0.1.13');
    expect(note!.text).toContain('本版 0.1.13');
    expect(note!.text).not.toContain('安装包');
  });
});

describe('alarms panel', () => {
  it('deletes an alarm from Coo\'s list and tells Coo which one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-notice-'));
    const world = noticeDefinition({
      version: 'dev', notesDir: dir, stateFile: join(dir, 'notice.json'), alarmsFile: join(dir, 'alarms.json'),
      newInstall: () => true, read: () => undefined, petConnected: () => false, guiding: () => false,
      refreshTools: async () => {}, label: () => 'notice',
    }).create({ timezone: 'Asia/Shanghai' } as never);
    const notice = world as NoticeWorld;
    const pushed: Array<{ type: string; render: () => unknown }> = [];
    await world.start({ pushDeferred: (e: { type: string; render: () => unknown }) => pushed.push(e) } as unknown as WorldHost);
    try {
      const run = (name: string, args: Record<string, unknown>) => world.tools().find((t) => t.name === name)!.handler(args, {} as never) as Promise<{ text: string }>;
      await run('alarm_set', { note: '提醒喝水', in_minutes: 30 });
      await run('alarm_set', { note: '提醒睡觉', in_minutes: 90 });
      const panel = world.webUi!('zh');
      const [first] = ((await panel.invoke!('alarms', 'list', [])) as AlarmsState).alarms;
      const after = (await panel.invoke!('alarms', 'cancel', [first!.id])) as AlarmsState;
      expect(after.alarms.map((a) => a.note)).toEqual(['提醒睡觉']);
      expect((await run('alarm_list', {})).text).not.toContain('提醒喝水');
      expect(pushed.map((e) => e.type)).toEqual(['coopanion.alarm-cancelled']);
      const rendered = pushed[0]!.render() as { text: string };
      expect(rendered.text).toContain('提醒喝水');
      expect(notice.admitAlarmNotice(rendered)).toBe(true);
      expect(notice.admitAlarmNotice(rendered)).toBe(false);
      await expect(panel.invoke!('alarms', 'cancel', [first!.id])).rejects.toThrow();
    } finally {
      await world.stop();
    }
  });
});


describe('notice state recovery', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it.each(['', '{"version":', 'null', '{"version":7}'])('starts with invalid state %j', async (content) => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-notice-state-'));
    dirs.push(dir);
    const stateFile = join(dir, 'notice.json');
    writeFileSync(stateFile, content);
    const world = noticeDefinition({
      version: '0.2.6', notesDir: dir, stateFile, alarmsFile: join(dir, 'alarms.json'),
      newInstall: () => true, read: () => undefined, petConnected: () => false, guiding: () => false,
      refreshTools: async () => {}, label: () => 'notice',
    }).create({ timezone: 'UTC' } as never);
    await world.start({ pushDeferred: () => {} } as unknown as WorldHost);
    try {
      expect(readFileSync(`${stateFile}.bad`, 'utf8')).toBe(content);
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ version: '0.2.6' });
    } finally { await world.stop(); }
  });
});


describe('release notice source admission', () => {
  it.each(['zh', 'en'] as const)('admits one unchanged bundled update in %s', async (language) => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-update-proof-'));
    const world = new NoticeWorld({
      version: '0.4.0', notesDir: join(process.cwd(), 'docs', 'releases'),
      stateFile: join(dir, 'notice.json'), alarmsFile: join(dir, 'alarms.json'),
      newInstall: () => false, read: path => path === 'language' ? language : undefined,
      petConnected: () => true, guiding: () => false, refreshTools: async () => {}, label: () => 'notice',
    }, 'UTC');
    const queued: Array<{ type: string; render: () => unknown }> = [];
    await world.start({ pushDeferred: (e: { type: string; render: () => unknown }) => queued.push(e) } as unknown as WorldHost);
    try {
      (world as unknown as { tick(): void }).tick();
      expect(queued).toHaveLength(1);
      const rendered = queued[0]!.render() as { text: string };
      expect(queued[0]!.type).toBe('coopanion.updated');
      expect(world.admitUpdate({ ...rendered })).toBe(false);
      expect(world.admitUpdate(rendered)).toBe(true);
      expect(world.admitUpdate(rendered)).toBe(false);
    } finally { await world.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses changed release-note content', async () => {
    const dir = releases(['0.4.0']);
    const world = new NoticeWorld({
      version: '0.4.0', notesDir: dir, stateFile: join(dir, 'notice.json'), alarmsFile: join(dir, 'alarms.json'),
      newInstall: () => false, read: () => undefined, petConnected: () => true, guiding: () => false,
      refreshTools: async () => {}, label: () => 'notice',
    }, 'UTC');
    const queued: Array<{ render: () => unknown }> = [];
    await world.start({ pushDeferred: (e: { render: () => unknown }) => queued.push(e) } as unknown as WorldHost);
    try {
      (world as unknown as { tick(): void }).tick();
      const rendered = queued[0]!.render();
      expect(world.admitUpdate(rendered)).toBe(false);
    } finally { await world.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('settings change source admission', () => {
  it('admits only the current rendered setting summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-settings-source-'));
    let user = '伙伴';
    const queued: Array<{ type: string; render: () => unknown }> = [];
    let notify!: (event: { type: string; render: () => unknown }) => void;
    const queuedChange = new Promise<{ type: string; render: () => unknown }>((resolve) => { notify = resolve; });
    const world = new NoticeWorld({
      version: 'dev', notesDir: dir, stateFile: join(dir, 'notice.json'), alarmsFile: join(dir, 'alarms.json'),
      newInstall: () => false,
      read: (path) => path === 'worlds.desktop-pet.user' ? user : undefined,
      petConnected: () => true, guiding: () => false, refreshTools: async () => {}, label: () => 'notice',
    }, 'UTC');
    await world.start({ pushDeferred: (event: { type: string; render: () => unknown }) => {
      queued.push(event);
      if (event.type === 'coopanion.settings-changed') notify(event);
    } } as unknown as WorldHost);
    try {
      user = 'R4 验收伙伴';
      (world as unknown as { tick(): void }).tick();
      const event = await queuedChange;
      expect(event.type).toBe('coopanion.settings-changed');
      const rendered = event.render() as { text: string };
      expect(rendered.text).toContain('R4 验收伙伴');
      expect(world.admitSettingsChange({ ...rendered })).toBe(false);
      expect(world.admitSettingsChange(rendered)).toBe(true);
      expect(world.admitSettingsChange(rendered)).toBe(false);
    } finally {
      await world.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
