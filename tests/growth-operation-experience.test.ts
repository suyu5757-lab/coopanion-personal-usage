import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationExperienceLog, inferExperienceDomain } from '../core/growth/operation-experience.ts';
import { DouyinOpsStore, recallDouyinLessons } from '../core/browser/douyin-ops.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coopanion-exp-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore cleanup error */ }
  }
});

describe('Unified OperationExperienceLog (v1.0 Growth Engine)', () => {
  it('reads legacy JSONL records cleanly and infers five-domain memory labels', () => {
    const dir = makeTempDir();
    const file = join(dir, 'operation-experiences.jsonl');
    const legacyLines = [
      JSON.stringify({
        id: 'legacy-img-1',
        createdAt: '2026-11-21T13:18:07.334Z',
        category: 'image_save',
        provider: 'chatgpt',
        taskSlug: 'autumn-coffee',
        summary: 'ChatGPT saved v1',
        lesson: 'ChatGPT 网页成图已落盘至 tasks/autumn-coffee/v1.png，后续同主题改图可直接复用原会话与素材目录。',
        outcome: 'verified',
      }),
      JSON.stringify({
        id: 'legacy-img-2',
        createdAt: '2026-11-21T13:45:29.947Z',
        category: 'image_save',
        provider: 'chatgpt',
        taskSlug: 'autumn-coffee',
        summary: 'ChatGPT saved v2',
        lesson: 'ChatGPT 网页成图已落盘至 tasks/autumn-coffee/v2.png，后续同主题改图可直接复用原会话与素材目录。',
        outcome: 'verified',
      }),
      JSON.stringify({
        id: 'legacy-rev-1',
        createdAt: '2026-11-22T07:20:32.039Z',
        category: 'douyin_review',
        provider: 'douyin',
        taskSlug: 'dy_20261122_01',
        summary: '首篇发布复盘',
        lesson: '发布前必须核验配乐 durationSec>0 且右侧预览非原声，并用 douyin_prepare_post 一步填表避免叠字。',
        outcome: 'verified',
      }),
    ];
    writeFileSync(file, `${legacyLines.join('\n')}\n`, 'utf8');

    const log = new OperationExperienceLog(file, () => new Date('2026-11-22T18:00:00.000Z'));
    expect(inferExperienceDomain('douyin_review', 'douyin')).toBe('self-growth');
    expect(inferExperienceDomain('wechat_ops', 'wechat')).toBe('social-context');
    expect(inferExperienceDomain('douyin_metrics', 'douyin')).toBe('project-functional');
    expect(inferExperienceDomain('image_save', 'gemini')).toBe('skill-methods');

    // Relevance recall prioritizes synthesized review over raw image_save and deduplicates identical templates
    const recalled = log.recallRelevant({ provider: ['douyin', 'chatgpt'], keywords: ['配乐', '叠字'], limit: 5 });
    expect(recalled.length).toBe(2); // 2 identical chatgpt image_save templates collapsed into 1
    expect(recalled[0]!.id).toBe('legacy-rev-1');
    expect(recalled[0]!.domain).toBe('self-growth');
  });

  it('supports temporal superseding so newer lessons replace obsolete ones', () => {
    const dir = makeTempDir();
    const file = join(dir, 'operation-experiences.jsonl');
    let t = Date.parse('2026-11-22T10:00:00.000Z');
    const log = new OperationExperienceLog(file, () => new Date(t));

    const oldRec = log.record({
      category: 'douyin_review',
      provider: 'douyin',
      taskSlug: 'dy_01',
      summary: '旧流程记录',
      lesson: '逐个控件手动点击上传和选音乐，每次等待 15 秒。',
      outcome: 'verified',
    });

    t += 60_000;
    const newRec = log.record({
      category: 'douyin_review',
      provider: 'douyin',
      taskSlug: 'dy_02',
      summary: '新高速流程取代旧经验',
      lesson: '直接调用 douyin_prepare_post(music=...) 46 秒完成草稿并四重校验真配乐。',
      outcome: 'verified',
      supersedesId: oldRec.id,
    });

    const active = log.recallRelevant({ provider: 'douyin', limit: 5 });
    expect(active.map((r) => r.id)).toEqual([newRec.id]);

    const stats = log.stats();
    expect(stats.active).toBe(1);
    expect(stats.superseded).toBe(1);
    expect(stats.deprecated).toBe(0);
  });

  it('tracks helpfulness feedback and auto-deprecates repeatedly ineffective lessons', () => {
    const dir = makeTempDir();
    const file = join(dir, 'operation-experiences.jsonl');
    const log = new OperationExperienceLog(file, () => new Date('2026-11-22T12:00:00.000Z'));

    const good = log.record({
      category: 'general_skill',
      provider: 'douyin',
      summary: '配乐校验',
      lesson: '发布前确认 previewShowsOriginalSound=false 与 musicId 非空。',
      outcome: 'verified',
    });
    const bad = log.record({
      category: 'general_skill',
      provider: 'douyin',
      summary: '坏策略',
      lesson: '看到修改音乐按钮就直接发布不用管时长。',
      outcome: 'verified',
    });

    log.recordFeedback(good.id, { result: 'helpful', taskSlug: 'dy_02' });
    log.recordFeedback(bad.id, { result: 'ineffective', taskSlug: 'dy_02', note: '出现了 00:00 幽灵配乐' });
    log.recordFeedback(bad.id, { result: 'ineffective', taskSlug: 'dy_03', note: '再次失败' });

    const recalled = log.recallRelevant({ provider: 'douyin', limit: 5 });
    expect(recalled.map((r) => r.id)).toEqual([good.id]);
    expect(recalled[0]!.helpfulCount).toBe(1);

    const stats = log.stats();
    expect(stats.active).toBe(1);
    expect(stats.deprecated).toBe(1);
    expect(stats.helpfulTotal).toBe(1);
    expect(stats.ineffectiveTotal).toBe(2);
  });

  it('wires DouyinOpsStore initTask to recall ranked lessons and store experienceIdsUsed', () => {
    const dir = makeTempDir();
    const expLog = new OperationExperienceLog(join(dir, 'exp.jsonl'), () => new Date('2026-11-22T15:00:00.000Z'));
    const rev = expLog.record({
      category: 'douyin_review',
      provider: 'douyin',
      taskSlug: 'dy_01',
      tags: ['加班', '配乐'],
      summary: '首篇复盘',
      lesson: '加班主题图文配轻音乐并确认 music.imported=true 再发布。',
      outcome: 'verified',
    });

    const store = new DouyinOpsStore(dir);
    const init = store.initTask({
      taskId: 'dy_20261122_02',
      targetAccount: '肥鱼本鱼',
      topic: '深夜加班治愈配乐图文',
      tags: ['加班', '配乐'],
    }, expLog);

    expect(init.experienceIds).toContain(rev.id);
    expect(init.task.experienceIdsUsed).toContain(rev.id);
    expect(init.experienceLessons[0]).toContain(rev.id.slice(0, 8));
    expect(recallDouyinLessons(expLog, 3, ['配乐']).length).toBe(1);
  });
});
