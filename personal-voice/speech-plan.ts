/**
 * 台词在变成声音之前的两道工序：去掉括号里的标记，再把文字切成句段。
 *
 * 与 streamvoice 0.4.0 自带的 `clean.ts` / `chunker.ts` 相比，这里多两件事：
 *
 * - 每个标记记下它在整段台词里的位置（UTF-16 偏移），切块时按位置归属，所以同一段文字
 *   不管被切成几个增量，得到的句段、顺序和情绪都一样；
 * - 只把能力清单里认得的标记当情绪。`<点头>` 这类动作不覆盖上一句仍适用的情绪，
 *   能力清单没拿到时退回旧行为（任何标记都算情绪）。
 *
 * 标记语法与桌宠剧本一致：`【表情, 动作】` 阻塞，`<表情>` 行内（也认全角的 `＜表情＞`），
 * 行内标记超过 32 字或跨行就当正文。
 */

/** 行内标记的长度上限；和剧本解析同一个数。 */
export const MARKER_MAX = 32;
/** 一次最多读这么长；超出的留在屏幕上。 */
export const SPEAK_MAX = 600;

export interface MarkerHit {
  /** 这个标记在已发出的正文里的位置；它会作用在这个位置之后。 */
  at: number;
  text: string;
}

/** 增量地去标记，并顺手记下每个标记落在哪。 */
export class MarkupFilter {
  private hold = '';
  /** 已经交出去的正文有多少字。 */
  private out = 0;
  private hits: MarkerHit[] = [];

  push(text: string): string {
    return this.scan(text, false);
  }

  /** 收尾：不再等没闭合的标记，剩下的都当正文。 */
  flush(): string {
    return this.scan('', true);
  }

  /** 取走这次扫描记下的标记，交给切块那一步。 */
  takeHits(): MarkerHit[] {
    const hits = this.hits;
    this.hits = [];
    return hits;
  }

  /** 从头算：收尾之后再喂字，就是另一段台词。 */
  reset(): void {
    this.hold = '';
    this.out = 0;
    this.hits = [];
  }

  private scan(text: string, final: boolean): string {
    this.hold += text;
    let piece = '';
    let i = 0;
    while (i < this.hold.length) {
      const ch = this.hold[i];
      if (ch === '【') {
        const end = this.hold.indexOf('】', i + 1);
        if (end < 0) {
          if (final) { piece += ch; i++; continue; }
          break;
        }
        this.note(piece.length, this.hold.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      if (ch === '<' || ch === '＜') {
        const close = ch === '<' ? '>' : '＞';
        const end = this.hold.indexOf(close, i + 1);
        if (end < 0) {
          const rest = this.hold.slice(i);
          // 长度按标记内部算：开括号不算字数，否则恰好 32 字的标记会随切分方式不同而不一样
          if (final || rest.slice(1).length > MARKER_MAX || rest.includes('\n')) { piece += ch; i++; continue; }
          break;
        }
        const inner = this.hold.slice(i + 1, end);
        if (inner.length <= MARKER_MAX && !inner.includes('\n')) {
          this.note(piece.length, inner);
          i = end + 1;
          continue;
        }
        piece += ch;
        i++;
        continue;
      }
      piece += ch;
      i++;
    }
    this.hold = this.hold.slice(i);
    this.out += piece.length;
    return piece;
  }

  private note(at: number, marker: string): void {
    const text = marker.trim();
    if (text) this.hits.push({ at: this.out + at, text });
  }
}

export interface ChunkLimits {
  /** 少于这么多字（不含空白）不单独成块。 */
  min: number;
  /** 一块最多这么多字。 */
  max: number;
}

export interface SpeechChunk {
  text: string;
  /** 在整段台词里的起止位置，UTF-16 偏移。 */
  start: number;
  end: number;
}

/** 一看见就切：句末标点与换行。 */
const HARD_ENDS = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n', '\r']);
/** 句末标点后面跟着的收尾符号，归前一块。 */
const CLOSERS = new Set(['」', '』', '”', '’', '）', ')', '】', '》', '"', "'"]);
/** 超过 max 时可以下刀的地方，优先靠后。 */
const SOFT_ENDS = new Set(['，', ',', '、', '：', ':']);

/** 可见字数：空白不算。 */
function visibleLength(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

function isHardEnd(text: string, i: number): boolean {
  const ch = text[i];
  if (HARD_ENDS.has(ch)) return true;
  if (ch === '.') {
    // 小数点、版本号里的点不算句子结束
    const prev = text[i - 1] ?? '';
    const next = text[i + 1];
    if (/\d/.test(prev)) return false;
    // 句尾的点后面还没有下一个字时先不切，等它落地
    return next === undefined ? false : /[\s"')）」』】]/.test(next);
  }
  return false;
}

/** 边收边切，并且记住每一块在原文里的位置。规则和 streamvoice 的 SentenceChunker 一致。 */
export class VoiceChunker {
  private buf = '';
  /** `buf[0]` 在整段台词里的位置。 */
  private base = 0;

  constructor(private limits: ChunkLimits) {}

  setLimits(limits: ChunkLimits): void {
    this.limits = limits;
  }

  get pending(): number {
    return visibleLength(this.buf);
  }

  push(text: string): SpeechChunk[] {
    if (!text) return [];
    this.buf += text;
    return this.drain();
  }

  flush(): SpeechChunk[] {
    const rest = this.buf.trim();
    const lead = this.buf.length - this.buf.replace(/^\s+/, '').length;
    const start = this.base + lead;
    this.buf = '';
    if (!rest) return [];
    return [{ text: rest, start, end: start + rest.length }];
  }

  /** 从头算：位置和缓冲一起清掉。 */
  reset(): void {
    this.buf = '';
    this.base = 0;
  }

  private drain(): SpeechChunk[] {
    const out: SpeechChunk[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut <= 0) return out;
      const piece = this.buf.slice(0, cut);
      const lead = piece.length - piece.replace(/^[\s，,、：:]+/, '').length;
      const trimmed = piece.replace(/^[\s，,、：:]+/, '').trim();
      if (trimmed) out.push({ text: trimmed, start: this.base + lead, end: this.base + lead + trimmed.length });
      this.buf = this.buf.slice(cut);
      this.base += cut;
    }
  }

  private findCut(): number {
    const { min, max } = this.limits;
    let i = 0;
    while (i < this.buf.length) {
      if (isHardEnd(this.buf, i)) {
        let end = i + 1;
        while (end < this.buf.length && CLOSERS.has(this.buf[end])) end++;
        const piece = this.buf.slice(0, end);
        const len = visibleLength(piece);
        if (len < min) {
          i = end;
          continue;
        }
        if (len > max) return this.softCut(max);
        // 句末刚好落在增量末尾时先不切：收尾引号、括号可能在下一个增量里
        if (end >= this.buf.length) return 0;
        return end;
      }
      i++;
    }
    if (visibleLength(this.buf) > max) return this.softCut(max);
    return 0;
  }

  private softCut(max: number): number {
    let seen = 0;
    let lastSoft = -1;
    let hardAt = -1;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (/\s/.test(ch)) continue;
      seen++;
      if (seen > max) {
        hardAt = i;
        break;
      }
      if (SOFT_ENDS.has(ch)) lastSoft = i + 1;
    }
    if (lastSoft > 0) return lastSoft;
    if (hardAt > 0) return hardAt;
    return this.buf.length;
  }
}

/** adapter 报上来的参考音能力；没拿到时按旧行为处理。 */
export interface VoiceCapability {
  fingerprint?: string;
  default?: string;
  references: string[];
  /** 别名 → 参考音 id，来自 adapter 配置，不在这里另抄一份。 */
  aliases: Record<string, string>;
}

/** 一个标记里的词：和视觉解析一样按逗号、顿号、空白分。 */
export function markerTokens(marker: string): string[] {
  return marker.split(/[,，、;；\s]+/).map((t) => t.trim()).filter(Boolean);
}

/** 这个标记里有没有能力清单认得的声音参考。清单没拿到时任何标记都算。 */
export function isToneMarker(marker: string, capability: VoiceCapability | null): boolean {
  if (!capability) return true;
  return markerTokens(marker).some((token) => {
    if (capability.references.includes(token)) return true;
    if (capability.aliases[token]) return true;
    return Boolean(capability.aliases[token.toLowerCase()]);
  });
}

export interface PlannedSegment {
  /** 去掉标记后的原文；还没清表情和网址。 */
  text: string;
  start: number;
  end: number;
  /** 这句话该用的情绪标记；没有就是 undefined，由 adapter 用默认参考。 */
  marker?: string;
}

/**
 * 增量规划：去标记、切句、按标记位置归属情绪。
 *
 * 情绪边界优先于短句合并：一块里如果夹着换情绪的标记，就按标记位置切开，不会为了凑够
 * min 字把两种情绪并成一句。
 */
export class SpeechPlanner {
  private readonly filter = new MarkupFilter();
  private readonly chunker: VoiceChunker;
  private pending: MarkerHit[] = [];
  private tone: string | undefined;

  constructor(limits: ChunkLimits, private readonly capability: () => VoiceCapability | null) {
    this.chunker = new VoiceChunker(limits);
  }

  setLimits(limits: ChunkLimits): void {
    this.chunker.setLimits(limits);
  }

  push(delta: string): PlannedSegment[] {
    const text = this.filter.push(delta);
    this.pending.push(...this.filter.takeHits());
    if (!text) return [];
    return this.plan(this.chunker.push(text));
  }

  flush(): PlannedSegment[] {
    const tail = this.filter.flush();
    this.pending.push(...this.filter.takeHits());
    const chunks = tail ? [...this.chunker.push(tail), ...this.chunker.flush()] : this.chunker.flush();
    const out = this.plan(chunks);
    // 收尾之后这个实例从零开始：再喂字就是另一段台词
    this.filter.reset();
    this.chunker.reset();
    this.pending = [];
    this.tone = undefined;
    return out;
  }

  private plan(chunks: SpeechChunk[]): PlannedSegment[] {
    const out: PlannedSegment[] = [];
    for (const chunk of chunks) out.push(...this.split(chunk));
    return out;
  }

  private split(chunk: SpeechChunk): PlannedSegment[] {
    const inside: MarkerHit[] = [];
    const capability = this.capability();
    while (this.pending.length && this.pending[0].at <= chunk.end) {
      const hit = this.pending.shift()!;
      if (!isToneMarker(hit.text, capability)) continue;
      if (hit.at <= chunk.start) {
        this.tone = hit.text;
        continue;
      }
      inside.push(hit);
    }
    const pieces: PlannedSegment[] = [];
    let at = chunk.start;
    for (const hit of inside) {
      pieces.push({ text: chunk.text.slice(at - chunk.start, hit.at - chunk.start), start: at, end: hit.at, marker: this.tone });
      this.tone = hit.text;
      at = hit.at;
    }
    pieces.push({ text: chunk.text.slice(at - chunk.start), start: at, end: chunk.end, marker: this.tone });
    return pieces.filter((piece) => piece.text.trim().length > 0);
  }
}

export type DisplayStatus = 'pending' | 'sent' | 'rendered' | 'unknown';
export type PlaybackStatus = 'queued' | 'playing' | 'finished' | 'cancelled' | 'failed';

/**
 * 一句话从计划到出声的记录。只回答「请求了哪个参考音、服务实际选了哪个、播放到了哪一步」，
 * 不证明用户听见了，也不落盘。
 */
export interface SpeechTraceV1 {
  traceVersion: 1;
  batchId: string;
  callId: string;
  utteranceId: string;
  segmentId: string;
  epoch: number;
  index: number;
  /** 这段声音对应去掉标记后正文里的哪一段，UTF-16 偏移。 */
  sourceRange: { start: number; end: number };
  displayText: string;
  spokenText: string;
  requestedReference?: string;
  selectedReference?: string;
  capabilityFingerprint?: string;
  fallbackReason?: string;
  displayStatus: DisplayStatus;
  playbackStatus: PlaybackStatus;
  playbackEvidence?: 'player-call' | 'player-exit';
}
