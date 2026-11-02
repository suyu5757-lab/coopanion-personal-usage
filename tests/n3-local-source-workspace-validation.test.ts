import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { describe, expect, it } from 'vitest';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona, PARTNER_FILE } from '../core/persona.ts';
import { HindsightMemory, SOURCE_LOOKUP_LIMITS, type AutomaticSourceLookupReceipt, type SourceLookupReceipt } from '../core/memory/hindsight.ts';
import { planRecallQueries } from '../core/memory/recall-query.ts';
import { planRecall } from '../core/memory/router.ts';
import { sanitizeForMemory } from '../core/memory/policy.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';
import {
  partnerProvenancePath,
  partnerSegmentDigest,
  partnerWorkspaceDigest,
  writePartnerProvenance,
} from '../core/memory/partner-provenance.ts';

type SyntheticDocument = {
  id: string;
  original_text: string;
  document_metadata: Record<string, string>;
  responseId?: string;
};

type HarnessOptions = {
  documents?: SyntheticDocument[];
  listedIds?: string[];
  recall?: Record<string, unknown> | ((query: string) => Record<string, unknown>);
  timeoutMs?: number;
  delayListMs?: number;
};

const eventMetadata = { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2025-04-03T12:00:00Z' };

async function localMemory(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coo-n3-source-workspace-'));
  const documents = options.documents ?? [];
  const listedIds = options.listedIds ?? documents.map((document) => document.id);
  const calls = { recall: 0, lists: 0, sourceReads: 0 };
  const recallQueries: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestText = Buffer.concat(chunks).toString('utf8');
      const requestBody = requestText ? JSON.parse(requestText) as Record<string, unknown> : {};
      const send = (value: unknown, status = 200) => {
        if (res.destroyed || res.headersSent) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname.endsWith('/memories/recall')) {
        calls.recall += 1;
        const recallQuery = typeof requestBody.query === 'string' ? requestBody.query : '';
        recallQueries.push(recallQuery);
        send(typeof options.recall === 'function'
          ? options.recall(recallQuery)
          : options.recall ?? { results: [], source_facts: {}, source_facts_truncated: false });
        return;
      }
      if (url.pathname.endsWith('/documents') && req.method === 'GET') {
        calls.lists += 1;
        const page = {
          items: listedIds.map((id) => ({
            id,
            bank_id: 'fixture-bank',
            document_metadata: documents.find((document) => document.id === id)?.document_metadata ?? eventMetadata,
          })),
          total: listedIds.length,
          limit: SOURCE_LOOKUP_LIMITS.pageSize,
          offset: 0,
        };
        if (options.delayListMs) setTimeout(() => send(page), options.delayListMs);
        else send(page);
        return;
      }
      if (url.pathname.includes('/documents/')) {
        calls.sourceReads += 1;
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        const document = documents.find((candidate) => candidate.id === id);
        if (!document) {
          send({ detail: 'Synthetic source missing' }, 404);
          return;
        }
        send({
          ...document,
          id: document.responseId ?? document.id,
          bank_id: 'fixture-bank',
          created_at: document.document_metadata.said_at ?? '2025-04-03T12:00:00Z',
          updated_at: document.document_metadata.said_at ?? '2025-04-03T12:00:00Z',
          content_hash: null,
          memory_unit_count: 1,
        });
        return;
      }
      send({ detail: 'Synthetic route not found' }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store = openMemoryStateStore(join(root, 'state.sqlite'));
  const memory = new HindsightMemory();
  Object.assign(memory, {
    config: loadHindsightConfig(root, {
      enabled: true,
      autostart: false,
      apiUrl: baseUrl,
      bankId: 'fixture-bank',
      recall: { timeoutMs: options.timeoutMs ?? 8_000 },
    }),
    client: new HindsightClient({ baseUrl, maxAttempts: 1 }),
    stateStore: store,
    outbox: new MemoryOutbox(store),
    ledger: new ForgetLedger(store),
    ready: true,
    unavailableUntil: 0,
  });
  return {
    root,
    memory,
    calls,
    recallQueries,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeMemoryStateStores();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function localPersona(memory: HindsightMemory) {
  const root = mkdtempSync(join(tmpdir(), 'coo-n3-workspace-'));
  const workspace = join(root, 'workspace');
  const appState = join(root, 'app-state');
  mkdirSync(workspace);
  mkdirSync(appState);
  const Persona = coopanionPersona(Cormini, { memory, growthStateFile: join(appState, 'growth.json') });
  const persona = new Persona({ memoryDir: workspace });
  const tools = () => persona.declareSessions()[0]!.tools();
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools().find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Synthetic Persona tool ${name} is missing`);
    return tool.handler(args, { role: 'main' } as never);
  };
  return { root, workspace, appState, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

function lastAutomaticLookup(memory: HindsightMemory): AutomaticSourceLookupReceipt | undefined {
  return (memory as unknown as { lastRecall?: { automaticSourceLookup?: AutomaticSourceLookupReceipt } }).lastRecall?.automaticSourceLookup;
}

function legacyFullQuestionMatch(source: string, query: string): boolean {
  const safe = sanitizeForMemory(query);
  if (safe.skip) return false;
  const asked = safe.text.trim().slice(0, 120);
  return source.toLocaleLowerCase().includes(asked.toLocaleLowerCase());
}

describe('N3 local source and workspace validation', () => {
  it('routes implicit past-decision questions and plans several safe retrieval queries', () => {
    expect(planRecall('评论先人工确认，暂时不自动发布，这个决定是什么？').route).toBe('deep');
    expect(planRecall('我们最终决定采用什么方式？').route).toBe('deep');
    expect(planRecall('我们关于抖音评论功能决定了什么？').route).toBe('deep');
    expect(planRecall('我们一起做过什么？').route).toBe('deep');
    expect(planRecall('我们在会上讨论了什么？').route).toBe('deep');
    expect(planRecall('What did we decide about comment moderation?').route).toBe('deep');
    expect(planRecall('What happened next?').route).toBe('deep');
    expect(planRecall('And then?').route).toBe('deep');
    expect(planRecall('What was our plan?').route).toBe('deep');
    expect(planRecall('我们一起计划一下下个月的旅行吧，看看去哪里比较好').route).toBe('standard');
    expect(planRecall('我们计划什么时候去旅行？').route).toBe('standard');
    expect(planRecall('What is our plan for next week?').route).toBe('standard');
    expect(planRecall('我们上周计划什么时候去旅行？').route).toBe('deep');

    const plan = planRecallQueries('我们之前关于抖音评论功能最终决定采用什么方式？');
    expect(plan.sourcePhrases).toContain('抖音评论');
    expect(plan.sourcePhrases).toContain('评论');
    expect(plan.sourcePhrases).not.toContain('什么');
    expect(plan.supplementalQueries.length).toBeGreaterThan(1);
    expect(plan.supplementalQueries.length).toBeLessThanOrEqual(2);
  });

  it('keeps late focal entities across long backgrounds and reordered mixed-language questions', () => {
    const questions = [
      '关于抖音评论功能，我们之前讨论了去年项目评审和运营排班，最后决定怎么发布？',
      '我们之前讨论了去年项目评审、运营排班和抖音评论功能，最后决定怎么发布？',
      '我们之前讨论了去年项目评审和运营排班，最后关于抖音评论功能决定怎么发布？',
      'After the review with Lin and the product team, what did we agree about Douyin 评论 moderation and publishing?',
    ];
    for (const question of questions) {
      const plan = planRecallQueries(question);
      expect(plan.sourcePhrases, question).toContain('评论');
      expect(plan.sourcePhrases.length).toBeLessThanOrEqual(4);
      expect(plan.supplementalQueries.length).toBeLessThanOrEqual(2);
      expect(new Set(plan.supplementalQueries.map((query) => query.toLocaleLowerCase())).size).toBe(plan.supplementalQueries.length);
      expect(plan.supplementalQueries.join(' ')).toContain('评论');
      expect(plan.sourcePhrases.every((phrase) => [...phrase].length <= 48)).toBe(true);
      expect(plan.supplementalQueries.every((query) => [...query].length <= 180)).toBe(true);
      expect(plan.sourcePhrases.some((phrase) => phrase.includes('林同学') || phrase.includes('评审会'))).toBe(false);
    }
    const mixed = planRecallQueries(questions[3]!);
    expect(mixed.sourcePhrases.some((phrase) => phrase.toLocaleLowerCase().includes('douyin'))).toBe(true);
    expect(mixed.supplementalQueries.join(' ').toLocaleLowerCase()).toContain('publishing');
    expect(mixed.sourcePhrases.join(' ').toLocaleLowerCase()).not.toContain('人工确认');
  });

  it('preserves time clues and multiple focal entities when the user asks for them', () => {
    const timePlan = planRecallQueries('去年秋天，我们在北门见面后讨论了几次行程，最后约定哪天在北桥集合？');
    expect(timePlan.sourcePhrases).toContain('去年');
    expect(timePlan.sourcePhrases.some((phrase) => phrase.includes('北桥') || phrase.includes('集合'))).toBe(true);

    const entityPlan = planRecallQueries('上周我和林同学在博物馆讨论展览安排，最后决定讲解路线与开放时间如何划分？');
    expect(entityPlan.sourcePhrases.some((phrase) => phrase.includes('路线'))).toBe(true);
    expect(entityPlan.sourcePhrases.some((phrase) => phrase.includes('开放'))).toBe(true);
    expect(entityPlan.supplementalQueries.join(' ')).toContain('路线');
    expect(entityPlan.supplementalQueries.join(' ')).toContain('开放');
  });

  it('prioritizes the final question over earlier topic markers in long Chinese and English questions', () => {
    const chinese = '今年春天在山海展馆的策划会上，我和陈老师、林同学、运营组、技术组先后讨论了人员值班、票价调整、志愿者排班、开放时间和活动日期，会议记录还提到入口动线、设备预算、导览手册、月度验收计划、临时展项维护以及语音设备测试，多轮评审后，最后关于无障碍地图的维护责任我们决定由谁承担？';
    expect(chinese.length).toBeGreaterThan(120);
    const chinesePlan = planRecallQueries(chinese);
    expect(chinesePlan.sourcePhrases.some((phrase) => phrase.includes('无障碍地图'))).toBe(true);
    expect(chinesePlan.supplementalQueries.join(' ')).toContain('无障碍地图');
    expect(chinesePlan.supplementalQueries.join(' ')).toContain('维护');

    const english = 'After several rounds of planning with the archive staff, curators, and volunteers about budgets, schedules, deliveries, access reviews, and exhibition setup; what policy did we agree on for the north wing reading room?';
    const englishPlan = planRecallQueries(english);
    expect(englishPlan.sourcePhrases).toContain('policy');
    expect(englishPlan.sourcePhrases.some((phrase) => phrase.includes('north wing reading room'))).toBe(true);
    expect(englishPlan.sourcePhrases).not.toContain('budgets');
    expect(englishPlan.supplementalQueries.join(' ').toLocaleLowerCase()).toContain('north');
    expect(englishPlan.supplementalQueries.join(' ').toLocaleLowerCase()).not.toMatch(/budgets\s/);

    const unmarkedFocusPlan = planRecallQueries('After several rounds of planning about budgets and delivery schedules; what plan did we choose?');
    expect(unmarkedFocusPlan.sourcePhrases).toContain('plan');
    expect(unmarkedFocusPlan.sourcePhrases).not.toContain('budgets');
    expect(unmarkedFocusPlan.supplementalQueries[0]?.toLocaleLowerCase()).toContain('plan');
    expect(unmarkedFocusPlan.supplementalQueries[0]?.toLocaleLowerCase()).not.toContain('budget');
  });

  it('keeps a late focus term when the user query exceeds the bounded planning window', () => {
    const background = Array.from({ length: 130 }, () => '我们讨论展览预算和人员排期').join('，');
    const query = `${background}，最后关于失物招领柜的编号规则，我们决定怎么设置？`;
    expect(query.length).toBeGreaterThan(1800);
    const plan = planRecallQueries(query);
    expect(plan.sourcePhrases.some((phrase) => phrase.includes('失物招领') || phrase.includes('编号'))).toBe(true);
    expect(plan.supplementalQueries.join(' ')).toContain('失物招领');
  });

  it.each([
    { query: '之前关于东岸陶板展柜的除湿材料，我们最后决定使用哪一种？', target: '东岸陶板展柜的除湿材料为硅胶包。', noise: '西岸陶板展柜的除湿材料为活性炭片。' },
    { query: '之前东岸陶板展柜使用哪一种除湿材料？', target: '东岸陶板展柜的除湿材料为硅胶包。', noise: '西岸陶板展柜的除湿材料为活性炭片。' },
    { query: '上次关于东岸陶板展柜的除湿材料我们最后决定使用哪一种', target: '东岸陶板展柜的除湿材料为硅胶包。', noise: '西岸陶板展柜的除湿材料为活性炭片。' },
    { query: '关于晨雾泵房的排水巡检，我们当时确定什么顺序？', target: '晨雾泵房的排水巡检顺序是先检查阀门再启动水泵。', noise: '晚霞泵房的排水巡检顺序是先启动水泵再检查阀门。' },
    { query: '之前晨雾泵房按什么顺序进行排水巡检？', target: '晨雾泵房的排水巡检顺序是先检查阀门再启动水泵。', noise: '晚霞泵房的排水巡检顺序是先启动水泵再检查阀门。' },
  ])('excludes another entity sharing generic attributes in one scan and at most three Recall requests: $query', async ({ query, target, noise }) => {
    const fixture = await localMemory({ documents: [
      { id: 'source-focus-target', original_text: target, document_metadata: eventMetadata },
      { id: 'source-other-entity', original_text: noise, document_metadata: eventMetadata },
    ] });
    try {
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true, activationEnabled: false });
      expect(result.route).toBe('deep');
      expect(result.text).toContain('source_id:source-focus-target');
      expect(result.text).not.toContain('source_id:source-other-entity');
      expect(result.text).toContain('candidate relevance to the full question is still unresolved');
      expect(fixture.calls.lists).toBe(1);
      expect(fixture.calls.recall).toBeLessThanOrEqual(3);
      expect(lastAutomaticLookup(fixture.memory)?.scanIncomplete).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('keeps both named entities while excluding a third entity that shares their material query', async () => {
    const fixture = await localMemory({ documents: [
      { id: 'source-cabinet-one', original_text: '若岚标本柜的防潮材料是硅胶包。', document_metadata: eventMetadata },
      { id: 'source-cabinet-two', original_text: '星溪样品箱的防潮材料是吸水纸。', document_metadata: eventMetadata },
      { id: 'source-cabinet-noise', original_text: '落霞展示柜的防潮材料是活性炭片。', document_metadata: eventMetadata },
    ] });
    try {
      const result = await fixture.memory.recallForTurn('我们之前关于若岚标本柜和星溪样品箱的防潮材料，最后采用了什么方案？', { captureTrace: true, activationEnabled: false });
      expect(result.text).toContain('source_id:source-cabinet-one');
      expect(result.text).toContain('source_id:source-cabinet-two');
      expect(result.text).not.toContain('source_id:source-cabinet-noise');
    } finally {
      await fixture.close();
    }
  });

  it('automatically finds the supplied A1 source while preserving source identity', async () => {
    const source = '评论先人工确认，暂时不自动发布。';
    const suppliedQuestion = `${source}这个决定是什么？`;
    const deepQuestion = `之前，${suppliedQuestion}`;
    expect(legacyFullQuestionMatch(source, suppliedQuestion)).toBe(false);
    expect(planRecallQueries(suppliedQuestion).sourcePhrases).toContain(source);
    const fixture = await localMemory({ documents: [{ id: 'source-exact', original_text: source, document_metadata: eventMetadata }] });
    try {
      const suppliedResult = await fixture.memory.recallForTurn(suppliedQuestion, { captureTrace: true });
      expect(suppliedResult.route).toBe('deep');
      expect(suppliedResult.text).toContain('source_id:source-exact');
      expect(lastAutomaticLookup(fixture.memory)).toMatchObject({ status: 'found', sourceReads: 1 });

      const result = await fixture.memory.recallForTurn(deepQuestion, { captureTrace: true });
      expect(result.route).toBe('deep');
      expect(result.text).toContain('source_id:source-exact');
      expect(lastAutomaticLookup(fixture.memory)).toMatchObject({ status: 'found', scanIncomplete: false });
      const directPhrase = await fixture.memory.searchSourceDocuments(source);
      expect(directPhrase.status).toBe('found');
      expect(directPhrase.text).toContain('source_id:source-exact');
      expect(directPhrase.text).toContain(source);
      expect(fixture.calls).toEqual({ recall: 6, lists: 3, sourceReads: 3 });
    } finally {
      await fixture.close();
    }
  });

  it('finds topical phrase candidates for a paraphrase without inventing a semantic Recall hit', async () => {
    const source = '评论先人工确认，暂时不自动发布。';
    const query = '我们之前关于抖音评论功能最终决定采用什么方式？';
    const fixtures = [
      { id: 'source-paraphrase', original_text: source, document_metadata: eventMetadata },
      { id: 'source-review-flow', original_text: '抖音评论由运营人工确认来源，再由客服完成处理。', document_metadata: eventMetadata },
      { id: 'source-test-policy', original_text: '测试账号评论需人工确认权限，发布仍要单独批准。', document_metadata: eventMetadata },
    ];
    expect(legacyFullQuestionMatch(source, query)).toBe(false);
    const fixture = await localMemory({ documents: fixtures });
    try {
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true });
      expect(result.route).toBe('deep');
      expect(result.status).toBe('found');
      expect(result.text).toContain('source_id:source-paraphrase');
      expect(result.text).toContain('source_id:source-review-flow');
      expect(result.text).toContain('relevance to the full question is still unresolved');
      expect(result.text.match(/match_type:literal_phrase/g)).toHaveLength(3);
      expect(lastAutomaticLookup(fixture.memory)).toMatchObject({ status: 'found', sourceReads: 3 });
      expect(fixture.calls.recall).toBeLessThanOrEqual(3);
      expect(fixture.calls.lists).toBe(1);
      expect(fixture.calls.sourceReads).toBe(3);
    } finally {
      await fixture.close();
    }
  });

  it('does not treat a retained but nonmatching source as support for a historical decision', async () => {
    const query = '我们之前关于抖音评论功能最终决定采用什么方式？';
    const fixture = await localMemory({ documents: [
      { id: 'source-unrelated', original_text: '项目上线最终采用蓝色按钮。', document_metadata: eventMetadata },
    ] });
    try {
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true });
      expect(result.status).toBe('absent');
      expect(result.text).toContain('No original user source in this scan contained the literal phrase');
      expect(result.text).not.toContain('source_id:source-unrelated');
      expect(lastAutomaticLookup(fixture.memory)?.sourceDocumentHashes).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('recovers an explicitly quoted original sentence beyond the 120-character query prefix', async () => {
    const source = '评论先人工确认，暂时不自动发布。';
    const context = '我、林同学和团队在秋季项目评审会上讨论抖音评论功能，围绕平台风险、运营排班、发布权限、审核责任、异常回滚和上线节奏交换了多轮意见。';
    const query = `去年，${context.repeat(2)}最终决定的原话是：${source} 这个决定具体采用什么方式？`;
    expect(query.length).toBeGreaterThan(120);
    expect(query.indexOf(source)).toBeGreaterThan(120);
    expect(legacyFullQuestionMatch(source, query)).toBe(false);
    const fixture = await localMemory({ documents: [{ id: 'source-long-question', original_text: source, document_metadata: eventMetadata }] });
    try {
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true });
      expect(result.route).toBe('deep');
      expect(result.text).toContain('source_id:source-long-question');
      expect(result.text).toContain('match_type:literal_phrase');
      expect(lastAutomaticLookup(fixture.memory)).toMatchObject({ status: 'found', sourceReads: 1 });
    } finally {
      await fixture.close();
    }
  });

  it('finds the previous long-question regression from a late focus term without semantic fixture hits', async () => {
    const source = '评论先人工确认，暂时不自动发布。';
    const query = '去年秋天我和林同学在评审会上来回讨论了几轮，最后确认抖音评论功能采用什么发布方式？';
    const fixture = await localMemory({ documents: [
      { id: 'source-late-comment-focus', original_text: source, document_metadata: eventMetadata },
      { id: 'source-late-comment-noise', original_text: '抖音评论由客服筛选后按周发布。', document_metadata: eventMetadata },
    ] });
    try {
      expect(planRecallQueries(query).sourcePhrases).toContain('评论');
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true });
      expect(result.route).toBe('deep');
      expect(result.text).toContain('source_id:source-late-comment-focus');
      expect(result.text).toContain('candidate relevance to the full question is still unresolved');
      expect(fixture.calls.recall).toBeLessThanOrEqual(3);
      expect(fixture.calls.lists).toBe(1);
      expect(fixture.recallQueries.every((recallQuery) => recallQuery.length > 0)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('uses one semantic Recall when complete source wording already covers the historical question', async () => {
    const query = 'What did we decide about comment moderation?';
    const source = 'We decided comment moderation should require a human review before publishing.';
    const fixture = await localMemory({
      documents: [{ id: 'source-covered', original_text: source, document_metadata: eventMetadata }],
      recall: {
        results: [{
          id: 'result-covered',
          text: source,
          type: 'world',
          document_id: 'source-covered',
          metadata: eventMetadata,
        }],
        source_facts: {},
        source_facts_truncated: false,
      },
    });
    try {
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true, activationEnabled: false });
      expect(result.route).toBe('deep');
      expect(result.status).toBe('found');
      expect(result.text).toContain(source);
      expect(result.trace?.queryAttempts).toHaveLength(1);
      expect(fixture.calls).toEqual({ recall: 1, lists: 0, sourceReads: 1 });
    } finally {
      await fixture.close();
    }
  });

  it('merges repeated semantic candidates by source ID and retains query-level trace evidence', async () => {
    const query = '我们之前关于抖音评论功能最终决定采用什么方式？';
    const documents = [
      { id: 'source-decoy', original_text: 'We discussed a different product setting.', document_metadata: eventMetadata },
      { id: 'source-target', original_text: 'We agreed that comments require human review before publishing.', document_metadata: eventMetadata },
    ];
    const directResult = (id: string, text: string, score: number) => ({
      id,
      text,
      type: 'world',
      document_id: id === 'result-decoy' ? 'source-decoy' : 'source-target',
      metadata: eventMetadata,
      scores: { semantic: score },
    });
    const fixture = await localMemory({
      documents,
      recall: (recallQuery) => ({
        results: recallQuery === query
          ? [directResult('result-decoy', 'We discussed another unrelated product setting.', 0.91)]
          : [directResult('result-target', 'We agreed on a human review for comments.', recallQuery.length / 100)],
        source_facts: {},
        source_facts_truncated: false,
      }),
    });
    try {
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true, activationEnabled: false });
      expect(fixture.recallQueries).toHaveLength(3);
      expect(result.trace?.queryAttempts.map((attempt) => attempt.strategy)).toEqual(['primary', 'topic', 'phrase']);
      expect(result.trace?.search.candidateResultIds).toEqual(['result-decoy', 'result-target']);
      expect(result.trace?.search.items.filter((item) => item.resultId === 'result-target').map((item) => item.queryIndex)).toEqual([1, 2]);
      expect(result.trace?.search.items.filter((item) => item.resultId === 'result-target').every((item) => !!item.retrievalScores)).toBe(true);
      expect(result.text).toContain('source_id:source-target');
      expect(result.text).toContain('We agreed that comments require human review before publishing.');
      expect(result.text).toContain('candidate relevance to the full question is still unresolved');
      expect(result.trace?.format.includedResultIds.filter((id) => id === 'result-target')).toHaveLength(1);
      expect(fixture.calls).toEqual({ recall: 3, lists: 1, sourceReads: 2 });
    } finally {
      await fixture.close();
    }
  });

  it('excludes a Recall candidate whose document response has a different source ID', async () => {
    const query = 'What did we decide about comment moderation?';
    const fixture = await localMemory({
      documents: [{
        id: 'source-mismatch',
        responseId: 'different-source',
        original_text: 'We decided comments require a human review before publishing.',
        document_metadata: eventMetadata,
      }],
      recall: {
        results: [{
          id: 'result-mismatch',
          text: 'We decided comments require a human review before publishing.',
          type: 'world',
          document_id: 'source-mismatch',
          metadata: eventMetadata,
        }],
        source_facts: {},
        source_facts_truncated: false,
      },
    });
    try {
      const result = await fixture.memory.recallForTurn(query, { captureTrace: true, activationEnabled: false });
      expect(result.status).toBe('incomplete');
      expect(result.text).toContain('could not be verified as retained user documents');
      expect(result.text).not.toContain('source_id:source-mismatch');
      expect(result.trace?.search.items.find((item) => item.resultId === 'result-mismatch'))
        .toMatchObject({ disposition: 'filtered', reason: 'missing-source-id' });
      expect(lastAutomaticLookup(fixture.memory)?.invalidCandidateCount).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('keeps correction and superseded source identity visible when both match', async () => {
    const fixture = await localMemory({ documents: [
      { id: 'source-original', original_text: '评论先自动发布。', document_metadata: { ...eventMetadata, status: 'superseded' } },
      { id: 'source-correction', original_text: '更正：评论必须先人工确认，之后才允许发布。', document_metadata: { ...eventMetadata, kind: 'correction', status: 'completed' } },
    ] });
    try {
      const result = await fixture.memory.searchSourceDocuments('评论');
      expect(result.sourceDocuments?.map((source) => [source.documentId, source.sourceKind, source.recordStatus])).toEqual([
        ['source-original', 'event', 'superseded'],
        ['source-correction', 'correction', 'completed'],
      ]);
      expect(result.text).toContain('kind:correction');
      expect(result.text).toContain('record_status:superseded');
      expect(result.text).toContain('record_status:completed');
    } finally {
      await fixture.close();
    }
  });

  it('keeps forgotten source candidates fenced during supplemental lookup', async () => {
    const fixture = await localMemory({ documents: [
      { id: 'source-forgotten', original_text: '评论先人工确认，暂时不自动发布。', document_metadata: eventMetadata },
    ] });
    try {
      (fixture.memory as unknown as { ledger: ForgetLedger }).ledger.addMany([{
        bankId: 'fixture-bank',
        endpoint: fixture.baseUrl,
        documentId: 'source-forgotten',
        reason: 'Synthetic forget fence',
      }], 'Synthetic forget fence');
      const result = await fixture.memory.recallForTurn('我们之前关于抖音评论最终决定了什么？', { captureTrace: true });
      expect(result.status).toBe('fenced');
      expect(result.text).not.toContain('source_id:source-forgotten');
      expect(result.text).toBe('');
    } finally {
      await fixture.close();
    }
  });

  it('returns every source matching a broad phrase with its identity instead of resolving semantic relevance', async () => {
    const fixture = await localMemory({ documents: [
      { id: 'decision-source', original_text: '评论先人工确认，暂时不自动发布。', document_metadata: eventMetadata },
      { id: 'workflow-source', original_text: '抖音评论由运营人工确认来源字段，再交给客服处理。', document_metadata: eventMetadata },
      { id: 'test-source', original_text: '测试账号的评论也要人工确认权限，发布仍需单独批准。', document_metadata: eventMetadata },
    ] });
    try {
      const result = await fixture.memory.searchSourceDocuments('人工确认');
      expect(result.status).toBe('found');
      for (const id of ['decision-source', 'workflow-source', 'test-source']) expect(result.text).toContain(`source_id:${id}`);
      expect((fixture.memory as unknown as { lastSourceLookup: SourceLookupReceipt }).lastSourceLookup.sourceDocumentHashes).toHaveLength(3);
      expect(result.text).toContain('At most six matching sources are shown');
    } finally {
      await fixture.close();
    }
  });

  it('does not turn a missing source body into a verified source excerpt', async () => {
    const fixture = await localMemory({ listedIds: ['vanished-source'] });
    try {
      const result = await fixture.memory.searchSourceDocuments('synthetic phrase');
      expect(result.text).not.toContain('source_id:vanished-source');
      expect((fixture.memory as unknown as { lastSourceLookup: SourceLookupReceipt }).lastSourceLookup.sourceDocumentHashes).toEqual([]);
      expect(result.status).toBe('absent');
    } finally {
      await fixture.close();
    }
  });

  it('bounds automatic source lookup by its configured timeout', async () => {
    const fixture = await localMemory({ timeoutMs: 100, delayListMs: 250 });
    try {
      const result = await fixture.memory.recallForTurn('之前那次项目决定是什么？', { captureTrace: true });
      expect(result.text).toContain('bounded original-source check could not complete');
      expect(result.text).not.toContain('source_id:');
      expect(lastAutomaticLookup(fixture.memory)).toMatchObject({ status: 'unavailable', scanIncomplete: true, sourceDocumentHashes: [] });
      expect(lastAutomaticLookup(fixture.memory)?.elapsedMs).toBeLessThan(1_000);
      expect(fixture.calls.recall).toBe(result.trace?.queryAttempts.length);
      expect(fixture.calls.recall).toBeLessThanOrEqual(3);
      expect(fixture.calls.lists).toBe(1);
      expect(fixture.calls.sourceReads).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('keeps deep Recall candidates 12, 13 and 20, caps before candidate 21, and filters an unlinked observation', async () => {
    const metadata = eventMetadata;
    const results = Array.from({ length: 21 }, (_, index) => ({
      id: `rank-${index + 1}`,
      text: `Synthetic direct source candidate ${index + 1}.`,
      type: 'world',
      document_id: `source-${index + 1}`,
      metadata,
    }));
    results.push({
      id: 'orphan-observation',
      text: 'Synthetic observation without source links.',
      type: 'observation',
      document_id: 'orphan-parent',
      metadata,
    });
    const documents = Array.from({ length: 20 }, (_, index) => ({
      id: `source-${index + 1}`,
      original_text: `Synthetic retained source body ${index + 1}.`,
      document_metadata: metadata,
    }));
    const fixture = await localMemory({ documents, recall: { results, source_facts: {}, source_facts_truncated: false } });
    try {
      const result = await fixture.memory.recallForTurn('之前的项目记录有哪些？', { captureTrace: true, activationEnabled: false });
      expect(result.trace?.search.candidateResultIds).toHaveLength(21);
      expect(result.trace?.search.items.find((item) => item.resultId === 'orphan-observation')).toMatchObject({ disposition: 'filtered', reason: 'unlinked-observation' });
      expect(result.trace?.format.includedResultIds).toContain('rank-12');
      expect(result.trace?.format.includedResultIds).toContain('rank-13');
      expect(result.trace?.format.includedResultIds).toContain('rank-20');
      expect(result.trace?.format.includedResultIds).not.toContain('rank-21');
      expect(result.trace?.format.omittedResultIds).toContain('rank-21');
      expect(result.text).not.toContain('Synthetic observation without source links.');
      expect(result.text).toContain('source_id:source-20');
      const sourceBudget = (fixture.memory as unknown as { config: { recall: { maxSourceFactsTokens: number } } }).config.recall.maxSourceFactsTokens;
      expect(result.trace?.queryAttempts).toHaveLength(3);
      expect(result.trace?.sourceFactsTokenBudget).toBe(sourceBudget + 2 * Math.min(1024, sourceBudget));
    } finally {
      await fixture.close();
    }
  });

  it('keeps normal project files readable while labeling unsupported history and mixed grep output unverified', async () => {
    const fixture = await localMemory();
    const project = await localPersona(fixture.memory);
    try {
      mkdirSync(join(project.workspace, 'lab'));
      writeFileSync(join(project.workspace, 'lab', '项目草稿.md'), '下一步准备研究 A 方案。');
      writeFileSync(join(project.workspace, 'lab', '混合资料.md'), [
        '项目草稿：下一步准备比较 A 方案。',
        '历史主张：用户去年已经最终决定采用 A 方案。',
        '来源摘要候选：原始记忆据称记录用户选择 B 方案。',
      ].join('\n'));

      const draft = String(await project.run('read_file', { path: 'lab/项目草稿.md' }));
      const unsupportedHistory = String(await project.run('read_file', { path: 'lab/混合资料.md' }));
      const mixedSearch = String(await project.run('grep_files', { pattern: '方案', path: 'lab' }));
      await project.run('edit_file', {
        path: 'lab/项目草稿.md',
        old_string: '下一步准备研究 A 方案。',
        new_string: '下一步准备研究 A 方案，并补充风险分析。',
      });
      const editedDraft = String(await project.run('read_file', { path: 'lab/项目草稿.md' }));

      expect(draft).toContain('historicalEvidence=unverified');
      expect(draft).toContain('下一步准备研究 A 方案。');
      expect(editedDraft).toContain('下一步准备研究 A 方案，并补充风险分析。');
      expect(unsupportedHistory).toContain('historicalEvidence=unverified');
      expect(unsupportedHistory).toContain('用户去年已经最终决定采用 A 方案。');
      expect(mixedSearch).toContain('path="lab"; historicalEvidence=unverified');
      expect(mixedSearch).toContain('比较 A 方案');
      expect(mixedSearch).toContain('最终决定采用 A 方案');
      expect(mixedSearch).toContain('据称记录用户选择 B 方案');
      expect(mixedSearch.match(/historicalEvidence=unverified/g)).toHaveLength(1);
    } finally {
      project.close();
      await fixture.close();
    }
  });

  it('shows source-backed B and old workspace A separately, and keeps forgotten ordinary notes readable only as unverified artifacts', async () => {
    const sourceText = 'The person confirmed option B at the project review.';
    const fixture = await localMemory({ documents: [{ id: 'source-option-b', original_text: sourceText, document_metadata: eventMetadata }] });
    const project = await localPersona(fixture.memory);
    try {
      mkdirSync(join(project.workspace, 'agenda'));
      writeFileSync(join(project.workspace, 'agenda', 'now.md'), '用户去年已经最终决定采用 A 方案。');
      const derivedSummary = 'The person chose option B at the project review.';
      writeFileSync(join(project.workspace, PARTNER_FILE), derivedSummary);
      const scope = fixture.memory.sourceScopeDigest();
      if (!scope) throw new Error('Synthetic Memory scope digest is unavailable');
      writePartnerProvenance(partnerProvenancePath(project.appState, project.workspace), {
        v: 1,
        workspaceDigest: partnerWorkspaceDigest(project.workspace),
        entries: [{
          id: '11111111111111111111111111111111',
          segmentDigest: partnerSegmentDigest(derivedSummary),
          origin: 'derived',
          sourceIds: ['source-option-b'],
          sourceScopeDigest: scope,
          state: 'current',
        }],
      });

      const memoryTool = await project.run('memory_search', { query: 'confirmed option B', sources: true });
      const oldDraft = String(await project.run('read_file', { path: 'agenda/now.md' }));
      const linkedPartnerSummary = String(await project.run('read_file', { path: PARTNER_FILE }));
      expect(String(memoryTool)).toContain('source_id:source-option-b');
      expect(String(memoryTool)).toContain(sourceText);
      expect(oldDraft).toContain('historicalEvidence=unverified');
      expect(oldDraft).toContain('采用 A 方案');
      expect(linkedPartnerSummary).toContain('source_ids=["source-option-b"]');
      expect(linkedPartnerSummary).toContain('chose option B');

      (fixture.memory as unknown as { ledger: ForgetLedger }).ledger.addMany([{
        bankId: 'fixture-bank',
        endpoint: fixture.baseUrl,
        documentId: 'source-option-b',
        reason: 'Synthetic forget fence',
      }], 'Synthetic forget fence');
      const fencedSearch = await project.run('memory_search', { query: 'confirmed option B', sources: true });
      const staleDerivedSummary = String(await project.run('read_file', { path: PARTNER_FILE }));
      const oldDraftAfterFence = String(await project.run('read_file', { path: 'agenda/now.md' }));
      expect(String(fencedSearch)).toContain('Historical memory is restricted');
      expect(staleDerivedSummary).not.toContain('chose option B');
      expect(oldDraftAfterFence).toContain('historicalEvidence=unverified');
      expect(oldDraftAfterFence).toContain('采用 A 方案');
    } finally {
      project.close();
      await fixture.close();
    }
  });
});
