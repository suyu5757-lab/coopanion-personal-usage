/** Resource reading used to pause non-interactive browser exploration and growth reviews. */
import { execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

export const RESOURCE_PRESSURE_PAUSE_FREE_PERCENT = 20;
const CACHE_MS = 30_000;
let cachedAt = 0;
let cached: { freePercent: number | null; paused: boolean } | null = null;

export function parseMacMemoryFreePercent(output: string): number | null {
  const value = output.match(/System-wide memory free percentage:\s*(\d+)%/i)?.[1];
  if (value === undefined) return null;
  const percent = Number(value);
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

export function shouldPauseBackgroundForMemory(freePercent: number | null): boolean {
  return freePercent !== null && freePercent < RESOURCE_PRESSURE_PAUSE_FREE_PERCENT;
}

export function readResourcePressure(now = Date.now()): { freePercent: number | null; paused: boolean } {
  if (cached && now - cachedAt < CACHE_MS) return cached;
  let freePercent: number | null = null;
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
      freePercent = parseMacMemoryFreePercent(output);
    } catch { /* Fall back to the operating-system free-memory reading. */ }
  }
  if (freePercent === null) {
    const total = totalmem();
    if (total > 0) freePercent = Math.round(freemem() / total * 100);
  }
  cachedAt = now;
  cached = { freePercent, paused: shouldPauseBackgroundForMemory(freePercent) };
  return cached;
}
