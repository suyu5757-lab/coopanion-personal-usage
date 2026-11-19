/**
 * Proposes source-level memory domains from a trusted readback.
 *
 * The caller supplies the same asynchronous readback boundary used by D3-S1. This
 * module validates identity, epoch, revision, actor, kind, status and UTF-16 spans,
 * then returns a proposal. It never writes a store row and never calls the D3-S1
 * consumer: a first classification starts from source identity and body, while the
 * consumer remains the final barrier for persisted confirmed links.
 *
 * A link is confirmed only by a rule in the approved registry and only when the
 * source passes every safety check. Unknown, unapproved, conflicted or out-of-scope
 * rules produce candidate links. A missing safety context also prevents confirmation,
 * so a caller cannot turn an unverified source into a confirmed proposal.
 */
import { createHash } from 'node:crypto';
import {
  MEMORY_DOMAIN_TAXONOMY,
  isDomainId,
  type ClaimVerification,
  type DomainId,
  type SourceDomainLinkState,
  type SourceDomainState,
} from './source-domains.ts';
import type {
  SourceDomainIdentity,
  TrustedSourceReadbackEvidence,
  TrustedSourceReadbackProvider,
} from './source-domain-consumer.ts';

export const AUTO_DOMAIN_CLASSIFIER_VERSION = 'source-domain-auto-classifier/v1';
export const AUTO_DOMAIN_RULE_SET_VERSION = 'A1-v1.0.6-draft/approved-contract-5';
export const AUTO_DOMAIN_CONFIDENCE_SEMANTICS = 'provider_heuristic_not_accuracy';

const RUBRIC_PATH = '03_taxonomy/annotator_rubric.csv';
const RUBRIC_SHA256 = '71dbaac34fef6269604d865d58ed57e3248993018d52cbe71746d3a4385f2935';
const RULE_VERSION = 'A1-v1.0.6-draft';

export type SourceActorClass = 'user' | 'coo' | 'derived' | 'other';

export type AutoDomainUncertaintyCode =
  | 'claim_verification_downgraded'
  | 'capability_claim'
  | 'derived_source'
  | 'downstream_user_gate'
  | 'evidence_ambiguous'
  | 'model_uncertain'
  | 'rule_conflict'
  | 'rule_scope_mismatch'
  | 'rule_unapproved'
  | 'rule_unknown'
  | 'rule_untrusted'
  | 'safety_context_missing'
  | 'stability_unverified';

export type AutoDomainReason =
  | 'cancelled'
  | 'content_empty'
  | 'duplicate_domain'
  | 'epoch_mismatch'
  | 'evidence_invalid'
  | 'fenced'
  | 'identity_mismatch'
  | 'invalid_options'
  | 'invalid_query'
  | 'kind_invalid'
  | 'provider_error'
  | 'provider_missing'
  | 'provider_timeout'
  | 'readback_error'
  | 'readback_missing'
  | 'readback_timeout'
  | 'revision_mismatch'
  | 'rule_domain_mismatch'
  | 'rule_rejected'
  | 'safety_error'
  | 'source_changed'
  | 'status_invalid'
  | 'suggestion_invalid'
  | 'superseded'
  | 'time_budget'
  | 'actor_invalid';

export interface SourceDomainRuleAuthority {
  ruleId: string;
  domainId: DomainId;
  approval: 'APPROVED_CONTRACT' | 'PROPOSAL_NOT_APPROVED' | 'SOURCE_UNAVAILABLE';
  version: string;
  sourcePath: string;
  sourceSha256: string;
  conflict: string | null;
  /** Actor classes that can confirm this rule. */
  confirmedActors: readonly SourceActorClass[];
  /** Normalized source kinds that can confirm this rule. */
  confirmedKinds: readonly string[];
  /** UR-01 records the user's own preference, so its span must be user-verified. */
  requiresUserVerifiedClaim: boolean;
}

/**
 * The five domain-subject rules whose evidence_level is APPROVED_CONTRACT in the
 * current A1 rubric. The remaining 59 rules are proposals and stay candidate-only.
 * The rubric and taxonomy documents are still marked A1_RULE_EXAMPLE_CONFLICT_GATED.
 *
 * These definitions are the private trusted root. They are cloned into a separate
 * deeply frozen public export below; caller mutation of that export cannot change
 * the authority used for confirmation decisions.
 */
const TRUSTED_APPROVED_RULE_DEFINITIONS: readonly SourceDomainRuleAuthority[] = [
  {
    ruleId: 'UR-01',
    domainId: 'user-relationship',
    approval: 'APPROVED_CONTRACT',
    version: RULE_VERSION,
    sourcePath: RUBRIC_PATH,
    sourceSha256: RUBRIC_SHA256,
    conflict: null,
    confirmedActors: ['user'],
    confirmedKinds: ['event', 'correction', 'preference'],
    requiresUserVerifiedClaim: true,
  },
  {
    ruleId: 'PF-01',
    domainId: 'project-functional',
    approval: 'APPROVED_CONTRACT',
    version: RULE_VERSION,
    sourcePath: RUBRIC_PATH,
    sourceSha256: RUBRIC_SHA256,
    conflict: null,
    confirmedActors: ['user', 'coo'],
    confirmedKinds: ['event', 'correction', 'plan', 'reflection', 'self_report'],
    requiresUserVerifiedClaim: false,
  },
  {
    ruleId: 'SM-01',
    domainId: 'skill-methods',
    approval: 'APPROVED_CONTRACT',
    version: RULE_VERSION,
    sourcePath: RUBRIC_PATH,
    sourceSha256: RUBRIC_SHA256,
    conflict: null,
    confirmedActors: ['user', 'coo'],
    confirmedKinds: ['event', 'correction', 'plan', 'reflection', 'self_report'],
    requiresUserVerifiedClaim: false,
  },
  {
    ruleId: 'SC-01',
    domainId: 'social-context',
    approval: 'APPROVED_CONTRACT',
    version: RULE_VERSION,
    sourcePath: RUBRIC_PATH,
    sourceSha256: RUBRIC_SHA256,
    conflict: null,
    confirmedActors: ['user', 'coo'],
    confirmedKinds: ['event', 'correction', 'reflection'],
    requiresUserVerifiedClaim: false,
  },
  {
    ruleId: 'SG-01',
    domainId: 'self-growth',
    approval: 'APPROVED_CONTRACT',
    version: RULE_VERSION,
    sourcePath: RUBRIC_PATH,
    sourceSha256: RUBRIC_SHA256,
    conflict: null,
    confirmedActors: ['coo'],
    confirmedKinds: ['reflection', 'plan', 'self_report'],
    requiresUserVerifiedClaim: false,
  },
];

function frozenRuleAuthority(rule: SourceDomainRuleAuthority): SourceDomainRuleAuthority {
  return Object.freeze({
    ...rule,
    confirmedActors: Object.freeze([...rule.confirmedActors]),
    confirmedKinds: Object.freeze([...rule.confirmedKinds]),
  }) as SourceDomainRuleAuthority;
}

const TRUSTED_APPROVED_RULES_INTERNAL: readonly SourceDomainRuleAuthority[] = Object.freeze(
  TRUSTED_APPROVED_RULE_DEFINITIONS.map((rule) => frozenRuleAuthority(rule)),
);

const TRUSTED_APPROVED_RULE_MAP: ReadonlyMap<string, SourceDomainRuleAuthority> = new Map(
  TRUSTED_APPROVED_RULES_INTERNAL.map((rule) => [rule.ruleId, rule]),
);

/**
 * Public, deeply frozen copy for callers. Production confirmation never consults
 * this export; it uses the private snapshot above.
 */
export const APPROVED_SOURCE_DOMAIN_RULES: readonly SourceDomainRuleAuthority[] = Object.freeze(
  TRUSTED_APPROVED_RULES_INTERNAL.map((rule) => frozenRuleAuthority(rule)),
);

/** Approved invariants that are enforced in code rather than by a domain cue. */
export const APPROVED_INVARIANT_RULE_IDS = [
  'ST-AS-01',
  'ST-AS-02',
  'ST-UN-01',
  'SRC-05',
  'ID-02',
  'TIME-01',
  'TIME-02',
  'TIME-03',
  'TIME-04',
  'SKILL-01',
  'SAFE-04',
] as const;

export interface SourceDomainSuggestionInput {
  domainId: DomainId;
  ruleId: string;
  /** UTF-16 code-unit offsets into the verified source body; end is exclusive. */
  evidenceStart: number;
  evidenceEnd: number;
  confidence?: number | null;
  claimVerification?: ClaimVerification;
  uncertainty?: AutoDomainUncertaintyCode | readonly AutoDomainUncertaintyCode[];
  capabilityClaim?: boolean;
}

export interface AutoDomainSuggestionContext {
  signal: AbortSignal;
  deadlineAt: number;
}

export type SourceDomainSuggestionProvider = (
  snapshot: Readonly<TrustedSourceSnapshot>,
  context: Readonly<AutoDomainSuggestionContext>,
) => Promise<readonly SourceDomainSuggestionInput[] | null> | readonly SourceDomainSuggestionInput[] | null;

export interface TrustedSourceSnapshot extends SourceDomainIdentity {
  content: string;
  sourceRevision: string;
  sourceEpoch: number;
  sourceActor: string;
  sourceKind: string;
  sourceStatus: string;
}

export interface SourceDomainSuggestionLink {
  domainId: DomainId;
  linkState: SourceDomainLinkState;
  confidence: number | null;
  ruleId: string;
  ruleVersion: string;
  ruleApproval: SourceDomainRuleAuthority['approval'] | 'UNKNOWN';
  ruleConflict: string | null;
  evidenceStart: number;
  evidenceEnd: number;
  evidenceQuote: string;
  evidenceDigest: string;
  claimVerification: ClaimVerification;
  uncertainty: AutoDomainUncertaintyCode[];
  capabilityClaim: boolean;
}

export interface SourceDomainSuggestion {
  processed: true;
  state: SourceDomainState;
  bankId: string;
  endpoint: string;
  documentId: string;
  sourceRevision: string;
  sourceEpoch: number;
  sourceActor: string;
  sourceKind: string;
  sourceStatus: string;
  taxonomyVersion: string;
  ruleSetVersion: string;
  classifierVersion: string;
  confidence: number | null;
  confidenceSemantics: string;
  links: SourceDomainSuggestionLink[];
  uncertainty: AutoDomainUncertaintyCode[];
  externalFactsVerified: false;
  sourceStabilityVerified: boolean;
  persistence: {
    eligible: boolean;
    reason: string;
    consumerUserGate: true;
    storeWriteRequiresUserEvent: true;
  };
  permissions: {
    toolExecutionGranted: false;
    actionGateRequired: true;
    capabilityClaimIsNotVerifiedCapability: true;
  };
  proposedAt: string;
}

export interface AutoDomainSuggestedResult {
  outcome: 'suggested';
  suggestion: SourceDomainSuggestion;
  reason: null;
  detail: null;
  elapsedMs: number;
}

export interface AutoDomainRejectedResult {
  outcome: 'blocked' | 'unavailable';
  suggestion: null;
  reason: AutoDomainReason;
  detail: string | null;
  elapsedMs: number;
}

export type AutoDomainResult = AutoDomainSuggestedResult | AutoDomainRejectedResult;

export interface AutoDomainClassificationRequest extends SourceDomainIdentity {
  expectedSourceRevision?: string;
  expectedSourceEpoch?: number;
}

export interface AutoDomainSafetyContext {
  /** Durable Forget epoch for the bank namespace. */
  epoch: (bankId: string, endpoint: string) => number;
  isFenced: (source: Readonly<SourceDomainIdentity>) => boolean;
  isSuperseded: (source: Readonly<SourceDomainIdentity>) => boolean;
}

export interface AutoDomainClassifierOptions {
  readback: TrustedSourceReadbackProvider | null | undefined;
  suggester: SourceDomainSuggestionProvider | null | undefined;
  rules?: readonly SourceDomainRuleAuthority[];
  safety?: AutoDomainSafetyContext;
  /** Per readback or suggestion call. Range 1..30000 ms; default 2000. */
  providerTimeoutMs?: number;
  /** Total budget for one classification. Range 1..60000 ms; default 5000. */
  timeBudgetMs?: number;
  /** Read the source again after suggesting and discard a changed proposal. Default true. */
  verifySourceStability?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

export interface AutoDomainBatchResult {
  outcome: 'suggested' | 'partial' | 'blocked' | 'unavailable';
  suggestions: SourceDomainSuggestion[];
  withheld: Array<{
    bankId: string;
    endpoint: string;
    documentId: string;
    reason: AutoDomainReason;
    detail: string | null;
  }>;
  scanned: number;
  stopReason: 'cancelled' | 'item_limit' | 'time_budget' | null;
  elapsedMs: number;
}

interface NormalizedOptions {
  readback: TrustedSourceReadbackProvider | null;
  suggester: SourceDomainSuggestionProvider | null;
  rules: ReadonlyMap<string, SourceDomainRuleAuthority>;
  rulesTrustedForConfirmation: boolean;
  ruleSetVersion: string;
  safety: AutoDomainSafetyContext | null;
  providerTimeoutMs: number;
  timeBudgetMs: number;
  verifySourceStability: boolean;
  signal: AbortSignal;
  now: () => number;
}

type ProviderOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

const ACTIVE_SOURCE_STATUSES = new Set(['current', 'completed']);
const KNOWN_SOURCE_KINDS = new Set([
  'correction',
  'event',
  'fact',
  'plan',
  'preference',
  'reflection',
  'report',
  'self_report',
]);
const CLAIM_VERIFICATIONS = new Set<ClaimVerification>(['user_verified', 'external_unverified']);
const UNCERTAINTY_CODES = new Set<AutoDomainUncertaintyCode>([
  'claim_verification_downgraded',
  'capability_claim',
  'derived_source',
  'downstream_user_gate',
  'evidence_ambiguous',
  'model_uncertain',
  'rule_conflict',
  'rule_scope_mismatch',
  'rule_unapproved',
  'rule_unknown',
  'rule_untrusted',
  'safety_context_missing',
  'stability_unverified',
]);
const RULE_APPROVALS = new Set<SourceDomainRuleAuthority['approval']>([
  'APPROVED_CONTRACT',
  'PROPOSAL_NOT_APPROVED',
  'SOURCE_UNAVAILABLE',
]);
const ACTOR_CLASSES = new Set<SourceActorClass>(['user', 'coo', 'derived', 'other']);
const OPTION_LIMITS = {
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

function option(
  value: number | undefined,
  limits: { min: number; max: number; fallback: number },
): number | null {
  const resolved = value ?? limits.fallback;
  return Number.isInteger(resolved) && resolved >= limits.min && resolved <= limits.max ? resolved : null;
}

function actorClassOf(actor: string): SourceActorClass {
  if (actor === 'user' || actor === 'synthetic_user') return 'user';
  if (actor === 'coo' || actor === 'agent' || actor === 'synthetic_agent') return 'coo';
  if (actor === 'inference') return 'derived';
  return 'other';
}

function normalizeKind(kind: string): string {
  if (kind === 'synthetic_self_report') return 'self_report';
  if (kind === 'synthetic_reflection') return 'reflection';
  if (kind === 'synthetic_report') return 'report';
  return kind;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizeUncertainty(
  value: AutoDomainUncertaintyCode | readonly AutoDomainUncertaintyCode[] | undefined,
): AutoDomainUncertaintyCode[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  const unique: AutoDomainUncertaintyCode[] = [];
  for (const code of values) {
    if (!UNCERTAINTY_CODES.has(code)) throw new Error(`unknown uncertainty code: ${String(code)}`);
    if (!unique.includes(code)) unique.push(code);
  }
  return unique;
}

function ruleMapOf(rules: readonly SourceDomainRuleAuthority[]): Map<string, SourceDomainRuleAuthority> | null {
  const map = new Map<string, SourceDomainRuleAuthority>();
  for (const rule of rules) {
    if (!isNonEmptyText(rule.ruleId) || !isDomainId(rule.domainId)
      || !RULE_APPROVALS.has(rule.approval) || !isNonEmptyText(rule.version)
      || !isNonEmptyText(rule.sourcePath) || !/^[0-9a-f]{64}$/.test(rule.sourceSha256)
      || (rule.conflict !== null && typeof rule.conflict !== 'string')
      || !Array.isArray(rule.confirmedActors) || rule.confirmedActors.length === 0
      || rule.confirmedActors.some((actor) => !ACTOR_CLASSES.has(actor))
      || !Array.isArray(rule.confirmedKinds) || rule.confirmedKinds.length === 0
      || rule.confirmedKinds.some((kind) => !isNonEmptyText(kind))
      || typeof rule.requiresUserVerifiedClaim !== 'boolean') {
      return null;
    }
    if (map.has(rule.ruleId)) return null;
    map.set(rule.ruleId, rule);
  }
  return map;
}

function normalizeOptions(options: AutoDomainClassifierOptions): NormalizedOptions | null {
  const providerTimeoutMs = option(options.providerTimeoutMs, OPTION_LIMITS.providerTimeoutMs);
  const timeBudgetMs = option(options.timeBudgetMs, OPTION_LIMITS.timeBudgetMs);
  if (providerTimeoutMs === null || timeBudgetMs === null) return null;
  const customRules = options.rules !== undefined;
  const rules = customRules ? ruleMapOf(options.rules!) : TRUSTED_APPROVED_RULE_MAP;
  if (!rules) return null;
  const now = options.now ?? Date.now;
  if (typeof now !== 'function' || !Number.isFinite(now())) return null;
  const safety = options.safety;
  if (safety !== undefined && (typeof safety.epoch !== 'function'
    || typeof safety.isFenced !== 'function' || typeof safety.isSuperseded !== 'function')) {
    return null;
  }
  return {
    readback: options.readback ?? null,
    suggester: options.suggester ?? null,
    rules,
    rulesTrustedForConfirmation: !customRules,
    ruleSetVersion: customRules ? 'custom-rule-table' : AUTO_DOMAIN_RULE_SET_VERSION,
    safety: safety ?? null,
    providerTimeoutMs,
    timeBudgetMs,
    verifySourceStability: options.verifySourceStability !== false,
    signal: options.signal ?? new AbortController().signal,
    now,
  };
}

function callWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T> | T,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<ProviderOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const finish = (outcome: ProviderOutcome<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      parentSignal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      controller.abort();
      finish({ kind: 'cancelled' });
    };
    if (parentSignal.aborted) {
      finish({ kind: 'cancelled' });
      return;
    }
    parentSignal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      finish({ kind: 'timeout' });
    }, timeoutMs);

    Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        (value) => finish({ kind: 'value', value }),
        (error) => finish({ kind: 'error', detail: detailOf(error) }),
      );
  });
}

function remainingFor(options: NormalizedOptions, deadlineAt: number): number {
  return Math.min(options.providerTimeoutMs, deadlineAt - options.now());
}

function identityOf(source: SourceDomainIdentity): SourceDomainIdentity {
  return { bankId: source.bankId, endpoint: source.endpoint, documentId: source.documentId };
}

function snapshotFrom(
  evidence: TrustedSourceReadbackEvidence,
  revision: string,
): TrustedSourceSnapshot {
  return {
    bankId: evidence.bankId,
    endpoint: evidence.endpoint,
    documentId: evidence.documentId,
    content: evidence.content,
    sourceRevision: revision,
    sourceEpoch: evidence.sourceEpoch,
    sourceActor: evidence.sourceActor,
    sourceKind: evidence.sourceKind,
    sourceStatus: evidence.sourceStatus,
  };
}

function validateReadbackShape(
  evidence: TrustedSourceReadbackEvidence,
): AutoDomainReason | null {
  if (!evidence || typeof evidence !== 'object'
    || !isNonEmptyText(evidence.bankId) || !isNonEmptyText(evidence.endpoint)
    || !isNonEmptyText(evidence.documentId) || typeof evidence.content !== 'string'
    || !Number.isInteger(evidence.sourceEpoch) || evidence.sourceEpoch < 0
    || typeof evidence.sourceActor !== 'string' || typeof evidence.sourceKind !== 'string'
    || typeof evidence.sourceStatus !== 'string'
    || (evidence.sourceRevision !== undefined && typeof evidence.sourceRevision !== 'string')) {
    return 'evidence_invalid';
  }
  return null;
}

function safetyCheck(
  identity: SourceDomainIdentity,
  snapshot: TrustedSourceSnapshot,
  safety: AutoDomainSafetyContext,
): { ok: true } | { ok: false; reason: AutoDomainReason; detail: string | null } {
  try {
    const epoch = safety.epoch(snapshot.bankId, snapshot.endpoint);
    if (!Number.isInteger(epoch) || epoch < 0) {
      return { ok: false, reason: 'safety_error', detail: 'safety epoch is not a non-negative integer' };
    }
    if (epoch !== snapshot.sourceEpoch) {
      return { ok: false, reason: 'epoch_mismatch', detail: 'source epoch does not match the durable epoch' };
    }
    if (safety.isFenced(identity)) {
      return { ok: false, reason: 'fenced', detail: 'source is fenced' };
    }
    if (safety.isSuperseded(identity)) {
      return { ok: false, reason: 'superseded', detail: 'source is superseded' };
    }
  } catch (error) {
    return { ok: false, reason: 'safety_error', detail: detailOf(error) };
  }
  return { ok: true };
}

async function readTrustedSnapshot(
  request: AutoDomainClassificationRequest,
  options: NormalizedOptions,
  deadlineAt: number,
): Promise<
  | { ok: true; snapshot: TrustedSourceSnapshot }
  | { ok: false; outcome: 'blocked' | 'unavailable'; reason: AutoDomainReason; detail: string | null }
> {
  if (!options.readback) {
    return { ok: false, outcome: 'unavailable', reason: 'readback_missing', detail: 'no trusted readback provider is configured' };
  }
  const remaining = remainingFor(options, deadlineAt);
  if (remaining <= 0) {
    return { ok: false, outcome: 'unavailable', reason: 'time_budget', detail: 'time budget expired before readback' };
  }
  const identity = identityOf(request);
  const outcome = await callWithTimeout(
    (signal) => options.readback!(identity, { signal, deadlineAt }),
    options.signal,
    remaining,
  );
  if (outcome.kind === 'cancelled') {
    return { ok: false, outcome: 'unavailable', reason: 'cancelled', detail: null };
  }
  if (outcome.kind === 'timeout') {
    return { ok: false, outcome: 'unavailable', reason: 'readback_timeout', detail: null };
  }
  if (outcome.kind === 'error') {
    return { ok: false, outcome: 'blocked', reason: 'readback_error', detail: outcome.detail };
  }
  if (outcome.value === null || outcome.value === undefined) {
    return { ok: false, outcome: 'blocked', reason: 'readback_missing', detail: 'readback returned no evidence' };
  }
  const evidence = outcome.value;
  const shape = validateReadbackShape(evidence);
  if (shape) {
    return { ok: false, outcome: 'blocked', reason: shape, detail: 'readback evidence has an invalid shape' };
  }
  if (evidence.bankId !== identity.bankId || evidence.endpoint !== identity.endpoint
    || evidence.documentId !== identity.documentId) {
    return { ok: false, outcome: 'blocked', reason: 'identity_mismatch', detail: 'readback identity does not match the request tuple' };
  }
  if (evidence.content.trim().length === 0) {
    return { ok: false, outcome: 'blocked', reason: 'content_empty', detail: 'readback body is empty' };
  }
  const revision = hash(evidence.content);
  if (evidence.sourceRevision !== undefined && evidence.sourceRevision !== revision) {
    return { ok: false, outcome: 'blocked', reason: 'revision_mismatch', detail: 'provider-supplied revision does not match the readback body' };
  }
  if (request.expectedSourceRevision !== undefined && request.expectedSourceRevision !== revision) {
    return { ok: false, outcome: 'blocked', reason: 'revision_mismatch', detail: 'expected revision does not match the readback body' };
  }
  if (request.expectedSourceEpoch !== undefined && request.expectedSourceEpoch !== evidence.sourceEpoch) {
    return { ok: false, outcome: 'blocked', reason: 'epoch_mismatch', detail: 'expected epoch does not match the readback epoch' };
  }
  if (!ACTIVE_SOURCE_STATUSES.has(evidence.sourceStatus)) {
    return { ok: false, outcome: 'blocked', reason: 'status_invalid', detail: `source status ${evidence.sourceStatus} is not current` };
  }
  const actorClass = actorClassOf(evidence.sourceActor);
  if (actorClass === 'other') {
    return { ok: false, outcome: 'blocked', reason: 'actor_invalid', detail: `source actor ${evidence.sourceActor} is not user, coo or inference` };
  }
  const kind = normalizeKind(evidence.sourceKind);
  if (!KNOWN_SOURCE_KINDS.has(kind)) {
    return { ok: false, outcome: 'blocked', reason: 'kind_invalid', detail: `source kind ${evidence.sourceKind} is not recognized` };
  }
  const snapshot = snapshotFrom(evidence, revision);
  if (options.safety) {
    const safety = safetyCheck(identity, snapshot, options.safety);
    if (!safety.ok) return { ok: false, outcome: 'blocked', reason: safety.reason, detail: safety.detail };
  }
  return { ok: true, snapshot };
}

async function verifyStability(
  snapshot: TrustedSourceSnapshot,
  options: NormalizedOptions,
  deadlineAt: number,
): Promise<{ ok: true } | { ok: false; reason: AutoDomainReason; detail: string | null }> {
  if (!options.readback) {
    return { ok: false, reason: 'readback_missing', detail: 'no trusted readback provider is configured' };
  }
  const remaining = remainingFor(options, deadlineAt);
  if (remaining <= 0) {
    return { ok: false, reason: 'time_budget', detail: 'time budget expired before the stability readback' };
  }
  const identity = identityOf(snapshot);
  const outcome = await callWithTimeout(
    (signal) => options.readback!(identity, { signal, deadlineAt }),
    options.signal,
    remaining,
  );
  if (outcome.kind === 'cancelled') return { ok: false, reason: 'cancelled', detail: null };
  if (outcome.kind === 'timeout') return { ok: false, reason: 'readback_timeout', detail: null };
  if (outcome.kind === 'error') return { ok: false, reason: 'readback_error', detail: outcome.detail };
  if (outcome.value === null || outcome.value === undefined) {
    return { ok: false, reason: 'source_changed', detail: 'source disappeared before the stability check' };
  }
  const evidence = outcome.value;
  const shape = validateReadbackShape(evidence);
  if (shape) return { ok: false, reason: shape, detail: 'stability readback has an invalid shape' };
  if (evidence.bankId !== snapshot.bankId || evidence.endpoint !== snapshot.endpoint
    || evidence.documentId !== snapshot.documentId) {
    return { ok: false, reason: 'identity_mismatch', detail: 'stability readback identity changed' };
  }
  const revision = hash(evidence.content);
  if (revision !== snapshot.sourceRevision) {
    return { ok: false, reason: 'source_changed', detail: 'source body changed after the proposal' };
  }
  if (evidence.sourceRevision !== undefined && evidence.sourceRevision !== revision) {
    return { ok: false, reason: 'revision_mismatch', detail: 'provider-supplied revision does not match the stability readback body' };
  }
  if (evidence.sourceEpoch !== snapshot.sourceEpoch) {
    return { ok: false, reason: 'epoch_mismatch', detail: 'source epoch changed after the proposal' };
  }
  if (normalizeKind(evidence.sourceKind) !== normalizeKind(snapshot.sourceKind)
    || evidence.sourceActor !== snapshot.sourceActor || evidence.sourceStatus !== snapshot.sourceStatus) {
    return { ok: false, reason: 'source_changed', detail: 'source metadata changed after the proposal' };
  }
  if (options.safety) {
    const safety = safetyCheck(identity, snapshot, options.safety);
    if (!safety.ok) return safety;
  }
  return { ok: true };
}

function linkFrom(
  snapshot: TrustedSourceSnapshot,
  rules: ReadonlyMap<string, SourceDomainRuleAuthority>,
  rulesTrustedForConfirmation: boolean,
  safetyAvailable: boolean,
  input: SourceDomainSuggestionInput,
): SourceDomainSuggestionLink {
  if (!isDomainId(input.domainId)) throw new Error(`unknown memory domain: ${String(input.domainId)}`);
  if (!isNonEmptyText(input.ruleId)) throw new Error('ruleId must be a non-empty string');
  if (!Number.isInteger(input.evidenceStart) || !Number.isInteger(input.evidenceEnd)
    || input.evidenceStart < 0 || input.evidenceEnd <= input.evidenceStart
    || input.evidenceEnd > snapshot.content.length) {
    throw new Error(`link ${input.domainId} has an invalid UTF-16 span`);
  }
  const quote = snapshot.content.slice(input.evidenceStart, input.evidenceEnd);
  if (quote.length === 0 || hasLoneSurrogate(quote)) {
    throw new Error(`link ${input.domainId} has an empty or malformed UTF-16 span`);
  }
  const confidence = input.confidence ?? null;
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error(`link ${input.domainId} confidence is outside [0, 1]`);
  }
  let claimVerification = input.claimVerification ?? 'external_unverified';
  if (!CLAIM_VERIFICATIONS.has(claimVerification)) {
    throw new Error(`link ${input.domainId} claimVerification is invalid`);
  }
  const uncertainty = normalizeUncertainty(input.uncertainty);
  const actorClass = actorClassOf(snapshot.sourceActor);
  const kind = normalizeKind(snapshot.sourceKind);
  const upstreamClaim = claimVerification;

  if (claimVerification === 'user_verified' && actorClass !== 'user') {
    claimVerification = 'external_unverified';
    if (!uncertainty.includes('claim_verification_downgraded')) {
      uncertainty.push('claim_verification_downgraded');
    }
  }

  const rule = rules.get(input.ruleId);
  let ruleApproval: SourceDomainSuggestionLink['ruleApproval'] = 'UNKNOWN';
  let ruleVersion = 'unknown';
  let ruleConflict: string | null = null;
  let confirmable = false;

  if (!rule) {
    if (!uncertainty.includes('rule_unknown')) uncertainty.push('rule_unknown');
  } else {
    if (rule.domainId !== input.domainId) {
      throw new Error(`rule ${rule.ruleId} belongs to ${rule.domainId}, not ${input.domainId}`);
    }
    if (rule.approval === 'SOURCE_UNAVAILABLE') {
      throw new Error(`rule ${rule.ruleId} has no available source evidence`);
    }
    ruleApproval = rule.approval;
    ruleVersion = rule.version;
    ruleConflict = rule.conflict;
    if (rule.approval === 'APPROVED_CONTRACT' && !rulesTrustedForConfirmation) {
      // A caller-supplied table is never an authority root, even when its fields
      // claim approval or copy a built-in rule id byte for byte.
      ruleApproval = 'UNKNOWN';
      if (!uncertainty.includes('rule_untrusted')) uncertainty.push('rule_untrusted');
    }
    if (rule.approval === 'PROPOSAL_NOT_APPROVED' && !uncertainty.includes('rule_unapproved')) {
      uncertainty.push('rule_unapproved');
    }
    if (rule.conflict !== null && !uncertainty.includes('rule_conflict')) {
      uncertainty.push('rule_conflict');
    }
    if (!rule.confirmedActors.includes(actorClass) || !rule.confirmedKinds.includes(kind)) {
      if (!uncertainty.includes('rule_scope_mismatch')) uncertainty.push('rule_scope_mismatch');
    }
    if (rule.requiresUserVerifiedClaim && claimVerification !== 'user_verified') {
      if (!uncertainty.includes('rule_scope_mismatch')) uncertainty.push('rule_scope_mismatch');
    }
    confirmable = rulesTrustedForConfirmation
      && rule.approval === 'APPROVED_CONTRACT'
      && rule.conflict === null
      && rule.confirmedActors.includes(actorClass)
      && rule.confirmedKinds.includes(kind)
      && (!rule.requiresUserVerifiedClaim || claimVerification === 'user_verified')
      && safetyAvailable;
  }

  if (actorClass === 'derived') {
    if (!uncertainty.includes('derived_source')) uncertainty.push('derived_source');
    if (!uncertainty.includes('downstream_user_gate')) uncertainty.push('downstream_user_gate');
    claimVerification = 'external_unverified';
  }
  if (!safetyAvailable && !uncertainty.includes('safety_context_missing')) {
    uncertainty.push('safety_context_missing');
  }
  if (input.capabilityClaim === true && !uncertainty.includes('capability_claim')) {
    uncertainty.push('capability_claim');
  }
  if (upstreamClaim === 'user_verified' && claimVerification !== 'user_verified'
    && !uncertainty.includes('claim_verification_downgraded')) {
    uncertainty.push('claim_verification_downgraded');
  }

  const linkState: SourceDomainLinkState = confirmable && uncertainty.length === 0 ? 'confirmed' : 'candidate';
  return {
    domainId: input.domainId,
    linkState,
    confidence,
    ruleId: input.ruleId,
    ruleVersion,
    ruleApproval,
    ruleConflict,
    evidenceStart: input.evidenceStart,
    evidenceEnd: input.evidenceEnd,
    evidenceQuote: quote,
    evidenceDigest: hash(quote),
    claimVerification,
    uncertainty,
    capabilityClaim: input.capabilityClaim === true,
  };
}

function stateOf(links: readonly SourceDomainSuggestionLink[]): SourceDomainState {
  if (links.length === 0) return 'unclassified';
  const confirmed = links.filter((link) => link.linkState === 'confirmed');
  const candidates = links.filter((link) => link.linkState === 'candidate');
  if (confirmed.length > 0 && candidates.length === 0) return 'assigned';
  if (candidates.some((link) => link.uncertainty.includes('evidence_ambiguous'))) return 'ambiguous';
  return 'pending_review';
}

function overallConfidence(links: readonly SourceDomainSuggestionLink[]): number | null {
  const values = links
    .map((link) => link.confidence)
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.min(...values);
}

function overallUncertainty(
  links: readonly SourceDomainSuggestionLink[],
  safetyAvailable: boolean,
): AutoDomainUncertaintyCode[] {
  const unique: AutoDomainUncertaintyCode[] = [];
  for (const link of links) {
    for (const code of link.uncertainty) if (!unique.includes(code)) unique.push(code);
  }
  if (!safetyAvailable && !unique.includes('safety_context_missing')) unique.push('safety_context_missing');
  return unique;
}

function persistenceFor(
  state: SourceDomainState,
  links: readonly SourceDomainSuggestionLink[],
  actorClass: SourceActorClass,
  kind: string,
  stabilityVerified: boolean,
): SourceDomainSuggestion['persistence'] {
  if (!stabilityVerified) {
    return {
      eligible: false,
      reason: 'source_stability_unverified',
      consumerUserGate: true,
      storeWriteRequiresUserEvent: true,
    };
  }
  if (state !== 'assigned') {
    return { eligible: false, reason: `state_${state}`, consumerUserGate: true, storeWriteRequiresUserEvent: true };
  }
  if (links.some((link) => link.linkState !== 'confirmed')) {
    return { eligible: false, reason: 'candidate_link_present', consumerUserGate: true, storeWriteRequiresUserEvent: true };
  }
  if (actorClass !== 'user') {
    return { eligible: false, reason: 'actor_not_user', consumerUserGate: true, storeWriteRequiresUserEvent: true };
  }
  if (kind !== 'event' && kind !== 'correction') {
    return { eligible: false, reason: 'kind_not_event_or_correction', consumerUserGate: true, storeWriteRequiresUserEvent: true };
  }
  return { eligible: true, reason: 'user_event_confirmed_links', consumerUserGate: true, storeWriteRequiresUserEvent: true };
}

function suggestionFrom(
  snapshot: TrustedSourceSnapshot,
  links: SourceDomainSuggestionLink[],
  safetyAvailable: boolean,
  ruleSetVersion: string,
  now: number,
): SourceDomainSuggestion {
  const state = stateOf(links);
  const actorClass = actorClassOf(snapshot.sourceActor);
  const kind = normalizeKind(snapshot.sourceKind);
  return {
    processed: true,
    state,
    bankId: snapshot.bankId,
    endpoint: snapshot.endpoint,
    documentId: snapshot.documentId,
    sourceRevision: snapshot.sourceRevision,
    sourceEpoch: snapshot.sourceEpoch,
    sourceActor: snapshot.sourceActor,
    sourceKind: snapshot.sourceKind,
    sourceStatus: snapshot.sourceStatus,
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    ruleSetVersion,
    classifierVersion: AUTO_DOMAIN_CLASSIFIER_VERSION,
    confidence: overallConfidence(links),
    confidenceSemantics: AUTO_DOMAIN_CONFIDENCE_SEMANTICS,
    links,
    uncertainty: overallUncertainty(links, safetyAvailable),
    externalFactsVerified: false,
    sourceStabilityVerified: false,
    persistence: persistenceFor(state, links, actorClass, kind, false),
    permissions: {
      toolExecutionGranted: false,
      actionGateRequired: true,
      capabilityClaimIsNotVerifiedCapability: true,
    },
    proposedAt: new Date(now).toISOString(),
  };
}

function withUncertainty(
  values: readonly AutoDomainUncertaintyCode[],
  code: AutoDomainUncertaintyCode,
): AutoDomainUncertaintyCode[] {
  return values.includes(code) ? [...values] : [...values, code];
}

/**
 * Keep the stability flag, link state, aggregate state and persistence reason in
 * one semantic unit. An unverified source may never retain a confirmed link or an
 * eligible persistence decision.
 */
function applyStabilityVerification(
  suggestion: SourceDomainSuggestion,
  stabilityVerified: boolean,
  safetyAvailable: boolean,
): SourceDomainSuggestion {
  const links = stabilityVerified
    ? suggestion.links
    : suggestion.links.map((link) => ({
      ...link,
      linkState: link.linkState === 'confirmed' ? 'candidate' as const : link.linkState,
      uncertainty: withUncertainty(link.uncertainty, 'stability_unverified'),
    }));
  const state = stateOf(links);
  return {
    ...suggestion,
    state,
    links,
    uncertainty: overallUncertainty(links, safetyAvailable),
    sourceStabilityVerified: stabilityVerified,
    persistence: persistenceFor(
      state,
      links,
      actorClassOf(suggestion.sourceActor),
      normalizeKind(suggestion.sourceKind),
      stabilityVerified,
    ),
  };
}

/**
 * Synchronous final return barrier. It rechecks the exact source tuple and the
 * snapshot captured for the proposal against the same safety context after every
 * asynchronous readback/suggester call has completed. Callers must not await after
 * this returns and before constructing the response.
 */
function finalSafetyBarrier(
  snapshot: TrustedSourceSnapshot,
  suggestion: SourceDomainSuggestion,
  safety: AutoDomainSafetyContext | null,
): { ok: true } | { ok: false; reason: AutoDomainReason; detail: string | null } {
  if (suggestion.bankId !== snapshot.bankId || suggestion.endpoint !== snapshot.endpoint
    || suggestion.documentId !== snapshot.documentId
    || suggestion.sourceRevision !== snapshot.sourceRevision
    || suggestion.sourceEpoch !== snapshot.sourceEpoch
    || suggestion.sourceActor !== snapshot.sourceActor
    || suggestion.sourceKind !== snapshot.sourceKind
    || suggestion.sourceStatus !== snapshot.sourceStatus) {
    return { ok: false, reason: 'source_changed', detail: 'suggestion snapshot does not match the prepared source snapshot' };
  }
  if (!safety) {
    if (suggestion.persistence.eligible || suggestion.links.some((link) => link.linkState === 'confirmed')) {
      return { ok: false, reason: 'safety_error', detail: 'safety context is missing at the final barrier' };
    }
    return { ok: true };
  }
  return safetyCheck(identityOf(snapshot), snapshot, safety);
}

interface PreparedSuggestion {
  snapshot: TrustedSourceSnapshot;
  suggestion: SourceDomainSuggestion;
}

async function prepareSuggestion(
  request: AutoDomainClassificationRequest,
  options: NormalizedOptions,
  deadlineAt: number,
): Promise<
  | { ok: true; prepared: PreparedSuggestion }
  | { ok: false; outcome: 'blocked' | 'unavailable'; reason: AutoDomainReason; detail: string | null }
> {
  const source = await readTrustedSnapshot(request, options, deadlineAt);
  if (!source.ok) return source;
  if (options.signal.aborted) {
    return { ok: false, outcome: 'unavailable', reason: 'cancelled', detail: null };
  }
  if (options.now() >= deadlineAt) {
    return { ok: false, outcome: 'unavailable', reason: 'time_budget', detail: 'time budget expired before suggestion' };
  }
  if (!options.suggester) {
    return { ok: false, outcome: 'unavailable', reason: 'provider_missing', detail: 'no suggestion provider is configured' };
  }

  const remaining = remainingFor(options, deadlineAt);
  if (remaining <= 0) {
    return { ok: false, outcome: 'unavailable', reason: 'time_budget', detail: 'time budget expired before suggestion' };
  }
  const frozen = Object.freeze({ ...source.snapshot });
  const outcome = await callWithTimeout(
    (signal) => options.suggester!(frozen, { signal, deadlineAt }),
    options.signal,
    remaining,
  );
  if (outcome.kind === 'cancelled') {
    return { ok: false, outcome: 'unavailable', reason: 'cancelled', detail: null };
  }
  if (outcome.kind === 'timeout') {
    return { ok: false, outcome: 'unavailable', reason: 'provider_timeout', detail: null };
  }
  if (outcome.kind === 'error') {
    return { ok: false, outcome: 'blocked', reason: 'provider_error', detail: outcome.detail };
  }
  if (outcome.value === null || outcome.value === undefined) {
    return { ok: false, outcome: 'blocked', reason: 'provider_error', detail: 'suggestion provider returned null' };
  }
  if (!Array.isArray(outcome.value)) {
    return { ok: false, outcome: 'blocked', reason: 'suggestion_invalid', detail: 'suggestion provider must return an array' };
  }

  const seen = new Set<DomainId>();
  const links: SourceDomainSuggestionLink[] = [];
  try {
    for (const input of outcome.value) {
      const link = linkFrom(
        source.snapshot,
        options.rules,
        options.rulesTrustedForConfirmation,
        options.safety !== null,
        input,
      );
      if (seen.has(link.domainId)) {
        return { ok: false, outcome: 'blocked', reason: 'duplicate_domain', detail: `duplicate domain suggestion: ${link.domainId}` };
      }
      seen.add(link.domainId);
      links.push(link);
    }
  } catch (error) {
    const detail = detailOf(error);
    const reason: AutoDomainReason = detail.includes('belongs to')
      ? 'rule_domain_mismatch'
      : detail.includes('no available source evidence')
        ? 'rule_rejected'
        : 'suggestion_invalid';
    return { ok: false, outcome: 'blocked', reason, detail };
  }

  const suggestion = suggestionFrom(source.snapshot, links, options.safety !== null, options.ruleSetVersion, options.now());
  return { ok: true, prepared: { snapshot: source.snapshot, suggestion } };
}

function reject(
  outcome: 'blocked' | 'unavailable',
  reason: AutoDomainReason,
  detail: string | null,
  startedAt: number,
  now: () => number,
): AutoDomainRejectedResult {
  return { outcome, suggestion: null, reason, detail, elapsedMs: Math.max(0, now() - startedAt) };
}

export async function classifySourceDomain(
  request: AutoDomainClassificationRequest,
  options: AutoDomainClassifierOptions,
): Promise<AutoDomainResult> {
  const config = normalizeOptions(options);
  const startedAt = config?.now() ?? (options.now ?? Date.now)();
  if (!config) return reject('blocked', 'invalid_options', 'classifier options are outside the approved bounds', startedAt, options.now ?? Date.now);
  if (!request || typeof request !== 'object'
    || !isNonEmptyText(request.bankId) || !isNonEmptyText(request.endpoint) || !isNonEmptyText(request.documentId)) {
    return reject('blocked', 'invalid_query', 'source identity must contain non-empty strings', startedAt, config.now);
  }
  if (config.signal.aborted) return reject('unavailable', 'cancelled', 'classification has already been cancelled', startedAt, config.now);

  const deadlineAt = startedAt + config.timeBudgetMs;
  if (config.now() >= deadlineAt) return reject('unavailable', 'time_budget', 'time budget expired before readback', startedAt, config.now);

  const prepared = await prepareSuggestion(request, config, deadlineAt);
  if (!prepared.ok) return reject(prepared.outcome, prepared.reason, prepared.detail, startedAt, config.now);

  if (config.verifySourceStability) {
    const stable = await verifyStability(prepared.prepared.snapshot, config, deadlineAt);
    if (!stable.ok) return reject('blocked', stable.reason, stable.detail, startedAt, config.now);
  }

  // No await from here to the returned value: the final safety barrier is synchronous.
  const suggestion = applyStabilityVerification(
    prepared.prepared.suggestion,
    config.verifySourceStability,
    config.safety !== null,
  );
  const barrier = finalSafetyBarrier(prepared.prepared.snapshot, suggestion, config.safety);
  if (!barrier.ok) return reject('blocked', barrier.reason, barrier.detail, startedAt, config.now);
  return {
    outcome: 'suggested',
    suggestion,
    reason: null,
    detail: null,
    elapsedMs: Math.max(0, config.now() - startedAt),
  };
}

export interface AutoDomainBatchOptions extends AutoDomainClassifierOptions {
  /** Maximum sources inspected by one call. Range 1..500; default 100. */
  maxItems?: number;
}

function batchLimit(value: number | undefined): number | null {
  const resolved = value ?? 100;
  return Number.isInteger(resolved) && resolved >= 1 && resolved <= 500 ? resolved : null;
}

export async function classifySourceDomainBatch(
  requests: readonly AutoDomainClassificationRequest[],
  options: AutoDomainBatchOptions,
): Promise<AutoDomainBatchResult> {
  const config = normalizeOptions(options);
  const startedAt = config?.now() ?? (options.now ?? Date.now)();
  const maxItems = batchLimit(options.maxItems);
  if (!config || maxItems === null) {
    return {
      outcome: 'blocked',
      suggestions: [],
      withheld: [],
      scanned: 0,
      stopReason: null,
      elapsedMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
    };
  }
  if (!Array.isArray(requests)) {
    return {
      outcome: 'blocked',
      suggestions: [],
      withheld: [],
      scanned: 0,
      stopReason: null,
      elapsedMs: Math.max(0, config.now() - startedAt),
    };
  }
  if (config.signal.aborted) {
    return {
      outcome: 'unavailable',
      suggestions: [],
      withheld: [],
      scanned: 0,
      stopReason: 'cancelled',
      elapsedMs: Math.max(0, config.now() - startedAt),
    };
  }

  const deadlineAt = startedAt + config.timeBudgetMs;
  const prepared: PreparedSuggestion[] = [];
  const withheld: AutoDomainBatchResult['withheld'] = [];
  let scanned = 0;
  let stopReason: AutoDomainBatchResult['stopReason'] = null;

  for (const request of requests) {
    if (config.signal.aborted) { stopReason = 'cancelled'; break; }
    if (scanned >= maxItems) { stopReason = 'item_limit'; break; }
    if (config.now() >= deadlineAt) { stopReason = 'time_budget'; break; }
    if (!request || typeof request !== 'object'
      || !isNonEmptyText(request.bankId) || !isNonEmptyText(request.endpoint) || !isNonEmptyText(request.documentId)) {
      withheld.push({
        bankId: request && typeof request === 'object' ? String(request.bankId) : '',
        endpoint: request && typeof request === 'object' ? String(request.endpoint) : '',
        documentId: request && typeof request === 'object' ? String(request.documentId) : '',
        reason: 'invalid_query',
        detail: 'source identity must contain non-empty strings',
      });
      scanned += 1;
      continue;
    }
    scanned += 1;
    const result = await prepareSuggestion(request, config, deadlineAt);
    if (!result.ok) {
      if (result.outcome === 'unavailable') {
        stopReason = result.reason === 'cancelled' ? 'cancelled' : result.reason === 'time_budget' ? 'time_budget' : null;
        withheld.push({ bankId: request.bankId, endpoint: request.endpoint, documentId: request.documentId, reason: result.reason, detail: result.detail });
        return {
          outcome: 'unavailable',
          suggestions: [],
          withheld,
          scanned,
          stopReason,
          elapsedMs: Math.max(0, config.now() - startedAt),
        };
      }
      withheld.push({ bankId: request.bankId, endpoint: request.endpoint, documentId: request.documentId, reason: result.reason, detail: result.detail });
      continue;
    }
    prepared.push(result.prepared);
  }

  const returnCandidates: PreparedSuggestion[] = [];
  if (config.verifySourceStability) {
    for (const item of prepared) {
      if (config.signal.aborted) { stopReason = 'cancelled'; break; }
      if (config.now() >= deadlineAt) { stopReason = 'time_budget'; break; }
      const stable = await verifyStability(item.snapshot, config, deadlineAt);
      if (!stable.ok) {
        withheld.push({
          bankId: item.snapshot.bankId,
          endpoint: item.snapshot.endpoint,
          documentId: item.snapshot.documentId,
          reason: stable.reason,
          detail: stable.detail,
        });
        continue;
      }
      returnCandidates.push({
        snapshot: item.snapshot,
        suggestion: applyStabilityVerification(item.suggestion, true, config.safety !== null),
      });
    }
  } else {
    for (const item of prepared) {
      returnCandidates.push({
        snapshot: item.snapshot,
        suggestion: applyStabilityVerification(item.suggestion, false, config.safety !== null),
      });
    }
  }

  // Synchronous final barrier. Every async readback/suggester/verification has
  // completed; no await is allowed between this loop and the returned object.
  const suggestions: SourceDomainSuggestion[] = [];
  for (const item of returnCandidates) {
    const barrier = finalSafetyBarrier(item.snapshot, item.suggestion, config.safety);
    if (!barrier.ok) {
      withheld.push({
        bankId: item.snapshot.bankId,
        endpoint: item.snapshot.endpoint,
        documentId: item.snapshot.documentId,
        reason: barrier.reason,
        detail: barrier.detail,
      });
      continue;
    }
    suggestions.push(item.suggestion);
  }

  let outcome: AutoDomainBatchResult['outcome'];
  if (suggestions.length === 0 && withheld.length > 0) outcome = 'blocked';
  else if (withheld.length > 0 || stopReason !== null) outcome = 'partial';
  else outcome = 'suggested';

  return {
    outcome,
    suggestions,
    withheld,
    scanned,
    stopReason,
    elapsedMs: Math.max(0, config.now() - startedAt),
  };
}
