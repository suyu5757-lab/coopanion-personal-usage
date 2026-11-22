/**
 * S3 Douyin graphic-post lifecycle store (`douyin-ops/<taskId>/post_task.json` + `images/`).
 * Keeps the single-file task contract and links Growth lessons from `operation-experiences.jsonl`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { OperationExperienceLog, ScoredExperienceRecord } from '../growth/operation-experience.ts';

export type DouyinPostTaskStatus =
  | 'DRAFT'
  | 'READY'
  | 'PUBLISHING'
  | 'UNDER_REVIEW'
  | 'PUBLISHED'
  | 'FAILED'
  | 'UNKNOWN';

export interface DouyinMetricsSnapshot {
  recordedAt: string;
  views: number;
  likes: number;
  collections: number;
  comments: number;
  shares: number;
}

export interface DouyinCommentItem {
  commentId: string;
  user: string;
  text: string;
  replyDraft?: string;
  isReplied: boolean;
  repliedAt?: string;
}

export interface DouyinPostTask {
  taskId: string;
  targetAccount: string;
  targetAccountRef?: string;
  topic: string;
  title: string;
  body: string;
  tags: string[];
  finalImagePaths: string[];
  music?: string;
  aiDisclosure: boolean;
  status: DouyinPostTaskStatus;
  postId?: string;
  postUrl?: string;
  reviewStatus?: string;
  publishedAt?: string;
  metricsSnapshots: DouyinMetricsSnapshot[];
  comments: DouyinCommentItem[];
  experienceLessonsUsed?: string[];
  experienceIdsUsed?: string[];
  updatedAt?: string;
}

export function sanitizeTaskId(raw: string): string {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 64);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('taskId must contain letters, digits, underscores or hyphens');
  }
  return cleaned;
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of tags) {
    if (typeof item !== 'string') continue;
    const clean = item.replace(/^#+/, '').replace(/\s+/g, '').trim().slice(0, 32);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 10) break;
  }
  return out;
}

export function recallDouyinLessonEntries(
  log: OperationExperienceLog | null,
  limit = 5,
  keywords: string[] = [],
): ScoredExperienceRecord[] {
  if (!log) return [];
  return log.recallRelevant({
    provider: ['douyin', 'chatgpt', 'gemini'],
    domain: ['self-growth', 'skill-methods', 'project-functional', 'social-context'],
    keywords,
    limit,
    deduplicate: true,
  });
}

export function recallDouyinLessons(
  log: OperationExperienceLog | null,
  limit = 5,
  keywords: string[] = [],
): string[] {
  if (!log) return [];
  return recallDouyinLessonEntries(log, limit, keywords).map((item) => log.formatLesson(item));
}

export class DouyinOpsStore {
  private readonly opsRoot: string;

  constructor(private readonly workspaceDir: string) {
    this.opsRoot = join(resolve(workspaceDir), 'douyin-ops');
  }

  taskDir(taskId: string): string {
    return join(this.opsRoot, sanitizeTaskId(taskId));
  }

  imagesDir(taskId: string): string {
    return join(this.taskDir(taskId), 'images');
  }

  taskFile(taskId: string): string {
    return join(this.taskDir(taskId), 'post_task.json');
  }

  private writeTask(task: DouyinPostTask): DouyinPostTask {
    const dir = this.taskDir(task.taskId);
    mkdirSync(join(dir, 'images'), { recursive: true });
    const next: DouyinPostTask = {
      ...task,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.taskFile(task.taskId), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  getTask(taskId: string): DouyinPostTask | null {
    const file = this.taskFile(taskId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DouyinPostTask>;
      if (!parsed || typeof parsed.taskId !== 'string') return null;
      return {
        taskId: parsed.taskId,
        targetAccount: typeof parsed.targetAccount === 'string' ? parsed.targetAccount : '',
        ...(typeof parsed.targetAccountRef === 'string' && parsed.targetAccountRef ? { targetAccountRef: parsed.targetAccountRef } : {}),
        topic: typeof parsed.topic === 'string' ? parsed.topic : '',
        title: typeof parsed.title === 'string' ? parsed.title : '',
        body: typeof parsed.body === 'string' ? parsed.body : '',
        tags: Array.isArray(parsed.tags) ? normalizeTags(parsed.tags) : [],
        finalImagePaths: Array.isArray(parsed.finalImagePaths)
          ? parsed.finalImagePaths.filter((p): p is string => typeof p === 'string' && !!p.trim())
          : [],
        ...(typeof parsed.music === 'string' && parsed.music.trim() ? { music: parsed.music.trim() } : {}),
        aiDisclosure: parsed.aiDisclosure === true,
        status: (parsed.status as DouyinPostTaskStatus) || 'DRAFT',
        ...(typeof parsed.postId === 'string' && parsed.postId ? { postId: parsed.postId } : {}),
        ...(typeof parsed.postUrl === 'string' && parsed.postUrl ? { postUrl: parsed.postUrl } : {}),
        ...(typeof parsed.reviewStatus === 'string' && parsed.reviewStatus ? { reviewStatus: parsed.reviewStatus } : {}),
        ...(typeof parsed.publishedAt === 'string' && parsed.publishedAt ? { publishedAt: parsed.publishedAt } : {}),
        metricsSnapshots: Array.isArray(parsed.metricsSnapshots) ? parsed.metricsSnapshots : [],
        comments: Array.isArray(parsed.comments) ? parsed.comments : [],
        ...(Array.isArray(parsed.experienceLessonsUsed) ? { experienceLessonsUsed: parsed.experienceLessonsUsed } : {}),
        ...(Array.isArray(parsed.experienceIdsUsed) ? { experienceIdsUsed: parsed.experienceIdsUsed.filter((x): x is string => typeof x === 'string') } : {}),
        ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      };
    } catch {
      return null;
    }
  }

  listTasks(): Array<{
    taskId: string;
    targetAccount: string;
    topic: string;
    title: string;
    status: DouyinPostTaskStatus;
    postId?: string;
    postUrl?: string;
    metricsCount: number;
    commentsCount: number;
    updatedAt?: string;
  }> {
    if (!existsSync(this.opsRoot)) return [];
    const entries = readdirSync(this.opsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    const tasks = [];
    for (const entry of entries) {
      const task = this.getTask(entry.name);
      if (!task) continue;
      tasks.push({
        taskId: task.taskId,
        targetAccount: task.targetAccount,
        topic: task.topic,
        title: task.title,
        status: task.status,
        ...(task.postId ? { postId: task.postId } : {}),
        ...(task.postUrl ? { postUrl: task.postUrl } : {}),
        metricsCount: task.metricsSnapshots.length,
        commentsCount: task.comments.length,
        ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
      });
    }
    return tasks.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }

  initTask(
    input: {
      taskId: string;
      targetAccount?: string;
      targetAccountRef?: string;
      topic?: string;
      title?: string;
      body?: string;
      tags?: string[];
      finalImagePaths?: string[];
      music?: string;
      aiDisclosure?: boolean;
    },
    experienceLog: OperationExperienceLog | null,
  ): {
    task: DouyinPostTask;
    taskFile: string;
    imagesDir: string;
    experienceLessons: string[];
    experienceIds: string[];
    existed: boolean;
  } {
    const id = sanitizeTaskId(input.taskId);
    const keywords = [input.topic, input.title, ...(input.tags ?? [])].filter((s): s is string => typeof s === 'string' && !!s.trim());
    const recalled = recallDouyinLessonEntries(experienceLog, 6, keywords);
    const experienceLessons = experienceLog ? recalled.map((item) => experienceLog.formatLesson(item)) : [];
    const experienceIds = recalled.map((item) => item.id);
    const existing = this.getTask(id);
    if (existing) {
      const merged: DouyinPostTask = {
        ...existing,
        ...(typeof input.targetAccount === 'string' && input.targetAccount.trim() ? { targetAccount: input.targetAccount.trim() } : {}),
        ...(typeof input.targetAccountRef === 'string' && input.targetAccountRef.trim() ? { targetAccountRef: input.targetAccountRef.trim() } : {}),
        ...(typeof input.topic === 'string' && input.topic.trim() ? { topic: input.topic.trim() } : {}),
        ...(typeof input.title === 'string' && input.title.trim() ? { title: input.title.trim() } : {}),
        ...(typeof input.body === 'string' && input.body.trim() ? { body: input.body.trim() } : {}),
        ...(Array.isArray(input.tags) && input.tags.length ? { tags: normalizeTags(input.tags) } : {}),
        ...(Array.isArray(input.finalImagePaths) && input.finalImagePaths.length ? { finalImagePaths: input.finalImagePaths } : {}),
        ...(typeof input.music === 'string' && input.music.trim() ? { music: input.music.trim() } : {}),
        ...(typeof input.aiDisclosure === 'boolean' ? { aiDisclosure: input.aiDisclosure } : {}),
        ...(experienceLessons.length && !existing.experienceLessonsUsed?.length ? { experienceLessonsUsed: experienceLessons } : {}),
        ...(experienceIds.length && !existing.experienceIdsUsed?.length ? { experienceIdsUsed: experienceIds } : {}),
      };
      const saved = this.writeTask(merged);
      return { task: saved, taskFile: this.taskFile(id), imagesDir: this.imagesDir(id), experienceLessons, experienceIds, existed: true };
    }
    const created: DouyinPostTask = {
      taskId: id,
      targetAccount: typeof input.targetAccount === 'string' ? input.targetAccount.trim() : '',
      ...(typeof input.targetAccountRef === 'string' && input.targetAccountRef.trim() ? { targetAccountRef: input.targetAccountRef.trim() } : {}),
      topic: typeof input.topic === 'string' ? input.topic.trim() : '',
      title: typeof input.title === 'string' ? input.title.trim() : '',
      body: typeof input.body === 'string' ? input.body.trim() : '',
      tags: normalizeTags(input.tags),
      finalImagePaths: Array.isArray(input.finalImagePaths)
        ? input.finalImagePaths.filter((p): p is string => typeof p === 'string' && !!p.trim())
        : [],
      ...(typeof input.music === 'string' && input.music.trim() ? { music: input.music.trim() } : {}),
      aiDisclosure: input.aiDisclosure === true,
      status: 'DRAFT',
      metricsSnapshots: [],
      comments: [],
      ...(experienceLessons.length ? { experienceLessonsUsed: experienceLessons } : {}),
      ...(experienceIds.length ? { experienceIdsUsed: experienceIds } : {}),
    };
    const saved = this.writeTask(created);
    return { task: saved, taskFile: this.taskFile(id), imagesDir: this.imagesDir(id), experienceLessons, experienceIds, existed: false };
  }

  updateTask(taskId: string, patch: Partial<Omit<DouyinPostTask, 'taskId'>>): DouyinPostTask {
    const id = sanitizeTaskId(taskId);
    const existing = this.getTask(id) ?? {
      taskId: id,
      targetAccount: '',
      topic: '',
      title: '',
      body: '',
      tags: [],
      finalImagePaths: [],
      aiDisclosure: false,
      status: 'DRAFT' as DouyinPostTaskStatus,
      metricsSnapshots: [],
      comments: [],
    };
    const next: DouyinPostTask = {
      ...existing,
      ...(typeof patch.targetAccount === 'string' ? { targetAccount: patch.targetAccount.trim() } : {}),
      ...(typeof patch.targetAccountRef === 'string' ? { targetAccountRef: patch.targetAccountRef.trim() } : {}),
      ...(typeof patch.topic === 'string' ? { topic: patch.topic.trim() } : {}),
      ...(typeof patch.title === 'string' ? { title: patch.title.trim() } : {}),
      ...(typeof patch.body === 'string' ? { body: patch.body.trim() } : {}),
      ...(Array.isArray(patch.tags) ? { tags: normalizeTags(patch.tags) } : {}),
      ...(Array.isArray(patch.finalImagePaths)
        ? { finalImagePaths: patch.finalImagePaths.filter((p): p is string => typeof p === 'string' && !!p.trim()) }
        : {}),
      ...(typeof patch.music === 'string' && patch.music.trim() ? { music: patch.music.trim() } : {}),
      ...(typeof patch.aiDisclosure === 'boolean' ? { aiDisclosure: patch.aiDisclosure } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(typeof patch.postId === 'string' && patch.postId.trim() ? { postId: patch.postId.trim() } : {}),
      ...(typeof patch.postUrl === 'string' && patch.postUrl.trim() ? { postUrl: patch.postUrl.trim() } : {}),
      ...(typeof patch.reviewStatus === 'string' && patch.reviewStatus.trim() ? { reviewStatus: patch.reviewStatus.trim() } : {}),
      ...(typeof patch.publishedAt === 'string' && patch.publishedAt.trim() ? { publishedAt: patch.publishedAt.trim() } : {}),
      ...(Array.isArray(patch.metricsSnapshots) ? { metricsSnapshots: patch.metricsSnapshots } : {}),
      ...(Array.isArray(patch.comments) ? { comments: patch.comments } : {}),
      ...(Array.isArray(patch.experienceLessonsUsed) ? { experienceLessonsUsed: patch.experienceLessonsUsed } : {}),
    };
    return this.writeTask(next);
  }

  /** Copies finalized images from `data/video/media/` into `douyin-ops/<taskId>/images/` and records relative paths. */
  syncImagesFromMedia(taskId: string, mediaDir: string, relativeMediaPaths: string[]): DouyinPostTask {
    const id = sanitizeTaskId(taskId);
    const destDir = this.imagesDir(id);
    mkdirSync(destDir, { recursive: true });
    const synced: string[] = [];
    const rootResolved = resolve(mediaDir);
    for (let i = 0; i < relativeMediaPaths.length; i++) {
      const rel = relativeMediaPaths[i]!.trim();
      if (!rel || rel.includes('..')) continue;
      const src = resolve(rootResolved, rel);
      if (!src.startsWith(rootResolved) || !existsSync(src)) continue;
      const ext = extname(src) || '.png';
      const destName = `final_${String(i + 1).padStart(2, '0')}${ext}`;
      copyFileSync(src, join(destDir, destName));
      synced.push(`images/${destName}`);
    }
    if (!synced.length) {
      throw new Error('no valid source images found in media directory to sync');
    }
    return this.updateTask(id, { finalImagePaths: synced });
  }

  appendMetrics(taskId: string, snapshot: Omit<DouyinMetricsSnapshot, 'recordedAt'> & { recordedAt?: string }): {
    task: DouyinPostTask;
    latest: DouyinMetricsSnapshot;
    delta: Record<string, number> | null;
  } {
    const id = sanitizeTaskId(taskId);
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    const latest: DouyinMetricsSnapshot = {
      recordedAt: snapshot.recordedAt || new Date().toISOString(),
      views: Math.max(0, Math.round(Number(snapshot.views) || 0)),
      likes: Math.max(0, Math.round(Number(snapshot.likes) || 0)),
      collections: Math.max(0, Math.round(Number(snapshot.collections) || 0)),
      comments: Math.max(0, Math.round(Number(snapshot.comments) || 0)),
      shares: Math.max(0, Math.round(Number(snapshot.shares) || 0)),
    };
    const prev = existing.metricsSnapshots.at(-1);
    const delta = prev
      ? {
        views: latest.views - prev.views,
        likes: latest.likes - prev.likes,
        collections: latest.collections - prev.collections,
        comments: latest.comments - prev.comments,
        shares: latest.shares - prev.shares,
      }
      : null;
    const task = this.updateTask(id, {
      metricsSnapshots: [...existing.metricsSnapshots, latest],
    });
    return { task, latest, delta };
  }

  mergeComments(taskId: string, incoming: Array<Omit<DouyinCommentItem, 'isReplied'> & { isReplied?: boolean }>): DouyinPostTask {
    const id = sanitizeTaskId(taskId);
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    const byId = new Map<string, DouyinCommentItem>(existing.comments.map((c) => [c.commentId, c]));
    for (const raw of incoming) {
      const cid = String(raw.commentId || '').trim();
      if (!cid) continue;
      const prev = byId.get(cid);
      byId.set(cid, {
        commentId: cid,
        user: String(raw.user || prev?.user || '').trim(),
        text: String(raw.text || prev?.text || '').trim(),
        ...(raw.replyDraft ?? prev?.replyDraft ? { replyDraft: raw.replyDraft ?? prev?.replyDraft } : {}),
        isReplied: raw.isReplied === true || prev?.isReplied === true,
        ...(prev?.repliedAt ? { repliedAt: prev.repliedAt } : {}),
      });
    }
    return this.updateTask(id, { comments: [...byId.values()] });
  }

  markCommentReplied(taskId: string, commentId: string, replyText: string): DouyinPostTask {
    const id = sanitizeTaskId(taskId);
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    const now = new Date().toISOString();
    let found = false;
    const updated = existing.comments.map((item) => {
      if (item.commentId !== commentId) return item;
      found = true;
      return { ...item, replyDraft: replyText, isReplied: true, repliedAt: now };
    });
    if (!found) {
      updated.push({
        commentId,
        user: '',
        text: '',
        replyDraft: replyText,
        isReplied: true,
        repliedAt: now,
      });
    }
    return this.updateTask(id, { comments: updated });
  }
}

export function basenameSafe(filePath: string): string {
  return basename(filePath);
}
