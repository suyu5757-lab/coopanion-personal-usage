/**
 * 台词规划：同一段文字，不管被切成几个增量，句段、顺序和情绪都要一样。
 *
 * 这些用例对应已复现的 M1（情绪随 delta 边界变化）、M2（全角行内标记漏进朗读）、
 * M3（纯动作覆盖声音情绪）。
 */
import { describe, expect, it } from 'vitest';
import {
  MarkupFilter,
  SpeechPlanner,
  VoiceChunker,
  isToneMarker,
  markerTokens,
  type PlannedSegment,
  type VoiceCapability,
} from '../personal-voice/speech-plan.ts';

/** 只有认得的参考音和别名才算情绪；其余标记都是动作。 */
function capability(aliases: Record<string, string>): VoiceCapability {
  return { references: [...new Set(Object.values(aliases))], aliases };
}

const CAP = capability({ 开心: 'happy', 生气: 'angry', 中性: 'neutral' });

function plan(chunks: string[], cap: VoiceCapability | null = CAP): PlannedSegment[] {
  const planner = new SpeechPlanner({ min: 8, max: 40 }, () => cap);
  const out: PlannedSegment[] = [];
  for (const chunk of chunks) out.push(...planner.push(chunk));
  out.push(...planner.flush());
  return out;
}

function split(text: string, every: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += every) out.push(text.slice(i, i + every));
  return out;
}

const shape = (segments: PlannedSegment[]): Array<{ text: string; marker?: string }> =>
  segments.map((segment) => ({ text: segment.text, marker: segment.marker }));

describe('speech plan', () => {
  it('keeps the same segments and tones however the deltas are cut', () => {
    const script = '【开心】第一句话已经足够长了。<生气>第二句话也已经足够长了。';
    const whole = shape(plan([script]));
    expect(whole).toEqual([
      { text: '第一句话已经足够长了。', marker: '开心' },
      { text: '第二句话也已经足够长了。', marker: '生气' },
    ]);
    for (const size of [1, 2, 3, 5, 7]) expect(shape(plan(split(script, size)))).toEqual(whole);
  });

  it('reads full-width inline markers as markers, not as text', () => {
    expect(shape(plan(['＜开心＞那我们走吧。']))).toEqual([{ text: '那我们走吧。', marker: '开心' }]);
    expect(shape(plan(['＜开心＞那我们走吧。'], null))).toEqual([{ text: '那我们走吧。', marker: '开心' }]);
  });

  it('lets an action marker leave the current voice emotion alone', () => {
    const segments = plan(['【开心】好呀。<点头>', '那我们走吧。']);
    expect(segments.map((segment) => segment.text).join('')).toContain('那我们走吧');
    expect(segments.every((segment) => segment.marker === '开心')).toBe(true);
  });

  it('falls back to the legacy rule when the adapter capability is unknown', () => {
    const segments = plan(['【开心】好呀。<点头>', '那我们走吧。'], null);
    expect(segments.at(-1)?.marker).toBe('点头');
  });

  it('splits a chunk at an emotion boundary instead of merging the two tones', () => {
    const segments = plan(['【开心】好的。<生气>你走开。']);
    expect(shape(segments)).toEqual([
      { text: '好的。', marker: '开心' },
      { text: '你走开。', marker: '生气' },
    ]);
  });

  it('recognises a tone inside a combined action marker', () => {
    expect(isToneMarker('开心，甩尾巴', CAP)).toBe(true);
    expect(isToneMarker('点头', CAP)).toBe(false);
    expect(markerTokens('开心，甩尾巴')).toEqual(['开心', '甩尾巴']);
    expect(shape(plan(['【开心，甩尾巴】那我们走吧。']))).toEqual([
      { text: '那我们走吧。', marker: '开心，甩尾巴' },
    ]);
  });

  it('keeps an unclosed inline marker as text once it is too long to be a marker', () => {
    const long = `<${'a'.repeat(40)}`;
    const segments = plan([long]);
    expect(segments.map((segment) => segment.text).join('')).toBe(long);
    expect(segments.every((segment) => segment.marker === undefined)).toBe(true);
  });

  it('treats an inline marker of exactly the limit the same however it is cut', () => {
    const inner = 'a'.repeat(32);
    const script = `＜${inner}＞那我们走吧。`;
    const whole = shape(plan([script], null));
    for (const size of [1, 2, 7, 33]) expect(shape(plan(split(script, size), null))).toEqual(whole);
    expect(whole[0]?.marker).toBe(inner);
    expect(whole[0]?.text).toBe('那我们走吧。');
    // 能力清单里没有这个标记时，它照样是标记，只是不换声音
    expect(shape(plan([script]))[0]?.marker).toBeUndefined();
  });

  it('keeps a closing quote with the sentence it belongs to however it is cut', () => {
    const script = '【开心】第一句话已经足够长了。”</span>'
      .replace('</span>', '')
      .concat('<生气>第二句话也已经足够长了。');
    const whole = shape(plan([script]));
    for (const size of [1, 3, 8]) expect(shape(plan(split(script, size)))).toEqual(whole);
    expect(whole[0]).toEqual({ text: '第一句话已经足够长了。”', marker: '开心' });
  });

  it('starts over after a flush instead of carrying the old tone and offsets', () => {
    const planner = new SpeechPlanner({ min: 1, max: 40 }, () => CAP);
    expect(planner.push('【开心】好的。 ').map((s) => s.marker)).toEqual(['开心']);
    expect(planner.flush().map((s) => s.marker)).toEqual([]);
    const next = planner.push('<生气>再见。 ');
    expect(next.map((s) => s.marker)).toEqual(['生气']);
    expect(next.map((s) => s.start)).toEqual([0]);
  });

  it('reports the range of each segment in the cleaned text', () => {
    const planner = new SpeechPlanner({ min: 8, max: 40 }, () => CAP);
    const segments = [...planner.push('【开心】第一句话已经足够长了。'), ...planner.flush()];
    const cleaned = '第一句话已经足够长了。';
    for (const segment of segments) {
      expect(cleaned.slice(segment.start, segment.end)).toBe(segment.text);
    }
  });

  it('marks the same text without any marker as unknown tone', () => {
    expect(shape(plan(['一句没有标记的话，够长了。']))).toEqual([
      { text: '一句没有标记的话，够长了。', marker: undefined },
    ]);
  });
});

describe('markup filter', () => {
  it('holds an incomplete marker across pushes and drops it once closed', () => {
    const filter = new MarkupFilter();
    expect(filter.push('前半句【开')).toBe('前半句');
    expect(filter.push('心】后半句')).toBe('后半句');
    expect(filter.takeHits()).toEqual([{ at: 3, text: '开心' }]);
  });

  it('treats a block marker left open at the end as text', () => {
    const filter = new MarkupFilter();
    expect(filter.push('半句【没闭合')).toBe('半句');
    expect(filter.flush()).toBe('【没闭合');
  });
});

describe('chunker', () => {
  it('keeps ranges contiguous with the text it emits', () => {
    const chunker = new VoiceChunker({ min: 1, max: 6 });
    const text = '第一句。第二句很长很长很长。';
    const chunks = [...chunker.push(text), ...chunker.flush()];
    expect(chunks.map((chunk) => text.slice(chunk.start, chunk.end))).toEqual(chunks.map((chunk) => chunk.text));
  });
});
