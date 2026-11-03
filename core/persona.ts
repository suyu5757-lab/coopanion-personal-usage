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
import { LOG_SCHEME, blobScheme } from 'cortico/core/blobs.ts';
import type { CoreApi, ContextEvidenceInspection, ContextHandoffPrepareContext, ContextHandoffSourceExcerpt, EvidenceAttachment, EventEnvelope, HandoffCommitCheck, PersonaWebUiDecl, PreparedContextHandoff, PrefixSegment, SessionDecl, SessionOpeningReason, SourceExposureRef, SourceMapSpan, StoragePart, SystemPrefixContext, ToolCallContext, ToolDef, ToolOutcome, WorldLifecycleEvent } from 'cortico/core/types.ts';
import { message, withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { Language } from 'cortico/core/language.ts';
import { HANDOFF_DIR, type Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import type { GitAuthor, WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { memoryTools } from './memory/tools.ts';
import type { HindsightMemory, MemoryEvidenceSegment } from './memory/hindsight.ts';
import type { DerivedArtifact } from './memory/state-store.ts';
import { evidenceCoversText } from './memory/source-evidence.ts';
import { isMemoryForgetRequest } from './memory/router.ts';
import { memoryStorageText } from './memory/strings.ts';
import {
  filterPartnerMarkdown,
  markPartnerDerivedStale,
  markPartnerSourcesStale,
  partnerProvenancePath,
  partnerSegmentDigest,
  partnerSegments,
  partnerWorkspaceDigest,
  readPartnerProvenance,
  type PartnerTextResult,
} from './memory/partner-provenance.ts';
import { SESSION_MAX_CALLS, type SelfTimeConfig } from './browser/config.ts';
import { selfTimeLine } from './browser/model-text.ts';
import { GROWTH_DEFAULTS, type GrowthConfig } from './growth/config.ts';
import { GROWTH_SESSION, GROWTH_TOOL_NAMES, GrowthReview, growthMemorySearchTool } from './growth/review.ts';
import { EXPERIENCE_CONTEXT_HEADER, ExperienceCards, experienceCardArtifactText, readExperienceCardInput } from './growth/experience-cards.ts';
import { GrowthProposals, growthProposalArtifactText, type GrowthProposal } from './growth/proposals.ts';
import { GROWTH_CHECK_MS, GrowthSchedule } from './growth/schedule.ts';
import { readResourcePressure } from './resource-pressure.ts';
import { MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, memoryReadNotice } from './memory/model-text.ts';
import type { ModelLanguage } from './language.ts';
import type { FileSystemActionAuthorization, FileSystemActionAuthorizationRequest } from './action-authorization.ts';
import type { ActionReceiptLedger, ActionReceiptReviewDecision } from './action-receipts.ts';
import type { FileSystemTargetEvidence } from './task-grants.ts';
import { writeState } from './state-file.ts';
import { HANDOFF_NOTE_TYPE, handoffNoteStamp, renderHandoffNote } from '../vendor/cortico/bots/cormini/persona/handoffNote.ts';

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
const WORKSPACE_READ_PATHS: Record<string, string> = {
  read_file: 'path',
  list_files: 'dir',
  glob_files: 'target_directory',
  grep_files: 'path',
};

function partnerSegmentContextText(segment: { text: string; origin: 'user-authored' | 'derived'; sourceIds: string[] }): string {
  const label = segment.origin === 'derived'
    ? `[workspace summary; source_ids=${JSON.stringify(segment.sourceIds)}; source references passed the local provenance and forget-fence checks; verify original Memory sources before citing history]`
    : '[workspace note; user-authored; no original event source is recorded]';
  return `${label}\n${segment.text}`;
}

function partnerEvidenceText(result: PartnerTextResult): string {
  return result.segments.map(partnerSegmentContextText).join('\n\n');
}

function workspaceReadResult(path: string, result: unknown): string | ToolOutcome {
  const label = `[workspace artifact; path=${JSON.stringify(path)}; historicalEvidence=unverified] This content may support the current workspace task. It has no verified source link for a past decision or shared event.`;
  if (typeof result === 'string') {
    if (/^\[(?:not found|read failed|search failed|workspace read failed)/iu.test(result)) return result;
    return `${label}\n${result}`;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return String(result ?? '');
  const record = result as Record<string, unknown>;
  if (typeof record.text !== 'string') return String(result);
  return { ...record, text: `${label}${record.text ? `\n${record.text}` : ''}` } as ToolOutcome;
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
  memory?: HindsightMemory;
  /** The live `companion.selfTime`; null when the app does not have it. */
  selfTime?: () => SelfTimeConfig | null;
  modelLanguage?: () => ModelLanguage;
  /** The live `companion.growth`; reviews only run when a state file is given too. */
  growth?: () => GrowthConfig;
  /** Where the next review is recorded; null turns the review off for this Persona. */
  growthStateFile?: string;
  /** True while the app is paused; a paused app starts no background review. */
  paused?: () => boolean;
  timezone?: () => string;
  /** Core authorizes one workspace file change through the shared action receipt ledger. */
  authorizeWorkspaceAction?: (request: FileSystemActionAuthorizationRequest) => Promise<FileSystemActionAuthorization | null>;
  /** Core owns the shared Browser, CUA and filesystem action receipts shown in Persona settings. */
  actionReceipts?: () => ActionReceiptLedger | null;
}

export function coopanionPersona(Base: typeof Cormini, deps: MemoryDeps = {}) {
  return class CoopanionPersona extends Base {
    /** Commits wait for the one before: Git's index takes one writer, and a turn often writes several files. */
    private commits: Promise<unknown> = Promise.resolve();
    private readonly longTerm = deps.memory ?? null;
    private readonly selfTimeNow = deps.selfTime ?? (() => null);
    private readonly modelLang = deps.modelLanguage ?? (() => 'zh' as ModelLanguage);
    private readonly growthNow = deps.growth ?? (() => GROWTH_DEFAULTS);
    private readonly growthStateFile = deps.growthStateFile ?? null;
    private readonly pausedNow = deps.paused ?? (() => false);
    private readonly timezoneNow = deps.timezone ?? (() => 'UTC');
    private readonly authorizeWorkspaceAction = deps.authorizeWorkspaceAction ?? null;
    private readonly actionReceiptsNow = deps.actionReceipts ?? (() => null);
    private growthSchedule: GrowthSchedule | null = null;
    private growthCheck: ReturnType<typeof setInterval> | null = null;
    private lastUserMemory: { documentId: string; at: number } | null = null;
    private readonly memoryContextBlocks = new Set<string>();
    private readonly partnerArtifacts = new Set<string>();
    private partnerArtifactEpoch: string | null = null;
    private attachedCore: CoreApi | null = null;

    override attach(core: CoreApi): void {
      this.attachedCore = core;
      super.attach(core);
      this.longTerm?.setLifecycleHooks({
        forgetSources: (ids) => {
          let sidecarError: unknown;
          const sidecar = this.partnerProvenanceFile();
          const scope = this.longTerm?.sourceScopeDigest();
          if (sidecar && scope) {
            try { markPartnerSourcesStale(sidecar, partnerWorkspaceDigest(this.memoryDir), scope, ids); }
            catch (error) { sidecarError = error; }
          }
          const forgotten = new Set(ids);
          const proposals = this.growthProposals()?.list().filter((proposal) => proposal.sourceIds.some((id) => forgotten.has(id))) ?? [];
          const policies = this.experienceCards()?.list().filter((card) => card.sourceIds.some((id) => forgotten.has(id))) ?? [];
          if (proposals.length + policies.length > 0) {
            const titles = policies.map((card) => card.title).slice(0, 8);
            const proposalTitles = proposals.map((proposal) => proposal.title).slice(0, 8);
            const detail = [...proposalTitles, ...titles].length ? ` Withdraw these proposals or policies: ${[...proposalTitles, ...titles].join('; ')}.` : '';
            this.injectMemoryContext(`[memory] A source was forgotten. Do not use any linked proposal or experience policy.${detail}`);
          }
          if (sidecarError) throw sidecarError;
        },
        clearDerived: () => {
          let sidecarError: unknown;
          const sidecar = this.partnerProvenanceFile();
          if (sidecar) {
            try { markPartnerDerivedStale(sidecar, partnerWorkspaceDigest(this.memoryDir), this.longTerm?.sourceScopeDigest() ?? null); }
            catch (error) { sidecarError = error; }
          }
          const proposals = this.growthProposals()?.list().filter((proposal) => proposal.state === 'approved') ?? [];
          const cards = this.experienceCards()?.list('approved') ?? [];
          if (proposals.length + cards.length > 0) {
            this.injectMemoryContext('[memory] Long-term memory was cleared. Do not use the retained Growth proposals or Experience cards; their source records are unavailable.');
          }
          this.injectMemoryContext('[memory] Long-term memory was cleared. Do not rely on Hindsight-derived context from before the clear.');
          if (sidecarError) throw sidecarError;
        },
      });
      if (!this.growthStateFile) return;
      const log = {
        info: (message: string, data?: unknown) => this.core?.log.info(message, data),
        warn: (message: string, data?: unknown) => this.core?.log.warn(message, data),
      };
      const review = new GrowthReview({
        core: () => this.core,
        snapshot: () => this.growthSnapshot(),
        tools: () => this.growthTools(),
        memory: () => this.longTerm,
        proposalsDir: join(dirname(this.growthStateFile), 'growth-proposals'),
        experienceCardsDir: join(dirname(this.growthStateFile), 'experience-cards'),
        modelLanguage: () => this.modelLang(),
        timezone: this.timezoneNow,
        log,
      });
      this.growthSchedule = new GrowthSchedule({
        stateFile: this.growthStateFile,
        config: this.growthNow,
        timers: core.timers,
        run: () => review.run(),
        paused: this.pausedNow,
        forkRunning: () => (this.core?.sessionInfo(GROWTH_SESSION).running ?? 0) > 0,
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
      if (this.growthCheck) clearInterval(this.growthCheck);
      this.growthCheck = null;
    }

    override validateEvidenceForRequest(sources: readonly SourceExposureRef[]): boolean {
      return sources.length === 0 || this.longTerm?.sourceExposureCurrent(sources) === true;
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

    private async experienceContext(): Promise<{ text: string; evidence: EvidenceAttachment[] }> {
      const cards = this.experienceCards();
      const memory = this.longTerm;
      if (!cards || !memory?.enabled() || !memory.settled()) return { text: '', evidence: [] };
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
      if (!memory.enabled() || !memory.settled()) return { text: '', evidence: [] };
      const entries = cards.approvedContextEntries(8, 3200, (card) => valid.has(card.id));
      const included: Array<{ text: string; evidence: EvidenceAttachment[] }> = [];
      for (const entry of entries) {
        const sourceIds = [...new Set(entry.card.sourceIds)];
        const segments: MemoryEvidenceSegment[] = sourceIds.map((documentId) => ({
          documentId, start: 0, end: entry.text.length, derived: true,
        }));
        const evidence = await memory.evidenceForSegments(entry.text, segments);
        if (evidence.length !== segments.length || !evidenceCoversText(entry.text, evidence)) continue;
        included.push({ text: entry.text, evidence });
      }
      if (!memory.enabled() || !memory.settled() || included.length === 0) return { text: '', evidence: [] };
      const text = `${EXPERIENCE_CONTEXT_HEADER}\n${included.map((entry) => entry.text).join('\n')}`;
      const evidence: EvidenceAttachment[] = [];
      let offset = EXPERIENCE_CONTEXT_HEADER.length + 1;
      for (let index = 0; index < included.length; index++) {
        const entry = included[index]!;
        evidence.push(...entry.evidence.map((attachment) => ({
          ...attachment,
          segment: { ...attachment.segment, start: attachment.segment.start + offset, end: attachment.segment.end + offset },
        })));
        offset += entry.text.length + (index + 1 < included.length ? 1 : 0);
      }
      return { text, evidence };
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

    private searchMayIncludeProvenance(path: string | null): boolean {
      if (path === null || path === '.') return true;
      const protectedPaths = [PARTNER_FILE, PARTNER_DIR, 'handoffs'];
      return protectedPaths.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`) || protectedPath.startsWith(`${path}/`));
    }

    private partnerProvenanceResult(source?: string) {
      const file = this.partnerDocFile();
      if (!existsSync(file) || !statSync(file).isFile() || !insidePath(realpathSync(this.memoryDir), realpathSync(file))) {
        return filterPartnerMarkdown('', { status: 'missing' }, this.longTerm?.sourceScopeDigest() ?? null, () => false);
      }
      source ??= readFileSync(file, 'utf8');
      const sidecar = this.partnerProvenanceFile();
      const provenance = sidecar ? readPartnerProvenance(sidecar, partnerWorkspaceDigest(this.memoryDir)) : { status: 'missing' as const };
      const filtered = filterPartnerMarkdown(source, provenance, this.longTerm?.sourceScopeDigest() ?? null,
        (sourceId) => this.longTerm?.sourceCurrentForContext(sourceId) === true);
      if (filtered.status !== 'ok' || provenance.status !== 'ok') return filtered;
      const entries = new Map(provenance.file.entries.map((entry) => [entry.segmentDigest, entry]));
      const epochCurrent = !!this.longTerm && this.partnerArtifactEpoch === this.longTerm.evidenceEpoch();
      const segments = filtered.segments.filter((segment) => {
        if (segment.origin === 'user-authored') return true;
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
      return partnerEvidenceText(result) || '[read failed] PARTNER.md paragraphs are withheld because their provenance is not current.';
    }

    protected override writeGuard(op: 'write' | 'append' | 'rename' | 'delete', path: string, role: string): string | null {
      if (isWorkspaceGitMetadataPath(this.memoryDir, path)) return 'Git metadata is not available through workspace tools.';
      return super.writeGuard(op, path, role);
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

    override async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
      await this.ensurePartnerArtifacts();
      const segments = await super.systemSegments(ctx);
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
      const listing = this.prefixWorkspaceListing();
      if (workspace) {
        const start = listing ? workspace.text.indexOf(listing) : -1;
        const unique = start >= 0 && workspace.text.indexOf(listing, start + listing.length) < 0;
        const constitution = segments.find((segment) => segment.title === 'CONSTITUTION');
        const seedConstitution = !!constitution?.sourceMapSpans?.some((span) => span.start === 0
          && span.end === constitution.text.length && span.origin === 'core-generated'
          && span.digest === sha256(constitution.text));
        const partnerSources = this.partnerWorkspaceSources(segments.find((segment) => segment.title === 'PARTNER'));
        if (unique) {
          workspace.sourceMapSpans = this.workspaceListingSourceMap(listing, seedConstitution, partnerSources)
            .map((span) => ({ ...span, start: span.start + start, end: span.end + start }));
        }
      }
      return segments;
    }

    private partnerWorkspaceSources(partner: PrefixSegment | undefined): SourceExposureRef[] | null {
      if (!partner) return null;
      const covered = new Uint8Array(partner.text.length);
      const sources = new Map<string, SourceExposureRef>();
      for (const span of partner.sourceMapSpans ?? []) {
        if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0
          || span.end <= span.start || span.end > partner.text.length
          || span.digest !== sha256(partner.text.slice(span.start, span.end))) return null;
        if (span.origin === 'unknown-derived' || span.origin === 'user-input') return null;
        if (span.origin === 'hindsight-source' || span.origin === 'generation-derived') {
          if (!span.exposedSources?.length) return null;
          for (const source of span.exposedSources) {
            const key = JSON.stringify([source.bankId, source.endpoint, source.documentId]);
            const previous = sources.get(key);
            if (previous && (previous.contentDigest !== source.contentDigest
              || previous.validatedEpoch !== source.validatedEpoch)) return null;
            sources.set(key, source);
          }
        }
        for (let at = span.start; at < span.end; at++) covered[at] = 1;
      }
      if (sources.size === 0) return null;
      for (let at = 0; at < partner.text.length; at++) {
        if (!/\s/u.test(partner.text[at]!) && covered[at] !== 1) return null;
      }
      return [...sources.values()];
    }

    private workspaceListingSourceMap(
      text: string,
      seedConstitution: boolean,
      partnerSources: readonly SourceExposureRef[] | null,
    ): SourceMapSpan[] {
      const heading = 'Files in your workspace:';
      if (!text.startsWith(`${heading}\n`)) return [];
      const spans: SourceMapSpan[] = [{ start: 0, end: heading.length, digest: sha256(heading), origin: 'core-generated' }];
      let start = heading.length + 1;
      for (const line of text.slice(start).split('\n')) {
        if (seedConstitution && line === `- ${CONSTITUTION_FILE}`) {
          spans.push({ start, end: start + line.length, digest: sha256(line), origin: 'core-generated' });
        } else if (partnerSources?.length && line === `- ${PARTNER_FILE}`) {
          spans.push({ start, end: start + line.length, digest: sha256(line), origin: 'hindsight-source',
            exposedSources: [...partnerSources] });
        }
        start += line.length + 1;
      }
      return spans;
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
              ? { start, end, digest: sha256(entry.text), origin: 'hindsight-source', exposedSources }
              : { start, end, digest: sha256(entry.text), origin: 'unknown-derived' });
          } else {
            spans.push({ start, end, digest: sha256(entry.text), origin: 'unknown-derived' });
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
              return `[workspace read failed] Git metadata is not available through workspace tools.`;
            }
            const path = this.workspaceRelativePath(args[pathArgument]);
            if (tool.name === 'read_file' && path === PARTNER_FILE) {
              await this.ensurePartnerArtifacts();
              return this.partnerDocumentForRead();
            }
            if (tool.name === 'read_file' && path?.startsWith(HANDOFF_DIR)) {
              await this.recoverHandoffFiles();
              return '[read failed] This workspace area is withheld until its content has provenance sidecar entries.';
            }
            if (tool.name === 'read_file' && path
              && path.startsWith(`${PARTNER_DIR}/`)) {
              return '[read failed] This workspace area is withheld until its content has provenance sidecar entries.';
            }
            if (tool.name === 'grep_files' && this.searchMayIncludeProvenance(path)) {
              return '[search failed] The requested scope may include partner or handoff notes; read only eligible files directly.';
            }
            const result = await tool.handler(args, ctx);
            return workspaceReadResult(path ?? '.', result);
          },
        };
      });
      return [...base, ...memoryTools({
        memory: () => this.longTerm,
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

    private workspaceActionPlan(name: string, args: Record<string, unknown>, role: string): WorkspaceActionPlan | { error: string; failurePrefix: string } {
      const failurePrefix = name === 'save_blob' ? '[save failed] '
        : name === 'append_file' ? '[append failed] '
          : name === 'edit_file' ? '[edit failed] '
            : name === 'delete_file' ? '[delete failed] ' : '[write failed] ';
      const rawPath = String(args.path ?? '').trim();
      if (!rawPath) return { error: 'path 不能为空', failurePrefix };

      const operation = name === 'append_file' ? 'append' : name === 'delete_file' ? 'delete' : 'write';
      const denied = this.writeGuard(operation, rawPath, role);
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
      };
      return { request, path: pathState, finalBytes: name === 'delete_file' ? null : finalBytes, failurePrefix };
    }

    /** The tool, authorized before dispatch and committed after a matching read-back. */
    private committed(base: ToolDef, { ok, verb }: { ok: string; verb: string }): ToolDef {
      return {
        ...base,
        handler: async (args, ctx) => {
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

          const planned = this.workspaceActionPlan(base.name, args, ctx.role);
          if ('error' in planned) return `${planned.failurePrefix}${planned.error}`;
          const authorization = await this.authorizeWorkspaceAction(planned.request);
          if (!authorization) return `${planned.failurePrefix}Core did not authorize this workspace action`;

          let dispatched = false;
          try {
            // Establish the pre-write checkpoint only after approval; it is workspace history metadata.
            this.git.ensureRepo();
            const current = this.workspacePathState(planned.path.relativePath, planned.request.target.instanceId);
            if (current.path.snapshotId !== planned.path.snapshotId) {
              authorization.revoke();
              return `${planned.failurePrefix}the workspace file changed before dispatch`;
            }
            if (!authorization.consume(current.target, planned.request.expectedChange, planned.request.files)) {
              authorization.revoke();
              return `${planned.failurePrefix}the workspace grant expired or no longer matches`;
            }

            dispatched = true;
            const out = await base.handler(args, ctx);
            if (typeof out !== 'string' || !out.startsWith(ok)) {
              authorization.complete({
                phase: 'unknown', dispatchState: 'unknown', outcome: 'unknown',
                note: 'the workspace tool did not confirm whether it changed the file',
                evidence: { source: 'persona-workspace-tool', status: 'unknown', observedAt: Date.now() },
              });
              return out;
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
              return `${planned.failurePrefix}workspace read-back could not verify the result`;
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
              return `${planned.failurePrefix}workspace read-back differed from the approved result`;
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
            return out;
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
            return `${planned.failurePrefix}${error instanceof Error ? error.message : String(error)}`;
          }
        },
      };
    }

    override webUi(language: Language = 'zh'): PersonaWebUiDecl {
      const decl = super.webUi(language);
      const storage: StoragePart[] = [...(decl.memory?.storage ?? [])];
      const panels = [...(decl.memory?.panels ?? [])];
      const t = memoryStorageText(language);
      if (this.longTerm || this.growthStateFile) {
        panels.push({ id: 'hindsight', title: t.hindsightLabel, description: t.hindsightPanelDesc });
      }
      panels.push({ id: 'action-receipts', title: t.actionReceiptsLabel, description: t.actionReceiptsPanelDesc });
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
        if (!baseInvoke) throw new Error(`No handler for panel ${panel}`);
        return baseInvoke(panel, method, args);
      };
      return {
        ...decl,
        invoke,
        ...(decl.memory ? { memory: { ...decl.memory, panels, storage } } : { memory: { panels, storage } }),
      };
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

    private async hindsightInvoke(method: string, args: unknown[]): Promise<unknown> {
      if (method === 'system-health') return this.systemHealth();
      if (method === 'growth-status') {
        return {
          schedule: this.growthSchedule?.status() ?? null,
          proposals: this.growthProposals()?.list() ?? [],
          experiences: this.experienceCards()?.list() ?? [],
          browser: this.systemHealth().browser,
        };
      }
      if (method === 'growth-proposals') {
        const memory = this.longTerm;
        return this.growthProposals()?.list().filter((proposal) =>
          memory?.derivedArtifactIsCurrent(proposal.id, growthProposalArtifactText(proposal)) === true) ?? [];
      }
      if (method === 'growth-proposal-review') {
        const id = String(args[0] ?? ''), action = String(args[1] ?? '');
        if (action !== 'approved' && action !== 'rejected') throw new Error('Review action must be approved or rejected.');
        const store = this.growthProposals();
        const current = store?.get(id);
        if (action === 'approved') {
          const memory = this.longTerm;
          if (!current || !memory?.enabled() || !await this.verifiedMemorySources(current.sourceIds)) {
            throw new Error('The proposal sources cannot be verified.');
          }
          if (!await memory.verifyDerivedArtifact(current.id, growthProposalArtifactText(current))) {
            throw new Error('The proposal provenance is missing, stale or no longer matches its sources.');
          }
          if (!memory.setDerivedArtifactReviewState(current.id, 'approved')) {
            throw new Error('The proposal artifact could not be approved in the provenance store.');
          }
        }
        const proposal = store?.transition(id, action, String(args[2] ?? ''));
        if (!proposal) throw new Error('The proposal is no longer a candidate. Refresh the list.');
        if (action === 'rejected') this.longTerm?.setDerivedArtifactReviewState(id, 'rejected');
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
        if (action === 'approved') {
          const context = await this.experienceContext();
          if (context.text) this.injectMemoryContext(context.text, context.evidence);
        } else if (action === 'deprecated') {
          const context = await this.experienceContext();
          const notice = `[memory] The user revoked the experience strategy “${before?.title ?? id}”. Do not follow it anymore.`;
          const text = context.text ? `${notice} ${context.text}` : `${notice} No approved experience strategies remain active.`;
          const offset = notice.length + 1;
          const evidence = context.evidence.map((attachment) => ({
            ...attachment,
            segment: { ...attachment.segment, start: attachment.segment.start + offset, end: attachment.segment.end + offset },
          }));
          this.injectMemoryContext(text, evidence);
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
      this.core?.injectInternal(ctx.reason === 'restarted' ? '[system] The app restarted; the session carries on.' : '[system] The session has started.', 'opening');
      if (!this.longTerm?.enabled() && !this.experienceCards()?.list('approved').length) return;
      this.core?.injectDeferred('memory', async () => {
        const briefing = this.longTerm?.enabled() ? await this.longTerm.sessionBriefing().catch(() => null) : null;
        const portrait = briefing?.text?.trim() ?? '';
        const strategies = await this.experienceContext();
        if (portrait && briefing?.evidence?.length) this.injectMemoryContext(portrait, briefing.evidence);
        if (strategies.text) this.injectMemoryContext(strategies.text, strategies.evidence);
        return null;
      });
    }

    retainCooOutput(text: string, meta: { session?: string; callId?: string; timestamp?: string }): void {
      const session = meta.session ?? 'main';
      const envelopes = meta.callId
        ? this.attachedCore?.generationEvidence(session).filter((envelope) => envelope.sessionId === session
            && envelope.outputToolCalls.some((output) => output.toolCallId === meta.callId)) ?? []
        : [];
      this.longTerm?.retainCoo(text, meta, envelopes.length === 1 ? envelopes[0] : undefined);
    }

    override onWorldLifecycle(event: WorldLifecycleEvent): void {
      const what = event.kind === 'visibility'
        ? (event.visible ? 'is visible to you again' : 'is hidden from you; its events no longer reach you')
        : event.kind === 'mounted' ? 'is on' : event.kind === 'unmounted' ? 'is off' : 'restarted';
      this.core?.injectInternal(`[system] The World "${event.label}" ${what}.`, 'notice');
    }

    /** Cormini's delivery: the heartbeat's quiet time starts over, and one line counts the events. */
    override async onDelivery(ctx: { events: EventEnvelope[] }): Promise<void> {
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
      this.core?.injectInternal(`[system] ${n} new event${n === 1 ? '' : 's'}.`, 'notice');

      let latest: string | null = null;
      let latestUserDocumentId: string | null = null;
      for (const event of external) {
        if (event.type === 'desktop-pet.touch') {
          const touch = event.meta?.touch as { kind?: unknown; count?: unknown; crashed?: unknown } | undefined;
          if (touch) this.longTerm?.retainTouch(touch, { session: 'main', cursor: event.cursor, at: event.ts });
          this.lastUserMemory = null;
          continue;
        }
        if (event.type !== 'desktop-pet.message' && event.type !== 'desktop-pet.speech' && event.type !== 'desktop-pet.answer') continue;
        const said = typeof event.meta?.text === 'string' ? event.meta.text.trim() : event.text.trim();
        if (!said) continue;
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
      const recalled = await this.longTerm.recallForTurn(latest, {
        ...(latestUserDocumentId ? { userEventDocumentId: latestUserDocumentId } : {}),
        captureTrace: true,
      });
      if (recalled.text) {
        const sourceSegments = recalled.trace?.format.sourceSegments ?? [];
        const evidence = await this.longTerm.evidenceForSegments(recalled.text, sourceSegments);
        const complete = sourceSegments.length > 0 && evidenceCoversText(recalled.text, evidence);
        this.injectMemoryContext(complete ? recalled.text : `${recalled.text}\n${MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE}`, evidence);
      }
      else if (recalled.route === 'deep' && recalled.status !== 'skipped') {
        this.injectMemoryContext(`${memoryReadNotice(recalled.status)} If you are not sure, say so; do not invent dates, names or past events.`);
      }
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
          && span.exposedSources.every((source) => memory?.sourceVisible(source.documentId)
            && memory.sourceCurrentForContext(source.documentId)));
        const sourceMaps = (record.context.sourceMapSpans ?? []).filter((span) => validSpan(text, span)
          && span.origin !== 'unknown-derived'
          && (span.origin === 'core-generated' || span.origin === 'user-input'
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
        let stageMatches = handoffFileMatches(stagePath, owner, artifact.bodyDigest);
        let finalMatches = handoffFileMatches(finalPath, owner, artifact.bodyDigest);

        if (artifact.lifecycleState === 'pending') {
          if (!stageMatches && !finalMatches) {
            memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-candidate-file-unavailable');
            continue;
          }
          if (!await memory.verifyPendingHandoffArtifact(artifact.artifactId, artifact.creatorOperationId!,
            readFileSync(finalMatches ? finalPath : stagePath, 'utf8'))) continue;
          if (!finalMatches && stageMatches) {
            if (existsSync(finalPath)) {
              memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-target-owned-elsewhere');
              this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
              continue;
            }
            try {
              linkSync(stagePath, finalPath);
              syncDirectory(handoffPath);
              finalMatches = handoffFileMatches(finalPath, owner, artifact.bodyDigest);
            } catch {
              memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-publication-recovery-failed');
              this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
              continue;
            }
          }
          if (!finalMatches) {
            memory.withdrawDerivedArtifact(artifact.artifactId, 'handoff-published-file-unverified');
            this.removeOwnedHandoffFile(stagePath, owner, artifact.bodyDigest);
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
      await this.recoverHandoffFiles();
      const memory = this.longTerm;
      const protectedSnapshot = this.handoffIsProtected(snapshot);
      const expectedMemoryEpoch = memory?.evidenceEpoch() ?? null;
      const filtered = this.handoffSnapshot(snapshot, ctx.sourceEvidence);
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
          evidence: [{ ...excerpt.attachment, segment: { start: 0, end: text.length, digest: excerpt.attachment.segment.digest } }],
        })];
      });
      const noteSnapshot = [...filtered.records, ...excerptRecords];
      const note = renderHandoffNote(noteSnapshot, {
        speechTools: this.core?.toolsTagged('speak') ?? new Set<string>(),
        flowTools: this.core?.toolsTagged('flow') ?? new Set<string>(),
        snapshotTools: this.core?.toolsTagged('snapshot') ?? new Set<string>(),
        now,
        budgetTokens: Math.floor(maxTokens * keepRatio),
        splitAtMs: this.pressureSplitAt,
      });
      const handoffPath = join(this.memoryDir, HANDOFF_DIR);
      const stagingPath = join(handoffPath, '.staging');
      let ownsHandoffDirectory = false;
      let ownsStagingDirectory = false;
      let stageIdentity: { dev: number; ino: number } | null = null;
      let finalPath: string | null = null;
      let finalIdentity: { dev: number; ino: number } | null = null;
      let committedFile: string | null = null;
      let fileOwner: HandoffFileOwner | null = null;
      const noteDigest = sha256(note.text);
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
        writeFileSync(fd, note.text, { encoding: 'utf8' });
        fsyncSync(fd);
        const closingFd = fd;
        fd = null;
        closeSync(closingFd);
        syncDirectory(stagingPath);
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

      const commitGuard = (): HandoffCommitCheck => {
        const generation = this.core?.sessionInfo(ctx.sessionId).generation;
        if (!generation || generation.status !== 'current' || generation.token !== ctx.expectedGeneration) {
          return { status: 'stale', reason: 'generation-changed' };
        }
        if (!stageIdentity || !fileOwner || !handoffFileMatches(stagePath, fileOwner, noteDigest)) {
          return { status: 'blocked', reason: 'staged-candidate-changed' };
        }
        if (existsSync(join(handoffPath, plannedFilename!))) return { status: 'blocked', reason: 'handoff-target-owned-elsewhere' };
        if (candidateEvidence.mappingState !== 'complete') {
          return { status: 'blocked', reason: 'candidate-source-mapping-incomplete' };
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
          content: note.text,
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
      };
      const discard = (): void => {
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
        result: { tail: this.handoffTail(filtered.records) },
        candidate: {
          snapshotId: ctx.candidateSnapshotId,
          records: filtered.records,
          sourceExcerpts: filtered.sourceExcerpts,
          content: note.text,
          injections: note.parts.map((part) => ({
            origin: 'external' as const,
            kind: HANDOFF_NOTE_TYPE,
            text: part.text,
            sourceDependencies: candidateEvidence.exposedSources,
          })),
        },
        ...(protectedHandoff ? { protected: true as const } : {}),
        commitGuard,
        commit,
        discard,
        injections: [
          { origin: 'internal' as const, kind: 'handoff', text: persona.handoffNoteAt(plannedFile), sourceDependencies: [] },
          ...note.parts.map((part) => ({ origin: 'external' as const, kind: HANDOFF_NOTE_TYPE,
            text: part.text, sourceDependencies: candidateEvidence.exposedSources })),
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

    override onStallsRecovered({ count, quietMs }: { count: number; quietMs: number }): string | null {
      if (count < 2) return null;
      const span = quietMs >= 60_000 ? `about ${Math.round(quietMs / 60_000)} min` : `about ${Math.round(quietMs / 1000)} s`;
      return `[system] You got stuck ${count} times and could not speak for ${span}; it was not your choice. You can speak again now.`;
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

    protected override prefixFolds(): Array<{ prefix: string; line: (n: number) => string }> {
      return [
        { prefix: 'handoffs/', line: (n) => `handoffs/ (${n} handoff notes; list_files with dir handoffs lists them all)` },
        { prefix: 'blobs/', line: (n) => `blobs/ (${n} binary files; list_files with dir blobs lists them all, read_file shows an image)` },
      ];
    }
  };
}

export type CoopanionPersona = InstanceType<ReturnType<typeof coopanionPersona>>;
