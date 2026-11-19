/**
 * Trusted consumer boundary for source-level memory domains.
 *
 * This module is deliberately not wired into Recall, MemorySearch, Hindsight or any
 * model-visible path. A caller must pass an asynchronous readback provider and a
 * `SourceDomainReadStore` that does not contain a synchronous reentrant provider.
 * The raw store row is only a candidate index; it is never returned as verified.
 */
import { createHash } from 'node:crypto';
import { sourceDomainReadStoreUsesSyncReadback, type SourceDomainReadStore } from './source-domain-read-store.ts';
import {
  assertSourceDomainClassification,
  normalizeDomains,
  type ClaimVerification,
  type DomainId,
  type SourceDomainClassification,
  type SourceDomainLink,
} from './source-domains.ts';

export interface SourceDomainIdentity {
  bankId: string;
  endpoint: string;
  documentId: string;
}

export interface SourceDomainBatchQuery {
  bankId: string;
  endpoint: string;
  domains: readonly DomainId[];
}

/**
 * The trusted body read back from the source service. `content` is the exact body
 * used for the SHA-256 revision and UTF-16 span verification. `sourceStatus` must be
 * an active lifecycle value (`current` or the Hindsight user-event value `completed`).
 */
export interface TrustedSourceReadbackEvidence extends SourceDomainIdentity {
  content: string;
  sourceEpoch: number;
  sourceRevision?: string;
  sourceActor: string;
  sourceKind: string;
  sourceStatus: string;
}

export interface TrustedSourceReadbackContext {
  signal: AbortSignal;
  deadlineAt: number;
}

export type TrustedSourceReadbackProvider = (
  source: Readonly<SourceDomainIdentity>,
  context: Readonly<TrustedSourceReadbackContext>,
) => Promise<TrustedSourceReadbackEvidence | null>;

export interface SourceDomainConsumerOptions {
  /** Raw index rows fetched per page. Range 1..200; default 50. */
  pageSize?: number;
  /** Maximum candidate rows inspected by one call. Range 1..500; default 100. */
  maxItems?: number;
  /** Maximum raw pages fetched by one call. Range 1..50; default 20. */
  maxPages?: number;
  /** Per-readback timeout. Range 1..30000 ms; default 2000. */
  providerTimeoutMs?: number;
  /** Total asynchronous verification budget. Range 1..60000 ms; default 5000. */
  timeBudgetMs?: number;
  /** Start cursor, using the raw store's document-id order. */
  cursor?: string | null;
  /** External cancellation. A cancelled batch returns no verified items. */
  signal?: AbortSignal;
  /** Clock injection for deterministic budget tests; production uses Date.now. */
  now?: () => number;
}

export type SourceDomainConsumerReason =
  | 'provider_missing'
  | 'provider_error'
  | 'provider_timeout'
  | 'cancelled'
  | 'time_budget'
  | 'sync_store_provider_unsupported'
  | 'store_blocked'
  | 'store_error'
  | 'invalid_query'
  | 'invalid_options'
  | 'record_missing'
  | 'not_assigned'
  | 'invalid_classification'
  | 'no_confirmed_link'
  | 'identity_mismatch'
  | 'epoch_mismatch'
  | 'revision_mismatch'
  | 'actor_invalid'
  | 'kind_invalid'
  | 'status_invalid'
  | 'content_empty'
  | 'evidence_missing'
  | 'evidence_invalid'
  | 'span_invalid'
  | 'evidence_digest_mismatch'
  | 'classification_changed'
  | 'page_limit'
  | 'item_limit'
  | 'max_pages';

export interface VerifiedSourceDomainItem {
  status: 'verified';
  bankId: string;
  endpoint: string;
  documentId: string;
  classification: SourceDomainClassification;
  fingerprint: string;
  confirmedDomains: DomainId[];
  claims: Array<{ domainId: DomainId; claimVerification: ClaimVerification }>;
  /** External claims are traceable text, not independently verified world facts. */
  externalFactsVerified: false;
  verifiedAt: string;
}

export interface WithheldSourceDomainItem {
  status: 'blocked' | 'unavailable';
  bankId: string;
  endpoint: string;
  documentId: string;
  reason: SourceDomainConsumerReason;
  detail: string | null;
}

export interface SourceDomainVerifiedResult {
  status: 'verified';
  item: VerifiedSourceDomainItem;
  reason: null;
  detail: null;
  finalBarrier: 'passed';
  elapsedMs: number;
}

export interface SourceDomainRejectedResult {
  status: 'blocked' | 'unavailable';
  item: null;
  reason: SourceDomainConsumerReason;
  detail: string | null;
  finalBarrier: 'passed' | 'failed' | 'not_run';
  elapsedMs: number;
}

export type SourceDomainReadResult = SourceDomainVerifiedResult | SourceDomainRejectedResult;

export type SourceDomainBatchStatus = 'verified' | 'blocked' | 'incomplete' | 'unavailable';
export type SourceDomainStopReason = 'page_limit' | 'item_limit' | 'max_pages' | 'time_budget';

export interface SourceDomainBatchPage {
  pageSize: number;
  maxItems: number;
  maxPages: number;
  pagesRead: number;
  scanned: number;
  returned: number;
  /** Rows selected by the raw query but filtered by the store as no longer readable. */
  filtered: number;
  requestedCursor: string | null;
  nextCursor: string | null;
  complete: boolean;
  truncated: boolean;
  stopReason: SourceDomainStopReason | null;
}

export interface SourceDomainBatchResult {
  status: SourceDomainBatchStatus;
  reason: SourceDomainConsumerReason | null;
  detail: string | null;
  items: VerifiedSourceDomainItem[];
  withheld: WithheldSourceDomainItem[];
  finalBarrier: 'passed' | 'failed' | 'not_run';
  page: SourceDomainBatchPage;
  elapsedMs: number;
}

interface NormalizedOptions {
  pageSize: number;
  maxItems: number;
  maxPages: number;
  providerTimeoutMs: number;
  timeBudgetMs: number;
  cursor: string;
  signal: AbortSignal;
  now: () => number;
}

interface CandidateSnapshot {
  identity: SourceDomainIdentity;
  record: SourceDomainClassification;
  fingerprint: string;
  confirmedLinks: SourceDomainLink[];
}

type SnapshotOutcome =
  | { ok: true; snapshot: CandidateSnapshot }
  | { ok: false; global: boolean; reason: SourceDomainConsumerReason; detail: string | null };

interface TrustedRecord {
  record: SourceDomainClassification;
  confirmedLinks: SourceDomainLink[];
  fingerprint: string;
}

type VerifyOutcome =
  | { status: 'verified'; item: VerifiedSourceDomainItem; barrier: 'passed' }
  | {
    status: 'blocked' | 'unavailable';
    global: boolean;
    reason: SourceDomainConsumerReason;
    detail: string | null;
    barrier: 'passed' | 'not_run';
  };

const DIGEST = /^[0-9a-f]{64}$/;
const ACTIVE_SOURCE_STATUSES = new Set(['current', 'completed']);
const OPTION_LIMITS = {
  pageSize: { min: 1, max: 200, fallback: 50 },
  maxItems: { min: 1, max: 500, fallback: 100 },
  maxPages: { min: 1, max: 50, fallback: 20 },
  providerTimeoutMs: { min: 1, max: 30_000, fallback: 2_000 },
  timeBudgetMs: { min: 1, max: 60_000, fallback: 5_000 },
} as const;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function detailOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

function identityOf(source: SourceDomainIdentity): SourceDomainIdentity {
  return { bankId: source.bankId, endpoint: source.endpoint, documentId: source.documentId };
}

function tupleKey(source: SourceDomainIdentity): string {
  return JSON.stringify([source.bankId, source.endpoint, source.documentId]);
}

function fingerprintOf(record: SourceDomainClassification): string {
  return hash(JSON.stringify({
    bankId: record.bankId,
    endpoint: record.endpoint,
    documentId: record.documentId,
    state: record.state,
    taxonomyVersion: record.taxonomyVersion,
    classifierVersion: record.classifierVersion,
    confidence: record.confidence,
    sourceEpoch: record.sourceEpoch,
    sourceRevision: record.sourceRevision,
    classifiedAt: record.classifiedAt,
    updatedAt: record.updatedAt,
    links: record.links.map((link) => [
      link.domainId,
      link.linkState,
      link.confidence,
      link.ruleId,
      link.evidenceStart,
      link.evidenceEnd,
      link.evidenceDigest,
      link.claimVerification,
    ]),
  }));
}

function option(
  value: number | undefined,
  limits: { min: number; max: number; fallback: number },
): number | null {
  const resolved = value ?? limits.fallback;
  return Number.isInteger(resolved) && resolved >= limits.min && resolved <= limits.max ? resolved : null;
}

function normalizeOptions(options: SourceDomainConsumerOptions): NormalizedOptions | null {
  const pageSize = option(options.pageSize, OPTION_LIMITS.pageSize);
  const maxItems = option(options.maxItems, OPTION_LIMITS.maxItems);
  const maxPages = option(options.maxPages, OPTION_LIMITS.maxPages);
  const providerTimeoutMs = option(options.providerTimeoutMs, OPTION_LIMITS.providerTimeoutMs);
  const timeBudgetMs = option(options.timeBudgetMs, OPTION_LIMITS.timeBudgetMs);
  if (pageSize === null || maxItems === null || maxPages === null
    || providerTimeoutMs === null || timeBudgetMs === null) return null;
  const cursor = options.cursor ?? '';
  if (typeof cursor !== 'string') return null;
  const now = options.now ?? Date.now;
  if (typeof now !== 'function' || !Number.isFinite(now())) return null;
  return {
    pageSize,
    maxItems,
    maxPages,
    providerTimeoutMs,
    timeBudgetMs,
    cursor,
    signal: options.signal ?? new AbortController().signal,
    now,
  };
}

function trustedRecord(record: SourceDomainClassification): TrustedRecord | null {
  try {
    assertSourceDomainClassification(record);
  } catch {
    return null;
  }
  if (record.state !== 'assigned') return null;
  if (record.links.length === 0 || record.links.some((link) => link.linkState !== 'confirmed')) return null;
  const confirmedLinks = record.links.filter((link) => link.linkState === 'confirmed');
  if (confirmedLinks.length === 0) return null;
  return { record, confirmedLinks, fingerprint: fingerprintOf(record) };
}

function snapshotOutcome(store: SourceDomainReadStore, identity: SourceDomainIdentity): SnapshotOutcome {
  let record: SourceDomainClassification | null;
  try {
    record = store.getSourceDomainClassification(identity.bankId, identity.endpoint, identity.documentId);
  } catch (error) {
    return { ok: false, global: true, reason: 'store_error', detail: detailOf(error) };
  }
  if (!record) {
    return { ok: false, global: false, reason: 'record_missing', detail: 'classification is absent or no longer current' };
  }
  if (record.bankId !== identity.bankId || record.endpoint !== identity.endpoint || record.documentId !== identity.documentId) {
    return { ok: false, global: false, reason: 'identity_mismatch', detail: 'stored classification identity does not match the requested tuple' };
  }
  const trusted = trustedRecord(record);
  if (!trusted) {
    return {
      ok: false,
      global: false,
      reason: record.state === 'assigned' ? 'invalid_classification' : 'not_assigned',
      detail: record.state === 'assigned' ? 'assigned classification failed structural or link invariants' : `classification state is ${record.state}`,
    };
  }
  return {
    ok: true,
    snapshot: {
      identity,
      record: trusted.record,
      fingerprint: trusted.fingerprint,
      confirmedLinks: trusted.confirmedLinks,
    },
  };
}

function validateReadback(
  snapshot: CandidateSnapshot,
  evidence: TrustedSourceReadbackEvidence,
): { ok: true } | { ok: false; reason: SourceDomainConsumerReason; detail: string | null } {
  if (!evidence || typeof evidence !== 'object'
    || !isNonEmptyText(evidence.bankId) || !isNonEmptyText(evidence.endpoint) || !isNonEmptyText(evidence.documentId)
    || typeof evidence.content !== 'string' || !Number.isInteger(evidence.sourceEpoch)
    || typeof evidence.sourceActor !== 'string' || typeof evidence.sourceKind !== 'string'
    || typeof evidence.sourceStatus !== 'string'
    || (evidence.sourceRevision !== undefined && typeof evidence.sourceRevision !== 'string')) {
    return { ok: false, reason: 'evidence_invalid', detail: 'readback evidence has an invalid shape' };
  }
  if (evidence.bankId !== snapshot.identity.bankId
    || evidence.endpoint !== snapshot.identity.endpoint
    || evidence.documentId !== snapshot.identity.documentId) {
    return { ok: false, reason: 'identity_mismatch', detail: 'readback evidence identity does not match the tuple' };
  }
  if (evidence.sourceEpoch !== snapshot.record.sourceEpoch) {
    return { ok: false, reason: 'epoch_mismatch', detail: 'readback epoch does not match the classification snapshot' };
  }
  if (evidence.sourceActor !== 'user') {
    return { ok: false, reason: 'actor_invalid', detail: 'trusted source actor is not the user' };
  }
  if (evidence.sourceKind !== 'event' && evidence.sourceKind !== 'correction') {
    return { ok: false, reason: 'kind_invalid', detail: 'trusted source kind is not event or correction' };
  }
  if (!ACTIVE_SOURCE_STATUSES.has(evidence.sourceStatus)) {
    return { ok: false, reason: 'status_invalid', detail: `source status ${evidence.sourceStatus} is not current` };
  }
  if (evidence.content.length === 0) {
    return { ok: false, reason: 'content_empty', detail: 'trusted source body is empty' };
  }
  const revision = hash(evidence.content);
  if (revision !== snapshot.record.sourceRevision) {
    return { ok: false, reason: 'revision_mismatch', detail: 'readback body digest does not match the classification revision' };
  }
  if (evidence.sourceRevision !== undefined && evidence.sourceRevision !== revision) {
    return { ok: false, reason: 'revision_mismatch', detail: 'provider-supplied revision does not match the readback body' };
  }
  for (const link of snapshot.confirmedLinks) {
    const start = link.evidenceStart;
    const end = link.evidenceEnd;
    if (start === null || end === null || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end <= start || end > evidence.content.length) {
      return { ok: false, reason: 'span_invalid', detail: `confirmed link ${link.domainId} has an invalid UTF-16 span` };
    }
    if (typeof link.evidenceDigest !== 'string' || !DIGEST.test(link.evidenceDigest)) {
      return { ok: false, reason: 'span_invalid', detail: `confirmed link ${link.domainId} has an invalid digest` };
    }
    if (hash(evidence.content.slice(start, end)) !== link.evidenceDigest) {
      return { ok: false, reason: 'evidence_digest_mismatch', detail: `confirmed link ${link.domainId} span digest does not match the readback body` };
    }
  }
  return { ok: true };
}

function itemFrom(
  record: SourceDomainClassification,
  fingerprint: string,
  confirmedLinks: SourceDomainLink[],
  now: () => number,
): VerifiedSourceDomainItem {
  const claims = confirmedLinks.map((link) => ({
    domainId: link.domainId,
    claimVerification: link.claimVerification,
  }));
  return {
    status: 'verified',
    bankId: record.bankId,
    endpoint: record.endpoint,
    documentId: record.documentId,
    classification: record,
    fingerprint,
    confirmedDomains: claims.map((claim) => claim.domainId),
    claims,
    externalFactsVerified: false,
    verifiedAt: new Date(now()).toISOString(),
  };
}

type ProviderOutcome =
  | { kind: 'value'; value: TrustedSourceReadbackEvidence | null }
  | { kind: 'error'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

function callProvider(
  provider: TrustedSourceReadbackProvider,
  identity: SourceDomainIdentity,
  options: NormalizedOptions,
  deadlineAt: number,
): Promise<ProviderOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: ProviderOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: 'cancelled' });
    if (options.signal.aborted) {
      finish({ kind: 'cancelled' });
      return;
    }
    const remaining = Math.min(options.providerTimeoutMs, deadlineAt - options.now());
    if (remaining <= 0) {
      finish({ kind: 'timeout' });
      return;
    }
    timer = setTimeout(() => finish({ kind: 'timeout' }), remaining);
    options.signal.addEventListener('abort', onAbort, { once: true });

    let pending: Promise<TrustedSourceReadbackEvidence | null>;
    try {
      pending = Promise.resolve(provider(identityOf(identity), { signal: options.signal, deadlineAt }));
    } catch (error) {
      finish({ kind: 'error', detail: detailOf(error) });
      return;
    }
    pending.then(
      (value) => finish({ kind: 'value', value }),
      (error) => finish({ kind: 'error', detail: detailOf(error) }),
    );
  });
}

async function verifySnapshot(
  store: SourceDomainReadStore,
  provider: TrustedSourceReadbackProvider,
  snapshot: CandidateSnapshot,
  options: NormalizedOptions,
  deadlineAt: number,
): Promise<VerifyOutcome> {
  const outcome = await callProvider(provider, snapshot.identity, options, deadlineAt);
  if (outcome.kind === 'cancelled') {
    return { status: 'unavailable', global: true, reason: 'cancelled', detail: null, barrier: 'not_run' };
  }
  if (outcome.kind === 'timeout') {
    return { status: 'unavailable', global: true, reason: 'provider_timeout', detail: null, barrier: 'not_run' };
  }
  if (outcome.kind === 'error') {
    return { status: 'blocked', global: false, reason: 'provider_error', detail: outcome.detail, barrier: 'not_run' };
  }
  if (outcome.value === null || outcome.value === undefined) {
    return { status: 'blocked', global: false, reason: 'evidence_missing', detail: 'provider returned no trusted evidence', barrier: 'not_run' };
  }

  const validation = validateReadback(snapshot, outcome.value);
  if (!validation.ok) {
    return { status: 'blocked', global: false, reason: validation.reason, detail: validation.detail, barrier: 'not_run' };
  }

  let current: SourceDomainClassification | null;
  try {
    current = store.getSourceDomainClassification(snapshot.identity.bankId, snapshot.identity.endpoint, snapshot.identity.documentId);
  } catch (error) {
    return { status: 'blocked', global: true, reason: 'store_error', detail: detailOf(error), barrier: 'not_run' };
  }
  if (!current) {
    return { status: 'blocked', global: false, reason: 'record_missing', detail: 'classification disappeared after readback', barrier: 'passed' };
  }
  if (fingerprintOf(current) !== snapshot.fingerprint) {
    return { status: 'blocked', global: false, reason: 'classification_changed', detail: 'classification fingerprint changed during readback', barrier: 'passed' };
  }
  const trusted = trustedRecord(current);
  if (!trusted) {
    return { status: 'blocked', global: false, reason: 'invalid_classification', detail: 'current classification is no longer trusted', barrier: 'passed' };
  }
  return {
    status: 'verified',
    item: itemFrom(trusted.record, snapshot.fingerprint, trusted.confirmedLinks, options.now),
    barrier: 'passed',
  };
}

function rejected(
  status: 'blocked' | 'unavailable',
  reason: SourceDomainConsumerReason,
  detail: string | null,
  startedAt: number,
  now: () => number,
  barrier: 'passed' | 'failed' | 'not_run' = 'not_run',
): SourceDomainRejectedResult {
  return { status, reason, detail, item: null, finalBarrier: barrier, elapsedMs: Math.max(0, now() - startedAt) };
}

export async function readVerifiedSourceDomain(
  store: SourceDomainReadStore,
  provider: TrustedSourceReadbackProvider | null | undefined,
  identity: SourceDomainIdentity,
  options: SourceDomainConsumerOptions = {},
): Promise<SourceDomainReadResult> {
  const config = normalizeOptions(options);
  const startedAt = config?.now() ?? (options.now ?? Date.now)();
  if (!config) return rejected('blocked', 'invalid_options', 'consumer options are outside the approved bounds', startedAt, options.now ?? Date.now);
  const { now } = config;
  if (!isNonEmptyText(identity.bankId) || !isNonEmptyText(identity.endpoint) || !isNonEmptyText(identity.documentId)) {
    return rejected('blocked', 'invalid_query', 'source identity must contain non-empty strings', startedAt, now);
  }
  if (!provider) return rejected('unavailable', 'provider_missing', 'no trusted asynchronous readback provider is configured', startedAt, now);
  if (sourceDomainReadStoreUsesSyncReadback(store)) {
    return rejected('blocked', 'sync_store_provider_unsupported', 'the raw store still has a synchronous reentrant readback provider', startedAt, now);
  }
  if (config.signal.aborted) return rejected('unavailable', 'cancelled', 'consumer call has already been cancelled', startedAt, now);

  const snapshot = snapshotOutcome(store, identity);
  if (!snapshot.ok) return rejected('blocked', snapshot.reason, snapshot.detail, startedAt, now);
  const deadlineAt = startedAt + config.timeBudgetMs;
  if (now() >= deadlineAt) return rejected('unavailable', 'time_budget', 'time budget expired before readback', startedAt, now);

  const verified = await verifySnapshot(store, provider, snapshot.snapshot, config, deadlineAt);
  if (verified.status !== 'verified') {
    return rejected(verified.status, verified.reason, verified.detail, startedAt, now, verified.barrier);
  }
  return {
    status: 'verified',
    item: verified.item,
    reason: null,
    detail: null,
    finalBarrier: 'passed',
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

function batchPage(
  config: NormalizedOptions,
  requestedCursor: string | null,
  values: Partial<SourceDomainBatchPage> = {},
): SourceDomainBatchPage {
  return {
    pageSize: config.pageSize,
    maxItems: config.maxItems,
    maxPages: config.maxPages,
    pagesRead: 0,
    scanned: 0,
    returned: 0,
    filtered: 0,
    requestedCursor,
    nextCursor: requestedCursor,
    complete: false,
    truncated: true,
    stopReason: null,
    ...values,
  };
}

function batchRejected(
  status: SourceDomainBatchStatus,
  reason: SourceDomainConsumerReason,
  detail: string | null,
  config: NormalizedOptions | null,
  requestedCursor: string | null,
  startedAt: number,
  now: () => number,
  barrier: 'passed' | 'failed' | 'not_run' = 'not_run',
): SourceDomainBatchResult {
  return {
    status,
    reason,
    detail,
    items: [],
    withheld: [],
    finalBarrier: barrier,
    page: config
      ? batchPage(config, requestedCursor)
      : {
        pageSize: 0, maxItems: 0, maxPages: 0, pagesRead: 0, scanned: 0, returned: 0,
        filtered: 0, requestedCursor, nextCursor: requestedCursor, complete: false, truncated: true, stopReason: null,
      },
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

function withheldItem(
  source: SourceDomainIdentity,
  status: 'blocked' | 'unavailable',
  reason: SourceDomainConsumerReason,
  detail: string | null,
): WithheldSourceDomainItem {
  return { status, bankId: source.bankId, endpoint: source.endpoint, documentId: source.documentId, reason, detail };
}

interface BarrierResult {
  ok: boolean;
  globalReason: SourceDomainConsumerReason | null;
  globalDetail: string | null;
  items: VerifiedSourceDomainItem[];
  withheld: WithheldSourceDomainItem[];
}

/**
 * Synchronous final barrier. There is intentionally no await in this function: every
 * provider call has settled before it is entered. It rechecks every candidate snapshot
 * and every item that was already accepted.
 */
function runFinalBarrier(
  store: SourceDomainReadStore,
  candidates: readonly CandidateSnapshot[],
  verified: readonly VerifiedSourceDomainItem[],
): BarrierResult {
  const accepted = new Map(verified.map((item) => [tupleKey(item), item]));
  const survivors: VerifiedSourceDomainItem[] = [];
  const withheld: WithheldSourceDomainItem[] = [];
  for (const candidate of candidates) {
    let current: SourceDomainClassification | null;
    try {
      current = store.getSourceDomainClassification(
        candidate.identity.bankId,
        candidate.identity.endpoint,
        candidate.identity.documentId,
      );
    } catch (error) {
      return {
        ok: false,
        globalReason: 'store_error',
        globalDetail: detailOf(error),
        items: [],
        withheld: [],
      };
    }
    const item = accepted.get(tupleKey(candidate.identity));
    if (!item) continue;
    if (!current) {
      withheld.push(withheldItem(candidate.identity, 'blocked', 'record_missing', 'candidate disappeared before the final barrier'));
      continue;
    }
    if (fingerprintOf(current) !== item.fingerprint) {
      withheld.push(withheldItem(candidate.identity, 'blocked', 'classification_changed', 'classification changed before the final barrier'));
      continue;
    }
    const trusted = trustedRecord(current);
    if (!trusted) {
      withheld.push(withheldItem(candidate.identity, 'blocked', 'invalid_classification', 'classification is no longer trusted at the final barrier'));
      continue;
    }
    survivors.push({
      ...item,
      classification: trusted.record,
      fingerprint: trusted.fingerprint,
      confirmedDomains: trusted.confirmedLinks.map((link) => link.domainId),
      claims: trusted.confirmedLinks.map((link) => ({
        domainId: link.domainId,
        claimVerification: link.claimVerification,
      })),
    });
  }
  if (survivors.length + withheld.length !== accepted.size) {
    return {
      ok: false,
      globalReason: 'store_error',
      globalDetail: 'final barrier did not account for every accepted item',
      items: [],
      withheld: [],
    };
  }
  return { ok: true, globalReason: null, globalDetail: null, items: survivors, withheld };
}

export async function readVerifiedDomainSources(
  store: SourceDomainReadStore,
  provider: TrustedSourceReadbackProvider | null | undefined,
  query: SourceDomainBatchQuery,
  options: SourceDomainConsumerOptions = {},
): Promise<SourceDomainBatchResult> {
  const config = normalizeOptions(options);
  const startedAt = config?.now() ?? (options.now ?? Date.now)();
  const requestedCursor = options.cursor ?? null;
  if (!config) {
    return batchRejected('blocked', 'invalid_options', 'consumer options are outside the approved bounds', null, requestedCursor, startedAt, options.now ?? Date.now);
  }
  const { now } = config;
  if (!isNonEmptyText(query.bankId) || !isNonEmptyText(query.endpoint)
    || !Array.isArray(query.domains) || query.domains.length === 0) {
    return batchRejected('blocked', 'invalid_query', 'source identity and at least one domain are required', config, requestedCursor, startedAt, now);
  }
  let domains: DomainId[];
  try {
    domains = normalizeDomains(query.domains);
  } catch (error) {
    return batchRejected('blocked', 'invalid_query', detailOf(error), config, requestedCursor, startedAt, now);
  }
  if (!provider) {
    return batchRejected('unavailable', 'provider_missing', 'no trusted asynchronous readback provider is configured', config, requestedCursor, startedAt, now);
  }
  if (sourceDomainReadStoreUsesSyncReadback(store)) {
    return batchRejected('blocked', 'sync_store_provider_unsupported', 'the raw store still has a synchronous reentrant readback provider', config, requestedCursor, startedAt, now);
  }
  if (config.signal.aborted) {
    return batchRejected('unavailable', 'cancelled', 'consumer call has already been cancelled', config, requestedCursor, startedAt, now);
  }

  const deadlineAt = startedAt + config.timeBudgetMs;
  const candidates: CandidateSnapshot[] = [];
  const verified: VerifiedSourceDomainItem[] = [];
  const withheld: WithheldSourceDomainItem[] = [];
  let cursor = config.cursor;
  let pagesRead = 0;
  let scanned = 0;
  let filteredRows = 0;
  let lastConsumed: string | null = null;
  let complete = false;
  let stopReason: SourceDomainStopReason | null = null;
  let global: { status: 'blocked' | 'unavailable'; reason: SourceDomainConsumerReason; detail: string | null } | null = null;

  while (true) {
    if (global || complete || stopReason) break;
    if (pagesRead >= config.maxPages) {
      stopReason = 'max_pages';
      break;
    }
    if (scanned >= config.maxItems) {
      stopReason = 'item_limit';
      break;
    }
    if (config.signal.aborted) {
      global = { status: 'unavailable', reason: 'cancelled', detail: null };
      break;
    }
    if (now() >= deadlineAt) {
      stopReason = 'time_budget';
      break;
    }
    const remainingItems = config.maxItems - scanned;
    const requestedLimit = Math.min(config.pageSize, remainingItems);
    let page;
    try {
      page = store.listDomainSources(query.bankId, query.endpoint, domains, { limit: requestedLimit, cursor });
    } catch (error) {
      global = { status: 'blocked', reason: 'store_error', detail: detailOf(error) };
      break;
    }
    pagesRead += 1;
    filteredRows += page.filtered;
    if (page.blocked) {
      global = { status: 'blocked', reason: 'store_blocked', detail: 'the raw store blocked domain reads' };
      break;
    }
    if (page.items.length === 0) {
      complete = page.complete;
      cursor = page.nextCursor ?? '';
      if (!complete) {
        stopReason = 'page_limit';
      }
      break;
    }

    for (const listed of page.items) {
      if (global || stopReason) break;
      if (scanned >= config.maxItems) {
        stopReason = 'item_limit';
        break;
      }
      if (config.signal.aborted) {
        global = { status: 'unavailable', reason: 'cancelled', detail: null };
        break;
      }
      if (now() >= deadlineAt) {
        stopReason = 'time_budget';
        break;
      }
      const source = identityOf(listed);
      const snapshot = snapshotOutcome(store, source);
      scanned += 1;
      lastConsumed = listed.documentId;
      if (!snapshot.ok) {
        if (snapshot.global) {
          global = { status: 'blocked', reason: snapshot.reason, detail: snapshot.detail };
          break;
        }
        withheld.push(withheldItem(source, 'blocked', snapshot.reason, snapshot.detail));
        continue;
      }
      if (fingerprintOf(listed) !== snapshot.snapshot.fingerprint) {
        withheld.push(withheldItem(source, 'blocked', 'classification_changed', 'index row changed before readback'));
        continue;
      }
      candidates.push(snapshot.snapshot);
      const outcome = await verifySnapshot(store, provider, snapshot.snapshot, config, deadlineAt);
      if (outcome.status === 'verified') {
        verified.push(outcome.item);
      } else if (outcome.global) {
        global = { status: outcome.status, reason: outcome.reason, detail: outcome.detail };
        break;
      } else {
        withheld.push(withheldItem(source, 'blocked', outcome.reason, outcome.detail));
      }
    }

    if (global || stopReason) break;
    complete = page.complete;
    cursor = page.nextCursor ?? '';
    if (complete) break;
    if (!page.nextCursor) {
      stopReason = 'page_limit';
      break;
    }
    if (scanned >= config.maxItems) {
      stopReason = 'item_limit';
      break;
    }
  }

  if (global) {
    return batchRejected(global.status, global.reason, global.detail, config, requestedCursor, startedAt, now, 'not_run');
  }

  let finalBarrier: 'passed' | 'failed' | 'not_run' = 'not_run';
  let items = verified;
  if (verified.length > 0) {
    const barrier = runFinalBarrier(store, candidates, verified);
    if (!barrier.ok) {
      return batchRejected('blocked', barrier.globalReason ?? 'store_error', barrier.globalDetail, config, requestedCursor, startedAt, now, 'failed');
    }
    finalBarrier = 'passed';
    items = barrier.items;
    withheld.push(...barrier.withheld);
  }

  if (!complete && stopReason === null) stopReason = 'page_limit';
  const truncated = !complete;
  const nextCursor = complete ? null : (lastConsumed ?? (cursor || null));
  let status: SourceDomainBatchStatus;
  let reason: SourceDomainConsumerReason | null;
  let detail: string | null = null;
  const filtered = filteredRows > 0;
  if (items.length === 0) {
    if (withheld.length > 0) {
      status = withheld.some((entry) => entry.status === 'blocked') ? 'blocked' : 'unavailable';
      reason = withheld[0]!.reason;
    } else if (complete && filtered) {
      status = 'blocked';
      reason = 'record_missing';
      detail = `the raw store filtered ${filteredRows} candidate rows and returned none`;
    } else if (complete) {
      status = 'verified';
      reason = null;
    } else {
      status = 'incomplete';
      reason = stopReason ?? 'page_limit';
    }
  } else if (withheld.length === 0 && complete && !filtered) {
    status = 'verified';
    reason = null;
  } else {
    status = 'incomplete';
    reason = stopReason ?? (withheld[0]?.reason ?? (filtered ? 'record_missing' : null));
    if (filtered) detail = `the raw store filtered ${filteredRows} candidate rows`;
  }

  return {
    status,
    reason,
    detail,
    items,
    withheld,
    finalBarrier,
    page: batchPage(config, requestedCursor, {
      pagesRead,
      scanned,
      returned: items.length,
      filtered: filteredRows,
      nextCursor,
      complete,
      truncated,
      stopReason,
    }),
    elapsedMs: Math.max(0, now() - startedAt),
  };
}
