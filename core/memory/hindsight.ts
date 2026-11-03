import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAttachment, GenerationEvidenceEnvelope, SourceExposureRef } from 'cortico/core/types.ts';
import { createClient, createConfig, HindsightClient, HindsightError, sdk } from '@vectorize-io/hindsight-client';
import {
  activationAt,
  DEFAULT_REINFORCEMENT_PARAMETERS,
  mentionIntensityForText,
} from './activation.ts';
import { formatPortrait, formatRecall, formatRecallDetailed, type RecallFormatTrace } from './format.ts';
import { captureRetrievalScores, type RetrievalScoreEvidence } from './retrieval-scores.ts';
import { sanitizeForMemory } from './policy.ts';
import { loadHindsightConfig, type HindsightConfig, type HindsightFileConfig } from './config.ts';
import { DeliveryError, OutboxDelivery, type DeliveryOps, type OperationState } from './delivery.ts';
import { MemoryOutbox, readLegacyOutbox, type OutboxItem, type RetainItem } from './outbox.ts';
import { ForgetLedger, readLegacyForget, type DeletionInput, type ForgetIntentAcceptance } from './forget-ledger.ts';
import {
  memoryArtifactScope,
  openMemoryStateStore,
  type DerivedArtifact,
  type DerivedArtifactInput,
  type DerivedArtifactOrigin,
  type DerivedArtifactReviewState,
  type DerivedArtifactLifecycleState,
  type GenerationEvidence,
  type GenerationEvidenceInput,
  type MemoryEvidenceOrigin,
  type MemorySourceDependency,
  type MemorySourceMappingState,
  type MemorySourceValidationState,
  type MemoryStateStore,
} from './state-store.ts';
import { planRecall, type RecallRoute } from './router.ts';
import { partnerSourceScopeDigest } from './partner-provenance.ts';
import { sourceFactsTokenBudget as resolveSourceFactsTokenBudget, recallContextCharBudget } from './recall-limits.ts';
import { summarizeSourceFacts, type SourceFactCounts } from './recall-evidence.ts';
import { planRecallQueries, type SourceMatchType } from './recall-query.ts';
import {
  SOURCE_LOOKUP_CANDIDATE_HEADER,
  SOURCE_LOOKUP_HEADER,
  SOURCE_LOOKUP_INCOMPLETE_NOTICE,
  SOURCE_LOOKUP_INVALID_CANDIDATE_NOTICE,
  sourceLookupMissNotice,
} from './model-text.ts';

export type MemoryReadStatus = 'found' | 'absent' | 'incomplete' | 'unavailable' | 'fenced';
export type TurnRecallStatus = MemoryReadStatus | 'skipped';
export const SOURCE_LOOKUP_LIMITS = { pageSize: 250, maxDocuments: 2048, maxSourceReads: 2048, concurrency: 4, maxSources: 6, maxChars: 8000 } as const;
const DEEP_RECALL_MAX_ITEMS = 20;
const MAX_SUPPLEMENTAL_RECALL_QUERIES = 2;
const SUPPLEMENTAL_RECALL_MAX_TOKENS = 600;
const SUPPLEMENTAL_SOURCE_FACTS_MAX_TOKENS = 1024;
const MAX_PRIORITY_SOURCE_DOCUMENTS = DEEP_RECALL_MAX_ITEMS;

export interface MemoryTextRead {
  text: string;
  status: MemoryReadStatus;
  sourceFactsTruncated?: boolean;
  trace?: MemoryRecallTrace;
  sourceDocuments?: OriginalSourceCandidate[];
  sourceSegments?: MemoryEvidenceSegment[];
  rejectedSourceDocumentIds?: string[];
}

export interface MemoryEvidenceSegment {
  documentId: string;
  start: number;
  end: number;
  /** Experience cards keep an explicit sourceIds link to each verified source. */
  derived?: true;
}

export interface OriginalSourceCandidate {
  documentId: string;
  originalText: string;
  recordedAt: string;
  sourceKind: 'event' | 'correction';
  recordStatus: string;
  matchType: SourceMatchType;
  matchChars: number;
  clipped: boolean;
}

export interface RecallQueryAttemptTrace {
  queryHash: string;
  strategy: 'primary' | 'topic' | 'phrase';
  status: MemoryReadStatus;
  elapsedMs: number;
  resultCount: number;
  sourceFactsTruncated: boolean;
  recallTokenBudget?: number;
  sourceFactsTokenBudget?: number;
}

export interface MemoryRecallTrace {
  search: MemorySearchTrace;
  format: RecallFormatTrace;
  maxTokens: number;
  maxChars: number;
  sourceFactsTokenBudget?: number;
  queryAttempts: RecallQueryAttemptTrace[];
}

export interface MemorySearchSourceFact {
  id: string;
  text: string;
  type: string;
  date: string;
  documentId: string;
  metadata?: Record<string, string>;
  sourceMatchType?: SourceMatchType;
}

export interface MemorySearchResult {
  id: string;
  text: string;
  type: string;
  date: string;
  documentId: string | null;
  context?: string;
  metadata?: Record<string, string>;
  sourceFacts?: MemorySearchSourceFact[];
  sourceFactsIncomplete?: boolean;
  matchScore?: number;
  activationWeight?: number;
  retrievalScores?: RetrievalScoreEvidence;
  queryIndexes?: number[];
  sourceMatchType?: SourceMatchType;
}

export interface MemorySearchRead {
  results: MemorySearchResult[];
  status: MemoryReadStatus;
  sourceFactsTruncated?: boolean;
  trace?: MemorySearchTrace;
}

export interface MemorySearchTraceItem {
  resultIndex: number;
  queryIndex: number;
  resultId: string;
  parentDocumentId: string | null;
  declaredSourceFactIds: string[];
  verifiedSources: Array<{ sourceFactId: string; documentId: string }>;
  disposition: 'candidate' | 'visible' | 'filtered' | 'fenced';
  reason?: 'forgotten-support' | 'unverified-source-fact' | 'unlinked-observation' | 'missing-source-id' | 'current-question-source' | 'fence-unresolved' | 'ledger-unreadable';
  sourceFactsIncomplete: boolean;
  activationWeight?: number;
  retrievalScores?: RetrievalScoreEvidence;
}

export interface MemorySearchTrace {
  items: MemorySearchTraceItem[];
  candidateResultIndexes: number[];
  candidateResultIds: string[];
  status: MemoryReadStatus;
  sourceFactsTruncated: boolean;
  recallTokenBudget?: number;
  sourceFactsTokenBudget?: number;
  sourceFactCounts?: SourceFactCounts;
  queryAttempts?: RecallQueryAttemptTrace[];
}

export interface MemoryLog {
  warn(message: string, data?: unknown): void;
  error?(message: string, data?: unknown): void;
}

export interface RecallOptions {
  timeoutMs?: number;
  maxTokens?: number;
  maxSourceFactsTokens?: number;
  maxChars?: number;
  maxItems?: number;
  coverageWeight?: number;
  activationInfluence?: number;
  activationEnabled?: boolean;
  budget?: 'low' | 'mid' | 'high';
  types?: string[];
  captureTrace?: boolean;
  userEventDocumentId?: string;
  queryIndex?: number;
}

interface UserEventSource {
  documentId: string;
  date: string;
}

function userEventSources(result: MemorySearchResult): UserEventSource[] {
  const sources = result.sourceFacts?.length
    ? result.sourceFacts.map((fact) => ({ documentId: fact.documentId, date: fact.date, metadata: fact.metadata }))
    : result.sourceFactsIncomplete || !result.documentId
      ? []
      : [{ documentId: result.documentId, date: result.date, metadata: result.metadata }];
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (!source.documentId || !source.date || !Number.isFinite(Date.parse(source.date))) return false;
    if (source.metadata?.source_actor !== 'user' || source.metadata.kind !== 'event') return false;
    if (source.metadata.status === 'superseded' || source.metadata.status === 'disputed') return false;
    if (seen.has(source.documentId)) return false;
    seen.add(source.documentId);
    return true;
  }).map(({ documentId, date }) => ({ documentId, date }));
}

function historicalSourceMetadata(metadata: Record<string, string> | undefined): boolean {
  return !!metadata
    && ['user', 'coo', 'affinity', 'tool'].includes(metadata.source_actor ?? '')
    && ['event', 'correction'].includes(metadata.kind ?? '')
    && metadata.status !== 'disputed';
}

function recallResultKey(result: MemorySearchResult): string {
  if (result.documentId && result.type !== 'observation') return `${result.type}\0${result.documentId}`;
  return `${result.type}\0${result.id}`;
}

function mergeRecallReads(reads: readonly MemorySearchRead[]): MemorySearchRead {
  const merged = new Map<string, MemorySearchResult>();
  const traceItems: MemorySearchTraceItem[] = [];
  const attempts: RecallQueryAttemptTrace[] = [];
  const sourceFactCounts: SourceFactCounts = { declared: 0, returned: 0, valid: 0, missing: 0, invalid: 0, parsed: 0 };
  let recallTokenBudget = 0, sourceFactsTokenBudget = 0;
  let hasRecallBudget = false, hasSourceBudget = false, sourceFactsTruncated = false;

  for (const read of reads) {
    if (read.trace) {
      traceItems.push(...read.trace.items);
      if (read.trace.recallTokenBudget !== undefined) { recallTokenBudget += read.trace.recallTokenBudget; hasRecallBudget = true; }
      if (read.trace.sourceFactsTokenBudget !== undefined) { sourceFactsTokenBudget += read.trace.sourceFactsTokenBudget; hasSourceBudget = true; }
      for (const key of ['declared', 'returned', 'valid', 'missing', 'invalid', 'parsed'] as const) {
        sourceFactCounts[key] = (sourceFactCounts[key] ?? 0) + (read.trace.sourceFactCounts?.[key] ?? 0);
      }
    }
    if (read.trace?.queryAttempts) attempts.push(...read.trace.queryAttempts);
    sourceFactsTruncated ||= read.sourceFactsTruncated === true;
    for (const result of read.results) {
      const key = recallResultKey(result);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, result);
        continue;
      }
      const texts = [...new Set([current.text, result.text].map((value) => value.trim()).filter(Boolean))];
      const facts = new Map<string, MemorySearchSourceFact>();
      for (const fact of [...(current.sourceFacts ?? []), ...(result.sourceFacts ?? [])]) {
        const factKey = `${fact.documentId}\0${fact.id}`;
        const existing = facts.get(factKey);
        if (!existing || existing.text.length < fact.text.length) facts.set(factKey, fact);
      }
      const matchScore = Math.max(current.matchScore ?? Number.NEGATIVE_INFINITY, result.matchScore ?? Number.NEGATIVE_INFINITY);
      merged.set(key, {
        ...current,
        text: texts.join('\n'),
        ...(facts.size ? { sourceFacts: [...facts.values()] } : {}),
        sourceFactsIncomplete: current.sourceFactsIncomplete === true || result.sourceFactsIncomplete === true,
        ...(Number.isFinite(matchScore) ? { matchScore } : {}),
        queryIndexes: [...new Set([...(current.queryIndexes ?? []), ...(result.queryIndexes ?? [])])],
        ...(current.sourceMatchType ?? result.sourceMatchType ? { sourceMatchType: current.sourceMatchType ?? result.sourceMatchType } : {}),
      });
    }
  }
  const results = [...merged.values()];
  const status = results.length ? 'found' : reads.some((read) => read.status === 'fenced') ? 'fenced'
    : reads.some((read) => read.status === 'incomplete') ? 'incomplete'
      : reads.some((read) => read.status === 'unavailable') ? 'unavailable' : 'absent';
  const trace: MemorySearchTrace = {
    items: traceItems,
    candidateResultIndexes: results.map((_, index) => index),
    candidateResultIds: results.map((result) => result.id),
    status,
    sourceFactsTruncated,
    ...(hasRecallBudget ? { recallTokenBudget } : {}),
    ...(hasSourceBudget ? { sourceFactsTokenBudget } : {}),
    ...(traceItems.length ? { sourceFactCounts } : {}),
    ...(attempts.length ? { queryAttempts: attempts } : {}),
  };
  return { results, status, ...(sourceFactsTruncated ? { sourceFactsTruncated: true } : {}), trace };
}

function recallEvidenceCoversQuery(read: MemorySearchRead, phrases: readonly string[]): boolean {
  if (read.status !== 'found' || read.sourceFactsTruncated) return false;
  const complete = read.results.filter((result) => !result.sourceFactsIncomplete);
  if (complete.length === 0) return false;
  const sourceTexts = complete.flatMap((result) => [
    ...(result.metadata?.source_actor === 'user' && ['event', 'correction'].includes(result.metadata.kind ?? '') ? [result.text] : []),
    ...(result.sourceFacts ?? []).filter((fact) => fact.metadata?.source_actor === 'user'
      && ['event', 'correction'].includes(fact.metadata.kind ?? '')).map((fact) => fact.text),
  ]).map((text) => text.toLocaleLowerCase());
  if (sourceTexts.length === 0) return false;
  const required = [...new Set(phrases.filter((phrase) => [...phrase].length >= 3))];
  if (required.length === 0) return true;
  return sourceTexts.some((sourceText) => {
    const matched = required.filter((phrase) => sourceText.includes(phrase.toLocaleLowerCase()))
      .sort((left, right) => [...right].length - [...left].length);
    if (matched.some((phrase) => [...phrase].length >= 8
      && (phrase.includes(' ') || /\p{Script=Han}/u.test(phrase)))) return true;
    const distinct = matched.filter((phrase, index) => !matched.slice(0, index)
      .some((previous) => previous.includes(phrase) || phrase.includes(previous)));
    return distinct.length >= Math.min(2, required.length);
  });
}

/** Source facts already carry validated support; only direct user records need an original-document read-back. */
function sourceDocumentIdsFromRecall(results: readonly MemorySearchResult[], excludeDocumentId?: string): string[] {
  const ids = new Set<string>();
  for (const result of results) {
    if (result.type !== 'observation' && result.documentId
      && result.metadata?.source_actor === 'user' && ['event', 'correction'].includes(result.metadata.kind ?? '')
      && result.documentId !== excludeDocumentId) ids.add(result.documentId);
  }
  return [...ids];
}

function mergeOriginalSources(read: MemorySearchRead, sources: readonly OriginalSourceCandidate[]): MemorySearchRead {
  if (sources.length === 0) return read;
  const results = [...read.results];
  for (const source of sources) {
    const matching = results.findIndex((result) => result.documentId === source.documentId
      || result.sourceFacts?.some((fact) => fact.documentId === source.documentId));
    if (matching < 0) {
      results.push({
        id: `source-candidate:${hash(source.documentId)}`,
        text: source.originalText,
        type: 'world',
        date: source.recordedAt,
        documentId: source.documentId,
        metadata: { source_actor: 'user', kind: source.sourceKind, status: source.recordStatus },
        sourceMatchType: source.matchType,
      });
      continue;
    }
    const result = results[matching]!;
    if (result.documentId === source.documentId) {
      const text = result.text.includes(source.originalText) ? result.text : `${result.text}\n${source.originalText}`;
      results[matching] = { ...result, text, sourceMatchType: source.matchType };
      continue;
    }
    const facts = result.sourceFacts?.map((fact) => fact.documentId === source.documentId
      ? {
        ...fact,
        text: fact.text.includes(source.originalText) ? fact.text : `${fact.text}\n${source.originalText}`,
        sourceMatchType: source.matchType,
      }
      : fact);
    results[matching] = { ...result, ...(facts ? { sourceFacts: facts } : {}) };
  }
  const matchPriority: Record<SourceMatchType, number> = { query_prefix: 0, literal_phrase: 1, semantic_candidate: 2 };
  results.sort((left, right) => {
    const leftType = left.sourceMatchType ?? left.sourceFacts?.find((fact) => fact.sourceMatchType)?.sourceMatchType;
    const rightType = right.sourceMatchType ?? right.sourceFacts?.find((fact) => fact.sourceMatchType)?.sourceMatchType;
    if (!leftType && !rightType) return 0;
    if (!leftType) return 1;
    if (!rightType) return -1;
    return matchPriority[leftType] - matchPriority[rightType];
  });
  return { ...read, results };
}

function rejectInvalidSourceCandidates(read: MemorySearchRead, invalidIds: readonly string[]): MemorySearchRead {
  const invalid = new Set(invalidIds);
  if (invalid.size === 0) return read;
  const results = read.results.flatMap((result): MemorySearchResult[] => {
    if (result.documentId && invalid.has(result.documentId)) {
      for (const item of read.trace?.items ?? []) {
        if (item.resultId === result.id) {
          item.disposition = 'filtered';
          item.reason = 'missing-source-id';
        }
      }
      return [];
    }
    return [result];
  });
  const trace = read.trace ? {
    ...read.trace,
    candidateResultIndexes: results.map((_, index) => index),
    candidateResultIds: results.map((result) => result.id),
    status: results.length ? 'found' as const : 'incomplete' as const,
  } : undefined;
  return { ...read, results, status: results.length ? 'found' : 'incomplete', ...(trace ? { trace } : {}) };
}

export interface TurnRecall {
  text: string;
  route: RecallRoute;
  found: boolean;
  status: TurnRecallStatus;
  trace?: MemoryRecallTrace;
}

export interface TurnRecallReceipt {
  at: string;
  queryHash: string;
  contextHash: string;
  contextChars: number;
  injectedAt?: string;
  route: RecallRoute;
  status: TurnRecallStatus;
  elapsedMs: number;
  cacheHit: boolean;
  maxTokens: number;
  maxSourceFactsTokens: number;
  timeoutMs: number;
  maxChars: number;
  sourceFactCounts?: SourceFactCounts;
  queryAttempts?: RecallQueryAttemptTrace[];
  serverTruncated?: boolean;
  includedResults: number;
  omittedResults: number;
  clippedResults: number;
  includedSourceFactHashes: string[];
  includedSourceDocumentHashes: string[];
  automaticSourceLookup?: AutomaticSourceLookupReceipt;
}

export interface SourceLookupReceipt {
  at: string;
  queryHash: string;
  queryHashes: string[];
  contextHash: string;
  contextChars: number;
  elapsedMs: number;
  status: MemoryReadStatus | 'incomplete';
  sourceDocumentHashes: string[];
  clippedSourceDocumentHashes: string[];
  scannedDocuments: number;
  sourceReads: number;
  scanIncomplete: boolean;
  queryPrefixMatches: number;
  phraseCandidates: number;
  semanticCandidates: number;
  invalidCandidateHashes: string[];
}

export interface AutomaticSourceLookupReceipt {
  status: SourceLookupReceipt['status'];
  queryHashes: string[];
  sourceDocumentHashes: string[];
  scannedDocuments: number;
  sourceReads: number;
  scanIncomplete: boolean;
  queryPrefixMatches: number;
  phraseCandidates: number;
  semanticCandidates: number;
  invalidCandidateCount: number;
  elapsedMs: number;
}

export interface ForgetSourceScanReceipt {
  at: string;
  queryHash: string;
  elapsedMs: number;
  scannedDocuments: number;
  sourceReads: number;
  matchedSources: number;
  matchedSourceDocumentHashes: string[];
  complete: boolean;
  stopReason: 'complete' | 'short-query' | 'unavailable' | 'too-many-matches' | 'scan-limit' | 'read-limit' | 'empty-page' | 'timeout' | 'service-error';
}

export interface ForgetResult {
  /** Whether a durable intent or existing fence accepted the request. */
  acceptance: ForgetIntentAcceptance | 'not-found' | 'partial';
  /** Writes removed from the local queue before sending. */
  local: number;
  /** Source documents confirmed deleted remotely. */
  deleted: number;
  /** Deletion tasks still waiting for the service or their original bank. */
  pending: number;
  /** Deletion tasks that failed and will be retried. */
  failed: number;
  /** Cortico does not expose active-session context invalidation to this extension. */
  activeContextInvalidated: false;
}

export interface MemoryLifecycleHooks {
  /** Remove derived application state tied to these exact Hindsight source document IDs. */
  forgetSources(sourceIds: readonly string[]): void;
  /** Remove derived application state after the configured bank has been cleared. */
  clearDerived(): void;
}

/** Metadata that keeps an extracted fact tied to who said it and when, without a second fact graph. */
export interface SourceMeta {
  actor: 'user' | 'coo' | 'affinity' | 'tool' | 'inference';
  kind: 'fact' | 'preference' | 'plan' | 'event' | 'correction';
  status?: 'current' | 'planned' | 'completed' | 'superseded' | 'disputed';
  saidAt?: string;
  eventId?: string;
  userVerified?: boolean;
  supersedes?: string[];
}

export interface MemorySourceEvidence {
  present: boolean;
  visible: boolean;
  actor: string | null;
  status: string | null;
  kind?: string;
  occurredAt?: string;
}

export interface DerivedArtifactRegistration {
  artifactId: string;
  kind: string;
  target: string;
  content: string;
  origin: DerivedArtifactOrigin;
  reviewState: DerivedArtifactReviewState;
  creatorSessionId?: string;
  creatorGenerationId?: string;
  creatorOperationId?: string;
  sourceIds: readonly string[];
  expectedEpoch?: string;
}

export interface HandoffArtifactCommit {
  artifactId: string;
  ownerToken: string;
  target: string;
  content: string;
  expectedEpoch: string;
  mappingState: 'complete' | 'source-independent';
  sources: readonly SourceExposureRef[];
  segmentDigests: ReadonlyMap<string, string>;
}

interface MemorySourceExposure {
  attachment: Omit<EvidenceAttachment, 'segment'>;
  originalText: string;
}

function canonicalEvidenceText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function sourceMetadata(meta: SourceMeta): Record<string, string> {
  const out: Record<string, string> = { source_actor: meta.actor, kind: meta.kind };
  if (meta.status) out.status = meta.status;
  if (meta.saidAt) out.said_at = meta.saidAt;
  if (meta.eventId) out.source_event_id = meta.eventId;
  if (meta.userVerified !== undefined) out.user_verified = String(meta.userVerified);
  if (meta.supersedes?.length) out.supersedes_source_ids = JSON.stringify([...new Set(meta.supersedes)]);
  return out;
}

export interface SessionBriefing {
  text: string;
  source: 'mental-models' | 'recall' | 'none';
  evidence?: EvidenceAttachment[];
}

const BRIEFING_MODEL_IDS = ['partner-portrait', 'relationship', 'open-loops'] as const;
/** Coo's portrait of herself; read by the periodic self-review, not by the session opening. */
export const SELF_PORTRAIT_MODEL = 'self-portrait';
const MODEL_IDS = [...BRIEFING_MODEL_IDS, SELF_PORTRAIT_MODEL] as const;
type ModelId = typeof MODEL_IDS[number];

const MODEL_QUERIES: Record<ModelId, string> = {
  'partner-portrait': 'Write a compact portrait of the person Coo lives with: their name or how they want to be addressed, stable preferences, routines, boundaries, important people, current projects, and what they expect from Coo. Prefer durable facts; ignore one-off chatter.',
  'relationship': 'Describe the relationship between Coo and the person: shared rituals, affectionate moments, conflicts and repairs, what makes the person feel cared for, and what they dislike. Be concrete and kind; no diagnosis.',
  'open-loops': 'List open loops: promises Coo made, things the person asked Coo to remember or follow up on, and unresolved topics. Include dates when known.',
  [SELF_PORTRAIT_MODEL]: 'Describe how Coo has been showing up lately, using her own words and the relationship diary: her tone, recurring phrases, what she does when praised, worried, contradicted, bored or needed; what she keeps doing or avoiding; what seems to be changing in her. Focus on Coo, not on the person. Prefer durable patterns over one-off moods. Be concrete and quote a short phrase when it shows the pattern.',
};

const MODEL_TITLES: Record<ModelId, string> = {
  'partner-portrait': 'The person',
  'relationship': 'Our relationship',
  'open-loops': 'Open loops',
  [SELF_PORTRAIT_MODEL]: 'Me, lately',
};

const MENTAL_MODEL_REFRESH_TIMEOUT_MS = 240_000;
const MENTAL_MODEL_REFRESH_POLL_MS = 500;

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const sourceTupleKey = (source: Pick<SourceExposureRef, 'bankId' | 'endpoint' | 'documentId'>): string =>
  JSON.stringify([source.bankId, source.endpoint, source.documentId]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise.catch(() => fallback), sleep(ms).then(() => fallback)]);
}

function isMissing(err: unknown): boolean {
  return err instanceof HindsightError && (err.statusCode === 404 || err.statusCode === 410);
}

function isMissingDelete(err: unknown): boolean {
  return isMissing(err)
    || (err instanceof Error && err.message === 'deleteDocument failed: {"detail":"Document not found"}');
}

/** A forget request cancels queued payloads that contain the same words, not every item in the queue. */
function matchesForget(item: { content: string }, query: string): boolean {
  const text = item.content.toLowerCase();
  const asked = query.trim().toLowerCase();
  if (asked.length < 2) return false;
  if (text.includes(asked)) return true;
  const parts = asked.split(/[\s,，。.!！?？、;；:：]+/).filter((part) => part.length >= 2);
  return parts.length > 1 && parts.every((part) => text.includes(part));
}

/** The fenced source behind a queued write; an item without a bank binding cannot be deleted. */
function sourceOf(item: OutboxItem): DeletionInput | null {
  if (!item.bankId || !item.endpoint) return null;
  return {
    bankId: item.bankId,
    endpoint: item.endpoint,
    documentId: item.documentId,
    ...(item.state === 'pending' ? {} : { operationId: item.operationId }),
    reason: 'the person asked to forget this',
  };
}

function defaultHindsightCommand(port: string): string {
  const mac = join(homedir(), 'Library', 'Application Support', 'Hindsight', 'venv', 'bin', 'hindsight-api');
  const bin = existsSync(mac) ? mac : 'hindsight-api';
  return `"${bin}" --host 127.0.0.1 --port ${port}`;
}

export class HindsightMemory {
  private config: HindsightConfig | null = null;
  private client: HindsightClient | null = null;
  private log: MemoryLog | null = null;
  private booting: Promise<void> | null = null;
  private bootingNow = false;
  private ready = false;
  private unavailableUntil = 0;
  private warnedAt = 0;
  private warnedFullAt = 0;
  private briefing: { at: number; value: SessionBriefing } | null = null;
  private outbox: MemoryOutbox | null = null;
  private ledger: ForgetLedger | null = null;
  private stateStore: MemoryStateStore | null = null;
  private storageError: string | null = null;
  private delivery: OutboxDelivery | null = null;
  private opsClient: ReturnType<typeof createClient> | null = null;
  private draining = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private recallCache = new Map<string, { at: number; value: string; trace?: MemoryRecallTrace }>();
  private lastRecall: TurnRecallReceipt | null = null;
  private lastSourceLookup: SourceLookupReceipt | null = null;
  private lastForgetSourceScan: ForgetSourceScanReceipt | null = null;
  private recallStats = { fast: 0, standard: 0, deep: 0, measured: 0, totalMs: 0 };
  /** Incremented by every invalidation; an in-flight read from an older epoch is discarded. */
  private cacheEpoch = 0;
  /** Whole-bank reads pause while a natural-language forget query is being resolved to sources. */
  private forgetScanDepth = 0;
  /** Fence epoch whose portraits have already been cleared in this process. */
  private readonly clearedEpochs = new Map<string, number>();
  /** A terminal refresh failure keeps its fence closed without silently re-submitting every tick. */
  private readonly failedRefreshEpochs = new Map<string, number>();
  private readonly derivedRefreshes = new Map<string, { epoch: number; promise: Promise<void> }>();
  private latestDelivery: { at: number; submitted: number; completed: number; verified: number; failed: number } | null = null;
  private rootDir: string | null = null;
  private autostartTried = false;
  private modelRefreshAt = 0;
  private modelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleHooks: MemoryLifecycleHooks | null = null;

  setLifecycleHooks(hooks: MemoryLifecycleHooks): void {
    this.lifecycleHooks = hooks;
  }

  private dependencyFromExposure(
    source: SourceExposureRef,
    segmentDigest: string | null,
    correlationId: string | null,
    expectedEpoch: string,
  ): MemorySourceDependency {
    const config = this.config;
    const ledger = this.ledger;
    const current = !!config && !!ledger && source.bankId === config.bankId && source.endpoint === config.apiUrl
      && source.validatedEpoch === expectedEpoch && this.evidenceEpoch() === expectedEpoch
      && this.sourceExposureCurrent([source]) && !!segmentDigest && /^[a-f0-9]{64}$/.test(segmentDigest);
    const validationState: MemorySourceValidationState = current ? 'validated'
      : source.validationStatus === 'stale' || source.revisionState === 'superseded' ? 'stale'
        : source.validationStatus === 'rejected' ? 'withheld' : 'unknown';
    const epoch = current && config && ledger ? ledger.epoch(config.bankId, config.apiUrl) : null;
    return {
      bankId: source.bankId,
      endpoint: source.endpoint,
      documentId: source.documentId,
      validatedEpoch: epoch,
      validatedFence: epoch === null ? null : String(epoch),
      revision: /^[a-f0-9]{64}$/.test(source.contentDigest) ? source.contentDigest : null,
      contentDigest: /^[a-f0-9]{64}$/.test(source.contentDigest) ? source.contentDigest : null,
      segmentDigest: segmentDigest && /^[a-f0-9]{64}$/.test(segmentDigest) ? segmentDigest : null,
      validationState,
      correlationId,
    };
  }

  private sourceSetCurrent(sources: readonly SourceExposureRef[], expectedEpoch: string): boolean {
    if (this.evidenceEpoch() !== expectedEpoch || this.ledger?.damaged()) return false;
    const config = this.config;
    const ledger = this.ledger;
    if (!config || !ledger || ledger.bankClearPending(config.bankId, config.apiUrl)) return false;
    return sources.length === 0 || this.sourceExposureCurrent(sources);
  }

  private sameDerivedArtifact(current: DerivedArtifact, next: DerivedArtifactInput): boolean {
    const sources = [...next.sources].sort((a, b) =>
      a.bankId.localeCompare(b.bankId) || a.endpoint.localeCompare(b.endpoint) || a.documentId.localeCompare(b.documentId));
    return current.lifecycleState === 'active'
      && current.kind === next.kind
      && current.target === next.target
      && current.scope === next.scope
      && current.creatorSessionId === next.creatorSessionId
      && current.creatorGenerationId === next.creatorGenerationId
      && current.creatorOperationId === next.creatorOperationId
      && current.bodyDigest === next.bodyDigest
      && current.origin === next.origin
      && current.lineageState === next.lineageState
      && JSON.stringify(current.sources) === JSON.stringify(sources);
  }

  private sameGenerationEvidence(current: GenerationEvidence, next: GenerationEvidenceInput): boolean {
    const sources = [...next.sources].sort((a, b) =>
      a.bankId.localeCompare(b.bankId) || a.endpoint.localeCompare(b.endpoint) || a.documentId.localeCompare(b.documentId));
    return current.sessionId === next.sessionId
      && current.generationId === next.generationId
      && current.providerAttemptId === next.providerAttemptId
      && current.responseId === next.responseId
      && current.toolCorrelationId === next.toolCorrelationId
      && current.origin === next.origin
      && current.mappingState === next.mappingState
      && current.validationReceiptDigest === next.validationReceiptDigest
      && current.exceptionReason === next.exceptionReason
      && current.actualEvidenceUsed === 'unknown'
      && JSON.stringify(current.sources) === JSON.stringify(sources);
  }

  private saveDerivedArtifactCurrent(
    input: DerivedArtifactInput,
    expectedEpoch: string,
    sources: readonly SourceExposureRef[],
    commit?: () => void,
  ): DerivedArtifact | null {
    const store = this.stateStore;
    if (!store) return null;
    return store.transaction(() => {
      if (!this.sourceSetCurrent(sources, expectedEpoch)) return null;
      const current = store.getDerivedArtifact(input.artifactId);
      if (current) {
        if (!this.sameDerivedArtifact(current, input)) return null;
        commit?.();
        return current;
      }
      const saved = store.saveDerivedArtifact(input);
      commit?.();
      return saved;
    });
  }

  async registerDerivedArtifactFromSources(input: DerivedArtifactRegistration): Promise<DerivedArtifact | null> {
    const config = this.config;
    const store = this.stateStore;
    const expectedEpoch = input.expectedEpoch ?? this.evidenceEpoch();
    const sourceIds = [...new Set(input.sourceIds.filter(Boolean))];
    if (!config || !store || !expectedEpoch || sourceIds.length === 0 || !input.content) return null;
    const segments: MemoryEvidenceSegment[] = sourceIds.map((documentId) => ({
      documentId, start: 0, end: input.content.length, derived: true,
    }));
    const evidence = await this.evidenceForSegments(input.content, segments);
    if (evidence.length !== segments.length || this.evidenceEpoch() !== expectedEpoch) return null;
    const dependencies = evidence.map((attachment) => this.dependencyFromExposure(
      attachment,
      attachment.segment.digest,
      input.creatorOperationId ?? input.artifactId,
      expectedEpoch,
    ));
    if (dependencies.some((source) => source.validationState !== 'validated')) return null;
    const bodyDigest = sha256(input.content);
    const at = new Date().toISOString();
    const lineageReceiptDigest = sha256(JSON.stringify([
      input.artifactId, bodyDigest, expectedEpoch, evidence.map(({ bankId, endpoint, documentId, validationReceipt, contentDigest, segment }) =>
        [bankId, endpoint, documentId, validationReceipt, contentDigest, segment.digest]),
    ]));
    const record: DerivedArtifactInput = {
      artifactId: input.artifactId,
      kind: input.kind,
      target: input.target,
      scope: memoryArtifactScope(config.bankId, config.apiUrl),
      creatorSessionId: input.creatorSessionId ?? null,
      creatorGenerationId: input.creatorGenerationId ?? null,
      creatorOperationId: input.creatorOperationId ?? null,
      bodyDigest,
      origin: input.origin,
      reviewState: input.reviewState,
      lifecycleState: 'active',
      lineageState: 'complete',
      lineageReceiptDigest,
      lineageValidatedAt: at,
      statusReason: null,
      createdAt: at,
      updatedAt: at,
      sources: dependencies,
    };
    return this.saveDerivedArtifactCurrent(record, expectedEpoch, evidence);
  }

  registerUnknownDerivedArtifact(input: {
    artifactId: string;
    kind: string;
    target: string;
    content: string;
    origin: DerivedArtifactOrigin;
    reviewState: DerivedArtifactReviewState;
    creatorOperationId: string;
    reason: string;
  }): DerivedArtifact | null {
    const config = this.config;
    const store = this.stateStore;
    if (!config || !store) return null;
    const at = new Date().toISOString();
    const bodyDigest = sha256(input.content);
    const record: DerivedArtifactInput = {
      artifactId: input.artifactId,
      kind: input.kind,
      target: input.target,
      scope: memoryArtifactScope(config.bankId, config.apiUrl),
      creatorSessionId: null,
      creatorGenerationId: null,
      creatorOperationId: input.creatorOperationId,
      bodyDigest,
      origin: input.origin,
      reviewState: input.reviewState,
      lifecycleState: 'withheld',
      lineageState: 'unknown',
      lineageReceiptDigest: null,
      lineageValidatedAt: null,
      statusReason: input.reason,
      createdAt: at,
      updatedAt: at,
      sources: [],
    };
    try {
      return store.transaction(() => {
        const current = store.getDerivedArtifact(input.artifactId);
        if (current) return current.lifecycleState === 'withheld' && current.bodyDigest === bodyDigest ? current : null;
        return store.saveDerivedArtifact(record);
      });
    } catch {
      return null;
    }
  }

  commitHandoffArtifact(input: HandoffArtifactCommit): DerivedArtifact | null {
    const config = this.config;
    const store = this.stateStore;
    if (!config || !store || !input.ownerToken || !input.expectedEpoch || !this.sourceSetCurrent(input.sources, input.expectedEpoch)) return null;
    if (input.mappingState === 'source-independent' && input.sources.length > 0) return null;
    if (input.mappingState === 'complete' && input.sources.length === 0) return null;
    const dependencies = input.sources.map((source) => this.dependencyFromExposure(
      source,
      input.segmentDigests.get(sourceTupleKey(source)) ?? null,
      input.artifactId,
      input.expectedEpoch,
    ));
    if (dependencies.some((source) => source.validationState !== 'validated')) return null;
    const bodyDigest = sha256(input.content);
    const at = new Date().toISOString();
    const receipt = sha256(JSON.stringify([
      input.artifactId, bodyDigest, input.expectedEpoch, input.mappingState,
      input.sources.map((source) => [source.bankId, source.endpoint, source.documentId, source.validationReceipt, source.contentDigest]),
      [...input.segmentDigests.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ]));
    const record: DerivedArtifactInput = {
      artifactId: input.artifactId,
      kind: 'handoff-note',
      target: input.target,
      scope: memoryArtifactScope(config.bankId, config.apiUrl),
      creatorSessionId: null,
      creatorGenerationId: null,
      creatorOperationId: input.ownerToken,
      bodyDigest,
      origin: 'model-derived',
      reviewState: 'unreviewed',
      lifecycleState: 'pending',
      lineageState: input.mappingState,
      lineageReceiptDigest: receipt,
      lineageValidatedAt: at,
      statusReason: 'handoff-awaiting-file-publication',
      createdAt: at,
      updatedAt: at,
      sources: dependencies,
    };
    return store.transaction(() => {
      if (!this.sourceSetCurrent(input.sources, input.expectedEpoch)) return null;
      const current = store.getDerivedArtifact(input.artifactId);
      if (current) {
        return current.kind === record.kind && current.target === record.target && current.scope === record.scope
          && current.creatorOperationId === input.ownerToken && current.bodyDigest === bodyDigest
          && (current.lifecycleState === 'pending' || current.lifecycleState === 'active') ? current : null;
      }
      return store.saveDerivedArtifact(record);
    });
  }

  listHandoffArtifacts(): DerivedArtifact[] {
    const config = this.config;
    const store = this.stateStore;
    if (!config || !store) return [];
    const scope = memoryArtifactScope(config.bankId, config.apiUrl);
    return store.listDerivedArtifacts('handoff-note').filter((artifact) => artifact.scope === scope);
  }

  private handoffArtifactDependenciesCurrent(artifact: DerivedArtifact): boolean {
    const config = this.config;
    const store = this.stateStore;
    const ledger = this.ledger;
    if (!config || !store || !ledger || ledger.damaged() || ledger.bankClearPending(config.bankId, config.apiUrl)
      || artifact.scope !== memoryArtifactScope(config.bankId, config.apiUrl)) return false;
    if (artifact.lineageState === 'source-independent') return artifact.sources.length === 0;
    if (artifact.lineageState !== 'complete' || artifact.sources.length === 0) return false;
    const epoch = ledger.epoch(config.bankId, config.apiUrl);
    return artifact.sources.every((source) => source.validationState === 'validated'
      && source.bankId === config.bankId && source.endpoint === config.apiUrl
      && source.validatedEpoch === epoch && source.validatedFence === String(epoch)
      && !!source.contentDigest && /^[a-f0-9]{64}$/.test(source.contentDigest)
      && !!source.segmentDigest && /^[a-f0-9]{64}$/.test(source.segmentDigest)
      && !ledger.forgotten(source.bankId, source.endpoint, source.documentId)
      && !store.supersededSources(source.bankId, source.endpoint).has(source.documentId)
      && this.sourceVisible(source.documentId) && this.sourceCurrentForContext(source.documentId));
  }

  async verifyPendingHandoffArtifact(artifactId: string, ownerToken: string, content: string): Promise<boolean> {
    const store = this.stateStore;
    const artifact = store?.getDerivedArtifact(artifactId);
    if (!artifact || artifact.kind !== 'handoff-note' || artifact.lifecycleState !== 'pending'
      || artifact.creatorOperationId !== ownerToken || artifact.bodyDigest !== sha256(content)
      || !this.handoffArtifactDependenciesCurrent(artifact)) return false;
    if (artifact.lineageState === 'source-independent') return true;
    const expectedEpoch = this.evidenceEpoch();
    if (!expectedEpoch) return false;
    for (const source of artifact.sources) {
      const exposure = await this.readSourceExposure(source.documentId, expectedEpoch);
      if (!exposure || exposure.attachment.bankId !== source.bankId || exposure.attachment.endpoint !== source.endpoint
        || exposure.attachment.contentDigest !== source.contentDigest || exposure.attachment.revisionState !== 'current'
        || exposure.attachment.validationStatus !== 'validated' || !this.handoffArtifactDependenciesCurrent(artifact)) return false;
    }
    return this.evidenceEpoch() === expectedEpoch && this.handoffArtifactDependenciesCurrent(artifact);
  }

  activateHandoffArtifact(artifactId: string, ownerToken: string): DerivedArtifact | null {
    const store = this.stateStore;
    if (!store) return null;
    return store.transaction(() => {
      const current = store.getDerivedArtifact(artifactId);
      if (!current || current.kind !== 'handoff-note' || current.creatorOperationId !== ownerToken
        || !this.handoffArtifactDependenciesCurrent(current)) return null;
      if (current.lifecycleState === 'active') return current;
      if (current.lifecycleState !== 'pending') return null;
      return store.activateDerivedArtifact(artifactId, ownerToken, new Date().toISOString());
    });
  }

  derivedArtifactIsCurrent(artifactId: string, content: string): boolean {
    const config = this.config;
    const store = this.stateStore;
    const ledger = this.ledger;
    if (!config || !store || !ledger || ledger.damaged() || ledger.bankClearPending(config.bankId, config.apiUrl)) return false;
    const artifact = store.getDerivedArtifact(artifactId);
    if (!artifact || artifact.lifecycleState !== 'active' || artifact.bodyDigest !== sha256(content)
      || artifact.scope !== memoryArtifactScope(config.bankId, config.apiUrl)) return false;
    if (artifact.lineageState === 'source-independent') return artifact.sources.length === 0;
    if (artifact.lineageState !== 'complete' || artifact.sources.length === 0) return false;
    return artifact.sources.every((source) => source.validationState === 'validated'
      && source.bankId === config.bankId && source.endpoint === config.apiUrl
      && !!source.contentDigest && !!source.segmentDigest
      && !ledger.forgotten(source.bankId, source.endpoint, source.documentId)
      && !store.supersededSources(source.bankId, source.endpoint).has(source.documentId));
  }

  async verifyDerivedArtifact(artifactId: string, content: string): Promise<boolean> {
    if (!this.derivedArtifactIsCurrent(artifactId, content)) return false;
    const store = this.stateStore;
    const config = this.config;
    const ledger = this.ledger;
    const artifact = store?.getDerivedArtifact(artifactId);
    const expectedEpoch = this.evidenceEpoch();
    if (!store || !config || !ledger || !artifact || !expectedEpoch) return false;
    if (artifact.lineageState === 'source-independent') return true;
    const segments = artifact.sources.map((source) => ({
      documentId: source.documentId, start: 0, end: content.length, derived: true as const,
    }));
    const evidence = await this.evidenceForSegments(content, segments);
    if (evidence.length !== artifact.sources.length || this.evidenceEpoch() !== expectedEpoch) return false;
    const current = new Map(evidence.map((entry) => [entry.documentId, entry]));
    const matches = artifact.sources.every((source) => {
      const exposure = current.get(source.documentId);
      return !!exposure && exposure.bankId === source.bankId && exposure.endpoint === source.endpoint
        && exposure.contentDigest === source.contentDigest && exposure.segment.digest === source.segmentDigest
        && this.derivedArtifactIsCurrent(artifactId, content);
    });
    return matches && this.evidenceEpoch() === expectedEpoch;
  }

  setDerivedArtifactReviewState(artifactId: string, reviewState: DerivedArtifactReviewState): DerivedArtifact | null {
    const store = this.stateStore;
    return store?.setDerivedArtifactReviewState(artifactId, reviewState, new Date().toISOString()) ?? null;
  }

  derivedArtifact(artifactId: string): DerivedArtifact | null {
    return this.stateStore?.getDerivedArtifact(artifactId) ?? null;
  }

  recordGenerationEvidenceEnvelope(envelope: GenerationEvidenceEnvelope, toolCallId: string): boolean {
    const store = this.stateStore;
    const config = this.config;
    const ledger = this.ledger;
    const expectedEpoch = this.evidenceEpoch();
    if (!store || !config || !ledger || !expectedEpoch || !toolCallId || ledger.damaged()) return false;
    const outputs = envelope.outputToolCalls.filter((output) => output.toolCallId === toolCallId);
    const output = outputs.length === 1 ? outputs[0] : null;
    const joined = !!output && output.joinState === 'matched' && output.responseId === envelope.responseId
      && envelope.responseJoinState === 'matched' && envelope.requestState === 'sent';
    const segmentDigests = new Map<string, string[]>();
    for (const source of envelope.exposedSources) {
      const digests = envelope.items.flatMap((item) => item.spans
        .filter((span) => span.exposedSources.some((candidate) => sourceTupleKey(candidate) === sourceTupleKey(source)))
        .map((span) => span.digest));
      if (digests.length > 0) segmentDigests.set(sourceTupleKey(source), digests);
    }
    const independent = envelope.mappingState === 'complete' && envelope.exposedSources.length === 0 && envelope.items.length > 0
      && envelope.items.every((item) => item.mappingState === 'complete' && item.disposition !== 'unknown-derived-incomplete'
        && item.exposedSources.length === 0
        && item.spans.every((span) => span.mappingState === 'complete' && span.exposedSources.length === 0));
    const sourceBearing = envelope.exposedSources.length > 0 && envelope.mappingState === 'complete'
      && envelope.items.every((item) => item.mappingState === 'complete' && item.disposition !== 'unknown-derived-incomplete')
      && envelope.exposedSources.every((source) => segmentDigests.has(sourceTupleKey(source)))
      && this.sourceExposureCurrent(envelope.exposedSources);
    const mappingState: MemorySourceMappingState = joined && sourceBearing ? 'complete'
      : joined && independent ? 'source-independent'
        : envelope.mappingState === 'ambiguous' || output?.joinState === 'ambiguous' ? 'ambiguous'
          : envelope.mappingState === 'missing' || output?.joinState === 'missing' ? 'missing' : 'unknown';
    const sources = envelope.exposedSources.map((source) => this.dependencyFromExposure(
      source,
      segmentDigests.has(sourceTupleKey(source))
        ? sha256(JSON.stringify([...segmentDigests.get(sourceTupleKey(source))!].sort()))
        : null,
      envelope.id,
      expectedEpoch,
    ));
    const receipt = mappingState === 'complete' || mappingState === 'source-independent'
      ? sha256(JSON.stringify([
          envelope.id, envelope.serializedBodyDigest, envelope.responseId, envelope.providerAttemptId,
          envelope.outputToolCalls.map((entry) => [entry.toolCallId, entry.outputDigest, entry.joinState]).sort(),
          envelope.mappingState, sources.map((source) => [source.bankId, source.endpoint, source.documentId, source.contentDigest, source.segmentDigest]),
        ]))
      : null;
    const record: GenerationEvidenceInput = {
      sessionId: envelope.sessionId,
      generationId: envelope.id,
      providerAttemptId: envelope.providerAttemptId,
      responseId: envelope.responseId,
      toolCorrelationId: sha256(JSON.stringify(envelope.outputToolCalls.map((entry) => entry.toolCallId).sort())),
      origin: 'provider-response',
      mappingState,
      validationReceiptDigest: receipt,
      validatedAt: receipt ? new Date().toISOString() : null,
      exceptionReason: receipt ? null : 'provider generation evidence is incomplete or unjoined',
      actualEvidenceUsed: 'unknown',
      createdAt: new Date().toISOString(),
      sources,
    };
    try {
      return store.transaction(() => {
        if (this.evidenceEpoch() !== expectedEpoch) return false;
        const existing = store.getGenerationEvidence(record.sessionId, record.generationId);
        if (existing) {
          return this.sameGenerationEvidence(existing, record)
            && (existing.mappingState === 'complete' || existing.mappingState === 'source-independent');
        }
        store.saveGenerationEvidence(record);
        return record.mappingState === 'complete' || record.mappingState === 'source-independent';
      });
    } catch {
      return false;
    }
  }

  withdrawDerivedArtifact(artifactId: string, reason: string): DerivedArtifact | null {
    const store = this.stateStore;
    return store?.markDerivedArtifactState(artifactId, 'withdrawn', reason, new Date().toISOString()) ?? null;
  }

  private persistUnknownDerivedArtifact(input: {
    artifactId: string;
    kind: string;
    target: string;
    content: string;
    operationId: string;
    reason: string;
  }): DerivedArtifact | null {
    return this.registerUnknownDerivedArtifact({
      artifactId: input.artifactId,
      kind: input.kind,
      target: input.target,
      content: input.content,
      creatorOperationId: input.operationId,
      reason: input.reason,
      origin: 'model-derived',
      reviewState: 'unknown',
    });
  }

  private forgetDerived(sourceIds: readonly string[]): void {
    const unique = [...new Set(sourceIds.filter(Boolean))];
    if (unique.length === 0) return;
    try { this.lifecycleHooks?.forgetSources(unique); }
    catch (error) { this.log?.warn('[memory] derived state could not be removed after forget', { err: error instanceof Error ? error.message : String(error) }); }
  }

  configure(rootDir: string, log: MemoryLog, overrides?: HindsightFileConfig): void {
    this.config = loadHindsightConfig(rootDir, overrides);
    this.rootDir = rootDir;
    this.log = log;
    this.ready = false;
    this.booting = null;
    this.autostartTried = false;
    this.unavailableUntil = 0;
    this.warnedFullAt = 0;
    this.recallCache.clear();
    this.clearedEpochs.clear();
    this.failedRefreshEpochs.clear();
    this.recallStats = { fast: 0, standard: 0, deep: 0, measured: 0, totalMs: 0 };
    this.lastRecall = null;
    this.lastSourceLookup = null;
    this.lastForgetSourceScan = null;
    this.cacheEpoch += 1;
    this.latestDelivery = null;
    this.briefing = null;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.modelRefreshTimer) {
      clearTimeout(this.modelRefreshTimer);
      this.modelRefreshTimer = null;
    }
    this.modelRefreshAt = 0;
    this.draining = false;
    this.forgetScanDepth = 0;
    this.outbox = null;
    this.ledger = null;
    this.stateStore = null;
    this.storageError = null;
    this.delivery = null;
    this.opsClient = null;
    this.client = null;
    if (!this.config.enabled) return;
    try {
      this.stateStore = openMemoryStateStore(join(rootDir, 'memory-state.sqlite'));
      if (!this.stateStore.imported('outbox-v1') || !this.stateStore.imported('forget-v1')) {
        const legacyForget = readLegacyForget(
          join(rootDir, 'memory-forget.json'),
          join(rootDir, 'memory-deletions.json'),
          log,
        );
        this.stateStore.importLegacy({
          outbox: readLegacyOutbox(join(rootDir, 'memory-outbox.jsonl'), log),
          forget: legacyForget.state,
          forgetDamaged: legacyForget.damaged,
        });
      }
      this.outbox = new MemoryOutbox(this.stateStore, { log });
      this.ledger = new ForgetLedger(this.stateStore, { log });
      this.ledger.damaged();
      this.client = new HindsightClient({
        baseUrl: this.config.apiUrl,
        ...(this.config.apiToken ? { apiKey: this.config.apiToken } : {}),
        userAgent: 'coopanion-memory/0.1',
      });
      this.opsClient = createClient(createConfig({
        baseUrl: this.config.apiUrl,
        headers: this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {},
      }));
    } catch (error) {
      this.storageError = error instanceof Error ? error.message : String(error);
      this.log.warn('[memory] local memory database is unavailable; historical memory remains closed', { message: this.storageError });
      this.stateStore = null;
      this.outbox = null;
      this.ledger = null;
      return;
    }
    this.delivery = new OutboxDelivery(this.outbox, this.deliveryOps(), {
      log,
      target: () => ({ bankId: this.config!.bankId, endpoint: this.config!.apiUrl }),
      forgotten: (item) => !!this.ledger?.damaged() || (this.ledger?.forgotten(
        item.bankId ?? this.config!.bankId,
        item.endpoint ?? this.config!.apiUrl,
        item.documentId,
      ) ?? false),
    });
    this.booting = this.runBootstrap();
    this.startDelivery();
  }

  enabled(): boolean {
    return this.config?.enabled === true
      && this.client !== null
      && this.stateStore !== null
      && this.outbox?.readable() === true
      && this.ledger?.damaged() === false;
  }

  bankId(): string | null {
    return this.config?.bankId ?? null;
  }

  bootstrap(): Promise<void> {
    this.booting ??= this.runBootstrap();
    return this.booting;
  }

  /** Wake the outbox worker; a failed drain leaves items on disk for the next tick. */
  private startDelivery(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = setInterval(() => void this.drain(), 15_000);
    this.drainTimer.unref?.();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.delivery) return;
    this.draining = true;
    try {
      if (!this.canTry() || !await this.ensureStarted()) return;
      const result = await this.delivery.drain();
      if (result.submitted || result.completed || result.verified || result.failed) {
        this.latestDelivery = { at: Date.now(), ...result };
      }
      if (result.verified > 0) {
        this.clearReadCache();
        this.scheduleModelRefresh();
      }
      await this.drainDeletions();
      if (this.derivedBlocked()) await this.clearDerived();
    } catch (err) {
      this.noteFailure('retain', err);
    } finally {
      this.draining = false;
    }
  }

  /** Retry remote deletions for the current bank; tasks for another bank stay pending. */
  private async drainDeletions(): Promise<void> {
    if (!this.ledger || !this.canTry() || !await this.ensureStarted()) return;
    const config = this.config!;
    for (const task of this.ledger.due(new Date(), 8, { bankId: config.bankId, endpoint: config.apiUrl })) {
      if (task.operationId) {
        try {
          const response = await sdk.cancelOperation({
            client: this.opsClient!,
            path: { bank_id: task.bankId, operation_id: task.operationId },
            signal: AbortSignal.timeout(5_000),
          });
          if (response.error) {
            this.log?.warn('[memory] could not cancel a forgotten operation; deleting its document anyway', {
              operation: task.operationId,
              message: this.errorText(response.error),
            });
          }
        } catch (err) {
          // 404/409 means the operation is already terminal; other errors are followed by the
          // document deletion, which is the actual user-visible outcome.
          this.log?.warn('[memory] could not cancel a forgotten operation; deleting its document anyway', {
            operation: task.operationId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        await this.client!.deleteDocument(task.bankId, task.documentId);
        this.ledger.markDone(task.id);
      } catch (err) {
        if (isMissingDelete(err)) this.ledger.markDone(task.id);
        else this.ledger.markFailed(task.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private deliveryOps(): DeliveryOps {
    const config = () => this.config!;
    return {
      retain: async (item: OutboxItem) => {
        try {
          const response = await this.client!.retain(item.bankId ?? config().bankId, item.content, {
            documentId: item.documentId,
            context: item.context,
            tags: item.tags,
            ...(item.metadata ? { metadata: item.metadata } : {}),
            ...(item.timestamp ? { timestamp: item.timestamp } : {}),
            updateMode: 'replace',
            observationScopes: [['scope:life'], ['scope:affection']],
            async: config().retain.async,
            ...(config().retain.async ? { operationId: item.operationId } : {}),
            signal: AbortSignal.timeout(config().retain.async ? 15_000 : 60_000),
          });
          return {
            async: response.async,
            operationId: response.operation_id ?? response.operation_ids?.[0] ?? null,
          };
        } catch (err) {
          const status = err instanceof HindsightError ? err.statusCode : undefined;
          if (status && [400, 401, 403, 409, 413, 422].includes(status)) {
            throw new DeliveryError(err instanceof Error ? err.message : String(err), true);
          }
          throw err;
        }
      },
      status: (item) => this.operationStatus(item),
      verify: async (item) => {
        try {
          const document = await this.client!.getDocument(item.bankId ?? config().bankId, item.documentId, {
            signal: AbortSignal.timeout(5_000),
          });
          return document !== null
            && document.id === item.documentId
            && document.bank_id === (item.bankId ?? config().bankId)
            && (!item.content || document.original_text === item.content);
        } catch (err) {
          if (isMissing(err)) return false;
          throw err;
        }
      },
      retry: async (item) => {
        try {
          const response = await sdk.retryOperation({
            client: this.opsClient!,
            path: { bank_id: item.bankId ?? config().bankId, operation_id: item.operationId },
            signal: AbortSignal.timeout(5_000),
          });
          if (response.error) throw new DeliveryError(this.errorText(response.error));
        } catch (err) {
          const status = err instanceof HindsightError ? err.statusCode : undefined;
          if (status && [400, 404, 409, 422].includes(status)) {
            throw new DeliveryError(err instanceof Error ? err.message : String(err), true);
          }
          throw err;
        }
      },
      cancel: async (item) => {
        const response = await sdk.cancelOperation({
          client: this.opsClient!,
          path: { bank_id: item.bankId ?? config().bankId, operation_id: item.operationId },
          signal: AbortSignal.timeout(5_000),
        });
        if (response.error) throw new DeliveryError(this.errorText(response.error));
      },
    };
  }

  private async operationStatus(item: OutboxItem): Promise<OperationState> {
    const response = await sdk.getOperationStatus({
      client: this.opsClient!,
      path: { bank_id: item.bankId ?? this.config!.bankId, operation_id: item.operationId },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.error) throw new DeliveryError(this.errorText(response.error));
    const status = response.data?.status;
    return status === 'pending' || status === 'processing' || status === 'completed'
      || status === 'failed' || status === 'cancelled'
      ? status
      : 'not_found';
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
    return String(error);
  }

  private async runBootstrap(): Promise<void> {
    if (!this.client || !this.config || this.bootingNow) return;
    this.bootingNow = true;
    try {
      await this.ensureServer();
      await this.ensureBank();
      this.ready = true;
      // A portrait is rebuilt only after the sources behind it are gone from the bank.
      if (this.derivedBlocked()) await this.clearDerived();
      await this.ensureMentalModels();
    } catch (err) {
      this.ready = false;
      this.noteFailure('bootstrap', err);
    } finally {
      this.bootingNow = false;
    }
  }

  private async ensureStarted(): Promise<boolean> {
    if (!this.enabled()) return false;
    if (this.ready) return true;
    if (!this.bootingNow && Date.now() >= this.unavailableUntil) this.booting = this.runBootstrap();
    if (this.booting) await within(this.booting, 2500, undefined);
    return this.ready;
  }

  private noteFailure(where: string, err: unknown): void {
    this.ready = false;
    this.unavailableUntil = Date.now() + 60_000;
    if (Date.now() - this.warnedAt < 60_000) return;
    this.warnedAt = Date.now();
    const message = err instanceof Error ? err.message : String(err);
    this.log?.warn(`[memory] Hindsight ${where} failed; retrying in 60s`, { message });
  }

  private async ensureServer(): Promise<void> {
    const config = this.config;
    if (!config?.enabled || !config.autostart || !config.apiUrl || this.autostartTried) return;
    let host: string;
    try {
      host = new URL(config.apiUrl).hostname;
    } catch {
      return;
    }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return;
    if ((await this.health()).ok) return;
    this.autostartTried = true;
    const port = new URL(config.apiUrl).port || '8888';
    const command = config.autostartCommand?.trim() || defaultHindsightCommand(port);
    const logFile = this.rootDir ? join(this.rootDir, 'hindsight.log') : null;
    let fd: number | null = null;
    try {
      if (logFile) fd = openSync(logFile, 'a');
      const child = spawn(command, {
        shell: true,
        detached: true,
        stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      });
      child.unref();
    } catch (err) {
      this.log?.warn('[memory] could not start Hindsight', { message: err instanceof Error ? err.message : String(err), command });
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if ((await this.health()).ok) return;
    }
    this.log?.warn('[memory] Hindsight autostart did not become healthy', { command });
  }

  private async ensureBank(): Promise<void> {
    const config = this.config!;
    await this.client!.createBank(config.bankId, {
      name: 'Coopanion',
      reflectMission: 'You are Coo, a small desktop companion who lives on the person\'s screen. Reason from the person\'s stable preferences, routines, boundaries and shared history. Be concrete, warm and brief.',
      retainMission: 'Extract durable facts about the person, Coo, and their shared daily life: names, preferences, routines, boundaries, important people, ongoing projects, promises and relationship patterns. Ignore greetings, filler and one-off small talk. Use the context to decide whether a first-person sentence belongs to the person or to Coo.',
      observationsMission: 'Consolidate durable preferences, habits, boundaries, important people, ongoing projects, promises, Coo\'s recurring ways of speaking and acting, and recurring relationship patterns. Drop ephemeral states such as mood-of-the-minute or what was eaten for lunch unless the person made it meaningful.',
      retainExtractionMode: 'concise',
      enableObservations: true,
      dispositionEmpathy: 4,
      dispositionSkepticism: 3,
      dispositionLiteralism: 2,
    });
  }

  private async ensureMentalModels(): Promise<void> {
    const config = this.config!;
    for (const id of MODEL_IDS) {
      let exists = false;
      try {
        const existing = await this.client!.getMentalModel(config.bankId, id, { detail: 'content' });
        exists = true;
        if (existing.content?.trim()) continue;
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      try {
        if (exists) {
          await this.client!.refreshMentalModel(config.bankId, id);
          continue;
        }
        await this.client!.createMentalModel(config.bankId, MODEL_TITLES[id], MODEL_QUERIES[id], {
          id,
          maxTokens: config.portrait.maxTokens,
          trigger: { mode: 'delta', refreshAfterConsolidation: true, minRefreshIntervalSeconds: 3600 },
        });
      } catch (err) {
        this.log?.warn(`[memory] could not prepare mental model ${id}`, { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async sessionBriefing(): Promise<SessionBriefing> {
    if (!this.canTry()) return { text: '', source: 'none' };
    if (!await this.ensureStarted() || this.derivedBlocked()) return { text: '', source: 'none' };
    if (this.briefing && Date.now() - this.briefing.at < 60_000) return this.briefing.value;
    const epoch = this.cacheEpoch;
    const config = this.config!;
    try {
      const models = await within(Promise.all(BRIEFING_MODEL_IDS.map(async (id) => {
        const model = await this.client!.getMentalModel(config.bankId, id, { detail: 'content' });
        return { title: MODEL_TITLES[id], text: model.content ?? '' };
      })), 2500, []);
      if (epoch !== this.cacheEpoch) return { text: '', source: 'none' };
      const portrait = formatPortrait(models, 2400);
      if (portrait) this.persistUnknownDerivedArtifact({
        artifactId: `hindsight-portrait:${sha256(JSON.stringify([config.bankId, config.apiUrl]))}`,
        kind: 'hindsight-mental-models',
        target: 'session-briefing',
        content: portrait,
        operationId: 'hindsight-session-briefing',
        reason: 'Hindsight mental models do not expose a source dependency envelope',
      });
      const fallback = await this.recallBlockDetailed('Who is the person Coo lives with, and what matters to them?', {
        timeoutMs: Math.min(1500, config.recall.timeoutMs),
        maxTokens: 500,
        types: ['observation', 'world'],
      });
      if (epoch !== this.cacheEpoch) return { text: '', source: 'none' };
      if (!fallback.text) return { text: '', source: 'none' };
      const evidence = await this.evidenceForRead(fallback);
      if (epoch !== this.cacheEpoch || evidence.length === 0) return { text: '', source: 'none' };
      const value: SessionBriefing = { text: fallback.text, source: 'recall', evidence };
      this.briefing = { at: Date.now(), value };
      return value;
    } catch (err) {
      this.noteFailure('briefing', err);
      return { text: '', source: 'none' };
    }
  }

  /** Coo's own portrait, for the periodic self-review. Empty when memory is off or the model has no content yet. */
  async selfPortrait(timeoutMs = 2_500): Promise<string> {
    if (!this.canTry()) return '';
    if (!await this.ensureStarted() || this.derivedBlocked()) return '';
    const epoch = this.cacheEpoch;
    try {
      const config = this.config!;
      const model = await within<{ content: string }>(
        this.client!.getMentalModel(config.bankId, SELF_PORTRAIT_MODEL, { detail: 'content' }).then((found) => ({ content: found.content ?? '' })),
        timeoutMs,
        { content: '' },
      );
      const portrait = epoch === this.cacheEpoch ? model.content?.trim() ?? '' : '';
      if (portrait) this.persistUnknownDerivedArtifact({
        artifactId: `hindsight-self-portrait:${sha256(JSON.stringify([config.bankId, config.apiUrl]))}`,
        kind: 'hindsight-self-portrait',
        target: SELF_PORTRAIT_MODEL,
        content: portrait,
        operationId: 'hindsight-self-portrait',
        reason: 'Hindsight mental models do not expose a source dependency envelope',
      });
      return '';
    } catch (err) {
      this.noteFailure('self-portrait', err);
      return '';
    }
  }

  private addActivationWeight(result: MemorySearchResult, now: string): MemorySearchResult {
    const sources = userEventSources(result);
    if (sources.length === 0) return result;
    const config = this.config;
    const store = this.stateStore;
    if (!config || !store) return result;
    const weights: number[] = [];
    try {
      for (const source of sources) {
        const state = store.activationForRetrieval(config.bankId, config.apiUrl, source.documentId, source.date, now);
        if (!state) continue;
        const weight = activationAt({ weight: state.anchorWeight, at: state.anchorAt }, now, {
          halfLifeDays: state.halfLifeDays,
          epsilon: state.epsilon,
        });
        weights.push(weight);
      }
    } catch (error) {
      this.log?.warn('[memory] activation state could not be read during recall', {
        message: error instanceof Error ? error.message : String(error),
      });
      return result;
    }
    return weights.length > 0 ? { ...result, activationWeight: weights.reduce((sum, value) => sum + value, 0) / weights.length } : result;
  }

  private reinforceFromUserTurn(results: readonly MemorySearchResult[], userEventDocumentId: string, userText: string): void {
    const config = this.config;
    const store = this.stateStore;
    if (!config || !store) return;
    const candidate = results
      .filter((result) => typeof result.matchScore === 'number'
        && Number.isFinite(result.matchScore)
        && result.matchScore >= DEFAULT_REINFORCEMENT_PARAMETERS.minimumSemanticMatch)
      .map((result) => ({ result, sources: userEventSources(result) }))
      .find((entry) => entry.sources.length > 0);
    // A result-level match cannot identify which of several supporting user events was mentioned.
    if (!candidate || candidate.sources.length !== 1) return;
    const source = candidate.sources[0];
    if (!source || typeof candidate.result.matchScore !== 'number') return;
    try {
      store.recordUserMention({
        bankId: config.bankId,
        endpoint: config.apiUrl,
        targetDocumentId: source.documentId,
        userEventDocumentId,
        targetCreatedAt: source.date,
        semanticMatch: candidate.result.matchScore,
        intensity: mentionIntensityForText(userText),
      });
    } catch (error) {
      this.log?.warn('[memory] user mention reinforcement could not be saved', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async searchResultsDetailed(query: string, opts: RecallOptions = {}): Promise<MemorySearchRead> {
    const traceItems: MemorySearchTraceItem[] = [];
    let recallTokenBudget: number | undefined;
    let sourceFactsTokenBudget: number | undefined;
    let sourceFactCounts: SourceFactCounts | undefined;
    const finishRead = (results: MemorySearchResult[], status: MemoryReadStatus, sourceFactsTruncated = false): MemorySearchRead => ({
      results,
      status,
      ...(status === 'found' && sourceFactsTruncated ? { sourceFactsTruncated: true } : {}),
      ...(opts.captureTrace ? {
        trace: {
          items: traceItems,
          candidateResultIndexes: traceItems.filter((item) => item.disposition === 'visible').map((item) => item.resultIndex),
          candidateResultIds: traceItems.filter((item) => item.disposition === 'visible').map((item) => item.resultId),
          status,
          sourceFactsTruncated,
          ...(recallTokenBudget === undefined ? {} : { recallTokenBudget }),
          ...(sourceFactsTokenBudget === undefined ? {} : { sourceFactsTokenBudget }),
          ...(sourceFactCounts ? { sourceFactCounts: { ...sourceFactCounts, parsed: new Set(traceItems.flatMap((item) => item.verifiedSources.map((source) => source.sourceFactId))).size } } : {}),
        },
      } : {}),
    });
    if (!query.trim()) return finishRead([], 'absent');
    if (this.forgetScanDepth > 0) return finishRead([], 'fenced');
    if (!this.canTry() || !await this.ensureStarted()) return finishRead([], 'unavailable');
    const epoch = this.cacheEpoch;
    const config = this.config!;
    const timeoutMs = opts.timeoutMs ?? config.recall.timeoutMs;
    const deadline = AbortSignal.timeout(timeoutMs);
    recallTokenBudget = opts.maxTokens ?? config.recall.maxTokens;
    sourceFactsTokenBudget = resolveSourceFactsTokenBudget(opts.maxSourceFactsTokens ?? config.recall.maxSourceFactsTokens);
    try {
      const response = await this.client!.recall(config.bankId, query.slice(0, 1800), {
        types: opts.types ?? config.recall.types,
        maxTokens: recallTokenBudget,
        budget: opts.budget ?? config.recall.budget,
        preferObservations: true,
        includeEntities: false,
        includeSourceFacts: true,
        maxSourceFactsTokens: sourceFactsTokenBudget,
        queryTimestamp: new Date().toISOString(),
        signal: deadline,
      });
      // A forget can invalidate the bank while recall is in flight; discard before reading state or source facts.
      if (epoch !== this.cacheEpoch) return finishRead([], 'fenced');
      const superseded = this.stateStore!.supersededSources(config.bankId, config.apiUrl);
      const currentRevisions = this.stateStore!.currentRevisionSources(config.bankId, config.apiUrl);
      const sourceFactsById = response.source_facts ?? {};
      sourceFactCounts = summarizeSourceFacts(response);
      const sourceFactsTruncated = response.source_facts_truncated === true;
      const unresolved = this.ledger?.unresolved(config.bankId, config.apiUrl) ?? 0;
      const hasFencedSources = this.ledger?.hasFencedSources(config.bankId, config.apiUrl) ?? false;
      let blockedDerivedResults = 0;
      const verifiedSupport = new WeakSet<MemorySearchResult>();
      const traceByMapped = opts.captureTrace ? new Map<MemorySearchResult, MemorySearchTraceItem>() : undefined;
      const results = response.results.flatMap((result, resultIndex): MemorySearchResult[] => {
        const retrievalScores = captureRetrievalScores(result.scores, resultIndex);
        const documentId = result.document_id ?? null;
        const metadata = result.metadata ? { ...result.metadata } : {};
        if (documentId && currentRevisions.has(documentId)) metadata.status = 'current';
        else if (documentId && superseded.has(documentId)) metadata.status = 'superseded';
        const sourceFacts: MemorySearchSourceFact[] = [];
        const sourceFactIds = [...new Set(result.source_fact_ids ?? [])];
        const traceItem: MemorySearchTraceItem | undefined = opts.captureTrace ? {
          resultIndex,
          queryIndex: opts.queryIndex ?? 0,
          resultId: result.id,
          parentDocumentId: documentId,
          declaredSourceFactIds: sourceFactIds,
          verifiedSources: [],
          disposition: 'candidate',
          sourceFactsIncomplete: false,
          retrievalScores,
        } : undefined;
        if (traceItem) traceItems.push(traceItem);
        let missingSourceFact = false;
        let forgottenSupport = false;
        let currentQuestionSupport = false;
        for (const sourceFactId of sourceFactIds) {
          const fact = sourceFactsById[sourceFactId];
          const factDocumentId = fact?.document_id?.trim();
          const text = String(fact?.text ?? '').trim();
          if (!fact || fact.id !== sourceFactId || !factDocumentId || !text) {
            missingSourceFact = true;
            continue;
          }
          if (this.forgottenSource(factDocumentId)) {
            forgottenSupport = true;
            continue;
          }
          if (factDocumentId === opts.userEventDocumentId) {
            currentQuestionSupport = true;
            missingSourceFact = true;
            continue;
          }
          const factMetadata = fact.metadata ? { ...fact.metadata } : {};
          if (!historicalSourceMetadata(factMetadata)) {
            missingSourceFact = true;
            continue;
          }
          if (currentRevisions.has(factDocumentId)) factMetadata.status = 'current';
          else if (superseded.has(factDocumentId)) factMetadata.status = 'superseded';
          sourceFacts.push({
            id: fact.id,
            text,
            type: String(fact.type ?? 'memory'),
            date: String(fact.occurred_start ?? fact.mentioned_at ?? ''),
            documentId: factDocumentId,
            ...(Object.keys(factMetadata).length > 0 ? { metadata: factMetadata } : {}),
          });
          traceItem?.verifiedSources.push({ sourceFactId, documentId: factDocumentId });
        }
        const cannotVerifySupport = sourceFactIds.length > 0 && missingSourceFact && sourceFacts.length === 0;
        // An observation's parent document does not identify the sources it was derived from.
        const unlinkedObservation = result.type === 'observation' && sourceFactIds.length === 0;
        const currentQuestionResult = !!documentId && documentId === opts.userEventDocumentId;
        const missingDirectSource = result.type !== 'observation' && !documentId && sourceFacts.length === 0;
        const unverifiedDirectSource = result.type !== 'observation' && !historicalSourceMetadata(metadata);
        if (traceItem) traceItem.sourceFactsIncomplete = sourceFactIds.length > 0 && missingSourceFact;
        if (forgottenSupport || currentQuestionSupport || currentQuestionResult || cannotVerifySupport
          || unlinkedObservation || missingDirectSource || unverifiedDirectSource) {
          blockedDerivedResults += 1;
          if (traceItem) {
            traceItem.disposition = 'filtered';
            traceItem.reason = forgottenSupport ? 'forgotten-support'
              : currentQuestionSupport || currentQuestionResult ? 'current-question-source'
                : missingDirectSource ? 'missing-source-id'
                  : cannotVerifySupport || unverifiedDirectSource ? 'unverified-source-fact'
                    : 'unlinked-observation';
          }
          return [];
        }
        const sourceFactsIncomplete = sourceFactIds.length > 0 && missingSourceFact;
        const mapped: MemorySearchResult = {
          id: result.id,
          text: String(result.text ?? ''),
          type: String(result.type ?? 'memory'),
          date: String(result.occurred_start ?? result.mentioned_at ?? ''),
          documentId,
          retrievalScores,
          ...(typeof result.scores?.reranker === 'number' && Number.isFinite(result.scores.reranker)
            ? { matchScore: result.scores.reranker }
            : typeof result.scores?.semantic === 'number' && Number.isFinite(result.scores.semantic)
              ? { matchScore: result.scores.semantic }
              : {}),
          ...(result.context ? { context: String(result.context) } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          ...(sourceFacts.length > 0 ? { sourceFacts } : {}),
          ...(sourceFactsIncomplete ? { sourceFactsIncomplete: true } : {}),
          queryIndexes: [opts.queryIndex ?? 0],
        };
        if (sourceFactIds.length > 0 && !missingSourceFact) verifiedSupport.add(mapped);
        if (traceItem) traceByMapped?.set(mapped, traceItem);
        return [mapped];
      });
      // A ledger that cannot be read may be missing tombstones, so no source can be shown clear.
      if (this.ledger?.damaged()) {
        if (opts.captureTrace) {
          for (const item of traceItems) {
            item.disposition = 'fenced';
            item.reason = 'ledger-unreadable';
          }
        }
        return finishRead([], 'fenced', sourceFactsTruncated);
      }
      // A parentless result is visible behind a fence only when every declared source is verified.
      const visible = results.filter((result) => {
        const isVisible = (result.documentId !== null || verifiedSupport.has(result) || (unresolved === 0 && !hasFencedSources))
          && !this.forgottenSource(result.documentId);
        if (opts.captureTrace) {
          const traceItem = traceByMapped?.get(result);
          if (traceItem) {
            traceItem.disposition = isVisible ? 'visible' : 'fenced';
            if (!isVisible) traceItem.reason = 'fence-unresolved';
          }
        }
        return isVisible;
      });
      if (visible.length > 0) {
        const activationNow = new Date().toISOString();
        const weighted = opts.activationEnabled === false ? visible : visible.map((result) => {
          const withWeight = this.addActivationWeight(result, activationNow);
          const traceItem = traceByMapped?.get(result);
          if (traceItem && withWeight.activationWeight !== undefined) traceItem.activationWeight = withWeight.activationWeight;
          return withWeight;
        });
        return finishRead(weighted, 'found', sourceFactsTruncated);
      }
      if (results.length > 0 || response.results.length > 0 || unresolved > 0 || blockedDerivedResults > 0) {
        return finishRead([], hasFencedSources || unresolved > 0 ? 'fenced' : 'incomplete', sourceFactsTruncated);
      }
      return finishRead([], 'absent', sourceFactsTruncated);
    } catch (err) {
      if (!deadline.aborted) this.noteFailure('recall', err);
      return finishRead([], 'unavailable');
    }
  }

  async searchResults(query: string, opts: RecallOptions = {}): Promise<MemorySearchRead['results']> {
    return (await this.searchResultsDetailed(query, opts)).results;
  }

  async recallBlockDetailed(query: string, opts: RecallOptions = {}): Promise<MemoryTextRead> {
    const read = await this.searchResultsDetailed(query, opts);
    if (opts.activationEnabled !== false && opts.userEventDocumentId && read.status === 'found') {
      this.reinforceFromUserTurn(read.results, opts.userEventDocumentId, query);
    }
    return this.formatSearchReadDetailed(read, opts);
  }

  private formatSearchReadDetailed(read: MemorySearchRead, opts: RecallOptions = {}): MemoryTextRead {
    const config = this.config;
    const maxTokens = opts.maxTokens ?? config?.recall.maxTokens ?? 900;
    const maxChars = opts.maxChars ?? recallContextCharBudget(maxTokens, resolveSourceFactsTokenBudget(opts.maxSourceFactsTokens ?? config?.recall.maxSourceFactsTokens));
    const formattedResults = read.results.map((result) => ({
      id: result.id,
      text: result.text,
      type: result.type,
      occurred_start: result.date,
      document_id: result.documentId ?? undefined,
      ...(result.context ? { context: result.context } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(result.sourceFacts ? { sourceFacts: result.sourceFacts } : {}),
      ...(result.sourceFactsIncomplete ? { sourceFactsIncomplete: true } : {}),
      ...(result.activationWeight === undefined ? {} : { activationWeight: result.activationWeight }),
      ...(result.retrievalScores ? { retrievalScores: result.retrievalScores } : {}),
      ...(result.sourceMatchType ? { sourceMatchType: result.sourceMatchType } : {}),
    }));
    const formatOptions = {
      maxChars,
      ...(opts.maxItems === undefined ? {} : { maxItems: opts.maxItems }),
      ...(opts.coverageWeight === undefined ? {} : { coverageWeight: opts.coverageWeight }),
      ...(opts.activationEnabled === false
        ? { activationInfluence: 0 }
        : opts.activationInfluence === undefined ? {} : { activationInfluence: opts.activationInfluence }),
      ...(read.sourceFactsTruncated ? { sourceFactsTruncated: true } : {}),
    };
    if (opts.captureTrace) {
      const formatted = formatRecallDetailed(formattedResults, formatOptions);
      const incomplete = read.sourceFactsTruncated ? { sourceFactsTruncated: true } : {};
      if (!read.trace) return { text: formatted.text, status: formatted.text ? 'found' : read.status, ...incomplete };
      return {
        text: formatted.text,
        status: formatted.text ? 'found' : read.results.length > 0 ? 'absent' : read.status,
        ...incomplete,
        trace: {
          search: read.trace,
          format: formatted.trace,
          maxTokens,
          maxChars,
          ...(read.trace.sourceFactsTokenBudget === undefined ? {} : { sourceFactsTokenBudget: read.trace.sourceFactsTokenBudget }),
          queryAttempts: read.trace.queryAttempts ?? [],
        },
      };
    }
    const text = formatRecall(formattedResults, formatOptions);
    return text
      ? { text, status: 'found', ...(read.sourceFactsTruncated ? { sourceFactsTruncated: true } : {}) }
      : { text: '', status: read.status === 'found' ? 'absent' : read.status, ...(read.sourceFactsTruncated ? { sourceFactsTruncated: true } : {}) };
  }

  async recallBlock(query: string, opts: RecallOptions = {}): Promise<string> {
    return (await this.recallBlockDetailed(query, opts)).text;
  }

  /** Reads original user events selected by Recall, then searches a bounded set of literal topic phrases. */
  async searchSourceDocuments(query: string, opts: {
    excludeDocumentId?: string;
    candidateDocumentIds?: readonly string[];
    fallbackPhrases?: readonly string[];
    candidateOnly?: boolean;
    timeoutMs?: number;
  } = {}): Promise<MemoryTextRead> {
    const started = Date.now();
    const safeQuery = sanitizeForMemory(query);
    const asked = safeQuery.skip ? '' : safeQuery.text.trim().slice(0, 120);
    const phraseCandidates = (opts.fallbackPhrases ?? []).flatMap((candidate) => {
      const safe = sanitizeForMemory(candidate);
      const text = safe.skip ? '' : safe.text.trim();
      return text.length >= 2 ? [text] : [];
    });
    const needleMap = new Map<string, { text: string; type: SourceMatchType }>();
    if (asked) needleMap.set(asked.toLocaleLowerCase(), { text: asked, type: 'query_prefix' });
    for (const text of phraseCandidates) {
      if (!needleMap.has(text.toLocaleLowerCase())) needleMap.set(text.toLocaleLowerCase(), { text, type: 'literal_phrase' });
    }
    const needles = [...needleMap.values()];
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const renderedSourceDocuments: OriginalSourceCandidate[] = [];
    const sourceSegments: MemoryEvidenceSegment[] = [];
    const clippedIds: string[] = [];
    let scannedDocuments = 0, sourceReads = 0, scanIncomplete = false, blocked = false;
    const rejectedSourceDocumentIds = new Set<string>();
    let queryPrefixMatches = 0, phraseMatches = 0, semanticCandidates = 0;
    const queryHashes = needles.map((needle) => digest(needle.text));
    const finish = (text: string, status: MemoryReadStatus, receiptStatus: SourceLookupReceipt['status'] = status): MemoryTextRead => {
      this.lastSourceLookup = {
        at: new Date().toISOString(), queryHash: digest(asked), queryHashes,
        contextHash: digest(text), contextChars: text.length,
        elapsedMs: Date.now() - started, status: receiptStatus,
        sourceDocumentHashes: renderedSourceDocuments.map((source) => digest(source.documentId)),
        clippedSourceDocumentHashes: clippedIds.map(digest),
        scannedDocuments, sourceReads, scanIncomplete,
        queryPrefixMatches, phraseCandidates: phraseMatches, semanticCandidates,
        invalidCandidateHashes: [...rejectedSourceDocumentIds].map((id) => digest(id)),
      };
      return {
        text,
        status,
        ...(renderedSourceDocuments.length ? { sourceDocuments: [...renderedSourceDocuments] } : {}),
        ...(sourceSegments.length ? { sourceSegments: [...sourceSegments] } : {}),
        ...(rejectedSourceDocumentIds.size ? { rejectedSourceDocumentIds: [...rejectedSourceDocumentIds] } : {}),
      };
    };
    if (needles.length === 0 && !(opts.candidateDocumentIds?.length)) return finish('', 'absent');
    if (this.forgetScanDepth > 0) return finish('', 'fenced');
    if (!this.stateStore || !this.outbox?.readable() || !this.ledger || this.ledger.damaged()) return finish('', 'fenced');
    if (!this.canTry() || !await this.ensureStarted()) return finish('', 'unavailable');
    const config = this.config!, epoch = this.cacheEpoch, fence = this.visibilityEpoch();
    const timeoutMs = Math.min(config.recall.timeoutMs, opts.timeoutMs ?? config.recall.timeoutMs);
    if (timeoutMs <= 0) return finish('', 'unavailable');
    const deadline = AbortSignal.timeout(timeoutMs);
    const {
      maxChars, maxDocuments, maxSourceReads, maxSources, pageSize, concurrency,
    } = SOURCE_LOOKUP_LIMITS;
    const header = opts.fallbackPhrases?.length || opts.candidateDocumentIds?.length
      ? SOURCE_LOOKUP_CANDIDATE_HEADER
      : SOURCE_LOOKUP_HEADER;
    const incompleteNotice = SOURCE_LOOKUP_INCOMPLETE_NOTICE;
    let blockedCandidates = false;
    try {
      const superseded = this.stateStore.supersededSources(config.bankId, config.apiUrl);
      const currentRevisions = this.stateStore.currentRevisionSources(config.bankId, config.apiUrl);
      const seen = new Set<string>();
      const listedCandidates: Array<Omit<OriginalSourceCandidate, 'originalText' | 'clipped'>> = [];
      const candidateBodies = new Map<string, { text: string; clipped: boolean }>();
      const recordDocument = (candidateId: string, doc: Awaited<ReturnType<NonNullable<typeof this.client>['getDocument']>> | null, semanticCandidate: boolean): void => {
        if (!doc || doc.id !== candidateId || doc.bank_id !== config.bankId || this.forgottenSource(candidateId)) {
          if (semanticCandidate && !this.forgottenSource(candidateId)) rejectedSourceDocumentIds.add(candidateId);
          return;
        }
        const metadata = (doc.document_metadata ?? {}) as Record<string, string>;
        if (metadata.source_actor !== 'user' || !['event', 'correction'].includes(metadata.kind ?? '')) {
          if (semanticCandidate) rejectedSourceDocumentIds.add(candidateId);
          return;
        }
        const safe = sanitizeForMemory(doc.original_text ?? '');
        if (!safe.text) {
          if (semanticCandidate) rejectedSourceDocumentIds.add(candidateId);
          return;
        }
        const matched = needles.filter((needle) => safe.text.toLocaleLowerCase().includes(needle.text.toLocaleLowerCase()));
        if (!semanticCandidate && matched.length === 0) return;
        const matchType: SourceMatchType = matched.some((needle) => needle.type === 'query_prefix') ? 'query_prefix'
          : matched.length > 0 ? 'literal_phrase' : 'semantic_candidate';
        const state = currentRevisions.has(doc.id) ? 'current' : superseded.has(doc.id) ? 'superseded'
          : typeof metadata.status === 'string' ? metadata.status : 'unknown';
        const recordedAt = typeof metadata.said_at === 'string' ? metadata.said_at : doc.created_at;
        if (matchType === 'semantic_candidate') semanticCandidates += 1;
        else if (matchType === 'query_prefix') queryPrefixMatches += 1;
        else phraseMatches += 1;
        const sourceKind = metadata.kind === 'correction' ? 'correction' : 'event';
        listedCandidates.push({
          documentId: doc.id,
          recordedAt,
          sourceKind,
          recordStatus: state,
          matchType,
          matchChars: matched.reduce((length, needle) => Math.max(length, needle.text.length), 0),
        });
        const bounded = safe.text.slice(0, maxChars);
        candidateBodies.set(doc.id, { text: bounded, clipped: bounded.length < safe.text.length });
      };

      const candidateLimit = opts.candidateOnly ? maxSources : MAX_PRIORITY_SOURCE_DOCUMENTS;
      const prioritizedIds = [...new Set((opts.candidateDocumentIds ?? []).filter((id) => !!id && id !== opts.excludeDocumentId))]
        .slice(0, candidateLimit);
      if ((opts.candidateDocumentIds?.length ?? 0) > prioritizedIds.length) scanIncomplete = true;
      for (let index = 0; index < prioritizedIds.length && sourceReads < maxSourceReads && scannedDocuments < maxDocuments; index += concurrency) {
        const batch = prioritizedIds.slice(index, index + concurrency).filter((id) => !seen.has(id));
        for (const id of batch) { seen.add(id); scannedDocuments += 1; }
        const pending = batch.flatMap((id) => {
          if (this.forgottenSource(id)) { blockedCandidates = true; return []; }
          sourceReads += 1;
          return [this.client!.getDocument(config.bankId, id, { signal: deadline }).then((doc) => ({ id, doc })).catch((err: unknown) => {
            if (err instanceof HindsightError && err.statusCode === 404) {
              rejectedSourceDocumentIds.add(id);
              return { id, doc: null };
            }
            throw err;
          })];
        });
        const documents = await Promise.all(pending);
        if (epoch !== this.cacheEpoch || fence !== this.visibilityEpoch()) return finish('', 'fenced');
        for (const { id, doc } of documents) recordDocument(id, doc, true);
      }

      let offset = 0, total = Infinity;
      let textScanIncomplete = false;
      const shouldScanText = opts.candidateOnly !== true || prioritizedIds.length === 0 || listedCandidates.length === 0;
      const literalCandidateCount = () => listedCandidates.filter((candidate) => candidate.matchType !== 'semantic_candidate').length;
      while (shouldScanText && offset < total && scannedDocuments < maxDocuments && sourceReads < maxSourceReads
        && literalCandidateCount() < maxSources && !deadline.aborted) {
        const limit = Math.min(pageSize, maxDocuments - scannedDocuments);
        const page = await this.client!.listDocuments(config.bankId, { limit, offset, signal: deadline });
        total = page.total;
        offset += page.items.length;
        if (page.items.length === 0) {
          textScanIncomplete = offset < total;
          break;
        }
        let processed = 0;
        for (let index = 0; index < page.items.length; index += concurrency) {
          if (scannedDocuments >= maxDocuments || sourceReads >= maxSourceReads
            || literalCandidateCount() >= maxSources || deadline.aborted) break;
          const pending = page.items.slice(index, index + concurrency).flatMap((candidate) => {
            processed += 1;
            if (seen.has(candidate.id)) return [];
            seen.add(candidate.id);
            scannedDocuments += 1;
            if (candidate.id === opts.excludeDocumentId) return [];
            if (this.forgottenSource(candidate.id)) { blocked = true; return []; }
            if (candidate.bank_id && candidate.bank_id !== config.bankId) return [];
            const preview = candidate.document_metadata as Record<string, string> | undefined;
            if (preview && ((preview.source_actor !== undefined && preview.source_actor !== 'user')
              || (preview.kind !== undefined && !['event', 'correction'].includes(preview.kind)))) return [];
            sourceReads += 1;
            return [this.client!.getDocument(config.bankId, candidate.id, { signal: deadline })
              .then((doc) => ({ id: candidate.id, doc }))
              .catch((err: unknown) => {
                if (err instanceof HindsightError && err.statusCode === 404) {
                  scanIncomplete = true;
                  rejectedSourceDocumentIds.add(candidate.id);
                  return { id: candidate.id, doc: null };
                }
                throw err;
              })];
          });
          const documents = await Promise.all(pending);
          if (epoch !== this.cacheEpoch || fence !== this.visibilityEpoch()) return finish('', 'fenced');
          for (const { id, doc } of documents) recordDocument(id, doc, false);
        }
        textScanIncomplete = offset < total || processed < page.items.length;
        if (processed < page.items.length) break;
      }
      if (deadline.aborted) textScanIncomplete = true;
      scanIncomplete ||= textScanIncomplete;
      if (epoch !== this.cacheEpoch || fence !== this.visibilityEpoch()) return finish('', 'fenced');
      if (listedCandidates.length === 0 && blockedCandidates) return finish('', 'fenced');
      if (listedCandidates.length === 0 && blocked) return finish('', 'fenced');

      const matchPriority: Record<SourceMatchType, number> = { query_prefix: 0, literal_phrase: 1, semantic_candidate: 2 };
      listedCandidates.sort((left, right) => matchPriority[left.matchType] - matchPriority[right.matchType]
        || right.matchChars - left.matchChars);
      const lines = [header];
      let used = header.length;
      for (const candidate of listedCandidates.slice(0, maxSources)) {
        const body = candidateBodies.get(candidate.documentId);
        if (!body) continue;
        const prefix = `\n- (source_id:${candidate.documentId}, recorded_at:${candidate.recordedAt}, actor:user, kind:${candidate.sourceKind}, record_status:${candidate.recordStatus}, match_type:${candidate.matchType}) `;
        const truncationNotice = '\n  [Source excerpt truncated.]';
        const reserve = incompleteNotice.length + 1;
        const remaining = maxChars - used - prefix.length - reserve;
        if (remaining <= truncationNotice.length) { scanIncomplete = true; break; }
        const clipped = body.clipped || body.text.length > remaining;
        const excerpt = clipped ? body.text.slice(0, Math.max(0, remaining - truncationNotice.length)) + truncationNotice : body.text;
        const line = prefix + excerpt;
        if (used + line.length > maxChars - reserve) { scanIncomplete = true; break; }
        const visibleExcerptLength = clipped ? Math.max(0, excerpt.length - truncationNotice.length) : excerpt.length;
        if (visibleExcerptLength > 0) sourceSegments.push({
          documentId: candidate.documentId,
          start: used + prefix.length,
          end: used + prefix.length + visibleExcerptLength,
        });
        lines.push(line);
        used += line.length;
        renderedSourceDocuments.push({ ...candidate, originalText: excerpt, clipped });
        if (clipped) clippedIds.push(candidate.documentId);
      }
      if (renderedSourceDocuments.length > 0) {
        const notice = scanIncomplete ? `\n${incompleteNotice}` : '';
        return finish(lines.join('') + notice, scanIncomplete ? 'incomplete' : 'found');
      }
      if (blockedCandidates || blocked) return finish('', 'fenced');
      return finish(sourceLookupMissNotice(scanIncomplete), 'absent', scanIncomplete ? 'incomplete' : 'absent');
    } catch (err) {
      scanIncomplete = true;
      if (!deadline.aborted) this.noteFailure('source-search', err);
      return finish('', 'unavailable');
    }
  }

  /**
   * One recall for an incoming turn, routed by whether the answer depends on a past fact.
   * Results are cached briefly; explicit memory changes clear the cache.
   */
  async recallForTurn(query: string, context: { userEventDocumentId?: string; activationInfluence?: number; activationEnabled?: boolean; captureTrace?: boolean } = {}): Promise<TurnRecall> {
    const started = Date.now();
    const epoch = this.cacheEpoch;
    const config = this.config;
    const plan = planRecall(query, config ? {
      timeoutMs: config.recall.timeoutMs,
      maxTokens: config.recall.maxTokens,
      maxSourceFactsTokens: config.recall.maxSourceFactsTokens,
      budget: config.recall.budget,
    } : {});
    const finish = (text: string, status: TurnRecallStatus, trace?: MemoryRecallTrace, cacheHit = false, automaticSourceLookup?: SourceLookupReceipt): TurnRecall => {
      this.recallStats[plan.route] += 1;
      if (plan.route !== 'fast') {
        this.recallStats.measured += 1;
        this.recallStats.totalMs += Date.now() - started;
      }
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      this.lastRecall = {
        at: new Date().toISOString(), queryHash: hash(query), contextHash: hash(text), contextChars: text.length,
        route: plan.route, status, elapsedMs: Date.now() - started, cacheHit,
        maxTokens: plan.maxTokens, maxSourceFactsTokens: plan.maxSourceFactsTokens, timeoutMs: plan.timeoutMs, maxChars: plan.maxChars,
        ...(trace?.search.sourceFactCounts ? { sourceFactCounts: trace.search.sourceFactCounts } : {}),
        ...(trace?.queryAttempts.length ? { queryAttempts: trace.queryAttempts } : {}),
        ...(trace ? { serverTruncated: trace.search.sourceFactsTruncated } : {}),
        includedResults: trace?.format.includedResultIds.length ?? 0,
        omittedResults: trace?.format.omittedResultIds.length ?? 0,
        clippedResults: trace?.format.clippedResultIds.length ?? 0,
        includedSourceFactHashes: (trace?.format.includedSourceFactIds ?? []).map(hash),
        includedSourceDocumentHashes: (trace?.format.includedSourceDocumentIds ?? []).map(hash),
        ...(automaticSourceLookup ? {
          automaticSourceLookup: {
            status: automaticSourceLookup.status,
            queryHashes: automaticSourceLookup.queryHashes,
            sourceDocumentHashes: automaticSourceLookup.sourceDocumentHashes,
            scannedDocuments: automaticSourceLookup.scannedDocuments,
            sourceReads: automaticSourceLookup.sourceReads,
            scanIncomplete: automaticSourceLookup.scanIncomplete,
            queryPrefixMatches: automaticSourceLookup.queryPrefixMatches,
            phraseCandidates: automaticSourceLookup.phraseCandidates,
            semanticCandidates: automaticSourceLookup.semanticCandidates,
            invalidCandidateCount: automaticSourceLookup.invalidCandidateHashes.length,
            elapsedMs: automaticSourceLookup.elapsedMs,
          },
        } : {}),
      };
      return {
        text,
        route: plan.route,
        found: status === 'found' && !!text,
        status,
        ...(context.captureTrace && trace ? { trace } : {}),
      };
    };
    if (plan.route === 'fast') return finish('', 'skipped');
    const key = `${config?.bankId ?? ''}|${config?.apiUrl ?? ''}|${this.visibilityEpoch()}|${plan.route}|${context.userEventDocumentId ?? ''}|${context.activationEnabled === false ? 'disabled' : 'enabled'}|${context.activationInfluence ?? 'default'}|${query.trim().toLowerCase().slice(0, 300)}`;
    const cached = !context.captureTrace && plan.route === 'standard' ? this.recallCache.get(key) : undefined;
    if (cached && Date.now() - cached.at < 5 * 60_000) return finish(cached.value, 'found', cached.trace, true);
    if (plan.route === 'standard') {
      const read = await this.recallBlockDetailed(query, {
        budget: plan.budget,
        maxTokens: plan.maxTokens,
        maxSourceFactsTokens: plan.maxSourceFactsTokens,
        timeoutMs: plan.timeoutMs,
        maxChars: plan.maxChars,
        ...(context.activationEnabled === undefined ? {} : { activationEnabled: context.activationEnabled }),
        ...(context.activationInfluence === undefined ? {} : { activationInfluence: context.activationInfluence }),
        captureTrace: true,
        ...(context.userEventDocumentId ? { userEventDocumentId: context.userEventDocumentId } : {}),
      });
      if (epoch !== this.cacheEpoch) return finish('', 'fenced');
      if (read.text) {
        this.recallCache.set(key, { at: Date.now(), value: read.text, trace: read.trace });
        if (this.recallCache.size > 64) {
          const oldest = this.recallCache.keys().next();
          if (!oldest.done) this.recallCache.delete(oldest.value);
        }
      }
      return finish(read.text, read.status, read.trace);
    }
    const queryPlan = planRecallQueries(query);
    const queryAttempts: RecallQueryAttemptTrace[] = [];
    const reads: MemorySearchRead[] = [];
    const queryHash = (value: string) => createHash('sha256').update(value).digest('hex');
    const runRecall = async (
      searchQuery: string,
      queryIndex: number,
      strategy: RecallQueryAttemptTrace['strategy'],
      supplemental: boolean,
    ): Promise<MemorySearchRead> => {
      const elapsedStart = Date.now();
      const remaining = Math.max(0, plan.timeoutMs - (elapsedStart - started));
      if (remaining <= 0) return { results: [], status: 'unavailable' };
      const read = await this.searchResultsDetailed(searchQuery, {
        budget: supplemental ? 'low' : plan.budget,
        maxTokens: supplemental ? Math.min(SUPPLEMENTAL_RECALL_MAX_TOKENS, plan.maxTokens) : plan.maxTokens,
        maxSourceFactsTokens: supplemental
          ? Math.min(SUPPLEMENTAL_SOURCE_FACTS_MAX_TOKENS, plan.maxSourceFactsTokens)
          : plan.maxSourceFactsTokens,
        timeoutMs: remaining,
        ...(context.activationEnabled === undefined ? {} : { activationEnabled: context.activationEnabled }),
        ...(context.activationInfluence === undefined ? {} : { activationInfluence: context.activationInfluence }),
        captureTrace: true,
        ...(context.userEventDocumentId ? { userEventDocumentId: context.userEventDocumentId } : {}),
        queryIndex,
      });
      queryAttempts.push({
        queryHash: queryHash(searchQuery),
        strategy,
        status: read.status,
        elapsedMs: Date.now() - elapsedStart,
        resultCount: read.results.length,
        sourceFactsTruncated: read.sourceFactsTruncated === true,
        ...(read.trace?.recallTokenBudget === undefined ? {} : { recallTokenBudget: read.trace.recallTokenBudget }),
        ...(read.trace?.sourceFactsTokenBudget === undefined ? {} : { sourceFactsTokenBudget: read.trace.sourceFactsTokenBudget }),
      });
      reads.push(read);
      return read;
    };

    const primary = await runRecall(query, 0, 'primary', false);
    if (epoch !== this.cacheEpoch || primary.status === 'fenced') return finish('', 'fenced');
    let merged = mergeRecallReads(reads);
    let evidenceCovered = recallEvidenceCoversQuery(merged, queryPlan.sourcePhrases);
    if (plan.route === 'deep' && !evidenceCovered && primary.status !== 'unavailable') {
      for (const [index, supplementalQuery] of queryPlan.supplementalQueries.entries()) {
        if (index >= MAX_SUPPLEMENTAL_RECALL_QUERIES || Date.now() - started >= plan.timeoutMs) break;
        const read = await runRecall(supplementalQuery, index + 1, index === 0 ? 'topic' : 'phrase', true);
        if (epoch !== this.cacheEpoch || read.status === 'fenced') return finish('', 'fenced');
        merged = mergeRecallReads(reads);
        evidenceCovered = recallEvidenceCoversQuery(merged, queryPlan.sourcePhrases);
        if (read.status === 'unavailable' || evidenceCovered) break;
      }
    }
    merged.trace = merged.trace ? { ...merged.trace, queryAttempts } : undefined;
    if (context.activationEnabled !== false && context.userEventDocumentId && merged.status === 'found') {
      this.reinforceFromUserTurn(merged.results, context.userEventDocumentId, query);
    }
    if (epoch !== this.cacheEpoch) return finish('', 'fenced');

    let automaticSourceLookup: SourceLookupReceipt | undefined;
    let sourceRead: MemoryTextRead | undefined;
    if (plan.route === 'deep' && merged.status !== 'unavailable') {
      const remaining = Math.max(0, plan.timeoutMs - (Date.now() - started));
      sourceRead = await this.searchSourceDocuments(query, {
        ...(context.userEventDocumentId ? { excludeDocumentId: context.userEventDocumentId } : {}),
        candidateDocumentIds: sourceDocumentIdsFromRecall(merged.results, context.userEventDocumentId),
        fallbackPhrases: queryPlan.sourcePhrases,
        ...(evidenceCovered ? { candidateOnly: true } : {}),
        timeoutMs: remaining,
      });
      automaticSourceLookup = this.lastSourceLookup ?? undefined;
      if (epoch !== this.cacheEpoch || sourceRead.status === 'fenced') return finish('', 'fenced', undefined, false, automaticSourceLookup);
      if (sourceRead.rejectedSourceDocumentIds?.length) {
        merged = rejectInvalidSourceCandidates(merged, sourceRead.rejectedSourceDocumentIds);
      }
      if (sourceRead.sourceDocuments?.length) merged = mergeOriginalSources(merged, sourceRead.sourceDocuments);
    }

    let notice = '';
    let status = merged.status;
    if (sourceRead?.rejectedSourceDocumentIds?.length) {
      notice = SOURCE_LOOKUP_INVALID_CANDIDATE_NOTICE;
      status = 'incomplete';
    }
    if (sourceRead?.status === 'absent' || sourceRead?.status === 'incomplete') {
      const sourceNotice = sourceRead.sourceDocuments?.length ? SOURCE_LOOKUP_INCOMPLETE_NOTICE : sourceRead.text;
      notice = [notice, sourceNotice].filter(Boolean).join('\n');
      if ((sourceRead.status === 'incomplete' || automaticSourceLookup?.scanIncomplete)
        && (sourceRead.sourceDocuments?.length || merged.results.length === 0)) status = 'incomplete';
    }
    else if (sourceRead?.status === 'unavailable') {
      notice = [notice, '[memory] The bounded original-source check could not complete. Use only other verified source evidence; this does not mean the record is absent.']
        .filter(Boolean).join('\n');
      if (merged.results.length === 0) status = 'unavailable';
    } else if (sourceRead?.status === 'found' && automaticSourceLookup?.scanIncomplete) {
      notice = [notice, SOURCE_LOOKUP_INCOMPLETE_NOTICE].filter(Boolean).join('\n');
    }
    if (merged.results.length > 0 && sourceRead?.sourceDocuments?.length) {
      status = sourceRead.rejectedSourceDocumentIds?.length || automaticSourceLookup?.scanIncomplete ? 'incomplete' : 'found';
    }
    const formatMaxChars = Math.max(1, plan.maxChars - notice.length - (notice ? 1 : 0));
    const formatted = this.formatSearchReadDetailed(merged, {
      budget: plan.budget,
      maxTokens: plan.maxTokens,
      maxSourceFactsTokens: plan.maxSourceFactsTokens,
      maxChars: formatMaxChars,
      ...(plan.route === 'deep' ? { maxItems: DEEP_RECALL_MAX_ITEMS } : {}),
      ...(context.activationEnabled === undefined ? {} : { activationEnabled: context.activationEnabled }),
      ...(context.activationInfluence === undefined ? {} : { activationInfluence: context.activationInfluence }),
      captureTrace: true,
    });
    const text = [formatted.text, notice].filter(Boolean).join('\n');
    if (formatted.trace && queryAttempts.length > 0) formatted.trace.queryAttempts = queryAttempts;
    return finish(text, status, formatted.trace, false, automaticSourceLookup);
  }

  markRecallInjected(text: string): void {
    if (text && this.lastRecall?.contextHash === createHash('sha256').update(text).digest('hex')) {
      this.lastRecall.injectedAt = new Date().toISOString();
    }
  }

  /** Drop recalled text and the session portrait after an explicit write, forget or bank change. */
  invalidateCache(): void {
    this.cacheEpoch += 1;
    this.clearReadCache();
  }

  /** New verified sources and model refreshes expire caches without revoking visible facts. */
  private clearReadCache(): void {
    this.recallCache.clear();
    this.briefing = null;
  }

  /**
   * No portrait or reflection may be served while a fenced source is still being removed, or while
   * the portraits have not been rebuilt without it. Recall stays available because each result is
   * checked against the fence.
   */
  private derivedBlocked(): boolean {
    if (this.forgetScanDepth > 0) return true;
    const config = this.config;
    const ledger = this.ledger;
    if (!config || !ledger) return false;
    if (ledger.damaged()) return true;
    return ledger.bankClearPending(config.bankId, config.apiUrl)
      || ledger.unresolved(config.bankId, config.apiUrl) > 0
      || ledger.stale(config.bankId, config.apiUrl);
  }

  /** Whether memory is safe to read as a whole: no forget waiting, no portrait older than one. */
  settled(): boolean {
    return !this.derivedBlocked();
  }

  /**
   * Clear every portrait so the next refresh is built from what is left in the bank. Clearing the
   * content is what ends the leak. The bank is released only after every deletion and replacement
   * refresh reaches a successful terminal state.
   */
  private async clearDerived(): Promise<void> {
    const config = this.config;
    const ledger = this.ledger;
    const client = this.client;
    if (!config || !ledger || !client || !this.ready) return;
    if (!ledger.damaged() && ledger.unresolved(config.bankId, config.apiUrl) === 0 && !ledger.stale(config.bankId, config.apiUrl)) return;
    const target = JSON.stringify([config.bankId, config.apiUrl]);
    const epoch = ledger.epoch(config.bankId, config.apiUrl);
    const existing = this.derivedRefreshes.get(target);
    if (existing) {
      await existing.promise.catch(() => {});
      if (ledger.epoch(config.bankId, config.apiUrl) !== epoch) await this.clearDerived();
      return;
    }
    const promise = this.clearDerivedForEpoch(config, ledger, client, target, epoch);
    this.derivedRefreshes.set(target, { epoch, promise });
    try {
      await promise;
    } finally {
      if (this.derivedRefreshes.get(target)?.promise === promise) this.derivedRefreshes.delete(target);
    }
  }

  private async clearDerivedForEpoch(
    config: HindsightConfig,
    ledger: ForgetLedger,
    client: HindsightClient,
    target: string,
    epoch: number,
  ): Promise<void> {
    if (this.failedRefreshEpochs.get(target) === epoch) return;
    // One clear per fence: the drain runs every fifteen seconds, and the content only has to go once.
    if (this.clearedEpochs.get(target) === epoch) {
      if (ledger.unresolved(config.bankId, config.apiUrl) > 0) return;
    } else {
      let cleared = true;
      for (const id of MODEL_IDS) {
        try {
          await client.clearMentalModel(config.bankId, id, { signal: AbortSignal.timeout(8_000) });
        } catch (err) {
          if (!isMissing(err)) cleared = false;
        }
      }
      this.briefing = null;
      if (!cleared) return;
      this.clearedEpochs.set(target, epoch);
      if (ledger.unresolved(config.bankId, config.apiUrl) > 0) return;
    }
    let refreshed = true;
    const deadline = Date.now() + MENTAL_MODEL_REFRESH_TIMEOUT_MS;
    for (const id of MODEL_IDS) {
      try {
        const submission = await client.refreshMentalModel(config.bankId, id, { mode: 'full', signal: AbortSignal.timeout(15_000) });
        if (!submission.operation_id || !await this.waitForMentalModelRefresh(config, submission.operation_id, deadline)) {
          refreshed = false;
        }
      } catch (err) {
        if (!isMissing(err)) refreshed = false;
      }
    }
    if (!refreshed) {
      this.failedRefreshEpochs.set(target, epoch);
      return;
    }
    if (ledger.epoch(config.bankId, config.apiUrl) !== epoch || ledger.unresolved(config.bankId, config.apiUrl) > 0) return;
    if (!ledger.markFresh(config.bankId, config.apiUrl)) {
      this.failedRefreshEpochs.set(target, epoch);
      return;
    }
    this.clearedEpochs.delete(target);
    this.failedRefreshEpochs.delete(target);
  }

  /** Keep portraits blocked until every submitted refresh reaches a successful terminal state. */
  private async waitForMentalModelRefresh(config: HindsightConfig, operationId: string, deadline: number): Promise<boolean> {
    const client = this.opsClient;
    if (!config || !client) return false;
    while (Date.now() < deadline) {
      try {
        const response = await sdk.getOperationStatus({
          client,
          path: { bank_id: config.bankId, operation_id: operationId },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.error && response.data?.status === 'completed') return true;
        if (!response.error && ['failed', 'cancelled', 'not_found'].includes(response.data?.status ?? '')) return false;
        if ([400, 401, 403, 404, 409, 422].includes(response.response?.status ?? 0)) return false;
      } catch {
        // A status read is safe to repeat; the refresh operation itself is never retried here.
      }
      await sleep(MENTAL_MODEL_REFRESH_POLL_MS);
    }
    return false;
  }

  /** Is this source fenced out of this bank's reads? */
  private forgottenSource(documentId: string | null): boolean {
    const config = this.config;
    if (!config || !this.ledger) return false;
    return documentId !== null && this.ledger.forgotten(config.bankId, config.apiUrl, documentId);
  }

  /** A read started under this epoch must not be used once a fence is written. */
  private visibilityEpoch(): number {
    const config = this.config;
    return config && this.ledger ? this.ledger.epoch(config.bankId, config.apiUrl) : 0;
  }

  retainUser(text: string, meta: { session?: string; cursor?: number; timestamp?: string } = {}): string | null {
    const safe = sanitizeForMemory(text);
    const body = safe.text;
    if (!body || safe.skip) return null;
    const session = meta.session ?? 'main';
    const id = meta.cursor === undefined ? hash(body) : String(meta.cursor);
    const saidAt = meta.timestamp ?? new Date().toISOString();
    const documentId = `user:${session}:${id}`;
    const queued = this.enqueue({
      content: `The person said to Coo: ${body.slice(0, 4000)}`,
      documentId,
      context: 'The person is speaking to Coo, a desktop pet. First-person "I" refers to the person.',
      tags: ['scope:life', 'source:chat', `session:${session}`],
      timestamp: meta.timestamp,
      priority: 'normal',
      metadata: sourceMetadata({ actor: 'user', kind: 'event', status: 'completed', saidAt, ...(meta.cursor !== undefined ? { eventId: String(meta.cursor) } : {}) }),
    });
    return queued === 'queued' ? documentId : null;
  }

  retainCoo(
    text: string,
    meta: { session?: string; callId?: string; timestamp?: string } = {},
    envelope?: GenerationEvidenceEnvelope,
  ): void {
    const safe = sanitizeForMemory(text);
    const body = safe.text;
    if (!body || safe.skip) return;
    if (!this.enabled() || !this.stateStore || !this.outbox || !this.config || !this.ledger || this.ledger.damaged()) return;
    const session = meta.session ?? 'main';
    const id = meta.callId ?? hash(body);
    const at = meta.timestamp ?? new Date().toISOString();
    const documentId = `coo:${session}:${id}:${hash(body).slice(0, 8)}`;
    if (this.ledger.forgotten(this.config.bankId, this.config.apiUrl, documentId)) return;
    const outputs = envelope?.outputToolCalls.filter((output) => output.toolCallId === id) ?? [];
    const output = outputs.length === 1 ? outputs[0] : null;
    const requestComplete = !!envelope && !!output && output.joinState === 'matched'
      && output.responseId === envelope.responseId
      && envelope.responseJoinState === 'matched' && envelope.requestState === 'sent'
      && envelope.mappingState === 'complete'
      && envelope.items.length > 0
      && envelope.items.every((item) => item.mappingState === 'complete'
        && item.disposition !== 'unknown-derived-incomplete');
    const exposed = envelope?.exposedSources ?? [];
    const sourceFree = requestComplete && envelope!.mappingState === 'complete' && exposed.length === 0
      && envelope!.items.every((item) => item.mappingState === 'complete' && item.disposition !== 'unknown-derived-incomplete'
        && item.exposedSources.length === 0
        && item.spans.every((span) => span.mappingState === 'complete' && span.exposedSources.length === 0));
    const sourceSegmentDigests = new Map<string, string>();
    for (const source of exposed) {
      const digests = envelope?.items.flatMap((item) => item.spans
        .filter((span) => span.exposedSources.some((candidate) => candidate.bankId === source.bankId
          && candidate.endpoint === source.endpoint && candidate.documentId === source.documentId))
        .map((span) => span.digest)) ?? [];
      if (digests.length > 0) sourceSegmentDigests.set(sourceTupleKey(source), sha256(JSON.stringify([...digests].sort())));
    }
    const sourceBearing = requestComplete && exposed.length > 0
      && exposed.every((source) => sourceSegmentDigests.has(sourceTupleKey(source)))
      && this.sourceExposureCurrent(exposed);
    const mappingState: MemorySourceMappingState = sourceBearing ? 'complete'
      : sourceFree ? 'source-independent'
        : envelope?.mappingState === 'ambiguous' || output?.joinState === 'ambiguous' ? 'ambiguous'
          : envelope?.mappingState === 'missing' || output?.joinState === 'missing' ? 'missing' : 'unknown';
    const generationId = envelope?.id ?? `missing:${id}`;
    const evidenceSources = exposed.map((source) => this.dependencyFromExposure(
      source,
      sourceSegmentDigests.get(sourceTupleKey(source)) ?? null,
      envelope?.id ?? id,
      this.evidenceEpoch() ?? '',
    ));
    const bodyDigest = sha256(body);
    const generationReceiptDigest = mappingState === 'complete' || mappingState === 'source-independent'
      ? sha256(JSON.stringify([
          envelope?.id ?? generationId, envelope?.serializedBodyDigest ?? null, envelope?.responseId ?? null,
          envelope?.providerAttemptId ?? null,
          envelope?.outputToolCalls.map((entry) => [entry.toolCallId, entry.outputDigest, entry.joinState]).sort(), mappingState,
          evidenceSources.map((source) => [source.bankId, source.endpoint, source.documentId, source.contentDigest, source.segmentDigest]),
        ]))
      : null;
    const lineageReceiptDigest = generationReceiptDigest
      ? sha256(JSON.stringify([generationReceiptDigest, output?.outputDigest ?? null, output?.receiptRef ?? null, bodyDigest]))
      : null;
    const generation: GenerationEvidenceInput = {
      sessionId: envelope?.sessionId ?? session,
      generationId,
      providerAttemptId: envelope?.providerAttemptId ?? null,
      responseId: envelope?.responseId ?? output?.responseId ?? null,
      toolCorrelationId: sha256(JSON.stringify(envelope?.outputToolCalls.map((entry) => entry.toolCallId).sort() ?? [id])),
      origin: envelope ? 'provider-response' : 'unknown',
      mappingState,
      validationReceiptDigest: generationReceiptDigest,
      validatedAt: generationReceiptDigest ? at : null,
      exceptionReason: generationReceiptDigest ? null : 'Coo output had no complete joined source envelope',
      actualEvidenceUsed: 'unknown',
      createdAt: at,
      sources: evidenceSources,
    };
    const artifactId = `coo-output:${documentId}`;
    const active = mappingState === 'complete' || mappingState === 'source-independent';
    const artifact: DerivedArtifactInput = {
      artifactId,
      kind: 'coo-output',
      target: documentId,
      scope: memoryArtifactScope(this.config.bankId, this.config.apiUrl),
      creatorSessionId: envelope ? envelope.sessionId : null,
      creatorGenerationId: envelope ? envelope.id : null,
      creatorOperationId: id,
      bodyDigest,
      origin: 'model-derived',
      reviewState: 'unreviewed',
      lifecycleState: active ? 'active' : 'withheld',
      lineageState: mappingState,
      lineageReceiptDigest,
      lineageValidatedAt: lineageReceiptDigest ? at : null,
      statusReason: active ? null : 'Coo output source mapping is incomplete',
      createdAt: at,
      updatedAt: at,
      sources: evidenceSources,
    };
    const item: RetainItem = {
      content: `Coo said to the person: ${body.slice(0, 4000)}`,
      documentId,
      context: 'Coo is speaking to the person. First-person "I" refers to Coo.',
      tags: ['scope:life', 'source:chat', `session:${session}`],
      timestamp: at,
      priority: 'low',
      metadata: {
        ...sourceMetadata({ actor: 'coo', kind: 'event', status: 'completed', saidAt: at }),
        derived_artifact_id: artifactId,
        ...(output?.receiptRef ? { action_receipt_ref: output.receiptRef } : {}),
      },
      bankId: this.config.bankId,
      endpoint: this.config.apiUrl,
    };
    try {
      this.stateStore.transaction(() => {
        if (sourceBearing && !this.sourceExposureCurrent(exposed)) throw new Error('Coo output sources changed before persistence');
        const priorGeneration = this.stateStore!.getGenerationEvidence(generation.sessionId, generation.generationId);
        if (!priorGeneration) this.stateStore!.saveGenerationEvidence(generation);
        else if (!this.sameGenerationEvidence(priorGeneration, generation)) {
          throw new Error('Coo output generation identity conflicts with its persisted evidence');
        }
        const priorArtifact = this.stateStore!.getDerivedArtifact(artifactId);
        if (!priorArtifact) this.stateStore!.saveDerivedArtifact(artifact);
        else if (!this.sameDerivedArtifact(priorArtifact, artifact)) throw new Error('Coo output artifact identity conflicts with persisted provenance');
        if (active) {
          const queued = this.enqueue(item);
          if (queued !== 'queued') throw new Error(`Coo output event was not queued: ${queued}`);
        }
      });
    } catch (error) {
      this.log?.warn('[memory] Coo output provenance could not be committed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Queue an explicit fact. The answer says what happened locally: the service has not confirmed
   * it yet, so a person who needs it kept must be told it is queued, not stored.
   */
  remember(text: string, meta: { session?: string; sourceDocumentId?: string } = {}): 'queued' | 'submitted' | 'unverified' | 'verified' | 'needs-attention' | 'source-missing' | 'empty' | 'sensitive' | 'full' | 'disabled' | 'persistence-error' | 'forgotten' {
    if (this.config?.enabled && (this.storageError || !this.stateStore || !this.outbox || !this.outbox.readable() || !this.ledger || this.ledger.damaged())) {
      return 'persistence-error';
    }
    if (!this.enabled() || !this.outbox) return 'disabled';
    const safe = sanitizeForMemory(text);
    const body = safe.text;
    if (!body) return safe.skip ? 'sensitive' : 'empty';
    const session = meta.session ?? 'main';
    if (meta.sourceDocumentId) {
      if (!this.sourceVisible(meta.sourceDocumentId)) return 'forgotten';
      const state = this.outbox.promoteDocument(meta.sourceDocumentId, this.config!.bankId, this.config!.apiUrl);
      if (!state) return 'source-missing';
      this.invalidateCache();
      if (state === 'verified') return 'verified';
      if (state === 'sent' || state === 'sending') return 'submitted';
      if (state === 'done') return 'unverified';
      if (state === 'dead' || state === 'orphaned' || state === 'cancelled') return 'needs-attention';
      return 'queued';
    }
    const at = new Date().toISOString();
    const queued = this.enqueue({
      content: `The person asked Coo to remember: ${body.slice(0, 4000)}`,
      // The timestamp makes a later, deliberate re-telling a new source instead of a replay of a
      // fenced one.
      documentId: `explicit:${session}:${hash(body)}:${hash(at)}`,
      context: 'The person asked Coo to remember this. It is a fact about the person or their shared life.',
      tags: ['scope:life', 'source:explicit', `session:${session}`],
      priority: 'critical',
      metadata: sourceMetadata({ actor: 'inference', kind: 'fact', status: 'current', saidAt: at }),
    });
    if (queued === 'full') return 'full';
    if (queued === 'persistence-error') return 'persistence-error';
    if (queued === 'skipped') return 'forgotten';
    this.invalidateCache();
    return 'queued';
  }

  async correct(
    text: string,
    sourceIds: readonly string[],
    meta: { session?: string; sourceDocumentId?: string } = {},
  ): Promise<'queued' | 'submitted' | 'unverified' | 'verified' | 'empty' | 'sensitive' | 'full' | 'disabled' | 'persistence-error' | 'forgotten' | 'source-missing' | 'source-unavailable'> {
    if (this.config?.enabled && (this.storageError || !this.stateStore || !this.outbox || !this.outbox.readable() || !this.ledger || this.ledger.damaged())) {
      return 'persistence-error';
    }
    if (!this.enabled() || !this.outbox || !this.config) return 'disabled';
    const safe = sanitizeForMemory(text);
    const body = safe.text;
    if (!body) return safe.skip ? 'sensitive' : 'empty';
    const sources = [...new Set(sourceIds.map((id) => id.trim()).filter(Boolean))];
    if (sources.length === 0 || sources.length > 8) return 'source-missing';
    for (const sourceId of sources) {
      if (!this.sourceVisible(sourceId)) return 'forgotten';
      try {
        if (!await this.hasSource(sourceId) || !this.sourceVisible(sourceId)) return 'source-missing';
      } catch {
        return 'source-unavailable';
      }
    }
    const session = meta.session ?? 'main';
    if (meta.sourceDocumentId) {
      if (!this.sourceVisible(meta.sourceDocumentId)) return 'forgotten';
      const state = this.outbox.linkCorrection(meta.sourceDocumentId, this.config.bankId, this.config.apiUrl, sources);
      if (!state) return 'source-missing';
      this.invalidateCache();
      if (state === 'verified') return 'verified';
      if (state === 'sent' || state === 'sending') return 'submitted';
      if (state === 'done') return 'unverified';
      return 'queued';
    }
    const at = new Date().toISOString();
    const queued = this.enqueue({
      content: `The person corrected a past fact: ${body.slice(0, 4000)}`,
      documentId: `correction:${session}:${hash(body)}:${hash(at)}`,
      context: 'The person explicitly corrected these earlier source records. This is the current account; the earlier records remain available as history.',
      tags: ['scope:life', 'source:correction', `session:${session}`],
      timestamp: at,
      priority: 'critical',
      metadata: sourceMetadata({ actor: 'inference', kind: 'correction', status: 'current', saidAt: at, supersedes: sources }),
    });
    if (queued === 'full') return 'full';
    if (queued === 'persistence-error') return 'persistence-error';
    if (queued === 'skipped') return 'forgotten';
    this.invalidateCache();
    return 'queued';
  }

  retainTouch(touch: { kind?: unknown; count?: unknown; crashed?: unknown }, meta: { session?: string; cursor?: number; at?: string } = {}): void {
    const kind = String(touch.kind ?? 'touch');
    const count = typeof touch.count === 'number' && touch.count > 1 ? ` ×${Math.trunc(touch.count)}` : '';
    const at = meta.at ?? new Date().toISOString();
    const body = `On ${at.slice(0, 10)} the person touched Coo: ${kind}${count}${touch.crashed === true ? ' (crashed)' : ''}.`;
    const safe = sanitizeForMemory(body);
    if (!safe.text || safe.skip) return;
    this.enqueue({
      content: safe.text,
      documentId: `touch:${meta.session ?? 'main'}:${meta.cursor ?? hash(body)}`,
      context: "This is a touch event recorded by the desktop pet app. It is a fact about the person's interaction with Coo.",
      tags: ['scope:affection', 'source:touch', `session:${meta.session ?? 'main'}`],
      timestamp: at,
      priority: 'low',
      metadata: sourceMetadata({ actor: 'user', kind: 'event', status: 'completed', saidAt: at, ...(meta.cursor !== undefined ? { eventId: String(meta.cursor) } : {}) }),
    });
  }

  retainAffinityChange(meta: Record<string, unknown>): void {
    const subject = typeof meta.subject === 'string' || typeof meta.subject === 'number' ? String(meta.subject) : '';
    const score = typeof meta.score === 'number' ? meta.score : null;
    const delta = typeof meta.delta === 'number' ? meta.delta : null;
    const kind = typeof meta.kind === 'string' ? meta.kind : '';
    const reason = typeof meta.reason === 'string' ? meta.reason : '';
    const slot = meta.slot === null ? 'cleared' : typeof meta.slot === 'string' ? meta.slot : '';
    const at = typeof meta.at === 'string' ? meta.at : new Date().toISOString();
    const parts = [`Affinity update${subject ? ` for ${subject}` : ''}: score ${score ?? '?'}`];
    if (delta) parts.push(`${delta > 0 ? '+' : ''}${delta}`);
    if (kind) parts.push(`feeling ${kind}`);
    if (slot) parts.push(`relationship slot ${slot}`);
    if (reason) parts.push(reason);
    const safe = sanitizeForMemory(parts.join('. '));
    if (!safe.text || safe.skip) return;
    this.enqueue({
      content: safe.text,
      documentId: `affinity-change:${subject}:${at}:${hash(safe.text)}`,
      context: 'This is an affinity change recorded by the Coopanion affinity extension. It is a fact about the relationship between the person and Coo.',
      tags: ['scope:affection', 'source:affinity', 'session:main'],
      timestamp: at,
      priority: 'normal',
      metadata: sourceMetadata({ actor: 'affinity', kind: 'event', status: 'completed', saidAt: at }),
    });
  }

  retainJournal(text: string, day: string): void {
    const body = text.trim();
    if (!body) return;
    const safe = sanitizeForMemory(body);
    if (!safe.text || safe.skip) return;
    const documentId = `journal:${day}`;
    this.persistUnknownDerivedArtifact({
      artifactId: `journal-output:${documentId}`,
      kind: 'relationship-journal',
      target: documentId,
      content: safe.text.slice(0, 6000),
      operationId: documentId,
      reason: 'Hindsight reflection output has no source mapping',
    });
  }

  private enqueue(item: RetainItem): 'queued' | 'full' | 'persistence-error' | 'skipped' {
    if (!this.enabled() || !this.outbox || !this.config) return 'skipped';
    // A fenced source never re-enters the bank. A person who changes their mind creates a new
    // event with its own document id, which is not this one.
    if (this.ledger?.forgotten(this.config.bankId, this.config.apiUrl, item.documentId)) return 'skipped';
    const result = this.outbox.add({
      ...item,
      bankId: this.config!.bankId,
      endpoint: this.config!.apiUrl,
    });
    if (result === 'full') {
      if (Date.now() - this.warnedFullAt >= 60_000) {
        this.warnedFullAt = Date.now();
        this.log?.warn('[memory] retain queue is full; the event was not queued', { documentId: item.documentId, priority: item.priority });
      }
      return 'full';
    }
    if (result === 'persistence-error') {
      this.log?.warn('[memory] the event was not queued because the outbox could not be written', { documentId: item.documentId });
      return 'persistence-error';
    }
    void this.drain();
    return 'queued';
  }

  private scheduleModelRefresh(): void {
    if (this.modelRefreshTimer || Date.now() < this.modelRefreshAt) return;
    this.modelRefreshAt = Date.now() + 10 * 60_000;
    this.modelRefreshTimer = setTimeout(() => {
      this.modelRefreshTimer = null;
      void this.refreshEmptyModels();
    }, 20_000);
    this.modelRefreshTimer.unref?.();
  }

  private async refreshEmptyModels(): Promise<void> {
    if (!this.canTry()) return;
    const config = this.config!;
    for (const id of MODEL_IDS) {
      try {
        const model = await this.client!.getMentalModel(config.bankId, id, { detail: 'content' });
        if (!model.content?.trim()) await this.client!.refreshMentalModel(config.bankId, id);
      } catch (err) {
        if (!isMissing(err)) this.log?.warn(`[memory] could not refresh mental model ${id}`, { message: err instanceof Error ? err.message : String(err) });
      }
    }
    this.clearReadCache();
  }

  forgetRecoveryBlocked(): boolean {
    return this.config?.enabled === true && (!!this.storageError || this.ledger?.damaged() === true);
  }

  async forget(query: string): Promise<ForgetResult> {
    const asked = query.trim();
    if (!asked) return { acceptance: 'not-found', local: 0, deleted: 0, pending: 0, failed: 0, activeContextInvalidated: false };
    this.forgetScanDepth += 1;
    this.invalidateCache();
    try {
      return await this.forgetMatching(asked);
    } finally {
      this.forgetScanDepth -= 1;
      this.invalidateCache();
    }
  }

  private async literalSourceDocumentIds(query: string): Promise<{ documentIds: string[]; complete: boolean }> {
    const config = this.config;
    const asked = sanitizeForMemory(query).text.trim();
    const started = Date.now();
    let scanned = 0, reads = 0;
    const documentIds = new Set<string>();
    const finish = (complete: boolean, stopReason: ForgetSourceScanReceipt['stopReason']) => {
      this.lastForgetSourceScan = {
        at: new Date().toISOString(), queryHash: createHash('sha256').update(asked).digest('hex'),
        elapsedMs: Date.now() - started, scannedDocuments: scanned, sourceReads: reads,
        matchedSources: documentIds.size, matchedSourceDocumentHashes: [...documentIds].slice(0, SOURCE_LOOKUP_LIMITS.maxSources)
          .map((id) => createHash('sha256').update(id).digest('hex')),
        complete, stopReason,
      };
      return { documentIds: complete ? [...documentIds] : [], complete };
    };
    if (!config || !this.client) return finish(false, 'unavailable');
    if (asked.length < 3) return finish(true, 'short-query');
    const { pageSize, maxDocuments, concurrency, maxSources } = SOURCE_LOOKUP_LIMITS;
    const maxSourceReads = maxDocuments;
    const deadline = AbortSignal.timeout(config.recall.timeoutMs);
    const seen = new Set<string>();
    let offset = 0, total = Infinity;
    try {
      while (offset < total && offset < maxDocuments && reads < maxSourceReads) {
        const page = await this.client!.listDocuments(config.bankId, {
          limit: Math.min(pageSize, maxDocuments - offset), offset, signal: deadline,
        });
        total = page.total;
        offset += page.items.length;
        if (page.items.length === 0) return finish(offset >= total, offset >= total ? 'complete' : 'empty-page');
        let processed = 0;
        for (let index = 0; index < page.items.length; index += concurrency) {
          if (scanned >= maxDocuments || reads >= maxSourceReads) break;
          const pending = page.items.slice(index, index + concurrency).flatMap((candidate) => {
            if (scanned >= maxDocuments || reads >= maxSourceReads) return [];
            processed += 1;
            if (!candidate.id || seen.has(candidate.id)) return [];
            seen.add(candidate.id);
            scanned += 1;
            if (candidate.bank_id && candidate.bank_id !== config.bankId) return [];
            const metadata = candidate.document_metadata;
            if (metadata && (
              (typeof metadata.source_actor === 'string' && metadata.source_actor !== 'user' && metadata.source_actor !== 'coo')
              || (typeof metadata.kind === 'string' && metadata.kind !== 'event')
            )) return [];
            if (this.forgottenSource(candidate.id)) return [];
            reads += 1;
            return [this.client!.getDocument(config.bankId, candidate.id, { signal: deadline }).then((document) => ({ candidate, document }))];
          });
          const documents = await Promise.all(pending);
          for (const { candidate, document } of documents) {
            if (!document || document.id !== candidate.id || document.bank_id !== config.bankId || this.forgottenSource(document.id)) continue;
            const metadata = document.document_metadata ?? {};
            const actor = metadata.source_actor;
            if ((actor !== 'user' && actor !== 'coo') || metadata.kind !== 'event') continue;
            const safe = sanitizeForMemory(document.original_text ?? '');
            if (safe.text.toLowerCase().includes(asked.toLowerCase())) documentIds.add(document.id);
            if (documentIds.size > maxSources) return finish(false, 'too-many-matches');
          }
        }
        if (processed < page.items.length) return finish(false, reads >= maxSourceReads ? 'read-limit' : 'scan-limit');
        if (offset >= total) return finish(true, 'complete');
        if (scanned >= maxDocuments) return finish(false, 'scan-limit');
        if (reads >= maxSourceReads) return finish(false, 'read-limit');
      }
      return finish(offset >= total, offset >= total ? 'complete' : reads >= maxSourceReads ? 'read-limit' : 'scan-limit');
    } catch (error) {
      if (!deadline.aborted) this.log?.warn('[memory] literal source scan failed during forget', { message: error instanceof Error ? error.message : String(error) });
      return finish(false, deadline.aborted ? 'timeout' : 'service-error');
    }
  }

  private async forgetMatching(asked: string): Promise<ForgetResult> {
    if (this.storageError) return { acceptance: 'unknown-blocked', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    if (!this.config || !this.ledger) return { acceptance: 'not-accepted', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    const outbox = this.outbox;
    const ledger = this.ledger;
    const store = outbox?.stateStore;
    if (!outbox || !store || store !== ledger.stateStore) return { acceptance: 'not-accepted', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    let candidates: OutboxItem[] = [];
    let cancelled: OutboxItem[] = [];
    const sourceIds = new Set<string>();
    let belongsToTarget: (item: OutboxItem) => boolean = () => false;
    let inputs: DeletionInput[] = [];
    const reason = 'the person asked to forget this';
    try {
      const matched = outbox.matching((item) => matchesForget(item, asked));
      const targets = new Map<string, { bankId: string; endpoint: string; documents: Set<string> }>();
      for (const item of matched) {
        if (!item.bankId || !item.endpoint) continue;
        const targetKey = JSON.stringify([item.bankId, item.endpoint]);
        const target = targets.get(targetKey) ?? { bankId: item.bankId, endpoint: item.endpoint, documents: new Set<string>() };
        target.documents.add(item.documentId);
        targets.set(targetKey, target);
      }
      for (const target of targets.values()) {
        let frontier = [...target.documents];
        while (frontier.length > 0) {
          const revisionDependents = store.revisionDependents(target.bankId, target.endpoint, frontier)
            .filter((id) => !target.documents.has(id));
          const outputDependents = frontier.flatMap((sourceId) => store.derivedArtifactsForSource(
            target.bankId, target.endpoint, sourceId,
          )).filter((artifact) => artifact.kind === 'coo-output' && artifact.target.startsWith('coo:'))
            .map((artifact) => artifact.target).filter((id) => !target.documents.has(id));
          const dependents = [...new Set([...revisionDependents, ...outputDependents])];
          for (const dependent of dependents) target.documents.add(dependent);
          frontier = dependents;
        }
      }
      belongsToTarget = (item) => [...targets.values()].some((target) =>
        item.bankId === target.bankId && item.endpoint === target.endpoint && target.documents.has(item.documentId));
      candidates = outbox.matching(belongsToTarget);
      for (const target of targets.values()) {
        for (const documentId of target.documents) {
          sourceIds.add(documentId);
          const inFlight = candidates.find((entry) => entry.bankId === target.bankId
            && entry.endpoint === target.endpoint && entry.documentId === documentId && entry.state !== 'pending');
          inputs.push({
            bankId: target.bankId,
            endpoint: target.endpoint,
            documentId,
            ...(inFlight ? { operationId: inFlight.operationId } : {}),
            reason,
          });
        }
      }
    } catch (error) {
      outbox.reload();
      ledger.reload();
      ledger.markUnavailable('local forget transaction failed; source visibility remains blocked until a fence is committed');
      this.log?.warn('[memory] forget transaction was not committed', { message: error instanceof Error ? error.message : String(error) });
      return { acceptance: 'unknown-blocked', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    }

    const intent = inputs.length > 0 ? ledger.beginIntents(inputs, reason) : null;
    if (!intent && ledger.damaged()) {
      return { acceptance: 'unknown-blocked', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    }
    if (intent && intent.acceptance !== 'accepted') {
      return { acceptance: intent.acceptance, local: 0, deleted: 0, pending: 0, failed: intent.failed, activeContextInvalidated: false };
    }
    const fencedTasks = intent?.tasks ?? [];
    if (intent) {
      try {
        store.transaction(() => {
          cancelled = outbox.cancelMatching(belongsToTarget, reason);
          if (!ledger.finalizeIntents()) throw new Error('the durable forget intent could not be fenced');
        });
      } catch (error) {
        outbox.reload();
        ledger.reload();
        ledger.markUnavailable('durable forget intent awaits fence recovery; Memory remains blocked');
        this.invalidateCache();
        this.log?.warn('[memory] forget fence finalization failed', { message: error instanceof Error ? error.message : String(error) });
        return { acceptance: 'accepted', local: 0, deleted: 0, pending: fencedTasks.length, failed: 0, activeContextInvalidated: false };
      }
    }
    const cancelFailed = Math.max(0, candidates.length - cancelled.length);
    this.invalidateCache();
    this.forgetDerived([...sourceIds]);
    const additional = { local: 0, deleted: 0, pending: 0, failed: 0, accepted: false, unknownBlocked: false };
    if (this.delivery) await this.delivery.cancelForget(candidates);
    if (this.canTry() && await this.ensureStarted()) {
      const config = this.config;
      try {
        const response = await this.client!.recall(config.bankId, asked.slice(0, 800), {
          maxTokens: 1200,
          budget: 'low',
          includeEntities: false,
          signal: AbortSignal.timeout(3000),
        });
        const discovered = response.results
          .map((result) => result.document_id)
          .filter((documentId): documentId is string => typeof documentId === 'string' && documentId.length > 0);
        for (const documentId of discovered) {
          if (sourceIds.has(documentId)) continue;
          const document = await this.client!.getDocument(config.bankId, documentId, { signal: AbortSignal.timeout(3_000) });
          if (!document || document.id !== documentId || document.bank_id !== config.bankId) continue;
          sourceIds.add(documentId);
          const result = await this.forgetDocument(documentId);
          additional.local += result.local;
          additional.deleted += result.deleted;
          additional.pending += result.pending;
          additional.failed += result.failed;
          additional.accepted ||= result.acceptance === 'accepted' || result.acceptance === 'partial';
          additional.unknownBlocked ||= result.acceptance === 'unknown-blocked';
        }
      } catch (err) {
        this.noteFailure('forget', err);
        additional.failed += 1;
      }
    }
    const literal = await this.literalSourceDocumentIds(asked);
    if (!literal.complete) additional.failed += 1;
    else {
      for (const documentId of literal.documentIds) {
        if (sourceIds.has(documentId) || this.forgottenSource(documentId)) continue;
        sourceIds.add(documentId);
        const result = await this.forgetDocument(documentId);
        additional.local += result.local;
        additional.deleted += result.deleted;
        additional.pending += result.pending;
        additional.failed += result.failed;
        additional.accepted ||= result.acceptance === 'accepted' || result.acceptance === 'partial';
        additional.unknownBlocked ||= result.acceptance === 'unknown-blocked';
      }
    }
    if (this.canTry() && await this.ensureStarted()) {
      await this.drainDeletions();
      await this.clearDerived();
    }
    this.forgetDerived([...sourceIds]);
    const outcome = ledger.outcome(fencedTasks.map((task) => task.id));
    const accepted = !!intent || additional.accepted;
    const acceptance = accepted
      ? additional.failed > 0 || !literal.complete ? 'partial' : 'accepted'
      : additional.unknownBlocked ? 'unknown-blocked'
      : additional.failed > 0 || !literal.complete ? 'not-accepted' : 'not-found';
    return {
      acceptance,
      local: cancelled.length + additional.local,
      deleted: outcome.done + additional.deleted,
      pending: outcome.pending + additional.pending,
      failed: outcome.failed + cancelFailed + additional.failed,
      activeContextInvalidated: false,
    };
  }

  private enqueueDeletions(items: Array<{ documentId: string; bankId?: string; endpoint?: string; operationId?: string }>, reason: string): { ids: string[]; failed: number } {
    const ledger = this.ledger;
    if (!ledger) return { ids: [], failed: items.length };
    const result = ledger.addMany(items.map((item) => ({
      bankId: item.bankId ?? this.config!.bankId,
      endpoint: item.endpoint ?? this.config!.apiUrl,
      documentId: item.documentId,
      ...(item.operationId ? { operationId: item.operationId } : {}),
      reason,
    })), reason);
    return { ids: result.tasks.map((task) => task.id), failed: result.failed };
  }

  /** Requeue a dead item after the person fixes the service or authorization. */
  retryDead(id: string): boolean {
    return this.outbox?.retryDead(id) ?? false;
  }

  /**
   * Forget the newest write for a session inside a window, read from the durable queue rather than
   * from a pointer this process happens to hold.
   */
  async forgetMostRecent(session: string, since: Date): Promise<ForgetResult | null> {
    const item = this.outbox?.recentDocument(`user:${session}:`, since);
    if (!item) return null;
    return this.forgetDocument(item.documentId);
  }

  /** Forget exactly one source event; no unrelated recent item is touched. */
  async forgetDocument(documentId: string): Promise<ForgetResult> {
    if (!documentId) return { acceptance: 'not-found', local: 0, deleted: 0, pending: 0, failed: 0, activeContextInvalidated: false };
    if (this.storageError) return { acceptance: 'unknown-blocked', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    if (!this.config || !this.ledger) return { acceptance: 'not-accepted', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    const outbox = this.outbox;
    const ledger = this.ledger;
    const store = outbox?.stateStore;
    if (!outbox || !store || store !== ledger.stateStore) return { acceptance: 'not-accepted', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    const config = this.config;
    let matched: OutboxItem[] = [];
    let cancelled: OutboxItem[] = [];
    let sourceIds = [documentId];
    let target = { bankId: config.bankId, endpoint: config.apiUrl };
    let inputs: DeletionInput[] = [];
    const reason = 'the person asked not to remember this';
    try {
      const direct = outbox.matching((item) => item.documentId === documentId);
      const origin = direct.find((item) => item.bankId && item.endpoint);
      if (origin?.bankId && origin.endpoint) target = { bankId: origin.bankId, endpoint: origin.endpoint };
      const seen = new Set(sourceIds);
      let frontier = [...sourceIds];
      while (frontier.length > 0) {
        const revisionDependents = store.revisionDependents(target.bankId, target.endpoint, frontier)
          .filter((id) => !seen.has(id));
        const outputDependents = frontier.flatMap((sourceId) => store.derivedArtifactsForSource(
          target.bankId, target.endpoint, sourceId,
        )).filter((artifact) => artifact.kind === 'coo-output' && artifact.target.startsWith('coo:'))
          .map((artifact) => artifact.target).filter((id) => !seen.has(id));
        const dependents = [...new Set([...revisionDependents, ...outputDependents])];
        for (const dependent of dependents) seen.add(dependent);
        sourceIds = [...seen];
        frontier = dependents;
      }
      matched = outbox.matching((item) => item.bankId === target.bankId && item.endpoint === target.endpoint && seen.has(item.documentId));
      inputs = sourceIds.map((sourceId) => {
        const inFlight = matched.find((entry) => entry.documentId === sourceId && entry.state !== 'pending');
        return {
          bankId: target.bankId,
          endpoint: target.endpoint,
          documentId: sourceId,
          ...(inFlight ? { operationId: inFlight.operationId } : {}),
          reason,
        };
      });
    } catch (error) {
      outbox.reload();
      ledger.reload();
      ledger.markUnavailable('local forget transaction failed; source visibility remains blocked until a fence is committed');
      this.log?.warn('[memory] source forget transaction was not committed', { message: error instanceof Error ? error.message : String(error) });
      return { acceptance: 'unknown-blocked', local: 0, deleted: 0, pending: 0, failed: 1, activeContextInvalidated: false };
    }
    const intent = ledger.beginIntents(inputs, reason);
    if (intent.acceptance !== 'accepted') {
      return { acceptance: intent.acceptance, local: 0, deleted: 0, pending: 0, failed: intent.failed, activeContextInvalidated: false };
    }
    try {
      store.transaction(() => {
        cancelled = outbox.cancelMatching((item) => item.bankId === target.bankId
          && item.endpoint === target.endpoint && sourceIds.includes(item.documentId), reason);
        if (!ledger.finalizeIntents()) throw new Error('the durable forget intent could not be fenced');
      });
    } catch (error) {
      outbox.reload();
      ledger.reload();
      ledger.markUnavailable('durable forget intent awaits fence recovery; Memory remains blocked');
      this.invalidateCache();
      this.log?.warn('[memory] source forget fence finalization failed', { message: error instanceof Error ? error.message : String(error) });
      return { acceptance: 'accepted', local: 0, deleted: 0, pending: intent.tasks.length, failed: 0, activeContextInvalidated: false };
    }
    const cancelFailed = Math.max(0, matched.length - cancelled.length);
    this.invalidateCache();
    this.forgetDerived(sourceIds);
    if (this.delivery) await this.delivery.cancelForget(matched);
    if (this.canTry() && await this.ensureStarted()) {
      await this.drainDeletions();
      await this.clearDerived();
    }
    const outcome = ledger.outcome(intent.tasks.map((task) => task.id));
    return {
      acceptance: 'accepted',
      local: cancelled.length,
      deleted: outcome.done,
      pending: outcome.pending,
      failed: outcome.failed + cancelFailed,
      activeContextInvalidated: false,
    };
  }

  async reflect(question: string, opts: { tags?: string[]; tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact'; timeoutMs?: number } = {}): Promise<string> {
    return (await this.reflectDetailed(question, opts)).text;
  }

  async reflectDetailed(question: string, opts: { tags?: string[]; tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact'; timeoutMs?: number } = {}): Promise<MemoryTextRead> {
    if (!question.trim()) return { text: '', status: 'absent' };
    if (this.forgetScanDepth > 0 || this.derivedBlocked()) return { text: '', status: 'fenced' };
    if (!this.canTry() || !await this.ensureStarted()) return { text: '', status: 'unavailable' };
    const config = this.config!;
    const epoch = this.cacheEpoch;
    const fence = this.visibilityEpoch();
    try {
      const response = await this.client!.reflect(config.bankId, question.slice(0, 1200), {
        budget: 'mid',
        ...(opts.tags ? { tags: opts.tags } : {}),
        ...(opts.tagsMatch ? { tagsMatch: opts.tagsMatch } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      // The service reasons over the bank as it was when the call started. A forget during the
      // call makes the answer unusable: it may quote or summarise a fenced source.
      if (epoch !== this.cacheEpoch || fence !== this.visibilityEpoch()) return { text: '', status: 'fenced' };
      const text = response.text.trim();
      return text ? { text, status: 'found' } : { text: '', status: 'absent' };
    } catch (err) {
      this.noteFailure('reflect', err);
      return { text: '', status: 'unavailable' };
    }
  }

  async refreshModel(id: string): Promise<void> {
    if (!this.canTry() || !await this.ensureStarted()) return;
    try {
      await this.client!.refreshMentalModel(this.config!.bankId, id);
      this.clearReadCache();
    } catch (err) {
      this.log?.warn(`[memory] could not refresh mental model ${id}`, { message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Does the fence still allow this source to appear in injected text? */
  sourceVisible(documentId: string): boolean {
    const config = this.config;
    const ledger = this.ledger;
    const store = this.stateStore;
    if (!documentId || !this.enabled() || !config || !ledger || !store || ledger.damaged()) return false;
    if (ledger.forgotten(config.bankId, config.apiUrl, documentId)) return false;
    if (documentId.startsWith('coo:')) {
      const artifact = store.getDerivedArtifact(`coo-output:${documentId}`);
      if (!artifact || artifact.lifecycleState !== 'active') return false;
      if (artifact.lineageState === 'source-independent') return artifact.sources.length === 0;
      if (artifact.lineageState !== 'complete' || artifact.sources.length === 0) return false;
      return artifact.sources.every((source) => source.validationState === 'validated'
        && source.bankId === config.bankId && source.endpoint === config.apiUrl
        && !ledger.forgotten(source.bankId, source.endpoint, source.documentId)
        && !store.supersededSources(source.bankId, source.endpoint).has(source.documentId));
    }
    if (documentId.startsWith('journal:')) {
      const artifact = store.getDerivedArtifact(`journal-output:${documentId}`);
      return !!artifact && artifact.lifecycleState === 'active'
        && (artifact.lineageState === 'complete' || artifact.lineageState === 'source-independent');
    }
    return true;
  }

  /** A source used in a derived persona paragraph must not be fenced or superseded in local state. */
  sourceCurrentForContext(documentId: string): boolean {
    const config = this.config;
    const store = this.stateStore;
    if (!this.sourceVisible(documentId) || !config || !store || this.storageError) return false;
    try { return !store.supersededSources(config.bankId, config.apiUrl).has(documentId); }
    catch { return false; }
  }

  /** Rechecks a serialized source set against the active namespace and local Forget fence. */
  sourceExposureCurrent(sources: readonly SourceExposureRef[]): boolean {
    const config = this.config;
    const epoch = this.evidenceEpoch();
    if (!config || !epoch || !this.enabled() || this.ledger?.damaged() || sources.length === 0) return false;
    const current = sources.every((source) => source.bankId === config.bankId
      && source.endpoint === config.apiUrl
      && source.validatedEpoch === epoch
      && source.revisionState === 'current'
      && source.validationStatus === 'validated'
      && /^[a-f0-9]{64}$/.test(source.validationReceipt)
      && /^[a-f0-9]{64}$/.test(source.contentDigest)
      && this.sourceVisible(source.documentId)
      && this.sourceCurrentForContext(source.documentId));
    return current && this.evidenceEpoch() === epoch;
  }

  /** A content-free identity for the configured source namespace used by the partner sidecar. */
  sourceScopeDigest(): string | null {
    const config = this.config;
    return config ? partnerSourceScopeDigest(config.bankId, config.apiUrl) : null;
  }

  /** Whether a persisted forget fence covers this source, independent of whether Memory is enabled. */
  sourceFenced(documentId: string): boolean {
    const config = this.config;
    const ledger = this.ledger;
    return !!documentId && !!config && !!ledger && !ledger.damaged()
      && ledger.forgotten(config.bankId, config.apiUrl, documentId);
  }

  /** Whether the bank still holds this source. Throws when memory cannot be asked at all. */
  async hasSource(documentId: string): Promise<boolean> {
    if (!documentId) return false;
    if (!this.canTry() || !await this.ensureStarted()) throw new Error('long-term memory is unavailable, so the source cannot be checked');
    const config = this.config!;
    if (this.ledger?.forgotten(config.bankId, config.apiUrl, documentId)) return false;
    try {
      const document = await this.client!.getDocument(config.bankId, documentId, { signal: AbortSignal.timeout(5_000) });
      return document !== null;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  /** Read current provenance for a source used to approve or inject a derived policy. */
  async sourceEvidence(documentId: string): Promise<MemorySourceEvidence> {
    if (!documentId) return { present: false, visible: false, actor: null, status: null };
    if (!this.canTry() || !await this.ensureStarted()) throw new Error('long-term memory is unavailable, so the source cannot be checked');
    const config = this.config!;
    if (this.ledger?.damaged() || !this.sourceVisible(documentId)) {
      return { present: false, visible: false, actor: null, status: null };
    }
    try {
      const document = await this.client!.getDocument(config.bankId, documentId, { signal: AbortSignal.timeout(5_000) });
      const visible = this.sourceVisible(documentId) && !this.ledger?.damaged();
      if (!document || document.id !== documentId || document.bank_id !== config.bankId || !visible) {
        return { present: false, visible, actor: null, status: null };
      }
      const metadata = document.document_metadata && typeof document.document_metadata === 'object'
        ? document.document_metadata as Record<string, unknown>
        : {};
      const locallySuperseded = this.stateStore!.supersededSources(config.bankId, config.apiUrl).has(documentId);
      const localCurrent = this.stateStore!.currentRevisionSources(config.bankId, config.apiUrl).has(documentId);
      const kind = typeof metadata.kind === 'string' ? metadata.kind : undefined;
      const occurredAt = typeof metadata.said_at === 'string' ? metadata.said_at : undefined;
      return {
        present: true,
        visible,
        actor: typeof metadata.source_actor === 'string' ? metadata.source_actor : null,
        status: localCurrent ? 'current' : locallySuperseded ? 'superseded'
          : typeof metadata.status === 'string' ? metadata.status : null,
        ...(kind === undefined ? {} : { kind }),
        ...(typeof occurredAt === 'string' ? { occurredAt } : {}),
      };
    } catch (err) {
      if (isMissing(err)) return { present: false, visible: this.sourceVisible(documentId), actor: null, status: null };
      throw err;
    }
  }

  /** A process-local stamp for the bank namespace, read cache and persisted forget epoch. */
  evidenceEpoch(): string | null {
    const config = this.config;
    const ledger = this.ledger;
    const store = this.stateStore;
    if (!config || !ledger || !store || this.storageError || ledger.damaged()) return null;
    try {
      return `${this.cacheEpoch}:${ledger.epoch(config.bankId, config.apiUrl)}`;
    } catch {
      return null;
    }
  }

  /** Re-reads one source before it is attached to context text. */
  private async readSourceExposure(documentId: string, expectedEpoch: string): Promise<MemorySourceExposure | null> {
    if (!documentId || !this.canTry() || !await this.ensureStarted()) return null;
    const config = this.config;
    const client = this.client;
    const store = this.stateStore;
    const ledger = this.ledger;
    const epoch = this.evidenceEpoch();
    if (!config || !client || !store || !ledger || !epoch || epoch !== expectedEpoch || !this.sourceVisible(documentId)) return null;
    const fenceEpoch = this.visibilityEpoch();
    try {
      const document = await client.getDocument(config.bankId, documentId, { signal: AbortSignal.timeout(5_000) });
      if (!document || document.id !== documentId || document.bank_id !== config.bankId
        || typeof document.original_text !== 'string' || !document.original_text
        || this.evidenceEpoch() !== expectedEpoch || fenceEpoch !== this.visibilityEpoch()
        || ledger.damaged() || !this.sourceVisible(documentId)) return null;

      const metadata = document.document_metadata && typeof document.document_metadata === 'object'
        ? document.document_metadata as Record<string, unknown>
        : {};
      const localCurrent = store.currentRevisionSources(config.bankId, config.apiUrl).has(documentId);
      const superseded = store.supersededSources(config.bankId, config.apiUrl).has(documentId)
        || metadata.status === 'superseded';
      const knownStatus = localCurrent || ['current', 'planned', 'completed'].includes(String(metadata.status));
      const revisionState: EvidenceAttachment['revisionState'] = superseded ? 'superseded' : knownStatus ? 'current' : 'unknown';
      const validationStatus: EvidenceAttachment['validationStatus'] = superseded ? 'stale' : knownStatus ? 'validated' : 'unknown';
      const contentDigest = createHash('sha256').update(document.original_text, 'utf8').digest('hex');
      const validationReceipt = createHash('sha256').update(JSON.stringify([
        config.bankId, config.apiUrl, document.id, document.updated_at, document.content_hash,
        contentDigest, expectedEpoch, localCurrent, revisionState, validationStatus,
      ])).digest('hex');
      return {
        attachment: {
          bankId: config.bankId,
          endpoint: config.apiUrl,
          documentId,
          validatedEpoch: expectedEpoch,
          revisionState,
          validationStatus,
          validationReceipt,
          contentDigest,
        },
        originalText: document.original_text,
      };
    } catch {
      return null;
    }
  }

  /** Maps final formatted text ranges to current Hindsight source read-backs. */
  async evidenceForSegments(text: string, segments: readonly MemoryEvidenceSegment[]): Promise<EvidenceAttachment[]> {
    const expectedEpoch = this.evidenceEpoch();
    if (!expectedEpoch || !text || segments.length === 0) return [];
    const readbacks = new Map<string, Promise<MemorySourceExposure | null>>();
    const evidence: EvidenceAttachment[] = [];
    for (const segment of segments) {
      if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end)
        || segment.start < 0 || segment.end <= segment.start || segment.end > text.length || !segment.documentId) continue;
      let readback = readbacks.get(segment.documentId);
      if (!readback) {
        readback = this.readSourceExposure(segment.documentId, expectedEpoch);
        readbacks.set(segment.documentId, readback);
      }
      const source = await readback;
      if (!source) continue;
      const segmentText = text.slice(segment.start, segment.end);
      const sourceText = sanitizeForMemory(source.originalText).text;
      const matched = segment.derived === true
        || canonicalEvidenceText(sourceText).includes(canonicalEvidenceText(segmentText));
      const attachment = source.attachment;
      evidence.push({
        ...attachment,
        ...(matched ? {} : {
          validationStatus: 'unknown' as const,
          validationReceipt: createHash('sha256').update(JSON.stringify([attachment.validationReceipt, 'segment-unmatched'])).digest('hex'),
        }),
        segment: {
          start: segment.start,
          end: segment.end,
          digest: createHash('sha256').update(segmentText, 'utf8').digest('hex'),
        },
      });
    }
    return this.evidenceEpoch() === expectedEpoch ? evidence : [];
  }

  evidenceForRead(read: MemoryTextRead): Promise<EvidenceAttachment[]> {
    const segments = read.sourceSegments ?? read.trace?.format.sourceSegments.map(({ documentId, start, end }) => ({ documentId, start, end })) ?? [];
    return this.evidenceForSegments(read.text, segments);
  }

  async verifyExposureSources(sources: readonly SourceExposureRef[], expectedEpoch: string): Promise<boolean> {
    if (!expectedEpoch || sources.length === 0 || this.evidenceEpoch() !== expectedEpoch) return false;
    for (const source of sources) {
      if (source.validatedEpoch !== expectedEpoch) return false;
      const readback = await this.readSourceExposure(source.documentId, expectedEpoch);
      if (!readback || readback.attachment.bankId !== source.bankId || readback.attachment.endpoint !== source.endpoint
        || readback.attachment.contentDigest !== source.contentDigest || readback.attachment.revisionState !== 'current'
        || readback.attachment.validationStatus !== 'validated') return false;
    }
    return this.evidenceEpoch() === expectedEpoch;
  }

  async recent(limit = 20): Promise<Array<{ id: string; text: string; date: string; type: string; documentId: string | null; status?: string }>> {
    if (this.forgetScanDepth > 0 || !this.canTry() || !await this.ensureStarted()) return [];
    if (this.ledger?.damaged()) return [];
    const config = this.config!;
    const cacheEpoch = this.cacheEpoch;
    const fenceEpoch = this.visibilityEpoch();
    try {
      const response = await this.client!.listMemories(config.bankId, {
        limit: Math.min(100, Math.max(1, Math.round(limit))),
        timeField: 'mentioned_at',
        signal: AbortSignal.timeout(3000),
      });
      if (cacheEpoch !== this.cacheEpoch || fenceEpoch !== this.visibilityEpoch() || this.ledger?.damaged()) return [];
      const unresolved = this.ledger?.unresolved(config.bankId, config.apiUrl) ?? 0;
      const superseded = this.stateStore!.supersededSources(config.bankId, config.apiUrl);
      const currentRevisions = this.stateStore!.currentRevisionSources(config.bankId, config.apiUrl);
      return response.items.map((item) => {
        const documentId = item.document_id ?? null;
        return {
          id: item.id,
          text: String(item.text ?? ''),
          date: String(item.date ?? ''),
          type: String(item.fact_type ?? 'memory'),
          documentId,
          ...(documentId && currentRevisions.has(documentId) ? { status: 'current' }
            : documentId && superseded.has(documentId) ? { status: 'superseded' } : {}),
        };
      }).filter((item) => (item.documentId !== null || unresolved === 0) && !this.forgottenSource(item.documentId));
    } catch (err) {
      this.noteFailure('recent', err);
      return [];
    }
  }

  async status(limit = 20): Promise<{
    enabled: boolean;
    bankId: string | null;
    ok: boolean;
    version?: string;
    error?: string;
    outbox: ReturnType<MemoryOutbox['status']> | null;
    deletions: ReturnType<ForgetLedger['status']> | null;
    forget: { tombstones: number; unresolved: number; stale: boolean; damaged: boolean; sourceScan: ForgetSourceScanReceipt | null } | null;
    lastDelivery: { at: number; submitted: number; completed: number; verified: number; failed: number } | null;
    recall: { fast: number; standard: number; deep: number; measured: number; avgMs: number; last: TurnRecallReceipt | null; sourceLookup: SourceLookupReceipt | null; limits: { timeoutMs?: number; maxSourceFactsTokens: number } };
    recent: Array<{ id: string; text: string; date: string; type: string; documentId: string | null; status?: string }>;
  }> {
    const health = await this.health();
    return {
      enabled: this.enabled(),
      bankId: this.bankId(),
      ok: health.ok,
      ...(health.version ? { version: health.version } : {}),
      ...(health.error ? { error: health.error } : {}),
      outbox: this.outbox?.status() ?? null,
      deletions: this.ledger?.status() ?? null,
      forget: this.config && this.ledger
        ? {
            tombstones: this.ledger.status().tombstones,
            unresolved: this.ledger.unresolved(this.config.bankId, this.config.apiUrl),
            stale: this.ledger.stale(this.config.bankId, this.config.apiUrl),
            damaged: this.ledger.damaged(),
            sourceScan: this.lastForgetSourceScan,
          }
        : null,
      lastDelivery: this.latestDelivery,
      recall: {
        fast: this.recallStats.fast,
        standard: this.recallStats.standard,
        deep: this.recallStats.deep,
        measured: this.recallStats.measured,
        avgMs: this.recallStats.measured > 0 ? Math.round(this.recallStats.totalMs / this.recallStats.measured) : 0,
        last: this.lastRecall,
        sourceLookup: this.lastSourceLookup,
        limits: { timeoutMs: this.config?.recall.timeoutMs, maxSourceFactsTokens: resolveSourceFactsTokenBudget(this.config?.recall.maxSourceFactsTokens) },
      },
      recent: health.ok ? await this.recent(limit) : [],
    };
  }

  async health(): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (this.storageError) return { ok: false, error: `local memory database unavailable: ${this.storageError}` };
    if (!this.config?.enabled) return { ok: false, error: 'disabled' };
    if (!this.enabled()) return { ok: false, error: 'memory storage unavailable' };
    try {
      const version = await this.client!.getVersion({ signal: AbortSignal.timeout(1500) });
      return { ok: true, version: JSON.stringify(version).slice(0, 120) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async clear(): Promise<string> {
    if (!this.enabled()) return 'memory is disabled';
    const config = this.config!;
    const ledger = this.ledger;
    if (!ledger || !ledger.beginClearTarget(config.bankId, config.apiUrl)) {
      return 'long-term memory could not be fenced locally; the bank was not cleared';
    }
    this.invalidateCache();
    const cancelled = this.outbox?.cancelAll('the memory bank was cleared') ?? [];
    if (this.delivery) await this.delivery.cancelForget(cancelled);
    try { this.lifecycleHooks?.clearDerived(); }
    catch (error) { this.log?.warn('[memory] derived state could not be removed after bank clear', { err: error instanceof Error ? error.message : String(error) }); }
    try {
      await this.client!.deleteBank(config.bankId);
    } catch (error) {
      this.ready = false;
      throw error;
    }
    if (!ledger.finishClearTarget(config.bankId, config.apiUrl)) {
      this.ready = false;
      return 'the bank was cleared, but its local fence remains closed';
    }
    this.ready = false;
    this.invalidateCache();
    return 'long-term memory cleared';
  }

  private canTry(): boolean {
    return this.enabled() && Date.now() >= this.unavailableUntil;
  }
}
