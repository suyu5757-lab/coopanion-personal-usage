/** `companion.selfTime`: when Coo may take time of her own, how long, and what the browser may do. */
import { getByPath } from 'cortico/core/config-schema.ts';

export interface SelfTimeConfig {
  /** Off: the heartbeat stays as Cormini's (`tick.intervalMinutes`), usually silent. */
  enabled: boolean;
  /** Minutes without a chat before Coo gets a turn of her own. */
  afterMinutes: number;
  /** The most minutes one browser session may run; ignored while `sessionUnlimited` is on. */
  sessionMinutes: number;
  /** No time limit on a session; it ends when she closes the browser or the call budget runs out. */
  sessionUnlimited: boolean;
  /** Play the browser's sound; off by default. */
  sound: boolean;
  /** Allow likes, favorites, follows, comments and danmaku; off makes the browser read-only. */
  actions: boolean;
}

export const SELF_TIME_DEFAULTS: SelfTimeConfig = {
  enabled: true,
  afterMinutes: 20,
  sessionMinutes: 20,
  sessionUnlimited: false,
  sound: false,
  actions: true,
};

/** The settings as the live config has them, with a hand-edited value outside its range clamped to it. */
export function readSelfTime(config: unknown): SelfTimeConfig {
  const raw = getByPath(config as Record<string, unknown>, 'companion.selfTime') as Partial<SelfTimeConfig> | undefined;
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  // a browser World the person switched off in advanced settings leaves the heartbeat as it was
  const world = getByPath(config as Record<string, unknown>, 'worlds.browser.enabled');
  return {
    enabled: bool(raw?.enabled, SELF_TIME_DEFAULTS.enabled) && world !== false,
    afterMinutes: number(raw?.afterMinutes, SELF_TIME_DEFAULTS.afterMinutes, 1, 240),
    sessionMinutes: number(raw?.sessionMinutes, SELF_TIME_DEFAULTS.sessionMinutes, 5, 60),
    sessionUnlimited: bool(raw?.sessionUnlimited, SELF_TIME_DEFAULTS.sessionUnlimited),
    sound: bool(raw?.sound, SELF_TIME_DEFAULTS.sound),
    actions: bool(raw?.actions, SELF_TIME_DEFAULTS.actions),
  };
}

/** The most tool calls one browser session may make, reads included. */
export const SESSION_MAX_CALLS = 80;
/** The simplified element tree returned by a read; longer pages are cut with a note. */
export const CONTENT_MAX = 14_000;
/** The visible page text returned by `browser_text`. */
export const TEXT_MAX = 12_000;
/** The longest `browser_watch`, in seconds; the tool's own schema repeats it. */
export const WATCH_MAX = 30;
/** The most frames one `browser_watch` may take; the tool's own schema repeats it. */
export const WATCH_FRAMES_MAX = 6;
/** The frames `browser_watch` takes when the call names none. */
export const WATCH_FRAMES_DEFAULT = 3;
