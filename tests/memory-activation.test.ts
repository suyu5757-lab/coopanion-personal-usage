import { describe, expect, it } from 'vitest';
import { ACTIVATION_DAY_MS, DEFAULT_ACTIVATION_PARAMETERS, activationAt } from '../core/memory/activation.ts';

describe('memory activation decay', () => {
  it('follows the candidate 100-day half-life examples without deleting or mutating the anchor', () => {
    const anchor = { weight: 0.8, at: 0 };
    const values = [0, 100, 200, 400].map((days) => activationAt(anchor, days * ACTIVATION_DAY_MS));

    expect(values[0]).toBeCloseTo(0.8, 12);
    expect(values[1]).toBeCloseTo(0.4, 12);
    expect(values[2]).toBeCloseTo(0.2, 12);
    expect(values[3]).toBeCloseTo(0.05, 12);
    expect(anchor).toEqual({ weight: 0.8, at: 0 });
    expect(DEFAULT_ACTIVATION_PARAMETERS).toEqual({ version: 'activation-v1', halfLifeDays: 100, epsilon: 0.001 });
  });

  it('is monotone over time and keeps a nonzero activation floor for a retained source', () => {
    const anchor = { weight: 0.8, at: '2026-01-01T00:00:00.000Z' };
    const values = [0, 1, 7, 30, 100, 200, 400, 2_000].map((days) =>
      activationAt(anchor, Date.parse(anchor.at) + days * ACTIVATION_DAY_MS),
    );

    expect(values.every((value) => value > 0)).toBe(true);
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeLessThanOrEqual(values[i - 1]!);
    expect(values.at(-1)).toBe(0.001);
  });

  it('does not increase activation for a clock earlier than its anchor', () => {
    const anchor = { weight: 0.6, at: '2026-05-10T12:00:00.000Z' };
    expect(activationAt(anchor, '2026-05-01T12:00:00.000Z')).toBe(0.6);
  });

  it('allows the half-life and floor to be calibrated independently', () => {
    const anchor = { weight: 0.8, at: 0 };
    expect(activationAt(anchor, 100 * ACTIVATION_DAY_MS, { halfLifeDays: 200, epsilon: 0.0001 })).toBeCloseTo(Math.sqrt(0.32), 12);
    expect(activationAt(anchor, 1_000_000 * ACTIVATION_DAY_MS, { halfLifeDays: 200, epsilon: 0.02 })).toBe(0.02);
  });

  it('rejects invalid time and decay parameters', () => {
    const anchor = { weight: 0.8, at: 0 };
    expect(() => activationAt(anchor, Number.NaN)).toThrow('activation timestamp');
    expect(() => activationAt({ weight: Number.NaN, at: 0 }, 0)).toThrow('anchor weight');
    expect(() => activationAt(anchor, 0, { halfLifeDays: 0, epsilon: 0.001 })).toThrow('half-life');
    expect(() => activationAt(anchor, 0, { halfLifeDays: 100, epsilon: 0 })).toThrow('activation floor');
  });
});
