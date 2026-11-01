import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecallResult } from '@vectorize-io/hindsight-client';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { hindsightConfigGroup } from '../core/memory/config-group.ts';
import { cleanSpeech, DEFAULT_ACTIVATION_RANK_INFLUENCE, formatPortrait, formatRecall, formatRecallDetailed, type FormattedRecallResult } from '../core/memory/format.ts';
import { captureRetrievalScores } from '../core/memory/retrieval-scores.ts';
import { MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE } from '../core/memory/model-text.ts';
import { sanitizeForMemory } from '../core/memory/policy.ts';

const workspace = () => mkdtempSync(join(tmpdir(), 'coo-memory-'));
const fixedNow = () => new Date('2026-10-24T10:00:00.000Z');

const recallResult = (over: Partial<FormattedRecallResult>): FormattedRecallResult => ({ id: 'f1', text: 'a fact', type: 'observation', ...over });

describe('Hindsight config', () => {
  it('is off without a file or environment', () => {
    expect(loadHindsightConfig(workspace()).enabled).toBe(false);
  });

  it('reads the deployment file and clamps values', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'hindsight.json'), JSON.stringify({
      enabled: true,
      apiUrl: 'http://127.0.0.1:9999/',
      bankId: 'coopanion:test',
      recall: { maxTokens: 99999, timeoutMs: 1, budget: 'high' },
      affection: { dailyPositive: 0 },
    }));
    const config = loadHindsightConfig(dir);
    expect(config.enabled).toBe(true);
    expect(config.apiUrl).toBe('http://127.0.0.1:9999');
    expect(config.bankId).toBe('coopanion:test');
    expect(config.recall.maxTokens).toBe(4000);
    expect(config.recall.timeoutMs).toBe(100);
    expect(config.recall.budget).toBe('high');
    expect(config.affection.dailyPositive).toBe(1);
  });

  it('lets the config page override the file and environment defaults', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'hindsight.json'), JSON.stringify({ enabled: false, bankId: 'from-file' }));
    const config = loadHindsightConfig(dir, {
      enabled: true,
      apiUrl: 'http://127.0.0.1:7777',
      bankId: 'coopanion:from-ui',
      recall: { maxTokens: 1200 },
      affection: { enabled: false },
    });
    expect(config.enabled).toBe(true);
    expect(config.apiUrl).toBe('http://127.0.0.1:7777');
    expect(config.bankId).toBe('coopanion:from-ui');
    expect(config.recall.maxTokens).toBe(1200);
    expect(config.affection.enabled).toBe(false);
    expect(loadHindsightConfig(dir, { enabled: false }).enabled).toBe(false);
  });

  it('exposes the same dotted paths the config page and the runtime read', () => {
    const group = hindsightConfigGroup('zh');
    expect(group.id).toBe('hindsight');
    expect(Object.keys(group.schema.properties)).toEqual([
      'hindsight.autostart',
      'hindsight.enabled',
      'hindsight.apiUrl',
      'hindsight.bankId',
      'hindsight.recall.maxTokens',
      'hindsight.recall.maxSourceFactsTokens',
      'hindsight.recall.timeoutMs',
      'hindsight.affection.enabled',
    ]);
    expect(group.schema.properties['hindsight.enabled'].title).toContain('长期记忆');
  });

  it('gives each deployment its own default bank', () => {
    const a = loadHindsightConfig(workspace()).bankId;
    const b = loadHindsightConfig(workspace()).bankId;
    expect(a).toMatch(/^coopanion:[a-f0-9]{10}$/);
    expect(a).not.toBe(b);
  });
});

describe('memory formatting', () => {
  it('strips speech markers', () => {
    expect(cleanSpeech('【happy】morning <wave> there')).toBe('morning there');
  });

  it('keeps dated memories, drops duplicates and respects the item cap', () => {
    const text = formatRecall([
      recallResult({ text: 'likes tea', occurred_start: '2026-10-01T00:00:00Z' }),
      recallResult({ id: 'f2', text: 'likes tea' }),
      recallResult({ id: 'f3', text: 'works at night', type: 'world', mentioned_at: '2026-10-20T00:00:00Z' }),
    ]);
    expect(text).toContain('(observation, 2026-10-01) likes tea');
    expect(text).toContain('(world, 2026-10-20) works at night');
    expect(text.match(/likes tea/g)).toHaveLength(1);
  });

  it('keeps who said it and whether it is a plan or already done', () => {
    const text = formatRecall([
      recallResult({ text: 'plans to move to Hangzhou', document_id: 'doc-plan', metadata: { source_actor: 'user', status: 'planned' } }),
      recallResult({ id: 'f2', text: 'already moved', metadata: { source_actor: 'user', status: 'completed', user_verified: 'true' } }),
      recallResult({ id: 'f3', text: 'seems to like rain', metadata: { source_actor: 'inference' } }),
    ]);
    expect(text).toContain('(observation, undated, the person said, planned, source_id:doc-plan) plans to move to Hangzhou');
    expect(text).toContain('(observation, undated, the person said, completed, confirmed by the person) already moved');
    expect(text).toContain('(observation, undated, inferred) seems to like rain');
  });

  it('keeps the retrieved context and its linked source facts', () => {
    const text = formatRecall([
      recallResult({
        id: 'observation-1',
        text: 'The two people worked together on a planning document.',
        context: 'The observation joins two dated source events.',
        sourceFacts: [
          { id: 'fact-1', text: 'Lin coordinated the materials.', type: 'world', date: '2026-10-20T00:00:00Z', documentId: 'doc-1', metadata: { source_actor: 'user' } },
          { id: 'fact-2', text: 'Wei reviewed the plan.', type: 'experience', date: '2026-10-21T00:00:00Z', documentId: 'doc-2' },
        ],
      }),
    ]);

    expect(text).toContain('context: The observation joins two dated source events.');
    expect(text).toContain('supporting source (world, 2026-10-20, the person said, source_id:doc-1) Lin coordinated the materials.');
    expect(text).toContain('supporting source (experience, 2026-10-21, source_id:doc-2) Wei reviewed the plan.');
  });

  it('labels a recall whose supporting source facts were truncated', () => {
    const text = formatRecall([recallResult({ text: 'A synthetic observation.', sourceFactsIncomplete: true })], { sourceFactsTruncated: true });

    expect(text).toContain('Supporting source evidence is incomplete or truncated');
    expect(text).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(text).toContain('Supporting source facts are incomplete for this result.');
  });

  it('requests original-source verification for incomplete facts even without a server truncation flag', () => {
    const text = formatRecall([recallResult({ text: 'A synthetic observation.', sourceFactsIncomplete: true })]);
    expect(text).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(text).toContain('Supporting source facts are incomplete for this result.');
  });

  it('keeps the full recall block under maxChars including headers and truncation notices', () => {
    const text = formatRecall([
      recallResult({ id: 'long', text: 'x'.repeat(700), sourceFactsIncomplete: true }),
    ], { header: 'H'.repeat(90), maxChars: 800, sourceFactsTruncated: true });
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(text).toContain('Supporting source facts are incomplete for this result.');
    expect(text).toContain('xxxxxxxxxxxxxxxx');
  });

  it('reports which evidence sources made it through the character budget without recording text', () => {
    const formatted = formatRecallDetailed([
      recallResult({
        id: 'observation-trace',
        text: 'A synthetic observation joins two source events.',
        sourceFacts: [
          { id: 'fact-a', text: 'First synthetic supporting event.', type: 'world', date: '2026-10-20', documentId: 'doc-a' },
          { id: 'fact-b', text: 'Second synthetic supporting event.', type: 'world', date: '2026-10-21', documentId: 'doc-b' },
        ],
      }),
    ], { maxChars: 260 });

    expect(formatted.text.length).toBeLessThanOrEqual(260);
    expect(formatted.trace.candidateResultIndexes).toEqual([0]);
    expect(formatted.trace.includedResultIndexes).toEqual([0]);
    expect(formatted.trace.inputResultIds).toEqual(['observation-trace']);
    expect(formatted.trace.includedResultIds).toEqual(['observation-trace']);
    expect(formatted.trace.includedSourceDocumentIds).toEqual(['doc-a']);
    expect(formatted.trace.omittedSourceDocumentIds).toEqual(['doc-b']);
    expect(formatted.trace.incompleteResultIds).toEqual(['observation-trace']);
    expect(JSON.stringify(formatted.trace)).not.toContain('First synthetic supporting event.');
  });

  it('selects a result that adds source coverage when the item budget is tight', () => {
    const results = [
      recallResult({ id: 'primary', text: 'The first record is relevant.', document_id: 'doc-a' }),
      recallResult({ id: 'redundant', text: 'A second record from the same source.', document_id: 'doc-a' }),
      recallResult({ id: 'additional', text: 'A useful record from another source.', document_id: 'doc-b' }),
    ];
    const baseline = formatRecallDetailed(results, { maxItems: 2, coverageWeight: 0 });
    const formatted = formatRecallDetailed(results, { maxItems: 2, coverageWeight: 0.5 });

    expect(formatted.trace.inputResultIndexes).toEqual([0, 1, 2]);
    expect(formatted.trace.candidateResultIndexes).toEqual([0, 2, 1]);
    expect(formatted.trace.includedResultIndexes).toEqual([0, 2]);
    expect(formatted.trace.includedSourceDocumentIds).toEqual(['doc-a', 'doc-b']);
    expect(baseline.trace.includedResultIndexes).toEqual([0, 1]);
    expect(baseline.trace.includedSourceDocumentIds).toEqual(['doc-a']);
    expect(formatted.text.indexOf('The first record is relevant.')).toBeLessThan(formatted.text.indexOf('A useful record from another source.'));
    expect(formatted.text).not.toContain('A second record from the same source.');
  });

  it('uses activation as a soft ranking signal and keeps a low-activation direct match eligible', () => {
    const results = [
      recallResult({ id: 'direct-old-event', text: 'The directly requested old event.', document_id: 'doc-old', activationWeight: 0.05 }),
      recallResult({ id: 'recent-1', document_id: 'doc-recent-1', activationWeight: 0.05 }),
      recallResult({ id: 'recent-2', document_id: 'doc-recent-2', activationWeight: 0.05 }),
      recallResult({ id: 'recent-3', document_id: 'doc-recent-3', activationWeight: 0.05 }),
      recallResult({ id: 'recent-4', document_id: 'doc-recent-4', activationWeight: 1 }),
    ];
    const formatted = formatRecallDetailed(results, { maxItems: results.length, coverageWeight: 0 });
    const directMatch = formatRecallDetailed([results[0]!], { maxItems: 1, coverageWeight: 0 });

    expect(formatted.trace.candidateResultIndexes).toEqual([0, 1, 4, 2, 3]);
    expect(formatted.trace.activationInfluence).toBe(DEFAULT_ACTIVATION_RANK_INFLUENCE);
    expect(formatted.trace.activationWeights).toEqual([
      { resultId: 'direct-old-event', weight: 0.05 },
      { resultId: 'recent-1', weight: 0.05 },
      { resultId: 'recent-4', weight: 1 },
      { resultId: 'recent-2', weight: 0.05 },
      { resultId: 'recent-3', weight: 0.05 },
    ]);
    expect(directMatch.trace.includedResultIds).toEqual(['direct-old-event']);
    expect(directMatch.trace.includedSourceDocumentIds).toEqual(['doc-old']);
  });

  it('captures only finite retrieval score values and records missing fields without filling them', () => {
    expect(captureRetrievalScores({ final: 0.82, reranker: null, semantic: Number.NaN, keyword: Number.POSITIVE_INFINITY, route: 'unverified' }, 3)).toEqual({
      source: 'hindsight-recall',
      inputRank: 3,
      final: { status: 'present', value: 0.82 },
      reranker: { status: 'missing' },
      semantic: { status: 'missing' },
      keyword: { status: 'missing' },
    });
    expect(captureRetrievalScores(undefined, 0)).toEqual({
      source: 'hindsight-recall',
      inputRank: 0,
      final: { status: 'missing' },
      reranker: { status: 'missing' },
      semantic: { status: 'missing' },
      keyword: { status: 'missing' },
    });
  });

  it('passes score evidence to a read-only trace without changing recall text or order', () => {
    const results = [
      recallResult({
        id: 'first', text: 'First result remains first.', document_id: 'doc-a',
        retrievalScores: captureRetrievalScores({ final: 0.1, reranker: 0.2 }, 0),
      }),
      recallResult({
        id: 'second', text: 'Second result has a higher synthetic score.', document_id: 'doc-b',
        retrievalScores: captureRetrievalScores({ final: 0.99, reranker: 0.98 }, 1),
      }),
    ];
    const withoutScores = results.map((result) => ({ ...result, retrievalScores: undefined }));
    const withScores = formatRecallDetailed(results, { maxItems: 1 });
    const baseline = formatRecallDetailed(withoutScores, { maxItems: 1 });
    const noTrace = formatRecallDetailed(results, { maxItems: 1, captureTrace: false });

    expect(withScores.text).toBe(baseline.text);
    expect(withScores.trace.candidateResultIndexes).toEqual(baseline.trace.candidateResultIndexes);
    expect(withScores.trace.includedResultIndexes).toEqual([0]);
    expect(withScores.trace.retrievalScores).toMatchObject([
      { resultId: 'first', source: 'hindsight-recall', inputRank: 0, final: { status: 'present', value: 0.1 } },
      { resultId: 'second', source: 'hindsight-recall', inputRank: 1, final: { status: 'present', value: 0.99 } },
    ]);
    expect(noTrace.text).toBe(withScores.text);
    expect(noTrace.trace.retrievalScores).toEqual([]);
  });

  it('preserves distinct supporting facts for duplicate observations with the same source document', () => {
    const common = { text: 'The team worked on the same plan.', document_id: 'doc-observation' };
    const text = formatRecall([
      recallResult({ id: 'observation-a', ...common, sourceFacts: [{ id: 'fact-a', text: 'Lin coordinated.', type: 'world', date: '2026-10-20', documentId: 'doc-source' }] }),
      recallResult({ id: 'observation-b', ...common, sourceFacts: [{ id: 'fact-b', text: 'Wei reviewed.', type: 'experience', date: '2026-10-21', documentId: 'doc-source' }] }),
    ]);
    expect(text).toContain('Lin coordinated.');
    expect(text).toContain('Wei reviewed.');
  });

  it('skips empty portraits and empty recall', () => {
    expect(formatPortrait([{ title: 'The person', text: 'I cannot find any information.' }])).toBe('');
    expect(formatRecall([])).toBe('');
  });

  it('redacts keys and refuses password-like text', () => {
    expect(sanitizeForMemory('my key is sk-abcdefghijklmnop1234').text).toContain('[redacted]');
    expect(sanitizeForMemory('我的密码是 hunter2')).toEqual({ text: '', skip: 'sensitive' });
    expect(sanitizeForMemory('token=abcdef1234567890')).toEqual({ text: '', skip: 'sensitive' });
    expect(sanitizeForMemory('I like tea')).toEqual({ text: 'I like tea' });
  });
});
