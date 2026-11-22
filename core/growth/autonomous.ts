/** Automatic Growth selects existing sources and stores reviewable candidates; it never applies them. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CoreApi, GenerationEvidenceEnvelope, SourceMapSpan, ToolCallContext } from 'cortico/core/types.ts';
import { digestText } from 'cortico/core/evidence.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import type { ExactMemorySourceEvidence, HindsightMemory } from '../memory/hindsight.ts';
import { asRecord, InvalidState, readState, writeState } from '../state-file.ts';
import { GrowthProposals, growthProposalArtifactText, type GrowthProposal, type GrowthSemanticReview } from './proposals.ts';
import { growthProposalSourceEligible, readLocalGrowthProposal } from './coo-growth-lifecycle.ts';
import { GROWTH_SESSION, FINISH_REVIEW_DECL, growthMemorySearchTool, type GrowthReview, type GrowthRunResult } from './review.ts';

export const GROWTH_VALIDATION_SESSION = 'growth-validation';
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const DAY = 86_400_000;
const EMPTY_RESULT = { proposals: 0, candidateSourceResults: [], note: '', cancelled: false };

type RunStatus = 'queued' | 'candidate_saved' | 'withheld' | 'failed' | 'skipped_no_new_evidence' | 'skipped_retry_exhausted';
interface AutonomousRun {
  runId: string;
  reason: 'weekly_due' | 'manual';
  key: string;
  epoch: string;
  sourceIds: string[];
  sourceDigests: string[];
  startedAt: string;
  finishedAt?: string;
  attempts: number;
  status: RunStatus;
  candidateIds: string[];
  error?: string;
}
interface AutonomousState {
  v: 1;
  seen: string[];
  paused?: boolean;
  lastSuccessAt?: string;
  lastRun?: AutonomousRun;
}

/** A narrow deterministic fallback for checkable arithmetic and literal quote errors. */
export function growthContentIssues(proposal: { summary: string; evidence: readonly string[]; changes?: readonly { reason: string }[] }, sources: readonly ExactMemorySourceEvidence[]): string[] {
  const issues: string[] = [];
  const events = sources.filter(source => source.actor === 'user' && (source.kind === 'event' || source.kind === 'correction'));
  const dates = [...new Set(events.map(source => source.saidAt?.slice(0, 10)).filter((date): date is string => !!date))].sort();
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, 一: 1, 两: 2, 二: 2, 三: 3, 七: 7, 十四: 14 };
  const text = [proposal.summary, ...proposal.evidence, ...(proposal.changes ?? []).map(change => change.reason)].join('\n');
  if (/(?:来源\s*ID|source\s*(?:IDs?|identit(?:y|ies)))[^\n]{0,100}(?:相隔|距离|far apart|distant)[^\n]{0,120}(?:跨时间|跨会话|跨日|across time|over time|across sessions)/i.test(text)) issues.push('source_identity_is_not_time_evidence');
  if (dates.length === 2) {
    const actualDays = (Date.parse(dates[1]!) - Date.parse(dates[0]!)) / DAY;
    for (const match of text.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fourteen)\s*(days?|weeks?)\b|([一两二三七]|十四|\d+)\s*(天|周|星期)/gi)) {
      const amount = Number(match[1] ?? match[3]) || words[(match[1] ?? match[3]!).toLowerCase()];
      const unit = match[2] ?? match[4]!;
      const claimedDays = amount! * (/week|周|星期/i.test(unit) ? 7 : 1);
      if (Number.isFinite(claimedDays) && claimedDays !== actualDays) issues.push(`date_interval_mismatch: ${dates[0]} to ${dates[1]} = ${actualDays} days, not ${claimedDays}`);
    }
  }
  const counts: Record<string, number> = { once: 1, twice: 2, one: 1, two: 2, three: 3, four: 4 };
  for (const match of text.matchAll(/\b(once|twice)\b|\b(one|two|three|four|\d+)\s+(?:separate\s+)?(?:occasions|user requests|user events)\b/gi)) {
    const token = (match[1] ?? match[2]!).toLowerCase();
    const claimed = counts[token] ?? Number(token);
    if (claimed > events.length && !events.some(source => source.storedText.toLowerCase().includes(match[0].toLowerCase()))) issues.push(`event_count_not_supported: ${claimed} claimed, ${events.length} user sources`);
  }
  for (const match of text.matchAll(/(20\d{2}-\d{2}-\d{2})[^.\n]{0,50}\b(before|after)\b[^.\n]{0,50}(20\d{2}-\d{2}-\d{2})/gi)) {
    const difference = Date.parse(match[1]!) - Date.parse(match[3]!);
    if ((match[2]!.toLowerCase() === 'before' && difference >= 0) || (match[2]!.toLowerCase() === 'after' && difference <= 0)) issues.push('date_order_mismatch');
  }
  const originals = sources.map(source => source.storedText.toLowerCase());
  for (const line of proposal.evidence) {
    for (const quote of line.matchAll(/[“"]([^”"]{12,})[”"]/g)) {
      const fragments = quote[1]!.toLowerCase().split(/\.{3}|…+/).map(part => part.trim()).filter(Boolean);
      const supported = fragments.length > 0 && originals.some(body => {
        let cursor = 0;
        for (const fragment of fragments) {
          const at = body.indexOf(fragment, cursor);
          if (at < 0) return false;
          cursor = at + fragment.length;
        }
        return true;
      });
      if (!supported) issues.push('literal_quote_not_supported_by_sources');
    }
  }
  return [...new Set(issues)];
}

export interface AutonomousGrowthDeps {
  stateFile: string;
  proposals: GrowthProposals;
  memory: HindsightMemory;
  review: GrowthReview;
  core: () => CoreApi | null;
  now?: () => Date;
  allowed?: () => boolean;
  semanticTimeoutMs?: number;
  onCandidatesReady?: (ids: readonly string[], current: () => boolean) => Promise<void>;
}

export class AutonomousGrowth {
  private running = false;
  private cancelled = false;
  private state: AutonomousState;
  private readonly now: () => Date;
  constructor(private readonly d: AutonomousGrowthDeps) {
    this.now = d.now ?? (() => new Date());
    this.state = readState(d.stateFile, value => {
      const v = asRecord(value);
      const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      if (v.v !== 1 || !Array.isArray(v.seen) || v.seen.length > 256 || v.seen.some(x => !digest(x))
        || (v.paused !== undefined && typeof v.paused !== 'boolean')) throw new InvalidState('invalid autonomous Growth state');
      if (v.lastRun !== undefined) {
        const run = asRecord(v.lastRun);
        if (!digest(run.key) || !digest(run.runId) || !Number.isInteger(run.attempts) || Number(run.attempts) < 0 || Number(run.attempts) > 3
          || !Array.isArray(run.sourceDigests) || run.sourceDigests.some(x => !digest(x))
          || !Array.isArray(run.sourceIds) || run.sourceIds.length > 8 || run.sourceIds.some(x => typeof x !== 'string')
          || typeof run.startedAt !== 'string' || !Number.isFinite(Date.parse(run.startedAt))
          || !['queued', 'candidate_saved', 'withheld', 'failed', 'skipped_no_new_evidence', 'skipped_retry_exhausted'].includes(String(run.status))) throw new InvalidState('invalid autonomous Growth run');
      }
      return v as unknown as AutonomousState;
    }) ?? { v: 1, seen: [] };
  }
  status(): Readonly<AutonomousState> & { running: boolean; persistedCandidateCount: number; semanticallyRejectedCount: number } {
    const candidates = this.d.proposals.list('candidate');
    return structuredClone({ ...this.state, running: this.running, persistedCandidateCount: candidates.length, semanticallyRejectedCount: candidates.filter(candidate => candidate.semanticReview?.verdict === 'rejected').length });
  }
  isPaused(): boolean { return this.state.paused === true; }
  pause(value: boolean): void { this.state.paused = value; if (value) this.cancel(); this.save(); }
  cancel(): void { this.cancelled = true; this.d.review.cancel(); }
  private current(): boolean { return !this.cancelled && !this.isPaused() && (this.d.allowed?.() ?? true); }
  private save(): void {
    mkdirSync(dirname(this.d.stateFile), { recursive: true });
    writeState(this.d.stateFile, JSON.stringify(this.state, null, 2) + '\n');
  }
  async run(reason: 'weekly_due' | 'manual' = 'weekly_due'): Promise<GrowthRunResult> {
    if (this.running || (this.d.core()?.sessionInfo(GROWTH_SESSION).running ?? 0) > 0 || (this.d.core()?.sessionInfo(GROWTH_VALIDATION_SESSION).running ?? 0) > 0) throw new Error('Automatic Growth is already running');
    if (this.isPaused() || !(this.d.allowed?.() ?? true)) return { ...EMPTY_RESULT, note: 'paused', cancelled: true };
    this.running = true; this.cancelled = false;
    try {
      const now = this.now();
      const available = await this.d.memory.discoverGrowthSources(new Date(now.getTime() - 14 * DAY), now);
      const sources: ExactMemorySourceEvidence[] = [];
      const sourceDigest = (source: ExactMemorySourceEvidence): string => hash(JSON.stringify([source.bankId, source.endpoint, source.documentId, source.revision, source.sourceEpoch]));
      for (const source of available) {
        if (!this.current()) throw new Error('Automatic Growth paused during selection');
        if (this.state.seen.includes(sourceDigest(source))) continue;
        if (!await growthProposalSourceEligible(this.d.memory, source.documentId)) continue;
        const group = [source];
        if (source.documentId.startsWith('journal:generated:')) {
          const artifact = this.d.memory.derivedArtifact(`journal-output:${source.documentId}`);
          for (const parent of artifact?.sources ?? []) {
            const exact = await this.d.memory.readExactSourceEvidence(parent.documentId);
            if (exact && await growthProposalSourceEligible(this.d.memory, exact.documentId)) group.push(exact);
          }
        }
        for (const item of group) {
          if (sources.length < 8 && !sources.some(existing => existing.documentId === item.documentId)) sources.push(item);
        }
        if (sources.length === 8) break;
      }
      const digests = sources.map(sourceDigest);
      const key = hash(JSON.stringify([...digests].sort()));
      const previous = this.state.lastRun;
      if (!sources.length || digests.every(digest => this.state.seen.includes(digest))) {
        this.state.lastRun = { runId: key, key, reason, epoch: this.d.memory.evidenceEpoch() ?? '', sourceIds: [], sourceDigests: digests, startedAt: now.toISOString(), finishedAt: now.toISOString(), attempts: 0, status: 'skipped_no_new_evidence', candidateIds: [] };
        this.save(); return { ...EMPTY_RESULT, note: 'skipped_no_new_evidence' };
      }
      const attempts = previous?.key === key ? previous.attempts + 1 : 1;
      if (attempts > 3) {
        this.state.lastRun = { ...previous!, status: 'skipped_retry_exhausted', finishedAt: now.toISOString() };
        this.save(); return { ...EMPTY_RESULT, note: 'skipped_retry_exhausted' };
      }
      const run: AutonomousRun = { runId: key, key, reason, epoch: this.d.memory.evidenceEpoch() ?? '', sourceIds: sources.map(source => source.documentId), sourceDigests: digests, startedAt: now.toISOString(), attempts, status: 'queued', candidateIds: [] };
      this.state.lastRun = run; this.save();
      const existing = this.d.proposals.list().filter(candidate => candidate.state !== 'rejected' && candidate.autonomousKey === key);
      const result = existing.length ? { ...EMPTY_RESULT, proposals: existing.length } : await this.d.review.run({ sourceIds: run.sourceIds, autonomousKey: key });
      if (result.cancelled || !this.current() || this.d.memory.evidenceEpoch() !== run.epoch) throw new Error('Automatic Growth cancelled or sources changed');
      const candidates = this.d.proposals.list('candidate').filter(candidate => candidate.autonomousKey === key);
      run.candidateIds = candidates.map(candidate => candidate.id);
      for (const candidate of candidates) {
        const trusted = await readLocalGrowthProposal(this.d.memory, this.d.proposals, candidate.id);
        if (trusted.status !== 'candidate') await this.checkSemantics(candidate, sources);
      }
      if (!this.current() || this.d.memory.evidenceEpoch() !== run.epoch) throw new Error('Automatic Growth invalidated before completion');
      const accepted = await Promise.all(candidates.map(candidate => readLocalGrowthProposal(this.d.memory, this.d.proposals, candidate.id)));
      if (!this.current() || this.d.memory.evidenceEpoch() !== run.epoch) throw new Error('Automatic Growth invalidated before application');
      await this.d.onCandidatesReady?.(candidates.map(candidate => candidate.id), () => this.current() && this.d.memory.evidenceEpoch() === run.epoch);
      if (!this.current() || this.d.memory.evidenceEpoch() !== run.epoch) throw new Error('Automatic Growth invalidated during application');
      run.status = accepted.some(read => read.status === 'withheld') ? 'withheld' : candidates.length ? 'candidate_saved' : 'skipped_no_new_evidence';
      run.finishedAt = this.now().toISOString();
      this.state.seen = [...new Set([...this.state.seen, ...digests])].slice(-256);
      this.state.lastSuccessAt = run.finishedAt; this.save();
      return { ...result, note: run.status, candidateSourceResults: accepted.map((read, index) => ({
        candidateId: candidates[index]!.id, candidateType: 'growth_proposal_candidate', sourceKind: 'plan',
        status: read.status === 'candidate' ? 'local_persisted_and_verified' : 'withheld', writeStatus: 'local-only',
        readbackStatus: read.status === 'candidate' ? 'trusted-local-candidate' : 'withheld',
        ...(read.status === 'withheld' ? { reason: read.reason } : {}),
      })) };
    } catch (error) {
      if (this.state.lastRun) { this.state.lastRun.status = 'failed'; this.state.lastRun.error = error instanceof Error ? error.message : String(error); this.state.lastRun.finishedAt = this.now().toISOString(); this.save(); }
      throw error;
    } finally { this.running = false; }
  }

  private async checkSemantics(candidate: GrowthProposal, sources: ExactMemorySourceEvidence[]): Promise<void> {
    const memory = this.d.memory, core = this.d.core();
    const body = growthProposalArtifactText(candidate), digest = hash(body), epoch = memory.evidenceEpoch();
    const deterministic = growthContentIssues(candidate, sources);
    const reject = (issues: string[], proof?: GenerationEvidenceEnvelope, provenanceVerified = true): void => {
      if (this.current()) this.d.proposals.saveSemanticReview(candidate.id, { verdict: 'rejected', candidateDigest: digest, issues, ...(proof ? { generationProof: proof } : {}), interpretation: 'uncertain', provenanceVerified, contentConsistencyChecked: false, planExecuted: false, skillVerified: false, toolExecutionPermitted: false });
    };
    if (!core?.spawnForkWithOutcome || !epoch || !await memory.verifyDerivedArtifact(candidate.id, body)) { reject(['candidate_provenance_unavailable'], undefined, false); return; }
    if (deterministic.length) { reject(deterministic); return; }
    const artifact = memory.derivedArtifact(candidate.id)!;
    const evidence = await memory.evidenceForSegments(body, artifact.sources.map(source => ({ documentId: source.documentId, start: 0, end: body.length, derived: true })));
    const refs = evidence.map(({ segment: _segment, ...ref }) => ref);
    const instruction = 'Independently check this unapproved Growth candidate against its exact sources. Call memory_search exactly once, as the only tool call in its batch. This fixed-source search returns every selected record regardless of query; do not issue a second search. Inspect that result, then call finish_review alone. Source IDs, numeric cursors and their distance never prove time order or elapsed time; use the verified said_at metadata, and reject ID-based temporal claims. Check dates, time order, counts, literal quotes, actor attribution, corrections, and whether each claimed observation is supported. User-stated preferences are valid as their preferences, not external facts. Journal is an inference, not a completed action or verified skill. Never approve changes to relationship consent or tool permissions. Finish with finish_review whose note is JSON: {"verdict":"pass"|"reject","issues":[short reasons],"interpretation":"user_preference"|"inference"|"uncertain"}. The issues array contains blocking content defects only, never supporting observations or stylistic comments. A pass requires issues: []; a reject requires a concrete unsupported claim or contradiction. A candidate may address one preference without covering every preference in its sources. Use reject for contradictions, absent evidence or an unclear attribution; do not silently rewrite the candidate. Passing means content consistency checked only, never plan execution or objective truth. Candidate follows:\n';
    const spans: SourceMapSpan[] = [{ start: 0, end: instruction.length, digest: digestText(instruction), origin: 'core-generated' }, { start: instruction.length, end: instruction.length + body.length, digest, origin: 'artifact-derived', exposedSources: refs }];
    let verdict: { verdict: 'pass' | 'reject'; issues: string[]; interpretation: GrowthSemanticReview['interpretation'] } | null = null;
    let proof: GenerationEvidenceEnvelope | undefined;
    let invalidReason = 'semantic_review_not_passed';
    const deadline = Date.now() + (this.d.semanticTimeoutMs ?? 180_000);
    const current = (): boolean => this.current() && Date.now() < deadline && memory.evidenceEpoch() === epoch;
    const observed = new Set<string>();
    const finish = { ...FINISH_REVIEW_DECL, handler: async (args: Record<string, unknown>, ctx: ToolCallContext) => {
      if (!current()) return '[review finished]';
      try {
        const parsed = JSON.parse(String(args.note ?? ''));
        if (!['pass', 'reject'].includes(parsed.verdict) || !Array.isArray(parsed.issues) || parsed.issues.some((issue: unknown) => typeof issue !== 'string') || !['user_preference', 'inference', 'uncertain'].includes(parsed.interpretation)) return '[review finished]';
        if (!candidate.sourceIds.every(id => observed.has(id))) { invalidReason = 'semantic_sources_not_observed'; return '[review finished]'; }
        const matches = core.generationEvidence(ctx.sessionId ?? ctx.role).filter(envelope => envelope.outputToolCalls.some(call => call.toolCallId === ctx.callId));
        if (matches.length !== 1 || !memory.recordGenerationEvidenceEnvelope(matches[0]!, ctx.callId!)) { invalidReason = 'semantic_generation_source_receipt_invalid'; return '[review finished]'; }
        verdict = parsed; proof = matches[0]!;
      } catch { /* An unparseable verdict never becomes a consistency receipt. */ }
      return '[review finished]';
    } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fork = core.spawnForkWithOutcome({ id: GROWTH_VALIDATION_SESSION, messages: [message('user', instruction + body, { sourceMapSpans: spans })], tools: [growthMemorySearchTool(() => memory, observed, sources.map(source => source.documentId)), finish], stopWhen: () => !current() });
      const outcome = await Promise.race([fork, new Promise<never>((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(new Error('Semantic review deadline exceeded; late results are withheld')), Math.max(1, deadline - Date.now())); })]);
      const decision = verdict as { verdict: 'pass' | 'reject'; issues: string[]; interpretation: GrowthSemanticReview['interpretation'] } | null;
      if (!current() || outcome.status !== 'completed') throw new Error('Semantic review was cancelled or invalidated');
      if (!decision || !proof || decision.verdict !== 'pass' || decision.issues.length) { reject(decision?.issues.length ? decision.issues : [invalidReason], proof); return; }
      const review: GrowthSemanticReview = { verdict: 'passed', candidateDigest: digest, issues: [], generationProof: proof, interpretation: decision.interpretation, provenanceVerified: true, contentConsistencyChecked: true, planExecuted: false, skillVerified: false, toolExecutionPermitted: false };
      const call = proof.outputToolCalls.find(item => item.toolCallId === artifact.creatorOperationId) ?? proof.outputToolCalls.at(-1);
      if (!call || !current()) throw new Error('Semantic completion receipt unavailable');
      const receipt = await memory.registerDerivedArtifactFromSources({ artifactId: `growth-semantic:${candidate.id}`, kind: 'growth-semantic-review', target: `growth-proposals/${candidate.id}.json`, content: JSON.stringify(review), origin: 'model-derived', reviewState: 'unreviewed', sourceIds: artifact.sources.map(source => source.documentId), expectedEpoch: epoch, generationSources: proof.exposedSources, creatorOperationId: call.toolCallId, creatorSessionId: proof.sessionId, creatorGenerationId: proof.id, canCommit: current });
      if (!receipt || !current() || growthProposalArtifactText(this.d.proposals.get(candidate.id)!) !== body) throw new Error('Candidate changed during semantic review');
      this.d.proposals.saveSemanticReview(candidate.id, review);
    } finally { if (timer) clearTimeout(timer); }
  }
}
