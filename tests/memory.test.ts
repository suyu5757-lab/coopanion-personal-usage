import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecallResult } from '@vectorize-io/hindsight-client';
import { AffectionLedger } from '../core/memory/affection.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { hindsightConfigGroup } from '../core/memory/config-group.ts';
import { cleanSpeech, formatPortrait, formatRecall } from '../core/memory/format.ts';
import { sanitizeForMemory } from '../core/memory/policy.ts';

const workspace = () => mkdtempSync(join(tmpdir(), 'coo-memory-'));
const fixedNow = () => new Date('2026-10-24T10:00:00.000Z');

const recallResult = (over: Partial<RecallResult>): RecallResult => ({ id: 'f1', text: 'a fact', type: 'observation', ...over });

describe('Hindsight config', () => {
  it('is off without a file or environment', () => {
    expect(loadHindsightConfig(workspace()).enabled).toBe(false);
  });

  it('reads the deployment file and clamps values', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'hindsight.json'), JSON.stringify({
      enabled: true,
      apiUrl: 'http://127.0.0.1:9999/',
      bankId: 'coopanion:test',
      recall: { maxTokens: 99999, timeoutMs: 1, budget: 'high' },
      affection: { dailyPositive: 0 },
    }));
    const config = loadHindsightConfig(dir);
    expect(config.enabled).toBe(true);
    expect(config.apiUrl).toBe('http://127.0.0.1:9999');
    expect(config.bankId).toBe('coopanion:test');
    expect(config.recall.maxTokens).toBe(4000);
    expect(config.recall.timeoutMs).toBe(100);
    expect(config.recall.budget).toBe('high');
    expect(config.affection.dailyPositive).toBe(1);
  });

  it('lets the config page override the file and environment defaults', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'hindsight.json'), JSON.stringify({ enabled: false, bankId: 'from-file' }));
    const config = loadHindsightConfig(dir, {
      enabled: true,
      apiUrl: 'http://127.0.0.1:7777',
      bankId: 'coopanion:from-ui',
      recall: { maxTokens: 1200 },
      affection: { enabled: false },
    });
    expect(config.enabled).toBe(true);
    expect(config.apiUrl).toBe('http://127.0.0.1:7777');
    expect(config.bankId).toBe('coopanion:from-ui');
    expect(config.recall.maxTokens).toBe(1200);
    expect(config.affection.enabled).toBe(false);
    expect(loadHindsightConfig(dir, { enabled: false }).enabled).toBe(false);
  });

  it('exposes the same dotted paths the config page and the runtime read', () => {
    const group = hindsightConfigGroup('zh');
    expect(group.id).toBe('hindsight');
    expect(Object.keys(group.schema.properties)).toEqual([
      'hindsight.autostart',
      'hindsight.enabled',
      'hindsight.apiUrl',
      'hindsight.bankId',
      'hindsight.recall.maxTokens',
      'hindsight.recall.timeoutMs',
      'hindsight.affection.enabled',
    ]);
    expect(group.schema.properties['hindsight.enabled'].title).toContain('长期记忆');
  });

  it('gives each deployment its own default bank', () => {
    const a = loadHindsightConfig(workspace()).bankId;
    const b = loadHindsightConfig(workspace()).bankId;
    expect(a).toMatch(/^coopanion:[a-f0-9]{10}$/);
    expect(a).not.toBe(b);
  });
});

describe('memory formatting', () => {
  it('strips speech markers', () => {
    expect(cleanSpeech('【happy】morning <wave> there')).toBe('morning there');
  });

  it('keeps dated memories, drops duplicates and respects the item cap', () => {
    const text = formatRecall([
      recallResult({ text: 'likes tea', occurred_start: '2026-10-01T00:00:00Z' }),
      recallResult({ id: 'f2', text: 'likes tea' }),
      recallResult({ id: 'f3', text: 'works at night', type: 'world', mentioned_at: '2026-10-20T00:00:00Z' }),
    ]);
    expect(text).toContain('(observation, 2026-10-01) likes tea');
    expect(text).toContain('(world, 2026-10-20) works at night');
    expect(text.match(/likes tea/g)).toHaveLength(1);
  });

  it('skips empty portraits and empty recall', () => {
    expect(formatPortrait([{ title: 'The person', text: 'I cannot find any information.' }])).toBe('');
    expect(formatRecall([])).toBe('');
  });

  it('redacts keys and refuses password-like text', () => {
    expect(sanitizeForMemory('my key is sk-abcdefghijklmnop1234').text).toContain('[redacted]');
    expect(sanitizeForMemory('我的密码是 hunter2')).toEqual({ text: '', skip: 'sensitive' });
    expect(sanitizeForMemory('token=abcdef1234567890')).toEqual({ text: '', skip: 'sensitive' });
    expect(sanitizeForMemory('I like tea')).toEqual({ text: 'I like tea' });
  });
});

describe('affection ledger', () => {
  const ledger = (file: string | null = null) => {
    const l = new AffectionLedger();
    l.configure(file, { now: fixedNow, dailyPositive: 5, dailyNegative: 5 });
    return l;
  };

  it('accumulates petting and stops at the daily positive cap', () => {
    const l = ledger();
    for (let i = 0; i < 8; i++) l.record('pet', { id: `pet-${i}` });
    const state = l.state();
    expect(state.bond).toBe(5);
    expect(state.level).toBe(1);
    expect(state.events).toBe(5);
  });

  it('is idempotent by event id', () => {
    const l = ledger();
    l.record('pet', { id: 'same' });
    expect(l.record('pet', { id: 'same' })).toBeNull();
    expect(l.state().bond).toBe(1);
  });

  it('caps negative events and never goes below zero', () => {
    const l = ledger();
    l.record('conflict', { id: 'c1' });
    l.record('throw', { id: 't1' });
    expect(l.record('crash', { id: 'c2' })).toBeNull();
    expect(l.state().bond).toBe(0);
  });

  it('reloads the same events from disk', () => {
    const file = join(workspace(), 'affection.jsonl');
    const first = ledger(file);
    first.record('pet', { id: 'p1' });
    first.record('comfort', { id: 'p2' });
    const second = ledger(file);
    expect(second.state().bond).toBe(first.state().bond);
    expect(second.state().events).toBe(2);
  });

  it('maps touches and ignores neutral ones', () => {
    const l = ledger();
    expect(l.recordTouch({ kind: 'pet', count: 2 }, { session: 'main', cursor: 7 })).not.toBeNull();
    expect(l.recordTouch({ kind: 'poke', count: 1 }, { session: 'main', cursor: 8 })).toBeNull();
    expect(l.recordTouch({ kind: 'throw', crashed: true }, { session: 'main', cursor: 9 })).not.toBeNull();
    expect(l.state().bond).toBe(0);
    expect(l.state().levelName).toBe('stranger');
  });

  it('describes the current bond without exposing the raw ledger', () => {
    const l = ledger();
    for (let i = 0; i < 3; i++) l.record('pet', { id: `p-${i}`, reason: 'patted' });
    expect(l.snapshot()).toContain('Bond Lv.');
    expect(l.snapshot()).toContain('mood +');
    expect(l.clear()).toContain('cleared');
    expect(l.state().events).toBe(0);
  });
});
