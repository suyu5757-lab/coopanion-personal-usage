/**
 * Writes one already-approved user source through the existing classifier, Store and
 * D3-S1 consumer.
 *
 * The classifier is advisory. Persistence happens only when the suggestion is assigned,
 * fully confirmed, stable, actor=user and kind=event/correction, the Store accepts the
 * exact body revision at its own transaction boundary, and the trusted consumer reads
 * the same tuple and links back. A correction additionally needs a synchronous provider
 * that names the original user events it supersedes.
 *
 * The bridge never executes SQL, never touches a private Store field and never changes
 * the Store or consumer actor gate. `writer` and `reader` must be distinct connections to
 * the same database because the consumer refuses a Store that carries the synchronous
 * write-time evidence provider.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  classifySourceDomain,
  type AutoDomainClassificationRequest,
  type AutoDomainSafetyContext,
  type SourceDomainSuggestion,
  type SourceDomainSuggestionProvider,
} from './source-domain-auto-classifier.ts';
import {
  readVerifiedSourceDomain,
  type SourceDomainIdentity,
  type SourceDomainReadResult,
  type TrustedSourceReadbackProvider,
  type VerifiedSourceDomainItem,
} from './source-domain-consumer.ts';
import type {
  SourceDomainClassification,
  SourceDomainClassificationInput,
  SourceDomainEvidence,
  SourceDomainEvidenceProvider,
} from './source-domains.ts';
import type { MemoryStateStore } from './state-store.ts';

const ACTIVE_SOURCE_STATUSES = new Set(['current', 'completed']);
const ORIGINAL_EVENT_STATUSES = new Set(['current', 'completed', 'superseded']);
const DIGEST = /^[0-9a-f]{64}$/;

export type PersistenceBridgeRejectionReason =
  | 'invalid_options'
  | 'classifier_blocked'
  | 'classifier_unavailable'
  | 'not_persistable'
  | 'cancelled'
  | 'correction_provenance_missing'
  | 'correction_provenance_unverified'
  | 'commit_evidence_missing'
  | 'commit_evidence_mismatch'
  | 'store_rejected';

export type PersistenceBridgeReadbackReason = 'readback_rejected' | 'readback_mismatch';

/**
 * One original user event named by a user-authored correction. The provider reads it from
 * the same trusted source boundary and returns the exact body and digest.
 */
export interface CorrectionOriginalEvent extends SourceDomainIdentity {
  content: string;
  sourceRevision: string;
  sourceEpoch: number;
  sourceActor: string;
  sourceKind: string;
  sourceStatus: string;
}

/** Synchronous and side-effect free. It is called at the commit boundary. */
export type CorrectionProvenanceProvider = (
  correction: Readonly<SourceDomainIdentity>,
) => readonly CorrectionOriginalEvent[] | null;

export interface SourceDomainPersistenceBridgeOptions {
  /** Store opened with the synchronous `sourceDomainEvidence` provider. */
  writer: MemoryStateStore;
  /** Separate Store connection without that provider, used by the D3-S1 consumer. */
  reader: MemoryStateStore;
  readback: TrustedSourceReadbackProvider | null | undefined;
  suggester: SourceDomainSuggestionProvider | null | undefined;
  safety: AutoDomainSafetyContext;
  /** Synchronous current-source provider used again immediately before the Store write. */
  commitEvidence: SourceDomainEvidenceProvider;
  correctionProvenance?: CorrectionProvenanceProvider | null;
  providerTimeoutMs?: number;
  timeBudgetMs?: number;
  verifySourceStability?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

export interface PersistenceBridgeVerified {
  status: 'verified';
  stage: 'readback';
  reason: null;
  cause: null;
  detail: null;
  suggestion: SourceDomainSuggestion;
  written: SourceDomainClassification;
  readback: VerifiedSourceDomainItem;
  elapsedMs: number;
}

export interface PersistenceBridgePersistedUnverified {
  status: 'persisted_unverified';
  stage: 'readback';
  reason: PersistenceBridgeReadbackReason;
  cause: string | null;
  detail: string;
  suggestion: SourceDomainSuggestion;
  written: SourceDomainClassification;
  readback: SourceDomainReadResult;
  elapsedMs: number;
}

export interface PersistenceBridgeWithheld {
  status: 'withheld';
  stage: 'options' | 'classify' | 'eligibility' | 'correction_provenance' | 'commit_evidence' | 'commit';
  reason: PersistenceBridgeRejectionReason;
  cause: string | null;
  detail: string;
  suggestion: SourceDomainSuggestion | null;
  written: null;
  elapsedMs: number;
}

export type PersistenceBridgeResult =
  | PersistenceBridgeVerified
  | PersistenceBridgePersistedUnverified
  | PersistenceBridgeWithheld;

interface Problem {
  cause: string;
  detail: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function detailOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function identityOf(source: SourceDomainIdentity): SourceDomainIdentity {
  return { bankId: source.bankId, endpoint: source.endpoint, documentId: source.documentId };
}

function sameIdentity(left: SourceDomainIdentity, right: SourceDomainIdentity): boolean {
  return left.bankId === right.bankId && left.endpoint === right.endpoint && left.documentId === right.documentId;
}

function optionsProblem(options: SourceDomainPersistenceBridgeOptions): string | null {
  if (!options.writer || !options.reader) return 'writer and reader are required';
  if (options.writer === options.reader) return 'writer and reader must be distinct Store connections';
  if (resolve(options.writer.path) !== resolve(options.reader.path)) {
    return 'writer and reader must open the same database file';
  }
  if (options.readback != null && typeof options.readback !== 'function') return 'readback must be a function when provided';
  if (options.suggester != null && typeof options.suggester !== 'function') return 'suggester must be a function when provided';
  if (!options.safety || typeof options.safety.epoch !== 'function'
    || typeof options.safety.isFenced !== 'function' || typeof options.safety.isSuperseded !== 'function') {
    return 'safety must provide epoch, isFenced and isSuperseded';
  }
  if (typeof options.commitEvidence !== 'function') return 'commitEvidence must be a function';
  if (options.correctionProvenance != null && typeof options.correctionProvenance !== 'function') {
    return 'correctionProvenance must be a function when provided';
  }
  return null;
}

function persistabilityProblem(
  suggestion: SourceDomainSuggestion,
  request: AutoDomainClassificationRequest,
): Problem | null {
  if (!suggestion.sourceStabilityVerified) {
    return { cause: 'source_stability_unverified', detail: 'the classifier did not verify source stability' };
  }
  if (suggestion.state !== 'assigned') {
    return { cause: `state_${suggestion.state}`, detail: 'only an assigned classification can be persisted' };
  }
  if (suggestion.links.length === 0 || suggestion.links.some((link) => link.linkState !== 'confirmed')) {
    return { cause: 'candidate_link_present', detail: 'every persisted link must be confirmed' };
  }
  if (suggestion.sourceActor !== 'user') {
    return { cause: 'actor_not_user', detail: `source actor ${suggestion.sourceActor} is not user` };
  }
  if (suggestion.sourceKind !== 'event' && suggestion.sourceKind !== 'correction') {
    return { cause: 'kind_not_event_or_correction', detail: `source kind ${suggestion.sourceKind} is not event or correction` };
  }
  if (!ACTIVE_SOURCE_STATUSES.has(suggestion.sourceStatus)) {
    return { cause: 'status_invalid', detail: `source status ${suggestion.sourceStatus} is not current` };
  }
  if (!suggestion.persistence.eligible) {
    return { cause: suggestion.persistence.reason, detail: 'the classifier did not mark the suggestion persistable' };
  }
  if (suggestion.permissions.toolExecutionGranted !== false) {
    return { cause: 'tool_permission_granted', detail: 'a classification cannot grant tool execution' };
  }
  if (!sameIdentity(suggestion, request)) {
    return { cause: 'identity_mismatch', detail: 'the suggestion identity does not match the requested tuple' };
  }
  if (request.expectedSourceRevision !== undefined && suggestion.sourceRevision !== request.expectedSourceRevision) {
    return { cause: 'revision_mismatch', detail: 'the suggestion revision does not match the expected revision' };
  }
  if (request.expectedSourceEpoch !== undefined && suggestion.sourceEpoch !== request.expectedSourceEpoch) {
    return { cause: 'epoch_mismatch', detail: 'the suggestion epoch does not match the expected epoch' };
  }
  return null;
}

function correctionProblem(
  suggestion: SourceDomainSuggestion,
  provider: CorrectionProvenanceProvider | null | undefined,
  safety: AutoDomainSafetyContext,
): Problem | null {
  if (suggestion.sourceKind !== 'correction') return null;
  if (!provider) {
    return { cause: 'correction_provenance_missing', detail: 'a user correction requires traceable original user events' };
  }

  let originals: readonly CorrectionOriginalEvent[] | null;
  try {
    originals = provider(identityOf(suggestion));
  } catch (error) {
    return { cause: 'correction_provenance_error', detail: detailOf(error) };
  }
  if (!Array.isArray(originals) || originals.length === 0) {
    return { cause: 'correction_provenance_unverified', detail: 'the provider returned no original user event' };
  }

  const seen = new Set<string>();
  for (const original of originals) {
    if (!original || typeof original !== 'object'
      || typeof original.bankId !== 'string' || typeof original.endpoint !== 'string'
      || typeof original.documentId !== 'string' || typeof original.content !== 'string'
      || typeof original.sourceRevision !== 'string' || !Number.isInteger(original.sourceEpoch)
      || typeof original.sourceActor !== 'string' || typeof original.sourceKind !== 'string'
      || typeof original.sourceStatus !== 'string') {
      return { cause: 'correction_provenance_unverified', detail: 'an original user event has an invalid shape' };
    }
    if (original.bankId !== suggestion.bankId || original.endpoint !== suggestion.endpoint
      || original.documentId === suggestion.documentId) {
      return { cause: 'correction_provenance_unverified', detail: 'an original event is not in the correction source scope' };
    }
    if (seen.has(original.documentId)) {
      return { cause: 'correction_provenance_unverified', detail: 'an original user event is repeated' };
    }
    seen.add(original.documentId);
    if (original.sourceActor !== 'user' || original.sourceKind !== 'event'
      || !ORIGINAL_EVENT_STATUSES.has(original.sourceStatus)) {
      return { cause: 'correction_provenance_unverified', detail: 'an original event is not a current or historical user event' };
    }
    if (original.content.length === 0 || !DIGEST.test(original.sourceRevision)
      || hash(original.content) !== original.sourceRevision) {
      return { cause: 'correction_provenance_unverified', detail: 'an original user event body does not match its revision' };
    }
    try {
      if (safety.isFenced(identityOf(original))) {
        return { cause: 'correction_provenance_unverified', detail: 'an original user event is fenced' };
      }
    } catch (error) {
      return { cause: 'correction_provenance_error', detail: detailOf(error) };
    }
  }
  return null;
}

function commitEvidenceProblem(
  suggestion: SourceDomainSuggestion,
  evidence: SourceDomainEvidence | null | undefined,
): Problem | null {
  if (!evidence || typeof evidence !== 'object') {
    return { cause: 'commit_evidence_missing', detail: 'the commit boundary returned no current source evidence' };
  }
  if (evidence.bankId !== suggestion.bankId || evidence.endpoint !== suggestion.endpoint
    || evidence.documentId !== suggestion.documentId) {
    return { cause: 'identity_mismatch', detail: 'the commit evidence identity changed' };
  }
  if (evidence.sourceActor !== 'user' || evidence.sourceKind !== suggestion.sourceKind) {
    return { cause: 'source_changed', detail: 'the commit evidence actor or kind changed' };
  }
  if (!ACTIVE_SOURCE_STATUSES.has(evidence.sourceStatus ?? '')
    || evidence.sourceStatus !== suggestion.sourceStatus) {
    return { cause: 'source_changed', detail: 'the commit evidence status changed' };
  }
  if (typeof evidence.content !== 'string' || evidence.content.length === 0
    || hash(evidence.content) !== suggestion.sourceRevision) {
    return { cause: 'revision_mismatch', detail: 'the commit evidence body no longer matches the classified revision' };
  }
  if (evidence.sourceEpoch !== suggestion.sourceEpoch) {
    return { cause: 'epoch_mismatch', detail: 'the commit evidence epoch no longer matches the classified epoch' };
  }
  return null;
}

function classificationInput(
  suggestion: SourceDomainSuggestion,
  at: string,
): SourceDomainClassificationInput {
  return {
    bankId: suggestion.bankId,
    endpoint: suggestion.endpoint,
    documentId: suggestion.documentId,
    state: suggestion.state,
    taxonomyVersion: suggestion.taxonomyVersion,
    classifierVersion: suggestion.classifierVersion,
    confidence: suggestion.confidence,
    sourceEpoch: suggestion.sourceEpoch,
    sourceRevision: suggestion.sourceRevision,
    classifiedAt: at,
    updatedAt: at,
    links: suggestion.links.map((link) => ({
      domainId: link.domainId,
      linkState: link.linkState,
      confidence: link.confidence,
      ruleId: link.ruleId,
      evidenceStart: link.evidenceStart,
      evidenceEnd: link.evidenceEnd,
      evidenceDigest: link.evidenceDigest,
      claimVerification: link.claimVerification,
    })),
  };
}

function canonical(record: SourceDomainClassification): string {
  return JSON.stringify({
    bankId: record.bankId,
    endpoint: record.endpoint,
    documentId: record.documentId,
    state: record.state,
    taxonomyVersion: record.taxonomyVersion,
    classifierVersion: record.classifierVersion,
    confidence: record.confidence,
    sourceEpoch: record.sourceEpoch,
    sourceRevision: record.sourceRevision,
    links: [...record.links]
      .sort((left, right) => left.domainId.localeCompare(right.domainId))
      .map((link) => ({
        domainId: link.domainId,
        linkState: link.linkState,
        confidence: link.confidence,
        ruleId: link.ruleId,
        evidenceStart: link.evidenceStart,
        evidenceEnd: link.evidenceEnd,
        evidenceDigest: link.evidenceDigest,
        claimVerification: link.claimVerification,
      })),
  });
}

function readbackProblem(
  suggestion: SourceDomainSuggestion,
  expected: SourceDomainClassification,
  written: SourceDomainClassification,
  item: VerifiedSourceDomainItem,
): Problem | null {
  if (canonical(written) !== canonical(expected)) {
    return { cause: 'store_changed_classification', detail: 'the stored classification differs from the verified suggestion' };
  }
  if (canonical(item.classification) !== canonical(written)) {
    return { cause: 'readback_changed_classification', detail: 'the consumer readback differs from the stored row' };
  }
  if (!sameIdentity(item, suggestion)) {
    return { cause: 'readback_identity_mismatch', detail: 'the consumer readback identity differs from the source tuple' };
  }
  const expectedDomains = [...suggestion.links.map((link) => link.domainId)].sort();
  const confirmedDomains = [...item.confirmedDomains].sort();
  if (JSON.stringify(expectedDomains) !== JSON.stringify(confirmedDomains)) {
    return { cause: 'readback_domains_mismatch', detail: 'the consumer confirmed domains differ from the suggestion' };
  }
  for (const link of suggestion.links) {
    const claim = item.claims.find((entry) => entry.domainId === link.domainId);
    if (!claim || claim.claimVerification !== link.claimVerification) {
      return { cause: 'readback_claims_mismatch', detail: `the consumer claim for ${link.domainId} differs from the suggestion` };
    }
  }
  if (item.externalFactsVerified !== false) {
    return { cause: 'external_fact_overclaim', detail: 'the consumer marked external facts as verified' };
  }
  return null;
}

function withheld(
  stage: PersistenceBridgeWithheld['stage'],
  reason: PersistenceBridgeRejectionReason,
  cause: string | null,
  detail: string,
  suggestion: SourceDomainSuggestion | null,
  startedAt: number,
  now: () => number,
): PersistenceBridgeWithheld {
  return {
    status: 'withheld',
    stage,
    reason,
    cause,
    detail,
    suggestion,
    written: null,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

export async function persistVerifiedUserSourceDomain(
  request: AutoDomainClassificationRequest,
  options: SourceDomainPersistenceBridgeOptions,
): Promise<PersistenceBridgeResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const invalid = optionsProblem(options);
  if (invalid) return withheld('options', 'invalid_options', null, invalid, null, startedAt, now);
  if (!request || typeof request !== 'object'
    || typeof request.bankId !== 'string' || request.bankId.trim().length === 0
    || typeof request.endpoint !== 'string' || request.endpoint.trim().length === 0
    || typeof request.documentId !== 'string' || request.documentId.trim().length === 0) {
    return withheld('options', 'invalid_options', null, 'source identity must contain non-empty strings', null, startedAt, now);
  }
  if (options.signal?.aborted) {
    return withheld('classify', 'cancelled', 'cancelled', 'the call was cancelled before classification', null, startedAt, now);
  }

  const classified = await classifySourceDomain(request, {
    readback: options.readback,
    suggester: options.suggester,
    safety: options.safety,
    providerTimeoutMs: options.providerTimeoutMs,
    timeBudgetMs: options.timeBudgetMs,
    verifySourceStability: options.verifySourceStability,
    signal: options.signal,
    now,
  });
  if (classified.outcome !== 'suggested') {
    return withheld(
      'classify',
      classified.outcome === 'blocked' ? 'classifier_blocked' : 'classifier_unavailable',
      classified.reason,
      classified.detail ?? `classification ${classified.outcome}`,
      null,
      startedAt,
      now,
    );
  }

  const suggestion = classified.suggestion;
  const persistable = persistabilityProblem(suggestion, request);
  if (persistable) {
    return withheld('eligibility', 'not_persistable', persistable.cause, persistable.detail, suggestion, startedAt, now);
  }
  if (options.signal?.aborted) {
    return withheld('eligibility', 'cancelled', 'cancelled', 'the call was cancelled before the commit boundary', suggestion, startedAt, now);
  }

  const correction = correctionProblem(suggestion, options.correctionProvenance, options.safety);
  if (correction) {
    return withheld(
      'correction_provenance',
      correction.cause === 'correction_provenance_missing'
        ? 'correction_provenance_missing'
        : 'correction_provenance_unverified',
      correction.cause,
      correction.detail,
      suggestion,
      startedAt,
      now,
    );
  }

  let evidence: SourceDomainEvidence | null;
  try {
    evidence = options.commitEvidence(suggestion.bankId, suggestion.endpoint, suggestion.documentId);
  } catch (error) {
    return withheld('commit_evidence', 'commit_evidence_missing', 'provider_error', detailOf(error), suggestion, startedAt, now);
  }
  const commit = commitEvidenceProblem(suggestion, evidence);
  if (commit) {
    return withheld('commit_evidence', 'commit_evidence_mismatch', commit.cause, commit.detail, suggestion, startedAt, now);
  }

  const at = new Date(now()).toISOString();
  const input = classificationInput(suggestion, at);
  const expected: SourceDomainClassification = { ...input, links: input.links.map((link) => ({ ...link })) };
  let written: SourceDomainClassification;
  try {
    written = options.writer.putSourceDomainClassification(input);
  } catch (error) {
    return withheld('commit', 'store_rejected', null, detailOf(error), suggestion, startedAt, now);
  }

  const readback = await readVerifiedSourceDomain(options.reader, options.readback, identityOf(suggestion), {
    providerTimeoutMs: options.providerTimeoutMs,
    timeBudgetMs: options.timeBudgetMs,
    signal: options.signal,
    now,
  });
  if (readback.status !== 'verified') {
    return {
      status: 'persisted_unverified',
      stage: 'readback',
      reason: 'readback_rejected',
      cause: readback.reason,
      detail: readback.detail ?? `consumer readback ${readback.status}`,
      suggestion,
      written,
      readback,
      elapsedMs: Math.max(0, now() - startedAt),
    };
  }

  const mismatch = readbackProblem(suggestion, expected, written, readback.item);
  if (mismatch) {
    return {
      status: 'persisted_unverified',
      stage: 'readback',
      reason: 'readback_mismatch',
      cause: mismatch.cause,
      detail: mismatch.detail,
      suggestion,
      written,
      readback,
      elapsedMs: Math.max(0, now() - startedAt),
    };
  }

  return {
    status: 'verified',
    stage: 'readback',
    reason: null,
    cause: null,
    detail: null,
    suggestion,
    written,
    readback: readback.item,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}
