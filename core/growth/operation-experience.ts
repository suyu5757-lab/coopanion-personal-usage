/**
 * Unified Operation Experience Engine (v1.0):
 * Durable, append-only experience store linking real-world task executions (web image creation,
 * Douyin ops, desktop CUA, browser navigation, WeChat ops) with five-domain memory classification,
 * temporal superseding, effectiveness feedback scoring, and relevance-ranked recall.
 *
 * 100% backward-compatible with legacy `operation-experiences.jsonl` records.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DomainId } from '../memory/source-domains.ts';

export type OperationExperienceCategory =
  | 'image_generation'
  | 'image_edit'
  | 'image_save'
  | 'douyin_upload'
  | 'douyin_publish'
  | 'douyin_comment_reply'
  | 'douyin_metrics'
  | 'douyin_review'
  | 'desktop_cua'
  | 'browser_navigation'
  | 'wechat_ops'
  | 'general_skill';

export type OperationExperienceProvider =
  | 'chatgpt'
  | 'gemini'
  | 'douyin'
  | 'desktop'
  | 'browser'
  | 'wechat'
  | 'system';

export type OperationExperienceOutcome = 'verified' | 'submitted' | 'unknown' | 'failed';
export type ExperienceLifecycleStatus = 'active' | 'superseded' | 'deprecated';
export type ExperienceFeedbackResult = 'helpful' | 'ineffective' | 'superseded' | 'deprecated';

export interface ExperienceRecord {
  id: string;
  createdAt: string;
  category: OperationExperienceCategory;
  provider: OperationExperienceProvider;
  domain?: DomainId;
  tags?: string[];
  taskSlug?: string;
  summary: string;
  lesson: string;
  outcome: OperationExperienceOutcome;
  status?: ExperienceLifecycleStatus;
  supersedesId?: string;
  artifacts?: string[];
  url?: string;
}

export interface ExperienceFeedbackEvent {
  kind: 'feedback';
  id: string;
  experienceId: string;
  createdAt: string;
  result: ExperienceFeedbackResult;
  taskSlug?: string;
  note?: string;
  supersededById?: string;
}

export interface ScoredExperienceRecord extends ExperienceRecord {
  domain: DomainId;
  effectiveStatus: ExperienceLifecycleStatus;
  appliedCount: number;
  helpfulCount: number;
  ineffectiveCount: number;
  score: number;
  supersededById?: string;
}

export type ExperienceRecordInput = Omit<ExperienceRecord, 'id' | 'createdAt'>;

export interface ExperienceRecallQuery {
  provider?: OperationExperienceProvider | OperationExperienceProvider[];
  category?: OperationExperienceCategory | OperationExperienceCategory[];
  domain?: DomainId | DomainId[];
  taskSlug?: string;
  keywords?: string[];
  limit?: number;
  includeFailed?: boolean;
  includeInactive?: boolean;
  deduplicate?: boolean;
}

export interface ExperienceStats {
  total: number;
  active: number;
  superseded: number;
  deprecated: number;
  helpfulTotal: number;
  ineffectiveTotal: number;
  byDomain: Record<string, number>;
  byProvider: Record<string, number>;
}

const VALID_DOMAINS = new Set<DomainId>([
  'user-relationship',
  'project-functional',
  'skill-methods',
  'social-context',
  'self-growth',
]);

export function inferExperienceDomain(
  category: OperationExperienceCategory,
  provider: OperationExperienceProvider,
): DomainId {
  if (category === 'douyin_comment_reply' || category === 'wechat_ops' || provider === 'wechat') {
    return 'social-context';
  }
  if (category === 'douyin_review' || category === 'general_skill') {
    return 'self-growth';
  }
  if (category === 'douyin_metrics') {
    return 'project-functional';
  }
  return 'skill-methods';
}

function normalizeTags(tags: readonly string[] | undefined): string[] | undefined {
  if (!tags?.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const clean = String(raw ?? '').trim().toLowerCase().slice(0, 40);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 12) break;
  }
  return out.length ? out : undefined;
}

/** Extracts lowercase Chinese bi-grams / words and ASCII tokens for lightweight keyword scoring. */
export function extractKeywords(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  const tokens = new Set<string>();
  for (const m of lower.matchAll(/[a-z0-9_-]{2,}/g)) {
    tokens.add(m[0]);
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seg = m[0];
    if (seg.length <= 6) {
      tokens.add(seg);
    }
    for (let i = 0; i <= seg.length - 2 && tokens.size < 48; i++) {
      tokens.add(seg.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/** Normalizes boilerplate paths/timestamps so near-duplicate file-save logs collapse cleanly. */
function dedupeSignature(record: Pick<ExperienceRecord, 'provider' | 'category' | 'lesson'>): string {
  const normalized = record.lesson
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/tasks\/[^\s，。,；;]+/g, '<task-file>')
    .replace(/[a-f0-9-]{8,}/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return `${record.provider}:${record.category}:${normalized.slice(0, 120)}`;
}

function asSet<T>(value: T | T[] | undefined): Set<T> | null {
  if (value === undefined) return null;
  return new Set(Array.isArray(value) ? value : [value]);
}

export class OperationExperienceLog {
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: ExperienceRecordInput): ExperienceRecord {
    const domain = input.domain && VALID_DOMAINS.has(input.domain)
      ? input.domain
      : inferExperienceDomain(input.category, input.provider);
    const tags = normalizeTags(input.tags);
    const entry: ExperienceRecord = {
      id: randomUUID(),
      createdAt: this.now().toISOString(),
      category: input.category,
      provider: input.provider,
      domain,
      ...(tags ? { tags } : {}),
      ...(input.taskSlug ? { taskSlug: input.taskSlug.slice(0, 64) } : {}),
      summary: input.summary.replace(/\s+/g, ' ').trim().slice(0, 300),
      lesson: input.lesson.replace(/\s+/g, ' ').trim().slice(0, 400),
      outcome: input.outcome,
      ...(input.status ? { status: input.status } : {}),
      ...(input.supersedesId ? { supersedesId: input.supersedesId.slice(0, 64) } : {}),
      ...(input.artifacts?.length ? { artifacts: input.artifacts.slice(0, 10) } : {}),
      ...(input.url ? { url: input.url.slice(0, 400) } : {}),
    };
    this.appendLine(entry);
    return entry;
  }

  recordFeedback(
    experienceId: string,
    input: {
      result: ExperienceFeedbackResult;
      taskSlug?: string;
      note?: string;
      supersededById?: string;
    },
  ): ExperienceFeedbackEvent | null {
    const cleanId = String(experienceId ?? '').trim();
    if (!cleanId) return null;
    const event: ExperienceFeedbackEvent = {
      kind: 'feedback',
      id: randomUUID(),
      experienceId: cleanId.slice(0, 64),
      createdAt: this.now().toISOString(),
      result: input.result,
      ...(input.taskSlug ? { taskSlug: input.taskSlug.slice(0, 64) } : {}),
      ...(input.note ? { note: input.note.replace(/\s+/g, ' ').trim().slice(0, 240) } : {}),
      ...(input.supersededById ? { supersededById: input.supersededById.slice(0, 64) } : {}),
    };
    this.appendLine(event);
    return event;
  }

  private appendLine(payload: unknown): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch {
      // Never block primary browser or companion actions if the optional experience log is unwritable.
    }
  }

  private foldAll(): ScoredExperienceRecord[] {
    if (!existsSync(this.filePath)) return [];
    let rawLines: string[];
    try {
      rawLines = readFileSync(this.filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }

    const records: ExperienceRecord[] = [];
    const feedbackEvents: ExperienceFeedbackEvent[] = [];

    for (const line of rawLines) {
      try {
        const item = JSON.parse(line) as Record<string, unknown>;
        if (!item || typeof item !== 'object') continue;
        if (item.kind === 'feedback') {
          if (
            typeof item.experienceId === 'string'
            && typeof item.result === 'string'
            && ['helpful', 'ineffective', 'superseded', 'deprecated'].includes(item.result)
          ) {
            feedbackEvents.push(item as unknown as ExperienceFeedbackEvent);
          }
          continue;
        }
        if (typeof item.id === 'string' && typeof item.summary === 'string' && typeof item.lesson === 'string') {
          records.push(item as unknown as ExperienceRecord);
        }
      } catch {
        // skip malformed line
      }
    }

    const byId = new Map<string, ScoredExperienceRecord>();
    const ordered: ScoredExperienceRecord[] = [];

    for (const rec of records) {
      const domain = rec.domain && VALID_DOMAINS.has(rec.domain)
        ? rec.domain
        : inferExperienceDomain(rec.category, rec.provider);
      const folded: ScoredExperienceRecord = {
        ...rec,
        domain,
        effectiveStatus: rec.status ?? 'active',
        appliedCount: 0,
        helpfulCount: 0,
        ineffectiveCount: 0,
        score: 0,
      };
      byId.set(rec.id, folded);
      ordered.push(folded);
    }

    // Apply implicit temporal superseding declared by newer records (`supersedesId`).
    for (const rec of ordered) {
      if (!rec.supersedesId) continue;
      const prev = byId.get(rec.supersedesId);
      if (prev && prev.effectiveStatus === 'active') {
        prev.effectiveStatus = 'superseded';
        prev.supersededById = rec.id;
      }
    }

    // Fold explicit feedback events.
    for (const ev of feedbackEvents) {
      const target = byId.get(ev.experienceId);
      if (!target) continue;
      if (ev.result === 'helpful') {
        target.appliedCount += 1;
        target.helpfulCount += 1;
      } else if (ev.result === 'ineffective') {
        target.appliedCount += 1;
        target.ineffectiveCount += 1;
        if (target.effectiveStatus === 'active' && target.ineffectiveCount >= 2 && target.ineffectiveCount > target.helpfulCount) {
          target.effectiveStatus = 'deprecated';
        }
      } else if (ev.result === 'superseded') {
        target.effectiveStatus = 'superseded';
        if (ev.supersededById) target.supersededById = ev.supersededById;
      } else if (ev.result === 'deprecated') {
        target.effectiveStatus = 'deprecated';
      }
    }

    return ordered;
  }

  list(limit = 20): ExperienceRecord[] {
    const folded = this.foldAll();
    return folded.slice(-Math.max(1, limit)).reverse();
  }

  listDetailed(limit = 50): ScoredExperienceRecord[] {
    const folded = this.foldAll();
    return folded.slice(-Math.max(1, limit)).reverse();
  }

  recallRelevant(query: ExperienceRecallQuery = {}): ScoredExperienceRecord[] {
    const limit = Math.max(1, query.limit ?? 5);
    const providers = asSet(query.provider);
    const categories = asSet(query.category);
    const domains = asSet(query.domain);
    const queryKeywords = new Set<string>(
      (query.keywords ?? []).flatMap((k) => extractKeywords(k)),
    );
    const nowMs = this.now().getTime();
    const candidates = this.foldAll();

    const scored: ScoredExperienceRecord[] = [];
    for (const rec of candidates) {
      if (!query.includeInactive && rec.effectiveStatus !== 'active') continue;
      if (!query.includeFailed && rec.outcome === 'failed') continue;
      if (providers && !providers.has(rec.provider)) continue;
      if (categories && !categories.has(rec.category)) continue;

      let score = 0;

      // Trust & verification baseline
      if (rec.outcome === 'verified') score += 2.0;
      else if (rec.outcome === 'submitted') score += 1.0;
      else if (rec.outcome === 'unknown') score -= 0.5;
      else score -= 2.0;

      // High-signal synthesized reviews / skills outrank raw file-save logs
      if (rec.category === 'douyin_review' || rec.category === 'general_skill') score += 2.5;
      else if (rec.category === 'douyin_publish' || rec.category === 'douyin_metrics' || rec.category === 'douyin_comment_reply') score += 1.2;
      else if (rec.category === 'image_save') score -= 0.6;

      // Context matching
      if (domains) {
        score += domains.has(rec.domain) ? 2.5 : -0.5;
      }
      if (query.taskSlug && rec.taskSlug && rec.taskSlug === query.taskSlug) {
        score += 2.0;
      }

      // Keyword overlap
      if (queryKeywords.size > 0) {
        const haystack = new Set(extractKeywords(`${rec.summary} ${rec.lesson} ${rec.taskSlug ?? ''} ${(rec.tags ?? []).join(' ')}`));
        let hits = 0;
        for (const kw of queryKeywords) {
          if (haystack.has(kw)) hits += 1;
        }
        score += Math.min(6.0, hits * 1.5);
      }

      // Effectiveness feedback loop
      score += Math.min(4.0, rec.helpfulCount * 1.25);
      score -= rec.ineffectiveCount * 1.5;

      // Gentle recency decay (0..1.5 over 30 days)
      const createdMs = Date.parse(rec.createdAt);
      if (Number.isFinite(createdMs)) {
        const ageDays = Math.max(0, (nowMs - createdMs) / 86_400_000);
        score += Math.max(0, 1.5 * Math.exp(-ageDays / 14));
      }

      scored.push({ ...rec, score: Number(score.toFixed(3)) });
    }

    scored.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));

    if (query.deduplicate === false) {
      return scored.slice(0, limit);
    }

    const seenSig = new Set<string>();
    const result: ScoredExperienceRecord[] = [];
    for (const item of scored) {
      const sig = dedupeSignature(item);
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      result.push(item);
      if (result.length >= limit) break;
    }
    return result;
  }

  formatLesson(item: ScoredExperienceRecord): string {
    const shortId = item.id.slice(0, 8);
    const slug = item.taskSlug ? `:${item.taskSlug}` : '';
    const feedback = item.helpfulCount > 0 ? ` (helpful×${item.helpfulCount})` : '';
    return `[${shortId}|${item.provider}/${item.category}${slug}]${feedback} ${item.lesson}`;
  }

  recentLessonsText(limit = 5, query?: Omit<ExperienceRecallQuery, 'limit'>): string {
    const items = this.recallRelevant({ ...(query ?? {}), limit, deduplicate: true })
      .filter((item) => item.outcome === 'verified' || item.outcome === 'submitted');
    if (!items.length) return '';
    return items.map((item) => this.formatLesson(item)).join(' | ');
  }

  stats(): ExperienceStats {
    const all = this.foldAll();
    const byDomain: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    let active = 0;
    let superseded = 0;
    let deprecated = 0;
    let helpfulTotal = 0;
    let ineffectiveTotal = 0;

    for (const rec of all) {
      if (rec.effectiveStatus === 'active') active += 1;
      else if (rec.effectiveStatus === 'superseded') superseded += 1;
      else deprecated += 1;
      helpfulTotal += rec.helpfulCount;
      ineffectiveTotal += rec.ineffectiveCount;
      byDomain[rec.domain] = (byDomain[rec.domain] ?? 0) + 1;
      byProvider[rec.provider] = (byProvider[rec.provider] ?? 0) + 1;
    }

    return {
      total: all.length,
      active,
      superseded,
      deprecated,
      helpfulTotal,
      ineffectiveTotal,
      byDomain,
      byProvider,
    };
  }
}
