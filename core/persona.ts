/**
 * Coo's Persona: Cortico's Cormini with four changes for the desktop pet.
 *
 * - `PARTNER.md` in the workspace goes into the system prefix whole (Cormini's partner segment), after a
 *   standing line asking Coo to keep it short and put details under `partner/`, and cannot be deleted with
 *   `delete_file`, as `CONSTITUTION.md` cannot.
 * - Every write Coo makes to its workspace is committed to the workspace's Git repository, one commit
 *   per tool call, so the workspace has a history to look back on and go back to. `blobs/` is left out
 *   of the repository. Without Git (`gitInstalled`) the files are written all the same.
 * - The lines the Persona itself puts into the context (a session opening, new events, a World
 *   switched, context pressure, the handoff, the round cap, stalls) and its workspace listing are in
 *   English whatever the app language; Coo is told which language to talk in by the desktop-pet World.
 * - While `companion.selfTime` is on, Cormini's quiet heartbeat offers time of her own instead of only
 *   speaking first: the browser World's tools are available and the line names the session limit.
 *
 * Cortico is staged at build time and the bots are not part of its module paths, so the base class is
 * passed in: the app loads it from the staged Cortico (`companion.ts`), the tests from vendor/cortico.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join, dirname } from 'node:path';
import type { CoreApi, EventEnvelope, PersonaWebUiDecl, SessionDecl, SessionOpeningReason, StoragePart, ToolDef, WorldLifecycleEvent } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { Language } from 'cortico/core/language.ts';
import type { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import type { GitAuthor, WorkspaceGit } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { memoryTools } from './memory/tools.ts';
import type { HindsightMemory } from './memory/hindsight.ts';
import { isMemoryForgetRequest } from './memory/router.ts';
import { memoryStorageText } from './memory/strings.ts';
import { SESSION_MAX_CALLS, type SelfTimeConfig } from './browser/config.ts';
import { selfTimeLine } from './browser/model-text.ts';
import { GROWTH_DEFAULTS, type GrowthConfig } from './growth/config.ts';
import { GROWTH_SESSION, GROWTH_TOOL_NAMES, GrowthReview, growthMemorySearchTool } from './growth/review.ts';
import { ExperienceCards } from './growth/experience-cards.ts';
import { GrowthProposals, type GrowthProposal } from './growth/proposals.ts';
import { GROWTH_CHECK_MS, GrowthSchedule } from './growth/schedule.ts';
import { readResourcePressure } from './resource-pressure.ts';
import type { ModelLanguage } from './language.ts';
import { writeState } from './state-file.ts';

/** The workspace file that goes into the prefix as Coo's notes on the person. */
export const PARTNER_FILE = 'PARTNER.md';
/** The workspace directory for details about the person that PARTNER.md leaves out; Coo reads them when needed. */
export const PARTNER_DIR = 'partner';
/** Heads the partner segment: the segment is the whole file on every request, so its length is paid each time. */
export const PARTNER_NOTE = `${PARTNER_FILE} in your workspace, below, is read in full on every request. Keep it a short, distilled portrait `
  + `of the person: merge or drop what is outdated. Put stories, logs and longer notes in files under ${PARTNER_DIR}/ and read them `
  + 'when needed.';
/** Commits of Coo's own writes. */
export const AUTHOR_COO: GitAuthor = { name: 'coo', email: 'coo@persona.local' };
/** Commits the app makes on its own: the snapshot at start. */
export const AUTHOR_APP: GitAuthor = { name: 'coopanion', email: 'app@persona.local' };
/** What the workspace's `.gitignore` holds besides Cormini's own line: the binaries Coo saves stay out of the history. */
const IGNORED = 'blobs/';
/** Tags made by `snapshot`: the workspace as each version of the app first found it. */
export const SNAPSHOT_TAG = (version: string) => `start-${version}`;
/** How long after a line a "don't remember that" still refers to it. */
const FORGET_WINDOW_MS = 10 * 60_000;

/** Write tools and the receipt each starts with when it succeeded (Cormini's workspaceTools.ts and blobs.ts). */
const WRITES: Record<string, { ok: string; verb: string }> = {
  write_file: { ok: '[written] ', verb: 'wrote' },
  edit_file: { ok: '[edited] ', verb: 'edited' },
  append_file: { ok: '[appended] ', verb: 'appended to' },
  delete_file: { ok: '[deleted] ', verb: 'deleted' },
  save_blob: { ok: '[saved] ', verb: 'saved' },
};

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
    private growthSchedule: GrowthSchedule | null = null;
    private growthCheck: ReturnType<typeof setInterval> | null = null;
    private lastUserMemory: { documentId: string; at: number } | null = null;

    override attach(core: CoreApi): void {
      super.attach(core);
      this.longTerm?.setLifecycleHooks({
        forgetSources: (ids) => {
          const forgotten = new Set(ids);
          const policies = this.experienceCards()?.list().filter((card) => card.sourceIds.some((id) => forgotten.has(id))) ?? [];
          const removed = this.growthProposals()?.removeBySource(ids) ?? 0;
          const cards = this.experienceCards()?.removeBySource(ids) ?? 0;
          if (removed + cards > 0) {
            const titles = policies.map((card) => card.title).slice(0, 8);
            const detail = titles.length ? ` Withdraw these policies: ${titles.join('; ')}.` : '';
            this.core?.injectInternal(`[memory] A source was forgotten. Do not rely on any proposal or experience policy derived from it; the linked records were removed.${detail}`, 'memory');
          }
        },
        clearDerived: () => {
          this.growthProposals()?.clear();
          this.experienceCards()?.clear();
          this.core?.injectInternal('[memory] Long-term memory was cleared. Disregard all Hindsight-derived experience policies injected earlier in this session; none remain active.', 'memory');
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

    private experienceContext(): string {
      const cards = this.experienceCards();
      if (!cards) return '';
      // A card whose source was fenced stays out even if its file survived a restart.
      return cards.approvedContext(8, 3200, (card) => card.sourceIds.every((id) => this.longTerm?.sourceVisible(id) ?? true));
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

    protected override partnerDoc(): string {
      return `${PARTNER_NOTE}

${super.partnerDoc() || `(${PARTNER_FILE} is empty.)`}`;
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
        if (!lines.includes(IGNORED)) appendFileSync(ignore, `${lines.length && lines.at(-1) !== '' ? '\n' : ''}${IGNORED}\n`, 'utf8');
        untrack(this.memoryDir, IGNORED);
        const tag = SNAPSHOT_TAG(version);
        if (git.listTags().some((t) => t.name === tag)) git.commitAll('Changes from before this start', AUTHOR_APP);
        else git.tag(tag, `The workspace as version ${version} found it`, AUTHOR_APP);
      } catch (err) {
        // runs at build time, before the Core exists; Cormini's Git warnings fall back to the console the same way
        console.warn('[workspaceGit] snapshot failed', err);
      }
    }

    protected override tools(): ToolDef[] {
      const base = super.tools().map((t) => (WRITES[t.name] ? this.committed(t, WRITES[t.name]!) : t));
      return [...base, ...memoryTools({ memory: () => this.longTerm })];
    }

    /** The tool, committing the workspace after each call that succeeded. */
    private committed(base: ToolDef, { ok, verb }: { ok: string; verb: string }): ToolDef {
      return {
        ...base,
        handler: async (args, ctx) => {
          // the repository exists before the first write, so its first commit (checkpoint0) holds the workspace as it was
          this.git.ensureRepo();
          const out = await base.handler(args, ctx);
          if (typeof out === 'string' && out.startsWith(ok)) {
            const message = `Coo ${verb} ${String(args.path ?? '')}`.trim();
            const run = () => this.git.commitAllAsync(message, AUTHOR_COO);
            this.commits = this.commits.then(run, run);
            await this.commits;
          }
          return out;
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
        if (!baseInvoke) throw new Error(`No handler for panel ${panel}`);
        return baseInvoke(panel, method, args);
      };
      return {
        ...decl,
        invoke,
        ...(decl.memory ? { memory: { ...decl.memory, panels, storage } } : { memory: { panels, storage } }),
      };
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
        const proposal = this.growthProposals()?.transition(id, action, String(args[2] ?? ''));
        if (!proposal) throw new Error('The proposal is no longer a candidate. Refresh the list.');
        return proposal;
      }
      if (method === 'growth-proposal-apply') return this.applyGrowthProposal(String(args[0] ?? ''));
      if (method === 'experience-create') {
        const result = this.experienceCards()?.create((args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>);
        if (!result?.ok) throw new Error(result?.errors.join('; ') ?? 'Experience cards are unavailable.');
        return result.card;
      }
      if (method === 'experience-review') {
        const id = String(args[0] ?? ''), action = String(args[1] ?? '');
        if (action !== 'approved' && action !== 'rejected' && action !== 'deprecated') throw new Error('Review action is not supported.');
        const before = this.experienceCards()?.get(id);
        const card = this.experienceCards()?.transition(id, action);
        if (!card) throw new Error('The experience card is no longer in that state. Refresh the list.');
        if (action === 'approved') {
          const context = this.experienceContext();
          if (context) this.core?.injectInternal(context, 'memory');
        } else if (action === 'deprecated') {
          this.core?.injectInternal(`[memory] The user revoked the experience policy “${before?.title ?? id}”. Do not follow it anymore. ${this.experienceContext() || 'No approved experience policies remain active.'}`, 'memory');
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
        return [briefing?.text?.trim(), this.experienceContext()].filter(Boolean).join('\n\n') || null;
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
          continue;
        }
        latest = said;
        const documentId = this.longTerm?.retainUser(said, { session: 'main', cursor: event.cursor, timestamp: event.ts });
        this.lastUserMemory = documentId ? { documentId, at: Date.now() } : null;
      }

      if (!latest || !this.longTerm?.enabled()) return;
      const recalled = await this.longTerm.recallForTurn(latest);
      if (recalled.text) this.core?.injectInternal(recalled.text, 'memory');
      else if (recalled.route === 'deep') {
        this.core?.injectInternal('[memory] No verified record was found for that question. If you are not sure, say so; do not invent dates, names or past events.', 'memory');
      }
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
        '[system] The handoff is done. The context before it is cleared; the files in your workspace are all still there. ',
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
