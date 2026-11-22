import { createHash } from 'node:crypto';
import type { GenerationEvidenceEnvelope } from 'cortico/core/types.ts';
import {
  ExperienceCards,
  experienceCardArtifactText,
  type ExperienceCard,
} from '../growth/experience-cards.ts';
import {
  GrowthProposals,
  growthProposalArtifactText,
  type GrowthProposal,
} from '../growth/proposals.ts';
import { MEMORY_DOMAIN_TAXONOMY, type CooGrowthCandidateSourceEvidence, type SourceDomainClassificationInput } from './source-domains.ts';
import {
  verifyCooSelfGrowthCandidate,
  type CooSelfGrowthCandidateReference,
  type CooSelfGrowthTrustResult,
} from './coo-self-growth-trust.ts';
import type { ExactCooGrowthSourceEvidence, HindsightMemory } from './hindsight.ts';
import type { DerivedArtifact } from './state-store.ts';

export const COO_GROWTH_SOURCE_CLASSIFIER = 'coo-growth-source/v1';
export type CooGrowthSourceKind = 'plan' | 'reflection';

export interface CooGrowthCandidateSourceBundle {
  candidateId: string;
  candidateType: 'growth_proposal_candidate' | 'experience_card_candidate';
  sourceKind: CooGrowthSourceKind;
  documentId: string;
  artifactId: string;
  content: string;
  bodyDigest: string;
  metadata: Record<string, string>;
  indexEvidence: CooGrowthCandidateSourceEvidence;
  classification: SourceDomainClassificationInput;
  creatorSessionId: string;
  creatorGenerationId: string;
  creatorOperationId: string;
  candidateCreatedAt: string;
  parentArtifact: DerivedArtifact;
}

export type CooGrowthCandidateSourceRead =
  | {
      status: 'trusted-candidate-source';
      candidateId: string;
      candidateType: CooGrowthCandidateSourceBundle['candidateType'];
      sourceKind: CooGrowthSourceKind;
      documentId: string;
      sourceBody: string;
      candidateBody: string;
      sourceBodyDigest: string;
      generationId: string;
      responseId: string;
      creatorOperationId: string;
      parentSources: readonly {
        bankId: string;
        endpoint: string;
        documentId: string;
        actor: 'user';
        kind: 'event' | 'correction';
        status: 'current' | 'completed';
        sourceEpoch: number;
        revision: string;
        contentDigest: string;
      }[];
      candidateState: 'candidate';
      factVerified: false;
      planExecuted: false;
      toolExecutionPermitted: false;
      toolPermissions: readonly never[];
    }
  | {
      status: 'withheld';
      candidateId: string;
      reason: string;
      factVerified: false;
      planExecuted: false;
      toolExecutionPermitted: false;
      toolPermissions: readonly never[];
    };

export interface PersistCooGrowthCandidateSourceInput {
  memory: HindsightMemory;
  candidate: CooSelfGrowthCandidateReference;
  generationEvidence: readonly GenerationEvidenceEnvelope[];
}

const NO_TOOL_PERMISSIONS: readonly never[] = Object.freeze([]);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function unavailable(candidateId: string, reason: string): CooGrowthCandidateSourceRead {
  return {
    status: 'withheld', candidateId, reason,
    factVerified: false, planExecuted: false, toolExecutionPermitted: false,
    toolPermissions: NO_TOOL_PERMISSIONS,
  };
}

function currentCandidate(reference: CooSelfGrowthCandidateReference): GrowthProposal | ExperienceCard | null {
  if (reference.kind === 'growth-proposal') {
    const candidate = reference.store.get(reference.id);
    return candidate?.id === reference.id ? candidate : null;
  }
  const candidate = reference.store.get(reference.id);
  return candidate?.id === reference.id ? candidate : null;
}

function candidateBody(reference: CooSelfGrowthCandidateReference, candidate: GrowthProposal | ExperienceCard): string {
  return reference.kind === 'growth-proposal'
    ? growthProposalArtifactText(candidate as GrowthProposal)
    : experienceCardArtifactText(candidate as ExperienceCard);
}

function completeTrust(trust: CooSelfGrowthTrustResult): trust is Extract<CooSelfGrowthTrustResult, { status: 'candidate' }> {
  return trust.status === 'candidate';
}

/** Construct the Coo-authored candidate document and its separate SQLite domain-index row. */
export function buildCooGrowthCandidateSource(
  reference: CooSelfGrowthCandidateReference,
  trust: CooSelfGrowthTrustResult,
  parentArtifact: DerivedArtifact,
): CooGrowthCandidateSourceBundle | null {
  if (!completeTrust(trust) || trust.candidateId !== reference.id) return null;
  const candidate = currentCandidate(reference);
  if (!candidate || candidate.state !== 'candidate') return null;
  if (reference.kind === 'experience-card' && (candidate as ExperienceCard).userExplicit !== false) return null;
  const renderedCandidate = candidateBody(reference, candidate);
  const candidateBodyDigest = sha256(renderedCandidate);
  const candidateSnapshotDigest = sha256(JSON.stringify(candidate));
  const candidateType = reference.kind === 'growth-proposal'
    ? 'growth_proposal_candidate' as const : 'experience_card_candidate' as const;
  const sourceKind: CooGrowthSourceKind = reference.kind === 'growth-proposal' ? 'plan' : 'reflection';
  if (trust.candidateType !== candidateType
    || trust.evidence.candidateArtifactBodyDigest !== candidateBodyDigest
    || trust.evidence.candidateSnapshotDigest !== candidateSnapshotDigest
    || !parentArtifact.creatorSessionId || !parentArtifact.creatorGenerationId || !parentArtifact.creatorOperationId
    || parentArtifact.creatorSessionId !== trust.evidence.sessionId
    || parentArtifact.creatorGenerationId !== trust.evidence.generationId
    || parentArtifact.lifecycleState !== 'active' || parentArtifact.reviewState !== 'unreviewed'
    || parentArtifact.origin !== 'model-derived' || parentArtifact.lineageState !== 'complete') return null;

  if (trust.evidence.parentSources.length === 0 || trust.evidence.parentSources.some((source) => source.actor !== 'user'
    || !['event', 'correction'].includes(source.kind) || !['current', 'completed'].includes(source.status))
    || new Set(trust.evidence.parentSources.map((source) => JSON.stringify([source.bankId, source.endpoint, source.documentId]))).size
      !== trust.evidence.parentSources.length
    || new Set(trust.evidence.parentSources.map((source) => source.sourceEpoch)).size !== 1
    || parentArtifact.sources.length !== trust.evidence.parentSources.length
    || parentArtifact.sources.some((source) => source.validationState !== 'validated'
      || !trust.evidence.parentSources.some((parent) => parent.bankId === source.bankId && parent.endpoint === source.endpoint
        && parent.documentId === source.documentId && parent.sourceEpoch === source.validatedEpoch
        && parent.revision === source.revision && parent.contentDigest === source.contentDigest))) return null;

  const parentEvidence = trust.evidence.parentSources.map((source) => ({
    bankId: source.bankId,
    endpoint: source.endpoint,
    documentId: source.documentId,
    actor: source.actor,
    kind: source.kind,
    status: source.status,
    sourceEpoch: source.sourceEpoch,
    revision: source.revision,
    contentDigest: source.contentDigest,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const parentSet = sha256(JSON.stringify(parentEvidence));
  const body = JSON.stringify({
    schema: 'coopanion-coo-growth-source/v1',
    sourceActor: 'coo',
    sourceKind,
    candidate: {
      id: reference.id,
      type: candidateType,
      state: 'candidate',
      bodyDigest: candidateBodyDigest,
      snapshotDigest: candidateSnapshotDigest,
      body: renderedCandidate,
    },
    generation: {
      sessionId: trust.evidence.sessionId,
      generationId: trust.evidence.generationId,
      responseId: trust.evidence.responseId,
      operationId: parentArtifact.creatorOperationId,
      requestDigest: trust.evidence.serializedGenerationRequestDigest,
      receiptDigest: trust.evidence.generationReceiptDigest,
    },
    parentSources: parentEvidence,
    boundaries: {
      factVerified: false,
      planExecuted: false,
      toolExecutionPermitted: false,
      toolPermissions: [],
    },
  });
  const bodyDigest = sha256(body);
  const bankId = trust.evidence.parentSources[0]!.bankId;
  const endpoint = trust.evidence.parentSources[0]!.endpoint;
  if (trust.evidence.parentSources.some((source) => source.bankId !== bankId || source.endpoint !== endpoint)) return null;
  const documentId = `coo-growth:${reference.id}:${bodyDigest.slice(0, 16)}`;
  const artifactId = `coo-growth-candidate-source:${documentId}`;
  const generationReceiptDigest = trust.evidence.generationReceiptDigest;
  const saidAt = candidate.createdAt;
  const metadata: Record<string, string> = {
    source_actor: 'coo',
    kind: sourceKind,
    status: 'candidate',
    said_at: saidAt,
    candidate_id: reference.id,
    candidate_type: candidateType,
    candidate_state: 'candidate',
    candidate_body_sha256: candidateBodyDigest,
    candidate_snapshot_sha256: candidateSnapshotDigest,
    source_body_sha256: bodyDigest,
    generation_id: trust.evidence.generationId,
    response_id: trust.evidence.responseId,
    creator_operation_id: parentArtifact.creatorOperationId,
    generation_receipt_sha256: generationReceiptDigest,
    parent_set_sha256: parentSet,
    derived_artifact_id: artifactId,
    tool_permissions: '[]',
    plan_executed: 'false',
  };
  const evidence: CooGrowthCandidateSourceEvidence = {
    bankId, endpoint, documentId, content: body, sourceEpoch: trust.evidence.parentSources[0]!.sourceEpoch,
    sourceActor: 'coo', sourceKind, sourceStatus: 'candidate', candidateId: reference.id, candidateType,
    candidateState: 'candidate', candidateBodyDigest, candidateSnapshotDigest, sourceBodyDigest: bodyDigest,
    generationId: trust.evidence.generationId, responseId: trust.evidence.responseId,
    creatorOperationId: parentArtifact.creatorOperationId,
    generationReceiptDigest, parentSetDigest: parentSet,
  };
  const now = new Date().toISOString();
  const classification: SourceDomainClassificationInput = {
    bankId,
    endpoint,
    documentId,
    state: 'assigned',
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: COO_GROWTH_SOURCE_CLASSIFIER,
    confidence: null,
    sourceEpoch: evidence.sourceEpoch,
    sourceRevision: bodyDigest,
    classifiedAt: now,
    updatedAt: now,
    links: [{
      domainId: 'self-growth',
      linkState: 'confirmed',
      confidence: null,
      ruleId: 'coo-growth-candidate',
      evidenceStart: 0,
      evidenceEnd: body.length,
      evidenceDigest: bodyDigest,
      claimVerification: 'external_unverified',
    }],
  };
  return {
    candidateId: reference.id,
    candidateType,
    sourceKind,
    documentId,
    artifactId,
    content: body,
    bodyDigest,
    metadata,
    indexEvidence: evidence,
    classification,
    creatorSessionId: trust.evidence.sessionId,
    creatorGenerationId: trust.evidence.generationId,
    creatorOperationId: parentArtifact.creatorOperationId,
    candidateCreatedAt: saidAt,
    parentArtifact,
  };
}

export function exactCooGrowthSourceMatches(exact: ExactCooGrowthSourceEvidence, bundle: CooGrowthCandidateSourceBundle): boolean {
  return exact.endpointBinding === 'configured-client'
    && exact.bankId === bundle.indexEvidence.bankId && exact.endpoint === bundle.indexEvidence.endpoint
    && exact.documentId === bundle.documentId && exact.storedText === bundle.content
    && exact.contentDigest === bundle.bodyDigest && exact.revision === bundle.bodyDigest
    && exact.actor === 'coo' && exact.kind === bundle.sourceKind && exact.status === 'candidate'
    && Object.entries(bundle.metadata).every(([key, value]) => exact.metadata[key] === value)
    && exact.metadata.source_body_sha256 === bundle.bodyDigest
    && exact.sourceEpoch === bundle.indexEvidence.sourceEpoch;
}

function sameTrustIdentity(left: CooSelfGrowthTrustResult, right: CooSelfGrowthTrustResult): boolean {
  return left.status === 'candidate' && right.status === 'candidate'
    && left.candidateId === right.candidateId && left.candidateType === right.candidateType
    && JSON.stringify(left.evidence) === JSON.stringify(right.evidence);
}

/** Dedicated exact readback; this result is not connected to Recall, Persona or tool dispatch. */
export async function readCooGrowthCandidateSource(
  input: PersistCooGrowthCandidateSourceInput,
): Promise<CooGrowthCandidateSourceRead> {
  const firstTrust = await verifyCooSelfGrowthCandidate(input);
  if (!completeTrust(firstTrust)) return unavailable(input.candidate.id, firstTrust.reason);
  const parentArtifact = input.memory.derivedArtifact(input.candidate.id);
  if (!parentArtifact) return unavailable(input.candidate.id, 'candidate artifact unavailable');
  const bundle = buildCooGrowthCandidateSource(input.candidate, firstTrust, parentArtifact);
  if (!bundle) return unavailable(input.candidate.id, 'candidate source identity is invalid');
  const firstExact = await input.memory.readExactCooGrowthSourceEvidence(bundle.documentId);
  if (!firstExact || !exactCooGrowthSourceMatches(firstExact, bundle)) return unavailable(input.candidate.id, 'Hindsight source read-back does not match the candidate');

  const secondTrust = await verifyCooSelfGrowthCandidate(input);
  if (!sameTrustIdentity(firstTrust, secondTrust)) return unavailable(input.candidate.id, 'candidate or parent evidence changed during read-back');
  const secondExact = await input.memory.readExactCooGrowthSourceEvidence(bundle.documentId);
  if (!secondExact || !exactCooGrowthSourceMatches(secondExact, bundle) || secondExact.validationReceipt !== firstExact.validationReceipt) {
    return unavailable(input.candidate.id, 'Hindsight source changed during read-back');
  }
  const index = input.memory.getCooGrowthCandidateClassification(secondExact);
  const artifact = input.memory.derivedArtifact(bundle.artifactId);
  if (!index || !artifact || artifact.kind !== 'coo-growth-candidate-source'
    || artifact.target !== bundle.documentId || artifact.bodyDigest !== bundle.bodyDigest
    || artifact.lifecycleState !== 'active' || artifact.reviewState !== 'unreviewed'
    || artifact.origin !== 'model-derived' || artifact.lineageState !== 'complete'
    || artifact.creatorSessionId !== bundle.creatorSessionId || artifact.creatorGenerationId !== bundle.creatorGenerationId
    || artifact.creatorOperationId !== bundle.creatorOperationId
    || artifact.sources.length !== bundle.parentArtifact.sources.length
    || artifact.sources.some((source) => !bundle.parentArtifact.sources.some((parent) =>
      source.bankId === parent.bankId && source.endpoint === parent.endpoint && source.documentId === parent.documentId
        && source.contentDigest === parent.contentDigest && source.validatedEpoch === parent.validatedEpoch
        && source.segmentDigest === parent.segmentDigest && source.validationState === 'validated'))) {
    return unavailable(input.candidate.id, 'SQLite candidate index or derived artifact is stale');
  }
  return {
    status: 'trusted-candidate-source',
    candidateId: bundle.candidateId,
    candidateType: bundle.candidateType,
    sourceKind: bundle.sourceKind,
    documentId: bundle.documentId,
    sourceBody: secondExact.storedText,
    candidateBody: JSON.parse(secondExact.storedText).candidate.body as string,
    sourceBodyDigest: secondExact.contentDigest,
    generationId: bundle.creatorGenerationId,
    responseId: firstTrust.evidence.responseId,
    creatorOperationId: bundle.creatorOperationId,
    parentSources: firstTrust.evidence.parentSources.map((source) => ({
      bankId: source.bankId,
      endpoint: source.endpoint,
      documentId: source.documentId,
      actor: 'user' as const,
      kind: source.kind as 'event' | 'correction',
      status: source.status as 'current' | 'completed',
      sourceEpoch: source.sourceEpoch,
      revision: source.revision,
      contentDigest: source.contentDigest,
    })),
    candidateState: 'candidate',
    factVerified: false,
    planExecuted: false,
    toolExecutionPermitted: false,
    toolPermissions: NO_TOOL_PERMISSIONS,
  };
}

export async function persistCooGrowthCandidateSource(
  input: PersistCooGrowthCandidateSourceInput,
): Promise<Awaited<ReturnType<HindsightMemory['persistCooGrowthCandidateSource']>>> {
  return input.memory.persistCooGrowthCandidateSource(input);
}
