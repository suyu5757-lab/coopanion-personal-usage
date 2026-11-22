import { createHash } from 'node:crypto';
import type { MemoryReadStatus, MemorySearchRead, RecallOptions } from './hindsight.ts';
import {
  readVerifiedSourceDomain,
  type SourceDomainConsumerReason,
  type SourceDomainIdentity,
  type TrustedSourceReadbackEvidence,
  type TrustedSourceReadbackProvider,
} from './source-domain-consumer.ts';
import type { SourceDomainReadStore } from './source-domain-read-store.ts';
import { DOMAIN_SUPPLEMENT_SOURCE_FACTS_TOKEN_BUDGET } from './recall-limits.ts';
import type { DomainId, SourceDomainState } from './source-domains.ts';

export interface QueryRelevantReadLimits {
  queryTimeoutMs?: number;
  queryMaxTokens?: number;
  sourceFactsMaxTokens?: number;
  maxSources?: number;
  readbackTimeBudgetMs?: number;
  providerTimeoutMs?: number;
  maxEvidenceChars?: number;
}

export type QueryRelevantSearch = (
  query: string,
  options: RecallOptions,
) => Promise<MemorySearchRead>;

export interface QueryRelevantReadInput {
  query: string;
  bankId: string;
  endpoint: string;
  store: SourceDomainReadStore;
  search: QueryRelevantSearch;
  readbackProvider?: TrustedSourceReadbackProvider | null;
  getEvidenceEpoch: () => string | null;
  limits?: QueryRelevantReadLimits;
  signal?: AbortSignal;
  now?: () => number;
}

export interface QueryRelevantDiscovery {
  resultId: string;
  sourceFactId: string | null;
}

export interface QueryRelevantEvidenceSpan {
  domains: DomainId[];
  start: number;
  end: number;
  digest: string;
  text: string;
  claims: Array<{ domainId: DomainId; claimVerification: 'user_verified' | 'external_unverified' }>;
}

export interface QueryRelevantCandidateSource {
  identity: SourceDomainIdentity;
  discovery: QueryRelevantDiscovery[];
  disposition: 'verified' | 'fallback' | 'withheld' | 'unprocessed';
}

export interface QueryRelevantVerifiedSource {
  identity: SourceDomainIdentity;
  domains: DomainId[];
  sourceEpoch: number;
  sourceRevision: string;
  fingerprint: string;
  sourceVerification: 'verified_domain_readback';
  discovery: QueryRelevantDiscovery[];
  evidence: QueryRelevantEvidenceSpan[];
}

export interface QueryRelevantFallbackSource {
  identity: SourceDomainIdentity;
  domainState: SourceDomainState | 'unindexed';
  sourceVerification: 'verified_exact_readback_fallback';
  reason: 'classification_missing' | 'classification_unassigned' | 'classification_stale';
  discovery: QueryRelevantDiscovery[];
}

export interface QueryRelevantWithheldSource {
  identity: SourceDomainIdentity;
  reason: SourceDomainConsumerReason | 'evidence_missing' | 'evidence_invalid' | 'readback_limit' | 'output_budget';
  discovery: QueryRelevantDiscovery[];
}

export type QueryRelevantReadStatus = 'complete' | 'incomplete' | 'no_candidates' | 'unavailable' | 'fenced';
export type QueryRelevantStopReason =
  | 'invalid_input'
  | 'source_epoch_unavailable'
  | 'query_unavailable'
  | 'query_fenced'
  | 'cancelled'
  | 'index_blocked'
  | 'source_limit'
  | 'readback_budget'
  | 'output_budget'
  | 'query_truncated'
  | 'no_candidates'
  | null;

export interface QueryRelevantReadResult {
  status: QueryRelevantReadStatus;
  complete: boolean;
  queryHash: string;
  candidateDiscovery: 'hindsight_natural_language_recall';
  searchStatus: MemoryReadStatus | null;
  stopReason: QueryRelevantStopReason;
  candidates: QueryRelevantCandidateSource[];
  sources: QueryRelevantVerifiedSource[];
  fallbackSources: QueryRelevantFallbackSource[];
  withheldSources: QueryRelevantWithheldSource[];
  coverage: {
    candidateCount: number;
    processed: number;
    verified: number;
    fallback: number;
    withheld: number;
    excluded: number;
    duplicateReferences: number;
    unprocessed: number;
    sourceFactsTruncated: boolean;
  };
  budget: {
    queryMode: 'low';
    queryTimeoutMs: number;
    queryMaxTokens: number;
    sourceFactsMaxTokens: number;
    maxSources: number;
    readbackTimeBudgetMs: number;
    providerTimeoutMs: number;
    maxEvidenceChars: number;
    readbackCalls: number;
    evidenceChars: number;
    elapsedMs: number;
  };
}

interface NormalizedLimits {
  queryTimeoutMs: number;
  queryMaxTokens: number;
  sourceFactsMaxTokens: number;
  maxSources: number;
  readbackTimeBudgetMs: number;
  providerTimeoutMs: number;
  maxEvidenceChars: number;
}

interface Candidate {
  identity: SourceDomainIdentity;
  discovery: QueryRelevantDiscovery[];
  discoveryKeys: Set<string>;
}

const DEFAULT_LIMITS: NormalizedLimits = {
  queryTimeoutMs: 8_000,
  queryMaxTokens: 600,
  sourceFactsMaxTokens: DOMAIN_SUPPLEMENT_SOURCE_FACTS_TOKEN_BUDGET,
  maxSources: 50,
  readbackTimeBudgetMs: 8_000,
  providerTimeoutMs: 1000,
  maxEvidenceChars: 6000,
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function normalizeLimits(limits: QueryRelevantReadLimits | undefined): NormalizedLimits | null {
  const queryTimeoutMs = boundedInteger(limits?.queryTimeoutMs, DEFAULT_LIMITS.queryTimeoutMs, 100, 10_000);
  const queryMaxTokens = boundedInteger(limits?.queryMaxTokens, DEFAULT_LIMITS.queryMaxTokens, 100, 2000);
  const sourceFactsMaxTokens = boundedInteger(
    limits?.sourceFactsMaxTokens,
    DEFAULT_LIMITS.sourceFactsMaxTokens,
    128,
    DOMAIN_SUPPLEMENT_SOURCE_FACTS_TOKEN_BUDGET,
  );
  const maxSources = boundedInteger(limits?.maxSources, DEFAULT_LIMITS.maxSources, 1, 50);
  const readbackTimeBudgetMs = boundedInteger(limits?.readbackTimeBudgetMs, DEFAULT_LIMITS.readbackTimeBudgetMs, 1, 10_000);
  const providerTimeoutMs = boundedInteger(limits?.providerTimeoutMs, DEFAULT_LIMITS.providerTimeoutMs, 1, 5000);
  const maxEvidenceChars = boundedInteger(limits?.maxEvidenceChars, DEFAULT_LIMITS.maxEvidenceChars, 1, 12_000);
  if ([queryTimeoutMs, queryMaxTokens, sourceFactsMaxTokens, maxSources, readbackTimeBudgetMs, providerTimeoutMs, maxEvidenceChars]
    .some((value) => value === null)) return null;
  return {
    queryTimeoutMs: queryTimeoutMs!,
    queryMaxTokens: queryMaxTokens!,
    sourceFactsMaxTokens: sourceFactsMaxTokens!,
    maxSources: maxSources!,
    readbackTimeBudgetMs: readbackTimeBudgetMs!,
    providerTimeoutMs: providerTimeoutMs!,
    maxEvidenceChars: maxEvidenceChars!,
  };
}

function tupleKey(identity: SourceDomainIdentity): string {
  return JSON.stringify([identity.bankId, identity.endpoint, identity.documentId]);
}

function eligibleForExactUserReadback(metadata: Record<string, string> | undefined, documentId: string): boolean {
  return !documentId.startsWith('coo-growth:')
    && (metadata?.source_actor === undefined || metadata.source_actor === 'user')
    && (metadata?.kind === undefined || metadata.kind === 'event' || metadata.kind === 'correction')
    && (metadata?.status === undefined || metadata.status === 'current' || metadata.status === 'completed');
}

function emptyResult(
  queryHash: string,
  limits: NormalizedLimits,
  status: QueryRelevantReadStatus,
  stopReason: QueryRelevantStopReason,
  startedAt: number,
  now: () => number,
  searchStatus: MemoryReadStatus | null = null,
): QueryRelevantReadResult {
  return {
    status,
    complete: status === 'complete',
    queryHash,
    candidateDiscovery: 'hindsight_natural_language_recall',
    searchStatus,
    stopReason,
    candidates: [],
    sources: [],
    fallbackSources: [],
    withheldSources: [],
    coverage: {
      candidateCount: 0,
      processed: 0,
      verified: 0,
      fallback: 0,
      withheld: 0,
      excluded: 0,
      duplicateReferences: 0,
      unprocessed: 0,
      sourceFactsTruncated: false,
    },
    budget: {
      queryMode: 'low',
      queryTimeoutMs: limits.queryTimeoutMs,
      queryMaxTokens: limits.queryMaxTokens,
      sourceFactsMaxTokens: limits.sourceFactsMaxTokens,
      maxSources: limits.maxSources,
      readbackTimeBudgetMs: limits.readbackTimeBudgetMs,
      providerTimeoutMs: limits.providerTimeoutMs,
      maxEvidenceChars: limits.maxEvidenceChars,
      readbackCalls: 0,
      evidenceChars: 0,
      elapsedMs: Math.max(0, now() - startedAt),
    },
  };
}

function addCandidate(
  candidates: Map<string, Candidate>,
  identity: SourceDomainIdentity,
  discovery: QueryRelevantDiscovery,
): boolean {
  const key = tupleKey(identity);
  const candidate = candidates.get(key) ?? { identity, discovery: [], discoveryKeys: new Set<string>() };
  const discoveryKey = JSON.stringify([discovery.resultId, discovery.sourceFactId]);
  const duplicateReference = candidates.has(key);
  if (!candidate.discoveryKeys.has(discoveryKey)) {
    candidate.discoveryKeys.add(discoveryKey);
    candidate.discovery.push(discovery);
  }
  candidates.set(key, candidate);
  return duplicateReference;
}

function discoveriesOf(result: Candidate): QueryRelevantDiscovery[] {
  return result.discovery.map(({ resultId, sourceFactId }) => ({ resultId, sourceFactId }));
}

async function exactFallbackReadback(
  provider: TrustedSourceReadbackProvider | null | undefined,
  identity: SourceDomainIdentity,
  externalSignal: AbortSignal | undefined,
  now: () => number,
  deadlineAt: number,
  timeoutMs: number,
): Promise<{ evidence: TrustedSourceReadbackEvidence | null; reason: SourceDomainConsumerReason | null }> {
  if (!provider) return { evidence: null, reason: 'provider_missing' };
  if (externalSignal?.aborted) return { evidence: null, reason: 'cancelled' };
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
    onAbort = () => resolve({ kind: 'aborted' });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const request = provider(identity, {
    signal,
    deadlineAt: Math.min(deadlineAt, now() + timeoutMs),
  }).then(
    (evidence) => ({ kind: 'resolved' as const, evidence }),
    () => ({ kind: 'failed' as const }),
  );
  const outcome = await Promise.race([request, aborted]);
  if (onAbort) signal.removeEventListener('abort', onAbort);
  if (outcome.kind === 'aborted') {
    return { evidence: null, reason: externalSignal?.aborted ? 'cancelled' : 'provider_timeout' };
  }
  if (outcome.kind === 'failed') return { evidence: null, reason: 'provider_error' };
  const evidence = outcome.evidence;
  if (!evidence) return { evidence: null, reason: 'record_missing' };
  if (evidence.bankId !== identity.bankId || evidence.endpoint !== identity.endpoint
    || evidence.documentId !== identity.documentId) return { evidence: null, reason: 'identity_mismatch' };
  if (evidence.sourceActor !== 'user') return { evidence: null, reason: 'actor_invalid' };
  if (evidence.sourceKind !== 'event' && evidence.sourceKind !== 'correction') return { evidence: null, reason: 'kind_invalid' };
  if (evidence.sourceStatus !== 'current' && evidence.sourceStatus !== 'completed') {
    return { evidence: null, reason: 'status_invalid' };
  }
  if (!evidence.content.trim()) return { evidence: null, reason: 'content_empty' };
  if (!Number.isSafeInteger(evidence.sourceEpoch) || evidence.sourceEpoch < 0) {
    return { evidence: null, reason: 'epoch_mismatch' };
  }
  if (evidence.sourceRevision && evidence.sourceRevision !== sha256(evidence.content)) {
    return { evidence: null, reason: 'revision_mismatch' };
  }
  return { evidence, reason: null };
}

function evidenceSpans(
  evidence: TrustedSourceReadbackEvidence,
  confirmedDomains: readonly DomainId[],
  classification: QueryRelevantVerifiedSource['identity'] & {
    links: Array<{
      domainId: DomainId;
      linkState: string;
      claimVerification: 'user_verified' | 'external_unverified';
      evidenceStart: number | null;
      evidenceEnd: number | null;
      evidenceDigest: string | null;
    }>;
  },
): QueryRelevantEvidenceSpan[] | null {
  const groups = new Map<string, QueryRelevantEvidenceSpan>();
  for (const domainId of confirmedDomains) {
    const link = classification.links.find((item) => item.domainId === domainId && item.linkState === 'confirmed');
    if (!link || !Number.isInteger(link.evidenceStart) || !Number.isInteger(link.evidenceEnd)
      || link.evidenceStart! < 0 || link.evidenceEnd! <= link.evidenceStart!
      || link.evidenceEnd! > evidence.content.length || !link.evidenceDigest) return null;
    const text = evidence.content.slice(link.evidenceStart!, link.evidenceEnd!);
    if (sha256(text) !== link.evidenceDigest) return null;
    const key = JSON.stringify([link.evidenceStart, link.evidenceEnd, link.evidenceDigest]);
    const group = groups.get(key);
    if (group) {
      if (!group.domains.includes(domainId)) group.domains.push(domainId);
      group.claims.push({ domainId, claimVerification: link.claimVerification });
    } else {
      groups.set(key, {
        domains: [domainId],
        start: link.evidenceStart!,
        end: link.evidenceEnd!,
        digest: link.evidenceDigest,
        text,
        claims: [{ domainId, claimVerification: link.claimVerification }],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Finds domain sources from a natural-language Hindsight query, then validates assigned links
 * through the existing asynchronous source consumer. Results are an explicit supplement; this
 * function is not installed into the ordinary Recall route.
 */
export async function readQueryRelevantDomains(input: QueryRelevantReadInput): Promise<QueryRelevantReadResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const limits = normalizeLimits(input.limits) ?? DEFAULT_LIMITS;
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const queryHash = sha256(query);
  const invalidLimits = normalizeLimits(input.limits) === null;
  if (invalidLimits || query.length === 0 || query.length > 1800
    || !input.bankId?.trim() || !input.endpoint?.trim()
    || typeof input.search !== 'function' || typeof input.getEvidenceEpoch !== 'function') {
    return emptyResult(queryHash, limits, 'incomplete', 'invalid_input', startedAt, now);
  }
  if (input.signal?.aborted) return emptyResult(queryHash, limits, 'incomplete', 'cancelled', startedAt, now);

  let initialEpoch: string | null;
  try {
    initialEpoch = input.getEvidenceEpoch();
  } catch {
    initialEpoch = null;
  }
  if (!initialEpoch) return emptyResult(queryHash, limits, 'unavailable', 'source_epoch_unavailable', startedAt, now);

  let searchRead: MemorySearchRead;
  try {
    searchRead = await input.search(query, {
      timeoutMs: limits.queryTimeoutMs,
      maxTokens: limits.queryMaxTokens,
      maxSourceFactsTokens: limits.sourceFactsMaxTokens,
      budget: 'low',
      captureTrace: true,
      activationEnabled: false,
      allowUnattributedSourceCandidates: true,
    });
  } catch {
    return emptyResult(queryHash, limits, 'unavailable', 'query_unavailable', startedAt, now);
  }
  if (input.signal?.aborted) return emptyResult(queryHash, limits, 'incomplete', 'cancelled', startedAt, now);
  if (searchRead.status === 'fenced') return emptyResult(queryHash, limits, 'fenced', 'query_fenced', startedAt, now, searchRead.status);
  if (searchRead.status === 'unavailable') return emptyResult(queryHash, limits, 'unavailable', 'query_unavailable', startedAt, now, searchRead.status);

  let postSearchEpoch: string | null;
  try {
    postSearchEpoch = input.getEvidenceEpoch();
  } catch {
    postSearchEpoch = null;
  }
  if (!postSearchEpoch) return emptyResult(queryHash, limits, 'unavailable', 'source_epoch_unavailable', startedAt, now, searchRead.status);
  if (postSearchEpoch !== initialEpoch) return emptyResult(queryHash, limits, 'fenced', 'query_fenced', startedAt, now, searchRead.status);

  let indexBlocked = false;
  try {
    indexBlocked = input.store.domainIndexStats(input.bankId, input.endpoint).blocked;
  } catch {
    return emptyResult(queryHash, limits, 'unavailable', 'index_blocked', startedAt, now, searchRead.status);
  }
  if (indexBlocked) return emptyResult(queryHash, limits, 'incomplete', 'index_blocked', startedAt, now, searchRead.status);

  const candidates = new Map<string, Candidate>();
  let excluded = 0;
  let duplicateReferences = 0;
  for (const result of searchRead.results) {
    if (result.sourceFactsIncomplete) {
      excluded += 1;
      continue;
    }
    for (const fact of result.sourceFacts ?? []) {
      if (!fact.documentId || !eligibleForExactUserReadback(fact.metadata, fact.documentId)) {
        excluded += 1;
        continue;
      }
      if (addCandidate(candidates, {
        bankId: input.bankId,
        endpoint: input.endpoint,
        documentId: fact.documentId,
      }, { resultId: result.id, sourceFactId: fact.id })) duplicateReferences += 1;
    }
    if (result.type !== 'observation' && result.documentId
      && eligibleForExactUserReadback(result.metadata, result.documentId)) {
      if (addCandidate(candidates, {
        bankId: input.bankId,
        endpoint: input.endpoint,
        documentId: result.documentId,
      }, { resultId: result.id, sourceFactId: null })) duplicateReferences += 1;
    } else if (result.type !== 'observation' && result.documentId
      && !eligibleForExactUserReadback(result.metadata, result.documentId)) {
      excluded += 1;
    }
  }

  const allCandidates = [...candidates.values()];
  const selected = allCandidates.slice(0, limits.maxSources);
  const sourceLimitReached = allCandidates.length > selected.length;
  const sources: QueryRelevantVerifiedSource[] = [];
  const fallbackSources: QueryRelevantFallbackSource[] = [];
  const withheldSources: QueryRelevantWithheldSource[] = [];
  let processed = 0;
  let readbackCalls = 0;
  let evidenceChars = 0;
  let stopReason: QueryRelevantStopReason = sourceLimitReached ? 'source_limit' : null;
  const readbackStartedAt = now();

  for (const candidate of selected) {
    if (input.signal?.aborted) {
      stopReason = 'cancelled';
      break;
    }
    const remainingMs = limits.readbackTimeBudgetMs - Math.max(0, now() - readbackStartedAt);
    if (remainingMs <= 0) {
      processed += 1;
      stopReason = 'readback_budget';
      withheldSources.push({
        identity: candidate.identity,
        reason: 'readback_limit',
        discovery: discoveriesOf(candidate),
      });
      break;
    }

    processed += 1;
    let classification;
    try {
      classification = input.store.getSourceDomainClassification(
        candidate.identity.bankId,
        candidate.identity.endpoint,
        candidate.identity.documentId,
      );
    } catch {
      return emptyResult(queryHash, limits, 'unavailable', 'index_blocked', startedAt, now, searchRead.status);
    }
    if (!classification || classification.state !== 'assigned') {
      readbackCalls += 1;
      const fallbackReadback = await exactFallbackReadback(
        input.readbackProvider,
        candidate.identity,
        input.signal,
        now,
        readbackStartedAt + limits.readbackTimeBudgetMs,
        Math.min(limits.providerTimeoutMs, remainingMs),
      );
      if (!fallbackReadback.evidence) {
        withheldSources.push({
          identity: candidate.identity,
          reason: fallbackReadback.reason ?? 'provider_error',
          discovery: discoveriesOf(candidate),
        });
        if (fallbackReadback.reason === 'cancelled') {
          stopReason = 'cancelled';
          break;
        }
        if (fallbackReadback.reason === 'provider_timeout') {
          stopReason = 'readback_budget';
          break;
        }
        continue;
      }
      const staleClassification = !!classification && (
        classification.sourceEpoch !== fallbackReadback.evidence.sourceEpoch
        || classification.sourceRevision !== sha256(fallbackReadback.evidence.content)
      );
      fallbackSources.push({
        identity: candidate.identity,
        domainState: staleClassification ? 'unindexed' : classification?.state ?? 'unindexed',
        sourceVerification: 'verified_exact_readback_fallback',
        reason: staleClassification ? 'classification_stale'
          : classification ? 'classification_unassigned' : 'classification_missing',
        discovery: discoveriesOf(candidate),
      });
      continue;
    }

    readbackCalls += 1;
    const observedReadback: { value: TrustedSourceReadbackEvidence | null } = { value: null };
    const provider: TrustedSourceReadbackProvider | null = input.readbackProvider
      ? async (identity, context) => {
        const value = await input.readbackProvider!(identity, context);
        observedReadback.value = value;
        return value;
      }
      : null;
    const verified = await readVerifiedSourceDomain(input.store, provider, candidate.identity, {
      providerTimeoutMs: Math.min(limits.providerTimeoutMs, remainingMs),
      timeBudgetMs: Math.min(limits.readbackTimeBudgetMs, remainingMs),
      signal: input.signal,
      now,
    });
    if (verified.status !== 'verified') {
      withheldSources.push({
        identity: candidate.identity,
        reason: verified.reason,
        discovery: discoveriesOf(candidate),
      });
      if (verified.reason === 'cancelled') {
        stopReason = 'cancelled';
        break;
      }
      if (verified.reason === 'time_budget' || verified.reason === 'provider_timeout') {
        stopReason = 'readback_budget';
        break;
      }
      continue;
    }
    if (!observedReadback.value || observedReadback.value.bankId !== candidate.identity.bankId
      || observedReadback.value.endpoint !== candidate.identity.endpoint
      || observedReadback.value.documentId !== candidate.identity.documentId) {
      withheldSources.push({
        identity: candidate.identity,
        reason: 'evidence_missing',
        discovery: discoveriesOf(candidate),
      });
      continue;
    }

    const evidence = evidenceSpans(
      observedReadback.value,
      verified.item.confirmedDomains,
      verified.item.classification,
    );
    if (!evidence || evidence.length === 0) {
      withheldSources.push({
        identity: candidate.identity,
        reason: 'evidence_invalid',
        discovery: discoveriesOf(candidate),
      });
      continue;
    }
    const sourceChars = evidence.reduce((total, span) => total + span.text.length, 0);
    if (evidenceChars + sourceChars > limits.maxEvidenceChars) {
      withheldSources.push({
        identity: candidate.identity,
        reason: 'output_budget',
        discovery: discoveriesOf(candidate),
      });
      stopReason = 'output_budget';
      break;
    }
    evidenceChars += sourceChars;
    sources.push({
      identity: candidate.identity,
      domains: [...verified.item.confirmedDomains],
      sourceEpoch: verified.item.classification.sourceEpoch,
      sourceRevision: verified.item.classification.sourceRevision,
      fingerprint: verified.item.fingerprint,
      sourceVerification: 'verified_domain_readback',
      discovery: discoveriesOf(candidate),
      evidence,
    });
  }

  let finalEpoch: string | null;
  try {
    finalEpoch = input.getEvidenceEpoch();
  } catch {
    finalEpoch = null;
  }
  if (!finalEpoch) return emptyResult(queryHash, limits, 'unavailable', 'source_epoch_unavailable', startedAt, now, searchRead.status);
  if (finalEpoch !== initialEpoch) return emptyResult(queryHash, limits, 'fenced', 'query_fenced', startedAt, now, searchRead.status);

  const sourceFactsTruncated = searchRead.sourceFactsTruncated === true;
  if (sourceFactsTruncated && stopReason === null) stopReason = 'query_truncated';
  const noCandidates = allCandidates.length === 0 && excluded === 0 && !sourceFactsTruncated;
  let status: QueryRelevantReadStatus;
  if (noCandidates) {
    status = searchRead.status === 'found' || searchRead.status === 'absent' ? 'no_candidates' : 'incomplete';
    if (status === 'no_candidates' && stopReason === null) stopReason = 'no_candidates';
  } else {
    const hasGaps = searchRead.status !== 'found' || sourceFactsTruncated || excluded > 0
      || sourceLimitReached || stopReason !== null || fallbackSources.length > 0 || withheldSources.length > 0
      || sources.length !== allCandidates.length;
    status = hasGaps ? 'incomplete' : 'complete';
  }

  const dispositions = new Map<string, QueryRelevantCandidateSource['disposition']>();
  for (const source of sources) dispositions.set(tupleKey(source.identity), 'verified');
  for (const source of fallbackSources) dispositions.set(tupleKey(source.identity), 'fallback');
  for (const source of withheldSources) dispositions.set(tupleKey(source.identity), 'withheld');
  const candidateSources = allCandidates.map((candidate): QueryRelevantCandidateSource => ({
    identity: candidate.identity,
    discovery: discoveriesOf(candidate),
    disposition: dispositions.get(tupleKey(candidate.identity)) ?? 'unprocessed',
  }));

  return {
    status,
    complete: status === 'complete',
    queryHash,
    candidateDiscovery: 'hindsight_natural_language_recall',
    searchStatus: searchRead.status,
    stopReason,
    candidates: candidateSources,
    sources,
    fallbackSources,
    withheldSources,
    coverage: {
      candidateCount: allCandidates.length,
      processed,
      verified: sources.length,
      fallback: fallbackSources.length,
      withheld: withheldSources.length,
      excluded,
      duplicateReferences,
      unprocessed: candidateSources.filter((candidate) => candidate.disposition === 'unprocessed').length,
      sourceFactsTruncated,
    },
    budget: {
      queryMode: 'low',
      queryTimeoutMs: limits.queryTimeoutMs,
      queryMaxTokens: limits.queryMaxTokens,
      sourceFactsMaxTokens: limits.sourceFactsMaxTokens,
      maxSources: limits.maxSources,
      readbackTimeBudgetMs: limits.readbackTimeBudgetMs,
      providerTimeoutMs: limits.providerTimeoutMs,
      maxEvidenceChars: limits.maxEvidenceChars,
      readbackCalls,
      evidenceChars,
      elapsedMs: Math.max(0, now() - startedAt),
    },
  };
}
