import { createHash } from 'node:crypto';
import type { GenerationEvidenceEnvelope, SourceExposureRef } from 'cortico/core/types.ts';
import {
  ExperienceCards,
  experienceCardArtifactText,
} from '../growth/experience-cards.ts';
import {
  GrowthProposals,
  growthProposalArtifactText,
} from '../growth/proposals.ts';
import type { ExactMemorySourceEvidence, HindsightMemory, ReadonlyGenerationEvidence } from './hindsight.ts';
import { memoryArtifactScope, type DerivedArtifact, type MemorySourceDependency } from './state-store.ts';

export type CooSelfGrowthCandidateType = 'growth_proposal_candidate' | 'experience_card_candidate';

export type CooSelfGrowthCandidateReference =
  | { kind: 'growth-proposal'; id: string; store: GrowthProposals }
  | { kind: 'experience-card'; id: string; store: ExperienceCards };

export type CooSelfGrowthWithheldReason =
  | 'candidate-unavailable-or-withdrawn'
  | 'candidate-is-not-current'
  | 'artifact-missing-or-inactive'
  | 'artifact-does-not-match-candidate'
  | 'generation-evidence-unavailable'
  | 'generation-envelope-missing-or-ambiguous'
  | 'generation-receipt-mismatch'
  | 'source-set-incomplete'
  | 'source-readback-unavailable-or-stale'
  | 'source-identity-mismatch'
  | 'forget-or-epoch-changed';

interface SafetyBoundary {
  persistable: false;
  userVerified: false;
  toolExecutionPermitted: false;
  toolPermissions: readonly never[];
}

export type CooSelfGrowthTrustResult =
  | (SafetyBoundary & {
      status: 'candidate';
      candidateType: CooSelfGrowthCandidateType;
      candidateId: string;
      evidence: {
        sessionId: string;
        generationId: string;
        responseId: string;
        serializedGenerationRequestDigest: string;
        generationReceiptDigest: string;
        candidateSnapshotDigest: string;
        candidateArtifactBodyDigest: string;
        artifactLineageReceiptDigest: string;
        parentSources: readonly {
          bankId: string;
          endpoint: string;
          documentId: string;
          actor: string;
          kind: string;
          status: string;
          sourceEpoch: number;
          revision: string;
          contentDigest: string;
        }[];
      };
    })
  | (SafetyBoundary & {
      status: 'withheld';
      candidateId: string;
      reason: CooSelfGrowthWithheldReason;
    });

export interface VerifyCooSelfGrowthCandidateInput {
  memory: HindsightMemory;
  candidate: CooSelfGrowthCandidateReference;
  /** Copy returned by CoreApi.generationEvidence for the artifact's creator session. */
  generationEvidence: readonly GenerationEvidenceEnvelope[];
}

interface LoadedCandidate {
  kind: CooSelfGrowthCandidateType;
  id: string;
  state: string;
  sourceIds: readonly string[];
  artifactBody: string;
  snapshotDigest: string;
  experienceKind?: string;
  userExplicit?: boolean;
}

interface ExpectedGenerationSource {
  ref: SourceExposureRef;
  segmentDigest: string;
}

const NO_TOOL_PERMISSIONS: readonly never[] = Object.freeze([]);
const DIGEST = /^[a-f0-9]{64}$/;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sourceTupleKey = (source: Pick<SourceExposureRef, 'bankId' | 'endpoint' | 'documentId'>): string =>
  JSON.stringify([source.bankId, source.endpoint, source.documentId]);

function withheld(candidateId: string, reason: CooSelfGrowthWithheldReason): CooSelfGrowthTrustResult {
  return {
    status: 'withheld',
    candidateId,
    reason,
    persistable: false,
    userVerified: false,
    toolExecutionPermitted: false,
    toolPermissions: NO_TOOL_PERMISSIONS,
  };
}

function readCandidate(reference: CooSelfGrowthCandidateReference): LoadedCandidate | null {
  try {
    if (!reference.id || reference.id.trim() !== reference.id) return null;
    if (reference.kind === 'growth-proposal') {
      const proposal = reference.store.get(reference.id);
      if (!proposal || proposal.id !== reference.id) return null;
      return {
        kind: 'growth_proposal_candidate',
        id: proposal.id,
        state: proposal.state,
        sourceIds: proposal.sourceIds,
        artifactBody: growthProposalArtifactText(proposal),
        snapshotDigest: sha256(JSON.stringify(proposal)),
      };
    }
    const card = reference.store.get(reference.id);
    if (!card || card.id !== reference.id) return null;
    return {
      kind: 'experience_card_candidate',
      id: card.id,
      state: card.state,
      sourceIds: card.sourceIds,
      artifactBody: experienceCardArtifactText(card),
      snapshotDigest: sha256(JSON.stringify(card)),
      experienceKind: card.kind,
      userExplicit: card.userExplicit,
    };
  } catch {
    return null;
  }
}

function isUniqueSourceList(sources: readonly SourceExposureRef[]): boolean {
  const tuples = new Set<string>();
  for (const source of sources) {
    if (!source || !source.bankId || !source.endpoint || !source.documentId
      || !DIGEST.test(source.contentDigest) || !DIGEST.test(source.validationReceipt)
      || source.revisionState !== 'current' || source.validationStatus !== 'validated') return false;
    const key = sourceTupleKey(source);
    if (tuples.has(key)) return false;
    tuples.add(key);
  }
  return tuples.size === sources.length;
}

function expectedGenerationSources(envelope: GenerationEvidenceEnvelope): ExpectedGenerationSource[] | null {
  if (!isUniqueSourceList(envelope.exposedSources) || envelope.exposedSources.length === 0) return null;
  const result: ExpectedGenerationSource[] = [];
  for (const source of envelope.exposedSources) {
    if (source.validatedEpoch !== envelope.exposedSources[0]!.validatedEpoch) return null;
    const spans = envelope.items.flatMap((item) => item.spans
      .filter((span) => span.exposedSources.some((candidate) => sourceTupleKey(candidate) === sourceTupleKey(source)))
      .map((span) => span.digest));
    if (spans.length === 0 || spans.some((digest) => !DIGEST.test(digest))) return null;
    result.push({ ref: source, segmentDigest: sha256(JSON.stringify([...spans].sort())) });
  }
  return result;
}

function generationReceipt(envelope: GenerationEvidenceEnvelope, sources: readonly ExpectedGenerationSource[]): string {
  return sha256(JSON.stringify([
    envelope.id,
    envelope.serializedBodyDigest,
    envelope.responseId,
    envelope.providerAttemptId,
    envelope.outputToolCalls.map((entry) => [entry.toolCallId, entry.outputDigest, entry.joinState]).sort(),
    envelope.mappingState,
    sources.map(({ ref, segmentDigest }) => [
      ref.bankId, ref.endpoint, ref.documentId, ref.contentDigest, segmentDigest,
    ]),
  ]));
}

function matchesGenerationSource(
  persisted: MemorySourceDependency,
  expected: ExpectedGenerationSource,
  envelope: GenerationEvidenceEnvelope,
  exact: ExactMemorySourceEvidence,
): boolean {
  const source = expected.ref;
  return persisted.bankId === source.bankId
    && persisted.endpoint === source.endpoint
    && persisted.documentId === source.documentId
    && persisted.validatedEpoch === exact.sourceEpoch
    && persisted.validatedFence === exact.fenceEpoch
    && persisted.revision === exact.revision
    && persisted.contentDigest === exact.contentDigest
    && persisted.segmentDigest === expected.segmentDigest
    && persisted.validationState === 'validated'
    && persisted.correlationId === envelope.id
    && exact.endpointBinding === 'configured-client'
    && exact.bankId === source.bankId
    && exact.endpoint === source.endpoint
    && exact.documentId === source.documentId
    && exact.evidenceEpoch === source.validatedEpoch
    && exact.validationReceipt === source.validationReceipt
    && exact.revision === source.contentDigest
    && exact.contentDigest === source.contentDigest
    && exact.status !== 'superseded'
    && exact.status !== 'disputed'
    && exact.actor !== null
    && exact.kind !== null;
}

function matchesArtifactSource(
  persisted: MemorySourceDependency,
  exact: ExactMemorySourceEvidence,
  artifactBodyDigest: string,
  artifact: DerivedArtifact,
): boolean {
  return persisted.bankId === exact.bankId
    && persisted.endpoint === exact.endpoint
    && persisted.documentId === exact.documentId
    && persisted.validatedEpoch === exact.sourceEpoch
    && persisted.validatedFence === exact.fenceEpoch
    && persisted.revision === exact.revision
    && persisted.contentDigest === exact.contentDigest
    && persisted.segmentDigest === artifactBodyDigest
    && persisted.validationState === 'validated'
    && persisted.correlationId === artifact.creatorOperationId;
}

function sameArtifactIdentity(left: DerivedArtifact, right: DerivedArtifact): boolean {
  return left.artifactId === right.artifactId
    && left.kind === right.kind
    && left.target === right.target
    && left.scope === right.scope
    && left.creatorSessionId === right.creatorSessionId
    && left.creatorGenerationId === right.creatorGenerationId
    && left.creatorOperationId === right.creatorOperationId
    && left.bodyDigest === right.bodyDigest
    && left.lineageReceiptDigest === right.lineageReceiptDigest
    && left.lifecycleState === right.lifecycleState
    && left.reviewState === right.reviewState
    && JSON.stringify(left.sources) === JSON.stringify(right.sources);
}

function sameGenerationIdentity(left: ReadonlyGenerationEvidence, right: ReadonlyGenerationEvidence): boolean {
  return left.sessionId === right.sessionId
    && left.generationId === right.generationId
    && left.validationReceiptDigest === right.validationReceiptDigest
    && left.toolCorrelationId === right.toolCorrelationId
    && JSON.stringify(left.sources) === JSON.stringify(right.sources);
}

/** Verifies a live Growth candidate against Core's envelope and the HindsightMemory instance's Store. */
export async function verifyCooSelfGrowthCandidate(
  input: VerifyCooSelfGrowthCandidateInput,
): Promise<CooSelfGrowthTrustResult> {
  const candidateId = input.candidate.id;
  const candidate = readCandidate(input.candidate);
  if (!candidate) return withheld(candidateId, 'candidate-unavailable-or-withdrawn');
  if (candidate.state !== 'candidate' || candidate.sourceIds.length === 0
    || new Set(candidate.sourceIds).size !== candidate.sourceIds.length
    || (candidate.kind === 'experience_card_candidate' && candidate.userExplicit !== false)) {
    return withheld(candidateId, 'candidate-is-not-current');
  }

  const epoch = input.memory.evidenceEpoch();
  const artifact = input.memory.derivedArtifact(candidate.id);
  if (!epoch || !artifact) return withheld(candidateId, 'artifact-missing-or-inactive');
  const artifactKind = candidate.kind === 'growth_proposal_candidate' ? 'growth-proposal' : 'experience-card';
  const target = candidate.kind === 'growth_proposal_candidate'
    ? `growth-proposals/${candidate.id}.json`
    : `experience-cards/${candidate.id}.json`;
  const artifactBodyDigest = sha256(candidate.artifactBody);
  if (artifact.artifactId !== candidate.id || artifact.kind !== artifactKind || artifact.target !== target
    || artifact.origin !== 'model-derived' || artifact.reviewState !== 'unreviewed'
    || artifact.lifecycleState !== 'active' || artifact.lineageState !== 'complete'
    || !artifact.lineageReceiptDigest || !DIGEST.test(artifact.lineageReceiptDigest)
    || !artifact.lineageValidatedAt || artifact.bodyDigest !== artifactBodyDigest
    || !artifact.creatorSessionId || !artifact.creatorGenerationId || !artifact.creatorOperationId) {
    return withheld(candidateId, 'artifact-does-not-match-candidate');
  }

  const generation = input.memory.getGenerationEvidence(artifact.creatorSessionId, artifact.creatorGenerationId);
  if (!generation) return withheld(candidateId, 'generation-evidence-unavailable');
  const envelopes = input.generationEvidence.filter((entry) => entry.sessionId === generation.sessionId
    && entry.id === generation.generationId);
  if (envelopes.length !== 1) return withheld(candidateId, 'generation-envelope-missing-or-ambiguous');
  const envelope = envelopes[0]!;
  const outputCalls = envelope.outputToolCalls.filter((entry) => entry.toolCallId === artifact.creatorOperationId);
  const outputCall = outputCalls.length === 1 ? outputCalls[0] : null;
  const allCallIds = envelope.outputToolCalls.map((entry) => entry.toolCallId);
  const expectedSources = expectedGenerationSources(envelope);
  if (!outputCall || new Set(allCallIds).size !== allCallIds.length || !expectedSources
    || envelope.responseJoinState !== 'matched' || envelope.requestState !== 'sent'
    || envelope.mappingState !== 'complete' || !envelope.responseId || !DIGEST.test(envelope.serializedBodyDigest)
    || !DIGEST.test(outputCall.outputDigest)
    || outputCall.joinState !== 'matched' || outputCall.responseId !== envelope.responseId
    || envelope.items.length === 0
    || envelope.items.some((item) => item.mappingState !== 'complete' || item.disposition === 'unknown-derived-incomplete')
    || generation.sessionId !== artifact.creatorSessionId || generation.generationId !== artifact.creatorGenerationId
    || generation.origin !== 'provider-response' || generation.mappingState !== 'complete'
    || generation.actualEvidenceUsed !== 'unknown' || generation.responseId !== envelope.responseId
    || generation.providerAttemptId !== envelope.providerAttemptId
    || generation.toolCorrelationId !== sha256(JSON.stringify([...allCallIds].sort()))
    || !generation.validationReceiptDigest || !generation.validatedAt
    || generation.sources.length !== expectedSources.length
    || generation.validationReceiptDigest !== generationReceipt(envelope, expectedSources)) {
    return withheld(candidateId, 'generation-receipt-mismatch');
  }

  const expectedByDocument = new Map(expectedSources.map((entry) => [entry.ref.documentId, entry]));
  const candidateSourceIds = [...candidate.sourceIds];
  if (candidateSourceIds.some((documentId) => !expectedByDocument.has(documentId))) {
    return withheld(candidateId, 'source-set-incomplete');
  }
  const registrationSourceIds = [...new Set([
    ...candidateSourceIds,
    ...envelope.exposedSources.map((source) => source.documentId),
  ])];
  if (registrationSourceIds.length !== expectedSources.length
    || artifact.sources.length !== expectedSources.length
    || new Set(expectedSources.map(({ ref }) => ref.documentId)).size !== expectedSources.length) {
    return withheld(candidateId, 'source-set-incomplete');
  }

  const generationByTuple = new Map(generation.sources.map((source) => [sourceTupleKey(source), source]));
  const artifactByTuple = new Map(artifact.sources.map((source) => [sourceTupleKey(source), source]));
  const exactByDocument = new Map<string, ExactMemorySourceEvidence>();
  const parentSources: Array<{
    bankId: string;
    endpoint: string;
    documentId: string;
    actor: string;
    kind: string;
    status: string;
    sourceEpoch: number;
    revision: string;
    contentDigest: string;
  }> = [];

  for (const expected of expectedSources) {
    const source = expected.ref;
    if (source.validatedEpoch !== epoch) return withheld(candidateId, 'forget-or-epoch-changed');
    const exact = await input.memory.readExactSourceEvidence(source.documentId);
    if (!exact || input.memory.evidenceEpoch() !== epoch) return withheld(candidateId, 'source-readback-unavailable-or-stale');
    const tuple = sourceTupleKey(source);
    const generationSource = generationByTuple.get(tuple);
    const artifactSource = artifactByTuple.get(tuple);
    if (!generationSource || !artifactSource
      || !matchesGenerationSource(generationSource, expected, envelope, exact)
      || !matchesArtifactSource(artifactSource, exact, artifactBodyDigest, artifact)) {
      return withheld(candidateId, 'source-identity-mismatch');
    }
    if (candidate.kind === 'experience_card_candidate') {
      if (exact.actor !== 'user' || exact.kind !== 'event'
        || (exact.status !== 'current' && exact.status !== 'completed')
        || !exact.saidAt || !Number.isFinite(Date.parse(exact.saidAt))) {
        return withheld(candidateId, 'source-identity-mismatch');
      }
    }
    exactByDocument.set(source.documentId, exact);
    parentSources.push({
      bankId: exact.bankId,
      endpoint: exact.endpoint,
      documentId: exact.documentId,
      actor: exact.actor!,
      kind: exact.kind!,
      status: exact.status!,
      sourceEpoch: exact.sourceEpoch,
      revision: exact.revision,
      contentDigest: exact.contentDigest,
    });
  }

  if (candidate.kind === 'experience_card_candidate') {
    const dates = new Set(candidateSourceIds.map((documentId) => {
      const saidAt = exactByDocument.get(documentId)?.saidAt;
      return saidAt ? new Date(saidAt).toISOString().slice(0, 10) : '';
    }));
    if (candidateSourceIds.length < 2 || dates.has('') || dates.size < 2) {
      return withheld(candidateId, 'source-identity-mismatch');
    }
  }

  const expectedScope = memoryArtifactScope(expectedSources[0]!.ref.bankId, expectedSources[0]!.ref.endpoint);
  if (artifact.scope !== expectedScope) return withheld(candidateId, 'source-identity-mismatch');
  const expectedLineageReceipt = sha256(JSON.stringify([
    artifact.artifactId,
    artifactBodyDigest,
    epoch,
    registrationSourceIds.map((documentId) => {
      const exact = exactByDocument.get(documentId);
      if (!exact) return null;
      return [exact.bankId, exact.endpoint, exact.documentId, exact.validationReceipt, exact.contentDigest, artifactBodyDigest];
    }),
  ]));
  if (artifact.lineageReceiptDigest !== expectedLineageReceipt || input.memory.evidenceEpoch() !== epoch) {
    return withheld(candidateId, 'forget-or-epoch-changed');
  }

  const currentCandidate = readCandidate(input.candidate);
  const currentGeneration = input.memory.getGenerationEvidence(generation.sessionId, generation.generationId);
  const currentArtifact = input.memory.derivedArtifact(candidateId);
  if (!currentCandidate || currentCandidate.state !== 'candidate'
    || currentCandidate.snapshotDigest !== candidate.snapshotDigest
    || !currentGeneration || !sameGenerationIdentity(currentGeneration, generation)
    || !currentArtifact || !sameArtifactIdentity(currentArtifact, artifact)
    || input.memory.evidenceEpoch() !== epoch
    || registrationSourceIds.some((documentId) => !input.memory.sourceVisible(documentId))) {
    return withheld(candidateId, 'forget-or-epoch-changed');
  }

  return {
    status: 'candidate',
    candidateType: candidate.kind,
    candidateId,
    persistable: false,
    userVerified: false,
    toolExecutionPermitted: false,
    toolPermissions: NO_TOOL_PERMISSIONS,
    evidence: {
      sessionId: generation.sessionId,
      generationId: generation.generationId,
      responseId: generation.responseId!,
      serializedGenerationRequestDigest: envelope.serializedBodyDigest,
      generationReceiptDigest: generation.validationReceiptDigest!,
      candidateSnapshotDigest: candidate.snapshotDigest,
      candidateArtifactBodyDigest: artifact.bodyDigest,
      artifactLineageReceiptDigest: artifact.lineageReceiptDigest!,
      parentSources,
    },
  };
}
