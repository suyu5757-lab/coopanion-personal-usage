/**
 * When Coo's next self-review is due. The state lives in `growth.json`; the Core timer only wakes a
 * running app, so a review missed while the app was closed runs at the next quiet moment after start.
 */
import type { TimersApi } from 'cortico/core/types.ts';
import { asRecord, field, readState, writeState } from '../state-file.ts';
import { GROWTH_QUIET_MINUTES, GROWTH_RETRY_MINUTES, type GrowthConfig } from './config.ts';
import type { GrowthLog } from './review.ts';

const GROWTH_TIMER = 'growth';
const CHECK_MS = 5 * 60_000;
const QUIET_MS = GROWTH_QUIET_MINUTES * 60_000;
const RETRY_MS = GROWTH_RETRY_MINUTES * 60_000;

interface GrowthState {
  lastReviewAt: string | null;
  nextReviewAt: string;
}

export interface GrowthScheduleDeps {
  stateFile: string;
  config: () => GrowthConfig;
  timers: TimersApi;
  run: () => Promise<void>;
  now?: () => Date;
  log?: GrowthLog;
  /** True while the app is paused: no background review starts. */
  paused?: () => boolean;
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
    if (!config.enabled || this.running || !this.state || this.d.paused?.()) return false;
    const now = this.now();
    if (Date.parse(this.state.nextReviewAt) > now.getTime()) return false;
    if (now.getTime() - this.lastActivityAt < QUIET_MS) return false;
    this.running = true;
    this.log?.info('[growth] self-review started', { dueAt: this.state.nextReviewAt });
    try {
      await this.d.run();
      const finishedAt = this.now();
      this.save({
        lastReviewAt: finishedAt.toISOString(),
        nextReviewAt: addDays(finishedAt, config.everyDays),
      });
    } catch (err) {
      const finishedAt = this.now();
      this.log?.warn('[growth] self-review failed', { err: err instanceof Error ? err.message : String(err) });
      this.save({
        lastReviewAt: this.state.lastReviewAt,
        nextReviewAt: new Date(finishedAt.getTime() + RETRY_MS).toISOString(),
      });
    } finally {
      this.running = false;
      this.arm();
    }
    return true;
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
        lastReviewAt: this.state.lastReviewAt,
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
      return { lastReviewAt: last, nextReviewAt: next };
    });
    if (restored) return restored;
    const state: GrowthState = { lastReviewAt: null, nextReviewAt: addDays(this.now(), this.d.config().everyDays) };
    this.save(state);
    return state;
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
    if (!this.d.config().enabled || !this.state) return;
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
