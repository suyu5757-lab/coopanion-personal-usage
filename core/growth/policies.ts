/** Core-owned reversible behavior policies; model proposals never authorize file or tool permissions. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrefixSegment, SourceMapSpan } from 'cortico/core/types.ts';
import { asRecord, InvalidState, readState, writeState } from '../state-file.ts';
import type { HindsightMemory } from '../memory/hindsight.ts';
import type { ActionReceiptLedger } from '../action-receipts.ts';
import type { FileSystemActionAuthorization, FileSystemActionAuthorizationRequest, FileSystemActionRefusal } from '../action-authorization.ts';
import { GrowthProposals, growthProposalArtifactText, type GrowthProposal } from './proposals.ts';
import { readLocalGrowthProposal } from './coo-growth-lifecycle.ts';

export type BehaviorPolicy =
  | { kind: 'focus_quiet'; enabled: boolean }
  | { kind: 'reply_style'; style: 'concise' | 'detailed' }
  | { kind: 'task_review'; mode: 'plan_then_check' | 'evidence_before_completion' };
export interface GrowthImpact {
  modelRisk: GrowthProposal['risk'];
  coreRisk: 'low' | 'medium' | 'high';
  reasons: string[];
  policies: BehaviorPolicy[];
}
export interface GrowthPolicyApplication extends GrowthImpact {
  candidateId: string;
  applicationId: string;
  candidateDigest: string;
  reviewState: 'approved_auto' | 'pending_owner' | 'approved_owner' | 'rejected_owner';
  state: 'applied' | 'revoked' | 'withheld' | 'pending_owner' | 'approved_owner';
  reason: string;
  appliedAt?: string;
  updatedAt: string;
  beforePolicies: BehaviorPolicy[];
  policiesDigest: string;
}
interface PolicyState { v: 1; focus: boolean; applications: GrowthPolicyApplication[] }
const sha = (body: string): string => createHash('sha256').update(body).digest('hex');
export const GROWTH_POLICY_FILE = 'growth-policies.json';

function policy(value: unknown): BehaviorPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.kind === 'focus_quiet' && Object.keys(item).sort().join() === 'enabled,kind' && typeof item.enabled === 'boolean') return { kind: item.kind, enabled: item.enabled };
  if (item.kind === 'reply_style' && Object.keys(item).sort().join() === 'kind,style' && ['concise', 'detailed'].includes(String(item.style))) return { kind: item.kind, style: item.style as 'concise' | 'detailed' };
  if (item.kind === 'task_review' && Object.keys(item).sort().join() === 'kind,mode' && ['plan_then_check', 'evidence_before_completion'].includes(String(item.mode))) return { kind: item.kind, mode: item.mode as 'plan_then_check' | 'evidence_before_completion' };
  return null;
}

/** Risk follows the actual destination and bounded effect, never the model's suggested level. */
export function assessGrowthImpact(proposal: GrowthProposal): GrowthImpact {
  const result: GrowthImpact = { modelRisk: proposal.risk, coreRisk: 'low', reasons: [], policies: [] };
  for (const change of proposal.changes) {
    if (change.file !== 'BEHAVIOR_POLICY') return { ...result, coreRisk: 'high', reasons: ['persona-file-requires-owner-and-workspace-permission'], policies: [] };
    let parsed: BehaviorPolicy | null = null;
    try { parsed = policy(JSON.parse(change.to)); } catch { /* Invalid policy JSON never becomes executable content. */ }
    if (!parsed || change.from !== undefined) return { ...result, coreRisk: 'high', reasons: ['unbounded-or-unknown-policy-effect'], policies: [] };
    if (result.policies.some(existing => existing.kind === parsed!.kind)) return { ...result, coreRisk: 'high', reasons: ['conflicting-policy-slots'], policies: [] };
    result.policies.push(parsed);
    if (parsed.kind === 'task_review') result.coreRisk = 'medium';
  }
  if (result.policies.length === 0) return { ...result, coreRisk: 'high', reasons: ['no-bounded-policy-effect'] };
  result.reasons = [result.coreRisk === 'medium' ? 'reversible-local-task-workflow' : 'reversible-local-conversation-preference'];
  return result;
}

export function behaviorPolicyText(item: BehaviorPolicy): string {
  if (item.kind === 'focus_quiet') return item.enabled
    ? 'During the user-selected focus context, hold routine proactive check-ins until a break. Direct user requests and urgent safety messages remain allowed.'
    : 'The learned quiet-focus override is disabled; use the ordinary interaction settings.';
  if (item.kind === 'reply_style') return item.style === 'concise'
    ? 'Prefer concise replies that retain the answer, essential evidence and uncertainty. Expand when the person asks.'
    : 'Prefer detailed replies with relevant reasoning and examples, while preserving uncertainty and avoiding repetition.';
  return item.mode === 'plan_then_check'
    ? 'For multi-step work, state a brief plan, carry out only authorized steps, then check the result before claiming completion. This grants no tool permissions.'
    : 'Before claiming an action is complete, compare the actual result with its receipt. Unknown remains unknown. This grants no tool permissions.';
}

export interface GrowthPoliciesDeps {
  rootDir: string;
  proposals: GrowthProposals;
  memory: HindsightMemory;
  enabled: () => boolean;
  authorize: (request: FileSystemActionAuthorizationRequest) => Promise<FileSystemActionAuthorization | FileSystemActionRefusal | null>;
  receipts: () => ActionReceiptLedger | null;
  changed?: () => void;
}

export class GrowthPolicies {
  private readonly file: string;
  private serial: Promise<unknown> = Promise.resolve();
  private cached: Array<{ application: GrowthPolicyApplication; artifactId: string }> = [];
  constructor(private readonly d: GrowthPoliciesDeps) { this.file = join(d.rootDir, GROWTH_POLICY_FILE); }
  private load(): PolicyState {
    return readState(this.file, value => {
      const state = asRecord(value);
      if (state.v !== 1 || typeof state.focus !== 'boolean' || !Array.isArray(state.applications)
        || state.applications.length > 256 || state.applications.some(item => !item || typeof item !== 'object' || typeof item.candidateId !== 'string' || !Array.isArray(item.policies))) throw new InvalidState('invalid Growth policy state');
      return state as unknown as PolicyState;
    }) ?? { v: 1, focus: false, applications: [] };
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.then(action, action); this.serial = next; return next;
  }
  private contextId(entry: GrowthPolicyApplication): string { return `growth-policy:${entry.applicationId}`; }
  private contextText(entry: GrowthPolicyApplication): string { return entry.policies.map(behaviorPolicyText).join('\n'); }
  private rawDigest(): string { return sha(existsSync(this.file) ? readFileSync(this.file, 'utf8') : ''); }
  private recoverReceipts(): void {
    const ledger = this.d.receipts();
    if (!ledger) return;
    for (const receipt of ledger.listUnresolved()) {
      if (!receipt.action.startsWith('growth-policy-') || receipt.target.surface !== 'filesystem'
        || receipt.target.path !== GROWTH_POLICY_FILE || receipt.target.workspaceRoot !== realpathSync(this.d.rootDir)) continue;
      if (receipt.approvalChannel !== 'durable-rule' || receipt.policyRuleId !== 'growth-controlled-policy' || !receipt.grantDigest) continue;
      const actual = this.rawDigest(), evidence = { source: 'growth-policy-recovery', status: 'exact-readback', digest: actual, observedAt: Date.now() };
      if (actual === receipt.payloadDigest) ledger.complete(receipt.id, { phase: 'verified', dispatchState: 'delivered', outcome: 'verified', note: 'Recovered the exact committed Growth policy digest.', evidence });
      else if (actual === receipt.target.snapshotId) ledger.complete(receipt.id, { phase: 'failed', dispatchState: 'not-dispatched', outcome: 'failed', note: 'Recovered an unchanged pre-write Growth policy state.', evidence });
    }
  }
  private async write(next: PolicyState, operation: string, taskId: string, mayCommit: () => boolean): Promise<void> {
    if (next.applications.length > 256) throw new Error('Growth policy capacity reached; existing applications were preserved.');
    mkdirSync(this.d.rootDir, { recursive: true });
    if (existsSync(this.file) && (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink())) throw new Error('The Growth policy target is not an ordinary file');
    this.recoverReceipts();
    const before = this.rawDigest(), text = JSON.stringify(next, null, 2) + '\n', digest = sha(text);
    const target = { surface: 'filesystem' as const, instanceId: 'coopanion-growth-policy', workspaceRoot: realpathSync(this.d.rootDir), path: GROWTH_POLICY_FILE, operation: 'file-write' as const, snapshotId: before, source: 'persona-workspace' as const };
    const files = [{ path: GROWTH_POLICY_FILE, digest, bytes: Buffer.byteLength(text), mime: 'application/json' }];
    const request: FileSystemActionAuthorizationRequest = { taskId, taskText: `Update the bounded Growth policy state (${operation}).`, expectedChange: digest, risk: 'REVERSIBLE_LOCAL', target, action: 'file-write', files, expiresInMs: 60_000, maxSteps: 1, actionName: `growth-policy-${operation}`, payloadDigest: digest, operation: existsSync(this.file) ? 'update' : 'create', targetState: existsSync(this.file) ? 'present' : 'absent', baseDigest: before, background: true };
    const authorization = await this.d.authorize(request);
    if (!authorization || !('consume' in authorization)) throw new Error('The bounded Growth policy write was not authorized');
    const unsafeTarget = realpathSync(this.d.rootDir) !== target.workspaceRoot
      || [this.file, this.file + '.tmp'].some(path => existsSync(path) && lstatSync(path).isSymbolicLink());
    if (unsafeTarget || !mayCommit() || this.rawDigest() !== before || !authorization.consume(target, digest, files)) { authorization.revoke(); throw new Error('Growth policy authorization or source state changed before writing'); }
    let written = false;
    try {
      writeState(this.file, text); written = true;
      if (this.rawDigest() !== digest) throw new Error('Growth policy readback digest mismatch');
      authorization.complete({ phase: 'verified', dispatchState: 'delivered', outcome: 'verified', note: 'Bounded Growth policy state was written and read back.', evidence: { source: 'growth-policy-readback', status: 'verified', digest, observedAt: Date.now() } });
      this.d.changed?.();
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      authorization.complete(written ? { phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown', note } : { phase: 'failed', dispatchState: 'not-dispatched', outcome: 'failed', note });
      throw error;
    }
  }
  async reconcile(ids?: readonly string[], allowed: () => boolean = () => true): Promise<void> {
    return this.serialize(async () => {
      await this.refreshInternal();
      if (!this.d.enabled() || !allowed()) return;
      const proposals = ids ? ids.flatMap(id => this.d.proposals.get(id) ?? []) : this.d.proposals.list('candidate');
      for (const proposal of proposals) {
        const impact = assessGrowthImpact(proposal), current = this.load();
        const existing = current.applications.find(entry => entry.candidateId === proposal.id);
        if (existing) continue;
        const verified = await readLocalGrowthProposal(this.d.memory, this.d.proposals, proposal.id);
        if (verified.status !== 'candidate' || !verified.contentConsistencyChecked) continue;
        const epoch = this.d.memory.evidenceEpoch();
        const candidateDigest = sha(growthProposalArtifactText(proposal));
        const applicationId = sha(JSON.stringify([proposal.id, candidateDigest, impact.policies]));
        const entry: GrowthPolicyApplication = { ...impact, candidateId: proposal.id, candidateDigest, applicationId, reviewState: impact.coreRisk === 'high' ? 'pending_owner' : 'approved_auto', state: impact.coreRisk === 'high' ? 'pending_owner' : 'applied', reason: impact.reasons[0]!, updatedAt: new Date().toISOString(), ...(impact.coreRisk !== 'high' ? { appliedAt: new Date().toISOString() } : {}), beforePolicies: this.cached.flatMap(item => item.application.policies), policiesDigest: sha(JSON.stringify(impact.policies)) };
        const canCommit = (): boolean => allowed() && this.d.enabled() && this.d.memory.evidenceEpoch() === epoch
          && this.d.memory.derivedArtifactIsCurrent(proposal.id, growthProposalArtifactText(proposal))
          && JSON.stringify(this.d.proposals.get(proposal.id)) === JSON.stringify(proposal);
        if (impact.coreRisk !== 'high' && !await this.ensureContext(entry, proposal)) continue;
        await this.write({ ...current, applications: [...current.applications, entry] }, impact.coreRisk === 'high' ? 'review-pending' : 'apply', `growth-policy:${applicationId}`, canCommit);
      }
      await this.refreshInternal();
    });
  }
  private async ensureContext(entry: GrowthPolicyApplication, proposal: GrowthProposal): Promise<boolean> {
    const memory = this.d.memory, id = this.contextId(entry), text = this.contextText(entry);
    const existing = memory.derivedArtifact(id);
    if (existing?.lifecycleState === 'withdrawn') return false;
    if (existing) return memory.verifyDerivedArtifact(id, text);
    const original = memory.derivedArtifact(proposal.id), proof = proposal.generationProof;
    if (!original || !proof) return false;
    const epoch = memory.evidenceEpoch();
    return !!await memory.registerDerivedArtifactFromSources({ artifactId: id, kind: 'growth-policy', target: `${GROWTH_POLICY_FILE}#${entry.applicationId}`, content: text, origin: 'model-derived', reviewState: 'approved', sourceIds: original.sources.map(source => source.documentId), expectedEpoch: epoch!, generationSources: proof.exposedSources, creatorOperationId: original.creatorOperationId!, creatorSessionId: original.creatorSessionId!, creatorGenerationId: original.creatorGenerationId!, canCommit: () => this.d.enabled() && memory.evidenceEpoch() === epoch });
  }
  private async refreshInternal(): Promise<void> {
    this.cached = [];
    if (!this.d.enabled()) return;
    this.recoverReceipts();
    let state = this.load();
    const invalid: string[] = [];
    for (const entry of [...state.applications].reverse()) {
      if (entry.state !== 'applied') continue;
      const receipt = this.d.receipts()?.findByTaskId(`growth-policy:${entry.applicationId}`);
      const receiptValid = receipt?.phase === 'verified' && receipt.dispatchState === 'delivered'
        && receipt.approvalChannel === 'durable-rule' && receipt.policyRuleId === 'growth-controlled-policy';
      const proposal = this.d.proposals.get(entry.candidateId);
      const read = await readLocalGrowthProposal(this.d.memory, this.d.proposals, entry.candidateId);
      const impact = proposal ? assessGrowthImpact(proposal) : null;
      if (!receiptValid || !proposal || read.status !== 'candidate' || !read.contentConsistencyChecked || !impact || impact.coreRisk === 'high'
        || sha(growthProposalArtifactText(proposal)) !== entry.candidateDigest
        || sha(JSON.stringify(impact.policies)) !== entry.policiesDigest || JSON.stringify(impact.policies) !== JSON.stringify(entry.policies)
        || !await this.ensureContext(entry, proposal)) { invalid.push(entry.applicationId); continue; }
      this.cached.push({ application: entry, artifactId: this.contextId(entry) });
    }
    if (invalid.length) {
      for (const id of invalid) this.d.memory.withdrawDerivedArtifact(`growth-policy:${id}`, 'growth-policy-source-or-approval-invalid');
      state = { ...state, applications: state.applications.map(entry => invalid.includes(entry.applicationId) ? { ...entry, state: 'revoked', reason: 'source-or-content-revoked', updatedAt: new Date().toISOString() } : entry) };
      await this.write(state, 'revoke', `growth-policy:revoke:${sha(invalid.join())}`, () => true);
    }
  }
  async refresh(): Promise<void> { return this.serialize(() => this.refreshInternal()); }
  revoke(candidateId: string): Promise<void> {
    return this.serialize(async () => {
      const state = this.load(), entry = state.applications.find(item => item.candidateId === candidateId);
      if (!entry || entry.state === 'revoked') return;
      this.d.memory.withdrawDerivedArtifact(this.contextId(entry), 'growth-policy-owner-revoked');
      this.cached = this.cached.filter(item => item.application.candidateId !== candidateId);
      await this.write({ ...state, applications: state.applications.map(item => item.candidateId === candidateId ? { ...item, state: 'revoked', reason: 'owner-revoked', updatedAt: new Date().toISOString() } : item) }, 'revoke', `growth-policy:revoke:${entry.applicationId}`, () => true);
    });
  }
  reviewOwner(candidateId: string, approved: boolean, note: string): Promise<void> {
    return this.serialize(async () => {
      const state = this.load(), entry = state.applications.find(item => item.candidateId === candidateId);
      if (!entry || entry.coreRisk !== 'high') throw new Error('An Owner-review high-risk candidate is required');
      await this.write({ ...state, applications: state.applications.map(item => item.candidateId === candidateId ? { ...item, reviewState: approved ? 'approved_owner' : 'rejected_owner', state: approved ? 'approved_owner' : 'revoked', reason: note.slice(0, 300) || (approved ? 'owner-approved-awaiting-target-permission' : 'owner-rejected'), updatedAt: new Date().toISOString() } : item) }, 'owner-review', `growth-policy:owner:${entry.applicationId}`, () => true);
    });
  }
  setFocus(value: boolean): Promise<void> {
    return this.serialize(async () => { await this.write({ ...this.load(), focus: value }, 'focus-context', `growth-policy:focus:${Date.now()}`, () => true); });
  }
  status(): PolicyState & { enabled: boolean; effective: BehaviorPolicy[] } {
    return { ...this.load(), enabled: this.d.enabled(), effective: this.effective() };
  }
  private effective(): BehaviorPolicy[] {
    if (!this.d.enabled()) return [];
    const slots = new Map<string, BehaviorPolicy>();
    for (const item of this.cached) {
      if (!this.d.memory.derivedArtifactIsCurrent(item.artifactId, this.contextText(item.application))) continue;
      if (item.application.policies.some(p => slots.has(p.kind))) continue;
      for (const p of item.application.policies) slots.set(p.kind, p);
    }
    return [...slots.values()];
  }
  quietFocus(): boolean { return this.load().focus && this.effective().some(p => p.kind === 'focus_quiet' && p.enabled); }
  async prefix(): Promise<PrefixSegment | null> {
    await this.refresh();
    let text = '', spans: SourceMapSpan[] = [];
    const selected = new Set<string>();
    for (const item of this.cached) {
      if (item.application.policies.some(p => selected.has(p.kind))) continue;
      const body = this.contextText(item.application), artifact = this.d.memory.derivedArtifact(item.artifactId);
      if (!artifact || !this.d.memory.derivedArtifactIsCurrent(item.artifactId, body)) continue;
      const evidence = await this.d.memory.evidenceForSegments(body, artifact.sources.map(source => ({ documentId: source.documentId, start: 0, end: body.length, derived: true })));
      if (evidence.length !== artifact.sources.length) continue;
      if (text) { const start = text.length; text += '\n'; spans.push({ start, end: text.length, digest: sha('\n'), origin: 'core-generated' }); }
      const start = text.length; text += body;
      spans.push({ start, end: text.length, digest: sha(body), origin: 'artifact-derived', exposedSources: evidence.map(({ segment: _segment, ...source }) => source) });
      item.application.policies.forEach(p => selected.add(p.kind));
    }
    return text ? { title: 'GROWTH_POLICIES', text, sourceMapSpans: spans } : null;
  }
}
