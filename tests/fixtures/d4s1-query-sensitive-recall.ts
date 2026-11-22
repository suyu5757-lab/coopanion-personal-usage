/**
 * D4-S1 same-source query-sensitive synthetic Hindsight corpus and lexical retriever.
 *
 * The retriever computes a deterministic score from the *actual query text* and each
 * source body. It never receives a case id, an expected document id, or an `enabled`
 * flag. Request types are the only route-level difference: the stock Recall uses its
 * configured type allow-list, while the domain supplement may ask for all source types.
 * Budget/token options are recorded but do not choose a different answer list.
 */
import type { DomainId } from '../../core/memory/source-domains.ts';

export interface D4S1Doc {
  documentId: string;
  content: string;
  /** Result type returned by the synthetic Hindsight recall endpoint. */
  resultType: 'observation' | 'opinion' | 'world' | 'experience';
  /** Source-fact type carried in source_facts. */
  factType: string;
  actor: 'user' | 'coo';
  kind: 'event' | 'correction' | 'plan' | 'reflection';
  status: 'completed' | 'current' | 'candidate';
  classification: 'assigned' | 'unclassified' | 'ambiguous' | 'pending_review';
  domains: DomainId[];
  excerpts: Partial<Record<DomainId, string>>;
  /** A user result that also declares a Coo candidate source fact. */
  mixedWith?: string;
  /** False for the Coo half of a mixed observation; it is never emitted separately. */
  emit?: boolean;
  /** A direct typed result (for example an opinion) whose document_id is the source itself. */
  directResult?: boolean;
}

export interface RankedDoc {
  doc: D4S1Doc;
  score: number;
  concepts: string[];
  tokens: string[];
}

export interface SyntheticFact {
  id: string;
  text: string;
  type: string;
  document_id: string;
  occurred_start: string;
  metadata: Record<string, string>;
}

export interface SyntheticResult {
  id: string;
  text: string;
  type: string;
  document_id: string;
  source_fact_ids: string[];
  metadata?: Record<string, string>;
}

export interface SyntheticRecallResponse {
  results: SyntheticResult[];
  source_facts: Record<string, SyntheticFact>;
  source_facts_truncated: boolean;
}

export interface RankEvidence {
  documentId: string;
  score: number;
  concepts: string[];
  tokens: string[];
}

const AT = '2026-11-10T09:00:00.000Z';

/**
 * A small, deliberately general synonym table. Every entry maps surface forms to a
 * topic concept; no entry names a document or an expected answer.
 */
const CONCEPTS: Record<string, readonly string[]> = {
  project: ['项目', '产品', '功能', '工程'],
  decision: ['决定', '决策', '选择', '定过', '定了', '方案'],
  basis: ['依据', '理由', '判断', '为什么', '原因'],
  method: ['方法', '做法', '实现', '复用', '重复使用', '反复使用', '封装', '接口'],
  scope: ['适用范围', '范围', '场景', '条件', '入口'],
  migration: ['迁移', '切换', '升级', '双写', '检查点', '新旧存储'],
  rollback: ['回滚', '恢复', '可恢复', '撤回'],
  verification: ['验证', '校验', '摘要', '一致性', '可验证'],
  reliability: ['稳定', '可靠', '可维护', '长期', '清晰'],
  speed: ['速度', '上线', '发布', '放慢'],
  communication: ['沟通', '交流', '表达', '复述'],
  conflict: ['分歧', '争执', '冲突', '不同意'],
  boundary: ['独处', '边界', '直接说明'],
  social: ['朋友', '聚会', '社交', '相处', '场合'],
  lifestyle: ['作息', '早上', '晚上', '晚饭', '散步', '睡眠', '时间安排'],
  focus: ['专注', '会议', '下午', '任务'],
  growth: ['成长', '反思', '改进', '建议'],
  cache: ['缓存', '首屏', '加载', '网络'],
  review: ['灰度', '审核', '评审', '全量'],
  test: ['测试', '语料', '基线', '补充通道', '曝光'],
  timeout: ['超时', '预算', '失败'],
  honesty: ['诚实', '透明', '黑盒', '解释'],
  unclassified: ['归档', '想法', '还没'],
};

const STOPWORDS = new Set([
  '请', '帮我', '我们', '咱们', '你们', '我', '你', '他', '她', '它', '的', '了', '吗', '呢', '吧',
  '和', '与', '及', '以及', '还有', '那个', '这个', '这些', '那些', '什么', '哪些', '怎么', '如何',
  '为什么', '先', '再', '又', '也', '都', '就', '才', '把', '被', '给', '对', '在', '里', '上', '下',
  '方面', '相关', '重要', '主要', '可以', '能否', '需要', '应该', '供', '本轮', '回答', '参考',
  '整理', '列出', '说明', '各自', '一起', '平时', '遇到', '发生', '时候', '当时', '之前', '以前',
]);

const SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function segmentsOf(text: string): string[] {
  return [...SEGMENTER.segment(text)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.trim())
    .filter(Boolean);
}

/** Latin words, segmented Chinese words, and Chinese character bigrams. */
export function tokensOf(text: string): string[] {
  const tokens = new Set<string>();
  const latin = text.toLocaleLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) ?? [];
  for (const word of latin) if (!STOPWORDS.has(word)) tokens.add(word);
  for (const segment of segmentsOf(text)) {
    if (/^[\u3400-\u9fff]+$/u.test(segment)) {
      if (segment.length >= 2 && !STOPWORDS.has(segment)) tokens.add(segment);
    } else if (/^[a-z][a-z0-9_-]+$/i.test(segment) && !STOPWORDS.has(segment.toLocaleLowerCase())) {
      tokens.add(segment.toLocaleLowerCase());
    }
  }
  return [...tokens];
}

export function conceptsOf(text: string): string[] {
  const found: string[] = [];
  for (const [concept, surfaces] of Object.entries(CONCEPTS)) {
    if (surfaces.some((surface) => text.includes(surface))) found.push(concept);
  }
  return found;
}

function inverseDocumentFrequency(termCount: number, total: number): number {
  return Math.log((total + 1) / (termCount + 1)) + 1;
}

export function rankDocuments(query: string, docs: readonly D4S1Doc[]): RankedDoc[] {
  const candidates = docs.filter((doc) => doc.emit !== false);
  const queryConcepts = new Set(conceptsOf(query));
  const queryTokens = new Set(tokensOf(query));
  const conceptDocumentCount = new Map<string, number>();
  const tokenDocumentCount = new Map<string, number>();
  const indexed = candidates.map((doc) => {
    const concepts = new Set(conceptsOf(doc.content));
    const tokens = new Set(tokensOf(doc.content));
    for (const concept of concepts) conceptDocumentCount.set(concept, (conceptDocumentCount.get(concept) ?? 0) + 1);
    for (const token of tokens) tokenDocumentCount.set(token, (tokenDocumentCount.get(token) ?? 0) + 1);
    return { doc, concepts, tokens };
  });
  const total = candidates.length;
  const ranked: RankedDoc[] = [];
  for (const item of indexed) {
    const sharedConcepts = [...queryConcepts].filter((concept) => item.concepts.has(concept));
    const sharedTokens = [...queryTokens].filter((token) => item.tokens.has(token));
    let score = 0;
    for (const concept of sharedConcepts) {
      score += 3 * inverseDocumentFrequency(conceptDocumentCount.get(concept) ?? 0, total);
    }
    for (const token of sharedTokens) {
      score += inverseDocumentFrequency(tokenDocumentCount.get(token) ?? 0, total);
    }
    if (score <= 0) continue;
    ranked.push({
      doc: item.doc,
      score: Math.round(score * 1_000_000) / 1_000_000,
      concepts: sharedConcepts.sort(),
      tokens: sharedTokens.sort(),
    });
  }
  ranked.sort((left, right) => right.score - left.score
    || (left.doc.documentId < right.doc.documentId ? -1 : left.doc.documentId > right.doc.documentId ? 1 : 0));
  return ranked;
}

export function rankingEvidence(ranked: readonly RankedDoc[], limit = 20): RankEvidence[] {
  return ranked.slice(0, limit).map((entry) => ({
    documentId: entry.doc.documentId,
    score: entry.score,
    concepts: entry.concepts,
    tokens: entry.tokens,
  }));
}

function userDoc(
  documentId: string,
  content: string,
  domains: DomainId[],
  excerpts: Partial<Record<DomainId, string>>,
  overrides: Partial<D4S1Doc> = {},
): D4S1Doc {
  return {
    documentId,
    content,
    resultType: 'observation',
    factType: 'world',
    actor: 'user',
    kind: 'event',
    status: 'completed',
    classification: 'assigned',
    domains,
    excerpts,
    ...overrides,
  };
}

function cooDoc(documentId: string, content: string, kind: 'plan' | 'reflection'): D4S1Doc {
  return {
    documentId,
    content,
    resultType: 'observation',
    factType: 'memory',
    actor: 'coo',
    kind,
    status: 'candidate',
    classification: 'unclassified',
    domains: [],
    excerpts: {},
    emit: false,
  };
}

/** The fixed same-source corpus used by every case in this run. */
export function corpus(): D4S1Doc[] {
  const project: DomainId[] = ['project-functional'];
  const skill: DomainId[] = ['skill-methods'];
  const growth: DomainId[] = ['self-growth'];
  const relationship: DomainId[] = ['user-relationship'];
  const social: DomainId[] = ['social-context'];
  return [
    userDoc('source-project-checkpoint',
      '迁移检查点采用双写校验：先确认新旧来源摘要一致，再切换读取路径；适用范围是新旧存储并行期。',
      project, { 'project-functional': '迁移检查点采用双写校验' }),
    userDoc('source-project-rollback',
      '项目功能决定：每个高风险改动都保留一键回滚，并在改动前验证回滚脚本；可恢复性优先。',
      project, { 'project-functional': '每个高风险改动都保留一键回滚' }),
    userDoc('source-project-cache',
      '项目功能决定：首屏加载先读本地缓存，再请求远端，避免网络抖动影响体验；适用范围是首屏与弱网场景。',
      project, { 'project-functional': '首屏加载先读本地缓存' }),
    userDoc('source-project-gray',
      '项目功能决定：新接口先经过一次小范围灰度，再全量开放；适用范围是公开接口的小流量变更。',
      project, { 'project-functional': '新接口先经过一次小范围灰度' }),
    userDoc('source-skill-verify',
      '可复用的实现方法：把来源校验封装成一个最小接口，先校验身份和摘要，再交给业务层使用；适用范围是所有读取记忆的入口。',
      skill, { 'skill-methods': '把来源校验封装成一个最小接口' }),
    userDoc('source-skill-eval',
      '可复用的实现方法：用同一份语料先跑基线，再跑补充通道，分别记录候选、消费和曝光；适用范围是同一语料上的基线对照。',
      skill, { 'skill-methods': '用同一份语料先跑基线' }),
    userDoc('source-skill-timeout',
      '实现方法：为每次外部查询设置独立的超时和预算，失败时保留旧结果，不把失败写成没有记忆；适用范围是所有外部查询入口。',
      skill, { 'skill-methods': '为每次外部查询设置独立的超时和预算' }),
    userDoc('source-multi-domain',
      '项目决定与实现方法：领域补充查询只追加经过复核的来源片段；Core 注入前再复核一次来源摘要。',
      ['project-functional', 'skill-methods'], {
        'project-functional': '领域补充查询只追加经过复核的来源片段',
        'skill-methods': 'Core 注入前再复核一次来源摘要',
      }),
    userDoc('source-values-basis',
      '判断依据：我重视可验证和可回滚，宁可放慢上线速度，也不接受无法解释的黑盒结果。',
      growth, { 'self-growth': '我重视可验证和可回滚' },
      { resultType: 'opinion', factType: 'opinion', directResult: true }),
    userDoc('source-values-craft',
      '我在意长期可维护性和清晰的边界，愿意为说明多花一点时间。',
      growth, { 'self-growth': '我在意长期可维护性' }),
    userDoc('source-relationship-repair',
      '沟通方式：发生分歧时先复述对方的重点，再表达自己的看法，最后确认下一步。',
      relationship, { 'user-relationship': '发生分歧时先复述对方的重点' }),
    userDoc('source-relationship-space',
      '沟通方式：需要独处时直接说明时间和安排，不让对方猜。',
      relationship, { 'user-relationship': '需要独处时直接说明时间和安排' }),
    userDoc('source-social-gathering',
      '社交场合的约定：朋友聚会时先确认时间和地点，遇到不熟悉的场合先观察再参与。',
      social, { 'social-context': '朋友聚会时先确认时间和地点' }),
    userDoc('source-lifestyle-morning',
      '作息安排：工作日的早上先处理需要专注的任务，下午再安排会议。',
      growth, { 'self-growth': '工作日的早上先处理需要专注的任务' }),
    userDoc('source-lifestyle-walk',
      '作息习惯：晚饭后散步二十分钟，回来再继续工作。',
      growth, { 'self-growth': '晚饭后散步二十分钟' }),
    userDoc('source-unclassified-idea',
      '尚未整理的一条记录：有一个还没归档的想法，和排期有关，但还没有形成结论。',
      [], {}, { classification: 'unclassified' }),
    userDoc('source-ambiguous-note',
      '有一条还没归档的说法，不确定属于哪个领域：排期可能调整，但还没有确认。',
      ['project-functional'], { 'project-functional': '排期可能调整' }, { classification: 'ambiguous' }),
    userDoc('source-pending-review',
      '待审记录：关于排期的两条说法互相矛盾，还没归档，等待本人确认。',
      [], {}, { classification: 'pending_review' }),
    userDoc('source-forgotten-plan',
      '旧的迁移方案采用一次性切换，不做双写；这是已经废弃的决定。',
      project, { 'project-functional': '旧的迁移方案采用一次性切换' }),
    userDoc('source-stale-cache',
      '缓存策略：首屏加载先读本地缓存，再请求远端。',
      project, { 'project-functional': '首屏加载先读本地缓存' }),
    cooDoc('coo-growth:plan-migration',
      '成长计划候选：建议把项目迁移拆成三步，先做只读验证。', 'plan'),
    userDoc('source-mixed-user',
      '迁移方案还需要再确认一次，尤其是回滚步骤。',
      project, { 'project-functional': '迁移方案还需要再确认一次' },
      { mixedWith: 'coo-growth:reflection-mixed' }),
    cooDoc('coo-growth:reflection-mixed',
      '反思候选：迁移可以更快。', 'reflection'),
    ...Array.from({ length: 6 }, (_, index) => {
      const number = String(index + 1).padStart(2, '0');
      return userDoc(`source-noise-${number}`,
        `日常项目记录 ${number}：本周例会按常规顺序同步进度，没有新的决定。`,
        project, { 'project-functional': '本周例会按常规顺序同步进度' });
    }),
  ];
}

function factFor(doc: D4S1Doc): SyntheticFact {
  return {
    id: `fact-${doc.documentId}`,
    text: doc.content,
    type: doc.factType,
    document_id: doc.documentId,
    occurred_start: AT,
    metadata: { source_actor: doc.actor, kind: doc.kind, status: doc.status },
  };
}

export interface SyntheticRecallOptions {
  types?: readonly string[];
  /** Recorded for audit only; the fixture is far below this bound. */
  maxTokens?: number;
  /** Recorded for audit only; the fixture is far below this bound. */
  maxSourceFactsTokens?: number;
}

export interface QuerySensitiveResponse {
  response: SyntheticRecallResponse;
  ranked: RankedDoc[];
  returned: string[];
  typeFiltered: string[];
  options: SyntheticRecallOptions;
}

/**
 * Computes one ranked list from the query, then applies the request's type allow-list.
 * The order, score and tie-break are identical for stock Recall and the supplement.
 */
export function responseForQuery(
  query: string,
  docs: readonly D4S1Doc[],
  options: SyntheticRecallOptions = {},
): QuerySensitiveResponse {
  const byId = new Map(docs.map((doc) => [doc.documentId, doc]));
  const ranked = rankDocuments(query, docs);
  const allowed = options.types ? new Set(options.types) : null;
  const filtered = ranked.filter((entry) => !allowed || allowed.has(entry.doc.resultType));
  const selected = filtered.slice(0, 24);
  const sourceFacts: Record<string, SyntheticFact> = {};
  const results: SyntheticResult[] = [];
  const returned: string[] = [];
  for (const entry of selected) {
    const doc = entry.doc;
    const fact = factFor(doc);
    const facts = [fact];
    if (doc.mixedWith) {
      const mixed = byId.get(doc.mixedWith);
      if (mixed) facts.push(factFor(mixed));
    }
    for (const item of facts) sourceFacts[item.id] = item;
    results.push({
      id: `${doc.directResult ? 'result' : 'observation'}-${doc.documentId}`,
      text: doc.directResult ? doc.content : `Synthetic observation ${doc.documentId}.`,
      type: doc.resultType,
      document_id: doc.directResult ? doc.documentId : `observation:${doc.documentId}`,
      source_fact_ids: facts.map((item) => item.id),
      ...(doc.directResult ? { metadata: { source_actor: doc.actor, kind: doc.kind, status: doc.status } } : {}),
    });
    returned.push(doc.documentId);
  }
  const typeFiltered = ranked
    .filter((entry) => allowed && !allowed.has(entry.doc.resultType))
    .map((entry) => entry.doc.documentId);
  return {
    response: { results, source_facts: sourceFacts, source_facts_truncated: false },
    ranked,
    returned,
    typeFiltered,
    options,
  };
}

export const D4S1_AT = AT;
