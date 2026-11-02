/**
 * When Coo's next self-review is due. The state lives in `growth.json`; the Core timer only wakes a
 * running app, so a review missed while the app was closed runs at the next quiet moment after start.
 */
import type { TimersApi } from 'cortico/core/types.ts';
import { randomUUID } from 'node:crypto';
import { asRecord, field, readState, writeState } from '../state-file.ts';
import { GROWTH_QUIET_MINUTES, GROWTH_RETRY_MINUTES, type GrowthConfig } from './config.ts';
import type { GrowthLog, GrowthRunResult } from './review.ts';

const GROWTH_TIMER = 'growth';
const CHECK_MS = 5 * 60_000;
const QUIET_MS = GROWTH_QUIET_MINUTES * 60_000;
const RETRY_MS = GROWTH_RETRY_MINUTES * 60_000;

type GrowthRunStatus = 'ok' | 'failed' | 'interrupted';

interface GrowthState {
  lastReviewAt: string | null;
  nextReviewAt: string;
  lastStatus?: GrowthRunStatus;
  lastError?: string;
  lastProposalCount?: number;
  lastFinishedAt?: string;
  /** Present only while a review is running; a value at startup means the process died mid-run. */
  activeRunId?: string;
  activeStartedAt?: string;
}

export interface GrowthScheduleDeps {
  stateFile: string;
  config: () => GrowthConfig;
  timers: TimersApi;
  run: () => Promise<void | GrowthRunResult>;
  now?: () => Date;
  log?: GrowthLog;
  /** True while the app is paused: no background review starts. */
  paused?: () => boolean;
  /** True while a growth fork still runs; a timed-out fork must not be joined by another. */
  forkRunning?: () => boolean;
  /** False until the local cancellation and background budget gates are accepted. */
  allowed?: () => boolean;
}

const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

const addDays = (date: Date, days: number): string => new Date(date.getTime() + days * 86_400_000).toISOString();

/** The review interval used for the running process; a test may drive `check` directly. */
export const GROWTH_CHECK_MS = CHECK_MS;

export class GrowthSchedule {
  private state: GrowthState | null = null;
  private running = false;
  private started = false;
  private lastActivityAt = 0;
  private readonly now: () => Date;
  private readonly log?: GrowthLog;

  constructor(private readonly d: GrowthScheduleDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log;
  }

  status(): {
    enabled: boolean;
    everyDays: number;
    paused: boolean;
    blocked: boolean;
    forkRunning: boolean;
    lastReviewAt: string | null;
    nextReviewAt: string | null;
    lastStatus: GrowthRunStatus | null;
    lastError: string | null;
    lastProposalCount: number | null;
    lastFinishedAt: string | null;
    activeRun: boolean;
  } {
    const state = this.state;
    const allowed = this.d.allowed?.() ?? true;
    return {
      enabled: this.d.config().enabled && allowed,
      everyDays: this.d.config().everyDays,
      paused: this.d.paused?.() ?? false,
      blocked: this.d.config().enabled && !allowed,
      forkRunning: this.d.forkRunning?.() ?? false,
      lastReviewAt: state?.lastReviewAt ?? null,
      nextReviewAt: state?.nextReviewAt ?? null,
      lastStatus: state?.lastStatus ?? null,
      lastError: state?.lastError ?? null,
      lastProposalCount: state?.lastProposalCount ?? null,
      lastFinishedAt: state?.lastFinishedAt ?? null,
      activeRun: this.running || !!state?.activeRunId,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastActivityAt = this.now().getTime();
    this.d.timers.onDue((entry) => {
      if (entry.payload?.kind === GROWTH_TIMER) {
        void this.check().catch((err) => this.log?.warn('[growth] check failed', { err: err instanceof Error ? err.message : String(err) }));
      }
    });
    this.reload();
    this.reconcileInterrupted();
  }

  /** A run marked active at startup has no fork behind it in this process. */
  private reconcileInterrupted(): void {
    if (!this.state?.activeRunId || this.running || this.d.forkRunning?.()) return;
    const at = this.now().toISOString();
    this.save({
      ...this.state,
      lastStatus: 'interrupted',
      lastError: 'the app stopped during a self-review',
      lastFinishedAt: at,
      activeRunId: undefined,
      activeStartedAt: undefined,
    });
  }

  /** Re-reads the interval and re-arms after `companion.growth` changes. */
  restart(): void {
    if (!this.started) {
      this.start();
      return;
    }
    try {
      this.reload(true);
    } catch (err) {
      this.log?.warn('[growth] could not re-arm the review schedule', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** An external event means the person is around; a due review waits for quiet again. */
  noteActivity(): void {
    this.lastActivityAt = this.now().getTime();
  }

  /** Runs one review when it is due and quiet. Returns whether a review ran. */
  async check(): Promise<boolean> {
    const config = this.d.config();
    if (!config.enabled || !(this.d.allowed?.() ?? true) || this.running || !this.state || this.d.paused?.()) return false;
    if (this.d.forkRunning?.()) return false;
    const now = this.now();
    if (Date.parse(this.state.nextReviewAt) > now.getTime()) return false;
    if (now.getTime() - this.lastActivityAt < QUIET_MS) return false;
    this.running = true;
    const runId = randomUUID();
    this.save({ ...this.state, activeRunId: runId, activeStartedAt: now.toISOString() });
    this.log?.info('[growth] self-review started', { dueAt: this.state.nextReviewAt, runId });
    try {
      const result = await this.d.run();
      const finishedAt = this.now();
      this.save({
        lastReviewAt: finishedAt.toISOString(),
        nextReviewAt: addDays(finishedAt, config.everyDays),
        lastStatus: result?.cancelled ? 'failed' : 'ok',
        ...(result?.cancelled ? { lastError: result.cancellationStatus === 'unknown'
          ? 'Core cancellation timed out; tracked fork work remains unresolved'
          : result.cancellationStatus === 'acknowledged'
            ? 'Core acknowledged cancellation after tracked fork work ended'
            : result.cancellationStatus === 'shutdown'
              ? 'Core shut down before the review completed'
              : 'the review deadline passed before it finished' } : {}),
        lastFinishedAt: finishedAt.toISOString(),
        lastProposalCount: result?.proposals ?? 0,
      });
    } catch (err) {
      const finishedAt = this.now();
      const message = err instanceof Error ? err.message : String(err);
      this.log?.warn('[growth] self-review failed', { err: message, runId });
      this.save({
        lastReviewAt: this.state.lastReviewAt,
        nextReviewAt: new Date(finishedAt.getTime() + RETRY_MS).toISOString(),
        lastStatus: 'failed',
        lastError: message.slice(0, 500),
        lastFinishedAt: finishedAt.toISOString(),
      });
    } finally {
      this.running = false;
      this.arm();
    }
    return true;
  }

  /** The persisted schedule and the last run's outcome, for diagnostics. */
  snapshot(): Readonly<GrowthState> | null {
    return this.state;
  }

  private reload(recompute = false): void {
    const config = this.d.config();
    try {
      this.state = this.load();
    } catch (err) {
      this.log?.warn('[growth] could not read the review schedule', { err: err instanceof Error ? err.message : String(err) });
      this.state = null;
      return;
    }
    if (recompute && this.state) {
      const base = this.state.lastReviewAt ? new Date(this.state.lastReviewAt) : this.now();
      this.state = {
        ...this.state,
        nextReviewAt: addDays(base, config.everyDays),
      };
      this.save(this.state);
    }
    this.arm();
  }

  private load(): GrowthState {
    const restored = readState(this.d.stateFile, (value) => {
      const record = asRecord(value);
      const last = field(record, 'lastReviewAt', (v): v is string | null => v === null || isIso(v));
      const next = field(record, 'nextReviewAt', isIso);
      const optional = <T>(key: string, is: (v: unknown) => v is T): T | undefined =>
        record[key] === undefined ? undefined : field(record, key, is);
      const isStatus = (v: unknown): v is GrowthRunStatus => v === 'ok' || v === 'failed' || v === 'interrupted';
      const isText = (v: unknown): v is string => typeof v === 'string';
      const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
      const state: GrowthState = { lastReviewAt: last, nextReviewAt: next };
      const status = optional('lastStatus', isStatus);
      const error = optional('lastError', isText);
      const proposals = optional('lastProposalCount', isCount);
      const finished = optional('lastFinishedAt', isIso);
      const runId = optional('activeRunId', isText);
      const started = optional('activeStartedAt', isIso);
      if (status) state.lastStatus = status;
      if (error) state.lastError = error;
      if (proposals !== undefined) state.lastProposalCount = proposals;
      if (finished) state.lastFinishedAt = finished;
      if (runId) state.activeRunId = runId;
      if (started) state.activeStartedAt = started;
      return state;
    });
    if (!restored) {
      const state: GrowthState = { lastReviewAt: null, nextReviewAt: addDays(this.now(), this.d.config().everyDays) };
      this.save(state);
      return state;
    }
    return restored;
  }

  private save(state: GrowthState): void {
    this.state = state;
    try {
      writeState(this.d.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      this.log?.warn('[growth] could not save the review schedule', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The timer is only a wake-up for a running app; a due review is picked up by the periodic check. */
  private arm(): void {
    this.cancelTimers();
    if (!this.d.config().enabled || !(this.d.allowed?.() ?? true) || !this.state) return;
    const at = Date.parse(this.state.nextReviewAt);
    if (at <= this.now().getTime()) return;
    const result = this.d.timers.set(this.state.nextReviewAt, { kind: GROWTH_TIMER });
    if (!result.ok) this.log?.warn('[growth] could not arm the review timer', { error: result.error });
  }

  private cancelTimers(): void {
    for (const entry of this.d.timers.list()) {
      if (entry.payload?.kind === GROWTH_TIMER) this.d.timers.cancel(entry.id);
    }
  }
}
