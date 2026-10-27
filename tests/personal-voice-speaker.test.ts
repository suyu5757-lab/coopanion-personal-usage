/**
 * 播放器生命周期：取消之后不再出声、一次只放一片、请求有明确的截止时间。
 *
 * 这些用例对应已复现的 S1（取消后旧请求拖住新回复）、S3（试听取消后仍可能播放）、
 * S4（并发试听争用播放器），以及试听与正常朗读共用播放器所有权的规则。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Speaker, inspectWav, type PlayResult, type Player } from '../personal-voice/speaker.gptsovits.ts';
import type { SpeechTraceV1 } from '../personal-voice/speech-plan.ts';

const native = process.platform === 'darwin' || process.platform === 'win32';
const STYLE = { voice: 'v', rate: '+0%', pitch: '+0Hz', volume: '+0%' };

function wav(ms = 40, sampleRate = 32_000): Buffer {
  const frames = Math.round((sampleRate * ms) / 1000);
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function audioResponse(bytes = wav(), headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/wav', ...headers } });
}

function trace(id: string): SpeechTraceV1 {
  return {
    traceVersion: 1,
    batchId: 'b1',
    callId: 'call1',
    utteranceId: id,
    segmentId: id,
    epoch: 0,
    index: 0,
    sourceRange: { start: 0, end: 0 },
    displayText: id,
    spokenText: id,
    displayStatus: 'unknown',
    playbackStatus: 'queued',
  };
}

interface FakeCall {
  url: string;
  body: { input: string; emotion?: string };
  aborted: boolean;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

/** 一句话一次响应；测试自己决定什么时候、以什么内容回。 */
function fakeTts(options: { ignoreAbort?: boolean } = {}) {
  const calls: FakeCall[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/capabilities')) {
      return Promise.resolve(new Response(JSON.stringify({
        fingerprint: 'caps-1',
        default: 'neutral',
        references: ['neutral', 'happy'],
        aliases: { 中性: 'neutral', 开心: 'happy' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return new Promise<Response>((resolve, reject) => {
      const call: FakeCall = { url, body: JSON.parse(String(init?.body)), aborted: false, resolve, reject };
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        call.aborted = true;
        if (!options.ignoreAbort) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      calls.push(call);
    });
  };
  return { calls, impl };
}

class FakePlayer implements Player {
  calls = 0;
  concurrent = 0;
  maxConcurrent = 0;
  delayMs = 10;
  async warm(): Promise<void> {}
  async play(_clip: string): Promise<PlayResult> {
    this.calls++;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.concurrent--;
    return 'played';
  }
  hush(): void {}
  async stop(): Promise<void> {}
}

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const servers: Server[] = [];

async function silentServer(): Promise<string> {
  const server = createServer(() => {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}/v1/audio/speech`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe.skipIf(!native)('speaker lifecycle', () => {
  it('plays a segment once and records what the service actually selected', async () => {
    const { calls, impl } = fakeTts();
    vi.stubGlobal('fetch', impl);
    const player = new FakePlayer();
    const speaker = new Speaker(() => {}, player, { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 1_000 });
    const line = trace('one');
    expect(speaker.say('你好呀。', { ...STYLE, emotion: '开心' }, line)).toBe(true);
    await until(() => calls.length === 1);
    expect(calls[0].body.emotion).toBe('开心');
    calls[0].resolve(audioResponse(wav(), { 'x-coopanion-reference': 'happy', 'x-coopanion-capability': 'caps-1' }));
    await until(() => line.playbackStatus === 'finished');
    expect(player.calls).toBe(1);
    expect(line.selectedReference).toBe('happy');
    expect(line.capabilityFingerprint).toBe('caps-1');
    expect(line.playbackEvidence).toBe('player-exit');
    await speaker.stop();
  });

  it('aborts the old request on hush so the next line does not wait for it', async () => {
    const { calls, impl } = fakeTts();
    vi.stubGlobal('fetch', impl);
    const player = new FakePlayer();
    const speaker = new Speaker(() => {}, player, { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 30_000 });
    const first = trace('first');
    const second = trace('second');
    speaker.say('第一句。', STYLE, first);
    await until(() => calls.length === 1);
    speaker.hush();
    await until(() => calls[0].aborted);
    speaker.say('第二句。', STYLE, second);
    await until(() => calls.length === 2);
    calls[1].resolve(audioResponse());
    await until(() => second.playbackStatus === 'finished');
    expect(first.playbackStatus).toBe('cancelled');
    expect(player.calls).toBe(1);
    await speaker.stop();
  });

  it('drops an audition whose response arrives after it was cancelled', async () => {
    // 这一例让响应无视取消照常回来，专门验证「取消后到达」这条路
    const { calls, impl } = fakeTts({ ignoreAbort: true });
    vi.stubGlobal('fetch', impl);
    const player = new FakePlayer();
    const speaker = new Speaker(() => {}, player, { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 5_000 });
    const pending = speaker.audition('试听一句。', STYLE);
    await until(() => calls.length === 1);
    speaker.hush();
    calls[0].resolve(audioResponse());
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(player.calls).toBe(0);
    await speaker.stop();
  });

  it('keeps one player at a time when two auditions overlap', async () => {
    const { calls, impl } = fakeTts({ ignoreAbort: true });
    vi.stubGlobal('fetch', impl);
    const player = new FakePlayer();
    const speaker = new Speaker(() => {}, player, { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 5_000 });
    const first = speaker.audition('第一次。', STYLE);
    await until(() => calls.length === 1);
    const second = speaker.audition('第二次。', STYLE);
    await until(() => calls.length === 2);
    // 第一次的响应晚到：回来之后发现代次已经不是自己的，不能放
    calls[0].resolve(audioResponse());
    expect((await first).cancelled).toBe(true);
    calls[1].resolve(audioResponse());
    expect((await second).ok).toBe(true);
    expect(player.maxConcurrent).toBe(1);
    await speaker.stop();
  });

  it('gives up on a request that never answers instead of holding the queue', async () => {
    const url = await silentServer();
    const player = new FakePlayer();
    const lines: string[] = [];
    const speaker = new Speaker((line) => lines.push(line), player, { url, requestTimeoutMs: 150 });
    const line = trace('slow');
    speaker.say('一句话。', STYLE, line);
    await until(() => line.playbackStatus === 'failed');
    expect(player.calls).toBe(0);
    expect(lines.some((text) => text.includes('合成失败'))).toBe(true);
    await speaker.stop();
  });

  it('never hands a non-WAV response to the player', async () => {
    const { calls, impl } = fakeTts();
    vi.stubGlobal('fetch', impl);
    const player = new FakePlayer();
    const speaker = new Speaker(() => {}, player, { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 1_000 });
    const line = trace('bad');
    speaker.say('一句话。', STYLE, line);
    await until(() => calls.length === 1);
    calls[0].resolve(new Response(Buffer.from('{"error":"nope"}'), { status: 200, headers: { 'content-type': 'application/json' } }));
    await until(() => line.playbackStatus === 'failed');
    expect(player.calls).toBe(0);
    await speaker.stop();
  });

  it('treats a busy service as a skipped segment, not as a failure', async () => {
    const { calls, impl } = fakeTts();
    vi.stubGlobal('fetch', impl);
    const player = new FakePlayer();
    const speaker = new Speaker(() => {}, player, { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 1_000 });
    const busy = trace('busy');
    speaker.say('一句。', STYLE, busy);
    await until(() => calls.length === 1);
    calls[0].resolve(new Response('{"error":"busy"}', { status: 429 }));
    await until(() => busy.playbackStatus === 'cancelled');
    expect(busy.fallbackReason).toBe('service-busy');
    expect(speaker.snapshot().failed).toBe(0);
    // 忙不等于坏了：下一句立刻重新请求，不走冷却
    const next = trace('next');
    speaker.say('下一句。', STYLE, next);
    await until(() => calls.length === 2);
    calls[1].resolve(audioResponse());
    await until(() => next.playbackStatus === 'finished');
    expect(player.calls).toBe(1);
    await speaker.stop();
  });

  it('gives an audition its own deadline instead of blocking later lines', async () => {
    const url = await silentServer();
    const speaker = new Speaker(() => {}, new FakePlayer(), { url, requestTimeoutMs: 150 });
    const started = Date.now();
    const result = await speaker.audition('试听一句。', STYLE);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    // 试听退出后普通朗读还能继续排队合成
    const line = trace('after');
    speaker.say('下一句。', STYLE, line);
    await until(() => line.playbackStatus !== 'queued', 3_000);
    await speaker.stop();
  });

  it('marks a segment skipped by the failure cooldown as cancelled, not queued', async () => {
    const { calls, impl } = fakeTts();
    vi.stubGlobal('fetch', impl);
    const speaker = new Speaker(() => {}, new FakePlayer(), { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 1_000 });
    const first = trace('first');
    speaker.say('第一句。', STYLE, first);
    await until(() => calls.length === 1);
    calls[0].resolve(new Response('{"error":"boom"}', { status: 500 }));
    await until(() => first.playbackStatus === 'failed');
    const second = trace('second');
    speaker.say('第二句。', STYLE, second);
    await until(() => second.playbackStatus !== 'queued');
    expect(second.playbackStatus).toBe('cancelled');
    expect(second.fallbackReason).toBe('service-cooldown');
    expect(speaker.snapshot().omitted).toBe(1);
    await speaker.stop();
  });

  it('stops reading a response body that grows past the byte limit', async () => {
    const speaker = new Speaker(() => {}, new FakePlayer(), {
      url: 'http://tts/v1/audio/speech',
      requestTimeoutMs: 1_000,
      maxAudioBytes: 1_000,
    });
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8_000));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    const line = trace('big');
    speaker.say('一句。', STYLE, line);
    await until(() => line.playbackStatus === 'failed');
    expect(line.fallbackReason).toContain('超过');
    await speaker.stop();
  });

  it('keeps the queue bounded and says so once', async () => {
    const { calls, impl } = fakeTts();
    vi.stubGlobal('fetch', impl);
    const player = new FakePlayer();
    const lines: string[] = [];
    const speaker = new Speaker((line) => lines.push(line), player, {
      url: 'http://tts/v1/audio/speech',
      requestTimeoutMs: 1_000,
      maxQueuedJobs: 1,
    });
    expect(speaker.say('第一句。', STYLE, trace('a'))).toBe(true);
    expect(speaker.say('第二句。', STYLE, trace('b'))).toBe(false);
    expect(speaker.say('第三句。', STYLE, trace('c'))).toBe(false);
    expect(speaker.snapshot().omitted).toBe(2);
    expect(lines.filter((line) => line.includes('语音省略')).length).toBe(1);
    await until(() => calls.length === 1);
    calls[0].resolve(audioResponse());
    await until(() => speaker.snapshot().spoken === 1);
    await speaker.stop();
  });
});

/**
 * 500 组固定种子的事件序列：说到一半取消、响应迟到、补齐遗漏的响应，播放器上都不能
 * 同时放两段，取消过的那段也不能再进播放器。片段把自己是谁写进 WAV 数据里，播放器据此
 * 对照它的句段记录。
 */
describe.skipIf(!native)('cancellation sequences', () => {
  class VerifyingPlayer extends FakePlayer {
    violations = 0;
    constructor(private readonly accept: (id: string) => boolean) {
      super();
    }
    async play(clip: string): Promise<PlayResult> {
      const body = readFileSync(clip).subarray(44).toString('utf8');
      const id = body.slice(4, body.indexOf('\u0000', 4));
      // 判据来自测试自己的记录，不看被测代码写的状态
      if (!this.accept(id)) this.violations++;
      return super.play(clip);
    }
  }

  /** 把片段名字塞进 WAV 的数据段，正文长度够 100ms，播放它的那一端才读得出来。 */
  function tagged(text: string): Buffer {
    const payload = Buffer.alloc(6400, 0);
    payload.write(`SEG:${text}`, 0, 'utf8');
    const header = wav(0, 32_000).subarray(0, 44);
    header.writeUInt32LE(payload.length, 40);
    header.writeUInt32LE(36 + payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  function lcg(seed: number): () => number {
    let state = seed * 2654435761 % 4294967296;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps one player and drops cancelled segments across 500 sequences', async () => {
    // 让响应无视取消照常回来，专门压「取消之后结果才到」这条路
    const { calls, impl } = fakeTts({ ignoreAbort: true });
    vi.stubGlobal('fetch', impl);
    const prefix = 'coopanion-streamvoice-';
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
    let played = 0;
    for (let seed = 0; seed < 500; seed++) {
      calls.length = 0;
      const random = lcg(seed + 1);
      // 测试自己记谁还在等声音：hush 把在等的全划掉，播放时必须还在名单里
      const live = new Set<string>();
      const player = new VerifyingPlayer((id) => {
        if (!live.has(id)) return false;
        live.delete(id);
        return true;
      });
      const original = player.play.bind(player);
      player.play = async (clip: string) => { played++; return original(clip); };
      const speaker = new Speaker(() => {}, player, { url: 'http://tts/v1/audio/speech', requestTimeoutMs: 1_000 });
      const ops = 2 + Math.floor(random() * 5);
      for (let i = 0; i < ops; i++) {
        const roll = random();
        if (roll < 0.45) {
          const id = `s${seed}-${i}`;
          live.add(id);
          speaker.say(id, STYLE, trace(id));
        } else if (roll < 0.7) {
          live.clear();
          speaker.hush();
        } else if (roll < 0.85) {
          // 试听先清空在等的，再把自己排进去
          live.clear();
          const id = `a${seed}-${i}`;
          live.add(id);
          void speaker.audition(id, STYLE).catch(() => {});
        } else if (calls.length) {
          const at = Math.floor(random() * calls.length);
          const [call] = calls.splice(at, 1);
          call.resolve(audioResponse(tagged(call.body.input)));
        }
        await tick();
      }
      // 收尾：把还在路上的响应都放出来，再等它们自己结束
      for (let i = 0; i < 6; i++) {
        for (const call of calls.splice(0)) call.resolve(audioResponse(tagged(call.body.input)));
        await tick();
      }
      await speaker.stop();
      await tick();
      expect(player.violations, `seed ${seed}`).toBe(0);
      expect(player.maxConcurrent, `seed ${seed}`).toBeLessThanOrEqual(1);
      expect(speaker.snapshot().queued, `seed ${seed}`).toBe(0);
    }
    // 序列里必须真的放出过声音，否则这条断言什么都没证明
    expect(played).toBeGreaterThan(20);
    // 停止之后不该留下这次创建的暂存目录
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !before.has(name));
    expect(after).toEqual([]);
  }, 90_000);
});

describe('wav inspection', () => {
  it('reads the real format instead of trusting the request', () => {
    expect(inspectWav(wav(100, 24_000))).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
  });

  it('rejects empty, truncated and foreign bodies', () => {
    expect(() => inspectWav(Buffer.alloc(0))).toThrow();
    expect(() => inspectWav(Buffer.from('RIFF0000WAVE'))).toThrow();
    expect(() => inspectWav(Buffer.from('{"error":1}'))).toThrow();
    const broken = wav();
    broken.writeUInt32LE(0, 40);
    expect(() => inspectWav(broken)).toThrow();
  });
});
