/** Source-linked proposals remain reviewable records; bounded behavior policies have separate application receipts. */
import type { GenerationEvidenceEnvelope } from 'cortico/core/types.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeState } from '../state-file.ts';

export type GrowthRisk = 'low' | 'medium' | 'high';

export interface GrowthChange {
  file: 'CONSTITUTION.md' | 'SELF.md' | 'BEHAVIOR_POLICY';
  /** The lines the proposal would replace; omitted when adding a new line. */
  from?: string;
  to: string;
  reason: string;
}

export interface GrowthSemanticReview {
  verdict: 'passed' | 'rejected';
  candidateDigest: string;
  issues: string[];
  generationProof?: GenerationEvidenceEnvelope;
  interpretation: 'user_preference' | 'inference' | 'uncertain';
  provenanceVerified: boolean;
  contentConsistencyChecked: boolean;
  planExecuted: false;
  skillVerified: false;
  toolExecutionPermitted: false;
}

export interface GrowthProposal {
  id: string;
  createdAt: string;
  title: string;
  summary: string;
  evidence: string[];
  changes: GrowthChange[];
  risk: GrowthRisk;
  sourceIds: string[];
  state: 'candidate' | 'approved' | 'rejected' | 'applied';
  reviewedAt?: string;
  reviewNote?: string;
  appliedAt?: string;
  appliedCommit?: string;
  /** Core's joined receipt; metadata and digests only, retained for candidate revalidation. */
  generationProof?: GenerationEvidenceEnvelope;
  autonomousKey?: string;
  semanticReview?: GrowthSemanticReview;
}

export interface GrowthProposalInput {
  title?: unknown;
  summary?: unknown;
  evidence?: unknown;
  sourceIds?: unknown;
  changes?: unknown;
  risk?: unknown;
}

export function growthProposalArtifactText(proposal: Pick<GrowthProposal, 'title' | 'summary' | 'evidence' | 'changes' | 'risk' | 'generationProof' | 'sourceIds' | 'autonomousKey'>): string {
  return JSON.stringify({ title: proposal.title, summary: proposal.summary, evidence: proposal.evidence, changes: proposal.changes, risk: proposal.risk,
    ...(proposal.autonomousKey ? { autonomousKey: proposal.autonomousKey } : {}),
    ...(proposal.generationProof ? { sourceIds: proposal.sourceIds, generationProofDigest: createHash('sha256').update(JSON.stringify(proposal.generationProof)).digest('hex') } : {}),
  });
}

export type GrowthProposalResult =
  | { ok: true; proposal: GrowthProposal; path: string }
  | { ok: false; errors: string[] };

const FILES = new Set(['CONSTITUTION.md', 'SELF.md', 'BEHAVIOR_POLICY']);
const RISKS = new Set(['low', 'medium', 'high']);
const MAX_TOTAL = 12_000;
const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const body = value.trim();
  return body && body.length <= max ? body : null;
}

function changes(value: unknown): { changes: GrowthChange[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    return { changes: [], errors: ['changes must be an array of one to three entries'] };
  }
  const out: GrowthChange[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object') {
      errors.push(`changes[${index}] must be an object`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const file = typeof entry.file === 'string' ? entry.file.trim() : '';
    if (!FILES.has(file)) {
      errors.push(`changes[${index}].file must be CONSTITUTION.md, SELF.md or BEHAVIOR_POLICY`);
      continue;
    }
    const to = text(entry.to, 2000);
    const reason = text(entry.reason, 500);
    const from = entry.from === undefined ? undefined : text(entry.from, 2000);
    if (!to) errors.push(`changes[${index}].to must be 1-2000 characters`);
    if (!reason) errors.push(`changes[${index}].reason must be 1-500 characters`);
    if (entry.from !== undefined && !from) errors.push(`changes[${index}].from must be 1-2000 characters`);
    if (!to || !reason || (entry.from !== undefined && !from)) continue;
    out.push({
      file: file as GrowthChange['file'],
      ...(from ? { from } : {}),
      to,
      reason,
    });
  }
  return { changes: out, errors };
}

export function readProposalInput(input: GrowthProposalInput): { proposal: Omit<GrowthProposal, 'id' | 'createdAt' | 'state'> } | { errors: string[] } {
  const errors: string[] = [];
  const title = text(input.title, 120);
  const summary = text(input.summary, 1200);
  const risk = typeof input.risk === 'string' ? input.risk.trim() : '';
  if (!title) errors.push('title must be 1-120 characters');
  if (!summary) errors.push('summary must be 1-1200 characters');
  if (!RISKS.has(risk)) errors.push('risk must be low, medium or high');
  const evidence: string[] = [];
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 8) {
    errors.push('evidence must be an array of one to eight quotes or memory references');
  } else {
    for (const [index, entry] of input.evidence.entries()) {
      const line = text(entry, 600);
      if (!line) errors.push(`evidence[${index}] must be 1-600 characters`);
      else evidence.push(line);
    }
  }
  const sourceIds: string[] = [];
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length === 0 || input.sourceIds.length > 8) {
    errors.push('sourceIds must contain one to eight Hindsight document IDs');
  } else {
    for (const [index, entry] of input.sourceIds.entries()) {
      const id = text(entry, 200);
      if (!id || /[\r\n\0]/.test(id)) errors.push(`sourceIds[${index}] must be a Hindsight document ID`);
      else sourceIds.push(id);
    }
  }
  const parsed = changes(input.changes);
  errors.push(...parsed.errors);
  if (errors.length > 0 || !title || !summary || !RISKS.has(risk)) return { errors };
  const total = title.length + summary.length + evidence.join('').length
    + sourceIds.join('').length
    + parsed.changes.reduce((sum, change) => sum + change.to.length + change.reason.length + (change.from?.length ?? 0), 0);
  if (total > MAX_TOTAL) return { errors: [`the proposal is too large (${total} > ${MAX_TOTAL} characters)`] };
  return {
    proposal: {
      title,
      summary,
      evidence,
      sourceIds,
      changes: parsed.changes,
      risk: risk as GrowthRisk,
    },
  };
}

export class GrowthProposals {
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  write(input: GrowthProposalInput, generationProof?: GenerationEvidenceEnvelope, autonomousKey?: string): GrowthProposalResult {
    const parsed = readProposalInput(input);
    if ('errors' in parsed) return { ok: false, errors: parsed.errors };
    const proposal: GrowthProposal = {
      ...parsed.proposal,
      id: randomUUID(),
      createdAt: this.now().toISOString(),
      state: 'candidate',
      ...(autonomousKey ? { autonomousKey } : {}),
      ...(generationProof ? { generationProof: structuredClone(generationProof) } : {}),
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, `${proposal.id}.json`);
      writeState(path, `${JSON.stringify(proposal, null, 2)}\n`);
      return { ok: true, proposal, path };
    } catch (err) {
      return { ok: false, errors: [`could not write the proposal: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  saveSemanticReview(id: string, review: GrowthSemanticReview): GrowthProposal | null {
    const proposal = this.get(id);
    if (!proposal || proposal.state !== 'candidate' || !proposal.autonomousKey) return null;
    const next = { ...proposal, semanticReview: structuredClone(review) };
    writeState(join(this.dir, `${id}.json`), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  private read(name: string): GrowthProposal | null {
    if (!name.endsWith('.json') || !PROPOSAL_ID.test(name.slice(0, -5))) return null;
    try {
      const value = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Partial<GrowthProposal>;
      if (value.id !== name.slice(0, -5) || typeof value.createdAt !== 'string' || typeof value.title !== 'string' || typeof value.summary !== 'string') return null;
      if (!Array.isArray(value.evidence) || !Array.isArray(value.changes)) return null;
      const state = ['candidate', 'approved', 'rejected', 'applied'].includes(String(value.state)) ? value.state as GrowthProposal['state'] : 'candidate';
      const sourceIds = Array.isArray(value.sourceIds) ? value.sourceIds.filter((id): id is string => typeof id === 'string') : [];
      return { ...value, id: value.id, state, sourceIds } as GrowthProposal;
    } catch { return null; }
  }

  get(id: string): GrowthProposal | null {
    return PROPOSAL_ID.test(id) ? this.read(`${id}.json`) : null;
  }

  list(state?: GrowthProposal['state']): GrowthProposal[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => this.read(name))
        .filter((proposal): proposal is GrowthProposal => !!proposal && (!state || proposal.state === state))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  transition(id: string, state: 'approved' | 'rejected', note = ''): GrowthProposal | null {
    const proposal = this.get(id);
    if (!proposal || proposal.state !== 'candidate') return null;
    if (state === 'approved' && proposal.sourceIds.length === 0) return null;
    const next: GrowthProposal = {
      ...proposal,
      state,
      reviewedAt: this.now().toISOString(),
      ...(note.trim() ? { reviewNote: note.trim().slice(0, 500) } : {}),
    };
    writeState(join(this.dir, `${id}.json`), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  markApplied(id: string, commit: string): GrowthProposal | null {
    const proposal = this.get(id);
    if (!proposal || proposal.state !== 'approved' || !commit.trim()) return null;
    const next: GrowthProposal = { ...proposal, state: 'applied', appliedAt: this.now().toISOString(), appliedCommit: commit.trim() };
    writeState(join(this.dir, `${id}.json`), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  remove(id: string): boolean {
    if (!PROPOSAL_ID.test(id)) return false;
    try { unlinkSync(join(this.dir, `${id}.json`)); return true; }
    catch { return false; }
  }

  removeBySource(sourceIds: readonly string[]): number {
    const sourceSet = new Set(sourceIds);
    if (sourceSet.size === 0) return 0;
    let removed = 0;
    for (const proposal of this.list()) {
      if (proposal.sourceIds.length > 0 && !proposal.sourceIds.some((id) => sourceSet.has(id))) continue;
      try { unlinkSync(join(this.dir, `${proposal.id}.json`)); removed += 1; } catch { /* The review panel will show a retained record if deletion failed. */ }
    }
    return removed;
  }

  clear(): number {
    let removed = 0;
    for (const proposal of this.list()) {
      try { unlinkSync(join(this.dir, `${proposal.id}.json`)); removed += 1; } catch { /* Preserve unreadable records. */ }
    }
    return removed;
  }
}
