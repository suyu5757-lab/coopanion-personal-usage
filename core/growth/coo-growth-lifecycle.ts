import { createHash } from 'node:crypto';
import { GrowthProposals, growthProposalArtifactText, type GrowthProposal } from './proposals.ts';
import type { GenerationEvidenceEnvelope } from 'cortico/core/types.ts';
import {
  buildCooGrowthCandidateSource,
  persistCooGrowthCandidateSource,
  readCooGrowthCandidateSource,
  type CooGrowthCandidateSourceRead,
  type CooGrowthSourceKind,
} from '../memory/coo-growth-source.ts';
import {
  verifyCooSelfGrowthCandidate,
  type CooSelfGrowthCandidateReference,
  type CooSelfGrowthCandidateType,
} from '../memory/coo-self-growth-trust.ts';
import type { HindsightMemory, PersistCooGrowthCandidateSourceResult } from '../memory/hindsight.ts';

export type CooGrowthCandidateLifecycleStatus =
  | 'local_persisted_and_verified'
  | 'persisted_and_verified'
  | 'queued_or_unverified'
  | 'withheld'
  | 'failed'
  | 'skipped';

export type CooGrowthCandidateLifecycleResult = {
  candidateId: string;
  candidateType: CooSelfGrowthCandidateType;
  sourceKind: CooGrowthSourceKind;
  status: CooGrowthCandidateLifecycleStatus;
  writeStatus: PersistCooGrowthCandidateSourceResult['status'] | 'not-attempted' | 'unknown' | 'local-only';
  readbackStatus: 'trusted-candidate-source' | 'trusted-local-candidate' | 'withheld' | 'not-run';
  documentId?: string;
  artifactId?: string;
  generationId?: string;
  responseId?: string;
  creatorOperationId?: string;
  candidateBodyDigest?: string;
  candidateSnapshotDigest?: string;
  sourceBodyDigest?: string;
  parentSources?: Extract<CooGrowthCandidateSourceRead, { status: 'trusted-candidate-source' }>['parentSources'];
  reason?: string;
};

export interface CooGrowthCandidateProducedEvent {
  candidate: CooSelfGrowthCandidateReference;
  generationEvidence: readonly GenerationEvidenceEnvelope[];
  isCurrent: () => boolean;
}

export type CooGrowthCandidateLifecycleHandler =
  (event: CooGrowthCandidateProducedEvent) => Promise<CooGrowthCandidateLifecycleResult>;

export function cooGrowthCandidateType(reference: CooSelfGrowthCandidateReference): CooSelfGrowthCandidateType {
  return reference.kind === 'growth-proposal' ? 'growth_proposal_candidate' : 'experience_card_candidate';
}

function emptyResult(
  reference: CooSelfGrowthCandidateReference,
  status: CooGrowthCandidateLifecycleStatus,
  reason: string,
): CooGrowthCandidateLifecycleResult {
  return {
    candidateId: reference.id,
    candidateType: cooGrowthCandidateType(reference),
    sourceKind: reference.kind === 'growth-proposal' ? 'plan' : 'reflection',
    status,
    writeStatus: 'not-attempted',
    readbackStatus: 'not-run',
    reason,
  };
}

export function skippedCooGrowthCandidateSource(
  reference: CooSelfGrowthCandidateReference,
  reason = 'lifecycle-not-enabled',
): CooGrowthCandidateLifecycleResult {
  return emptyResult(reference, 'skipped', reason);
}

export function failedCooGrowthCandidateSource(
  reference: CooSelfGrowthCandidateReference,
  reason = 'lifecycle-handler-failed',
): CooGrowthCandidateLifecycleResult {
  return { ...emptyResult(reference, 'failed', reason), writeStatus: 'unknown' };
}

function stillCurrent(event: CooGrowthCandidateProducedEvent): boolean {
  try { return event.isCurrent(); }
  catch { return false; }
}

function recorded(
  reference: CooSelfGrowthCandidateReference,
  status: CooGrowthCandidateLifecycleStatus,
  fields: Partial<CooGrowthCandidateLifecycleResult>,
): CooGrowthCandidateLifecycleResult {
  return {
    candidateId: reference.id,
    candidateType: cooGrowthCandidateType(reference),
    sourceKind: reference.kind === 'growth-proposal' ? 'plan' : 'reflection',
    status,
    writeStatus: 'not-attempted',
    readbackStatus: 'not-run',
    ...fields,
  };
}

function readbackSources(read: Extract<CooGrowthCandidateSourceRead, { status: 'trusted-candidate-source' }>) {
  return read.parentSources.map((source) => ({
    bankId: source.bankId,
    endpoint: source.endpoint,
    documentId: source.documentId,
    actor: source.actor,
    kind: source.kind,
    status: source.status,
    sourceEpoch: source.sourceEpoch,
    revision: source.revision,
    contentDigest: source.contentDigest,
  }));
}

/** Explicit synthetic opt-in for the committed Growth candidate source path. */
export function createCooGrowthCandidateLifecycle(
  memory: HindsightMemory,
): CooGrowthCandidateLifecycleHandler {
  return async (event) => {
    const reference = event.candidate;
    if (!stillCurrent(event)) return skippedCooGrowthCandidateSource(reference, 'review-no-longer-current');

    let bundle: ReturnType<typeof buildCooGrowthCandidateSource> = null;
    try {
      const input = { memory, candidate: reference, generationEvidence: event.generationEvidence };
      const trust = await verifyCooSelfGrowthCandidate(input);
      if (!stillCurrent(event)) return skippedCooGrowthCandidateSource(reference, 'review-no-longer-current');
      if (trust.status !== 'candidate') {
        return recorded(reference, 'withheld', { reason: trust.reason });
      }
      const parentArtifact = memory.derivedArtifact(reference.id);
      if (!parentArtifact) return recorded(reference, 'withheld', { reason: 'candidate-artifact-unavailable' });
      bundle = buildCooGrowthCandidateSource(reference, trust, parentArtifact);
      if (!bundle) return recorded(reference, 'withheld', { reason: 'candidate-source-identity-invalid' });
      if (!stillCurrent(event)) return skippedCooGrowthCandidateSource(reference, 'review-no-longer-current');

      const write = await persistCooGrowthCandidateSource(input);
      const details = {
        documentId: bundle.documentId,
        artifactId: bundle.artifactId,
        generationId: trust.evidence.generationId,
        responseId: trust.evidence.responseId,
        creatorOperationId: bundle.creatorOperationId,
        candidateBodyDigest: bundle.metadata.candidate_body_sha256,
        candidateSnapshotDigest: bundle.metadata.candidate_snapshot_sha256,
        sourceBodyDigest: bundle.bodyDigest,
        writeStatus: write.status,
      };
      if (!stillCurrent(event)) {
        memory.withdrawDerivedArtifact(bundle.artifactId, 'growth-review-no-longer-current');
        return recorded(reference, 'withheld', {
          ...details,
          readbackStatus: 'withheld',
          reason: 'review-no-longer-current',
        });
      }
      if (write.status === 'queued') {
        return recorded(reference, 'queued_or_unverified', {
          ...details,
          readbackStatus: 'withheld',
          reason: 'source-write-or-readback-pending',
        });
      }
      if (write.status === 'gated') {
        return recorded(reference, 'withheld', { ...details, reason: 'candidate-source-gated' });
      }
      if (write.status === 'persistence-error') {
        return recorded(reference, 'failed', { ...details, reason: 'candidate-source-write-failed' });
      }

      const read = await readCooGrowthCandidateSource(input);
      if (!stillCurrent(event)) {
        memory.withdrawDerivedArtifact(bundle.artifactId, 'growth-review-no-longer-current');
        return recorded(reference, 'withheld', {
          ...details,
          readbackStatus: 'withheld',
          reason: 'review-no-longer-current',
        });
      }
      if (read.status !== 'trusted-candidate-source'
        || read.candidateId !== reference.id
        || read.candidateType !== bundle.candidateType
        || read.sourceKind !== bundle.sourceKind
        || read.documentId !== bundle.documentId
        || read.generationId !== bundle.creatorGenerationId
        || read.creatorOperationId !== bundle.creatorOperationId
        || read.sourceBodyDigest !== bundle.bodyDigest) {
        return recorded(reference, 'queued_or_unverified', {
          ...details,
          readbackStatus: 'withheld',
          reason: 'exact-source-readback-unverified',
        });
      }
      return recorded(reference, 'persisted_and_verified', {
        ...details,
        readbackStatus: 'trusted-candidate-source',
        parentSources: readbackSources(read),
      });
    } catch {
      if (bundle && !stillCurrent(event)) {
        memory.withdrawDerivedArtifact(bundle.artifactId, 'growth-review-no-longer-current');
      }
      return recorded(reference, 'failed', { writeStatus: 'unknown', reason: 'candidate-source-operation-failed' });
    }
  };
}


/** A Journal may inform a proposal while its underlying user sources remain independently valid. */
export async function growthProposalSourceEligible(memory: HindsightMemory, documentId: string): Promise<boolean> {
  const source = await memory.readExactSourceEvidence(documentId);
  if (!source) return false;
  if (source.actor === 'user' && (source.kind === 'event' || source.kind === 'correction')
    && (source.status === 'current' || source.status === 'completed')
    && source.saidAt && Number.isFinite(Date.parse(source.saidAt))) return true;
  if (!documentId.startsWith('journal:generated:') || source.actor !== 'coo' || source.kind !== 'reflection'
    || source.status !== 'candidate' || source.metadata.journal_source !== 'host-daily-task') return false;
  const artifact = memory.derivedArtifact(`journal-output:${documentId}`);
  if (!artifact || artifact.lineageState !== 'complete' || artifact.sources.length === 0
    || !await memory.verifyDerivedArtifact(artifact.artifactId, source.storedText)) return false;
  for (const parent of artifact.sources) {
    const exact = await memory.readExactSourceEvidence(parent.documentId);
    if (!exact || exact.bankId !== parent.bankId || exact.endpoint !== parent.endpoint
      || exact.contentDigest !== parent.contentDigest || exact.sourceEpoch !== parent.validatedEpoch
      || exact.actor !== 'user' || (exact.kind !== 'event' && exact.kind !== 'correction')
      || (exact.status !== 'current' && exact.status !== 'completed')) return false;
  }
  return memory.evidenceEpoch() === source.evidenceEpoch && memory.sourceCurrentForContext(documentId);
}

export type LocalGrowthProposalRead =
  | { status: 'candidate'; proposal: GrowthProposal; factVerified: false; planExecuted: false; toolExecutionPermitted: false; provenanceVerified: boolean; contentConsistencyChecked: boolean; interpretation: 'user_preference' | 'inference' | 'uncertain' | 'needs_review' }
  | { status: 'withheld'; candidateId: string; reason: string; factVerified: false; planExecuted: false; toolExecutionPermitted: false; provenanceVerified: boolean; contentConsistencyChecked: boolean; interpretation: 'user_preference' | 'inference' | 'uncertain' | 'needs_review' };

/** Reopens a local proposal using its digest-bound receipt and fresh Bank readbacks. No writes occur. */
export async function readLocalGrowthProposal(
  memory: HindsightMemory, store: GrowthProposals, id: string,
): Promise<LocalGrowthProposalRead> {
  const boundaries = { factVerified: false as const, planExecuted: false as const, toolExecutionPermitted: false as const };
  const reject = (reason: string, provenanceVerified = false): LocalGrowthProposalRead => ({ status: 'withheld', candidateId: id, reason, ...boundaries, provenanceVerified, contentConsistencyChecked: false, interpretation: 'needs_review' });
  const candidate = store.get(id);
  if (!candidate?.generationProof) return reject('persisted-generation-proof-unavailable');
  if (candidate.semanticReview && !candidate.autonomousKey) return reject('semantic-review-unbound');
  try {
    const trust = await verifyCooSelfGrowthCandidate({ memory,
      candidate: { kind: 'growth-proposal', id, store }, generationEvidence: [candidate.generationProof] });
    if (trust.status !== 'candidate') return reject(trust.reason);
    for (const parent of trust.evidence.parentSources) {
      if (!await growthProposalSourceEligible(memory, parent.documentId)) return reject('unsupported-or-unverified-parent');
    }
    const after = await verifyCooSelfGrowthCandidate({ memory,
      candidate: { kind: 'growth-proposal', id, store }, generationEvidence: [candidate.generationProof] });
    if (after.status !== 'candidate' || JSON.stringify(after.evidence) !== JSON.stringify(trust.evidence)) {
      return reject('candidate-or-parent-changed');
    }
    if (createHash('sha256').update(JSON.stringify(candidate)).digest('hex') !== after.evidence.candidateSnapshotDigest) return reject('candidate-changed-during-read');
    if (candidate.autonomousKey) {
      const review = candidate.semanticReview;
      if (!review || review.verdict !== 'passed' || !review.contentConsistencyChecked || !review.provenanceVerified
        || review.planExecuted !== false || review.skillVerified !== false || review.toolExecutionPermitted !== false
        || review.candidateDigest !== createHash('sha256').update(growthProposalArtifactText(candidate)).digest('hex')
        || !review.generationProof || !await memory.verifyDerivedArtifact(`growth-semantic:${id}`, JSON.stringify(review))) return reject('semantic-review-missing-rejected-or-stale', true);
      const artifact = memory.derivedArtifact(`growth-semantic:${id}`);
      const generation = memory.getGenerationEvidence(review.generationProof.sessionId, review.generationProof.id);
      if (!artifact || artifact.creatorGenerationId !== review.generationProof.id || generation?.responseId !== review.generationProof.responseId) return reject('semantic-generation-receipt-missing');
    }
    if (JSON.stringify(store.get(id)) !== JSON.stringify(candidate) || !memory.derivedArtifactIsCurrent(id, growthProposalArtifactText(candidate))) return reject('candidate-changed-during-semantic-read');
    return { status: 'candidate', proposal: candidate, ...boundaries, provenanceVerified: true, contentConsistencyChecked: !!candidate.autonomousKey && candidate.semanticReview?.contentConsistencyChecked === true, interpretation: candidate.semanticReview?.interpretation ?? 'needs_review' };
  } catch { return reject('candidate-source-unavailable'); }
}

/** Local candidate persistence is sufficient for a manual review; it never submits a Bank write. */
export function createLocalGrowthCandidateLifecycle(memory: HindsightMemory): CooGrowthCandidateLifecycleHandler {
  return async (event) => {
    if (!stillCurrent(event)) return skippedCooGrowthCandidateSource(event.candidate, 'review-no-longer-current');
    if (event.candidate.kind !== 'growth-proposal') return skippedCooGrowthCandidateSource(event.candidate, 'existing-experience-review-path');
    const read = await readLocalGrowthProposal(memory, event.candidate.store, event.candidate.id);
    if (!stillCurrent(event) || read.status !== 'candidate') return emptyResult(event.candidate, 'withheld',
      read.status === 'withheld' ? read.reason : 'review-no-longer-current');
    return recorded(event.candidate, 'local_persisted_and_verified', {
      writeStatus: 'local-only', readbackStatus: 'trusted-local-candidate',
      artifactId: event.candidate.id,
      generationId: read.proposal.generationProof!.id,
      responseId: read.proposal.generationProof!.responseId ?? undefined,
    });
  };
}
