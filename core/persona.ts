import { GrowthPolicies, assessGrowthImpact } from './growth/policies.ts';
import { AutonomousGrowth, GROWTH_VALIDATION_SESSION } from './growth/autonomous.ts';
import { createLocalGrowthCandidateLifecycle, readLocalGrowthProposal } from './growth/coo-growth-lifecycle.ts';
/**
 * Coo's Persona: Cortico's Cormini with four changes for the desktop pet.
 *
 * - `PARTNER.md` in the workspace goes into the system prefix whole (Cormini's partner segment), after a
 *   standing line asking Coo to keep it short and put details under `partner/`, and cannot be deleted with
 *   `delete_file`, as `CONSTITUTION.md` cannot.
 * - In Coopanion Core, each workspace write asks for a one-use grant, records an action receipt and
 *   verifies the file after dispatch. Successful writes are committed one per tool call; `blobs/` is
 *   left out of Git. A standalone Persona without the Core callback keeps its local write behavior.
 * - The lines the Persona itself puts into the context (a session opening, new events, a World
 *   switched, context pressure, the handoff, the round cap, stalls) and its workspace listing are in
 *   English whatever the app language; Coo is told which language to talk in by the desktop-pet World.
 * - While `companion.selfTime` is on, Cormini's quiet heartbeat offers time of her own instead of only
 *   speaking first: the browser World's tools are available and the line names the session limit.
 *
 * Cortico is staged at build time and the bots are not part of its module paths, so the base class is
 * passed in: the app loads it from the staged Cortico (`companion.ts`), the tests from vendor/cortico.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOG_SCHEME, blobScheme } from 'cortico/core/blobs.ts';
import type { CoreApi, ContextEvidenceInspection, ContextHandoffPrepareContext, ContextHandoffSourceExcerpt, EvidenceAttachment, EventEnvelope, HandoffCommitCheck, PersonaWebUiDecl, PreparedContextHandoff, PrefixSegment, SessionDecl, SessionOpeningReason, SourceDependencyRecovery, SourceExposureRef, SourceMapSpan, StoragePart, SystemPrefixContext, ToolCallContext, ToolDef, ToolOutcome, WorldLifecycleEvent } from 'cortico/core/types.ts';
import { message, withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { Language } from 'cortico/core/language.ts';
import { repoRoot } from 'cortico/paths.ts';
import type { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import type { GitAuthor, WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { memoryTools } from './memory/tools.ts';
import type { DomainSupplementOptions, DomainSupplementReceipt, HindsightMemory, MemoryEvidenceSegment, PartnerSourceStatus, TurnRecall, TurnRecallStatus } from './memory/hindsight.ts';
import { baselineSourceExcerpts, consumeDomainRelevantMemory, type CoreMemoryConsumption, type DomainRelevantConsumeResult } from './memory/domain-relevant-consume.ts';
import type { DerivedArtifact } from './memory/state-store.ts';
import { evidenceCoversSegments, evidenceCoversText } from './memory/source-evidence.ts';
import { isMemoryForgetRequest } from './memory/router.ts';
import { memoryStorageText } from './memory/strings.ts';
import type { WorkspacePermissionStore } from './workspace-permissions.ts';
import { WorkspaceToolTextLedger, workspaceToolOutcome } from './workspace-tool-text.ts';
import { workspaceReadLabel, workspaceJournalSourceId, workspaceReadFencedLabel } from './workspace-read.ts';
import { canonicalOperatingText, canonicalPersonaText, isShippedOrientation, isShippedPersonaDescription } from './seed.ts';
import type { PromptProvenance } from './prompt-provenance.ts';
import {
  filterPartnerMarkdown,
  markPartnerDerivedStale,
  markPartnerSourcesStale,
  partnerProvenancePath,
  partnerSegmentDigest,
  partnerSegments,
  partnerWorkspaceDigest,
  readPartnerProvenance,
  writePartnerProvenance,
  type PartnerProvenanceEntry,
  type PartnerTextResult,
} from './memory/partner-provenance.ts';
import { SESSION_MAX_CALLS, type SelfTimeConfig } from './browser/config.ts';
import { selfTimeLine } from './browser/model-text.ts';
import { GROWTH_DEFAULTS, type GrowthConfig } from './growth/config.ts';
import { GROWTH_SESSION, GROWTH_TOOL_NAMES, GrowthReview, growthMemorySearchTool } from './growth/review.ts';
import { EXPERIENCE_CONTEXT_HEADER, ExperienceCards, experienceCardArtifactText, readExperienceCardInput, type ExperienceCard } from './growth/experience-cards.ts';
import { GrowthProposals, growthProposalArtifactText, type GrowthProposal } from './growth/proposals.ts';
import { GROWTH_CHECK_MS, GrowthSchedule } from './growth/schedule.ts';
import { readResourcePressure } from './resource-pressure.ts';
import { MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, SOURCE_CONTEXT_POLICY, memoryReadNotice } from './memory/model-text.ts';
import type { ModelLanguage } from './language.ts';
import type { FileSystemActionAuthorization, FileSystemActionAuthorizationRequest, FileSystemActionRefusal } from './action-authorization.ts';
import type { ActionReceiptLedger, ActionReceiptReviewDecision } from './action-receipts.ts';
import type { FileSystemTargetEvidence } from './task-grants.ts';
import { writeState } from './state-file.ts';

// The app runs the staged Cortico; a source checkout's vendor path is only a type source.
// Handoff constants and rendering come from whichever tree repoRoot() names.
const handoffPersona = (await import(pathToFileURL(join(repoRoot(), 'bots', 'cormini', 'persona', 'persona.ts')).href)) as typeof import('../vendor/cortico/bots/cormini/persona/persona.ts');
const { HANDOFF_DIR } = handoffPersona;
const handoffNote = (await import(pathToFileURL(join(repoRoot(), 'bots', 'cormini', 'persona', 'handoffNote.ts')).href)) as typeof import('../vendor/cortico/bots/cormini/persona/handoffNote.ts');
const { HANDOFF_NOTE_TYPE, handoffNoteStamp, renderHandoffNote } = handoffNote;

/** The workspace file that goes into the prefix as Coo's notes on the person. */
export const PARTNER_FILE = 'PARTNER.md';
const CONSTITUTION_FILE = 'CONSTITUTION.md';
/** The workspace directory for details about the person that PARTNER.md leaves out; Coo reads them when needed. */
export const PARTNER_DIR = 'partner';
/** Heads partner notes so their source class stays visible in model context. */
export const PARTNER_NOTE = `${PARTNER_FILE} in your workspace is paired with a private provenance sidecar. Only unchanged paragraphs with current provenance are included below. `
  + 'User-authored paragraphs are workspace notes, not original event evidence. Derived paragraphs show their source IDs; check Memory for the original source before using them to establish a past decision or shared event. Untracked, stale, edited or ambiguous paragraphs are withheld; omitted details are unknown, not false.';
/** Commits of Coo's own writes. */
export const AUTHOR_COO: GitAuthor = { name: 'coo', email: 'coo@persona.local' };
/** Commits the app makes on its own: the snapshot at start. */
export const AUTHOR_APP: GitAuthor = { name: 'coopanion', email: 'app@persona.local' };
/** What the workspace's `.gitignore` holds besides Cormini's own line: the binaries Coo saves stay out of the history. */
const BLOBS_DIR = 'blobs/';
/** Tags made by `snapshot`: the workspace as each version of the app first found it. */
export const SNAPSHOT_TAG = (version: string) => `start-${version}`;
/** How long after a line a "don't remember that" still refers to it. */
const FORGET_WINDOW_MS = 10 * 60_000;
const MEMORY_TOOL_NAMES = new Set(['memory_search', 'memory_remember', 'memory_correct', 'memory_forget', 'memory_reflect']);
/** Core's reserved synthetic call that carries an external event frame; mirrored read-only. */
const EXTERNAL_EVENT_FRAME = 'external_event_frame';
const WORKSPACE_READ_PATHS: Record<string, string> = {
  read_file: 'path',
  list_files: 'dir',
  glob_files: 'target_directory',
  grep_files: 'path',
};

const PARTNER_USER_LABEL = '[workspace note; user-authored; no original event source is recorded]';
const PARTNER_DERIVED_LABEL_PREFIX = '[workspace summary; source_ids=';
const PARTNER_DERIVED_LABEL_SUFFIX = '; source references passed the local provenance and forget-fence checks; verify original Memory sources before citing history]';
const PARTNER_READ_WITHHELD = '[read failed] PARTNER.md paragraphs are withheld because their provenance is not current.';
const PARTNER_READ_WITHHELD_NOTICE = '[system] Some PARTNER.md paragraphs are withheld because their provenance is missing, stale, edited or ambiguous. The omitted statements are unknown, not false.';

type PartnerSyncStatus = 'registered' | 'pending' | 'failed' | 'unavailable' | 'ignored';
interface PartnerSyncResult {
  status: PartnerSyncStatus;
  current: number;
  pending: number;
  stale: number;
  failed: number;
}

interface ForgottenHandoffReset {
  phase: 'awaiting-block' | 'reset-ready';
  rawContext?: true;
  eventCutoff?: number;
  forgottenIds: string[];
  sourceRefs: SourceExposureRef[];
  artifactIds: string[];
  expectedEpoch: string;
  candidateSnapshotId?: string;
  resetCandidateSnapshotId?: string;
  expectedGeneration?: string;
  resolveBlocked: () => void;
}

interface CleanHandoffRebuild {
  expectedEpoch: string;
  forgottenIds: string[];
  sourceRefs: SourceExposureRef[];
  inputs: Array<{ text: string; attachment: EvidenceAttachment }>;
}

function handoffSourceIdentity(source: Pick<SourceExposureRef, 'bankId' | 'endpoint' | 'documentId' | 'contentDigest'>): string {
  return JSON.stringify([source.bankId, source.endpoint, source.documentId, source.contentDigest]);
}

function handoffSourceProofIdentity(source: SourceExposureRef): string {
  return JSON.stringify([source.bankId, source.endpoint, source.documentId, source.validatedEpoch,
    source.revisionState, source.validationStatus, source.validationReceipt, source.contentDigest]);
}

function sourceRefFromAttachment(attachment: EvidenceAttachment): SourceExposureRef {
  const { segment: _segment, ...source } = attachment;
  return source;
}

/** Result of the opt-in path: either a fully proven supplement or an ordinary baseline fallback. */
type DomainSupplementOutcome =
  | {
    kind: 'finalized';
    text: string;
    evidence: EvidenceAttachment[];
    segments: MemoryEvidenceSegment[];
    result: DomainRelevantConsumeResult;
  }
  | {
    kind: 'fallback';
    reason: string;
    result: DomainRelevantConsumeResult | null;
  };

/**
 * Content-free diagnostics for the opt-in supplement. Source text, query hashes, document and bank
 * identities, proofs and provider details stay out of this shape.
 */
export interface DomainSupplementDiagnostics {
  available: boolean;
  enabled: boolean;
  receiptState: 'disabled' | 'unavailable' | 'no_receipt' | 'in_progress' | 'settled';
  receiptPresent: boolean;
  turnActive: boolean;
  /** Persona-side finalization only; never Core dispatch or model use. */
  status: 'finalized' | 'fallback' | 'skipped' | null;
  fallbackReason: string | null;
  baselineStatus: TurnRecallStatus | null;
  candidateCount: number | null;
  verifiedCount: number | null;
  consumedCount: number | null;
  addedSourceCount: number | null;
  withheldCount: number | null;
  fallbackCount: number | null;
  finalizedSegmentCount: number | null;
  queryCalls: number | null;
  readbackCalls: number | null;
  finalReadbackCalls: number | null;
  supplementalChars: number | null;
  elapsedMs: number | null;
  rssDeltaBytes: number | null;
  receiptAgeMs: number | null;
  scope: 'persona-domain-supplement';
  core: {
    requestState: 'UNKNOWN';
    actualEvidenceUsed: 'UNKNOWN';
    evidenceObserved: false;
  };
}

const DOMAIN_SUPPLEMENT_RECEIPT_STATUSES: readonly string[] = ['finalized', 'fallback', 'skipped'];
const TURN_RECALL_STATUSES: readonly string[] = ['found', 'absent', 'incomplete', 'unavailable', 'fenced', 'skipped'];
const DOMAIN_SUPPLEMENT_FALLBACK_REASONS: readonly string[] = [
  'baseline_absent', 'baseline_incomplete', 'baseline_unavailable', 'baseline_fenced', 'baseline_skipped',
  'baseline_identity_unavailable', 'baseline_evidence_incomplete',
  'memory_unavailable', 'accessors_unavailable', 'consume_exception', 'exception',
  'invalid_limits', 'invalid_input', 'source_epoch_unavailable', 'query_unavailable', 'query_fenced',
  'cancelled', 'index_blocked', 'source_limit', 'readback_budget', 'output_budget', 'query_truncated',
  'no_candidates', 'supplement_source_limit', 'supplement_output_budget', 'final_readback_budget',
  'final_epoch_changed', 'delivery_failed', 'delivery_count', 'delivery_mismatch',
  'baseline_not_preserved', 'supplement_budget', 'consumed_source_mismatch', 'no_new_segments',
  'source_namespace_mismatch', 'supplement_span_mismatch', 'duplicate_supplement_span',
  'segment_count_mismatch', 'supplement_segment_invalid', 'segment_span_mismatch',
  'raw_attachment_mismatch', 'finalize_incomplete', 'finalize_invalid', 'epoch_changed',
  'baseline_only', 'fenced', 'unavailable',
];
const DOMAIN_SUPPLEMENT_CORE_UNKNOWN = Object.freeze({
  requestState: 'UNKNOWN' as const,
  actualEvidenceUsed: 'UNKNOWN' as const,
  evidenceObserved: false as const,
});

function safeDomainSupplementStatus(value: unknown): 'finalized' | 'fallback' | 'skipped' | null {
  return typeof value === 'string' && DOMAIN_SUPPLEMENT_RECEIPT_STATUSES.includes(value)
    ? value as 'finalized' | 'fallback' | 'skipped'
    : null;
}

function safeTurnRecallStatus(value: unknown): TurnRecallStatus | null {
  return typeof value === 'string' && TURN_RECALL_STATUSES.includes(value) ? value as TurnRecallStatus : null;
}

function safeDomainSupplementFallbackReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && DOMAIN_SUPPLEMENT_FALLBACK_REASONS.includes(value) ? value : 'other';
}

function nonNegativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

const DOMAIN_SUPPLEMENT_EMPTY = Object.freeze({
  receiptPresent: false,
  turnActive: false,
  status: null,
  fallbackReason: null,
  baselineStatus: null,
  candidateCount: null,
  verifiedCount: null,
  consumedCount: null,
  addedSourceCount: null,
  withheldCount: null,
  fallbackCount: null,
  finalizedSegmentCount: null,
  queryCalls: null,
  readbackCalls: null,
  finalReadbackCalls: null,
  supplementalChars: null,
  elapsedMs: null,
  rssDeltaBytes: null,
  receiptAgeMs: null,
} satisfies Omit<DomainSupplementDiagnostics,
  'available' | 'enabled' | 'receiptState' | 'scope' | 'core'>);

/** Fixed labels a PARTNER read may carry; anything else in a tool result needs a source. */
export function isTrustedPartnerReadText(text: string): boolean {
  if (text === PARTNER_USER_LABEL || text === PARTNER_READ_WITHHELD || text === PARTNER_READ_WITHHELD_NOTICE) return true;
  if (!text.startsWith(PARTNER_DERIVED_LABEL_PREFIX) || !text.endsWith(PARTNER_DERIVED_LABEL_SUFFIX)) return false;
  try {
    const ids = JSON.parse(text.slice(PARTNER_DERIVED_LABEL_PREFIX.length, text.length - PARTNER_DERIVED_LABEL_SUFFIX.length));
    return Array.isArray(ids) && ids.length > 0
      && ids.every((id) => typeof id === 'string' && !!id && !/[\r\n\0]/u.test(id));
  } catch {
    return false;
  }
}

function partnerSegmentLabel(segment: { origin: 'user-authored' | 'derived'; sourceIds: string[] }): string {
  return segment.origin === 'derived'
    ? `${PARTNER_DERIVED_LABEL_PREFIX}${JSON.stringify(segment.sourceIds)}${PARTNER_DERIVED_LABEL_SUFFIX}`
    : PARTNER_USER_LABEL;
}

function partnerSegmentContextText(segment: { text: string; origin: 'user-authored' | 'derived'; sourceIds: string[] }): string {
  return `${partnerSegmentLabel(segment)}\n${segment.text}`;
}

function partnerEvidenceText(result: PartnerTextResult): string {
  return result.segments.map(partnerSegmentContextText).join('\n\n');
}

function workspaceReadResult(path: string, result: unknown): string | ToolOutcome {
  const label = workspaceReadLabel(path);
  const span = (text: string, start: number): { start: number; end: number; digest: string; origin: 'core-generated' } => ({
    start, end: start + text.length, digest: sha256(text), origin: 'core-generated',
  });
  if (typeof result === 'string') {
    // A fixed tool status line is not file material.
    if (/^\[(?:not found|read failed|search failed|workspace read failed)/iu.test(result)) return result;
    const text = `${label}\n${result}`;
    return { text, sourceMapSpans: [span(label, 0), span(result, label.length + 1)] };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return String(result ?? '');
  const record = result as Record<string, unknown>;
  if (typeof record.text !== 'string') return String(result);
  const body = record.text ? `\n${record.text}` : '';
  const text = `${label}${body}`;
  return {
    ...record,
    text,
    sourceMapSpans: [span(label, 0), ...(body ? [span(record.text, label.length + 1)] : [])],
  } as ToolOutcome;
}

function withWorkspaceSourceMap(value: string | ToolOutcome): ToolOutcome {
  if (typeof value === 'string') return workspaceToolOutcome(value);
  return value.sourceMapSpans?.length ? value : { ...value, sourceMapSpans: workspaceToolOutcome(value.text).sourceMapSpans };
}

function isWorkspaceGitMetadataPath(root: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const rootPath = resolve(root);
  const path = resolve(rootPath, candidate);
  const hasGitSegment = (value: string): boolean => value.split(sep).includes('.git');
  const workspacePath = relative(rootPath, path);
  if (hasGitSegment(workspacePath)) return true;

  const existingRealPath = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      const parent = dirname(value);
      return parent === value ? value : join(existingRealPath(parent), relative(parent, value));
    }
  };
  try {
    const realRoot = realpathSync(rootPath);
    return hasGitSegment(relative(realRoot, existingRealPath(path)));
  } catch {
    return false;
  }
}

/** Write tools and the receipt each starts with when it succeeded (Cormini's workspaceTools.ts and blobs.ts). */
const WRITES: Record<string, { ok: string; verb: string }> = {
  write_file: { ok: '[written] ', verb: 'wrote' },
  edit_file: { ok: '[edited] ', verb: 'edited' },
  append_file: { ok: '[appended] ', verb: 'appended to' },
  delete_file: { ok: '[deleted] ', verb: 'deleted' },
  save_blob: { ok: '[saved] ', verb: 'saved' },
};

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const HANDOFF_OWNER_PREFIX = 'handoff-owner-v1:';
/** The fixed sentence `injectMemoryContext` appends when a Recall status notice is used. */
const MEMORY_READ_SUFFIX = ' If you are not sure, say so; do not invent dates, names or past events.';
const MEMORY_STATUS_NOTICES = ['absent', 'incomplete', 'unavailable', 'fenced'] as const;

/** Fixed memory status text carries no historical content and may be re-proved after a restart. */
function isFixedMemoryStatusNotice(text: string): boolean {
  if (text === MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE) return true;
  return MEMORY_STATUS_NOTICES.some((status) => {
    const notice = memoryReadNotice(status);
    return text === notice || text === `${notice}${MEMORY_READ_SUFFIX}`;
  });
}

/** True when the span is one whole part of a rendered handoff note, not an arbitrary substring. */
function handoffNotePartOf(body: string, segment: string): boolean {
  if (!segment.startsWith('# 交接笔记 · ') || !segment.endsWith('\n')) return false;
  if (body === segment) return true;
  const nextPart = (at: number): boolean => body.startsWith('# 交接笔记 · ', at);
  if (body.startsWith(`${segment}\n`)) return nextPart(segment.length + 1);
  if (body.endsWith(`\n${segment}`)) return true;
  const at = body.indexOf(`\n${segment}\n`);
  return at >= 0 && nextPart(at + segment.length + 2);
}

interface HandoffFileOwner {
  artifactId: string;
  device: number;
  inode: number;
  stagedName: string;
}

function handoffOwnerToken(artifactId: string, identity: { dev: number; ino: number }, stagedName: string): string {
  return `${HANDOFF_OWNER_PREFIX}${JSON.stringify([artifactId, identity.dev, identity.ino, stagedName])}`;
}

function handoffOwner(artifact: DerivedArtifact): HandoffFileOwner | null {
  const token = artifact.creatorOperationId;
  if (!token?.startsWith(HANDOFF_OWNER_PREFIX)) return null;
  try {
    const value = JSON.parse(token.slice(HANDOFF_OWNER_PREFIX.length)) as unknown;
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== artifact.artifactId
      || !Number.isSafeInteger(value[1]) || !Number.isSafeInteger(value[2])
      || typeof value[3] !== 'string' || !/^[0-9a-f-]{36}\.md$/i.test(value[3]) || basename(value[3]) !== value[3]) return null;
    return { artifactId: value[0], device: value[1], inode: value[2], stagedName: value[3] };
  } catch {
    return null;
  }
}

function handoffFileMatches(path: string, owner: HandoffFileOwner, digest: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.dev === owner.device && stat.ino === owner.inode
      && sha256(readFileSync(path)) === digest;
  } catch {
    return false;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function insidePath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

interface WorkspacePathState {
  absolutePath: string;
  relativePath: string;
  bytes: Buffer | null;
  snapshotId: string;
}

interface WorkspaceActionPlan {
  request: FileSystemActionAuthorizationRequest;
  path: WorkspacePathState;
  finalBytes: Buffer | null;
  failurePrefix: string;
}

/**
 * Takes `path` out of the repository at `dir` and leaves the files: a workspace may have committed `blobs/`
 * before it was ignored. Git variables that would point the call at another repository are dropped, as
 * WorkspaceGit drops them.
 */
function untrack(dir: string, path: string): void {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX)$/i.test(k)));
  execFileSync('git', ['-C', dir, '-c', 'safe.directory=*', 'rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', path], { cwd: dir, env, stdio: 'ignore' });
}

/**
 * Puts the partner notes where this Persona reads them. Top-level entries whose names differ from `PARTNER.md` or
 * `partner/` only in letter case (possible on a case-sensitive file system) are merged in: such a file is renamed to
 * PARTNER.md, or appended to it under a line naming it when PARTNER.md exists; such a directory's entries move into
 * partner/. A file named `partner` moves into the directory as `partner/partner`. partner/ exists afterwards.
 * Returns whether anything moved.
 */
export function arrangePartner(dir: string): boolean {
  let moved = false;
  const names = () => readdirSync(dir);
  for (const name of names()) {
    if (name === PARTNER_FILE || name.toLowerCase() !== PARTNER_FILE.toLowerCase() || !statSync(join(dir, name)).isFile()) continue;
    if (names().includes(PARTNER_FILE)) {
      appendFileSync(join(dir, PARTNER_FILE), `

--- merged from ${name} ---
${readFileSync(join(dir, name), 'utf8')}`, 'utf8');
      unlinkSync(join(dir, name));
    } else {
      renameSync(join(dir, name), join(dir, PARTNER_FILE));
    }
    moved = true;
  }
  const target = join(dir, PARTNER_DIR);
  if (names().includes(PARTNER_DIR) && statSync(target).isFile()) {
    const held = join(dir, `${PARTNER_DIR}.moving`);
    renameSync(target, held);
    mkdirSync(target);
    renameSync(held, join(target, PARTNER_DIR));
    moved = true;
  }
  for (const name of names()) {
    if (name === PARTNER_DIR || name.toLowerCase() !== PARTNER_DIR || !statSync(join(dir, name)).isDirectory()) continue;
    if (!names().includes(PARTNER_DIR)) {
      renameSync(join(dir, name), target);
    } else {
      for (const entry of readdirSync(join(dir, name))) {
        const free = existsSync(join(target, entry)) ? `${name}-${entry}` : entry;
        renameSync(join(dir, name, entry), join(target, free));
      }
      rmdirSync(join(dir, name));
    }
    moved = true;
  }
  mkdirSync(target, { recursive: true });
  return moved;
}

/** Coo's Persona class on `Base`, Cormini as the staged Cortico has it. */
export interface MemoryDeps {
  /** Use the Owner-approved canonical character instead of legacy workspace self-descriptions. */
  canonicalPersona?: boolean;
  memory?: HindsightMemory;
  /** Rebuild the live system prefix after a user save changed PARTNER provenance. */
  reloadPrefix?: () => Promise<void>;
  sourceSafeToolResults?: boolean;
  /** The live `companion.selfTime`; null when the app does not have it. */
  selfTime?: () => SelfTimeConfig | null;
  modelLanguage?: () => ModelLanguage;
  /** The live `companion.growth`; reviews only run when a state file is given too. */
  growth?: () => GrowthConfig;
  /** Where the next review is recorded; null turns the review off for this Persona. */
  growthStateFile?: string;
  authorizeGrowthPolicyAction?: (request: FileSystemActionAuthorizationRequest) => Promise<FileSystemActionAuthorization | FileSystemActionRefusal | null>;
  /** True while the app is paused; a paused app starts no background review. */
  paused?: () => boolean;
  timezone?: () => string;
  /** Core authorizes one workspace file change through the shared action receipt ledger. */
  authorizeWorkspaceAction?: (request: FileSystemActionAuthorizationRequest) => Promise<FileSystemActionAuthorization | FileSystemActionRefusal | null>;
  /** Core owns the shared Browser, CUA and filesystem action receipts shown in Persona settings. */
  actionReceipts?: () => ActionReceiptLedger | null;
  /** Core owns the durable workspace-write rules and the pending approval queue. */
  workspacePermissions?: WorkspacePermissionStore | null;
  /** Host records of local prompt files the person saved or confirmed in the settings window. */
  promptProvenance?: PromptProvenance | null;
}

export function coopanionPersona(Base: typeof Cormini, deps: MemoryDeps = {}) {
  return class CoopanionPersona extends Base {
    /** Commits wait for the one before: Git's index takes one writer, and a turn often writes several files. */
    private commits: Promise<unknown> = Promise.resolve();
    private readonly longTerm = deps.memory ?? null;
    private readonly reloadPrefixNow = deps.reloadPrefix ?? (() => Promise.resolve());
    private readonly selfTimeNow = deps.selfTime ?? (() => null);
    private readonly modelLang = deps.modelLanguage ?? (() => 'zh' as ModelLanguage);
    private readonly growthNow = deps.growth ?? (() => GROWTH_DEFAULTS);
    private readonly growthStateFile = deps.growthStateFile ?? null;
    private readonly pausedNow = deps.paused ?? (() => false);
    private readonly timezoneNow = deps.timezone ?? (() => 'UTC');
    private readonly authorizeWorkspaceAction = deps.authorizeWorkspaceAction ?? null;
    private readonly actionReceiptsNow = deps.actionReceipts ?? (() => null);
    private readonly workspacePermissions = deps.workspacePermissions ?? null;
    private readonly promptProvenance = deps.promptProvenance ?? null;
    /** Lines this Host's workspace tool actually emitted; shape alone never earns trust. */
    private readonly workspaceIssuedText = new WorkspaceToolTextLedger();
    private growthReview: GrowthReview | null = null;
    private growthPolicies: GrowthPolicies | null = null;
    private autonomousGrowth: AutonomousGrowth | null = null;
    private autonomousPaused = false;
    private growthSchedule: GrowthSchedule | null = null;
    private growthCheck: ReturnType<typeof setInterval> | null = null;
    private lastUserMemory: { documentId: string; at: number } | null = null;
    private domainSupplementTurn = 0;
    private domainSupplementAbort: AbortController | null = null;
    /** When the newest supplement turn started; a receipt older than it belongs to an earlier turn. */
    private domainSupplementTurnStartedAt: number | null = null;
    /** The turn that wrote the receipt; timestamps alone cannot separate a same-millisecond earlier turn. */
    private domainSupplementReceiptTurn: number | null = null;
    private domainSupplementReceiptAt: string | null = null;
    private readonly memoryContextBlocks = new Set<string>();
    private readonly partnerArtifacts = new Set<string>();
    private partnerArtifactEpoch: string | null = null;
    private partnerSourceStates = new Map<string, PartnerSourceStatus>();
    private partnerSourceStatesKey: string | null = null;
    private partnerRecoveryAt = 0;
    private readonly sourceSpanDiagnostics = new Set<string>();
    private sourceRecoveryHandoffPending = false;
    private pendingForgottenHandoffReset: ForgottenHandoffReset | null = null;
    private pendingCleanHandoffRebuild: CleanHandoffRebuild | null = null;
    private lastForgottenHandoffBlock: {
      status: 'blocked'; candidateSnapshotId: string;
      mappingState: ContextEvidenceInspection['mappingState'];
      reason: 'original-memory-source-dependency-unverified';
    } | null = null;
    private attachedCore: CoreApi | null = null;
    private pendingOpening: string | null = null;

    override attach(core: CoreApi): void {
      this.attachedCore = core;
      super.attach(core);
      if (typeof this.longTerm?.setPartnerSourceStatus === 'function') {
        this.longTerm.setPartnerSourceStatus((documentId) => this.partnerSourceStatus(documentId));
      }
      void this.syncPartnerUserDocument(false).catch((error) => {
        core.log.warn('PARTNER.md pending registrations could not be recovered', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      this.longTerm?.setLifecycleHooks({
        forgetSources: (ids) => {
          let sidecarError: unknown;
          const sidecar = this.partnerProvenanceFile();
          const scope = this.longTerm?.sourceScopeDigest();
          if (sidecar && scope) {
            try { markPartnerSourcesStale(sidecar, partnerWorkspaceDigest(this.memoryDir), scope, ids); }
            catch (error) { sidecarError = error; }
            this.partnerSourceStatesKey = null;
          }
          void this.growthPolicies?.refresh().catch(error => this.core?.log.warn('[growth] policy revocation failed', { error: String(error) }));
        const forgotten = new Set(ids);
          this.pendingCleanHandoffRebuild = null;
          let handoffRecovery = false;
          try { handoffRecovery = this.requestHandoffAfterDeliveredNoteForget(ids); }
          catch { /* The source fence remains authoritative; handoff maintenance must not block Forget. */ }
          const proposals = this.growthProposals()?.list().filter((proposal) => proposal.sourceIds.some((id) => forgotten.has(id))) ?? [];
          const policies = this.experienceCards()?.list().filter((card) => card.sourceIds.some((id) => forgotten.has(id))) ?? [];
          if (!handoffRecovery && proposals.length + policies.length > 0) {
            this.injectMemoryContext('[memory] A source was forgotten. Do not use any linked proposal or experience policy.');
          }
          if (this.hasApprovedExperienceCards()) void this.reloadSystemPrefixSafely();
          if (sidecarError) throw sidecarError;
        },
        clearDerived: () => {
          let sidecarError: unknown;
          const sidecar = this.partnerProvenanceFile();
          if (sidecar) {
            try { markPartnerDerivedStale(sidecar, partnerWorkspaceDigest(this.memoryDir), this.longTerm?.sourceScopeDigest() ?? null); }
            catch (error) { sidecarError = error; }
            this.partnerSourceStatesKey = null;
          }
          const proposals = this.growthProposals()?.list().filter((proposal) => proposal.state === 'approved') ?? [];
          const cards = this.experienceCards()?.list('approved') ?? [];
          if (proposals.length + cards.length > 0) {
            this.injectMemoryContext('[memory] Long-term memory was cleared. Do not use the retained Growth proposals or Experience cards; their source records are unavailable.');
          }
          this.injectMemoryContext('[memory] Long-term memory was cleared. Do not rely on Hindsight-derived context from before the clear.');
          if (this.hasApprovedExperienceCards()) void this.reloadSystemPrefixSafely();
          if (sidecarError) throw sidecarError;
        },
      });
      if (!this.growthStateFile) return;
      const log = {
        info: (message: string, data?: unknown) => this.core?.log.info(message, data),
        warn: (message: string, data?: unknown) => this.core?.log.warn(message, data),
      };
      const review = this.growthReview = new GrowthReview({
        core: () => this.core,
        snapshot: () => this.growthSnapshot(),
        tools: () => this.growthTools(),
        memory: () => this.longTerm,
        proposalsDir: join(dirname(this.growthStateFile), 'growth-proposals'),
        experienceCardsDir: join(dirname(this.growthStateFile), 'experience-cards'),
        modelLanguage: () => this.modelLang(),
        timezone: this.timezoneNow,
        allowed: () => !this.pausedNow() && !this.autonomousPaused && !this.autonomousGrowth?.isPaused() && (this.core?.sessionInfo('main').running ?? 0) === 0,
        onCandidateProduced: this.longTerm ? createLocalGrowthCandidateLifecycle(this.longTerm) : undefined,
        log,
      });
      this.growthPolicies = this.longTerm && deps.authorizeGrowthPolicyAction ? new GrowthPolicies({
        rootDir: dirname(this.growthStateFile), proposals: new GrowthProposals(join(dirname(this.growthStateFile), 'growth-proposals')),
        memory: this.longTerm, enabled: () => this.growthNow().autoApply === true,
        authorize: deps.authorizeGrowthPolicyAction, receipts: this.actionReceiptsNow,
        changed: () => { void this.reloadSystemPrefixSafely(); },
      }) : null;
      const automatic = this.autonomousGrowth = this.longTerm ? new AutonomousGrowth({
        stateFile: join(dirname(this.growthStateFile), 'growth-autonomous.json'),
        proposals: new GrowthProposals(join(dirname(this.growthStateFile), 'growth-proposals')),
        memory: this.longTerm, review, core: () => this.core,
        onCandidatesReady: (ids, current) => this.growthPolicies?.reconcile(ids, current) ?? Promise.resolve(),
        allowed: () => this.growthNow().enabled && !this.pausedNow() && !this.autonomousPaused
          && (this.core?.sessionInfo('main').running ?? 0) === 0,
      }) : null;
      this.growthSchedule = new GrowthSchedule({
        stateFile: this.growthStateFile,
        config: this.growthNow,
        timers: core.timers,
        run: () => automatic ? automatic.run() : Promise.reject(new Error('Automatic Growth sources are unavailable')),
        cancel: () => automatic?.cancel(),
        paused: () => this.pausedNow() || this.autonomousPaused || (this.autonomousGrowth?.isPaused() ?? false),
        forkRunning: () => (this.core?.sessionInfo(GROWTH_SESSION).running ?? 0) > 0 || (this.core?.sessionInfo(GROWTH_VALIDATION_SESSION).running ?? 0) > 0,
        allowed: () => this.longTerm?.enabled() ?? false,
        log,
      });
      try {
        this.growthSchedule.start();
      } catch (err) {
        this.core?.log.warn('[growth] could not start the review schedule', { err: err instanceof Error ? err.message : String(err) });
      }
      this.growthCheck = setInterval(() => {
        void this.growthSchedule?.check().catch((err) => this.core?.log.warn('[growth] check failed', { err: err instanceof Error ? err.message : String(err) }));
      }, GROWTH_CHECK_MS);
      this.growthCheck.unref?.();
    }

    /** Re-arms after `companion.growth` changes. */
    restartGrowth(): void {
      this.growthSchedule?.restart();
    }

    /** Stops the periodic check; the persistent timer is left for the next start to reconcile. */
    stopGrowth(): void {
      this.autonomousGrowth?.cancel();
      if (this.growthCheck) clearInterval(this.growthCheck);
      this.growthCheck = null;
    }

    canonicalizeEvidenceSource(source: SourceExposureRef): SourceExposureRef | null {
      return this.longTerm?.canonicalEvidenceSource(source) ?? null;
    }

    override validateEvidenceForRequest(sources: readonly SourceExposureRef[], inspection?: ContextEvidenceInspection): boolean {
      const current = sources.length === 0 || (!!inspection && this.longTerm?.sourceEvidenceCurrent(inspection) === true);
      const incompleteMemory = !current && inspection?.items.some((item) =>
        item.disposition === 'unknown-derived-incomplete'
        && item.spans.some((span) => span.origin === 'hindsight-source' && span.mappingState === 'complete')
        && item.spans.some((span) => span.origin === 'generation-derived' && span.mappingState === 'unverified'
          && span.generationEvidenceId === undefined)) === true;
      if (incompleteMemory) this.sourceRecoveryHandoffPending = true;
      this.logSourceSpanDiagnostic(sources, inspection, { allowed: current, recoveryHandoffPending: this.sourceRecoveryHandoffPending });
      return current;
    }

    override onBatchEnd(): void {
      super.onBatchEnd();
      if (!this.sourceRecoveryHandoffPending || !this.attachedCore) return;
      this.sourceRecoveryHandoffPending = false;
      this.attachedCore.requestContextHandoff();
    }

    private logSourceSpanDiagnostic(
      sources: readonly SourceExposureRef[],
      inspection: ContextEvidenceInspection | undefined,
      metadata: {
        allowed?: boolean;
        providerGenerationId?: string | null;
        providerAttemptId?: string | null;
        requestState?: string;
        requestBlockReason?: string | null;
        responseJoinState?: string;
        recoveryHandoffPending?: boolean;
      } = {},
    ): void {
      if (!inspection || (process.env.COOPANION_TEST_CHANNEL !== '1' && process.env.CORTICO_TEST_CHANNEL !== '1')) return;
      const diagnosticKey = `${inspection.serializedBodyDigest ?? ''}:${metadata.allowed ?? 'unknown'}:${metadata.requestBlockReason ?? ''}`;
      if (this.sourceSpanDiagnostics.has(diagnosticKey)) return;
      this.sourceSpanDiagnostics.add(diagnosticKey);
      if (this.sourceSpanDiagnostics.size > 128) this.sourceSpanDiagnostics.delete(this.sourceSpanDiagnostics.values().next().value!);
      const records = this.attachedCore?.sessionInfo('main').snapshot ?? [];
      const ref = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
      const sourceIdentityHash = (source: SourceExposureRef): string => ref([source.bankId, source.endpoint, source.documentId]);
      const items = inspection.items.map((item) => {
        const messageIndex = records.findIndex((record) => record.item.id === item.itemId);
        const record = records[messageIndex];
        const text = record?.item.type === 'function_call'
          ? record.item.arguments
          : record ? textOf(record) : '';
        const covered = new Uint8Array(text.length);
        const origins: Record<string, number> = {};
        const states: Record<string, number> = {};
        for (const span of item.spans) {
          origins[span.origin] = (origins[span.origin] ?? 0) + 1;
          states[span.mappingState] = (states[span.mappingState] ?? 0) + 1;
          if (span.mappingState !== 'complete') continue;
          for (let offset = Math.max(0, span.start); offset < Math.min(text.length, span.end); offset += 1) covered[offset] = 1;
        }
        let firstUncovered: { start: number; end: number } | null = null;
        for (let offset = 0; offset < text.length; offset += 1) {
          if (/\s/u.test(text[offset]!) || covered[offset]) continue;
          const start = offset;
          while (offset < text.length && !/\s/u.test(text[offset]!) && !covered[offset]) offset += 1;
          firstUncovered = { start, end: offset };
          break;
        }
        const spans = item.spans
          .filter((span) => span.origin !== 'core-generated' || span.mappingState !== 'complete'
            || span.sourceProof !== undefined || span.generationEvidenceId !== undefined)
          .map((span) => ({
            startUtf16: span.start,
            endUtf16: span.end,
            digest: span.digest,
            origin: span.origin,
            mappingState: span.mappingState,
            sourceIdentityHashes: span.exposedSources.map(sourceIdentityHash),
            sourceProof: span.sourceProof ? { startUtf16: span.sourceProof.startUtf16, endUtf16: span.sourceProof.endUtf16 } : null,
            generationEvidenceRef: span.generationEvidenceId ? ref(span.generationEvidenceId) : null,
            serializedRanges: span.serializedRanges.map((range) => ({ field: range.field, start: range.start, end: range.end })),
          }));
        return {
          messageIndex,
          itemRef: ref(item.itemId),
          role: record?.item.type === 'message' ? record.item.role : null,
          segmentType: record?.item.type ?? null,
          toolName: record?.item.type === 'function_call' ? record.item.name : null,
          textLengthUtf16: text.length,
          mappingState: item.mappingState,
          disposition: item.disposition,
          nonWhitespaceFullyCovered: firstUncovered === null,
          firstUncovered,
          spanCount: item.spans.length,
          spanOrigins: origins,
          spanStates: states,
          spans,
        };
      });
      this.attachedCore?.log.info('source span dispatch diagnostic', {
        event: 'source-span-dispatch-diagnostic',
        data: {
          serializedBodyDigest: inspection.serializedBodyDigest ?? null,
          mappingState: inspection.mappingState,
          ...metadata,
          exposedSourceCount: sources.length,
          sourceIdentityHashes: sources.map(sourceIdentityHash),
          items,
        },
      });
    }

    private logRecentSourceSpanDiagnostics(): void {
      if (process.env.COOPANION_TEST_CHANNEL !== '1' && process.env.CORTICO_TEST_CHANNEL !== '1') return;
      const core = this.attachedCore;
      if (!core) return;
      for (const entry of core.generationEvidence('main').slice(-6)) {
        this.logSourceSpanDiagnostic(entry.exposedSources, entry, {
          allowed: entry.requestState === 'sent' && entry.mappingState === 'complete',
          providerGenerationId: entry.providerGenerationId ?? null,
          providerAttemptId: entry.providerAttemptId ?? null,
          requestState: entry.requestState,
          requestBlockReason: entry.requestBlockReason ?? null,
          responseJoinState: entry.responseJoinState,
        });
      }
    }

    private growthSnapshot(): ContextRecord[] {
      return this.core?.sessionInfo('main').snapshot ?? [];
    }

    private growthTools(): ToolDef[] {
      const wanted = new Set<string>(GROWTH_TOOL_NAMES);
      const tools = this.tools().filter((tool) => wanted.has(tool.name) && tool.name !== 'memory_search');
      return [...tools, growthMemorySearchTool(() => this.longTerm)];
    }

    private growthDirectory(): string | null {
      return this.growthStateFile ? dirname(this.growthStateFile) : null;
    }

    private growthProposals(): GrowthProposals | null {
      const dir = this.growthDirectory();
      return dir ? new GrowthProposals(join(dir, 'growth-proposals')) : null;
    }

    private experienceCards(): ExperienceCards | null {
      const dir = this.growthDirectory();
      return dir ? new ExperienceCards(join(dir, 'experience-cards')) : null;
    }

    /** Cheap check for the prefix hook; no directory scan when no card directory exists. */
    private hasApprovedExperienceCards(): boolean {
      const dir = this.growthDirectory();
      if (!dir) return false;
      const cardsDir = join(dir, 'experience-cards');
      return existsSync(cardsDir) && (this.experienceCards()?.list('approved').length ?? 0) > 0;
    }

    private injectMemoryContext(text: string, evidence?: EvidenceAttachment[]): void {
      if (!text) return;
      this.memoryContextBlocks.add(text);
      this.core?.injectInternal(text, 'memory', evidence);
      if (this.core) this.longTerm?.markRecallInjected(text);
    }

    private async verifiedMemorySources(sourceIds: readonly string[]): Promise<boolean> {
      const memory = this.longTerm;
      if (!memory?.enabled() || !memory.settled() || sourceIds.length === 0) return false;
      const actors = new Set(['user', 'coo', 'affinity', 'tool', 'inference']);
      const statuses = new Set(['current', 'planned', 'completed']);
      for (const sourceId of new Set(sourceIds)) {
        if (!memory.sourceVisible(sourceId)) return false;
        try {
          const source = await memory.sourceEvidence(sourceId);
          if (!source.present || !source.visible || !source.actor || !actors.has(source.actor)
            || !source.status || !statuses.has(source.status) || !memory.sourceVisible(sourceId)) return false;
        } catch {
          return false;
        }
      }
      return memory.enabled() && memory.settled() && sourceIds.every((id) => memory.sourceVisible(id));
    }

    private async verifiedRepeatedUserEventSources(sourceIds: readonly string[]): Promise<boolean> {
      const memory = this.longTerm;
      if (!memory?.enabled() || !memory.settled() || new Set(sourceIds).size < 2) return false;
      const dates = new Set<string>();
      for (const sourceId of new Set(sourceIds)) {
        if (!memory.sourceVisible(sourceId)) return false;
        try {
          const source = await memory.sourceEvidence(sourceId);
          if (!source.present || !source.visible || source.actor !== 'user' || source.kind !== 'event'
            || (source.status !== 'completed' && source.status !== 'current') || !source.occurredAt
            || !Number.isFinite(Date.parse(source.occurredAt)) || !memory.sourceVisible(sourceId)) return false;
          dates.add(new Date(source.occurredAt).toISOString().slice(0, 10));
        } catch {
          return false;
        }
      }
      return dates.size >= 2 && memory.enabled() && memory.settled()
        && sourceIds.every((id) => memory.sourceVisible(id));
    }

    private async experienceEntries(): Promise<Array<{ card: ExperienceCard; text: string; evidence: EvidenceAttachment[] }>> {
      const cards = this.experienceCards();
      const memory = this.longTerm;
      if (!cards || !memory?.enabled() || !memory.settled()) return [];
      const valid = new Set<string>();
      for (const card of cards.list('approved').slice(0, 8)) {
        const body = experienceCardArtifactText(card);
        const artifact = memory.derivedArtifact(card.id);
        if (artifact?.reviewState !== 'approved' || !memory.derivedArtifactIsCurrent(card.id, body)
          || !await memory.verifyDerivedArtifact(card.id, body)) continue;
        const sourcesValid = card.userExplicit
          ? await this.verifiedMemorySources(card.sourceIds)
          : await this.verifiedRepeatedUserEventSources(card.sourceIds);
        if (sourcesValid) valid.add(card.id);
      }
      if (!memory.enabled() || !memory.settled()) return [];
      const entries = cards.approvedContextEntries(8, 3200, (card) => valid.has(card.id));
      const included: Array<{ card: ExperienceCard; text: string; evidence: EvidenceAttachment[] }> = [];
      for (const entry of entries) {
        const sourceIds = [...new Set(entry.card.sourceIds)];
        const segments: MemoryEvidenceSegment[] = sourceIds.map((documentId) => ({
          documentId, start: 0, end: entry.text.length, derived: true,
        }));
        const evidence = await memory.evidenceForSegments(entry.text, segments);
        if (evidence.length !== segments.length || !evidenceCoversText(entry.text, evidence)) continue;
        included.push({ card: entry.card, text: entry.text, evidence });
      }
      return memory.enabled() && memory.settled() ? included : [];
    }

    private async experienceContext(): Promise<{ text: string; evidence: EvidenceAttachment[] }> {
      const entries = await this.experienceEntries();
      const text = entries.map((entry) => entry.text).join('\n');
      const evidence: EvidenceAttachment[] = [];
      let offset = 0;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        evidence.push(...entry.evidence.map((attachment) => ({
          ...attachment,
          segment: { ...attachment.segment, start: attachment.segment.start + offset, end: attachment.segment.end + offset },
        })));
        offset += entry.text.length + (index + 1 < entries.length ? 1 : 0);
      }
      return { text, evidence };
    }

    private async reloadSystemPrefixSafely(): Promise<boolean> {
      const core = this.core;
      const reload = core?.reloadSystemPrefix;
      if (!core || !reload) return false;
      try {
        await reload.call(core);
        return true;
      } catch {
        try {
          await reload.call(core);
          return true;
        } catch {
          return false;
        }
      }
    }

    private withdrawExperienceContextArtifacts(cardId: string, reason: string): void {
      const memory = this.longTerm;
      if (!memory) return;
      const list = (memory as unknown as { listDerivedArtifacts?: (kind: string) => DerivedArtifact[] })
        .listDerivedArtifacts;
      if (!list) return;
      const prefix = `experience-context:${cardId}:`;
      for (const artifact of list.call(memory, 'experience-context')) {
        if (artifact.artifactId.startsWith(prefix) && artifact.lifecycleState === 'active') {
          memory.withdrawDerivedArtifact(artifact.artifactId, reason);
        }
      }
    }

    /**
     * A user-approved Experience entry is rendered as its own derived artifact. The system-prefix
     * span then points at that artifact's exact body digest and current sources, so Core can accept
     * the text without pretending it is a literal slice of an external document.
     */
    private async experiencePrefixSegment(): Promise<PrefixSegment | null> {
      const entries = await this.experienceEntries();
      const memory = this.longTerm;
      if (!memory || entries.length === 0) return null;
      const expectedEpoch = memory.evidenceEpoch();
      if (!expectedEpoch) return null;
      const included: Array<{ text: string; digest: string; sources: SourceExposureRef[] }> = [];
      for (const entry of entries) {
        const digest = sha256(entry.text);
        const artifactId = `experience-context:${entry.card.id}:${digest.slice(0, 16)}`;
        if (!memory.derivedArtifact(artifactId)) {
          await memory.registerDerivedArtifactFromSources({
            artifactId,
            kind: 'experience-context',
            target: `experience-context/${entry.card.id}.txt`,
            content: entry.text,
            origin: entry.card.userExplicit ? 'user-authored' : 'model-derived',
            reviewState: 'approved',
            creatorOperationId: `experience-context:${entry.card.id}`,
            sourceIds: entry.card.sourceIds,
            expectedEpoch,
          });
        }
        const artifact = memory.derivedArtifact(artifactId);
        if (!artifact || artifact.lifecycleState !== 'active' || artifact.reviewState !== 'approved'
          || artifact.bodyDigest !== digest || !await memory.verifyDerivedArtifact(artifactId, entry.text)) continue;
        for (const old of memory.listDerivedArtifacts('experience-context')) {
          if (old.artifactId.startsWith(`experience-context:${entry.card.id}:`) && old.artifactId !== artifactId
            && old.lifecycleState === 'active') {
            memory.withdrawDerivedArtifact(old.artifactId, 'experience-context-replaced');
          }
        }
        const sources = entry.evidence.map(({ segment: _segment, ...source }) => source);
        included.push({ text: entry.text, digest, sources });
      }
      if (included.length === 0) return null;
      const text = `${EXPERIENCE_CONTEXT_HEADER}\n${included.map((entry) => entry.text).join('\n')}`;
      const sourceMapSpans: SourceMapSpan[] = [{
        start: 0, end: EXPERIENCE_CONTEXT_HEADER.length,
        digest: sha256(EXPERIENCE_CONTEXT_HEADER), origin: 'core-generated',
      }];
      let offset = EXPERIENCE_CONTEXT_HEADER.length + 1;
      for (const entry of included) {
        sourceMapSpans.push({
          start: offset, end: offset + entry.text.length, digest: entry.digest,
          origin: 'artifact-derived', exposedSources: entry.sources,
        });
        offset += entry.text.length + 1;
      }
      return { title: 'EXPERIENCE', text, sourceMapSpans };
    }

    private systemHealth(): Record<string, unknown> {
      const pressure = readResourcePressure();
      let diskAvailableBytes: number | null = null;
      try {
        const stat = statfsSync(this.memoryDir);
        diskAvailableBytes = Number(stat.bavail) * Number(stat.bsize);
      } catch { /* The deployment directory may not expose filesystem statistics. */ }
      return {
        platform: process.platform,
        coreRssBytes: process.memoryUsage().rss,
        systemTotalBytes: totalmem(),
        systemFreeBytes: freemem(),
        memoryPressureFreePercent: pressure.freePercent,
        backgroundPausedForMemory: pressure.paused,
        diskAvailableBytes,
        browser: {
          enabled: this.selfTimeNow()?.enabled ?? false,
          actions: this.selfTimeNow()?.actions ?? false,
          sessionMinutes: this.selfTimeNow()?.sessionMinutes ?? null,
          sessionUnlimited: this.selfTimeNow()?.sessionUnlimited ?? false,
          maxCallsPerSession: SESSION_MAX_CALLS,
        },
      };
    }

    override declareSessions(): SessionDecl[] {
      return [
        ...super.declareSessions(),
        { id: GROWTH_VALIDATION_SESSION, label: 'growth-validation', rounds: () => ({ soft: 5, hard: 8 }), persistent: false, receivesEvents: false, tools: () => [] },
        {
          id: GROWTH_SESSION,
          label: 'growth',
          rounds: () => ({ soft: 12, hard: 24 }),
          persistent: false,
          receivesEvents: false,
          tools: () => this.growthTools(),
        },
      ];
    }

    private get git(): WorkspaceGit {
      return this.memory.git;
    }

    /** Whether Git runs here, so the workspace has a history. */
    gitAvailable(): boolean {
      return this.git.available();
    }

    /** With time of her own on, the quiet line offers the browser as well as speaking first. */
    protected override tickText(quietSeconds: number): string {
      if (this.growthPolicies?.quietFocus()) return '';
      const self = this.selfTimeNow();
      if (self?.enabled && readResourcePressure().paused) {
        return '[system] Background exploration is paused because system memory pressure is high. Do not open the browser or start a self-review; end_turn.';
      }
      return self?.enabled ? selfTimeLine(this.modelLang(), quietSeconds, self.sessionMinutes, self.sessionUnlimited, self.topics) : super.tickText(quietSeconds);
    }

    /** The setting turned time of her own on, or its quiet interval changed: arm the next wake-up now. */
    restartRhythm(): void {
      this['heartbeat'].noteActivity();
      this.stopRhythm();
      this.startRhythm();
    }

    protected override partnerDocFile(): string {
      return join(this.memoryDir, PARTNER_FILE);
    }

    private partnerProvenanceFile(): string | null {
      const root = this.growthDirectory();
      return root ? partnerProvenancePath(root, this.memoryDir) : null;
    }

    private async ensurePartnerArtifacts(): Promise<void> {
      const memory = this.longTerm;
      this.partnerArtifacts.clear();
      this.partnerArtifactEpoch = memory?.evidenceEpoch() ?? null;
      if (!memory?.enabled() || !memory.settled() || !this.partnerArtifactEpoch) return;
      try {
        const file = this.partnerDocFile();
        if (!existsSync(file) || !statSync(file).isFile()
          || !insidePath(realpathSync(this.memoryDir), realpathSync(file))) return;
        const source = readFileSync(file, 'utf8');
        const sidecar = this.partnerProvenanceFile();
        if (!sidecar) return;
        const provenance = readPartnerProvenance(sidecar, partnerWorkspaceDigest(this.memoryDir));
        if (provenance.status !== 'ok') return;
        const filtered = filterPartnerMarkdown(source, provenance, memory.sourceScopeDigest(),
          (sourceId) => memory.sourceCurrentForContext(sourceId));
        if (filtered.status !== 'ok') return;
        const entries = new Map(provenance.file.entries.map((entry) => [entry.segmentDigest, entry]));
        const expectedEpoch = this.partnerArtifactEpoch;
        for (const segment of filtered.segments) {
          if (segment.origin !== 'derived' || segment.sourceIds.length === 0) continue;
          const entry = entries.get(partnerSegmentDigest(segment.text));
          if (!entry) continue;
          const artifactId = `partner:${entry.id}`;
          const content = partnerSegmentContextText(segment);
          const artifact = await memory.registerDerivedArtifactFromSources({
            artifactId,
            kind: 'partner-segment',
            target: `${PARTNER_FILE}#${entry.id}`,
            content,
            origin: 'model-derived',
            reviewState: 'unreviewed',
            creatorOperationId: `partner-sidecar:${entry.id}`,
            sourceIds: segment.sourceIds,
            expectedEpoch,
          });
          if (!artifact || !await memory.verifyDerivedArtifact(artifactId, content)) continue;
          this.partnerArtifacts.add(entry.id);
        }
        if (memory.evidenceEpoch() !== expectedEpoch) this.partnerArtifacts.clear();
      } catch {
        this.partnerArtifacts.clear();
      }
    }

    private workspaceRelativePath(candidate: unknown): string | null {
      if (typeof candidate !== 'string' || !candidate.trim()) return null;
      const root = resolve(this.memoryDir);
      const absolute = resolve(root, candidate.replace(/\\/g, '/'));
      const path = relative(root, absolute).split(sep).join('/');
      return !path || path === '.' || path.startsWith('../') || isAbsolute(path) ? null : path;
    }

    private workspaceResolvedReadPath(path: string): string | null {
      try {
        const root = realpathSync.native(this.memoryDir);
        const target = realpathSync.native(join(root, path));
        return insidePath(root, target) ? relative(root, target).split(sep).join('/') : null;
      } catch {
        return path;
      }
    }

    private searchMayIncludeProvenance(path: string | null): boolean {
      if (!path || path === '.') return true;
      const protectedPaths = [PARTNER_FILE, PARTNER_DIR, 'handoffs'];
      return protectedPaths.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`) || protectedPath.startsWith(`${path}/`));
    }

    private workspaceSearchContainsLinks(path: string): boolean {
      const target = join(this.memoryDir, path);
      if (!existsSync(target)) return false;
      try {
        return statSync(target).isDirectory()
          && readdirSync(target, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink());
      } catch {
        return true;
      }
    }

    private partnerFileVerified(source?: string): boolean {
      try {
        const file = this.partnerDocFile();
        const content = source ?? readFileSync(file, 'utf8');
        return this.promptProvenance?.verify({ key: 'partner', path: file, content })?.ok === true;
      } catch {
        return false;
      }
    }

    private partnerProvenanceResult(source?: string) {
      const file = this.partnerDocFile();
      if (!existsSync(file) || !statSync(file).isFile() || !insidePath(realpathSync(this.memoryDir), realpathSync(file))) {
        return filterPartnerMarkdown('', { status: 'missing' }, this.longTerm?.sourceScopeDigest() ?? null, () => false);
      }
      source ??= readFileSync(file, 'utf8');
      const userConfig = this.partnerFileVerified(source);
      const sidecar = this.partnerProvenanceFile();
      const provenance = sidecar ? readPartnerProvenance(sidecar, partnerWorkspaceDigest(this.memoryDir)) : { status: 'missing' as const };
      const rawSegments = partnerSegments(source);
      // A confirmed whole file with no sidecar is a user-authored workspace note: there are no
      // derived paragraphs to distinguish. Any invalid/scope-mismatched sidecar still fails closed.
      const filtered = provenance.status === 'missing' && userConfig
        ? {
            text: rawSegments.map((segment) => segment.text).join('\n\n'),
            status: 'ok' as const,
            includedSegments: rawSegments.length,
            withheldSegments: 0,
            segments: rawSegments.map((segment) => ({ text: segment.text, origin: 'user-authored' as const, sourceIds: [] })),
          }
        : filterPartnerMarkdown(source, provenance, this.longTerm?.sourceScopeDigest() ?? null,
            (sourceId) => this.longTerm?.sourceCurrentForContext(sourceId) === true);
      if (filtered.status !== 'ok' || (provenance.status !== 'ok' && !(provenance.status === 'missing' && userConfig))) return filtered;
      const entries = provenance.status === 'ok'
        ? new Map(provenance.file.entries.map((entry) => [entry.segmentDigest, entry]))
        : new Map();
      const epochCurrent = !!this.longTerm && this.partnerArtifactEpoch === this.longTerm.evidenceEpoch();
      const segments = filtered.segments.filter((segment) => {
        if (segment.origin === 'user-authored') return userConfig;
        const entry = entries.get(partnerSegmentDigest(segment.text));
        return !!entry && epochCurrent && this.partnerArtifacts.has(entry.id)
          && this.longTerm?.derivedArtifactIsCurrent(`partner:${entry.id}`, partnerSegmentContextText(segment)) === true;
      });
      const excluded = filtered.segments.length - segments.length;
      return {
        ...filtered,
        text: segments.map((segment) => segment.text).join('\n\n'),
        segments,
        includedSegments: segments.length,
        withheldSegments: filtered.withheldSegments + excluded,
      };
    }

    private partnerDocumentForRead(): string {
      const result = this.partnerProvenanceResult();
      return partnerEvidenceText(result) || PARTNER_READ_WITHHELD;
    }

    private partnerSyncEmpty(status: PartnerSyncStatus): PartnerSyncResult {
      return { status, current: 0, pending: 0, stale: 0, failed: 0 };
    }

    /** A pending source is current only after its exact read-back succeeds. */
    private async partnerNoteReadback(text: string, documentId: string): Promise<boolean> {
      try {
        const evidence = await this.longTerm?.evidenceForSegments(text,
          [{ documentId, start: 0, end: text.length, derived: true }], { allowedPendingPartnerId: documentId }) ?? [];
        return evidence.length === 1
          && evidence[0]!.validationStatus === 'validated'
          && evidence[0]!.revisionState === 'current';
      } catch {
        return false;
      }
    }

    /**
     * Recall asks this map, not the sidecar field alone. A source is current only while its
     * paragraph is still in the saved PARTNER.md, its entry is current, and every source ref is
     * still visible and unsuperseded.
     */
    private loadPartnerSourceStates(): void {
      const sidecar = this.partnerProvenanceFile();
      const file = this.partnerDocFile();
      let sidecarText = '';
      let partnerText = '';
      try {
        if (sidecar && existsSync(sidecar)) sidecarText = readFileSync(sidecar, 'utf8');
        if (existsSync(file) && statSync(file).isFile()) partnerText = readFileSync(file, 'utf8');
      } catch {
        this.partnerSourceStates = new Map();
        this.partnerSourceStatesKey = null;
        return;
      }
      const key = sha256(`${sidecarText}\0${partnerText}`);
      if (key === this.partnerSourceStatesKey) return;
      const states = new Map<string, PartnerSourceStatus>();
      try {
        if (sidecar) {
          const read = readPartnerProvenance(sidecar, partnerWorkspaceDigest(this.memoryDir));
          if (read.status === 'ok') {
            const counts = new Map<string, number>();
            for (const segment of partnerSegments(partnerText)) counts.set(segment.digest, (counts.get(segment.digest) ?? 0) + 1);
            for (const entry of read.file.entries) {
              const visible = entry.state === 'current'
                && (counts.get(entry.segmentDigest) ?? 0) === 1
                && (entry.origin !== 'derived' || (!!this.longTerm
                  && typeof this.longTerm.sourceScopeDigest === 'function'
                  && typeof this.longTerm.sourceCurrentForContext === 'function'
                  && entry.sourceScopeDigest === this.longTerm.sourceScopeDigest()
                  && entry.sourceIds.every((id) => this.longTerm?.sourceCurrentForContext(id) === true)));
              for (const id of entry.sourceIds) states.set(id, visible ? 'current' : 'superseded');
            }
          }
        }
      } catch {
        states.clear();
      }
      this.partnerSourceStates = states;
      this.partnerSourceStatesKey = key;
    }

    private partnerSourceStatus(documentId: string): PartnerSourceStatus | null {
      if (!documentId.startsWith('partner-user:')) return null;
      this.loadPartnerSourceStates();
      return this.partnerSourceStates.get(documentId) ?? 'superseded';
    }

    /**
     * Reconcile the saved PARTNER.md with its sidecar. A panel save may register new paragraphs;
     * recovery only retries entries already marked pending. Removed or edited paragraphs become
     * stale history. An incidental re-save does not revive them; an explicit panel save creates a
     * new version unless its old source ID is Forget-fenced.
     */
    private async syncPartnerUserDocument(registerNew: boolean, retireMissing = false, forceRecovery = false): Promise<PartnerSyncResult> {
      const memory = this.longTerm;
      const sidecar = this.partnerProvenanceFile();
      if (!memory || !sidecar || typeof memory.sourceScopeDigest !== 'function'
        || typeof memory.retainPartnerNote !== 'function') return this.partnerSyncEmpty('unavailable');
      const file = this.partnerDocFile();
      const fileExists = existsSync(file);
      if (!fileExists && !retireMissing) return this.partnerSyncEmpty('ignored');
      let source = '';
      try {
        if (fileExists) {
          if (!statSync(file).isFile() || !insidePath(realpathSync(this.memoryDir), realpathSync(file))) {
            return this.partnerSyncEmpty('failed');
          }
          source = readFileSync(file, 'utf8');
        }
      } catch {
        return this.partnerSyncEmpty('failed');
      }
      const scope = memory.sourceScopeDigest();
      if (!scope) return this.partnerSyncEmpty('unavailable');
      const workspaceDigest = partnerWorkspaceDigest(this.memoryDir);
      const stored = readPartnerProvenance(sidecar, workspaceDigest);
      if (stored.status !== 'ok' && stored.status !== 'missing') return this.partnerSyncEmpty('failed');
      const entries = stored.status === 'ok' ? [...stored.file.entries] : [];
      const byDigest = new Map(entries.map((entry) => [entry.segmentDigest, entry]));
      const segments = partnerSegments(source);
      const counts = new Map<string, number>();
      for (const segment of segments) counts.set(segment.digest, (counts.get(segment.digest) ?? 0) + 1);
      const currentDigests = new Set([...counts.entries()]
        .filter(([, count]) => count === 1)
        .map(([digest]) => digest));
      let changed = false;
      let recovered = false;
      const mark = (entry: PartnerProvenanceEntry, state: PartnerProvenanceEntry['state']): void => {
        if (entry.state === state) return;
        entry.state = state;
        changed = true;
      };

      // Anything no longer uniquely present in the saved file is history, not a current fact.
      for (const entry of entries) {
        if (entry.state !== 'stale' && !currentDigests.has(entry.segmentDigest)) mark(entry, 'stale');
      }

      for (const segment of segments) {
        if ((counts.get(segment.digest) ?? 0) !== 1) continue;
        const entry = byDigest.get(segment.digest);
        const scopeMismatch = !!entry && entry.origin === 'derived' && entry.sourceScopeDigest !== scope;
        if (entry?.state === 'stale') {
          if (!registerNew) continue;
          const forgotten = typeof memory.sourceFenced === 'function'
            && entry.sourceIds.some((sourceId) => memory.sourceFenced!(sourceId));
          if (forgotten) continue;
          const retention = memory.retainPartnerNote(segment.text, workspaceDigest, { reviveDead: true, version: randomUUID() });
          if (!retention) continue;
          const next: PartnerProvenanceEntry = {
            id: segment.digest,
            segmentDigest: segment.digest,
            origin: 'derived',
            sourceIds: [retention.documentId],
            sourceScopeDigest: scope,
            state: retention.status === 'forgotten' || retention.status === 'blocked'
              ? 'stale'
              : await this.partnerNoteReadback(segment.text, retention.documentId) ? 'current' : 'pending',
          };
          entries[entries.indexOf(entry)] = next;
          byDigest.set(segment.digest, next);
          changed = true;
          continue;
        }
        if (entry?.state === 'current' && entry.origin === 'derived' && !scopeMismatch) continue;
        if (entry?.state === 'pending') {
          if (!registerNew && !forceRecovery && Date.now() < this.partnerRecoveryAt) continue;
          if (entry.sourceIds.length !== 1) {
            mark(entry, 'stale');
            continue;
          }
          const storedId = entry.sourceIds[0]!;
          const retention = memory.retainPartnerNote(segment.text, workspaceDigest,
            { documentId: storedId, reviveDead: registerNew });
          if (!retention || retention.documentId !== storedId) continue;
          if (retention.status === 'forgotten' || retention.status === 'blocked') {
            mark(entry, 'stale');
            continue;
          }
          if (await this.partnerNoteReadback(segment.text, storedId)) {
            mark(entry, 'current');
            recovered = true;
          }
          continue;
        }
        if (!registerNew) continue;
        if (!entry || entry.origin === 'user-authored' || scopeMismatch) {
          const retention = memory.retainPartnerNote(segment.text, workspaceDigest, { reviveDead: registerNew });
          if (!retention) continue;
          const next: PartnerProvenanceEntry = {
            id: segment.digest,
            segmentDigest: segment.digest,
            origin: 'derived',
            sourceIds: [retention.documentId],
            sourceScopeDigest: scope,
            state: retention.status === 'forgotten' || retention.status === 'blocked'
              ? 'stale'
              : await this.partnerNoteReadback(segment.text, retention.documentId) ? 'current' : 'pending',
          };
          if (entry) entries[entries.indexOf(entry)] = next;
          else entries.push(next);
          byDigest.set(segment.digest, next);
          changed = true;
        }
      }

      if (changed) {
        try {
          writePartnerProvenance(sidecar, { v: 1, workspaceDigest, entries });
        } catch {
          return this.partnerSyncEmpty('failed');
        }
        this.partnerArtifacts.clear();
        this.partnerArtifactEpoch = null;
        this.partnerSourceStatesKey = null;
        if (registerNew || recovered) {
          void this.reloadPrefixNow().catch((error) => {
            this.core?.log.warn('PARTNER.md prefix reload failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }

      this.loadPartnerSourceStates();
      const current = entries.filter((entry) => entry.state === 'current').length;
      const pending = entries.filter((entry) => entry.state === 'pending').length;
      const stale = entries.filter((entry) => entry.state === 'stale').length;
      let failed = 0;
      for (const digest of currentDigests) {
        const entry = byDigest.get(digest);
        if (!entry || entry.state === 'stale' || entry.origin === 'user-authored'
          || (entry.origin === 'derived' && entry.sourceScopeDigest !== scope)) failed += 1;
      }
      for (const count of counts.values()) if (count > 1) failed += count;
      const status: PartnerSyncStatus = failed > 0 ? 'failed' : pending > 0 ? 'pending' : 'registered';
      this.partnerRecoveryAt = registerNew || pending === 0 ? 0 : Date.now() + 60_000;
      return { status, current, pending, stale, failed };
    }

    private async registerPartnerUserDocument(): Promise<PartnerSyncResult> {
      return this.syncPartnerUserDocument(true, true);
    }

    /** A read result whose paragraphs each carry the same verified derived-artifact proof as the system prefix. */
    private async partnerReadOutcome(): Promise<string | ToolOutcome> {
      const result = this.partnerProvenanceResult();
      if (result.status !== 'ok') return this.partnerStaticRead(PARTNER_READ_WITHHELD);
      const segments = result.segments.filter((segment) => segment.origin === 'derived');
      if (!segments.length) return this.partnerStaticRead(PARTNER_READ_WITHHELD);
      const memory = this.longTerm;
      if (!memory) return this.partnerStaticRead(PARTNER_READ_WITHHELD);
      const sidecar = this.partnerProvenanceFile();
      const provenance = sidecar ? readPartnerProvenance(sidecar, partnerWorkspaceDigest(this.memoryDir)) : { status: 'missing' as const };
      const entries = provenance.status === 'ok'
        ? new Map(provenance.file.entries.map((entry) => [entry.segmentDigest, entry]))
        : new Map();
      const parts = segments.map((segment) => partnerSegmentContextText(segment));
      const body = parts.join('\n\n');
      const notice = result.withheldSegments > 0 ? PARTNER_READ_WITHHELD_NOTICE : '';
      const text = notice ? `${body}\n\n${notice}` : body;
      const sourceMapSpans: SourceMapSpan[] = [];
      let offset = 0;
      for (const [index, segment] of segments.entries()) {
        const content = parts[index]!;
        const entry = entries.get(partnerSegmentDigest(segment.text));
        if (!entry || this.partnerArtifactEpoch !== memory.evidenceEpoch() || !this.partnerArtifacts.has(entry.id)
          || !await memory.verifyDerivedArtifact(`partner:${entry.id}`, content)) {
          return this.partnerStaticRead(PARTNER_READ_WITHHELD);
        }
        const evidence = await memory.evidenceForSegments(content,
          segment.sourceIds.map((documentId) => ({ documentId, start: 0, end: content.length, derived: true })));
        const exposedSources = evidence.map(({ segment: _segment, ...source }) => source);
        if (exposedSources.length !== segment.sourceIds.length
          || !exposedSources.every((source) => segment.sourceIds.includes(source.documentId))
          || !evidenceCoversText(content, evidence)) return this.partnerStaticRead(PARTNER_READ_WITHHELD);
        sourceMapSpans.push({ start: offset, end: offset + content.length, digest: sha256(content), origin: 'artifact-derived', exposedSources });
        offset += content.length + 2;
      }
      if (notice) sourceMapSpans.push({ start: body.length + 2, end: text.length, digest: sha256(notice), origin: 'core-generated' });
      return { text, sourceMapSpans };
    }

    private partnerStaticRead(text: string): ToolOutcome {
      return { text, sourceMapSpans: [{ start: 0, end: text.length, digest: sha256(text), origin: 'core-generated' }] };
    }

    protected override writeGuard(op: 'write' | 'append' | 'rename' | 'delete', path: string, role: string): string | null {
      if (isWorkspaceGitMetadataPath(this.memoryDir, path)) return 'Git metadata is not available through workspace tools.';
      return super.writeGuard(op, path, role);
    }

    protected override prefixVars(ctx: SystemPrefixContext): Record<string, string> {
      const values = super.prefixVars(ctx);
      if (deps.canonicalPersona) {
        values['persona.constitution'] = canonicalPersonaText();
        values['persona.orientation'] = canonicalOperatingText();
      }
      return values;
    }

    override promptVarValues(ctx?: { now: Date; timezone: string }): Record<string, string> {
      const values = super.promptVarValues(ctx);
      if (deps.canonicalPersona) {
        values['persona.constitution'] = canonicalPersonaText();
        values['persona.orientation'] = canonicalOperatingText();
      }
      return values;
    }

    protected override partnerDoc(): string {
      const file = this.partnerDocFile();
      let source = '';
      try {
        if (!existsSync(file)) return `${PARTNER_NOTE}\n\n(${PARTNER_FILE} is empty.)`;
        if (!statSync(file).isFile() || !insidePath(realpathSync(this.memoryDir), realpathSync(file))) {
          return `${PARTNER_NOTE}\n\n[system] PARTNER.md is withheld because its workspace path is invalid.`;
        }
        source = readFileSync(file, 'utf8');
      } catch {
        return `${PARTNER_NOTE}\n\n[system] PARTNER.md is withheld because it could not be safely read.`;
      }
      if (!source.trim()) return `${PARTNER_NOTE}\n\n(${PARTNER_FILE} is empty.)`;
      const filtered = this.partnerProvenanceResult(source);
      const notice = filtered.status !== 'ok'
        ? `[system] PARTNER.md content is withheld because its provenance sidecar is ${filtered.status}. The omitted statements are unknown, not false.`
        : filtered.withheldSegments > 0
          ? '[system] Some PARTNER.md paragraphs are withheld because their provenance is missing, stale, edited or ambiguous. The omitted statements are unknown, not false.'
          : '';
      const body = partnerEvidenceText(filtered) || '(No partner paragraphs have current provenance.)';
      return `${PARTNER_NOTE}\n\n${body}${notice ? `\n\n${notice}` : ''}`;
    }

    /** The shipped top-level prefix template; a changed template makes every literal span unproven. */
    private trustedPrefixTemplate(): boolean {
      try {
        return sha256(readFileSync(this.templateFile('PREFIX.md'), 'utf8'))
          === 'e92413a71e3006506de51d0ec863cab3738448862801f400778b5edb9e8fce8e';
      } catch {
        return false;
      }
    }

    /**
     * Map one editable value inside its prefix segment. The surrounding literal text is
     * `core-generated` only when the prefix template is the shipped one; the value itself is
     * `user-config` only when the Host attestation matches the exact file content.
     */
    private localConfigSegmentSpans(
      segment: PrefixSegment,
      value: string,
      key: 'orientation' | 'constitution',
      file: string,
      trustedPrefix: boolean,
    ): SourceMapSpan[] | undefined {
      if (!value || !segment.text.endsWith(value)) return undefined;
      const start = segment.text.length - value.length;
      if (segment.text.indexOf(value) !== start) return undefined;
      const verified = this.promptProvenance?.verify({ key, path: file, content: value });
      if (!verified?.ok) return undefined;
      const spans: SourceMapSpan[] = [];
      if (start > 0) {
        if (!trustedPrefix) return undefined;
        spans.push({
          start: 0, end: start, digest: sha256(segment.text.slice(0, start)), origin: 'core-generated',
        });
      }
      spans.push({
        start, end: segment.text.length, digest: sha256(value), origin: 'user-config',
      });
      return spans;
    }

    override async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
      await this.syncPartnerUserDocument(false);
      await this.ensurePartnerArtifacts();
      const segments = await super.systemSegments(ctx);
      // Cormini trusts its own stock seeds only. Coopanion ships its ORIENTATION and every persona
      // self-description in `core/seed/`; an unedited deployment copy is identified by exact seed
      // text, not by the runtime file hashing itself. The trailing/leading whitespace belongs to
      // the trusted prefix template and carries no other content.
      const orientation = segments.find((segment) => segment.title === 'ORIENTATION');
      if (orientation && ((deps.canonicalPersona && this.trustedPrefixTemplate() && orientation.text.trim() === canonicalOperatingText().trim()) || isShippedOrientation(orientation.text.trim()))) {
        orientation.sourceMapSpans = [{
          start: 0, end: orientation.text.length, digest: sha256(orientation.text), origin: 'core-generated',
        }];
      }
      const constitution = segments.find((segment) => segment.title === 'CONSTITUTION');
      if (constitution && ((deps.canonicalPersona && this.trustedPrefixTemplate() && constitution.text.trim() === canonicalPersonaText()) || isShippedPersonaDescription(constitution.text.trim()))) {
        constitution.sourceMapSpans = [{
          start: 0, end: constitution.text.length, digest: sha256(constitution.text), origin: 'core-generated',
        }];
      }
      // A deployment copy the person edited is not a shipped seed. It becomes `user-config` only
      // when the Host recorded that exact file after a settings save or confirmation; any doubt
      // leaves the segment unmapped and the strict-evidence gate blocks the request.
      const trustedPrefix = this.trustedPrefixTemplate();
      if (orientation && !orientation.sourceMapSpans?.length) {
        let value = '';
        try { value = readFileSync(this.orientationSource(), 'utf8').trim(); } catch { value = ''; }
        const spans = this.localConfigSegmentSpans(orientation, value, 'orientation', this.orientationSource(), trustedPrefix);
        if (spans) orientation.sourceMapSpans = spans;
      }
      if (constitution && !constitution.sourceMapSpans?.length) {
        let value = '';
        try { value = readFileSync(join(this.memoryDir, CONSTITUTION_FILE), 'utf8').trim(); } catch { value = ''; }
        const spans = this.localConfigSegmentSpans(constitution, value, 'constitution', join(this.memoryDir, CONSTITUTION_FILE), trustedPrefix);
        if (spans) constitution.sourceMapSpans = spans;
      }
      const partner = segments.find((segment) => segment.title === 'PARTNER');
      if (partner) {
        const partnerText = this.partnerDoc();
        const start = partnerText ? partner.text.indexOf(partnerText) : -1;
        const unique = start >= 0 && partner.text.indexOf(partnerText, start + partnerText.length) < 0;
        partner.sourceMapSpans = unique
          ? (await this.partnerPrefixSourceMap(partnerText)).map((span) => ({ ...span, start: span.start + start, end: span.end + start }))
          : partner.text ? [{ start: 0, end: partner.text.length, digest: sha256(partner.text), origin: 'unknown-derived' }] : [];
      }
      const workspace = segments.find((segment) => segment.title === 'WORKSPACE');
      if (workspace?.text) {
        // The W4 prefix line is generated by this Host and names no file; it carries no workspace
        // content, so the whole segment is Core text.
        workspace.sourceMapSpans = [{ start: 0, end: workspace.text.length, digest: sha256(workspace.text), origin: 'core-generated' }];
      }
      // Reviewed Experience text is a Persona rendering, not a user event. Its exact text,
      // boundaries and digests travel through the system-prefix source map. Skip the async
      // render entirely when no card is approved, so unrelated prefix builds keep their timing.
      if (this.longTerm?.enabled() && this.hasApprovedExperienceCards()) {
        const experience = await this.experiencePrefixSegment();
        if (experience) segments.push(experience);
      }
      segments.push({
        title: 'SOURCE_POLICY', text: SOURCE_CONTEXT_POLICY,
        sourceMapSpans: [{ start: 0, end: SOURCE_CONTEXT_POLICY.length, digest: sha256(SOURCE_CONTEXT_POLICY), origin: 'core-generated' }],
      });
      const policies = await this.growthPolicies?.prefix();
      if (policies) segments.push(policies);
      return segments;
    }

    async revalidateGenerationProofSources(sources: readonly SourceExposureRef[]): Promise<readonly SourceExposureRef[] | null> {
      const refreshed = await this.longTerm?.revalidateSourceExposures(sources);
      return refreshed ? sources : null;
    }

    async revalidateSourceDependencies(records: readonly ContextRecord[], events: readonly EventEnvelope[] = []): Promise<SourceDependencyRecovery[]> {
      const memory = this.longTerm;
      if (!memory) return [];
      // A restarted Core has no in-process source tokens. Historical memory attachments are
      // re-read here, before the first dispatch, and only a full identity/content/epoch match
      // registers a current proof under the persisted token.
      const refreshedEvidence = new WeakSet<ContextRecord>();
      for (const record of records) {
        const attachments = record.context.evidence;
        if (!Array.isArray(attachments) || attachments.length === 0) continue;
        if (await memory.refreshEvidenceAttachments(textOf(record), attachments)) refreshedEvidence.add(record);
      }
      await this.recoverHandoffFiles();
      const handoffFiles = memory.listHandoffArtifacts().flatMap((artifact) => {
        // A forgotten source marks the mixed note stale. Its still-current parts may be
        // re-read from the bodyDigest-bound file, but only for per-part recovery; the stale
        // artifact is never admitted as a whole note.
        const recoverable = artifact.lifecycleState === 'active'
          || (artifact.lifecycleState === 'stale' && artifact.lineageState === 'complete' && artifact.sources.length > 0);
        if (!recoverable || !artifact.target.startsWith(HANDOFF_DIR)) return [];
        const owner = handoffOwner(artifact);
        if (!owner) return [];
        const path = resolve(this.memoryDir, artifact.target);
        if (!insidePath(resolve(this.memoryDir), path) || !handoffFileMatches(path, owner, artifact.bodyDigest)) return [];
        try {
          return [{
            target: artifact.target,
            text: readFileSync(path, 'utf8'),
            sources: artifact.sources,
            sourceFree: artifact.lineageState === 'source-independent' && artifact.sources.length === 0,
          }];
        } catch { return []; }
      });
      const inputs: Array<{ text: string; digest: string; exposedSources: readonly SourceExposureRef[] }> = [];
      const spans: Array<{ proofId: string; digest: string; exposedSources: SourceExposureRef[] }> = [];
      const sourceFree: SourceDependencyRecovery[] = [];
      for (const record of records) {
        const text = textOf(record);
        for (const span of record.context.sourceDependencySpans ?? []) {
          if (!span || !Array.isArray(span.exposedSources)
            || typeof span.proofId !== 'string' || !span.proofId.trim()
            || !Number.isInteger(span.start) || !Number.isInteger(span.end)
            || span.start < 0 || span.end <= span.start || span.end > text.length
            || !/^[a-f0-9]{64}$/.test(span.digest)) continue;
          const segment = text.slice(span.start, span.end);
          if (sha256(segment) !== span.digest) continue;
          if (span.exposedSources.length === 0) {
            // The handoff notice itself is a fixed instruction, not historical content. It must
            // remain usable after its note file is withdrawn, otherwise the stale note takes the
            // whole new conversation down with it. The delivery count is cosmetic, and a
            // source-free note part is accepted only while its active note file still contains
            // that exact part. A mixed note keeps its parts on the source-bearing path.
            const staticNotice = (file: string): boolean => segment === this.handoffNoteAt(file);
            const fileInText = /saved in (handoffs\/[^\s]+\.md):/.exec(segment)?.[1];
            const noticeRecord = record.item.type === 'message' && record.item.role === 'user'
              && !record.context.frame?.events?.length && !record.context.evidence?.length
              && !record.context.sourceIndependentSpans?.length && !record.context.sourceMapSpans?.length;
            const deliveryNotice = record.item.type === 'message' && record.item.role === 'user'
              && (noticeRecord || !!record.context.frame?.events?.length || refreshedEvidence.has(record))
              && /^\[system\] \d+ new events?\.$/.test(segment);
            // After a restart the same user message may combine this fixed notice with a memory
            // block whose attachments were just re-read. The delivery count still carries no
            // historical content; only that restart path admits it beside refreshed evidence.
            const restartDeliveryNotice = refreshedEvidence.has(record) && record.item.type === 'message'
              && record.item.role === 'user' && /^\[system\] \d+ new events?\.$/.test(segment);
            const memoryStatusNotice = record.item.type === 'message' && record.item.role === 'user'
              && isFixedMemoryStatusNotice(segment);
            const belongsToHandoff = (record.context.frame?.events ?? []).some((event) =>
              event.type === HANDOFF_NOTE_TYPE && event.start < span.end && event.start + event.chars > span.start);
            const notePart = belongsToHandoff && handoffFiles.some((file) =>
              file.sourceFree && handoffNotePartOf(file.text, segment));
            // `injectMemoryContext` runs inside the delivery hook, where the Core marks the
            // injected block with the delivered events' source set. For a memory block that set
            // is empty even though the block's source-bearing slices carry separate evidence
            // attachments. Treat the block as source-free only when those attachments were just
            // re-read successfully; their spans, not this label, carry the source dependency.
            const memoryInjection = record.item.type === 'message' && record.item.role === 'user'
              && refreshedEvidence.has(record) && segment.startsWith('[memory] ');
            // `onOpening` sets this fixed line before any source-bearing delivery. It carries no
            // historical content; a restarted session repeats the other fixed variant.
            const sessionOpening = segment === '[system] The session has started.'
              || segment === '[system] The app restarted; the session carries on.';
            if (staticNotice('handoffs/') || (this.lastHandoffFile && staticNotice(this.lastHandoffFile))
              || (fileInText && staticNotice(fileInText)) || deliveryNotice || restartDeliveryNotice
              || notePart || memoryInjection || memoryStatusNotice || sessionOpening) {
              sourceFree.push({ proofId: span.proofId, digest: span.digest, persistedSources: [], currentSources: [] });
            }
            continue;
          }
          const belongsToHandoff = (record.context.frame?.events ?? []).some((event) =>
            event.type === HANDOFF_NOTE_TYPE && event.start < span.end && event.start + event.chars > span.start);
          if (belongsToHandoff && !handoffFiles.some((file) => file.text.includes(segment)
            && span.exposedSources.every((source) => file.sources.some((dependency) => dependency.bankId === source.bankId
              && dependency.endpoint === source.endpoint && dependency.documentId === source.documentId
              && dependency.contentDigest === source.contentDigest)))) continue;
          inputs.push({ text: segment, digest: span.digest, exposedSources: span.exposedSources });
          spans.push({ proofId: span.proofId, digest: span.digest, exposedSources: span.exposedSources });
        }
      }
      for (const event of events) {
        const dependency = event.sourceDependencies;
        if (!dependency?.proofId || !Array.isArray(dependency.exposedSources)
          || dependency.contentDigest !== sha256(event.text)) continue;
        if (dependency.exposedSources.length === 0) {
          const deliveryNotice = event.origin === 'internal'
            && /^\[system\] \d+ new events?\.$/.test(event.text);
          const notePart = event.type === HANDOFF_NOTE_TYPE && handoffFiles.some((file) =>
            file.sourceFree && handoffNotePartOf(file.text, event.text));
          if (deliveryNotice || notePart) {
            sourceFree.push({ proofId: dependency.proofId, digest: dependency.contentDigest,
              persistedSources: [], currentSources: [] });
          }
          continue;
        }
        if (event.type === HANDOFF_NOTE_TYPE && !handoffFiles.some((file) => file.text.includes(event.text)
          && dependency.exposedSources.every((source) => file.sources.some((entry) => entry.bankId === source.bankId
            && entry.endpoint === source.endpoint && entry.documentId === source.documentId
            && entry.contentDigest === source.contentDigest)))) continue;
        inputs.push({ text: event.text, digest: dependency.contentDigest, exposedSources: dependency.exposedSources });
        spans.push({ proofId: dependency.proofId, digest: dependency.contentDigest, exposedSources: dependency.exposedSources });
      }
      const current = await memory.revalidateSourceDependencies(inputs);
      return [...sourceFree, ...spans.flatMap((span, index) => current[index] ? [{
        proofId: span.proofId,
        digest: span.digest,
        persistedSources: span.exposedSources,
        currentSources: current[index]!,
      }] : [])];
    }

    private async partnerPrefixSourceMap(text: string): Promise<SourceMapSpan[]> {
      const unknown = (): SourceMapSpan[] => text
        ? [{ start: 0, end: text.length, digest: sha256(text), origin: 'unknown-derived' }]
        : [];
      const literal = (start: number, end: number): SourceMapSpan | null => start < end
        ? { start, end, digest: sha256(text.slice(start, end)), origin: 'core-generated' }
        : null;
      const staticText = (value: string): SourceMapSpan[] => value === text && value.length ? [literal(0, text.length)!] : unknown();
      let source = '';
      try {
        const file = this.partnerDocFile();
        if (!existsSync(file)) return staticText(`${PARTNER_NOTE}\n\n(${PARTNER_FILE} is empty.)`);
        if (!statSync(file).isFile() || !insidePath(realpathSync(this.memoryDir), realpathSync(file))) {
          return staticText(`${PARTNER_NOTE}\n\n[system] PARTNER.md is withheld because its workspace path is invalid.`);
        }
        source = readFileSync(file, 'utf8');
      } catch {
        return staticText(`${PARTNER_NOTE}\n\n[system] PARTNER.md is withheld because it could not be safely read.`);
      }
      if (!source.trim()) return staticText(`${PARTNER_NOTE}\n\n(${PARTNER_FILE} is empty.)`);

      const filtered = this.partnerProvenanceResult(source);
      const notice = filtered.status !== 'ok'
        ? `[system] PARTNER.md content is withheld because its provenance sidecar is ${filtered.status}. The omitted statements are unknown, not false.`
        : filtered.withheldSegments > 0
          ? '[system] Some PARTNER.md paragraphs are withheld because their provenance is missing, stale, edited or ambiguous. The omitted statements are unknown, not false.'
          : '';
      const renderedSegments = filtered.segments.map((segment) => ({ segment, text: partnerSegmentContextText(segment) }));
      const body = renderedSegments.map((entry) => entry.text).join('\n\n')
        || '(No partner paragraphs have current provenance.)';
      const expected = `${PARTNER_NOTE}\n\n${body}${notice ? `\n\n${notice}` : ''}`;
      if (expected !== text) return unknown();
      const userConfig = this.partnerFileVerified(source);
      const sidecar = this.partnerProvenanceFile();
      const provenance = sidecar ? readPartnerProvenance(sidecar, partnerWorkspaceDigest(this.memoryDir)) : { status: 'missing' as const };
      const entries = provenance.status === 'ok'
        ? new Map(provenance.file.entries.map((entry) => [entry.segmentDigest, entry]))
        : new Map();

      const spans: SourceMapSpan[] = [];
      const pushLiteral = (start: number, end: number): void => {
        const span = literal(start, end);
        if (span) spans.push(span);
      };
      pushLiteral(0, PARTNER_NOTE.length + 2);
      let at = PARTNER_NOTE.length + 2;
      if (renderedSegments.length === 0) {
        pushLiteral(at, at + body.length);
        at += body.length;
      } else {
        for (let index = 0; index < renderedSegments.length; index++) {
          const entry = renderedSegments[index]!;
          const start = at;
          const end = start + entry.text.length;
          if (entry.segment.origin === 'derived' && this.longTerm) {
            const provenanceEntry = entries.get(partnerSegmentDigest(entry.segment.text));
            const artifactId = provenanceEntry ? `partner:${provenanceEntry.id}` : '';
            const registered = !!provenanceEntry && this.partnerArtifactEpoch === this.longTerm.evidenceEpoch()
              && this.partnerArtifacts.has(provenanceEntry.id)
              && await this.longTerm.verifyDerivedArtifact(artifactId, entry.text);
            const evidence = registered
              ? await this.longTerm.evidenceForSegments(entry.text,
                  entry.segment.sourceIds.map((documentId) => ({ documentId, start: 0, end: entry.text.length, derived: true })))
              : [];
            const exposedSources = evidence.map(({ segment: _segment, ...sourceRef }) => sourceRef);
            const sourceIds = new Set(entry.segment.sourceIds);
            const complete = registered && sourceIds.size === exposedSources.length
              && exposedSources.every((sourceRef) => sourceIds.has(sourceRef.documentId))
              && evidenceCoversText(entry.text, evidence);
            spans.push(complete
              ? { start, end, digest: sha256(entry.text), origin: 'artifact-derived', exposedSources }
              : { start, end, digest: sha256(entry.text), origin: 'unknown-derived' });
          } else {
            spans.push(userConfig
              ? { start, end, digest: sha256(entry.text), origin: 'user-config' }
              : { start, end, digest: sha256(entry.text), origin: 'unknown-derived' });
          }
          at = end;
          if (index + 1 < renderedSegments.length) {
            pushLiteral(at, at + 2);
            at += 2;
          }
        }
      }
      if (notice) {
        pushLiteral(at, at + 2);
        at += 2;
        pushLiteral(at, text.length);
      }
      return spans;
    }

    /**
     * Brings the repository in line with this Persona: `blobs/` ignored and untracked, then whatever is
     * not committed yet committed and tagged `start-<version>` the first time `version` runs; then the partner
     * notes are arranged (`arrangePartner`) and that is committed on its own, so the tag holds the workspace as it
     * was. Run once at start, before Coo writes anything; without Git only the arranging runs. A failure is logged
     * and the app starts without that step.
     */
    snapshot(version: string): void {
      const git = this.git;
      git.ensureRepo();
      const repo = git.status().repo;
      if (repo) this.tagStart(version);
      try {
        if (arrangePartner(this.memoryDir) && repo) git.commitAll('Move partner notes into PARTNER.md and partner/', AUTHOR_APP);
      } catch (err) {
        console.warn('[persona] arranging the partner notes failed', err);
      }
    }

    /** `blobs/` ignored and untracked, then the start commit or tag; a Git failure is logged. */
    private tagStart(version: string): void {
      const git = this.git;
      try {
        const ignore = join(this.memoryDir, '.gitignore');
        const lines = existsSync(ignore) ? readFileSync(ignore, 'utf8').split(/\r?\n/) : [];
        if (!lines.includes(BLOBS_DIR)) appendFileSync(ignore, `${lines.length && lines.at(-1) !== '' ? '\n' : ''}${BLOBS_DIR}\n`, 'utf8');
        untrack(this.memoryDir, BLOBS_DIR);
        const tag = SNAPSHOT_TAG(version);
        if (git.listTags().some((t) => t.name === tag)) git.commitAll('Changes from before this start', AUTHOR_APP);
        else git.tag(tag, `The workspace as version ${version} found it`, AUTHOR_APP);
      } catch (err) {
        // runs at build time, before the Core exists; Cormini's Git warnings fall back to the console the same way
        console.warn('[workspaceGit] snapshot failed', err);
      }
    }

    protected override tools(): ToolDef[] {
      const base = super.tools().map((tool) => {
        const write = WRITES[tool.name];
        if (write) return this.committed(tool, write);
        const pathArgument = WORKSPACE_READ_PATHS[tool.name];
        if (!pathArgument) return tool;
        return {
          ...tool,
          handler: async (args: Record<string, unknown>, ctx: ToolCallContext) => {
            if (isWorkspaceGitMetadataPath(this.memoryDir, args[pathArgument])) {
              return this.trustedWorkspaceRead(tool.name, workspaceToolOutcome('[workspace read failed] Git metadata is not available through workspace tools.'));
            }
            const path = this.workspaceRelativePath(args[pathArgument]);
            const resolved = path && (tool.name === 'read_file' || tool.name === 'grep_files')
              ? this.workspaceResolvedReadPath(path) : path;
            if (path && resolved === null) {
              return this.trustedWorkspaceRead(tool.name, workspaceToolOutcome('[workspace read failed] The resolved path is unavailable through workspace tools.'));
            }
            if (tool.name === 'read_file' && (path === PARTNER_FILE || resolved === PARTNER_FILE)) {
              await this.syncPartnerUserDocument(false, false, true);
              await this.ensurePartnerArtifacts();
              return this.partnerReadOutcome();
            }
            if (tool.name === 'read_file' && (path?.startsWith(HANDOFF_DIR) || resolved?.startsWith(HANDOFF_DIR))) {
              await this.recoverHandoffFiles();
              return this.trustedWorkspaceRead(tool.name, workspaceToolOutcome('[read failed] This workspace area is withheld until its content has provenance sidecar entries.'));
            }
            if (tool.name === 'read_file' && (path?.startsWith(`${PARTNER_DIR}/`) || resolved?.startsWith(`${PARTNER_DIR}/`))) {
              return this.trustedWorkspaceRead(tool.name, workspaceToolOutcome('[read failed] This workspace area is withheld until its content has provenance sidecar entries.'));
            }
            if (tool.name === 'grep_files' && (this.searchMayIncludeProvenance(path) || this.searchMayIncludeProvenance(resolved))) {
              return this.trustedWorkspaceRead(tool.name, workspaceToolOutcome('[search failed] The requested scope may include partner or handoff notes; read only eligible files directly.'));
            }
            if (tool.name === 'grep_files' && path && this.workspaceSearchContainsLinks(path)) {
              return this.trustedWorkspaceRead(tool.name, workspaceToolOutcome('[search failed] The requested directory contains links whose contents cannot be verified; search an eligible file directly.'));
            }
            if (tool.name === 'read_file') {
              const documentId = workspaceJournalSourceId(path ?? resolved ?? '');
              if (documentId && this.longTerm?.historySourceStatus(documentId) === 'forgotten') {
                return this.trustedWorkspaceRead(tool.name, workspaceToolOutcome(workspaceReadFencedLabel(path ?? resolved ?? '')));
              }
            }
            const result = await tool.handler(args, ctx);
            return this.trustedWorkspaceRead(tool.name, workspaceReadResult(path ?? '.', result));
          },
        };
      });
      return [...base, ...memoryTools({
        memory: () => this.longTerm,
        sourceSafeToolResults: deps.sourceSafeToolResults,
        currentReadSource: (session) => session === 'main' ? this.lastUserMemory?.documentId ?? null : null,
        currentUserSource: (session) => session === 'main' && Date.now() - (this.lastUserMemory?.at ?? 0) < FORGET_WINDOW_MS
          ? this.lastUserMemory?.documentId ?? null
          : null,
      })];
    }

    private workspacePathState(path: string, instanceId: string): { path: WorkspacePathState; target: FileSystemTargetEvidence } {
      const root = resolve(this.memoryDir);
      const absolutePath = this.memory.resolveSafe(path);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (!relativePath || relativePath === '.' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
        throw new Error('the workspace path must name one file');
      }

      const realRoot = realpathSync(root);
      let bytes: Buffer | null = null;
      if (existsSync(absolutePath)) {
        if (statSync(absolutePath).isDirectory()) throw new Error('the workspace target is a directory');
        if (!insidePath(realRoot, realpathSync(absolutePath))) throw new Error('the workspace target resolves outside the workspace');
        bytes = readFileSync(absolutePath);
      } else {
        try {
          lstatSync(absolutePath);
          throw new Error('the workspace target is a broken symbolic link');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        let ancestor = dirname(absolutePath);
        while (!existsSync(ancestor)) {
          const parent = dirname(ancestor);
          if (parent === ancestor) throw new Error('the workspace parent directory is unavailable');
          ancestor = parent;
        }
        if (!insidePath(realRoot, realpathSync(ancestor))) throw new Error('the workspace parent resolves outside the workspace');
      }

      const snapshotId = sha256(JSON.stringify(bytes === null
        ? ['absent']
        : ['file', sha256(bytes), bytes.byteLength]));
      return {
        path: { absolutePath, relativePath, bytes, snapshotId },
        target: {
          surface: 'filesystem',
          instanceId,
          workspaceRoot: realRoot,
          path: relativePath,
          operation: 'file-write',
          snapshotId,
          source: 'persona-workspace',
        },
      };
    }

    private workspaceActionPlan(name: string, args: Record<string, unknown>, role: string, sessionId: string, background: boolean): WorkspaceActionPlan | { error: string; failurePrefix: string } {
      const failurePrefix = name === 'save_blob' ? '[save failed] '
        : name === 'append_file' ? '[append failed] '
          : name === 'edit_file' ? '[edit failed] '
            : name === 'delete_file' ? '[delete failed] ' : '[write failed] ';
      const rawPath = String(args.path ?? '').trim();
      if (!rawPath) return { error: 'path 不能为空', failurePrefix };

      const guardOperation = name === 'append_file' ? 'append' : name === 'delete_file' ? 'delete' : 'write';
      const denied = this.writeGuard(guardOperation, rawPath, role);
      if (denied) return { error: denied, failurePrefix };

      let effectivePath = rawPath;
      let mime = 'text/plain';
      let risk: FileSystemActionAuthorizationRequest['risk'] = 'REVERSIBLE_LOCAL';
      let finalBytes: Buffer | null = null;
      if (name === 'save_blob') {
        const given = String(args.handle ?? '').trim();
        if (!given) return { error: 'handle 不能为空', failurePrefix };
        const handle = blobScheme(given) ? given : `${LOG_SCHEME}${given}`;
        const blob = this.core?.blob(handle) ?? null;
        if (!blob) return { error: `没有 ${handle} 这份二进制`, failurePrefix };
        const normalized = this.memory.normalize(rawPath).replace(/^\.\//, '');
        effectivePath = normalized.includes('/') ? normalized : `${BLOBS_DIR}${normalized}`;
        finalBytes = Buffer.from(blob.bytes);
        mime = blob.mime;
      } else if (name === 'delete_file') {
        risk = 'EXTERNAL_MUTATION';
      }

      const nonce = randomUUID();
      let pathState: WorkspacePathState;
      let target: FileSystemTargetEvidence;
      try {
        ({ path: pathState, target } = this.workspacePathState(effectivePath, nonce));
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), failurePrefix };
      }

      if (name === 'delete_file') {
        if (this.prefixResidentFiles().some((file) => resolve(file) === pathState.absolutePath)) {
          return { error: `${rawPath} 常驻系统前缀,不能删`, failurePrefix };
        }
        if (!pathState.bytes) return { error: `${rawPath} 不存在`, failurePrefix };
        mime = 'application/octet-stream';
      }

      if (name === 'write_file') {
        finalBytes = Buffer.from(String(args.content ?? ''), 'utf8');
      } else if (name === 'append_file') {
        const content = String(args.content ?? '');
        const previous = pathState.bytes?.toString('utf8') ?? '';
        const payload = previous.length > 0 && !previous.endsWith('\n') ? `\n${content}` : content;
        finalBytes = Buffer.from(previous + payload, 'utf8');
      } else if (name === 'edit_file') {
        const oldText = String(args.old_string ?? '');
        const newText = String(args.new_string ?? '');
        if (oldText === '') return { error: 'old_string 不能为空', failurePrefix };
        if (oldText === newText) return { error: 'new_string 与 old_string 相同,没有可改的', failurePrefix };
        if (!pathState.bytes) return { error: `${rawPath} 不存在`, failurePrefix };
        const previous = pathState.bytes.toString('utf8');
        const count = previous.split(oldText).length - 1;
        if (count === 0) return { error: `${rawPath} 里没有这段文字`, failurePrefix };
        if (count > 1 && args.replace_all !== true) return { error: `这段文字在 ${rawPath} 里出现 ${count} 次`, failurePrefix };
        const next = args.replace_all === true ? previous.split(oldText).join(newText) : previous.replace(oldText, () => newText);
        finalBytes = Buffer.from(next, 'utf8');
      } else if (name === 'delete_file' || name === 'save_blob') {
        // The target or content was established before the tool-specific preflight above.
      } else {
        return { error: 'unsupported workspace action', failurePrefix };
      }

      const expectedBytes = name === 'delete_file' ? pathState.bytes! : finalBytes!;
      const digest = sha256(expectedBytes);
      const operation = name === 'delete_file' ? 'delete'
        : name === 'append_file' ? 'append'
          : pathState.bytes === null ? 'create' : 'update';
      const deltaBytes = name === 'delete_file' ? 0
        : name === 'append_file' ? expectedBytes.byteLength - (pathState.bytes?.byteLength ?? 0)
          : expectedBytes.byteLength;
      const file = { path: pathState.relativePath, digest, bytes: expectedBytes.byteLength, mime };
      const verb = name === 'delete_file' ? 'delete'
        : name === 'append_file' ? 'append'
          : name === 'edit_file' ? 'edit'
            : name === 'save_blob' ? 'save attachment to' : 'write';
      const expectedChange = name === 'delete_file'
        ? `delete ${pathState.relativePath} sha256:${digest}`
        : `${verb} ${pathState.relativePath} sha256:${digest} (${expectedBytes.byteLength} bytes)`;
      const taskText = name === 'delete_file'
        ? `Delete ${pathState.relativePath} (${expectedBytes.byteLength} bytes; sha256 ${digest}).`
        : `${verb} ${pathState.relativePath} (${expectedBytes.byteLength} bytes; sha256 ${digest}).`;
      const request: FileSystemActionAuthorizationRequest = {
        taskId: `persona:${role}:${nonce}`,
        taskText,
        actionName: `Persona ${name}`,
        expectedChange,
        payloadDigest: sha256(JSON.stringify([name, pathState.relativePath, pathState.snapshotId, digest, expectedBytes.byteLength, mime])),
        risk,
        target,
        action: 'file-write',
        files: [file],
        expiresInMs: 30_000,
        maxSteps: 1,
        operation,
        targetState: pathState.bytes === null ? 'absent' : 'present',
        baseDigest: pathState.bytes ? sha256(pathState.bytes) : null,
        deltaBytes,
        sessionId,
        background,
      };
      return { request, path: pathState, finalBytes: name === 'delete_file' ? null : finalBytes, failurePrefix };
    }

    /**
     * Self-time and other internal turns inject a `[system]` event as the last user message. A
     * chat turn carries a user-input span, so its writes may ask in the bubble.
     */
    private backgroundTurn(role: string): boolean {
      if (role !== 'main') return true;
      try {
        const records = this.core?.sessionInfo('main').snapshot ?? [];
        let lastUserInput = -1;
        let lastAssistant = -1;
        for (const [index, record] of records.entries()) {
          const userInput = (record.context.sourceIndependentSpans ?? []).some((span) => span.origin === 'user-input');
          if (userInput && (record.item.type === 'function_call_output'
            || (record.item.type === 'message' && record.item.role === 'user'))) lastUserInput = index;
          if (record.item.type === 'message' && record.item.role === 'assistant') lastAssistant = index;
        }
        return !(lastUserInput >= 0 && lastUserInput > lastAssistant);
      } catch {
        return true;
      }
    }

    /**
     * True only for a workspace result line this Host emitted from the named tool. The Core asks
     * this before it marks text as Core-generated, so a World, a model or a file cannot supply a
     * `[written] path`-shaped line and have it pass for a Host receipt.
     */
    trustWorkspaceToolText(tool: string, text: string): boolean {
      return this.workspaceIssuedText.trust(tool, text) || this.workspaceIssuedText.trustRead(tool, text);
    }

    /**
     * Marks a workspace read the Host itself composed. The read result is ordinary local
     * material, not a historical source; its label says so. Attesting the exact bytes is what
     * lets the next provider request show what the Host actually read instead of blocking it.
     */
    private trustedWorkspaceRead(tool: string, value: string | ToolOutcome): string | ToolOutcome {
      if (typeof value === 'string') {
        // A fixed Host status line is not file material, but it still has to be mapped or the
        // next request is blocked. The text is written by this wrapper, not by the file.
        return /^\[(?:not found|read failed|search failed|workspace read failed)/iu.test(value)
          ? workspaceToolOutcome(value)
          : value;
      }
      if (!value.sourceMapSpans?.length) return value;
      const spans = value.sourceMapSpans.map((span) => {
        const text = value.text.slice(span.start, span.end);
        this.workspaceIssuedText.issueRead(tool, text);
        return { ...span, origin: 'core-generated' as const };
      });
      return { ...value, sourceMapSpans: spans };
    }

    /** The tool, authorized before dispatch and committed after a matching read-back. */
    private committed(base: ToolDef, { ok, verb }: { ok: string; verb: string }): ToolDef {
      return {
        ...base,
        handler: async (args, ctx) => {
          // Core's loop supplies a call id; direct callers in tests do not, and keep the old string form.
          const trusted = ctx.callId !== undefined || ctx.generationToken !== undefined;
          const line = (text: string): string | ToolOutcome => {
            this.workspaceIssuedText.issue(base.name, text);
            return trusted ? workspaceToolOutcome(text) : text;
          };
          if (!this.authorizeWorkspaceAction) {
            // The standalone Persona retains its existing local behavior when Core has not supplied a gate.
            this.git.ensureRepo();
            const out = await base.handler(args, ctx);
            if (typeof out === 'string' && out.startsWith(ok)) {
              const message = `Coo ${verb} ${String(args.path ?? '')}`.trim();
              const run = () => this.git.commitAllAsync(message, AUTHOR_COO);
              this.commits = this.commits.then(run, run);
              await this.commits;
            }
            return out;
          }

          const planned = this.workspaceActionPlan(base.name, args, ctx.role, ctx.sessionId ?? ctx.role, this.backgroundTurn(ctx.role));
          if ('error' in planned) return line(`${planned.failurePrefix}${planned.error}`);
          // A retry of the same bytes at the same version needs no second write, approval or receipt.
          if (planned.finalBytes !== null && planned.path.bytes !== null && planned.finalBytes.equals(planned.path.bytes)) {
            return line(`${ok}${planned.path.relativePath} (unchanged)`);
          }
          const authorization = await this.authorizeWorkspaceAction(planned.request);
          if (!authorization) return line(`${planned.failurePrefix}Core did not authorize this workspace action`);
          if (!('consume' in authorization)) {
            return line(authorization.status === 'deferred'
              ? `${planned.failurePrefix}this write is waiting for approval in Settings → Memory → Workspace permissions (${authorization.reason}); it was not written. Do not retry it; continue with other work.`
              : `${planned.failurePrefix}the workspace policy refused this write (${authorization.reason}); it was not written.`);
          }

          let dispatched = false;
          try {
            // Establish the pre-write checkpoint only after approval; it is workspace history metadata.
            this.git.ensureRepo();
            const current = this.workspacePathState(planned.path.relativePath, planned.request.target.instanceId);
            if (current.path.snapshotId !== planned.path.snapshotId) {
              authorization.revoke();
              return line(`${planned.failurePrefix}the workspace file changed before dispatch`);
            }
            if (!authorization.consume(current.target, planned.request.expectedChange, planned.request.files)) {
              authorization.revoke();
              return line(`${planned.failurePrefix}the workspace grant expired or no longer matches`);
            }

            dispatched = true;
            const out = await base.handler(args, ctx);
            this.workspaceIssuedText.issue(base.name, typeof out === 'string' ? out : out.text);
            const outcome = trusted ? withWorkspaceSourceMap(out) : out;
            if (typeof out !== 'string' || !out.startsWith(ok)) {
              authorization.complete({
                phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown',
                note: 'the workspace tool did not confirm whether it changed the file',
                evidence: { source: 'persona-workspace-tool', status: 'unknown', observedAt: Date.now() },
              });
              return outcome;
            }

            let observed: WorkspacePathState;
            try {
              observed = this.workspacePathState(planned.path.relativePath, planned.request.target.instanceId).path;
            } catch (error) {
              authorization.complete({
                phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown',
                note: `workspace read-back failed: ${error instanceof Error ? error.message : String(error)}`,
                evidence: { source: 'persona-workspace-readback', status: 'unavailable', observedAt: Date.now() },
              });
              return line(`${planned.failurePrefix}workspace read-back could not verify the result`);
            }
            const matches = planned.finalBytes === null
              ? observed.bytes === null
              : observed.bytes !== null && observed.bytes.equals(planned.finalBytes);
            if (!matches) {
              authorization.complete({
                phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown',
                note: 'workspace read-back differed from the approved file state',
                evidence: {
                  source: 'persona-workspace-readback', status: 'mismatch',
                  ...(observed.bytes ? { digest: sha256(observed.bytes) } : {}), observedAt: Date.now(),
                },
              });
              return line(`${planned.failurePrefix}workspace read-back differed from the approved result`);
            }

            authorization.complete({
              phase: 'verified', dispatchState: 'delivered', outcome: 'ui-observed',
              note: planned.finalBytes === null ? 'the approved workspace file is absent after deletion' : 'the workspace file matches the approved bytes',
              evidence: {
                source: 'persona-workspace-readback', status: planned.finalBytes === null ? 'deleted' : 'matched',
                ...(observed.bytes ? { digest: sha256(observed.bytes) } : {}), observedAt: Date.now(),
              },
            });
            const message = `Coo ${verb} ${String(args.path ?? '')}`.trim();
            const run = () => this.git.commitAllAsync(message, AUTHOR_COO);
            this.commits = this.commits.then(run, run);
            await this.commits;
            return outcome;
          } catch (error) {
            if (dispatched) {
              try {
                authorization.complete({
                  phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown',
                  note: `workspace action result is uncertain: ${error instanceof Error ? error.message : String(error)}`,
                  evidence: { source: 'persona-workspace-tool', status: 'unknown', observedAt: Date.now() },
                });
              } catch {
                // The unresolved receipt remains recoverable if the ledger itself cannot be written.
              }
            } else {
              authorization.revoke();
            }
            return line(`${planned.failurePrefix}${error instanceof Error ? error.message : String(error)}`);
          }
        },
      };
    }

    override webUi(language: Language = 'zh'): PersonaWebUiDecl {
      const decl = super.webUi(language);
      const t = memoryStorageText(language);
      // W4 split: workspace browsing is ordinary file work, so it lives on the Persona page. The
      // Memory page keeps long-term memory, receipts and workspace-write permissions only.
      const workspacePanels = (decl.memory?.panels ?? []).filter((panel) => panel.id === 'workspace' || panel.id === 'history');
      const personaPanels = [...(decl.panels ?? []), ...workspacePanels];
      const storage: StoragePart[] = (decl.memory?.storage ?? []).map((part) => part.key === 'workspace'
        ? { ...part, label: t.workspaceFilesLabel, note: t.workspaceFilesNote }
        : part);
      const panels = (decl.memory?.panels ?? []).filter((panel) => panel.id !== 'workspace' && panel.id !== 'history');
      if (this.longTerm || this.growthStateFile) {
        panels.push({ id: 'hindsight', title: t.hindsightLabel, description: t.hindsightPanelDesc });
      }
      panels.push({ id: 'action-receipts', title: t.actionReceiptsLabel, description: t.actionReceiptsPanelDesc });
      if (this.workspacePermissions) {
        panels.push({ id: 'workspace-permissions', title: t.workspacePermissionLabel, description: t.workspacePermissionPanelDesc });
      }
      if (this.longTerm?.enabled()) {
        storage.push({
          key: 'hindsight',
          label: t.hindsightLabel,
          kind: 'disk',
          location: 'Hindsight',
          danger: true,
          note: t.hindsightNote,
          order: 20,
          stat: () => t.hindsightStat(this.longTerm?.bankId() ?? '?'),
          clear: () => this.longTerm!.clear(),
        });
      }
      const baseInvoke = decl.invoke;
      const invoke = async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
        if (panel === 'hindsight') return this.hindsightInvoke(method, args);
        if (panel === 'action-receipts') return this.actionReceiptsInvoke(method, args);
        if (panel === 'workspace-permissions') return this.workspacePermissionsInvoke(method, args);
        if (!baseInvoke) throw new Error(`No handler for panel ${panel}`);
        const result = await baseInvoke(panel, method, args) as { ok?: boolean; revision?: string } | null;
        const from = args[0];
        const to = method === 'rename' ? args[1] : args[0];
        const touchesPartner = panel === 'workspace'
          && (method === 'write' || method === 'rename' || method === 'remove')
          && (this.workspaceRelativePath(from) === PARTNER_FILE || this.workspaceRelativePath(to) === PARTNER_FILE);
        if (touchesPartner && result?.ok === true) {
          let verified = method !== 'write';
          if (method === 'write') {
            try {
              verified = typeof result.revision === 'string' && result.revision.length > 0
                && sha256(readFileSync(this.partnerDocFile(), 'utf8')) === result.revision;
            } catch {
              verified = false;
            }
          }
          if (!verified) return { ...result, memoryRegistration: 'failed' };
          try {
            const registration = await this.registerPartnerUserDocument();
            try {
              const partner = this.partnerDocFile();
              this.promptProvenance?.attest({ key: 'partner', path: partner, content: readFileSync(partner, 'utf8') });
            } catch { /* the save stands; only the local-configuration attestation is missing */ }
            return {
              ...result,
              memoryRegistration: registration.status,
              memoryRegistrationPending: registration.pending,
              memoryRegistrationFailed: registration.failed,
            };
          } catch (error) {
            this.core?.log.warn('PARTNER.md user provenance could not be registered', {
              message: error instanceof Error ? error.message : String(error),
            });
            return { ...result, memoryRegistration: 'failed' };
          }
        }
        return result;
      };
      return {
        ...decl,
        promptDocs: deps.canonicalPersona ? (decl.promptDocs ?? []).filter(doc => doc.key !== 'constitution' && doc.key !== 'orientation') : decl.promptDocs,
        panels: personaPanels,
        invoke,
        ...(decl.memory ? { memory: { ...decl.memory, panels, storage } } : { memory: { panels, storage } }),
      };
    }

    private workspacePermissionsInvoke(method: string, args: unknown[]): unknown {
      const permissions = this.workspacePermissions;
      if (!permissions) return { available: false, error: 'unavailable' };
      if (method === 'list') return permissions.snapshot();
      if (method === 'enableDefaults') return permissions.enableDefaults();
      if (method === 'clearSettled') return { ok: true, cleared: permissions.clearSettled() };
      if (method === 'setPaused') {
        if (typeof args[0] !== 'boolean') return { ok: false, error: 'invalid' };
        permissions.setPaused(args[0]);
        return { ok: true };
      }
      if (method === 'revokeRule') {
        const id = typeof args[0] === 'string' ? args[0] : '';
        return id && permissions.revokeRule(id) ? { ok: true } : { ok: false, error: 'missing' };
      }
      if (method === 'resolvePending') {
        const id = typeof args[0] === 'string' ? args[0] : '';
        const action = args[1];
        if (!id || (action !== 'allow-once' && action !== 'always' && action !== 'deny' && action !== 'dismiss')) {
          return { ok: false, error: 'invalid' };
        }
        return permissions.resolvePending(id, action);
      }
      throw new Error(`Unknown workspace permission method: ${method}`);
    }

    private actionReceiptsInvoke(method: string, args: unknown[]): unknown {
      const ledger = this.actionReceiptsNow();
      if (method === 'list') {
        if (!ledger) return { available: false, receipts: [] };
        return {
          available: true,
          receipts: ledger.listUnresolved().map((action) => ({
            id: action.id,
            actionId: action.actionId,
            attemptId: action.attemptId,
            taskId: action.taskId,
            intent: action.intent,
            action: action.action,
            risk: action.risk,
            phase: action.phase,
            target: action.target,
            payloadDigest: action.payloadDigest,
            files: action.files,
            dispatchState: action.dispatchState,
            evidence: action.evidence,
            createdAt: action.createdAt,
            updatedAt: action.updatedAt,
            ...(action.outcome ? { outcome: action.outcome } : {}),
            ...(action.note ? { note: action.note } : {}),
          })),
        };
      }
      if (method === 'reconcile') {
        if (!ledger) return { ok: false, error: 'unavailable' };
        const id = typeof args[0] === 'string' ? args[0] : '';
        const decision = args[1];
        const note = typeof args[2] === 'string' ? args[2] : '';
        if (!id || (decision !== 'verified' && decision !== 'review-pending' && decision !== 'failed') || !note.trim()) {
          return { ok: false, error: 'invalid' };
        }
        if (!ledger.reconcile(id, decision as ActionReceiptReviewDecision, note)) {
          return { ok: false, error: 'stale' };
        }
        return { ok: true };
      }
      throw new Error(`Unknown action receipt method: ${method}`);
    }

    /**
     * Returns the last settled supplement receipt without source text or identifiers. The method
     * is read-only and is reached only through the local Memory panel's invoke path.
     */
    private domainSupplementDiagnostics(): DomainSupplementDiagnostics {
      const base = { scope: 'persona-domain-supplement' as const, core: DOMAIN_SUPPLEMENT_CORE_UNKNOWN };
      const memory = this.longTerm;
      if (!memory) {
        return Object.freeze({ ...base, available: false, enabled: false, receiptState: 'unavailable' as const, ...DOMAIN_SUPPLEMENT_EMPTY });
      }

      let enabled = false;
      try {
        const options = typeof memory.domainSupplementOptions === 'function' ? memory.domainSupplementOptions() : null;
        enabled = memory.enabled() && options?.enabled === true;
      } catch {
        return Object.freeze({ ...base, available: true, enabled: false, receiptState: 'unavailable' as const, ...DOMAIN_SUPPLEMENT_EMPTY });
      }
      if (!enabled) {
        // A previous ON receipt stays in memory for the next ON turn but is not shown while off.
        return Object.freeze({ ...base, available: true, enabled: false, receiptState: 'disabled' as const, ...DOMAIN_SUPPLEMENT_EMPTY });
      }
      if (this.domainSupplementAbort) {
        // A newer turn owns the context; the previous receipt must not read as this turn's result.
        return Object.freeze({
          ...base, available: true, enabled: true, receiptState: 'in_progress' as const,
          ...DOMAIN_SUPPLEMENT_EMPTY, turnActive: true,
        });
      }

      let receipt: DomainSupplementReceipt | null;
      try {
        receipt = memory.lastDomainSupplementReceipt();
      } catch {
        return Object.freeze({ ...base, available: true, enabled: true, receiptState: 'unavailable' as const, ...DOMAIN_SUPPLEMENT_EMPTY });
      }
      if (!receipt) {
        return Object.freeze({ ...base, available: true, enabled: true, receiptState: 'no_receipt' as const, ...DOMAIN_SUPPLEMENT_EMPTY });
      }

      const status = safeDomainSupplementStatus(receipt.status) ?? 'fallback';
      const parsedAt = typeof receipt.at === 'string' ? Date.parse(receipt.at) : Number.NaN;
      // A turn that failed before delivery records no receipt. The last receipt in memory then still
      // belongs to the previous successful round, so it must not read as this turn's result.
      const receiptTurn = this.domainSupplementReceiptAt === receipt.at ? this.domainSupplementReceiptTurn : null;
      if (receiptTurn !== null) {
        if (receiptTurn !== this.domainSupplementTurn) {
          return Object.freeze({ ...base, available: true, enabled: true, receiptState: 'no_receipt' as const, ...DOMAIN_SUPPLEMENT_EMPTY });
        }
      } else {
        // A receipt can also be supplied without going through this Persona (for example a test or a
        // diagnostic injection); fall back to the timestamp rule when no turn owns it.
        const startedAt = this.domainSupplementTurnStartedAt;
        if (startedAt !== null && (!Number.isFinite(parsedAt) || parsedAt < startedAt)) {
          return Object.freeze({ ...base, available: true, enabled: true, receiptState: 'no_receipt' as const, ...DOMAIN_SUPPLEMENT_EMPTY });
        }
      }
      return Object.freeze({
        ...base,
        available: true,
        enabled: true,
        receiptState: 'settled' as const,
        receiptPresent: true,
        turnActive: false,
        status,
        fallbackReason: status === 'finalized'
          ? null : safeDomainSupplementFallbackReason(receipt.fallbackReason) ?? 'other',
        baselineStatus: safeTurnRecallStatus(receipt.baselineStatus),
        candidateCount: nonNegativeCount(receipt.candidateCount),
        verifiedCount: nonNegativeCount(receipt.verifiedCount),
        consumedCount: nonNegativeCount(receipt.consumedCount),
        addedSourceCount: nonNegativeCount(receipt.addedSourceCount),
        withheldCount: nonNegativeCount(receipt.withheldCount),
        fallbackCount: nonNegativeCount(receipt.fallbackCount),
        finalizedSegmentCount: nonNegativeCount(receipt.finalizedSegmentCount),
        queryCalls: nonNegativeCount(receipt.queryCalls),
        readbackCalls: nonNegativeCount(receipt.readbackCalls),
        finalReadbackCalls: nonNegativeCount(receipt.finalReadbackCalls),
        supplementalChars: nonNegativeCount(receipt.supplementalChars),
        elapsedMs: nonNegativeCount(receipt.elapsedMs),
        rssDeltaBytes: nonNegativeCount(receipt.rssDeltaBytes),
        receiptAgeMs: Number.isFinite(parsedAt) ? Math.max(0, Date.now() - parsedAt) : null,
      });
    }

    private async hindsightInvoke(method: string, args: unknown[]): Promise<unknown> {
      if (method === 'system-health') return this.systemHealth();
      if (method === 'domain-supplement-diagnostics') return this.domainSupplementDiagnostics();
      if (method === 'growth-policy-revoke') {
        if (!this.growthPolicies) throw new Error('Growth policies are unavailable.');
        await this.growthPolicies.revoke(String(args[0] ?? ''));
        return this.growthPolicies.status();
      }
      if (method === 'growth-policy-focus') {
        if (!this.growthPolicies || typeof args[0] !== 'boolean') throw new Error('A focus-context boolean is required.');
        await this.growthPolicies.setFocus(args[0]);
        await this.growthPolicies.refresh();
        return { ...this.growthPolicies.status(), proactiveTickSuppressed: this.tickText(1800) === '' };
      }
      if (method === 'growth-policy-reconcile') {
        await this.growthPolicies?.reconcile();
        return this.growthPolicies?.status() ?? null;
      }
      if (method === 'growth-auto-pause') {
        if (typeof args[0] !== 'boolean') throw new Error('A pause boolean is required.');
        this.autonomousPaused = args[0];
        this.autonomousGrowth?.pause(args[0]);
        return { paused: this.autonomousPaused };
      }
      if (method === 'growth-auto-run') {
        if (!this.autonomousGrowth) throw new Error('Automatic Growth is unavailable.');
        if ((this.core?.sessionInfo(GROWTH_SESSION).running ?? 0) > 0 || (this.core?.sessionInfo(GROWTH_VALIDATION_SESSION).running ?? 0) > 0) throw new Error('A Growth fork is already running.');
        return this.autonomousGrowth.run('manual');
      }
      if (method === 'growth-review') {
        if (this.autonomousGrowth?.status().running || (this.core?.sessionInfo(GROWTH_VALIDATION_SESSION).running ?? 0) > 0) throw new Error('Automatic Growth is still running.');
        if (!this.growthReview || !this.longTerm?.enabled()) throw new Error('Growth review is unavailable.');
        if (!Array.isArray(args[0]) || args[0].some(id => typeof id !== 'string')) throw new Error('A source ID list is required.');
        return this.growthReview.run({ sourceIds: args[0] as string[] });
      }
      if (method === 'growth-local-candidates') {
        const memory = this.longTerm, proposals = this.growthProposals();
        if (!memory || !proposals) return [];
        return Promise.all(proposals.list('candidate').map(proposal => readLocalGrowthProposal(memory, proposals, proposal.id)));
      }
      if (method === 'growth-status') {
        await this.growthPolicies?.refresh();
        return {
          schedule: this.growthSchedule?.status() ?? null,
          autonomous: this.autonomousGrowth?.status() ?? null,
          autoApply: this.growthNow().autoApply === true,
          config: this.growthNow(),
          proposalAssessments: Object.fromEntries((this.growthProposals()?.list() ?? []).map(proposal => [proposal.id, assessGrowthImpact(proposal)])),
          policies: this.growthPolicies?.status() ?? null,
          proposals: await this.hindsightInvoke('growth-proposals', []),
          experiences: this.experienceCards()?.list() ?? [],
          browser: this.systemHealth().browser,
        };
      }
      if (method === 'growth-proposals') {
        const memory = this.longTerm, store = this.growthProposals();
        if (!memory || !store) return [];
        const proposals = await Promise.all(store.list().map(async proposal => {
          if (!memory.derivedArtifactIsCurrent(proposal.id, growthProposalArtifactText(proposal))
            || !await memory.verifyDerivedArtifact(proposal.id, growthProposalArtifactText(proposal))) return null;
          if (proposal.state === 'candidate' && proposal.generationProof
            && (await readLocalGrowthProposal(memory, store, proposal.id)).status !== 'candidate') return null;
          return proposal;
        }));
        return proposals.filter((proposal): proposal is GrowthProposal => proposal !== null);
      }
      if (method === 'growth-proposal-review') {
        const id = String(args[0] ?? ''), action = String(args[1] ?? '');
        if (action !== 'approved' && action !== 'rejected') throw new Error('Review action must be approved or rejected.');
        const store = this.growthProposals();
        const current = store?.get(id);
        if (current && this.growthPolicies && assessGrowthImpact(current).coreRisk === 'high') {
          await this.growthPolicies.reconcile([id]);
          await this.growthPolicies.reviewOwner(id, action === 'approved', String(args[2] ?? ''));
          return current;
        }
        if (action === 'approved') {
          const memory = this.longTerm;
          if (!current || !memory?.enabled() || !await this.verifiedMemorySources(current.sourceIds)) {
            throw new Error('The proposal sources cannot be verified.');
          }
          if (!await memory.verifyDerivedArtifact(current.id, growthProposalArtifactText(current))) {
            throw new Error('The proposal provenance is missing, stale or no longer matches its sources.');
          }
          if (current.autonomousKey && (await readLocalGrowthProposal(memory, store!, current.id)).status !== 'candidate') throw new Error('The automatic candidate consistency review is missing or stale.');
          if (current.state !== 'candidate') throw new Error('The proposal is no longer a candidate. Refresh the list.');
        }
        const proposal = store?.transition(id, action, String(args[2] ?? ''));
        if (!proposal) throw new Error('The proposal is no longer a candidate. Refresh the list.');
        if (action === 'approved') {
          if (!this.longTerm?.setDerivedArtifactReviewState(id, 'approved')) {
            throw new Error('The proposal artifact could not be approved in the provenance store.');
          }
        } else {
          this.longTerm?.setDerivedArtifactReviewState(id, 'rejected');
        }
        return proposal;
      }
      if (method === 'growth-proposal-apply') throw new Error('Growth proposal application is not enabled.');
      if (method === 'experience-trial-receipts') {
        const id = String(args[0] ?? '');
        const cards = this.experienceCards();
        const card = cards?.get(id);
        if (!card || card.state !== 'candidate' || card.kind !== 'skill') throw new Error('A skill candidate is required.');
        const memory = this.longTerm;
        if (!memory?.derivedArtifactIsCurrent(card.id, experienceCardArtifactText(card))
          || !await memory.verifyDerivedArtifact(card.id, experienceCardArtifactText(card))) {
          throw new Error('The experience provenance is missing or stale.');
        }
        const sourcesValid = card.userExplicit
          ? await this.verifiedMemorySources(card.sourceIds)
          : await this.verifiedRepeatedUserEventSources(card.sourceIds);
        if (!memory?.enabled() || !sourcesValid) throw new Error('The experience sources cannot be verified.');
        const ledger = this.actionReceiptsNow();
        if (!ledger) throw new Error('Action receipts are unavailable.');
        return ledger.listExperienceTrialReceipts(Date.parse(card.createdAt));
      }
      if (method === 'experience-trial-record') {
        const id = String(args[0] ?? '');
        const receiptId = String(args[1] ?? '');
        const confirmedUnseen = args[2] === true;
        if (!confirmedUnseen) throw new Error('Confirm that the task was not used as candidate evidence.');
        const cards = this.experienceCards();
        const card = cards?.get(id);
        if (!card || card.state !== 'candidate' || card.kind !== 'skill') throw new Error('A skill candidate is required.');
        const memory = this.longTerm;
        if (!memory?.derivedArtifactIsCurrent(card.id, experienceCardArtifactText(card))
          || !await memory.verifyDerivedArtifact(card.id, experienceCardArtifactText(card))) {
          throw new Error('The experience provenance is missing or stale.');
        }
        const sourcesValid = card.userExplicit
          ? await this.verifiedMemorySources(card.sourceIds)
          : await this.verifiedRepeatedUserEventSources(card.sourceIds);
        if (!memory?.enabled() || !sourcesValid) throw new Error('The experience sources cannot be verified.');
        const ledger = this.actionReceiptsNow();
        if (!ledger) throw new Error('Action receipts are unavailable.');
        const receipt = ledger.findExperienceTrialReceipt(receiptId, Date.parse(card.createdAt));
        if (!receipt) throw new Error('The selected action receipt is unavailable, unresolved or predates the candidate.');
        if (!card.sourceIds.every((sourceId) => memory.sourceVisible(sourceId))) throw new Error('The experience sources are fenced.');
        const result = cards?.recordTrial(id, receipt, confirmedUnseen);
        if (!result?.ok) throw new Error(result?.errors.join('; ') ?? 'The skill trial could not be saved.');
        return result.card;
      }
      if (method === 'experience-create') {
        const input = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
        const parsed = readExperienceCardInput(input);
        if ('errors' in parsed) throw new Error(parsed.errors.join('; '));
        const memory = this.longTerm;
        const expectedEpoch = memory?.evidenceEpoch();
        if (!memory?.enabled() || !expectedEpoch || !await this.verifiedMemorySources(parsed.card.sourceIds)
          || memory.evidenceEpoch() !== expectedEpoch) {
          throw new Error('The experience sources are missing, fenced or lack current provenance.');
        }
        const cards = this.experienceCards();
        const result = cards?.create(input);
        if (!result?.ok) throw new Error(result?.errors.join('; ') ?? 'Experience cards are unavailable.');
        const registered = await memory.registerDerivedArtifactFromSources({
          artifactId: result.card.id,
          kind: 'experience-card',
          target: `experience-cards/${result.card.id}.json`,
          content: experienceCardArtifactText(result.card),
          origin: 'user-authored',
          reviewState: 'unreviewed',
          creatorOperationId: `experience-create:${result.card.id}`,
          sourceIds: result.card.sourceIds,
          expectedEpoch,
        });
        if (!registered) {
          cards?.remove(result.card.id);
          throw new Error('The experience provenance changed before the card was saved.');
        }
        return result.card;
      }
      if (method === 'experience-review') {
        const id = String(args[0] ?? ''), action = String(args[1] ?? '');
        if (action !== 'approved' && action !== 'rejected' && action !== 'deprecated') throw new Error('Review action is not supported.');
        const cards = this.experienceCards();
        const before = cards?.get(id);
        if (action === 'approved') {
          const memory = this.longTerm;
          if (before?.kind === 'skill') {
            const ledger = this.actionReceiptsNow();
            const hasLiveVerifiedTrial = !!ledger && before.trials.some((trial) => {
              const receipt = ledger.findExperienceTrialReceipt(trial.receiptId, Date.parse(before.createdAt));
              return receipt?.outcome === 'verified' && receipt.taskFingerprint === trial.taskFingerprint;
            });
            if (!hasLiveVerifiedTrial) throw new Error('A current verified receipt-backed trial is required before skill approval.');
          }
          const sourcesValid = before && (before.userExplicit
            ? await this.verifiedMemorySources(before.sourceIds)
            : await this.verifiedRepeatedUserEventSources(before.sourceIds));
          if (!memory?.enabled() || !sourcesValid || !await memory.verifyDerivedArtifact(id, experienceCardArtifactText(before))) {
            throw new Error('The experience sources cannot be verified.');
          }
          if (!memory.setDerivedArtifactReviewState(id, 'approved')) {
            throw new Error('The experience artifact could not be approved in the provenance store.');
          }
        }
        const card = cards?.transition(id, action);
        if (!card) throw new Error('The experience card is no longer in that state. Refresh the list.');
        if (action === 'rejected') this.longTerm?.setDerivedArtifactReviewState(id, 'rejected');
        if (action === 'deprecated') {
          this.longTerm?.setDerivedArtifactReviewState(id, 'rejected');
          this.longTerm?.withdrawDerivedArtifact(id, 'experience-policy-deprecated');
        }
        if (action === 'rejected' || action === 'deprecated') this.withdrawExperienceContextArtifacts(id, 'experience-policy-revoked');
        if (action === 'approved' || action === 'deprecated') {
          await this.reloadSystemPrefixSafely();
        }
        return card;
      }
      const memory = this.longTerm;
      if (!memory) throw new Error('Hindsight memory is not configured');
      switch (method) {
        case 'status':
          return memory.status();
        case 'search':
          return memory.searchResults(String(args[0] ?? ''));
        case 'forget':
          return memory.forget(String(args[0] ?? ''));
        case 'clear':
          return memory.clear();
        case 'remember':
          return memory.remember(String(args[0] ?? ''), { session: 'console' });
        default:
          throw new Error(`Unknown Hindsight method: ${method}`);
      }
    }

    private applyGrowthProposal(id: string): Promise<{ commit: string; proposal: GrowthProposal }> {
      const apply = async () => {
        const store = this.growthProposals();
        const proposal = store?.get(id);
        if (!store || !proposal || proposal.state !== 'approved' || proposal.sourceIds.length === 0) throw new Error('Approve a proposal with source documents before applying it.');
        this.git.ensureRepo();
        const status = this.git.status();
        if (!status.repo) throw new Error(status.initError ?? 'The Persona workspace has no Git history.');
        if (status.dirty) throw new Error('The Persona workspace has uncommitted changes. Commit or restore them before applying this proposal.');

        // Evidence that is gone must not become a Persona change. A source can be forgotten while
        // the app was off, so the proposal's list is checked against the bank again here.
        const memory = this.longTerm;
        if (!memory?.enabled()) throw new Error('Long-term memory is off, so the proposal sources cannot be checked. Turn it on and try again.');
        const expectedMemoryEpoch = memory.evidenceEpoch();
        if (!expectedMemoryEpoch) throw new Error('The proposal source epoch is unavailable. It was not applied.');
        if (memory.derivedArtifact(id)?.reviewState !== 'approved'
          || !memory.derivedArtifactIsCurrent(id, growthProposalArtifactText(proposal))
          || !await memory.verifyDerivedArtifact(id, growthProposalArtifactText(proposal))) {
          throw new Error('The proposal provenance is missing or stale. It was not applied.');
        }
        const missing: string[] = [];
        for (const sourceId of proposal.sourceIds) {
          if (!await memory.hasSource(sourceId)) missing.push(sourceId);
        }
        if (missing.length > 0) throw new Error(`The proposal sources are gone: ${missing.join(', ')}. It was not applied.`);
        if (memory.evidenceEpoch() !== expectedMemoryEpoch) throw new Error('The proposal sources changed during review. It was not applied.');

        // Every change is resolved against the same snapshot and every file's final text is built
        // in memory first, so a later change that no longer matches leaves no earlier one applied.
        const originals = new Map<string, { exists: boolean; text: string }>();
        const finals = new Map<string, string>();
        for (const change of proposal.changes) {
          if (!originals.has(change.file)) {
            const path = join(this.memoryDir, change.file);
            const exists = existsSync(path);
            const text = exists ? readFileSync(path, 'utf8') : '';
            originals.set(change.file, { exists, text });
            finals.set(change.file, text);
          }
          const before = finals.get(change.file)!;
          let after: string;
          if (change.from !== undefined) {
            const first = before.indexOf(change.from);
            if (first < 0 || before.indexOf(change.from, first + change.from.length) >= 0) {
              throw new Error(`${change.file} no longer has one unique copy of the proposed source text.`);
            }
            after = `${before.slice(0, first)}${change.to}${before.slice(first + change.from.length)}`;
          } else {
            if (before.includes(change.to)) throw new Error(`${change.file} already contains the proposed line.`);
            after = `${before.replace(/\s*$/, '')}${before.trim() ? '\n\n' : ''}${change.to}\n`;
          }
          finals.set(change.file, after);
        }

        const written: string[] = [];
        let committed = false;
        try {
          for (const [file, text] of finals) {
            writeState(join(this.memoryDir, file), text);
            written.push(file);
          }
          const commit = this.git.commitAll(`Apply growth proposal ${proposal.id}`, AUTHOR_APP);
          if (!commit) throw new Error(this.git.status().commitError ?? 'Git did not create a commit for this proposal.');
          committed = true;
          const applied = store.markApplied(proposal.id, commit);
          if (!applied) throw new Error('The Persona files were committed, but the proposal state could not be updated.');
          return { commit, proposal: applied };
        } catch (error) {
          if (!committed) {
            for (const file of written) {
              const original = originals.get(file)!;
              const path = join(this.memoryDir, file);
              if (original.exists) writeState(path, original.text);
              else unlinkSync(path);
            }
          }
          throw error;
        }
      };
      this.commits = this.commits.then(apply, apply);
      return this.commits as Promise<{ commit: string; proposal: GrowthProposal }>;
    }

    override onOpening(ctx: { reason: SessionOpeningReason }): void {
      this.pendingOpening = ctx.reason === 'restarted' ? '[system] The app restarted; the session carries on.' : '[system] The session has started.';
      if (!this.longTerm?.enabled() && !this.experienceCards()?.list('approved').length) return;
      this.core?.injectDeferred('memory', async () => {
        const briefing = this.longTerm?.enabled() ? await this.longTerm.sessionBriefing().catch(() => null) : null;
        const portrait = briefing?.text?.trim() ?? '';
        if (portrait && briefing?.evidence?.length) this.injectMemoryContext(portrait, briefing.evidence);
        return null;
      });
    }

    retainCooOutput(text: string, meta: { session?: string; callId?: string; timestamp?: string }): void {
      const session = meta.session ?? 'main';
      const envelopes = meta.callId
        ? this.attachedCore?.generationEvidence(session).filter((envelope) => envelope.sessionId === session
            && envelope.outputToolCalls.some((output) => output.toolCallId === meta.callId)) ?? []
        : [];
      const envelope = envelopes.length === 1 ? envelopes[0] : undefined;
      const generation = this.attachedCore?.sessionInfo(session).generation;
      if (envelope && (generation?.status !== 'current' || generation.token !== envelope.sessionGenerationToken)) return;
      this.longTerm?.retainCoo(text, meta, envelope);
    }

    override onWorldLifecycle(event: WorldLifecycleEvent): void {
      const what = event.kind === 'visibility'
        ? (event.visible ? 'is visible to you again' : 'is hidden from you; its events no longer reach you')
        : event.kind === 'mounted' ? 'is on' : event.kind === 'unmounted' ? 'is off' : 'restarted';
      this.core?.injectInternal(`[system] The World "${event.label}" ${what}.`, 'notice');
    }

    private requestHandoffAfterDeliveredNoteForget(forgottenIds: readonly string[]): boolean {
      const memory = this.longTerm;
      const core = this.attachedCore;
      const forgotten = [...new Set(forgottenIds.filter(Boolean))];
      if (!memory || !core || forgotten.length === 0) return false;
      const bankId = memory.bankId();
      const endpoint = memory.endpoint();
      const snapshot = core.sessionInfo('main').snapshot;
      if (!bankId || !endpoint || !snapshot?.length) return false;
      const forgottenSet = new Set(forgotten);
      const affectedSources = new Map<string, SourceExposureRef>();
      for (const record of snapshot) {
        const noteEvents = (record.context.frame?.events ?? []).filter((event) => event.type === HANDOFF_NOTE_TYPE);
        if (noteEvents.length === 0) continue;
        for (const span of record.context.sourceDependencySpans ?? []) {
          const coversNote = noteEvents.some((event) => span.start < event.start + event.chars && span.end > event.start);
          if (!coversNote || !span.exposedSources.some((source) =>
            source.bankId === bankId && source.endpoint === endpoint && forgottenSet.has(source.documentId))) continue;
          for (const source of span.exposedSources) {
            if (source.bankId === bankId && source.endpoint === endpoint) {
              affectedSources.set(handoffSourceProofIdentity(source), source);
            }
          }
        }
      }
      let rawContext = false;
      if (affectedSources.size === 0) {
        for (const record of snapshot) {
          const refs = [
            ...(record.context.evidence ?? []).map(sourceRefFromAttachment),
            ...(record.context.generationEvidenceProof?.exposedSources ?? []),
            ...(record.context.sourceDependencySpans ?? []).flatMap((span) => span.exposedSources),
            ...(record.context.sourceMapSpans ?? []).flatMap((span) => span.exposedSources ?? []),
          ];
          if (!refs.some((source) => source.bankId === bankId && source.endpoint === endpoint
            && forgottenSet.has(source.documentId))) continue;
          for (const source of refs) {
            if (source.bankId === bankId && source.endpoint === endpoint) {
              affectedSources.set(handoffSourceProofIdentity(source), source);
            }
          }
        }
        rawContext = affectedSources.size > 0;
      }
      if (affectedSources.size === 0) return false;

      const sourceRefs = [...affectedSources.values()];
      const identities = new Set(sourceRefs.map(handoffSourceIdentity));
      const artifactIds = memory.listHandoffArtifacts().filter((artifact) => artifact.kind === 'handoff-note'
        && artifact.lifecycleState === 'stale' && artifact.statusReason === 'source-forgotten'
        && artifact.sources.length > 0
        && artifact.sources.some((source) => forgottenSet.has(source.documentId))
        && artifact.sources.every((source) => identities.has(handoffSourceIdentity({
          bankId: source.bankId, endpoint: source.endpoint, documentId: source.documentId,
          contentDigest: source.contentDigest ?? '',
        })))).map((artifact) => artifact.artifactId);
      if (artifactIds.length === 0 && !rawContext) return false;

      const current = this.pendingForgottenHandoffReset;
      if (current) {
        if (current.rawContext) {
          const cursor = core.latestEventCursor?.();
          if (!Number.isSafeInteger(cursor) || cursor! < 0) {
            this.pendingForgottenHandoffReset = null;
            return false;
          }
          current.eventCutoff = Math.max(current.eventCutoff ?? 0, cursor!);
        }
        for (const id of forgotten) if (!current.forgottenIds.includes(id)) current.forgottenIds.push(id);
        for (const source of sourceRefs) {
          if (!current.sourceRefs.some((entry) => handoffSourceProofIdentity(entry) === handoffSourceProofIdentity(source))) {
            current.sourceRefs.push(source);
          }
        }
        for (const id of artifactIds) if (!current.artifactIds.includes(id)) current.artifactIds.push(id);
        current.expectedEpoch = memory.evidenceEpoch() ?? current.expectedEpoch;
        return true;
      }

      const expectedEpoch = memory.evidenceEpoch();
      if (!expectedEpoch) return false;
      const eventCutoff = rawContext ? core.latestEventCursor?.() : undefined;
      if (rawContext && (!Number.isSafeInteger(eventCutoff) || eventCutoff! < 0)) return false;
      let resolveBlocked!: () => void;
      const blocked = new Promise<void>((resolve) => { resolveBlocked = resolve; });
      const reset: ForgottenHandoffReset = {
        phase: 'awaiting-block',
        ...(rawContext ? { rawContext: true as const, eventCutoff } : {}),
        forgottenIds: forgotten,
        sourceRefs,
        artifactIds,
        expectedEpoch,
        resolveBlocked,
      };
      this.pendingForgottenHandoffReset = reset;
      void this.runForgottenHandoffReset(reset, blocked);
      return true;
    }

    private async runForgottenHandoffReset(reset: ForgottenHandoffReset, blocked: Promise<void>): Promise<void> {
      const core = this.attachedCore;
      if (!core) {
        if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
        return;
      }
      const waitMs = 10;
      const memory = this.longTerm;
      const settleDeadline = Date.now() + 10_000;
      while (this.pendingForgottenHandoffReset === reset && Date.now() < settleDeadline) {
        const generation = core.sessionInfo('main').generation;
        if (!generation || generation.status !== 'current') break;
        const settledEpoch = memory?.settled() ? memory.evidenceEpoch() : null;
        if (settledEpoch) {
          reset.expectedEpoch = settledEpoch;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      if (this.pendingForgottenHandoffReset !== reset || !memory?.settled() || !memory.evidenceEpoch()) {
        if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
        return;
      }
      reset.expectedEpoch = memory.evidenceEpoch()!;
      if (reset.rawContext) {
        const generation = core.sessionInfo('main').generation;
        if (!generation || generation.status !== 'current'
          || !reset.forgottenIds.every((id) => memory.sourceFenced(id))) {
          if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
          return;
        }
        reset.expectedGeneration = generation.token;
        reset.phase = 'reset-ready';
        const deadline = Date.now() + 5_000;
        while (this.pendingForgottenHandoffReset === reset && Date.now() < deadline) {
          const current = core.sessionInfo('main').generation;
          if (!current || current.status !== 'current' || current.token !== reset.expectedGeneration
            || !memory.settled() || memory.evidenceEpoch() !== reset.expectedEpoch) break;
          if (core.requestContextHandoff()) return;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
        return;
      }
      const oldBlockDeadline = Date.now() + 5_000;
      while (this.pendingForgottenHandoffReset === reset && !reset.candidateSnapshotId && Date.now() < oldBlockDeadline) {
        core.requestContextHandoff();
        await Promise.race([blocked, new Promise((resolve) => setTimeout(resolve, waitMs))]);
      }
      if (this.pendingForgottenHandoffReset !== reset || !reset.candidateSnapshotId || !reset.expectedGeneration) {
        if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const oldOutcome = core.handoffOutcome();
      if (oldOutcome?.status === 'blocked' && oldOutcome.candidateSnapshotId === reset.candidateSnapshotId
        && oldOutcome.reason === 'original-memory-source-dependency-unverified') {
        this.lastForgottenHandoffBlock = {
          status: 'blocked',
          candidateSnapshotId: oldOutcome.candidateSnapshotId,
          mappingState: oldOutcome.mappingState,
          reason: oldOutcome.reason,
        };
      }
      reset.phase = 'reset-ready';
      const resetDeadline = Date.now() + 5_000;
      while (this.pendingForgottenHandoffReset === reset && Date.now() < resetDeadline) {
        const generation = core.sessionInfo('main').generation;
        if (!generation || generation.status !== 'current' || generation.token !== reset.expectedGeneration) break;
        if (core.requestContextHandoff()) return;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
    }

    private signalForgottenHandoffBlocked(ctx: ContextHandoffPrepareContext): void {
      const reset = this.pendingForgottenHandoffReset;
      if (!reset || reset.phase !== 'awaiting-block') return;
      reset.candidateSnapshotId = ctx.candidateSnapshotId;
      reset.expectedGeneration = ctx.expectedGeneration;
      reset.resolveBlocked();
    }

    private prepareForgottenContextReset(
      snapshot: ContextRecord[],
      ctx: ContextHandoffPrepareContext,
      reset: ForgottenHandoffReset,
    ): PreparedContextHandoff {
      const memory = this.longTerm;
      const core = this.attachedCore;
      const expectedEpoch = memory?.evidenceEpoch() ?? null;
      const tail = this.handoffTail(snapshot, reset.rawContext ? reset.eventCutoff : undefined);
      const tailEvidence = ctx.inspectCandidate(tail);
      const validResetTail = tailEvidence.mappingState === 'complete' && tailEvidence.exposedSources.length === 0;
      const commitGuard = (): HandoffCommitCheck => {
        const generation = core?.sessionInfo(ctx.sessionId).generation;
        if (!generation || generation.status !== 'current' || generation.token !== ctx.expectedGeneration
          || ctx.candidateSnapshotId !== reset.resetCandidateSnapshotId
          || ctx.expectedGeneration !== reset.expectedGeneration) return { status: 'stale', reason: 'generation-changed' };
        if (this.pendingForgottenHandoffReset !== reset || reset.phase !== 'reset-ready') {
          return { status: 'blocked', reason: 'forgotten-handoff-reset-expired' };
        }
        if (!memory || !expectedEpoch || !memory.enabled() || !memory.settled()
          || memory.evidenceEpoch() !== expectedEpoch || reset.expectedEpoch !== expectedEpoch) {
          return { status: 'blocked', reason: 'forget-epoch-changed-during-reset' };
        }
        if (!reset.forgottenIds.every((id) => memory.sourceFenced(id))) {
          return { status: 'blocked', reason: 'forget-fence-not-current' };
        }
        if (!reset.artifactIds.every((id) => memory.derivedArtifact(id)?.lifecycleState === 'stale'
          && memory.derivedArtifact(id)?.statusReason === 'source-forgotten')) {
          return { status: 'blocked', reason: 'old-handoff-is-not-stale' };
        }
        const checked = ctx.inspectCandidate(tail);
        if (!validResetTail || checked.mappingState !== 'complete' || checked.exposedSources.length !== 0) {
          return { status: 'blocked', reason: 'reset-tail-is-not-source-independent' };
        }
        return { status: 'allow' };
      };
      return {
        result: { tail },
        candidate: { snapshotId: ctx.candidateSnapshotId, records: tail, sourceExcerpts: [], content: '', injections: [] },
        protected: true,
        archiveOriginal: true,
        commitGuard,
        commit: () => {
          if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
          this.pendingCleanHandoffRebuild = null;
          this.memoryContextBlocks.clear();
          this.pressureWarned = false;
          this.pressureSplitAt = null;
          queueMicrotask(() => { void this.rebuildCleanHandoffAfterReset(reset); });
        },
        discard: () => {
          if (this.pendingForgottenHandoffReset === reset) this.pendingForgottenHandoffReset = null;
        },
        injections: [],
      };
    }

    private async rebuildCleanHandoffAfterReset(reset: ForgottenHandoffReset): Promise<void> {
      const memory = this.longTerm;
      const core = this.attachedCore;
      if (!memory?.enabled() || !memory.settled() || !core || !reset.expectedGeneration) return;
      const isGenerationCurrent = (): boolean => {
        const generation = core.sessionInfo('main').generation;
        return !!generation && generation.status === 'current' && generation.token === reset.expectedGeneration;
      };
      if (!isGenerationCurrent()) return;
      const expectedEpoch = memory.evidenceEpoch();
      const bankId = memory.bankId();
      const endpoint = memory.endpoint();
      if (!expectedEpoch || !bankId || !endpoint) return;
      const inputs: CleanHandoffRebuild['inputs'] = [];
      const sourceRefs: SourceExposureRef[] = [];
      const seen = new Set<string>();
      for (const previous of reset.sourceRefs) {
        if (reset.forgottenIds.includes(previous.documentId)
          || previous.bankId !== bankId || previous.endpoint !== endpoint
          || memory.sourceFenced(previous.documentId) || !memory.sourceVisible(previous.documentId)
          || !memory.sourceCurrentForContext(previous.documentId)) continue;
        const tuple = JSON.stringify([previous.bankId, previous.endpoint, previous.documentId]);
        if (seen.has(tuple)) continue;
        seen.add(tuple);
        const exact = await memory.readExactSourceEvidence(previous.documentId);
        if (!isGenerationCurrent()) return;
        if (!exact || exact.endpointBinding !== 'configured-client'
          || exact.bankId !== previous.bankId || exact.endpoint !== previous.endpoint
          || exact.documentId !== previous.documentId
          || !/^[a-f0-9]{64}$/.test(exact.contentDigest)
          || exact.revision !== exact.contentDigest
          || createHash('sha256').update(exact.storedText, 'utf8').digest('hex') !== exact.contentDigest
          || !Number.isSafeInteger(exact.sourceEpoch) || exact.sourceEpoch < 0
          || exact.fenceEpoch !== String(exact.sourceEpoch) || exact.evidenceEpoch !== expectedEpoch
          || memory.evidenceEpoch() !== expectedEpoch || memory.sourceFenced(previous.documentId)
          || !memory.sourceVisible(previous.documentId) || !memory.sourceCurrentForContext(previous.documentId)) return;
        const [attachment] = await memory.evidenceForSegments(exact.storedText, [
          { documentId: exact.documentId, start: 0, end: exact.storedText.length },
        ]);
        if (!isGenerationCurrent()) return;
        if (!attachment || attachment.bankId !== exact.bankId || attachment.endpoint !== exact.endpoint
          || attachment.documentId !== exact.documentId || attachment.validatedEpoch !== exact.evidenceEpoch
          || attachment.revisionState !== 'current' || attachment.validationStatus !== 'validated'
          || attachment.validationReceipt !== exact.validationReceipt
          || attachment.contentDigest !== exact.contentDigest
          || attachment.segment.start !== 0 || attachment.segment.end !== exact.storedText.length
          || attachment.segment.digest !== exact.contentDigest || !attachment.segment.sourceProof
          || memory.evidenceEpoch() !== expectedEpoch) return;
        inputs.push({ text: exact.storedText, attachment });
        sourceRefs.push(sourceRefFromAttachment(attachment));
      }
      if (inputs.length === 0 || memory.evidenceEpoch() !== expectedEpoch
        || !await memory.verifyExposureSources(sourceRefs, expectedEpoch)
        || !isGenerationCurrent() || memory.evidenceEpoch() !== expectedEpoch) return;

      const plan: CleanHandoffRebuild = {
        expectedEpoch,
        forgottenIds: [...reset.forgottenIds],
        sourceRefs,
        inputs,
      };
      this.pendingCleanHandoffRebuild = plan;
      for (const input of inputs) this.injectMemoryContext(input.text, [input.attachment]);

      const deadline = Date.now() + 5_000;
      while (this.pendingCleanHandoffRebuild === plan && Date.now() < deadline) {
        if (!isGenerationCurrent() || memory.evidenceEpoch() !== expectedEpoch || !memory.settled()) {
          this.pendingCleanHandoffRebuild = null;
          return;
        }
        const snapshot = core.sessionInfo('main').snapshot ?? [];
        if (this.cleanHandoffSourceExcerpts(snapshot, plan)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (this.pendingCleanHandoffRebuild !== plan) return;
      if (!isGenerationCurrent() || memory.evidenceEpoch() !== expectedEpoch) {
        this.pendingCleanHandoffRebuild = null;
        return;
      }
      const snapshot = core.sessionInfo('main').snapshot ?? [];
      if (!this.cleanHandoffSourceExcerpts(snapshot, plan)) {
        this.pendingCleanHandoffRebuild = null;
        return;
      }

      const requestDeadline = Date.now() + 5_000;
      while (this.pendingCleanHandoffRebuild === plan && Date.now() < requestDeadline) {
        if (!isGenerationCurrent() || memory.evidenceEpoch() !== expectedEpoch) {
          this.pendingCleanHandoffRebuild = null;
          return;
        }
        if (core.requestContextHandoff()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (this.pendingCleanHandoffRebuild === plan) this.pendingCleanHandoffRebuild = null;
    }

    private cleanHandoffSourceExcerpts(
      snapshot: readonly ContextRecord[],
      plan: CleanHandoffRebuild,
    ): ContextHandoffSourceExcerpt[] | null {
      if (this.longTerm?.evidenceEpoch() !== plan.expectedEpoch) return null;
      const forgotten = new Set(plan.forgottenIds);
      const expected = new Map(plan.inputs.map((input) => [JSON.stringify(input.attachment), input]));
      const found = new Map<string, ContextHandoffSourceExcerpt>();
      for (const record of snapshot) {
        if (record.item.type === 'message' && record.item.role === 'system') continue;
        if ((record.context.frame?.events ?? []).some((event) => event.type === HANDOFF_NOTE_TYPE)) return null;
        for (const attachment of record.context.evidence ?? []) {
          if (forgotten.has(attachment.documentId)) return null;
          const input = expected.get(JSON.stringify(attachment));
          if (!input) return null;
          const text = textOf(record);
          const { start, end, digest } = attachment.segment;
          if (!record.item.id || start < 0 || end <= start || end > text.length
            || text.slice(start, end) !== input.text
            || digest !== createHash('sha256').update(input.text, 'utf8').digest('hex')) return null;
          const key = handoffSourceProofIdentity(sourceRefFromAttachment(attachment));
          if (found.has(key)) return null;
          found.set(key, { sourceRecordId: record.item.id, attachment });
        }
        for (const span of record.context.sourceDependencySpans ?? []) {
          if (span.exposedSources.some((source) => forgotten.has(source.documentId))) return null;
        }
        for (const span of record.context.sourceMapSpans ?? []) {
          if (span.exposedSources?.some((source) => forgotten.has(source.documentId))) return null;
        }
      }
      const result = plan.inputs.map((input) => found.get(handoffSourceProofIdentity(sourceRefFromAttachment(input.attachment))));
      return result.every((entry): entry is ContextHandoffSourceExcerpt => !!entry) ? result : null;
    }

    /**
     * A historical handoff note can carry only the union of its sources. If any of those
     * sources is gone, the note cannot be split by guessing text boundaries. Empty only the
     * delivered event body; the static handoff notice remains the fixed, fact-free diagnostic.
     * The stored note and artifact stay in place for audit. Never mark the historical body
     * as core-generated.
     */
    private async isolateInvalidHandoffNotes(events: readonly EventEnvelope[]): Promise<number> {
      const memory = this.longTerm;
      let isolated = 0;
      for (const event of events) {
        if (event.type !== HANDOFF_NOTE_TYPE || event.origin !== 'external') continue;
        const dependency = event.sourceDependencies;
        if (!dependency || dependency.exposedSources.length === 0) continue;
        let current: SourceExposureRef[] | null = null;
        if (memory?.enabled()) {
          try {
            const [validated] = await memory.revalidateSourceDependencies([{
              text: event.text,
              digest: dependency.contentDigest,
              exposedSources: dependency.exposedSources,
            }]);
            current = validated ?? null;
          } catch {
            current = null;
          }
        }
        if (current) continue;
        event.text = '';
        event.sourceDependencies = undefined;
        delete event.evidence;
        delete event.blobs;
        isolated += 1;
      }
      return isolated;
    }

    /** Cormini's delivery: the heartbeat's quiet time starts over, and one line counts the events. */
    override async onDelivery(ctx: { events: EventEnvelope[] }): Promise<void> {
      await this.growthPolicies?.refresh();
      this.logRecentSourceSpanDiagnostics();
      const isolatedHandoffs = await this.isolateInvalidHandoffNotes(ctx.events);
      await this.syncPartnerUserDocument(false);
      if (this.pendingOpening) {
        this.core?.injectInternal(this.pendingOpening, 'opening');
        this.pendingOpening = null;
      }
      if (ctx.events.some((event) => event.origin === 'external')) this.growthSchedule?.noteActivity();
      for (const event of ctx.events) {
        if (event.type !== 'affinity.changed') continue;
        const meta = event.meta as Record<string, unknown> | undefined;
        if (meta) this.longTerm?.retainAffinityChange(meta);
      }
      const external = ctx.events.filter((e) => e.origin === 'external');
      const n = external.length;
      if (n === 0) return;
      // Cormini keeps its heartbeat private; the bracket access is TypeScript's way in for a subclass
      this['heartbeat'].noteActivity();
      // A count notice injected during delivery inherits the batch's source dependencies.
      // When a mixed handoff note was isolated, those dependencies include the forgotten
      // source; skip the cosmetic count instead of poisoning the new request.
      // A source-free handoff batch has no dependency proof for the notice to inherit; the event
      // frame header already counts it, and an uncovered notice would block the next request
      // after a restart. Source-free ordinary batches keep the notice for provider mapping.
      const carriesSourceDependencies = ctx.events.some((event) =>
        (event.sourceDependencies?.exposedSources.length ?? 0) > 0);
      const sourceFreeHandoff = !carriesSourceDependencies
        && ctx.events.some((event) => event.type === HANDOFF_NOTE_TYPE);
      if (isolatedHandoffs === 0 && !sourceFreeHandoff) {
        this.core?.injectInternal(`[system] ${n} new event${n === 1 ? '' : 's'}.`, 'notice');
      }

      let latest: string | null = null;
      let latestUserDocumentId: string | null = null;
      for (const event of external) {
        if (event.source !== 'desktop-pet') continue;
        if (event.type === 'desktop-pet.touch') {
          const touch = event.meta?.touch as { kind?: unknown; count?: unknown; crashed?: unknown } | undefined;
          if (touch) this.longTerm?.retainTouch(touch, { session: 'main', cursor: event.cursor, at: event.ts });
          this.lastUserMemory = null;
          continue;
        }
        if (event.type !== 'desktop-pet.message' && event.type !== 'desktop-pet.speech' && event.type !== 'desktop-pet.answer') continue;
        const said = typeof event.meta?.text === 'string' ? event.meta.text.trim() : '';
        if (!said) {
          this.lastUserMemory = null;
          continue;
        }
        if (isMemoryForgetRequest(said)) {
          const previous = this.lastUserMemory;
          if (previous && Date.now() - previous.at < FORGET_WINDOW_MS) await this.longTerm?.forgetDocument(previous.documentId);
          else await this.longTerm?.forgetMostRecent('main', new Date(Date.now() - FORGET_WINDOW_MS));
          this.lastUserMemory = null;
          latest = null;
          latestUserDocumentId = null;
          continue;
        }
        latest = said;
        const documentId = this.longTerm?.retainUser(said, { session: 'main', cursor: event.cursor, timestamp: event.ts });
        latestUserDocumentId = documentId ?? null;
        this.lastUserMemory = documentId ? { documentId, at: Date.now() } : null;
      }

      if (!latest || !this.longTerm?.enabled()) return;
      const supplementOptions = typeof this.longTerm.domainSupplementOptions === 'function'
        ? this.longTerm.domainSupplementOptions()
        : null;
      // A newer user message retires the older turn before either baseline finishes, so a
      // slow older baseline cannot acquire a newer turn number and inject after the new one.
      const supplementTurn = supplementOptions?.enabled ? this.beginDomainSupplementTurn() : null;
      try {
        const recalled = await this.longTerm.recallForTurn(latest, {
          ...(latestUserDocumentId ? { userEventDocumentId: latestUserDocumentId } : {}),
          captureTrace: true,
        });
        const sourceSegments = recalled.trace?.format.sourceSegments ?? [];
        let effectiveRecalled = recalled;
        let baselineText = recalled.text;
        let baselineEvidence = baselineText
          ? await this.longTerm.evidenceForSegments(baselineText, sourceSegments)
          : [];
        // Every traced source body must be present, current, validated and digest-matched.
        // The fixed `[memory]` header, result labels and the incomplete-facts notice are Core
        // formatting, not historical content, so they are not required to carry a source span.
        let complete = sourceSegments.length > 0
          && evidenceCoversSegments(baselineText, sourceSegments, baselineEvidence);
        if (baselineText && !complete && typeof this.longTerm.verifiedSourceExcerptsForDocuments === 'function') {
          // Semantic recall often returns paraphrased facts that do not match the original text
          // verbatim. Rebuild the baseline from verified original source excerpts so SourceProof
          // stays strict without discarding valid semantic hits.
          const candidateDocIds = [
            ...(recalled.trace?.format.includedSourceDocumentIds ?? []),
            ...sourceSegments.map((segment) => segment.documentId),
          ];
          const rebuilt = await this.longTerm.verifiedSourceExcerptsForDocuments(candidateDocIds, {
            ...(latestUserDocumentId ? { excludeDocumentId: latestUserDocumentId } : {}),
            maxSources: 6,
          });
          if (rebuilt) {
            baselineText = rebuilt.text;
            baselineEvidence = rebuilt.evidence;
            effectiveRecalled = recalled.trace
              ? {
                ...recalled,
                text: rebuilt.text,
                trace: {
                  ...recalled.trace,
                  format: {
                    ...recalled.trace.format,
                    sourceSegments: rebuilt.sourceSegments,
                    includedSourceDocumentIds: [...new Set(rebuilt.sourceSegments.map((segment) => segment.documentId))],
                  },
                },
              }
              : { ...recalled, text: rebuilt.text };
            complete = true;
          }
        }
        if (baselineText && !complete) {
          // A summary without full evidence cannot enter the request; the opt-in consumer can still try exact indexed sources.
          if (!supplementOptions?.enabled) {
            this.injectMemoryContext(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
            return;
          }
          if (!supplementTurn || supplementTurn.turn !== this.domainSupplementTurn) return;
          const withheldBaseline = { text: '', route: recalled.route, found: false, status: 'absent' as const };
          await this.deliverWithDomainSupplement(
            latest, withheldBaseline, '', [],
            supplementOptions, supplementTurn, MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE,
          );
          return;
        }
        if (!supplementOptions?.enabled) {
          if (baselineText) this.injectMemoryContext(baselineText, baselineEvidence);
          else if (recalled.route === 'deep' && recalled.status !== 'skipped') {
            this.injectMemoryContext(`${memoryReadNotice(recalled.status)} If you are not sure, say so; do not invent dates, names or past events.`);
          }
          return;
        }
        if (!supplementTurn || supplementTurn.turn !== this.domainSupplementTurn) return;
        await this.deliverWithDomainSupplement(latest, effectiveRecalled, baselineText, baselineEvidence, supplementOptions, supplementTurn);
      } finally {
        // A failure before delivery must not leave the diagnostic surface stuck "in progress".
        if (supplementTurn && this.domainSupplementAbort === supplementTurn.controller) {
          this.domainSupplementAbort = null;
        }
      }
    }

    /** Injects the ordinary baseline exactly as the default-off path would. */
    private injectBaselineMemory(recalled: TurnRecall, baselineText: string, baselineEvidence: EvidenceAttachment[]): void {
      if (recalled.text) this.injectMemoryContext(baselineText, baselineEvidence);
      else if (recalled.route === 'deep' && recalled.status !== 'skipped') {
        this.injectMemoryContext(`${memoryReadNotice(recalled.status)} If you are not sure, say so; do not invent dates, names or past events.`);
      }
    }

    /** Starts the turn that owns the opt-in supplement and retires the previous one. */
    private beginDomainSupplementTurn(): { turn: number; controller: AbortController } {
      const turn = ++this.domainSupplementTurn;
      this.domainSupplementTurnStartedAt = Date.now();
      this.domainSupplementAbort?.abort();
      const controller = new AbortController();
      this.domainSupplementAbort = controller;
      return { turn, controller };
    }

    /**
     * Runs the opt-in domain supplement after the baseline recall proof, then injects once.
     * A per-turn controller and turn counter keep a late query or finalization from leaking
     * into a newer turn. Any failure keeps the ordinary baseline or the incomplete-evidence notice.
     */
    private async deliverWithDomainSupplement(
      query: string,
      recalled: TurnRecall,
      baselineText: string,
      baselineEvidence: EvidenceAttachment[],
      options: DomainSupplementOptions,
      supplementTurn: { turn: number; controller: AbortController },
      baselineWithheldNotice?: string,
    ): Promise<void> {
      const { turn, controller } = supplementTurn;
      if (turn !== this.domainSupplementTurn) return;
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      timer.unref?.();
      const startedAt = Date.now();
      const rssBefore = process.memoryUsage().rss;
      try {
        const outcome = await this.consumeDomainSupplement(query, recalled, baselineText, baselineEvidence, options, controller.signal);
        if (turn !== this.domainSupplementTurn) return;
        const receipt = this.domainSupplementReceipt(startedAt, rssBefore, recalled, outcome);
        this.longTerm?.recordDomainSupplement(receipt);
        this.domainSupplementReceiptTurn = turn;
        this.domainSupplementReceiptAt = receipt.at;
        if (process.env.COOPANION_MEMORY_DIAGNOSTICS === '1') {
          this.core?.log.info(`[memory] domain supplement receipt ${JSON.stringify(receipt)}`);
        }
        if (outcome.kind === 'finalized') {
          const notice = baselineWithheldNotice ? `${baselineWithheldNotice}\n` : '';
          const evidence = notice
            ? outcome.evidence.map((attachment) => ({
              ...attachment,
              segment: {
                ...attachment.segment,
                start: attachment.segment.start + notice.length,
                end: attachment.segment.end + notice.length,
              },
            }))
            : outcome.evidence;
          this.injectMemoryContext(`${notice}${outcome.text}`, evidence);
        } else if (baselineWithheldNotice) {
          this.injectMemoryContext(baselineWithheldNotice);
        } else {
          this.injectBaselineMemory(recalled, baselineText, baselineEvidence);
        }
      } catch (error) {
        if (turn !== this.domainSupplementTurn) return;
        const receipt = this.domainSupplementReceipt(startedAt, rssBefore, recalled, {
          kind: 'fallback', reason: 'exception', result: null,
        });
        this.longTerm?.recordDomainSupplement(receipt);
        this.domainSupplementReceiptTurn = turn;
        this.domainSupplementReceiptAt = receipt.at;
        if (baselineWithheldNotice) this.injectMemoryContext(baselineWithheldNotice);
        else this.injectBaselineMemory(recalled, baselineText, baselineEvidence);
        this.core?.log.warn('[memory] opt-in domain supplement failed', {
          fallbackContext: baselineWithheldNotice ? 'source_evidence_incomplete_notice' : 'ordinary_recall_baseline',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timer);
        if (this.domainSupplementAbort === controller) this.domainSupplementAbort = null;
      }
    }

    private domainSupplementEligibility(
      recalled: TurnRecall,
      baselineEvidence: readonly EvidenceAttachment[],
      bankId: string,
      endpoint: string,
    ): { ok: true } | { ok: false; reason: string } {
      // The ordinary `complete` flag also counts the non-source formatted header, so a
      // non-empty baseline can legitimately carry the incomplete notice. Eligibility for
      // appending checks every traced source segment and its minted attachment instead;
      // the default-off notice behavior itself is unchanged.
      const trace = recalled.trace;
      if (!recalled.text) {
        const ids = [
          ...(trace?.format.sourceSegments.map((segment) => segment.documentId) ?? []),
          ...(trace?.format.includedSourceDocumentIds ?? []),
        ];
        if (recalled.status !== 'absent' || ids.length > 0) {
          return {
            ok: false,
            reason: recalled.status === 'fenced' ? 'baseline_fenced'
              : recalled.status === 'unavailable' ? 'baseline_unavailable'
                : recalled.status === 'incomplete' ? 'baseline_incomplete'
                  : 'baseline_identity_unavailable',
          };
        }
        return { ok: true };
      }
      if (recalled.status !== 'found') return { ok: false, reason: `baseline_${recalled.status}` };
      const segments = trace?.format.sourceSegments ?? [];
      if (!trace || segments.length === 0) return { ok: false, reason: 'baseline_identity_unavailable' };
      if (baselineEvidence.length !== segments.length) return { ok: false, reason: 'baseline_evidence_incomplete' };
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        const attachment = baselineEvidence[index]!;
        if (attachment.bankId !== bankId || attachment.endpoint !== endpoint
          || attachment.documentId !== segment.documentId
          || attachment.segment.start !== segment.start || attachment.segment.end !== segment.end
          || attachment.validationStatus !== 'validated' || attachment.revisionState !== 'current'
          || !attachment.contentDigest || !attachment.validationReceipt
          || createHash('sha256').update(recalled.text.slice(segment.start, segment.end), 'utf8').digest('hex') !== attachment.segment.digest) {
          return { ok: false, reason: 'baseline_evidence_incomplete' };
        }
      }
      return { ok: true };
    }

    /**
     * Captures the S2 result instead of injecting it. Only exactly new segments are
     * finalized through the existing `HindsightMemory.evidenceForSegments()`; the raw S2
     * attachments never reach Core and are only cross-checked against the appended text.
     */
    private async consumeDomainSupplement(
      query: string,
      recalled: TurnRecall,
      baselineText: string,
      baselineEvidence: EvidenceAttachment[],
      options: DomainSupplementOptions,
      signal: AbortSignal,
    ): Promise<DomainSupplementOutcome> {
      const memory = this.longTerm;
      if (!memory) return { kind: 'fallback', reason: 'memory_unavailable', result: null };
      const bankId = memory.bankId();
      const endpoint = memory.endpoint();
      const store = memory.domainStore();
      const provider = memory.domainReadbackProvider();
      const expectedEpoch = memory.evidenceEpoch();
      if (!bankId || !endpoint || !store || !provider || !expectedEpoch) {
        return { kind: 'fallback', reason: 'accessors_unavailable', result: null };
      }
      const eligibility = this.domainSupplementEligibility(recalled, baselineEvidence, bankId, endpoint);
      if (!eligibility.ok) return { kind: 'fallback', reason: eligibility.reason, result: null };
      if (signal.aborted) return { kind: 'fallback', reason: 'cancelled', result: null };

      const deliveries: CoreMemoryConsumption[] = [];
      let result: DomainRelevantConsumeResult;
      try {
        result = await consumeDomainRelevantMemory({
          enabled: true,
          query,
          bankId,
          endpoint,
          store,
          baseline: {
            text: baselineText,
            status: recalled.status,
            ...(recalled.trace ? { trace: recalled.trace } : {}),
            evidence: baselineEvidence,
          },
          search: (text, searchOptions) => memory.searchResultsDetailed(text, {
            ...searchOptions,
            types: [...memory.domainSupplementTypes()],
          }),
          readbackProvider: provider,
          finalReadbackProvider: provider,
          getEvidenceEpoch: () => memory.evidenceEpoch(),
          limits: options.limits,
          signal,
          deliver: (block) => { deliveries.push(block); },
        });
      } catch {
        return {
          kind: 'fallback',
          reason: 'consume_exception',
          result: null,
        };
      }
      if (signal.aborted) return { kind: 'fallback', reason: 'cancelled', result };
      const expectedDeliveryCount = result.text ? 1 : 0;
      if (deliveries.length !== expectedDeliveryCount || result.deliveries !== expectedDeliveryCount) {
        return { kind: 'fallback', reason: 'delivery_count', result };
      }
      if (result.status !== 'supplemented' && result.status !== 'supplemented_partial') {
        return { kind: 'fallback', reason: result.stopReason ?? result.status, result };
      }
      // Only the exact source-excerpt block may reach the Provider. The labelled display text is
      // for receipts; it carries no source proof and would leave the request unmappable.
      const block = deliveries[0]!;
      const core = {
        text: block.coreText ?? '', evidence: block.coreEvidence ?? [], sourceSegments: block.coreSegments ?? [],
      };
      if (!core.text || core.sourceSegments.length !== core.evidence.length) {
        return { kind: 'fallback', reason: 'delivery_mismatch', result };
      }
      if (block.text !== result.text || block.sourceSegments.length !== result.sourceSegments.length) {
        return { kind: 'fallback', reason: 'delivery_mismatch', result };
      }
      if (!baselineSourceExcerpts({
        text: baselineText,
        status: recalled.status,
        ...(recalled.trace ? { trace: recalled.trace } : {}),
      }).every((excerpt) => core.text.includes(excerpt))) {
        return { kind: 'fallback', reason: 'baseline_not_preserved', result };
      }
      if (result.supplement.budget.supplementChars <= 0
        || result.supplement.budget.supplementChars > options.limits.maxSupplementChars) {
        return { kind: 'fallback', reason: 'supplement_budget', result };
      }
      if (result.consumedSources.length === 0 || result.supplement.consumedCount !== result.consumedSources.length) {
        return { kind: 'fallback', reason: 'consumed_source_mismatch', result };
      }

      const tupleKey = (documentId: string) => JSON.stringify([bankId, endpoint, documentId]);
      const baselineTuples = new Set<string>([
        ...(recalled.trace?.format.sourceSegments.map((segment) => tupleKey(segment.documentId)) ?? []),
        ...(recalled.trace?.format.includedSourceDocumentIds.map(tupleKey) ?? []),
      ]);
      const newSegments = core.sourceSegments.filter((segment) => !baselineTuples.has(tupleKey(segment.documentId)));
      if (newSegments.length === 0) return { kind: 'fallback', reason: 'no_new_segments', result };

      const consumedSpans = new Map<string, { contentDigest: string; digest: string; text: string }>();
      for (const source of result.consumedSources) {
        if (source.identity.bankId !== bankId || source.identity.endpoint !== endpoint) {
          return { kind: 'fallback', reason: 'source_namespace_mismatch', result };
        }
        for (const span of source.spans) {
          if (!Number.isInteger(span.start) || !Number.isInteger(span.end)
            || span.start < 0 || span.end <= span.start || span.end > core.text.length
            || core.text.slice(span.start, span.end) !== span.text
            || createHash('sha256').update(span.text, 'utf8').digest('hex') !== span.digest) {
            return { kind: 'fallback', reason: 'supplement_span_mismatch', result };
          }
          const key = `${tupleKey(source.identity.documentId)}\u0000${span.start}\u0000${span.end}`;
          if (consumedSpans.has(key)) return { kind: 'fallback', reason: 'duplicate_supplement_span', result };
          consumedSpans.set(key, { contentDigest: source.contentDigest, digest: span.digest, text: span.text });
        }
      }
      if (consumedSpans.size !== newSegments.length) return { kind: 'fallback', reason: 'segment_count_mismatch', result };

      for (const segment of newSegments) {
        if (!segment.documentId || !Number.isInteger(segment.start) || !Number.isInteger(segment.end)
          || segment.start < 0 || segment.end <= segment.start || segment.end > core.text.length) {
          return { kind: 'fallback', reason: 'supplement_segment_invalid', result };
        }
        const key = `${tupleKey(segment.documentId)}\u0000${segment.start}\u0000${segment.end}`;
        const span = consumedSpans.get(key);
        const text = core.text.slice(segment.start, segment.end);
        if (!span || span.text !== text
          || createHash('sha256').update(text, 'utf8').digest('hex') !== span.digest) {
          return { kind: 'fallback', reason: 'segment_span_mismatch', result };
        }
        const raw = core.evidence.find((attachment) => attachment.bankId === bankId
          && attachment.endpoint === endpoint
          && attachment.documentId === segment.documentId
          && attachment.segment.start === segment.start
          && attachment.segment.end === segment.end);
        if (!raw || raw.validationStatus !== 'validated' || raw.revisionState !== 'current'
          || raw.validatedEpoch !== expectedEpoch || !raw.validationReceipt
          || raw.contentDigest !== span.contentDigest || raw.segment.digest !== span.digest) {
          return { kind: 'fallback', reason: 'raw_attachment_mismatch', result };
        }
      }

      const finalized: EvidenceAttachment[] | null = await this.awaitDomainSupplementReadback(
        memory.evidenceForSegments(core.text, newSegments),
        signal,
      );
      if (!finalized) return { kind: 'fallback', reason: 'cancelled', result };
      if (finalized.length !== newSegments.length) return { kind: 'fallback', reason: 'finalize_incomplete', result };
      for (let index = 0; index < newSegments.length; index += 1) {
        const segment = newSegments[index]!;
        const attachment = finalized[index]!;
        const proof = attachment.segment.sourceProof;
        const segmentDigest = createHash('sha256').update(core.text.slice(segment.start, segment.end), 'utf8').digest('hex');
        if (attachment.bankId !== bankId || attachment.endpoint !== endpoint
          || attachment.documentId !== segment.documentId
          || attachment.segment.start !== segment.start || attachment.segment.end !== segment.end
          || attachment.segment.digest !== segmentDigest
          || attachment.validatedEpoch !== expectedEpoch
          || attachment.validationStatus !== 'validated' || attachment.revisionState !== 'current'
          || !/^[a-f0-9]{64}$/.test(attachment.contentDigest) || !attachment.validationReceipt
          || !proof || typeof proof.token !== 'string' || proof.token.length === 0
          || proof.startUtf16 !== 0 || proof.endUtf16 !== segment.end - segment.start) {
          return { kind: 'fallback', reason: 'finalize_invalid', result };
        }
      }
      if (signal.aborted) return { kind: 'fallback', reason: 'cancelled', result };
      if (memory.evidenceEpoch() !== expectedEpoch) return { kind: 'fallback', reason: 'epoch_changed', result };
      return {
        kind: 'finalized',
        text: core.text,
        evidence: [...finalized],
        segments: newSegments,
        result,
      };
    }

    /**
     * Stops waiting for a readback when the turn is cancelled. The in-flight read may still
     * settle, but its result is discarded and cannot be injected into a newer turn.
     */
    private awaitDomainSupplementReadback<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
      if (signal.aborted) return Promise.resolve(null);
      return new Promise<T | null>((resolvePromise) => {
        let settled = false;
        const finish = (value: T | null) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolvePromise(value);
        };
        const onAbort = () => finish(null);
        signal.addEventListener('abort', onAbort, { once: true });
        work.then((value) => finish(value), () => finish(null));
      });
    }

    private domainSupplementReceipt(
      startedAt: number,
      rssBefore: number,
      recalled: TurnRecall,
      outcome: DomainSupplementOutcome,
    ): DomainSupplementReceipt {
      const result = outcome.result;
      const supplement = result?.supplement;
      return {
        at: new Date().toISOString(),
        enabled: true,
        status: outcome.kind === 'finalized' ? 'finalized'
          : supplement?.queried ? 'fallback' : 'skipped',
        fallbackReason: outcome.kind === 'finalized' ? null : outcome.reason,
        baselineStatus: recalled.status,
        queryHash: supplement?.queryHash ?? null,
        candidateCount: supplement?.candidateCount ?? 0,
        verifiedCount: supplement?.verifiedCount ?? 0,
        consumedCount: supplement?.consumedCount ?? 0,
        addedSourceCount: result?.addedSourceTuples.length ?? 0,
        withheldCount: supplement?.withheldCount ?? 0,
        fallbackCount: supplement?.fallbackCount ?? 0,
        finalizedSegmentCount: outcome.kind === 'finalized' ? outcome.segments.length : 0,
        queryCalls: supplement?.budget.queryCalls ?? 0,
        readbackCalls: supplement?.budget.readbackCalls ?? 0,
        finalReadbackCalls: supplement?.budget.finalReadbackCalls ?? 0,
        supplementalChars: supplement?.budget.supplementChars ?? 0,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
      };
    }

    private handoffIsProtected(snapshot: readonly ContextRecord[]): boolean {
      if (this.memoryContextBlocks.size > 0) return true;
      if (snapshot.some((record) => record.context.frame?.events.some((event) => event.type === HANDOFF_NOTE_TYPE))) return true;
      if (snapshot.some((record) => (record.context.evidence?.length ?? 0) > 0)) return true;
      if (snapshot.some((record) => record.item.type === 'function_call'
        && (MEMORY_TOOL_NAMES.has(record.item.name) || WORKSPACE_READ_PATHS[record.item.name] !== undefined))) return true;
      return false;
    }

    private handoffSnapshot(snapshot: ContextRecord[], sourceEvidence: ContextEvidenceInspection): {
      records: ContextRecord[];
      sourceExcerpts: ContextHandoffSourceExcerpt[];
    } {
      const memory = this.longTerm;
      const coverage = new Map(sourceEvidence.items.map((item) => [item.itemId, item]));
      const fenced = (event: NonNullable<ContextRecord['context']['frame']>['events'][number]): boolean => {
        if (event.source !== 'desktop-pet') return false;
        const documentId = event.type === 'desktop-pet.touch'
          ? `touch:main:${event.cursor}`
          : ['desktop-pet.message', 'desktop-pet.speech', 'desktop-pet.answer'].includes(event.type)
            ? `user:main:${event.cursor}`
            : null;
        return documentId ? memory?.sourceFenced(documentId) === true : false;
      };
      const validSpan = (text: string, span: { start: number; end: number; digest: string }): boolean =>
        Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start
        && span.end <= text.length && /^[a-f0-9]{64}$/.test(span.digest)
        && createHash('sha256').update(text.slice(span.start, span.end), 'utf8').digest('hex') === span.digest;
      const safeRecord = (record: ContextRecord): ContextRecord | null => {
        const itemCoverage = record.item.id ? coverage.get(record.item.id) : undefined;
        if (!itemCoverage || !record.item.id) return null;
        if (record.item.type === 'function_call') {
          return itemCoverage.mappingState === 'complete' && itemCoverage.disposition !== 'unknown-derived-incomplete' ? record : null;
        }
        if (record.item.type !== 'message' && record.item.type !== 'function_call_output') {
          return itemCoverage.mappingState === 'complete' && itemCoverage.disposition !== 'unknown-derived-incomplete' ? record : null;
        }
        const text = textOf(record);
        const evidence = (record.context.evidence ?? []).filter((attachment) => {
          const { start, end } = attachment.segment;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return false;
          if (!memory?.sourceVisible(attachment.documentId) || !memory.sourceCurrentForContext(attachment.documentId)) return false;
          const segment = text.slice(start, end);
          return evidenceCoversText(segment, [{ ...attachment, segment: { start: 0, end: segment.length, digest: attachment.segment.digest } }]);
        });
        const independent = (record.context.sourceIndependentSpans ?? []).filter((span) => validSpan(text, span)
          && !((record.context.frame?.events ?? []).some((event) => fenced(event)
            && event.start < span.end && event.start + event.chars > span.start)));
        const dependencies = (record.context.sourceDependencySpans ?? []).filter((span) => validSpan(text, span)
          && itemCoverage.spans.some((covered) => covered.start === span.start && covered.end === span.end
            && covered.digest === span.digest && covered.origin === 'generation-derived' && covered.mappingState === 'complete'
            && covered.generationEvidenceId === span.proofId)
          && span.exposedSources.every((source) => memory?.sourceVisible(source.documentId)
            && memory.sourceCurrentForContext(source.documentId)));
        const sourceMaps = (record.context.sourceMapSpans ?? []).filter((span) => validSpan(text, span)
          && span.origin !== 'unknown-derived'
          && (span.origin === 'core-generated' || span.origin === 'user-input' || span.origin === 'user-config'
            ? !span.exposedSources?.length
            : (span.exposedSources?.length ?? 0) > 0
              && span.exposedSources!.every((source) => memory?.sourceVisible(source.documentId)
                && memory.sourceCurrentForContext(source.documentId))));
        const safeRanges = [
          ...evidence.map((attachment) => ({ start: attachment.segment.start, end: attachment.segment.end })),
          ...independent.map((span) => ({ start: span.start, end: span.end })),
          ...dependencies.map((span) => ({ start: span.start, end: span.end })),
          ...sourceMaps.map((span) => ({ start: span.start, end: span.end })),
        ];
        const safe = new Uint8Array(text.length);
        for (const range of safeRanges) for (let at = range.start; at < range.end; at++) safe[at] = 1;
        const redacted = Array.from({ length: text.length }, (_, at) => safe[at] || /\s/u.test(text[at]!) ? text[at]! : ' ').join('');
        if (!redacted.trim()) return null;
        const frameEvents = record.context.frame?.events.filter((event) =>
          safeRanges.some((range) => range.start <= event.start && range.end >= event.start + event.chars) && !fenced(event));
        const changed = redacted !== text || evidence.length !== (record.context.evidence?.length ?? 0)
          || independent.length !== (record.context.sourceIndependentSpans?.length ?? 0)
          || dependencies.length !== (record.context.sourceDependencySpans?.length ?? 0)
          || sourceMaps.length !== (record.context.sourceMapSpans?.length ?? 0)
          || (frameEvents?.length ?? 0) !== (record.context.frame?.events.length ?? 0);
        if (!changed) return record;
        const updated = withText(record, redacted);
        updated.context = {
          ...record.context,
          evidence,
          sourceIndependentSpans: independent,
          sourceDependencySpans: dependencies,
          sourceMapSpans: sourceMaps,
          ...(record.context.frame ? { frame: { ...record.context.frame, events: frameEvents ?? [] } } : {}),
        };
        return updated;
      };
      const processed = snapshot.flatMap((record) => {
        const safe = safeRecord(record);
        return safe ? [safe] : [];
      });
      const outputIds = new Set(processed.flatMap((record) => record.item.type === 'function_call_output' ? [record.item.call_id] : []));
      const callIds = new Set(processed.flatMap((record) => record.item.type === 'function_call' ? [record.item.call_id] : []));
      const existingOutputs = new Set(snapshot.flatMap((record) => record.item.type === 'function_call_output' ? [record.item.call_id] : []));
      const sourceExcerpts = processed.flatMap((record) => {
        if (record.item.type !== 'function_call_output' || callIds.has(record.item.call_id) || !record.item.id) return [];
        return (record.context.evidence ?? []).map((attachment) => ({ sourceRecordId: record.item.id!, attachment }));
      });
      const records = processed.filter((record) => record.item.type === 'function_call_output'
        ? callIds.has(record.item.call_id)
        : record.item.type === 'function_call' && existingOutputs.has(record.item.call_id)
          ? outputIds.has(record.item.call_id)
          : true);
      return { records, sourceExcerpts };
    }

    /**
     * Exact source slices that stay independently verifiable after a sibling source is forgotten.
     * Only whole candidate evidence spans and whole carried note parts qualify; each part keeps
     * one source tuple so Core can re-read and verify it on its own.
     */
    private handoffExcerptParts(
      records: readonly ContextRecord[],
      sourceExcerpts: readonly ContextHandoffSourceExcerpt[],
      evidence: ContextEvidenceInspection,
      sourceById: ReadonlyMap<string, ContextRecord>,
      includeEvidenceExcerpts: boolean,
    ): Array<{ text: string; source: SourceExposureRef }> {
      const candidates: Array<{ text: string; source: SourceExposureRef; order: number }> = [];
      let order = 0;
      const sourceKeyOf = (source: SourceExposureRef): string => JSON.stringify([
        source.bankId, source.endpoint, source.documentId, source.contentDigest,
      ]);
      const currentSource = (source: SourceExposureRef): SourceExposureRef | null =>
        evidence.exposedSources.find(candidate => sourceKeyOf(candidate) === sourceKeyOf(source)) ?? null;
      const textByItemId = new Map<string, string>();
      for (const record of records) if (record.item.id) textByItemId.set(record.item.id, textOf(record));

      // A previously delivered raw excerpt is present as a note event whose dependency span
      // covers exactly that event. Rendered note sections start with a header and are not
      // carried this way; their still-current content is rebuilt from the current snapshot.
      for (const record of records) {
        for (const event of record.context.frame?.events ?? []) {
          if (event.type !== HANDOFF_NOTE_TYPE) continue;
          const text = textOf(record).slice(event.start, event.start + event.chars);
          if (!text.trim() || text.startsWith('# ')) continue;
          const span = (record.context.sourceDependencySpans ?? []).find(entry =>
            entry.start === event.start && entry.end === event.start + event.chars
            && entry.exposedSources.length === 1 && entry.digest === sha256(text));
          if (!span) continue;
          const source = currentSource(span.exposedSources[0]!);
          if (!source) continue;
          candidates.push({ text, source, order: order++ });
        }
      }

      if (includeEvidenceExcerpts) {
        // Tool receipts carry read-back attachments as Core-verified hindsight-source spans.
        for (const item of evidence.items) {
          const text = textByItemId.get(item.itemId);
          if (!text) continue;
          for (const span of item.spans) {
            if (span.origin !== 'hindsight-source' || span.mappingState !== 'complete') continue;
            if (span.exposedSources.length !== 1) continue;
            if (span.start < 0 || span.end <= span.start || span.end > text.length) continue;
            const part = text.slice(span.start, span.end);
            if (!part.trim() || part.length > 4096 || sha256(part) !== span.digest) continue;
            const source = currentSource(span.exposedSources[0]!);
            if (!source) continue;
            candidates.push({ text: part, source, order: order++ });
          }
        }

        // An unpaired tool receipt is represented by its sourceExcerpts instead of a record.
        for (const excerpt of sourceExcerpts) {
          const sourceRecord = sourceById.get(excerpt.sourceRecordId);
          if (!sourceRecord) continue;
          const sourceText = textOf(sourceRecord);
          const { start, end, digest } = excerpt.attachment.segment;
          if (start < 0 || end <= start || end > sourceText.length) continue;
          const part = sourceText.slice(start, end);
          if (!part.trim() || part.length > 4096 || sha256(part) !== digest) continue;
          const { segment: _segment, ...attachmentSource } = excerpt.attachment;
          const source = currentSource(attachmentSource);
          if (!source) continue;
          candidates.push({ text: part, source, order: order++ });
        }
      }

      const best = new Map<string, { text: string; source: SourceExposureRef; order: number }>();
      for (const candidate of candidates.sort((left, right) => right.text.length - left.text.length || left.order - right.order)) {
        const key = sourceKeyOf(candidate.source);
        if (!best.has(key)) best.set(key, candidate);
      }
      return [...best.values()].slice(0, 4).map(({ text, source }) => ({ text, source }));
    }

    /**
     * Keeps the newest Core-framed, source-independent user event pair across a handoff.
     * The pair is the synthetic external_event_frame call and its output; Core's fixPairing
     * drops an orphaned output, and reusing both records leaves the original cursor and
     * user-input span intact without replaying the event.
     */
    protected override handoffTail(snapshot: ContextRecord[], afterCursor?: number): ContextRecord[] {
      let latest: { call: ContextRecord; output: ContextRecord } | null = null;
      for (let index = 0; index < snapshot.length; index++) {
        const output = snapshot[index];
        if (output.item.type !== 'function_call_output') continue;
        const callId = output.item.call_id;
        if (output.context.evidence?.length || output.context.sourceDependencySpans?.length
          || output.context.sourceMapSpans?.length) continue;
        const events = output.context.frame?.events;
        if (!events || events.length !== 1) continue;
        const event = events[0];
        if (event.type !== 'desktop-pet.message' || event.source !== 'desktop-pet') continue;
        if (!Number.isInteger(event.cursor) || event.cursor < 0
          || (afterCursor !== undefined && event.cursor <= afterCursor)
          || !Number.isInteger(event.start) || event.start < 0
          || !Number.isInteger(event.chars) || event.chars <= 0) continue;
        const text = textOf(output);
        const end = event.start + event.chars;
        if (end > text.length) continue;
        const digest = sha256(text.slice(event.start, end));
        const independent = output.context.sourceIndependentSpans?.some((span) =>
          span.origin === 'user-input' && span.start === event.start && span.end === end && span.digest === digest);
        if (!independent) continue;
        const call = snapshot.slice(0, index).reverse().find((record) =>
          record.item.type === 'function_call' && record.item.call_id === callId);
        if (!call || call.item.type !== 'function_call' || call.item.name !== EXTERNAL_EVENT_FRAME
          || !call.context.sourceIndependentItemDigest) continue;
        latest = { call, output };
      }
      return latest ? [latest.call, latest.output] : [];
    }

    private removeOwnedHandoffFile(path: string, owner: HandoffFileOwner, digest: string): boolean {
      if (!handoffFileMatches(path, owner, digest)) return false;
      try {
        unlinkSync(path);
        try { syncDirectory(dirname(path)); } catch { /* The removed name is still withheld if the directory could not be synced. */ }
        return true;
      } catch {
        return false;
      }
    }

    /** Reconciles only Handoff files whose SQLite row, inode owner and body digest match. */
    private async recoverHandoffFiles(): Promise<void> {
      const memory = this.longTerm;
      if (!memory) return;
      const root = resolve(this.memoryDir);
      const handoffPath = join(root, HANDOFF_DIR);
      const stagingPath = join(handoffPath, '.staging');
      for (const artifact of memory.listHandoffArtifacts()) {
        const owner = handoffOwner(artifact);
        if (!owner || !artifact.target.startsWith(HANDOFF_DIR)) continue;
        const filename = basename(artifact.target);
        if (artifact.target !== `${HANDOFF_DIR}${filename}` || !filename.endsWith('.md')) continue;
        const finalPath = resolve(root, artifact.target);
        if (!insidePath(root, finalPath)) continue;
        const stagePath = join(stagingPath, owner.stagedName);
        const stageMatches = handoffFileMatches(stagePath, owner, artifact.bodyDigest);
        let finalMatches = handoffFileMatches(finalPath, owner, artifact.bodyDigest);

        if (artifact.lifecycleState === 'pending') {
          if (!stageMatches && !finalMatches) {
            memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-candidate-file-unavailable');
            continue;
          }
          let content: string;
          try {
            content = readFileSync(finalMatches ? finalPath : stagePath, 'utf8');
          } catch {
            continue;
          }
          if (!await memory.verifyPendingHandoffArtifact(artifact.artifactId, artifact.creatorOperationId!, content)) continue;
          finalMatches = handoffFileMatches(finalPath, owner, artifact.bodyDigest);
          if (!finalMatches) {
            if (existsSync(finalPath)) {
              memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-target-owned-elsewhere');
              this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
              continue;
            }
            if (!handoffFileMatches(stagePath, owner, artifact.bodyDigest)) continue;
            try {
              linkSync(stagePath, finalPath);
            } catch {
              continue;
            }
          }
          try {
            syncDirectory(handoffPath);
          } catch {
            continue;
          }
          if (!handoffFileMatches(finalPath, owner, artifact.bodyDigest)) {
            memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-file-changed-during-recovery');
            this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
            continue;
          }
          const activated = memory.activateHandoffArtifact(artifact.artifactId, artifact.creatorOperationId!);
          if (activated) {
            if (!handoffFileMatches(finalPath, owner, artifact.bodyDigest)) {
              memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-file-changed-during-activation');
              this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
              continue;
            }
            this.lastHandoffFile = artifact.target;
            this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
          } else if (memory.derivedArtifact(artifact.artifactId)?.lifecycleState !== 'pending') {
            this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
          }
          continue;
        }

        if (artifact.lifecycleState === 'active') {
          if (finalMatches) {
            this.lastHandoffFile = artifact.target;
            if (stageMatches) this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
          } else {
            memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-active-file-changed-or-missing');
            if (stageMatches) this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
          }
          continue;
        }

        if (stageMatches) this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
      }
    }

    async prepareHandoff(snapshot: ContextRecord[], ctx: ContextHandoffPrepareContext): Promise<PreparedContextHandoff> {
      const reset = this.pendingForgottenHandoffReset;
      if (reset?.phase === 'reset-ready') {
        if (reset.expectedGeneration === ctx.expectedGeneration) {
          reset.resetCandidateSnapshotId = ctx.candidateSnapshotId;
          return this.prepareForgottenContextReset(snapshot, ctx, reset);
        }
        this.pendingForgottenHandoffReset = null;
      }
      await this.recoverHandoffFiles();
      const memory = this.longTerm;
      const rebuild = this.pendingCleanHandoffRebuild;
      const protectedSnapshot = this.handoffIsProtected(snapshot);
      const expectedMemoryEpoch = rebuild?.expectedEpoch ?? memory?.evidenceEpoch() ?? null;
      const cleanExcerpts = rebuild ? this.cleanHandoffSourceExcerpts(snapshot, rebuild) : null;
      if (rebuild && (!memory || memory.evidenceEpoch() !== rebuild.expectedEpoch || !cleanExcerpts)) {
        return {
          result: { tail: [] },
          protected: true,
          discard: () => { if (this.pendingCleanHandoffRebuild === rebuild) this.pendingCleanHandoffRebuild = null; },
        };
      }
      const filtered: { records: ContextRecord[]; sourceExcerpts: ContextHandoffSourceExcerpt[] } = rebuild
        ? { records: [], sourceExcerpts: cleanExcerpts! }
        : this.handoffSnapshot(snapshot, ctx.sourceEvidence);
      const candidateEvidence = ctx.inspectCandidate(filtered.records, filtered.sourceExcerpts);
      const memorySourcesVerified = !!memory && !!expectedMemoryEpoch && candidateEvidence.mappingState === 'complete'
        && candidateEvidence.exposedSources.length > 0
        && await memory.verifyExposureSources(candidateEvidence.exposedSources, expectedMemoryEpoch);

      const sourceFree = filtered.records.length + filtered.sourceExcerpts.length > 0
        && candidateEvidence.mappingState === 'complete'
        && candidateEvidence.exposedSources.length === 0;
      const protectedHandoff = protectedSnapshot || filtered.records.length !== ctx.sourceEvidence.items.length
        || filtered.sourceExcerpts.length > 0 || candidateEvidence.exposedSources.length > 0;
      const now = new Date();
      const { maxTokens, keepRatio } = this.context();
      const sourceById = new Map(snapshot.flatMap((record) => record.item.id ? [[record.item.id, record] as const] : []));
      const excerptRecords = filtered.sourceExcerpts.flatMap((excerpt) => {
        const source = sourceById.get(excerpt.sourceRecordId);
        if (!source) return [];
        const text = textOf(source).slice(excerpt.attachment.segment.start, excerpt.attachment.segment.end);
        if (!text) return [];
        return [message('user', text, {
          ...(source.context.ts ? { ts: source.context.ts } : {}),
          evidence: [{ ...excerpt.attachment, segment: { ...excerpt.attachment.segment, start: 0, end: text.length, digest: excerpt.attachment.segment.digest } }],
        })];
      });
      const noteSnapshot = [...filtered.records, ...excerptRecords];
      // Workspace reads are task material, not history. Their bodies can be large and are
      // often folded; keeping them in a handoff note leaves truncated text that cannot be
      // source-mapped, which would close the next Provider request. The files stay on disk and
      // can be read again; the note keeps the event and the call, not the file body.
      const handoffFlowTools = new Set<string>([
        ...(this.core?.toolsTagged('flow') ?? new Set<string>()),
        'read_file', 'list_files', 'glob_files', 'grep_files',
        'memory_search', 'memory_remember', 'memory_correct', 'memory_forget', 'memory_reflect',
      ]);
      const note = renderHandoffNote(noteSnapshot, {
        speechTools: this.core?.toolsTagged('speak') ?? new Set<string>(),
        flowTools: handoffFlowTools,
        snapshotTools: this.core?.toolsTagged('snapshot') ?? new Set<string>(),
        now,
        budgetTokens: Math.floor(maxTokens * keepRatio),
        splitAtMs: this.pressureSplitAt,
      });
      const excerptParts = this.handoffExcerptParts(filtered.records, filtered.sourceExcerpts, candidateEvidence, sourceById,
        candidateEvidence.exposedSources.length > 1);
      const noteParts: Array<{ text: string; sourceDependencies: SourceExposureRef[] }> = note.parts.map((part) => ({
        text: part.text,
        sourceDependencies: candidateEvidence.exposedSources,
      }));
      if (excerptParts.length > 0) {
        noteParts.push({ text: '# 原文摘录（逐段来源）\n', sourceDependencies: candidateEvidence.exposedSources });
        for (const excerpt of excerptParts) noteParts.push({ text: excerpt.text, sourceDependencies: [excerpt.source] });
      }
      const noteText = noteParts.map((part) => part.text).join('\n');
      const handoffPath = join(this.memoryDir, HANDOFF_DIR);
      const stagingPath = join(handoffPath, '.staging');
      let ownsHandoffDirectory = false;
      let ownsStagingDirectory = false;
      let stageIdentity: { dev: number; ino: number } | null = null;
      let finalPath: string | null = null;
      let finalIdentity: { dev: number; ino: number } | null = null;
      let committedFile: string | null = null;
      let fileOwner: HandoffFileOwner | null = null;
      const noteDigest = sha256(noteText);
      const stem = handoffNoteStamp(now);
      let plannedFilename: string | null = null;
      for (let suffix = 0; suffix < 100; suffix++) {
        const filename = `${stem}${suffix === 0 ? '' : `-${suffix}`}.md`;
        if (!existsSync(join(handoffPath, filename))) { plannedFilename = filename; break; }
      }
      if (!plannedFilename) throw new Error('no unused handoff filename is available');
      const plannedFile = `${HANDOFF_DIR}${plannedFilename}`;
      const handoffArtifactId = `handoff:${sha256(JSON.stringify([ctx.sessionId, ctx.candidateSnapshotId, plannedFilename]))}`;
      const handoffSegmentDigests = new Map<string, string>();
      const sourceSegmentDigests = new Map<string, string[]>();
      for (const item of candidateEvidence.items) for (const span of item.spans) for (const source of span.exposedSources) {
        const key = JSON.stringify([source.bankId, source.endpoint, source.documentId]);
        const digests = sourceSegmentDigests.get(key) ?? [];
        digests.push(span.digest);
        sourceSegmentDigests.set(key, digests);
      }
      for (const source of candidateEvidence.exposedSources) {
        const key = JSON.stringify([source.bankId, source.endpoint, source.documentId]);
        const digests = sourceSegmentDigests.get(key) ?? [];
        if (digests.length > 0) handoffSegmentDigests.set(key, sha256(JSON.stringify([...digests].sort())));
      }
      const persona = this;
      const previousHandoffFile = this.lastHandoffFile;
      const previousPressureWarned = this.pressureWarned;
      const previousPressureSplitAt = this.pressureSplitAt;
      const previousMemoryContextBlocks = [...this.memoryContextBlocks];
      const stagePath = join(stagingPath, `${randomUUID()}.md`);
      const stageName = basename(stagePath);
      const makeDirectory = (path: string): boolean => {
        try {
          mkdirSync(path, { mode: 0o700 });
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !statSync(path).isDirectory()) throw error;
          return false;
        }
      };
      const removeOwnedFile = (path: string | null, identity: { dev: number; ino: number } | null): boolean => {
        if (!path || !identity || !fileOwner || !handoffFileMatches(path, fileOwner, noteDigest)) return false;
        try {
          unlinkSync(path);
          try { syncDirectory(dirname(path)); } catch { /* The removed name stays withheld if its directory could not be synced. */ }
          return true;
        } catch {
          return false;
        }
      };
      const cleanupStage = (): void => {
        const removed = removeOwnedFile(stagePath, stageIdentity);
        stageIdentity = null;
        if (removed) {
          try { syncDirectory(stagingPath); } catch { /* Recovery can remove the owned name on the next run. */ }
        }
        if (ownsStagingDirectory) {
          try { rmdirSync(stagingPath); } catch { /* Keep a directory that now contains another entry. */ }
          ownsStagingDirectory = false;
        }
      };
      const cleanupOwnedDirs = (): void => {
        if (ownsStagingDirectory) {
          try { rmdirSync(stagingPath); } catch { /* Keep a directory that now contains another entry. */ }
          ownsStagingDirectory = false;
        }
        if (ownsHandoffDirectory) {
          try { rmdirSync(handoffPath); } catch { /* Keep a directory that now contains another entry. */ }
          ownsHandoffDirectory = false;
        }
      };

      let fd: number | null = null;
      try {
        ownsHandoffDirectory = makeDirectory(handoffPath);
        ownsStagingDirectory = makeDirectory(stagingPath);
        fd = openSync(stagePath, 'wx', 0o600);
        const opened = fstatSync(fd);
        stageIdentity = { dev: opened.dev, ino: opened.ino };
        fileOwner = { artifactId: handoffArtifactId, device: opened.dev, inode: opened.ino, stagedName: stageName };
        writeFileSync(fd, noteText, { encoding: 'utf8' });
        fsyncSync(fd);
        const closingFd = fd;
        fd = null;
        closeSync(closingFd);
        syncDirectory(stagingPath);
        if (ownsStagingDirectory) syncDirectory(handoffPath);
        if (ownsHandoffDirectory) syncDirectory(dirname(handoffPath));
      } catch (error) {
        if (fd !== null) {
          const closingFd = fd;
          fd = null;
          try { closeSync(closingFd); } catch { /* Preserve the write error. */ }
        }
        cleanupStage();
        cleanupOwnedDirs();
        throw error;
      }

      if (rebuild && (!memory || !expectedMemoryEpoch
        || !await memory.verifyExposureSources(candidateEvidence.exposedSources, expectedMemoryEpoch)
        || memory.evidenceEpoch() !== expectedMemoryEpoch)) {
        cleanupStage();
        cleanupOwnedDirs();
        return {
          result: { tail: [] },
          protected: true,
          discard: () => { if (this.pendingCleanHandoffRebuild === rebuild) this.pendingCleanHandoffRebuild = null; },
        };
      }

      const commitGuard = (): HandoffCommitCheck => {
        const generation = this.core?.sessionInfo(ctx.sessionId).generation;
        if (!generation || generation.status !== 'current' || generation.token !== ctx.expectedGeneration) {
          return { status: 'stale', reason: 'generation-changed' };
        }
        if (rebuild) {
          const expectedSources = rebuild.sourceRefs.map(handoffSourceProofIdentity).sort().join('\n');
          const candidateSources = candidateEvidence.exposedSources.map(handoffSourceProofIdentity).sort().join('\n');
          if (this.pendingCleanHandoffRebuild !== rebuild || !memory
            || memory.evidenceEpoch() !== rebuild.expectedEpoch || expectedMemoryEpoch !== rebuild.expectedEpoch
            || expectedSources !== candidateSources || !memory.sourceExposureCurrent(candidateEvidence.exposedSources)
            || !this.cleanHandoffSourceExcerpts(snapshot, rebuild)) {
            return { status: 'blocked', reason: 'clean-handoff-source-proof-changed' };
          }
        }
        if (!stageIdentity || !fileOwner || !handoffFileMatches(stagePath, fileOwner, noteDigest)) {
          return { status: 'blocked', reason: 'staged-candidate-changed' };
        }
        if (existsSync(join(handoffPath, plannedFilename!))) return { status: 'blocked', reason: 'handoff-target-owned-elsewhere' };
        if (candidateEvidence.mappingState !== 'complete') {
          return { status: 'blocked', reason: 'candidate-source-mapping-incomplete' };
        }
        if (ctx.sourceEvidence.exposedSources.length > 0
          && (!memory || !expectedMemoryEpoch || !memory.enabled() || !memory.settled()
            || memory.evidenceEpoch() !== expectedMemoryEpoch
            || ctx.sourceEvidence.exposedSources.some((source) => !memory.sourceVisible(source.documentId)
              || !memory.sourceCurrentForContext(source.documentId)))) {
          this.signalForgottenHandoffBlocked(ctx);
          return { status: 'blocked', reason: 'original-memory-source-dependency-unverified' };
        }
        if (candidateEvidence.exposedSources.length > 0) {
          if (!memory || !expectedMemoryEpoch || !memorySourcesVerified || !memory.enabled() || !memory.settled()
            || memory.evidenceEpoch() !== expectedMemoryEpoch
            || candidateEvidence.exposedSources.some((source) => !memory.sourceVisible(source.documentId)
              || !memory.sourceCurrentForContext(source.documentId))) {
            return { status: 'blocked', reason: 'memory-source-dependency-unverified' };
          }
        } else if (!sourceFree) {
          return { status: 'blocked', reason: 'source-free-dependency-unproven' };
        }
        return { status: 'allow' };
      };
      const publish = (): void => {
        if (committedFile) throw new Error('handoff candidate was already committed');
        if (!stageIdentity) throw new Error('handoff candidate ownership was lost');
        const candidate = join(handoffPath, plannedFilename!);
        linkSync(stagePath, candidate);
        finalPath = candidate;
        const linkedIdentity = { ...stageIdentity };
        finalIdentity = linkedIdentity;
        if (!fileOwner || !handoffFileMatches(candidate, fileOwner, noteDigest)) throw new Error('published handoff identity changed');
        syncDirectory(handoffPath);
        committedFile = plannedFile;
        this.lastHandoffFile = committedFile;
        this.pressureWarned = false;
        this.pressureSplitAt = null;
        this.memoryContextBlocks.clear();
      };
      const commit = (): void => {
        if (committedFile) throw new Error('handoff candidate was already committed');
        if (!memory || !memory.enabled()) {
          if (!sourceFree || candidateEvidence.exposedSources.length > 0) throw new Error('Memory provenance is unavailable for this handoff');
          publish();
          cleanupStage();
          return;
        }
        if (!expectedMemoryEpoch || !stageIdentity || !fileOwner) throw new Error('Memory epoch or staged owner is unavailable for this handoff');
        const ownerToken = handoffOwnerToken(handoffArtifactId, stageIdentity, stageName);
        const stored = memory.commitHandoffArtifact({
          artifactId: handoffArtifactId,
          ownerToken,
          target: plannedFile,
          content: noteText,
          expectedEpoch: expectedMemoryEpoch,
          mappingState: sourceFree ? 'source-independent' : 'complete',
          sources: candidateEvidence.exposedSources,
          segmentDigests: handoffSegmentDigests,
        });
        if (!stored) throw new Error('Handoff provenance could not be committed with the candidate.');
        publish();
        const active = memory.activateHandoffArtifact(handoffArtifactId, ownerToken);
        if (!active) throw new Error('Handoff provenance changed before file activation.');
        if (!fileOwner || !handoffFileMatches(finalPath!, fileOwner, noteDigest)) {
          memory.withdrawDerivedArtifact(handoffArtifactId, 'handoff-file-changed-during-activation');
          throw new Error('Handoff file changed before provenance activation completed.');
        }
        cleanupStage();
        if (rebuild && persona.pendingCleanHandoffRebuild === rebuild) persona.pendingCleanHandoffRebuild = null;
      };
      const discard = (): void => {
        if (rebuild && persona.pendingCleanHandoffRebuild === rebuild) persona.pendingCleanHandoffRebuild = null;
        removeOwnedFile(finalPath, finalIdentity);
        memory?.withdrawDerivedArtifact(handoffArtifactId, 'handoff-candidate-discarded');
        finalPath = null;
        finalIdentity = null;
        committedFile = null;
        this.lastHandoffFile = previousHandoffFile;
        this.pressureWarned = previousPressureWarned;
        this.pressureSplitAt = previousPressureSplitAt;
        this.memoryContextBlocks.clear();
        for (const block of previousMemoryContextBlocks) this.memoryContextBlocks.add(block);
        cleanupStage();
        cleanupOwnedDirs();
      };

      return {
        result: { tail: rebuild ? this.handoffTail(snapshot) : this.handoffTail(filtered.records) },
        candidate: {
          snapshotId: ctx.candidateSnapshotId,
          records: filtered.records,
          sourceExcerpts: filtered.sourceExcerpts,
          content: noteText,
          injections: noteParts.map((part) => ({
            origin: 'external' as const,
            kind: HANDOFF_NOTE_TYPE,
            text: part.text,
            sourceDependencies: part.sourceDependencies,
          })),
        },
        ...(protectedHandoff ? { protected: true as const } : {}),
        commitGuard,
        commit,
        discard,
        injections: [
          { origin: 'internal' as const, kind: 'handoff', text: persona.handoffNoteAt(plannedFile), sourceDependencies: [] },
          ...noteParts.map((part) => ({ origin: 'external' as const, kind: HANDOFF_NOTE_TYPE,
            text: part.text, sourceDependencies: part.sourceDependencies })),
        ],
      };
    }

    override async onHandoff(snapshot: ContextRecord[], ctx: { hardTokens: number | null }) {
      if (this.handoffIsProtected(snapshot)) return { tail: null };
      return super.onHandoff(snapshot, ctx);
    }

    protected override pressureNote(): string {
      return '[system] A handoff is coming. It clears everything above; the latest stretch is written into a handoff note for the new session. '
        + 'Whatever from long before you are still following or still mean to do, write it into a file now; soon the context will be gone.';
    }

    override onStallsRecovered({ count, quietMs }: { count: number; quietMs: number }): string | { text: string; sourceMapSpans: SourceMapSpan[] } | null {
      if (count < 2) return null;
      const span = quietMs >= 60_000 ? `about ${Math.round(quietMs / 60_000)} min` : `about ${Math.round(quietMs / 1000)} s`;
      const text = `[system] You got stuck ${count} times and could not speak for ${span}; it was not your choice. You can speak again now.`;
      return { text, sourceMapSpans: [{ start: 0, end: text.length, digest: sha256(text), origin: 'core-generated' }] };
    }

    private handoffNoteAt(file: string): string {
      return this.handoffNoteLinesFor(file).join('');
    }

    private handoffNoteLinesFor(file: string): string[] {
      return [
        '[system] The handoff is done. The context before it is cleared; the files in your workspace are all still there. The handoff summary can guide current work but is not verified evidence of a past decision or shared event; use Memory for those claims. ',
        `The stretch before the clear is written up as a handoff note, delivered with this batch and saved in ${file}: `,
        'it comes in parts by time, only parts with content are sent; "the latest stretch" leads into now, "the earlier stretch" is only for reference. ',
        'Only the latest stretch keeps what your speaking tools were called with and their receipts. ',
        'What a call was given is what you meant to say; whether the person saw it is in the receipt and the events after it. ',
        'Carry on with the current topic or action naturally, with no need to remark on the pause, the clear or the handoff. Old lines and folded fragments are not models for wording or length. ',
        'Never call a speaking tool with empty content; nothing would show. ',
        'To say something, put it straight into the call. If you have nothing to say this turn, call end_turn.',
      ];
    }

    protected override handoffNoteLines(): string[] {
      return this.handoffNoteLinesFor(this.lastHandoffFile ?? 'handoffs/');
    }

    protected override softCapHint(): string | null {
      return '[system] You have taken many steps in a row this turn. Finish what is in hand, then call end_turn.';
    }

    /**
     * The prefix names no workspace file. W4 removed the old note index/injection: a filename
     * listing is not history, and listing every journal or note made the workspace look like a
     * second memory. File access stays on demand through the workspace tools.
     */
    protected override prefixWorkspaceListing(): string {
      return 'Workspace files are task material, not long-term memory. Use list_files, glob_files or grep_files when the current task needs a file; read_file shows it on demand. For a past event, preference or decision, call memory_search. Use list_files with dir handoffs to find handoff notes; verify a note and its current sources before using it.';
    }

    protected override prefixFolds(): Array<{ prefix: string; line: (n: number) => string }> {
      return [
        { prefix: 'blobs/', line: (n) => `blobs/ (${n} binary files; list_files with dir blobs lists them all, read_file shows an image)` },
      ];
    }
  };
}

export type CoopanionPersona = InstanceType<ReturnType<typeof coopanionPersona>>;
