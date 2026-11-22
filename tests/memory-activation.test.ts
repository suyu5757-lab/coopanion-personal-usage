import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_DAY_MS,
  DEFAULT_ACTIVATION_PARAMETERS,
  DEFAULT_REINFORCEMENT_PARAMETERS,
  activationAt,
  mentionIntensityForText,
  reinforceActivation,
} from '../core/memory/activation.ts';

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

describe('user mention reinforcement', () => {
  it('classifies casual, detailed, extended and explicitly important user mentions', () => {
    expect(mentionIntensityForText('What did I tell you last time?')).toBe(0.06);
    expect(mentionIntensityForText('details '.repeat(32))).toBe(0.12);
    expect(mentionIntensityForText('details '.repeat(85))).toBe(0.2);
    expect(mentionIntensityForText('以后请记住这个约定')).toBe(0.35);
    expect(mentionIntensityForText('Please remember this from now on.')).toBe(0.35);
  });

  it('boosts the decayed activation by a small verified mention and starts a new anchor', () => {
    const eventAt = 100 * ACTIVATION_DAY_MS;
    const result = reinforceActivation(null, {
      targetCreatedAt: 0,
      occurredAt: eventAt,
      semanticMatch: 0.9,
      intensity: 0.06,
    }, { eventCount: 0, appliedBoost: 0 });

    expect(result.spacingBucket).toBe('initial');
    expect(result.boost).toBeCloseTo(0.054, 12);
    expect(result.state.anchorWeight).toBeCloseTo(0.4324, 12);
    expect(result.state.anchorAt).toBe(new Date(eventAt).toISOString());
    expect(result.state.halfLifeDays).toBe(100);
    expect(result.state.independentMentionCount).toBe(1);
  });

  it('grows stability only for qualified cross-day mentions', () => {
    const first = reinforceActivation(null, {
      targetCreatedAt: 0,
      occurredAt: 0,
      semanticMatch: 1,
      intensity: 0.1,
    }, { eventCount: 0, appliedBoost: 0 });
    const sameDay = reinforceActivation(first.state, {
      targetCreatedAt: 0,
      occurredAt: 60 * 60_000,
      semanticMatch: 1,
      intensity: 0.2,
    }, { eventCount: 0, appliedBoost: 0 });
    const nextDay = reinforceActivation(sameDay.state, {
      targetCreatedAt: 0,
      occurredAt: ACTIVATION_DAY_MS + 60 * 60_000,
      semanticMatch: 0.9,
      intensity: 0.2,
    }, { eventCount: 0, appliedBoost: 0 });

    expect(sameDay.spacingBucket).toBe('same-day');
    expect(sameDay.state.halfLifeDays).toBe(100);
    expect(nextDay.spacingBucket).toBe('cross-day');
    expect(nextDay.state.halfLifeDays).toBeCloseTo(104.5, 12);
  });

  it('never reduces existing stability when a later parameter set lowers the maximum', () => {
    const first = reinforceActivation(null, {
      targetCreatedAt: 0,
      occurredAt: 0,
      semanticMatch: 1,
      intensity: 0.1,
    }, { eventCount: 0, appliedBoost: 0 });
    const result = reinforceActivation(first.state, {
      targetCreatedAt: 0,
      occurredAt: 2 * ACTIVATION_DAY_MS,
      semanticMatch: 1,
      intensity: 0.3,
    }, { eventCount: 0, appliedBoost: 0 }, undefined, {
      ...DEFAULT_REINFORCEMENT_PARAMETERS,
      maxHalfLifeDays: 50,
    });

    expect(result.state.halfLifeDays).toBe(100);
  });

  it('records a capped event without boosting or moving the activation anchor', () => {
    const first = reinforceActivation(null, {
      targetCreatedAt: 0,
      occurredAt: 0,
      semanticMatch: 1,
      intensity: 0.1,
    }, { eventCount: 0, appliedBoost: 0 });
    const capped = reinforceActivation(first.state, {
      targetCreatedAt: 0,
      occurredAt: 2 * ACTIVATION_DAY_MS,
      semanticMatch: 1,
      intensity: 0.3,
    }, { eventCount: DEFAULT_REINFORCEMENT_PARAMETERS.maxDailyEvents, appliedBoost: 0 });

    expect(capped.outcome).toBe('daily-cap');
    expect(capped.appliedBoost).toBe(0);
    expect(capped.state.anchorWeight).toBe(first.state.anchorWeight);
    expect(capped.state.anchorAt).toBe(first.state.anchorAt);
    expect(capped.state.halfLifeDays).toBe(first.state.halfLifeDays);
    expect(capped.state.independentMentionCount).toBe(2);
  });

  it('caps a daily boost and rejects invalid or out-of-order mention evidence', () => {
    const first = reinforceActivation(null, {
      targetCreatedAt: 0,
      occurredAt: 0,
      semanticMatch: 1,
      intensity: 0.2,
    }, { eventCount: 0, appliedBoost: 0 });
    const capped = reinforceActivation(first.state, {
      targetCreatedAt: 0,
      occurredAt: 60 * 60_000,
      semanticMatch: 1,
      intensity: 0.2,
    }, { eventCount: 1, appliedBoost: DEFAULT_REINFORCEMENT_PARAMETERS.maxDailyBoost - 0.01 });

    expect(capped.appliedBoost).toBeCloseTo(0.01, 12);
    expect(() => reinforceActivation(first.state, {
      targetCreatedAt: 0,
      occurredAt: -1,
      semanticMatch: 1,
      intensity: 0.1,
    }, { eventCount: 0, appliedBoost: 0 })).toThrow('precedes');
    expect(() => reinforceActivation(first.state, {
      targetCreatedAt: 0,
      occurredAt: 1,
      semanticMatch: 1.1,
      intensity: 0.1,
    }, { eventCount: 0, appliedBoost: 0 })).toThrow('semantic match');
  });
});
