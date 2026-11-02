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
import { appendFileSync, closeSync, existsSync, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LOG_SCHEME, blobScheme } from 'cortico/core/blobs.ts';
import type { CoreApi, ContextHandoffPrepareContext, EvidenceAttachment, EventEnvelope, HandoffCommitCheck, PersonaWebUiDecl, PreparedContextHandoff, SessionDecl, SessionOpeningReason, StoragePart, ToolCallContext, ToolDef, ToolOutcome, WorldLifecycleEvent } from 'cortico/core/types.ts';
import { withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { Language } from 'cortico/core/language.ts';
import { HANDOFF_DIR, type Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import type { GitAuthor, WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { memoryTools } from './memory/tools.ts';
import type { HindsightMemory, MemoryEvidenceSegment } from './memory/hindsight.ts';
import { evidenceCoversText } from './memory/source-evidence.ts';
import { isMemoryForgetRequest } from './memory/router.ts';
import { memoryStorageText } from './memory/strings.ts';
import {
  filterPartnerMarkdown,
  markPartnerDerivedStale,
  markPartnerSourcesStale,
  partnerProvenancePath,
  partnerWorkspaceDigest,
  readPartnerProvenance,
  type PartnerTextResult,
} from './memory/partner-provenance.ts';
import { SESSION_MAX_CALLS, type SelfTimeConfig } from './browser/config.ts';
import { selfTimeLine } from './browser/model-text.ts';
import { GROWTH_DEFAULTS, type GrowthConfig } from './growth/config.ts';
import { GROWTH_SESSION, GROWTH_TOOL_NAMES, GrowthReview, growthMemorySearchTool } from './growth/review.ts';
import { EXPERIENCE_CONTEXT_HEADER, ExperienceCards, readExperienceCardInput } from './growth/experience-cards.ts';
import { GrowthProposals, type GrowthProposal } from './growth/proposals.ts';
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

function partnerEvidenceText(result: PartnerTextResult): string {
  return result.segments.map((segment) => {
    const label = segment.origin === 'derived'
      ? `[workspace summary; source_ids=${JSON.stringify(segment.sourceIds)}; source references passed the local provenance and forget-fence checks; verify original Memory sources before citing history]`
      : '[workspace note; user-authored; no original event source is recorded]';
    return `${label}\n${segment.text}`;
  }).join('\n\n');
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

    override attach(core: CoreApi): void {
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
          const policies = this.experienceCards()?.list().filter((card) => card.sourceIds.some((id) => forgotten.has(id))) ?? [];
          const removed = this.growthProposals()?.removeBySource(ids) ?? 0;
          const cards = this.experienceCards()?.removeBySource(ids) ?? 0;
          if (removed + cards > 0) {
            const titles = policies.map((card) => card.title).slice(0, 8);
            const detail = titles.length ? ` Withdraw these policies: ${titles.join('; ')}.` : '';
            this.injectMemoryContext(`[memory] A source was forgotten. Do not rely on any proposal or experience policy derived from it; the linked records were removed.${detail}`);
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
          this.growthProposals()?.clear();
          this.experienceCards()?.clear();
          this.injectMemoryContext('[memory] Long-term memory was cleared. Disregard all Hindsight-derived experience strategies injected earlier in this session; none remain active.');
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
      return filterPartnerMarkdown(source, provenance, this.longTerm?.sourceScopeDigest() ?? null,
        (sourceId) => this.longTerm?.sourceCurrentForContext(sourceId) === true);
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
            if (tool.name === 'read_file' && path === PARTNER_FILE) return this.partnerDocumentForRead();
            if (tool.name === 'read_file' && path
              && (path.startsWith(`${PARTNER_DIR}/`) || path.startsWith('handoffs/'))) {
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
      if (method === 'growth-proposals') return this.growthProposals()?.list() ?? [];
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
        }
        const proposal = store?.transition(id, action, String(args[2] ?? ''));
        if (!proposal) throw new Error('The proposal is no longer a candidate. Refresh the list.');
        return proposal;
      }
      if (method === 'growth-proposal-apply') throw new Error('Growth proposal application is not enabled.');
      if (method === 'experience-trial-receipts') {
        const id = String(args[0] ?? '');
        const cards = this.experienceCards();
        const card = cards?.get(id);
        if (!card || card.state !== 'candidate' || card.kind !== 'skill') throw new Error('A skill candidate is required.');
        const memory = this.longTerm;
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
        if (!memory?.enabled() || !await this.verifiedMemorySources(parsed.card.sourceIds)) {
          throw new Error('The experience sources are missing, fenced or lack current provenance.');
        }
        const result = this.experienceCards()?.create(input);
        if (!result?.ok) throw new Error(result?.errors.join('; ') ?? 'Experience cards are unavailable.');
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
          if (!memory?.enabled() || !sourcesValid) {
            throw new Error('The experience sources cannot be verified.');
          }
        }
        const card = cards?.transition(id, action);
        if (!card) throw new Error('The experience card is no longer in that state. Refresh the list.');
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
        const missing: string[] = [];
        for (const sourceId of proposal.sourceIds) {
          if (!await memory.hasSource(sourceId)) missing.push(sourceId);
        }
        if (missing.length > 0) throw new Error(`The proposal sources are gone: ${missing.join(', ')}. It was not applied.`);

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
        if (portrait) this.injectMemoryContext(`${portrait}\n${MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE}`);
        if (strategies.text) this.injectMemoryContext(strategies.text, strategies.evidence);
        return null;
      });
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

    private handoffSnapshot(snapshot: ContextRecord[]): ContextRecord[] {
      const memory = this.longTerm;
      const memoryCallIds = new Set(snapshot.flatMap((record) => record.item.type === 'function_call'
        && MEMORY_TOOL_NAMES.has(record.item.name) ? [record.item.call_id] : []));
      return snapshot
        .filter((record) => !(record.item.type === 'function_call'
          && MEMORY_TOOL_NAMES.has(record.item.name))
          && !(record.item.type === 'function_call_output' && memoryCallIds.has(record.item.call_id)))
        .map((record) => {
          if (record.item.type !== 'message') return record;
          let text = textOf(record);
          let changed = false;
          for (const block of this.memoryContextBlocks) {
            if (!block || !text.includes(block)) continue;
            const blank = block.replace(/[^\r\n]/g, ' ');
            text = text.split(block).join(blank);
            changed = true;
          }
          const sourceSpans = (record.context.evidence ?? []).flatMap((attachment) => {
            const current = memory?.sourceVisible(attachment.documentId) && memory.sourceCurrentForContext(attachment.documentId);
            return current ? [] : [{ start: attachment.segment.start, end: attachment.segment.end }];
          });
          const fencedEventSpans = (record.context.frame?.events ?? []).flatMap((event) => {
            if (event.source !== 'desktop-pet') return [];
            const documentId = event.type === 'desktop-pet.touch'
              ? `touch:main:${event.cursor}`
              : ['desktop-pet.message', 'desktop-pet.speech', 'desktop-pet.answer'].includes(event.type)
                ? `user:main:${event.cursor}`
                : null;
            return documentId && memory?.sourceFenced(documentId)
              ? [{ start: event.start, end: event.start + event.chars }]
              : [];
          });
          for (const { start, end } of [...sourceSpans, ...fencedEventSpans].sort((a, b) => b.start - a.start)) {
            const segment = text.slice(start, end);
            text = `${text.slice(0, start)}${segment.replace(/[^\r\n]/g, ' ')}${text.slice(end)}`;
            changed = true;
          }
          return changed ? withText(record, text) : record;
        });
    }

    async prepareHandoff(snapshot: ContextRecord[], ctx: ContextHandoffPrepareContext): Promise<PreparedContextHandoff> {
      const memory = this.longTerm;
      const protectedHandoff = this.handoffIsProtected(snapshot);
      const expectedMemoryEpoch = memory?.evidenceEpoch() ?? null;
      const memorySourcesVerified = !!memory && !!expectedMemoryEpoch
        && ctx.sourceEvidence.mappingState === 'complete'
        && await memory.verifyExposureSources(ctx.sourceEvidence.exposedSources, expectedMemoryEpoch);
      const sourceFree = !protectedHandoff && ctx.sourceEvidence.exposedSources.length === 0;
      const filtered = this.handoffSnapshot(snapshot);
      const now = new Date();
      const { maxTokens, keepRatio } = this.context();
      const note = renderHandoffNote(filtered, {
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
      const persona = this;
      const previousHandoffFile = this.lastHandoffFile;
      const previousPressureWarned = this.pressureWarned;
      const previousPressureSplitAt = this.pressureSplitAt;
      const previousMemoryContextBlocks = [...this.memoryContextBlocks];
      const stagePath = join(stagingPath, `${randomUUID()}.md`);
      const makeDirectory = (path: string): boolean => {
        try {
          mkdirSync(path, { mode: 0o700 });
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !statSync(path).isDirectory()) throw error;
          return false;
        }
      };
      const removeOwnedFile = (path: string | null, identity: { dev: number; ino: number } | null): void => {
        if (!path || !identity || !existsSync(path)) return;
        try {
          const current = statSync(path);
          if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
        } catch { /* Keep a file whose ownership cannot be confirmed. */ }
      };
      const cleanupStage = (): void => {
        removeOwnedFile(stagePath, stageIdentity);
        stageIdentity = null;
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
        writeFileSync(fd, note.text, { encoding: 'utf8' });
        const closingFd = fd;
        fd = null;
        closeSync(closingFd);
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
        if (protectedHandoff) {
          if (!memory || !expectedMemoryEpoch || !memorySourcesVerified || !memory.enabled() || !memory.settled()
            || memory.evidenceEpoch() !== expectedMemoryEpoch || ctx.sourceEvidence.mappingState !== 'complete'
            || ctx.sourceEvidence.exposedSources.length === 0
            || ctx.sourceEvidence.exposedSources.some((source) => !memory.sourceVisible(source.documentId)
              || !memory.sourceCurrentForContext(source.documentId))) {
            return { status: 'blocked', reason: 'memory-source-dependency-unverified' };
          }
        } else if (!sourceFree || ctx.sourceEvidence.exposedSources.length > 0) {
          return { status: 'blocked', reason: 'source-free-dependency-unproven' };
        }
        return { status: 'allow' };
      };
      const commit = (): void => {
        if (committedFile) throw new Error('handoff candidate was already committed');
        if (!stageIdentity) throw new Error('handoff candidate ownership was lost');
        const stem = handoffNoteStamp(now);
        for (let suffix = 0; suffix < 100; suffix++) {
          const filename = `${stem}${suffix === 0 ? '' : `-${suffix}`}.md`;
          const candidate = join(handoffPath, filename);
          try {
            linkSync(stagePath, candidate);
            finalPath = candidate;
            const linkedIdentity = { ...stageIdentity };
            finalIdentity = linkedIdentity;
            const stat = statSync(candidate);
            if (stat.dev !== linkedIdentity.dev || stat.ino !== linkedIdentity.ino) throw new Error('published handoff identity changed');
            committedFile = `${HANDOFF_DIR}${filename}`;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
        if (!committedFile) throw new Error('no unused handoff filename is available');
        unlinkSync(stagePath);
        stageIdentity = null;
        this.lastHandoffFile = committedFile;
        this.pressureWarned = false;
        this.pressureSplitAt = null;
        this.memoryContextBlocks.clear();
        cleanupStage();
      };
      const discard = (): void => {
        removeOwnedFile(finalPath, finalIdentity);
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
        result: { tail: this.handoffTail(snapshot) },
        ...(protectedHandoff ? { protected: true as const } : {}),
        commitGuard,
        commit,
        discard,
        get injections() {
          if (!committedFile) return [];
          return [
            { origin: 'internal' as const, kind: 'handoff', text: persona.handoffNote() },
            ...note.parts.map((part) => ({ origin: 'external' as const, kind: HANDOFF_NOTE_TYPE, text: part.text })),
          ];
        },
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

    protected override handoffNoteLines(): string[] {
      return [
        '[system] The handoff is done. The context before it is cleared; the files in your workspace are all still there. The handoff summary can guide current work but is not verified evidence of a past decision or shared event; use Memory for those claims. ',
        `The stretch before the clear is written up as a handoff note, delivered with this batch and saved in ${this.lastHandoffFile ?? 'handoffs/'}: `,
        'it comes in parts by time, only parts with content are sent; "the latest stretch" leads into now, "the earlier stretch" is only for reference. ',
        'Only the latest stretch keeps what your speaking tools were called with and their receipts. ',
        'What a call was given is what you meant to say; whether the person saw it is in the receipt and the events after it. ',
        'Carry on with the current topic or action naturally, with no need to remark on the pause, the clear or the handoff. Old lines and folded fragments are not models for wording or length. ',
        'Never call a speaking tool with empty content; nothing would show. ',
        'To say something, put it straight into the call. If you have nothing to say this turn, call end_turn.',
      ];
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
