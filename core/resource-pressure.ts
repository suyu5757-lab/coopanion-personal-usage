/** Resource reading used to defer background self-time, browser exploration, and growth reviews. */
import { execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

export const RESOURCE_PRESSURE_PAUSE_FREE_PERCENT = 5;
const CACHE_MS = 30_000;

export interface ResourcePressureSnapshot {
  freePercent: number | null;
  paused: boolean;
}

export interface ResourcePressureSource {
  platform: NodeJS.Platform;
  readMacOutput: () => string;
  readMemory: () => { freeBytes: number; totalBytes: number };
}

export function createResourcePressureReader(source: ResourcePressureSource): (now?: number) => ResourcePressureSnapshot {
  let cachedAt = 0;
  let cached: ResourcePressureSnapshot | null = null;
  return (now = Date.now()) => {
    if (cached && now - cachedAt < CACHE_MS) return cached;
    let freePercent: number | null = null;
    if (source.platform === 'darwin') {
      try { freePercent = parseMacMemoryFreePercent(source.readMacOutput()); }
      catch { /* Fall back to the operating-system free-memory reading. */ }
    }
    if (freePercent === null) {
      try {
        const { freeBytes, totalBytes } = source.readMemory();
        const percent = Math.round(freeBytes / totalBytes * 100);
        if (Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0
          && freeBytes >= 0 && percent >= 0 && percent <= 100) freePercent = percent;
      } catch { /* An unavailable reading leaves the pressure state unknown. */ }
    }
    cachedAt = now;
    cached = { freePercent, paused: shouldPauseBackgroundForMemory(freePercent) };
    return cached;
  };
}

export function parseMacMemoryFreePercent(output: string): number | null {
  const value = output.match(/System-wide memory free percentage:\s*(\d+)%/i)?.[1];
  if (value === undefined) return null;
  const percent = Number(value);
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

export function shouldPauseBackgroundForMemory(freePercent: number | null): boolean {
  return freePercent !== null && freePercent < RESOURCE_PRESSURE_PAUSE_FREE_PERCENT;
}

export function selfTimeTickDelayMs(
  selfTime: { enabled: boolean; afterMinutes: number },
  fallbackIntervalMinutes: number | null | undefined,
  pressurePaused: boolean,
): number | null {
  if (selfTime.enabled) return pressurePaused ? null : selfTime.afterMinutes * 60_000;
  return fallbackIntervalMinutes == null ? null : fallbackIntervalMinutes * 60_000;
}

export function selfTimeScheduleNeedsRearm(
  previous: { enabled: boolean; afterMinutes: number },
  next: { enabled: boolean; afterMinutes: number },
  wasPressurePaused: boolean,
  isPressurePaused: boolean,
): boolean {
  return previous.enabled !== next.enabled || previous.afterMinutes !== next.afterMinutes
    || (wasPressurePaused !== isPressurePaused && (previous.enabled || next.enabled));
}

const systemResourcePressure = createResourcePressureReader({
  platform: process.platform,
  readMacOutput: () => execFileSync('memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }),
  readMemory: () => ({ freeBytes: freemem(), totalBytes: totalmem() }),
});

export function readResourcePressure(now = Date.now()): ResourcePressureSnapshot {
  return systemResourcePressure(now);
}
