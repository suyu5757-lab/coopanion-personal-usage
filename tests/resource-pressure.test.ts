import { describe, expect, it } from 'vitest';
import { parseMacMemoryFreePercent, RESOURCE_PRESSURE_PAUSE_FREE_PERCENT, shouldPauseBackgroundForMemory } from '../core/resource-pressure.ts';

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
});
