import { describe, expect, it } from 'vitest';
import {
  createResourcePressureReader,
  parseMacMemoryFreePercent,
  RESOURCE_PRESSURE_PAUSE_FREE_PERCENT,
  selfTimeScheduleNeedsRearm,
  selfTimeTickDelayMs,
  shouldPauseBackgroundForMemory,
} from '../core/resource-pressure.ts';

describe('background memory pressure policy', () => {
  it('parses only valid macOS free-memory percentages', () => {
    expect(parseMacMemoryFreePercent('System-wide memory free percentage: 19%')).toBe(19);
    expect(parseMacMemoryFreePercent('System-wide memory free percentage: 100%')).toBe(100);
    expect(parseMacMemoryFreePercent('System-wide memory free percentage: 101%')).toBeNull();
    expect(parseMacMemoryFreePercent('memory pressure output changed')).toBeNull();
  });

  it('pauses only below the exported free-memory threshold', () => {
    expect(shouldPauseBackgroundForMemory(null)).toBe(false);
    expect(shouldPauseBackgroundForMemory(RESOURCE_PRESSURE_PAUSE_FREE_PERCENT)).toBe(false);
    expect(shouldPauseBackgroundForMemory(RESOURCE_PRESSURE_PAUSE_FREE_PERCENT - 1)).toBe(true);
  });

  it('falls back from an invalid macOS reading and refreshes only after the cache expires', () => {
    let output = 'unrecognized output';
    let freeBytes = 19;
    let macReads = 0;
    let memoryReads = 0;
    const read = createResourcePressureReader({
      platform: 'darwin',
      readMacOutput: () => { macReads++; return output; },
      readMemory: () => { memoryReads++; return { freeBytes, totalBytes: 100 }; },
    });

    expect(read(0)).toEqual({ freePercent: 19, paused: true });
    output = 'System-wide memory free percentage: 20%';
    freeBytes = 90;
    expect(read(29_999)).toEqual({ freePercent: 19, paused: true });
    expect(read(30_000)).toEqual({ freePercent: 20, paused: false });
    expect({ macReads, memoryReads }).toEqual({ macReads: 2, memoryReads: 1 });
  });

  it('leaves unavailable readings unknown and does not pause on the unknown value', () => {
    const read = createResourcePressureReader({
      platform: 'darwin',
      readMacOutput: () => 'unrecognized output',
      readMemory: () => ({ freeBytes: 0, totalBytes: 0 }),
    });

    expect(read(0)).toEqual({ freePercent: null, paused: false });
  });

  it('removes the self-time heartbeat while paused and rearms when pressure changes', () => {
    const selfTime = { enabled: true, afterMinutes: 3 };
    expect(selfTimeTickDelayMs(selfTime, null, false)).toBe(180_000);
    expect(selfTimeTickDelayMs(selfTime, null, true)).toBeNull();
    expect(selfTimeTickDelayMs({ ...selfTime, enabled: false }, 2, true)).toBe(120_000);
    expect(selfTimeScheduleNeedsRearm(selfTime, selfTime, false, true)).toBe(true);
    expect(selfTimeScheduleNeedsRearm({ ...selfTime, enabled: false }, { ...selfTime, enabled: false }, false, true)).toBe(false);
  });
});
