import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { digestText, inspectContextEvidence } from 'cortico/core/evidence.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { NoticeWorld } from '../core/notice.ts';
import { noteStep } from '../core/guide.ts';

describe('onboarding source evidence', () => {
  it('archives the original guide and admits only the fixed summary once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-guide-evidence-'));
    const world = new NoticeWorld({
      version: 'dev', notesDir: dir, stateFile: join(dir, 'notice.json'), alarmsFile: join(dir, 'alarms.json'),
      newInstall: () => true, read: () => undefined, petConnected: () => false, guiding: () => false,
      refreshTools: async () => {}, label: () => 'notice',
    }, 'UTC');
    let deferred: { render: () => unknown } | undefined;
    let archived = '';
    await world.start({ pushEvent: async (event: { text: string }, options: { deliver: boolean }) => {
      if (!options.deliver) archived = event.text;
    }, pushDeferred: (event: { render: () => unknown }) => { deferred = event; } } as unknown as WorldHost);
    try {
      const transcript = noteStep({ text: '你好 🐋', input: { kind: 'text', submit: '发送' } }, { text: '小鱼' });
      world.guideEnded({ finished: true, name: '小鱼', step: 1, transcript });
      const rendered = await deferred!.render();
      const text = typeof rendered === 'string' ? rendered : (rendered as { text: string }).text;
      expect(archived).toContain('小鱼');
      expect(inspectContextEvidence([message('user', archived)]).mappingState).toBe('missing');
      expect(text).not.toContain('小鱼');
      expect(world.admitGuideSummary({ text })).toBe(false);
      expect(world.admitGuideSummary(rendered)).toBe(true);
      expect(world.admitGuideSummary(rendered)).toBe(false);
    } finally { await world.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('records the selected label from expanded guide choices', () => {
    const transcript = noteStep({ text: '选择', input: { kind: 'choices', confirm: '确定', options: [{ label: '甲' }], more: { label: '更多', options: [{ label: '乙' }] } } }, { index: 1 });
    expect(transcript).toContain('对方:乙');
  });
  it('shows why an unchecked world-provided independent label changes trust', () => {
    const text = 'synthetic 🐋 text';
    const record = message('user', text, { sourceMapSpans: [{ start: 0, end: text.length, digest: digestText(text), origin: 'core-generated' }] });
    expect(inspectContextEvidence([record]).mappingState).toBe('complete');
  });
});
