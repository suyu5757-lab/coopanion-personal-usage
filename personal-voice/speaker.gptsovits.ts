/**
 * 一块字变成一段声音，并且按顺序连起来说。
 *
 * 队列只有一条：谁先进来谁先说。合成与播放是两条流水线——每个块一进来就立刻开始合成，
 * 播放器只在上一块说完之后把下一块交过去。所以第 1 块在说的时候，第 2 块已经在合成了，
 * 两块之间的空隙只剩交接时间。
 *
 * `hush()` 是唯一的清空方式：代次（epoch）加一，还在排队的块丢掉，正在合成的请求中止，
 * 已经合成好但还没放的声音删掉，正在放的那一片杀掉播放器。中止是请求级的（AbortController
 * 管到响应体读完），所以新回复不用等旧请求自己超时。
 *
 * 播放器只有一个所有者：正常朗读和试听都排在同一条播放流水线上，进播放器之前再复核一次
 * 代次。任何一路被取消，它的声音都不会在之后补放。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechTraceV1, VoiceCapability } from './speech-plan.ts';

/** 本机适配器的地址；开发测试用 `COOPANION_TTS_URL` 指到别处。 */
const DEFAULT_TTS_URL = 'http://127.0.0.1:9881/v1/audio/speech';

export interface SpeechStyle {
  voice: string;
  rate: string;
  /** 音调，如 `+10Hz`。 */
  pitch: string;
  volume: string;
  /** 当前这句的情绪/表情，由 adapter 换成对应的参考音。 */
  emotion?: string;
}

/** 播放器的最小契约；`player.ts` 的实现按结构对上就行。 */
export type PlayResult = 'played' | 'cut' | 'failed';

export interface Player {
  warm(dir: string): Promise<void>;
  play(clip: string): Promise<PlayResult>;
  hush(): void;
  stop(): Promise<void>;
}

/** 可以随时改的开关；世界每次开口前现写一遍，改配置不用重启。 */
export interface SpeakerOptions {
  /** 一块说完之后额外停这么久再放下块（0 = 紧接着说）。 */
  gapMs?: number;
  /** 模型开始写时先空打一发合成，把链路焐热；不想要这点请求就关掉。 */
  prewarm?: boolean;
  /** 逐块打详细日志。 */
  verbose?: boolean;
  /** 合成服务地址；不给就用 `COOPANION_TTS_URL` 或本机 9881。 */
  url?: string;
  /** 一次合成从发起请求到读完响应体的总时限。 */
  requestTimeoutMs?: number;
  /** 单块最多读这么多字；再长的只留在屏幕上。 */
  maxSegmentChars?: number;
  /** 一场话里排队等着念的字数上限；超出的只留在气泡里并记一次省略。 */
  maxQueuedChars?: number;
  /** 排队上限，按块数再兜一层。 */
  maxQueuedJobs?: number;
  /** 单个响应最多收这么多字节。 */
  maxAudioBytes?: number;
}

/** 试听的结果：能不能合成、用了多久、不能的话为什么。 */
export interface AuditionResult {
  ok: boolean;
  /** 从开始到放完的毫秒数。 */
  ms: number;
  /** 合成那一趟的毫秒数。 */
  synthMs?: number;
  /** 试听被后来的操作取消，没有放出来。 */
  cancelled?: boolean;
  error?: string;
}

/** 合成失败后这段时间内不再试，免得限流或断线时刷屏。 */
const COOLDOWN_MS = 10_000;
/** 能力清单多久重新拿一次。 */
const CAPABILITY_TTL_MS = 60_000;

const DEFAULTS: Required<Omit<SpeakerOptions, 'url'>> & { url: string } = {
  gapMs: 0,
  prewarm: true,
  verbose: false,
  url: process.env.COOPANION_TTS_URL || DEFAULT_TTS_URL,
  requestTimeoutMs: 30_000,
  maxSegmentChars: 600,
  maxQueuedChars: 1_200,
  maxQueuedJobs: 24,
  maxAudioBytes: 8 * 1024 * 1024,
};

/** 合成请求本身的失败；`busy` 表示对端拒绝并发、不是真的坏了。 */
class SpeechError extends Error {
  constructor(message: string, readonly busy = false) {
    super(message);
  }
}

interface Job {
  seq: number;
  text: string;
  epoch: number;
  style: SpeechStyle;
  queuedAt: number;
  startedAt: number;
  synthAt: number;
  ready: Promise<void>;
  dir: string | null;
  clip: string | null;
  dead: boolean;
  spokenAt: number;
  bytes: number;
  controller: AbortController | null;
  trace?: SpeechTraceV1;
}

export interface SpeakerStats {
  chunks: number;
  spoken: number;
  failed: number;
  /** 因为队列上限只留在气泡里的块数与字数。 */
  omitted: number;
  omittedChars: number;
  /** 最近一次：第一块从排到队到出声的毫秒数。 */
  firstAudioMs: number | null;
  /** 最近一次：第一块的字数。 */
  firstChunkChars: number | null;
  /** 最近一次：最后一块说完的总耗时。 */
  totalMs: number | null;
}

export class Speaker {
  private stage: string | null = null;
  private jobs: Job[] = [];
  private current: Job | null = null;
  private epoch = 0;
  private seq = 0;
  private busy = false;
  private synthChain: Promise<void> = Promise.resolve();
  private failedAt = 0;
  private speakingNow = false;
  private warnedPlatform = false;
  private stats: SpeakerStats = {
    chunks: 0,
    spoken: 0,
    failed: 0,
    omitted: 0,
    omittedChars: 0,
    firstAudioMs: null,
    firstChunkChars: null,
    totalMs: null,
  };
  private runStart = 0;
  private options = { ...DEFAULTS };
  private auditionBusy: Promise<void> | null = null;
  private auditionTicket = 0;
  private auditionController: AbortController | null = null;
  /** 播放器一次只放一片：正常朗读和试听都排在这条线上。 */
  private playLock: Promise<PlayResult> = Promise.resolve('played');
  private queuedChars = 0;
  private omittedLogged = false;
  private capabilities: VoiceCapability | null = null;
  private capabilitiesAt = 0;
  private capabilitiesPending = false;
  private lastTrace: SpeechTraceV1 | null = null;

  constructor(private readonly log: (line: string) => void, private readonly player: Player, options: SpeakerOptions = {}) {
    this.setOptions(options);
  }

  /** 每次开口前把当前配置的开关写进来；代价只是几次赋值。 */
  setOptions(opts: SpeakerOptions): void {
    if (typeof opts.gapMs === 'number' && opts.gapMs >= 0) this.options.gapMs = Math.min(5_000, Math.round(opts.gapMs));
    if (typeof opts.prewarm === 'boolean') this.options.prewarm = opts.prewarm;
    if (typeof opts.verbose === 'boolean') this.options.verbose = opts.verbose;
    if (typeof opts.url === 'string' && opts.url.trim()) this.options.url = opts.url.trim();
    if (typeof opts.requestTimeoutMs === 'number' && opts.requestTimeoutMs > 0) this.options.requestTimeoutMs = Math.round(opts.requestTimeoutMs);
    if (typeof opts.maxSegmentChars === 'number' && opts.maxSegmentChars > 0) this.options.maxSegmentChars = Math.round(opts.maxSegmentChars);
    if (typeof opts.maxQueuedChars === 'number' && opts.maxQueuedChars > 0) this.options.maxQueuedChars = Math.round(opts.maxQueuedChars);
    if (typeof opts.maxQueuedJobs === 'number' && opts.maxQueuedJobs > 0) this.options.maxQueuedJobs = Math.round(opts.maxQueuedJobs);
    if (typeof opts.maxAudioBytes === 'number' && opts.maxAudioBytes > 0) this.options.maxAudioBytes = Math.round(opts.maxAudioBytes);
  }

  /** 预热点：把暂存目录和播放器先备好，第一块能少等几百毫秒。 */
  async warm(_style: SpeechStyle): Promise<void> {
    if (!this.supported()) return;
    try {
      this.stage ??= await mkdtemp(join(tmpdir(), 'coopanion-streamvoice-'));
      await mkdir(this.stage, { recursive: true });
      await this.player.warm(this.stage);
    } catch (err) {
      this.log(`预热点失败（不影响朗读）：${(err as Error).message}`);
    }
    // 第一句就要用到这份清单；没有缓存时等一次（最多 2 秒），别让第一句退回旧规则
    if (this.capabilities) this.refreshCapability();
    else await this.fetchCapability();
  }

  /** 本地 GPT-SoVITS 常驻，空转一次合成没有意义。 */
  prime(_style: SpeechStyle): void {}

  get speaking(): boolean {
    return this.speakingNow;
  }

  /** 还排着几块（不含正在放的）。 */
  get queued(): number {
    return this.jobs.length;
  }

  snapshot(): SpeakerStats & { queued: number; speaking: boolean; capability: VoiceCapability | null; lastTrace: SpeechTraceV1 | null } {
    return {
      ...this.stats,
      queued: this.jobs.length,
      speaking: this.speakingNow,
      capability: this.capabilities,
      lastTrace: this.lastTrace,
    };
  }

  /** 声音参考的能力清单；还没拿到时返回 null，调用方按旧行为处理。 */
  capability(): VoiceCapability | null {
    return this.capabilities;
  }

  /** 重新拿一次能力清单；失败保留上一次的。 */
  refreshCapability(force = false): void {
    if (this.capabilitiesPending) return;
    if (!force && this.capabilities && Date.now() - this.capabilitiesAt < CAPABILITY_TTL_MS) return;
    this.capabilitiesPending = true;
    void this.fetchCapability().finally(() => { this.capabilitiesPending = false; });
  }

  /** 把一块排进队列；返回即走，说的时候在后台。队列满了返回 false。 */
  say(text: string, style: SpeechStyle, trace?: SpeechTraceV1): boolean {
    let trimmed = text.trim();
    if (!trimmed) return false;
    if (!this.supported()) {
      if (!this.warnedPlatform) {
        this.warnedPlatform = true;
        this.log(`朗读要 Windows 或 macOS；${process.platform} 上跳过`);
      }
      return false;
    }
    if (trimmed.length > this.options.maxSegmentChars) trimmed = `${trimmed.slice(0, this.options.maxSegmentChars)}……`;
    if (this.jobs.length >= this.options.maxQueuedJobs || this.queuedChars + trimmed.length > this.options.maxQueuedChars) {
      // 只省略声音，气泡里的字一个不少；日志里明确说这一轮漏了语音
      this.stats.omitted++;
      this.stats.omittedChars += trimmed.length;
      if (trace) {
        trace.playbackStatus = 'cancelled';
        trace.fallbackReason = trace.fallbackReason ?? 'queue-full';
      }
      if (!this.omittedLogged) {
        this.omittedLogged = true;
        this.log(`语音省略：排队已到上限，这一轮剩下的台词只留在气泡里`);
      }
      return false;
    }
    if (!this.jobs.length && !this.current) {
      this.runStart = Date.now();
      this.stats.firstAudioMs = null;
      this.stats.firstChunkChars = null;
      this.omittedLogged = false;
      // 一段话的块号从 1 数起，日志里好认
      this.seq = 0;
    }
    this.stats.chunks++;
    const job: Job = {
      seq: ++this.seq,
      text: trimmed,
      epoch: this.epoch,
      style,
      queuedAt: Date.now(),
      startedAt: 0,
      synthAt: 0,
      ready: Promise.resolve(),
      dir: null,
      clip: null,
      dead: false,
      spokenAt: 0,
      bytes: 0,
      controller: null,
      trace,
    };
    if (trace) {
      trace.epoch = this.epoch;
      trace.playbackStatus = 'queued';
      this.lastTrace = trace;
    }
    this.jobs.push(job);
    this.queuedChars += trimmed.length;
    // 合成立刻开始，不等播放轮到它
    job.ready = this.synthChain = this.synthChain
      .then(() => this.synthesise(job))
      .catch((err: unknown) => {
        job.dead = true;
        this.stats.failed++;
        if (trace) {
          trace.playbackStatus = 'failed';
          trace.fallbackReason = trace.fallbackReason ?? (err as Error).message;
        }
        this.log(`合成失败（这一块跳过）：${(err as Error).message}`);
      });
    this.kick();
    return true;
  }

  /**
   * 试听：按给定嗓音念一句短的，并等它说完。
   *
   * 走的是和正常朗读同一条合成与播放链路（同样的音色 / 语速 / 音调 / 音量），所以它能回答
   * 「这个音色在这台机器上到底能不能出声」——合成失败会把原因原样带回去。
   * 试听优先：先清空队列再试；连点时后一次取消前一次，播放器上最多只有一次试听。
   */
  async audition(text: string, style: SpeechStyle): Promise<AuditionResult> {
    if (!this.supported()) {
      return { ok: false, ms: 0, error: `朗读要 Windows 或 macOS；${process.platform} 上没有播放器` };
    }
    const started = Date.now();
    // 先停掉正在说的和上一次试听，再以自己的代次开始
    this.hush();
    const epoch = this.epoch;
    const ticket = ++this.auditionTicket;
    let done: () => void = () => {};
    const busy = new Promise<void>((resolve) => { done = resolve; });
    this.auditionBusy = busy;
    const controller = new AbortController();
    this.auditionController = controller;
    let dir: string | null = null;
    try {
      const stage = this.stage ?? (this.stage = await mkdtemp(join(tmpdir(), 'coopanion-streamvoice-')));
      dir = await mkdtemp(join(stage, 'try-'));
      const res = await this.request(text, style, controller, epoch);
      if (ticket !== this.auditionTicket || epoch !== this.epoch) return { ok: false, ms: Date.now() - started, cancelled: true, error: '试听被取消' };
      const info = inspectWav(res.audio);
      const audioFilePath = join(dir, 'try.wav');
      await writeFile(audioFilePath, res.audio);
      const synthMs = Date.now() - started;
      const result = await this.playOwned(audioFilePath, epoch);
      if (result === 'cut') return { ok: false, ms: Date.now() - started, synthMs, cancelled: true, error: '试听被取消' };
      void this.player.warm(stage).catch(() => {});
      if (result === 'played') {
        if (this.options.verbose) this.log(`试听合成 ${synthMs}ms，音频 ${info.durationMs}ms`);
        return { ok: true, ms: Date.now() - started, synthMs };
      }
      return { ok: false, ms: Date.now() - started, synthMs, error: '合成出来了，但没能放出来（播放器没响应）' };
    } catch (err) {
      if (epoch !== this.epoch) return { ok: false, ms: Date.now() - started, cancelled: true, error: '试听被取消' };
      return { ok: false, ms: Date.now() - started, error: (err as Error).message };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      if (this.auditionController === controller) this.auditionController = null;
      if (this.auditionBusy === busy) this.auditionBusy = null;
      done();
    }
  }

  /** 停下正在说的，丢掉还在排队的，中止在路上的请求。代次一变，早先的结果回来也不再生效。 */
  hush(): void {
    this.epoch++;
    this.auditionTicket++;
    this.auditionController?.abort(new Error('取消'));
    const live = new Set<Job>(this.jobs);
    if (this.current) live.add(this.current);
    this.jobs = [];
    this.current = null;
    this.queuedChars = 0;
    this.speakingNow = false;
    for (const job of live) {
      job.dead = true;
      job.controller?.abort(new Error('取消'));
      if (job.trace && (job.trace.playbackStatus === 'queued' || job.trace.playbackStatus === 'playing')) {
        job.trace.playbackStatus = 'cancelled';
      }
      void this.discard(job);
    }
    this.player.hush();
    // 下一次开口别等播放器启动：先把新的一个点起来
    const stage = this.stage;
    if (stage) void this.player.warm(stage).catch(() => {});
  }

  async stop(): Promise<void> {
    this.hush();
    await this.player.stop().catch(() => {});
    if (this.stage) {
      await rm(this.stage, { recursive: true, force: true }).catch(() => {});
      this.stage = null;
    }
  }

  private supported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  private kick(): void {
    if (this.busy) return;
    this.busy = true;
    void this.run().finally(() => {
      this.busy = false;
      if (this.jobs.length) this.kick();
    });
  }

  private async run(): Promise<void> {
    while (this.jobs.length) {
      // 试听在用播放器，等它说完再接着念
      if (this.auditionBusy) await this.auditionBusy;
      const job = this.jobs[0];
      if (!job) continue;
      if (job.epoch !== this.epoch) {
        this.take(job);
        await this.discard(job);
        continue;
      }
      this.current = job;
      await job.ready;
      if (job.epoch !== this.epoch || job.dead || !job.clip) {
        if (this.current === job) this.current = null;
        this.take(job);
        await this.discard(job);
        continue;
      }
      job.spokenAt = Date.now();
      const first = this.stats.firstAudioMs === null;
      if (first) {
        this.stats.firstAudioMs = job.spokenAt - job.queuedAt;
        this.stats.firstChunkChars = job.text.length;
      }
      if (first || this.options.verbose) {
        this.log(`第 ${job.seq} 块出声（${first ? `切出后 ${this.stats.firstAudioMs}ms，` : ''}合成 ${job.synthAt - job.startedAt}ms，等播放 ${job.spokenAt - job.synthAt}ms）`);
      }
      const result = await this.playOwned(job.clip, job.epoch, job.trace);
      if (this.current === job) this.current = null;
      this.take(job);
      await this.discard(job);
      if (job.epoch !== this.epoch) continue;
      if (result === 'played') {
        this.stats.spoken++;
        if (job.trace) {
          job.trace.playbackStatus = 'finished';
          job.trace.playbackEvidence = 'player-exit';
        }
      } else if (result === 'failed') {
        this.stats.failed++;
        if (job.trace) job.trace.playbackStatus = 'failed';
        this.log('这一块没能放出来');
      } else if (job.trace) {
        job.trace.playbackStatus = 'cancelled';
      }
      this.stats.totalMs = Date.now() - this.runStart;
      if (this.options.gapMs > 0 && this.jobs.length) await sleep(this.options.gapMs);
      if (this.options.verbose) {
        this.log(`说完第 ${job.seq} 块（${job.text.length} 字，合成 ${job.synthAt - job.startedAt}ms，本轮共 ${this.stats.totalMs}ms）`);
      }
    }
  }

  /** 把 job 从队列头上拿掉；hush 之后队列可能已经不是原来那条了。 */
  private take(job: Job): void {
    const at = this.jobs.indexOf(job);
    if (at < 0) return;
    this.jobs.splice(at, 1);
    this.queuedChars = Math.max(0, this.queuedChars - job.text.length);
  }

  private async discard(job: Job): Promise<void> {
    const dir = job.dir;
    job.dir = null;
    if (!dir) return;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /** 播放器所有权：一次只放一片，进播放器前复核代次。 */
  private playOwned(clip: string, epoch: number, trace?: SpeechTraceV1): Promise<PlayResult> {
    const run = this.playLock.then(() => this.playOnce(clip, epoch, trace), () => this.playOnce(clip, epoch, trace));
    this.playLock = run.catch((): PlayResult => 'failed');
    return run;
  }

  private async playOnce(clip: string, epoch: number, trace?: SpeechTraceV1): Promise<PlayResult> {
    if (epoch !== this.epoch) return 'cut';
    if (trace) {
      trace.playbackStatus = 'playing';
      trace.playbackEvidence = 'player-call';
    }
    this.speakingNow = true;
    try {
      return await this.player.play(clip);
    } catch (err) {
      this.log(`播放器失败：${(err as Error).message}`);
      return 'failed';
    } finally {
      this.speakingNow = false;
    }
  }

  private async synthesise(job: Job): Promise<void> {
    if (job.epoch !== this.epoch) return;
    job.startedAt = Date.now();
    if (Date.now() - this.failedAt < COOLDOWN_MS) {
      job.dead = true;
      return;
    }
    const controller = new AbortController();
    job.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error(`合成超过 ${this.options.requestTimeoutMs}ms`)), this.options.requestTimeoutMs);
    try {
      const stage = this.stage ?? (this.stage = await mkdtemp(join(tmpdir(), 'coopanion-streamvoice-')));
      const dir = await mkdtemp(join(stage, `c${job.seq}-`));
      job.dir = dir;
      // 取消可能发生在任何一步之后：结果丢掉，这次任务占的目录也一并清掉
      if (job.epoch !== this.epoch) return await this.discard(job);
      const res = await this.request(job.text, job.style, controller, job.epoch);
      if (job.epoch !== this.epoch) return await this.discard(job);
      inspectWav(res.audio);
      const file = join(dir, 'chunk.wav');
      await writeFile(file, res.audio);
      if (job.epoch !== this.epoch) return await this.discard(job);
      job.clip = file;
      job.synthAt = Date.now();
      job.bytes = res.audio.length;
      if (job.trace) {
        job.trace.selectedReference = res.reference;
        job.trace.capabilityFingerprint = res.capability;
        if (res.fallback) job.trace.fallbackReason = res.fallback;
      }
    } catch (err) {
      // 自己取消的不算失败：既不计入失败率，也不触发冷却
      if (job.epoch !== this.epoch) return await this.discard(job);
      if (err instanceof SpeechError && err.busy) {
        job.dead = true;
        if (job.trace) {
          job.trace.playbackStatus = 'cancelled';
          job.trace.fallbackReason = job.trace.fallbackReason ?? 'service-busy';
        }
        this.log('合成服务忙，这一段只留在气泡里');
        return;
      }
      this.failedAt = Date.now();
      throw err;
    } finally {
      clearTimeout(timer);
      if (job.controller === controller) job.controller = null;
    }
  }

  private async request(
    text: string,
    style: SpeechStyle,
    controller: AbortController,
    epoch: number,
  ): Promise<{ audio: Buffer; reference?: string; capability?: string; fallback?: string }> {
    const res = await fetch(this.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-sovits',
        input: text,
        voice: style.voice,
        emotion: style.emotion ?? '',
        response_format: 'wav',
        sample_rate: 32000,
      }),
      signal: controller.signal,
    });
    if (res.status === 429) {
      await res.text().catch(() => '');
      throw new SpeechError('合成服务正忙', true);
    }
    if (!res.ok) throw new SpeechError(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > this.options.maxAudioBytes) {
      await res.body?.cancel().catch(() => {});
      throw new SpeechError(`音频响应太大（${declared} 字节）`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (epoch !== this.epoch) throw new Error('取消');
    if (audio.length > this.options.maxAudioBytes) throw new SpeechError(`音频响应太大（${audio.length} 字节）`);
    return {
      audio,
      reference: res.headers.get('x-coopanion-reference') ?? undefined,
      capability: res.headers.get('x-coopanion-capability') ?? undefined,
      fallback: res.headers.get('x-coopanion-fallback') ?? undefined,
    };
  }

  private async fetchCapability(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const url = this.options.url.replace(/\/v1\/audio\/speech\/?$/, '/capabilities');
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return;
      const body = await res.json() as {
        fingerprint?: unknown;
        default?: unknown;
        references?: unknown;
        aliases?: unknown;
      };
      const references = Array.isArray(body.references)
        ? body.references
          .map((item) => (typeof item === 'string' ? item : String((item as { id?: unknown })?.id ?? '')))
          .filter(Boolean)
        : [];
      const aliases = body.aliases && typeof body.aliases === 'object' ? body.aliases as Record<string, string> : {};
      this.capabilities = {
        fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : undefined,
        default: typeof body.default === 'string' ? body.default : undefined,
        references,
        aliases,
      };
      this.capabilitiesAt = Date.now();
    } catch {
      // 拿不到就继续用上一次的；null 表示按旧行为把所有标记当情绪
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationMs: number;
}

/** 播放前确认手里是一片真的 WAV，顺便读出真实的采样率、声道和时长。 */
export function inspectWav(bytes: Buffer): WavInfo {
  if (bytes.length < 44) throw new SpeechError(`音频太短（${bytes.length} 字节）`);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new SpeechError('响应不是 WAV');
  }
  let at = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number } | null = null;
  let dataSize = 0;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = at + 8;
    if (body + size > bytes.length) break;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        blockAlign: bytes.readUInt16LE(body + 12),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = Math.min(size, bytes.length - body);
      break;
    }
    at = body + size + (size % 2);
  }
  if (!fmt) throw new SpeechError('WAV 缺少 fmt 段');
  if (fmt.format !== 1 && fmt.format !== 3 && fmt.format !== 0xfffe) throw new SpeechError(`不支持的 WAV 编码 ${fmt.format}`);
  if (fmt.channels < 1 || fmt.channels > 2) throw new SpeechError(`不支持的声道数 ${fmt.channels}`);
  if (fmt.sampleRate < 8_000 || fmt.sampleRate > 96_000) throw new SpeechError(`不支持的采样率 ${fmt.sampleRate}`);
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) throw new SpeechError(`不支持的位深 ${fmt.bitsPerSample}`);
  if (dataSize <= 0) throw new SpeechError('WAV 没有音频数据');
  const blockAlign = fmt.blockAlign || (fmt.channels * fmt.bitsPerSample) / 8;
  if (!blockAlign) throw new SpeechError('WAV 的块对齐不是合法值');
  const frames = dataSize / blockAlign;
  const durationMs = Math.round((frames / fmt.sampleRate) * 1000);
  if (durationMs <= 0) throw new SpeechError('WAV 时长为 0');
  if (durationMs > 600_000) throw new SpeechError(`WAV 时长不合理（${durationMs}ms）`);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, durationMs };
}

/** 等一会儿；块与块之间的停顿用它。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
