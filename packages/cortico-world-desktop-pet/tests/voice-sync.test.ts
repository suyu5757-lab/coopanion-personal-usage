import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { parseScriptWithSpans } from '../src/script.ts';
import { PetServer } from '../src/server.ts';
import {
  VOICE_DONE_HOLD_S,
  createVoiceSyncState,
  normalizeClockSnapshot,
  speechClean,
  stepVoiceSync,
} from '../web/voice-sync.js';

describe('Rev31 Voice V5 unified voice-bubble sync', () => {
  it('isolates identical phrases across generations and rejects late receipts from old turns', () => {
    const phrase = '好，我知道了。';
    const beatA = {
      bubbleId: 's1:b0',
      generationId: 'resp_gen_A',
      outputIndex: 0,
      segmentPrefix: 'resp_gen_A#0:',
      sayEpoch: 1,
      scriptStart: 0,
      scriptEnd: phrase.length,
      text: phrase,
    };
    const beatB = {
      bubbleId: 's2:b0',
      generationId: 'resp_gen_B',
      outputIndex: 0,
      segmentPrefix: 'resp_gen_B#0:',
      sayEpoch: 2,
      scriptStart: 0,
      scriptEnd: phrase.length,
      text: phrase,
    };

    const stateB = createVoiceSyncState(beatB, 10);

    // Generation A is still playing the exact same Chinese phrase -> Beat B MUST NOT bind to it.
    const r1 = stepVoiceSync(stateB, {
      ok: true,
      clockStatus: 'ok',
      epoch: 1,
      playing: true,
      current: {
        id: 'sv-job-A',
        text: phrase,
        elapsed: 0.6,
        duration: 1.4,
        done: false,
        generation_done: true,
        generationId: 'resp_gen_A',
        segmentId: 'resp_gen_A#0:1',
        textStart: 0,
        textEnd: phrase.length,
      },
      queue: [],
      recent_finished: [],
    }, 10.2, 0.05);

    expect(r1.handled).toBe(true);
    expect(r1.shown).toBe(0);
    expect(stateB.jobs.size).toBe(0);
    expect(stateB.matched).toBe(false);

    // Late receipt from Generation A must also be ignored by Beat B.
    const r2 = stepVoiceSync(stateB, {
      ok: true,
      clockStatus: 'ok',
      epoch: 1,
      playing: false,
      current: null,
      queue: [],
      recent_finished: [{
        id: 'sv-job-A',
        ok: true,
        cancelled: false,
        error: null,
        generationId: 'resp_gen_A',
        segmentId: 'resp_gen_A#0:1',
      }],
    }, 10.4, 0.05);

    expect(r2.beatDone).toBe(false);
    expect(r2.shown).toBe(0);

    // Now Generation B's own job plays and finishes -> Beat B binds and completes cleanly.
    const r3 = stepVoiceSync(stateB, {
      ok: true,
      clockStatus: 'ok',
      epoch: 1,
      playing: true,
      current: {
        id: 'sv-job-B',
        text: phrase,
        elapsed: 0.7,
        duration: 1.4,
        done: false,
        generation_done: true,
        generationId: 'resp_gen_B',
        segmentId: 'resp_gen_B#0:1',
        textStart: 0,
        textEnd: phrase.length,
      },
      queue: [],
      recent_finished: [],
    }, 10.6, 0.1);

    expect(stateB.matched).toBe(true);
    expect(stateB.jobs.has('sv-job-B')).toBe(true);
    expect(r3.shown).toBeGreaterThan(0);
    expect(r3.shown).toBeLessThan(phrase.length);

    const r4 = stepVoiceSync(stateB, {
      ok: true,
      clockStatus: 'ok',
      epoch: 1,
      playing: false,
      current: null,
      queue: [],
      recent_finished: [{
        id: 'sv-job-B',
        ok: true,
        cancelled: false,
        error: null,
        generationId: 'resp_gen_B',
        segmentId: 'resp_gen_B#0:1',
      }],
    }, 11.6, 0.1);

    expect(r4.beatDone).toBe(true);
    expect(r4.shown).toBe(phrase.length);
    expect(r4.holdSeconds).toBe(VOICE_DONE_HOLD_S);
    expect(beatA.bubbleId).not.toBe(beatB.bubbleId);
  });

  it('handles 1 bubble -> 2 jobs, cross-bubble job slicing, and emoji/Markdown normalization', () => {
    // 1) One bubble spanning 2 jobs with emoji & Markdown.
    const rawText = '先看**第一句**😊，再看第二句！';
    const beat = {
      bubbleId: 's3:b0',
      generationId: 'resp_multi',
      outputIndex: 0,
      segmentPrefix: 'resp_multi#0:',
      sayEpoch: 1,
      scriptStart: 0,
      scriptEnd: rawText.length,
      text: rawText,
    };
    const st = createVoiceSyncState(beat, 0);
    expect(speechClean(rawText).clean).toBe('先看第一句，再看第二句！');

    const job1 = {
      id: 'sv-1',
      text: '先看 第一句 ，',
      elapsed: 0.9,
      duration: 1.5,
      done: false,
      generation_done: true,
      generationId: 'resp_multi',
      segmentId: 'resp_multi#0:1',
      textStart: 0,
      textEnd: 12,
    };
    const job2 = {
      id: 'sv-2',
      text: '再看第二句！',
      elapsed: 0,
      duration: 1.3,
      done: false,
      generation_done: true,
      generationId: 'resp_multi',
      segmentId: 'resp_multi#0:2',
      textStart: 12,
      textEnd: rawText.length,
    };

    let res = stepVoiceSync(st, { ok: true, clockStatus: 'ok', epoch: 0, playing: true, current: job1, queue: [job2], recent_finished: [] }, 0.9, 0.1);
    const midShown = res.shown;
    expect(midShown).toBeGreaterThan(0);
    expect(res.beatDone).toBe(false);

    // Job 1 finishes, Job 2 starts -> monotonic, never jumps backwards.
    res = stepVoiceSync(st, {
      ok: true,
      clockStatus: 'ok',
      epoch: 0,
      playing: true,
      current: { ...job2, elapsed: 0.4 },
      queue: [],
      recent_finished: [{ id: 'sv-1', ok: true, generationId: 'resp_multi' }],
    }, 1.8, 0.1);
    expect(res.shown).toBeGreaterThanOrEqual(midShown);
    expect(res.beatDone).toBe(false);

    // Job 2 finishes -> whole bubble completes.
    res = stepVoiceSync(st, {
      ok: true,
      clockStatus: 'ok',
      epoch: 0,
      playing: false,
      current: null,
      queue: [],
      recent_finished: [
        { id: 'sv-1', ok: true, generationId: 'resp_multi' },
        { id: 'sv-2', ok: true, generationId: 'resp_multi' },
      ],
    }, 3.0, 0.1);
    expect(res.beatDone).toBe(true);
    expect(res.shown).toBe(rawText.length);

    // 2) Cross-bubble job: parseScriptWithSpans produces exact scriptStart/scriptEnd for 2 beats covered by 1 job.
    const { beats, spans } = parseScriptWithSpans('【happy】前半句先说。【smile】后半句接着说。', [
      { id: 'happy', kind: 'expression', names: {}, about: {}, seconds: 1 },
      { id: 'smile', kind: 'expression', names: {}, about: {}, seconds: 1 },
    ]);
    expect(beats).toHaveLength(2);
    expect(spans[0]!.scriptStart).toBe(0);
    expect(spans[0]!.scriptEnd).toBe(6);
    expect(spans[1]!.scriptStart).toBe(6);
    expect(spans[1]!.scriptEnd).toBe(13);

    const b0State = createVoiceSyncState({ ...beats[0], ...spans[0], generationId: 'resp_cross', outputIndex: 0, bubbleId: 's4:b0' }, 0);
    const crossJob = {
      id: 'sv-cross',
      text: '前半句先说。后半句接着说。',
      elapsed: 1.5,
      duration: 2.6,
      done: false,
      generation_done: true,
      generationId: 'resp_cross',
      segmentId: 'resp_cross#0:1',
      textStart: 0,
      textEnd: 13,
    };
    const crossRes = stepVoiceSync(b0State, { ok: true, clockStatus: 'ok', epoch: 0, playing: true, current: crossJob, queue: [], recent_finished: [] }, 1.5, 0.1);
    expect(crossRes.beatDone).toBe(true);
    expect(crossRes.shown).toBe(beats[0]!.text.length);
  });

  it('distinguishes clock outages from idle/finished, freezes briefly, recovers smoothly, and degrades cleanly', () => {
    const text = '这是一段用来测试时钟短暂故障和恢复的长句子，应该平滑追赶而不是直接跳完。';
    const st = createVoiceSyncState({
      bubbleId: 's5:b0',
      generationId: 'resp_clk',
      outputIndex: 0,
      scriptStart: 0,
      scriptEnd: text.length,
      text,
    }, 0);

    // Starts playing cleanly.
    const r0 = stepVoiceSync(st, {
      ok: true,
      clockStatus: 'ok',
      epoch: 0,
      playing: true,
      current: {
        id: 'sv-clk',
        text,
        elapsed: 1.2,
        duration: 7.0,
        done: false,
        generation_done: true,
        generationId: 'resp_clk',
        segmentId: 'resp_clk#0:1',
        textStart: 0,
        textEnd: text.length,
      },
      queue: [],
      recent_finished: [],
    }, 1.2, 0.1);
    expect(st.syncMode).toBe('synced');
    const shownBeforeOutage = r0.shown;

    // 1.5s transient timeout outage: MUST NOT mark finished or fall back yet.
    const rOut1 = stepVoiceSync(st, { ok: false, clockStatus: 'timeout', playing: false, current: null, queue: [] }, 1.7, 0.1);
    const rOut2 = stepVoiceSync(st, { ok: false, clockStatus: 'unavailable', playing: false, current: null, queue: [] }, 2.7, 0.1);
    expect(rOut1.handled).toBe(true);
    expect(rOut1.beatDone).toBe(false);
    expect(rOut2.handled).toBe(true);
    expect(rOut2.syncMode).toBe('degraded');
    expect(rOut2.shown).toBe(shownBeforeOutage);

    // Clock recovers at elapsed=3.5s -> smooth rate-limited catch-up (MUST NOT teleport all chars in 1 frame).
    const rRec = stepVoiceSync(st, {
      ok: true,
      clockStatus: 'ok',
      epoch: 0,
      playing: true,
      current: {
        id: 'sv-clk',
        text,
        elapsed: 3.5,
        duration: 7.0,
        done: false,
        generation_done: true,
        generationId: 'resp_clk',
        segmentId: 'resp_clk#0:1',
        textStart: 0,
        textEnd: text.length,
      },
      queue: [],
      recent_finished: [],
    }, 3.5, 0.05);
    expect(rRec.syncMode).toBe('synced');
    expect(rRec.shown - shownBeforeOutage).toBeLessThanOrEqual(2);

    // Sustained outage (> 2.5s) -> explicit unsynced fallback, never faking finished.
    stepVoiceSync(st, { ok: false, clockStatus: 'timeout', playing: false, current: null, queue: [] }, 4.0, 0.05);
    const rFall = stepVoiceSync(st, { ok: false, clockStatus: 'timeout', playing: false, current: null, queue: [] }, 7.0, 0.05);
    expect(rFall.handled).toBe(false);
    expect(rFall.beatDone).toBe(false);
    expect(rFall.syncMode).toBe('fallback');
    expect(rFall.reason).toBe('clock-timeout');

    // Pure text-only bubble when worker is healthy & idle -> exits waiting after 1.6s grace.
    const textOnly = createVoiceSyncState({ bubbleId: 's6:b0', text: '纯文字气泡' }, 20);
    const w1 = stepVoiceSync(textOnly, { ok: true, clockStatus: 'ok', epoch: 0, playing: false, current: null, queue: [] }, 20.5, 0.05);
    expect(w1.handled).toBe(true);
    const w2 = stepVoiceSync(textOnly, { ok: true, clockStatus: 'ok', epoch: 0, playing: false, current: null, queue: [] }, 21.8, 0.05);
    expect(w2.handled).toBe(false);
    expect(w2.syncMode).toBe('text-only');
  });

  it('removes 1.06 + 1 lead and handles worker epoch cancellation cleanly', () => {
    const text = '今天天气真不错，我们一起出去散散步吧。';
    const st = createVoiceSyncState({
      bubbleId: 's7:b0',
      generationId: 'resp_pace',
      outputIndex: 0,
      scriptStart: 0,
      scriptEnd: text.length,
      text,
    }, 0);

    // At 50% audio elapsed (2.0s / 4.0s), visible chars must NOT race ahead past ~50% (old 1.06+1 would exceed).
    let res = { shown: 0, beatDone: false, cancelled: false, holdSeconds: 0, handled: true, syncMode: 'waiting', reason: null as string | null };
    for (let t = 0.2; t <= 2.0; t += 0.1) {
      res = stepVoiceSync(st, {
        ok: true,
        clockStatus: 'ok',
        epoch: 3,
        playing: true,
        current: {
          id: 'sv-pace',
          text,
          elapsed: t,
          duration: 4.0,
          done: false,
          generation_done: true,
          generationId: 'resp_pace',
          segmentId: 'resp_pace#0:1',
          textStart: 0,
          textEnd: text.length,
        },
        queue: [],
        recent_finished: [],
      }, t, 0.1);
    }
    expect(res.shown).toBeGreaterThanOrEqual(6);
    expect(res.shown).toBeLessThanOrEqual(11);

    // Worker epoch bump while active -> immediate cancellation with 0s hold.
    const cancelRes = stepVoiceSync(st, {
      ok: true,
      clockStatus: 'ok',
      epoch: 4,
      playing: false,
      current: null,
      queue: [],
      recent_finished: [],
    }, 2.2, 0.05);
    expect(cancelRes.beatDone).toBe(true);
    expect(cancelRes.cancelled).toBe(true);
    expect(cancelRes.holdSeconds).toBe(0);
  });

  it('server /api/clock distinguishes ok vs error vs timeout without disguising faults as idle', async () => {
    let mode: 'ok' | 'error' | 'timeout' = 'ok';
    const fakeWorker = createServer((req, res) => {
      if (req.url === '/clock') {
        if (mode === 'ok') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, epoch: 7, playing: false, current: null, queue: [], recent_finished: [] }));
          return;
        }
        if (mode === 'error') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'busy' }));
          return;
        }
        // timeout: hold longer than 500ms
        setTimeout(() => { if (!res.writableEnded) res.end(); }, 900);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => fakeWorker.listen(0, '127.0.0.1', () => r()));
    const workerPort = (fakeWorker.address() as { port: number }).port;
    const prevUrl = process.env.COOPANION_MLX_URL;
    process.env.COOPANION_MLX_URL = `http://127.0.0.1:${workerPort}`;

    const petServer = new PetServer({
      port: () => 0,
      webDir: new URL('../web/', import.meta.url).pathname,
      snapshot: () => ({}),
      onPetMessage: () => {},
      onAudio: () => {},
      onPetConnect: () => {},
      onPetDisconnect: () => {},
      onSkin: () => {},
      onPrefs: () => {},
    });
    await petServer.start();
    try {
      const okJson = await (await fetch(`${petServer.origin}/api/clock`)).json() as Record<string, unknown>;
      expect(okJson.ok).toBe(true);
      expect(okJson.clockStatus).toBe('ok');
      expect(okJson.playing).toBe(false);

      mode = 'error';
      const errJson = await (await fetch(`${petServer.origin}/api/clock`)).json() as Record<string, unknown>;
      expect(errJson.ok).toBe(false);
      expect(errJson.clockStatus).toBe('error');
      expect(errJson.httpStatus).toBe(503);

      mode = 'timeout';
      const toJson = await (await fetch(`${petServer.origin}/api/clock`)).json() as Record<string, unknown>;
      expect(toJson.ok).toBe(false);
      expect(toJson.clockStatus).toBe('timeout');
      expect(normalizeClockSnapshot(toJson).ok).toBe(false);
    } finally {
      await petServer.stop();
      fakeWorker.close();
      if (prevUrl === undefined) delete process.env.COOPANION_MLX_URL;
      else process.env.COOPANION_MLX_URL = prevUrl;
    }
  });

  it('enforces strict outputIndex / segmentPrefix ordering within a generation even when later segments arrive first', () => {
    const textA = '第一句先说，不能被第二句抢跑。';
    const textB = '第二句字数更长，即使先到达也不能绑定到第一句的气泡上。';
    const beat1 = createVoiceSyncState({
      bubbleId: 's10:b0',
      generationId: 'gen_order_1',
      outputIndex: 1,
      segmentPrefix: 'gen_order_1#1:',
      sayEpoch: 5,
      scriptStart: 0,
      scriptEnd: textA.length,
      text: textA,
    }, 0);

    // Even if #2:1 somehow appeared in clock ahead of #1:1, Beat 1 (#1:) MUST NOT bind to #2:1.
    const rWrong = stepVoiceSync(beat1, {
      ok: true,
      clockStatus: 'ok',
      epoch: 1,
      playing: true,
      current: {
        id: 'sv-order-2',
        text: textB,
        elapsed: 0.5,
        duration: 3.0,
        done: false,
        generation_done: true,
        generationId: 'gen_order_1',
        segmentId: 'gen_order_1#2:1',
        textStart: 0,
        textEnd: textB.length,
      },
      queue: [],
      recent_finished: [],
    }, 0.5, 0.05);
    expect(beat1.matched).toBe(false);
    expect(beat1.jobs.size).toBe(0);
    expect(rWrong.shown).toBe(0);

    // Once #1:1 plays, Beat 1 binds cleanly and advances.
    const rRight = stepVoiceSync(beat1, {
      ok: true,
      clockStatus: 'ok',
      epoch: 1,
      playing: true,
      current: {
        id: 'sv-order-1',
        text: textA,
        elapsed: 0.8,
        duration: 2.2,
        done: false,
        generation_done: true,
        generationId: 'gen_order_1',
        segmentId: 'gen_order_1#1:1',
        textStart: 0,
        textEnd: textA.length,
      },
      queue: [],
      recent_finished: [],
    }, 1.0, 0.1);
    expect(beat1.matched).toBe(true);
    expect(beat1.jobs.has('sv-order-1')).toBe(true);
    expect(rRight.shown).toBeGreaterThan(0);
  });
});
