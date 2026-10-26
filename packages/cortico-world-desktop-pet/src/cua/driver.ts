/**
 * Client for the Cua Driver daemon (trycua/cua): window-scoped screenshots and background input.
 * The daemon holds Accessibility and Screen Recording, draws its own cursor, and posts input to one
 * window without moving the person's pointer or changing the frontmost app. Calls go through the
 * installed `cua-driver` CLI, so a daemon crash takes down neither this process nor Core.
 *
 * The daemon is started on first use when it is not already running. Captures come back as PNG and
 * are converted to JPEG with `sips`; actions take screenshot-pixel coordinates from the latest
 * capture. `element_token` clicks are deliberately not used: Cua Driver 0.37.0 crashes on them on
 * macOS 26, while a window-local pixel click works.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import jpeg from 'jpeg-js';

const DRIVER_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 20 * 1024 * 1024;
const FIXED_BINARIES = [
  '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
  join(homedir(), '.local/bin/cua-driver'),
  join(homedir(), '.cua-driver/bin/cua-driver'),
];

export type DriverEffect = 'confirmed' | 'unverifiable' | 'suspected_noop' | 'partial' | 'refused';

/** What one action reports; `effect` is the driver's own read-back confidence. */
export interface DriverAction {
  effect: DriverEffect;
  summary: string;
  hint?: string;
  route?: string;
  code?: string;
}

/** One window capture; sizes and scale are the screenshot's, and coordinates later used are its pixels. */
export interface DriverCapture {
  pid: number;
  windowId: number;
  title: string;
  width: number;
  height: number;
  scale: number;
  captureId: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  jpeg: Buffer;
}

export interface DriverZoom {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** One chord of a key sequence, in Cua Driver's vocabulary. */
export interface DriverChord {
  modifiers: string[];
  key: string;
}

export type DriverKeyError =
  | { error: 'empty' }
  | { error: 'oneKey' }
  | { error: 'unsupported'; key: string };

export interface CaptureOptions {
  screenshot: boolean;
  maxDimension: number;
  quality: number;
  signal?: AbortSignal;
}

export interface ActionOptions {
  signal?: AbortSignal;
}

/** A failure the driver worded itself; `code` is the driver's error code when it gave one. */
export class DriverFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DriverFailure';
  }
}

export interface CuaDriverLike {
  available(): boolean;
  capture(pid: number, windowId: number, opts: CaptureOptions): Promise<DriverCapture>;
  click(pid: number, windowId: number, x: number, y: number, captureId: string, opts?: ActionOptions & { button?: 'left' | 'right' | 'middle'; count?: number }): Promise<DriverAction>;
  type(pid: number, windowId: number, text: string, opts?: ActionOptions): Promise<DriverAction>;
  key(pid: number, windowId: number, chords: DriverChord[], opts?: ActionOptions): Promise<DriverAction>;
  scroll(pid: number, windowId: number, x: number, y: number, down: number, right: number, opts?: ActionOptions): Promise<DriverAction>;
  drag(pid: number, windowId: number, from: [number, number], to: [number, number], opts?: ActionOptions): Promise<DriverAction>;
  move(pid: number, windowId: number, x: number, y: number, opts?: ActionOptions): Promise<DriverAction>;
  zoom(pid: number, windowId: number, x: number, y: number, width: number, height: number, opts?: ActionOptions): Promise<DriverZoom>;
}

const MODIFIERS = new Set(['cmd', 'shift', 'option', 'ctrl', 'fn']);
const ALIASES: Record<string, string> = {
  command: 'cmd', win: 'cmd', windows: 'cmd', meta: 'cmd', super: 'cmd',
  control: 'ctrl', alt: 'option',
  return: 'return', enter: 'return', esc: 'escape',
  del: 'delete', ins: 'insert', pgup: 'pageup', pgdn: 'pagedown',
  plus: '+', minus: '-',
};
const UNSUPPORTED = new Set([
  'printscreen', 'prtsc', 'menu', 'apps', 'contextmenu', 'capslock', 'insert', 'ins',
  'volumeup', 'volumedown', 'volumemute', 'mute', 'playpause',
]);

/** Turns `pet_cua_key`'s "ctrl+s delete" into Cua Driver chords. `parseKeys` has already validated names. */
export function driverKeyChords(spec: string): DriverChord[] | DriverKeyError {
  const out: DriverChord[] = [];
  for (const part of spec.trim().split(/\s+/)) {
    if (!part) continue;
    const names = part === '+' ? ['plus'] : part.endsWith('++') ? [...part.slice(0, -2).split('+'), 'plus'] : part.split('+');
    const modifiers: string[] = [];
    const keys: string[] = [];
    for (const raw of names) {
      const name = raw.trim().toLowerCase();
      if (!name) continue;
      const mapped = ALIASES[name] ?? name;
      if (MODIFIERS.has(mapped)) {
        modifiers.push(mapped);
        continue;
      }
      if (UNSUPPORTED.has(name) || /^f(1[3-9]|2[0-4])$/.test(name)) return { error: 'unsupported', key: name };
      keys.push(mapped);
    }
    if (keys.length !== 1) return { error: 'oneKey' };
    out.push({ modifiers, key: keys[0]! });
  }
  return out.length ? out : { error: 'empty' };
}

function findBin(): string | null {
  const env = process.env.CUA_DRIVER_BIN;
  if (env) return existsSync(env) ? env : null;
  for (const path of FIXED_BINARIES) if (existsSync(path)) return path;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, 'cua-driver');
    if (existsSync(path)) return path;
  }
  return null;
}

interface RunOptions {
  timeout: number;
  signal?: AbortSignal;
}

function runFile(file: string, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, maxBuffer: MAX_OUTPUT, signal: options.signal }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
        e.stdout = String(stdout ?? '');
        e.stderr = String(stderr ?? '');
        reject(e);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new Error(`Cua Driver returned no JSON: ${trimmed.slice(0, 200)}`);
  }
}

function failureFrom(err: unknown): DriverFailure {
  if (err instanceof DriverFailure) return err;
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean; signal?: string };
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
    return new DriverFailure('aborted', 'The Cua Driver call was interrupted');
  }
  if (e.killed && e.signal === 'SIGTERM') {
    return new DriverFailure('timeout', 'Cua Driver did not answer in time');
  }
  let raw: Record<string, unknown> | null = null;
  try {
    raw = e.stdout ? parseJson<Record<string, unknown>>(e.stdout) : null;
  } catch {
    raw = null;
  }
  const nested = raw?.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : raw;
  const message = String(nested?.summary ?? nested?.message ?? nested?.hint ?? raw?.summary ?? raw?.message ?? e.stderr ?? e.message ?? 'Cua Driver failed').trim();
  const code = String(nested?.error_code ?? nested?.code ?? raw?.error_code ?? e.code ?? 'driver_failed');
  return new DriverFailure(code, message);
}

function actionFrom(raw: Record<string, unknown>): DriverAction {
  const effect = typeof raw.effect === 'string' ? raw.effect : 'unverifiable';
  const errorCode = String(raw.error_code ?? '');
  const code = String(raw.error_code ?? raw.code ?? '');
  const summary = String(raw.summary ?? raw.hint ?? raw.error ?? '').trim();
  if (raw.is_error === true || effect === 'refused' || errorCode) {
    throw new DriverFailure(errorCode || 'refused', summary || 'Cua Driver refused the action');
  }
  const known = ['confirmed', 'unverifiable', 'suspected_noop', 'partial', 'refused'];
  return {
    effect: (known.includes(effect) ? effect : 'unverifiable') as DriverEffect,
    summary,
    hint: typeof raw.hint === 'string' ? raw.hint : undefined,
    route: typeof raw.route === 'string' ? raw.route : undefined,
    code: code || undefined,
  };
}

export class CuaDriver implements CuaDriverLike {
  private starting: Promise<void> | null = null;

  constructor(private readonly session = 'coo') {}

  available(): boolean {
    return process.platform === 'darwin' && findBin() !== null;
  }

  async capture(pid: number, windowId: number, opts: CaptureOptions): Promise<DriverCapture> {
    const dir = mkdtempSync(join(tmpdir(), 'coo-window-'));
    const png = join(dir, 'window.png');
    const jpg = join(dir, 'window.jpg');
    try {
      const raw = await this.call<Record<string, unknown>>('get_window_state', {
        pid,
        window_id: windowId,
        include_accessibility_tree: false,
        include_screenshot: opts.screenshot,
        max_dimension: Math.max(320, Math.round(opts.maxDimension)),
      }, { signal: opts.signal, screenshotFile: opts.screenshot ? png : undefined });
      let bytes = Buffer.alloc(0);
      let width = Number(raw.screenshot_width ?? 0);
      let height = Number(raw.screenshot_height ?? 0);
      if (opts.screenshot) {
        await runFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(Math.max(1, Math.min(100, Math.round(opts.quality)))), png, '--out', jpg], { timeout: 15_000, signal: opts.signal });
        bytes = readFileSync(jpg);
        if (!width || !height) {
          const img = jpeg.decode(bytes);
          width = img.width;
          height = img.height;
        }
      }
      const bounds = raw.window_bounds && typeof raw.window_bounds === 'object' ? raw.window_bounds as DriverCapture['bounds'] : null;
      return {
        pid,
        windowId,
        title: String(raw.app_name ?? raw.window_title ?? ''),
        width,
        height,
        scale: Number(raw.screenshot_scale ?? 1),
        captureId: String(raw.capture_id ?? ''),
        bounds,
        jpeg: bytes,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  click(pid: number, windowId: number, x: number, y: number, captureId: string, opts?: ActionOptions & { button?: 'left' | 'right' | 'middle'; count?: number }): Promise<DriverAction> {
    return this.action('click', {
      pid,
      window_id: windowId,
      x,
      y,
      capture_id: captureId,
      button: opts?.button ?? 'left',
      count: opts?.count ?? 1,
      delivery_mode: 'background',
    }, opts);
  }

  type(pid: number, windowId: number, text: string, opts?: ActionOptions): Promise<DriverAction> {
    return this.action('type_text', { pid, window_id: windowId, text, delivery_mode: 'background' }, opts);
  }

  async key(pid: number, windowId: number, chords: DriverChord[], opts?: ActionOptions): Promise<DriverAction> {
    let last: DriverAction | null = null;
    for (const chord of chords) {
      last = chord.modifiers.length
        ? await this.action('hotkey', { pid, window_id: windowId, keys: [...chord.modifiers, chord.key], delivery_mode: 'background' }, opts)
        : await this.action('press_key', { pid, window_id: windowId, key: chord.key, delivery_mode: 'background' }, opts);
    }
    return last ?? { effect: 'unverifiable', summary: '' };
  }

  async scroll(pid: number, windowId: number, x: number, y: number, down: number, right: number, opts?: ActionOptions): Promise<DriverAction> {
    let last: DriverAction | null = null;
    if (down) last = await this.action('scroll', { pid, window_id: windowId, x, y, direction: down > 0 ? 'down' : 'up', amount: Math.abs(down), delivery_mode: 'background' }, opts);
    if (right) last = await this.action('scroll', { pid, window_id: windowId, x, y, direction: right > 0 ? 'right' : 'left', amount: Math.abs(right), delivery_mode: 'background' }, opts);
    return last ?? { effect: 'unverifiable', summary: '' };
  }

  drag(pid: number, windowId: number, from: [number, number], to: [number, number], opts?: ActionOptions): Promise<DriverAction> {
    return this.action('drag', {
      pid,
      window_id: windowId,
      from_x: from[0],
      from_y: from[1],
      to_x: to[0],
      to_y: to[1],
      delivery_mode: 'background',
    }, opts);
  }

  move(pid: number, windowId: number, x: number, y: number, opts?: ActionOptions): Promise<DriverAction> {
    return this.action('move_cursor', { target: { kind: 'window', pid, window_id: windowId }, x, y }, opts);
  }

  async zoom(pid: number, windowId: number, x: number, y: number, width: number, height: number, opts?: ActionOptions): Promise<DriverZoom> {
    const dir = mkdtempSync(join(tmpdir(), 'coo-zoom-'));
    const file = join(dir, 'zoom.jpg');
    try {
      await this.call<Record<string, unknown>>('zoom', {
        pid,
        window_id: windowId,
        x1: x,
        y1: y,
        x2: x + width,
        y2: y + height,
      }, { signal: opts?.signal, screenshotFile: file });
      const bytes = readFileSync(file);
      const img = jpeg.decode(bytes);
      return { jpeg: bytes, width: img.width, height: img.height };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async action(tool: string, args: Record<string, unknown>, opts?: ActionOptions): Promise<DriverAction> {
    return actionFrom(await this.call<Record<string, unknown>>(tool, args, opts));
  }

  private async call<T>(tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; screenshotFile?: string } = {}): Promise<T> {
    try {
      const bin = await this.ensure(opts.signal);
      const argv = ['call', tool, JSON.stringify({ session: this.session, ...args })];
      if (opts.screenshotFile) argv.push('--screenshot-out-file', opts.screenshotFile);
      const { stdout } = await runFile(bin, argv, { timeout: DRIVER_TIMEOUT_MS, signal: opts.signal });
      return parseJson<T>(stdout);
    } catch (err) {
      throw failureFrom(err);
    }
  }

  private async ensure(signal?: AbortSignal): Promise<string> {
    const bin = findBin();
    if (!bin) throw new DriverFailure('not_installed', 'cua-driver was not found');
    if (await this.running(bin)) return bin;
    if (!this.starting) this.starting = this.start(bin, signal).finally(() => { this.starting = null; });
    await this.starting;
    if (!(await this.running(bin))) throw new DriverFailure('daemon_start_failed', 'Cua Driver did not start');
    return bin;
  }

  private async running(bin: string): Promise<boolean> {
    try {
      const { stdout } = await runFile(bin, ['status'], { timeout: 4_000 });
      return /daemon is running/i.test(stdout);
    } catch {
      return false;
    }
  }

  private async start(bin: string, signal?: AbortSignal): Promise<void> {
    spawn(bin, ['serve'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) {
      if (signal?.aborted) throw new DriverFailure('aborted', 'The Cua Driver call was interrupted');
      await sleep(250, undefined, { signal });
      if (await this.running(bin)) return;
    }
  }
}
