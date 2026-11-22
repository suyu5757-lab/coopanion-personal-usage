/** Compile-time taxonomy for source-level memory domains. */
export const DOMAIN_IDS = [
  'user-relationship',
  'project-functional',
  'skill-methods',
  'social-context',
  'self-growth',
] as const;

export type DomainId = (typeof DOMAIN_IDS)[number];

export const MEMORY_DOMAIN_TAXONOMY = 'coopanion-memory-domain/v1';

export const SOURCE_DOMAIN_STATES = ['assigned', 'unclassified', 'ambiguous', 'pending_review'] as const;
export type SourceDomainState = (typeof SOURCE_DOMAIN_STATES)[number];

export const SOURCE_DOMAIN_LINK_STATES = ['confirmed', 'candidate'] as const;
export type SourceDomainLinkState = (typeof SOURCE_DOMAIN_LINK_STATES)[number];

export const CLAIM_VERIFICATIONS = ['user_verified', 'external_unverified'] as const;
export type ClaimVerification = (typeof CLAIM_VERIFICATIONS)[number];

export interface SourceDomainLinkInput {
  domainId: DomainId;
  linkState: SourceDomainLinkState;
  confidence: number | null;
  ruleId: string | null;
  /** UTF-16 code-unit offsets into the verified source body; end is exclusive. */
  evidenceStart: number | null;
  evidenceEnd: number | null;
  evidenceDigest: string | null;
  /**
   * `user_verified` means the span records what the user said, preferred or experienced.
   * `external_unverified` means the span reports a third-party or world fact that D1 does not verify.
   */
  claimVerification: ClaimVerification;
}

export interface SourceDomainClassificationInput {
  bankId: string;
  endpoint: string;
  documentId: string;
  state: SourceDomainState;
  taxonomyVersion: string;
  classifierVersion: string;
  confidence: number | null;
  /** Asserted against the current fence epoch by the store; a stale value is rejected. */
  sourceEpoch: number;
  /** Asserted against the verified source body by the store; a mismatch is rejected. */
  sourceRevision: string;
  classifiedAt: string;
  updatedAt: string;
  links: readonly SourceDomainLinkInput[];
}

export interface SourceDomainLink extends SourceDomainLinkInput {}

export interface SourceDomainClassification {
  bankId: string;
  endpoint: string;
  documentId: string;
  state: SourceDomainState;
  taxonomyVersion: string;
  classifierVersion: string;
  confidence: number | null;
  sourceEpoch: number;
  sourceRevision: string;
  classifiedAt: string;
  updatedAt: string;
  links: SourceDomainLink[];
}

export interface DomainSourcePage {
  items: SourceDomainClassification[];
  nextCursor: string | null;
  complete: boolean;
  filtered: number;
  blocked: boolean;
}

export interface SourceDomainStats {
  records: number;
  assigned: number;
  ambiguous: number;
  pendingReview: number;
  unclassified: number;
  /** Current user sources proven by verified operations or a persisted exact-read classification. */
  verifiedSources: number;
  /** Verified user operations with no current classification row. */
  notIndexed: number;
  /** Verified operations with missing actor metadata and no current classification row. */
  unattributedSources: number;
  blocked: boolean;
}

/** Content from the exact Hindsight readback held only while one classification is committed. */
export interface SourceDomainEvidence {
  bankId: string;
  endpoint: string;
  documentId: string;
  content: string;
  sourceEpoch: number;
  sourceActor: string;
  sourceKind: string;
  sourceStatus?: string;
}

/** Exact synthetic Coo Growth source read-back used only by its dedicated candidate index API. */
export interface CooGrowthCandidateSourceEvidence {
  bankId: string;
  endpoint: string;
  documentId: string;
  content: string;
  sourceEpoch: number;
  sourceActor: 'coo';
  sourceKind: 'plan' | 'reflection';
  sourceStatus: 'candidate';
  candidateId: string;
  candidateType: 'growth_proposal_candidate' | 'experience_card_candidate';
  candidateState: 'candidate';
  candidateBodyDigest: string;
  candidateSnapshotDigest: string;
  sourceBodyDigest: string;
  generationId: string;
  responseId: string;
  creatorOperationId: string;
  generationReceiptDigest: string;
  parentSetDigest: string;
}

export type SourceDomainEvidenceProvider = (
  bankId: string,
  endpoint: string,
  documentId: string,
) => SourceDomainEvidence | null;

const DIGEST = /^[0-9a-f]{64}$/;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
  return value;
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  return requiredText(value, field);
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function optionalDigest(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  return digest(value, field);
}

function confidence(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be in the interval [0, 1]`);
  return value;
}

function timestamp(value: string, field: string): string {
  const text = requiredText(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be a valid timestamp`);
  return text;
}

export function isDomainId(value: unknown): value is DomainId {
  return typeof value === 'string' && (DOMAIN_IDS as readonly string[]).includes(value);
}

/** Validate, deduplicate and return domains in taxonomy order. */
export function normalizeDomains(domains: readonly DomainId[]): DomainId[] {
  if (!Array.isArray(domains) || domains.length === 0) throw new Error('at least one memory domain is required');
  const unique = new Set<DomainId>();
  for (const domain of domains) {
    if (!isDomainId(domain)) throw new Error(`unknown memory domain: ${String(domain)}`);
    unique.add(domain);
  }
  return DOMAIN_IDS.filter((domain) => unique.has(domain));
}

/**
 * Validate the shape and cross-link invariants of one classification.
 * Body, span digest, source revision and epoch are verified by the store against
 * the trusted readback provider; this function only rejects structurally invalid input.
 */
export function assertSourceDomainClassification(input: SourceDomainClassificationInput): void {
  requiredText(input.bankId, 'bankId');
  requiredText(input.endpoint, 'endpoint');
  requiredText(input.documentId, 'documentId');
  if (!(SOURCE_DOMAIN_STATES as readonly string[]).includes(input.state)) throw new Error('source domain state is invalid');
  requiredText(input.taxonomyVersion, 'taxonomyVersion');
  requiredText(input.classifierVersion, 'classifierVersion');
  confidence(input.confidence, 'confidence');
  if (!Number.isInteger(input.sourceEpoch) || input.sourceEpoch < 0) throw new Error('sourceEpoch must be a non-negative integer');
  digest(input.sourceRevision, 'sourceRevision');
  timestamp(input.classifiedAt, 'classifiedAt');
  timestamp(input.updatedAt, 'updatedAt');
  if (!Array.isArray(input.links) || input.links.length > DOMAIN_IDS.length) {
    throw new Error(`a source can have at most ${DOMAIN_IDS.length} domain links`);
  }

  const seen = new Set<DomainId>();
  let confirmed = 0;
  let candidate = 0;
  for (const link of input.links) {
    if (!isDomainId(link.domainId)) throw new Error(`unknown memory domain: ${String(link.domainId)}`);
    if (seen.has(link.domainId)) throw new Error(`duplicate memory domain link: ${link.domainId}`);
    seen.add(link.domainId);
    if (!(SOURCE_DOMAIN_LINK_STATES as readonly string[]).includes(link.linkState)) {
      throw new Error('source domain link state is invalid');
    }
    confidence(link.confidence, 'link confidence');
    optionalText(link.ruleId, 'ruleId');
    if (!(CLAIM_VERIFICATIONS as readonly string[]).includes(link.claimVerification)) {
      throw new Error('claimVerification is invalid');
    }
    const hasStart = link.evidenceStart !== null;
    const hasEnd = link.evidenceEnd !== null;
    const hasDigest = link.evidenceDigest !== null;
    if (hasStart !== hasEnd || hasStart !== hasDigest) {
      throw new Error('evidence start, end and digest must be provided together');
    }
    if (hasStart) {
      if (!Number.isInteger(link.evidenceStart) || link.evidenceStart < 0) throw new Error('evidenceStart must be a non-negative integer');
      if (!Number.isInteger(link.evidenceEnd) || link.evidenceEnd <= link.evidenceStart!) {
        throw new Error('evidenceEnd must be greater than evidenceStart');
      }
      optionalDigest(link.evidenceDigest, 'evidenceDigest');
    }
    if (link.linkState === 'confirmed') {
      if (!hasStart || !hasDigest) throw new Error('confirmed links require a source span and digest');
      confirmed += 1;
    } else {
      candidate += 1;
    }
  }

  if (input.state === 'assigned' && (confirmed === 0 || candidate > 0)) {
    throw new Error('assigned requires at least one confirmed link and no candidate link');
  }
  if (input.state === 'unclassified' && input.links.length !== 0) {
    throw new Error('unclassified cannot contain domain links');
  }
  if (input.state === 'ambiguous' && candidate === 0) {
    throw new Error('ambiguous requires at least one candidate link');
  }
}
