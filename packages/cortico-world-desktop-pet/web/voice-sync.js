/**
 * Natural approximate voice-bubble sync state machine for Coopanion Desktop Pet (Rev31 Voice V5).
 *
 * Design contract:
 * - Trusted identity binding: prefers (generationId, segmentPrefix/outputIndex, scriptStart..scriptEnd)
 *   from Core/World/StreamVoice over text heuristics. Never lets an old generation or mismatched
 *   segment match a new bubble, even when two turns contain identical Chinese phrases.
 * - Authoritative clock semantics: distinguishes `clockStatus: 'ok'` (idle vs playing) from
 *   `timeout | unavailable | error` (unknown). Transient outages hold the last trusted position
 *   smoothly for a bounded window; sustained outages degrade explicitly to `fallback` (never faking
 *   `finished`).
 * - Natural approximate progression: removes the old `1.06 * rate + 1` lead. Uses CoreAudio pipe
 *   latency compensation, punctuation-weighted rhythm anchors, cross-bubble interval slicing, and
 *   smooth monotonic frame rate-limiting so visible text naturally tracks audible speech (~0.5-1s).
 */

/** Characters stripped by StreamVoice speakable(), plus whitespace. */
const SPEECH_NOISE = /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;
const CLAUSE_PAUSE = /[，,、：:；;]/;
const SENTENCE_PAUSE = /[。！？!?…]/;

/** Audio output pipe latency compensation (seconds) from ffmpeg stdin write to audible speaker output. */
const AUDIO_LATENCY_S = 0.12;
/** Max seconds to freeze at the last trusted position during a transient clock outage before fallback. */
const CLOCK_OUTAGE_FREEZE_S = 2.5;
/** Max seconds a matched beat waits without any clock progress before degrading to unsynced fallback. */
const MATCHED_STALL_S = 35;
/** Grace window (seconds) for an idle healthy worker before treating a bubble as text-only. */
const IDLE_NO_AUDIO_GRACE_S = 1.6;
/** Grace window (seconds) between consecutive jobs when worker briefly reports idle. */
const INTER_JOB_GRACE_S = 3.0;
/** Max seconds to wait for a busy worker to reach this bubble before falling back. */
const BUSY_QUEUE_WAIT_S = 60.0;
/** Upper bound on smooth catch-up speed (cleaned chars/s) so clock recovery never teleports text. */
const MAX_CATCHUP_CPS = 18.0;
/** Minimum smooth catch-up speed (cleaned chars/s) for short/responsive starts. */
const MIN_CATCHUP_CPS = 7.5;
/** Hold duration (seconds) after authoritative audio completion before advancing to the next bubble. */
export const VOICE_DONE_HOLD_S = 0.45;

/**
 * Cleans display text identically to StreamVoice's speakable() + whitespace removal.
 * `map[i]` is the UTF-16 index in `text` corresponding to `clean[i]`.
 */
export function speechClean(text) {
  const out = [];
  const map = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      const m = /^https?:\/\/\S+/.exec(rest);
      if (m) { i += m[0].length; continue; }
    }
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const step = ch.length;
    if (/\s/.test(ch) || /[*_`~#>|]/.test(ch) || SPEECH_NOISE.test(ch)) { i += step; continue; }
    out.push(ch);
    map.push(i);
    i += step;
  }
  return { clean: out.join(''), map };
}

/**
 * Builds cumulative rhythm weights for a cleaned string so punctuation marks absorb slightly more
 * audio duration than ordinary characters (natural clause/sentence pacing without forced alignment).
 */
export function buildRhythmWeights(clean) {
  const cum = new Array(clean.length + 1);
  cum[0] = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const w = SENTENCE_PAUSE.test(ch) ? 2.4 : CLAUSE_PAUSE.test(ch) ? 1.6 : 1.0;
    cum[i + 1] = cum[i] + w;
  }
  return cum;
}

/** Maps a fraction in [0, 1] onto a character count in [0, len] using rhythm weights. */
function weightedCharCount(cum, fraction) {
  const len = cum.length - 1;
  if (len <= 0) return 0;
  const total = cum[len];
  if (!(total > 0)) return 0;
  const targetW = Math.max(0, Math.min(1, fraction)) * total;
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= targetW) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Normalizes a `/api/clock` response (or network failure) into a canonical snapshot with explicit
 * `clockStatus`: `'ok' | 'timeout' | 'unavailable' | 'error'`.
 */
export function normalizeClockSnapshot(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, clockStatus: 'unavailable', playing: false, current: null, queue: [], recent_finished: [] };
  }
  const status = typeof raw.clockStatus === 'string'
    ? raw.clockStatus
    : raw.ok === false
      ? 'error'
      : 'ok';
  const ok = status === 'ok' && raw.ok !== false;
  return {
    ...raw,
    ok,
    clockStatus: status,
    playing: ok ? Boolean(raw.playing) : false,
    current: ok ? (raw.current ?? null) : null,
    queue: ok && Array.isArray(raw.queue) ? raw.queue : [],
    recent_finished: ok && Array.isArray(raw.recent_finished) ? raw.recent_finished : [],
  };
}

/**
 * Creates a fresh per-beat voice-bubble sync state.
 * `beat` may carry trusted identity fields from DesktopPetWorld:
 * `{ bubbleId, generationId, outputIndex, segmentPrefix, sayEpoch, scriptStart, scriptEnd, text }`.
 */
export function createVoiceSyncState(beat, now, latestClock = null) {
  const text = typeof beat?.text === 'string' ? beat.text : '';
  const { clean, map } = speechClean(text);
  const hasTrustedId = typeof beat?.generationId === 'string' && beat.generationId.length > 0;
  const hasRange = typeof beat?.scriptStart === 'number' && typeof beat?.scriptEnd === 'number' && beat.scriptEnd > beat.scriptStart;
  const segmentPrefix = typeof beat?.segmentPrefix === 'string' && beat.segmentPrefix
    ? beat.segmentPrefix
    : hasTrustedId && typeof beat?.outputIndex === 'number'
      ? `${beat.generationId}#${beat.outputIndex}:`
      : null;

  return {
    bubbleId: beat?.bubbleId || null,
    generationId: hasTrustedId ? beat.generationId : null,
    outputIndex: typeof beat?.outputIndex === 'number' ? beat.outputIndex : null,
    segmentPrefix,
    sayEpoch: typeof beat?.sayEpoch === 'number' ? beat.sayEpoch : null,
    scriptStart: hasRange ? beat.scriptStart : null,
    scriptEnd: hasRange ? beat.scriptEnd : null,
    text,
    clean,
    map,
    jobs: new Map(),
    matchCursor: 0,
    doneCursor: 0,
    displayCursor: 0,
    lastShown: 0,
    matched: false,
    active: false,
    misaligned: false,
    workerEpoch: latestClock?.ok && typeof latestClock.epoch === 'number' ? latestClock.epoch : null,
    startedAt: now,
    lastProgressAt: now,
    lastBusyAt: undefined,
    outageSince: null,
    syncMode: clean ? 'waiting' : 'text-only', // waiting | synced | degraded | fallback | text-only
    fallbackReason: clean ? null : 'empty-speakable',
    off: !clean,
  };
}

/** Checks whether a worker job belongs to this beat's trusted identity. */
function matchesIdentity(state, job) {
  if (!job) return false;
  if (state.generationId) {
    // Trusted generationId is mandatory when the beat carries one: never match an untrusted or other-gen job.
    if (!job.generationId || job.generationId !== state.generationId) return false;
    if (state.segmentPrefix && typeof job.segmentId === 'string' && job.segmentId) {
      if (!job.segmentId.startsWith(state.segmentPrefix)) return false;
    }
    return true;
  }
  // Legacy / untrusted beat (no generationId): only allow matching jobs that also lack generationId,
  // or allow legacy text matching when StreamVoice wasn't bridged.
  return true;
}

/**
 * Computes the binding between a worker job and this beat's cleaned text.
 * Supports:
 * 1. Exact shared coordinate-space interval intersection (`scriptStart..scriptEnd` ∩ `job.textStart..job.textEnd`),
 *    handling 1 bubble -> N jobs AND 1 cross-bubble job -> 2 bubbles cleanly.
 * 2. Sequential cleaned-text matching when coordinates are absent (legacy protocol).
 */
function bindJobToBeat(state, job) {
  const jc = speechClean(job.text || '').clean;
  if (!jc) return null;

  const hasBeatRange = state.scriptStart !== null && state.scriptEnd !== null;
  const hasJobRange = typeof job.textStart === 'number' && typeof job.textEnd === 'number' && job.textEnd > job.textStart;

  if (state.generationId && job.generationId === state.generationId && hasBeatRange && hasJobRange) {
    const overlapStart = Math.max(state.scriptStart, job.textStart);
    const overlapEnd = Math.min(state.scriptEnd, job.textEnd);
    if (overlapEnd <= overlapStart) return null; // Job belongs to a different beat in the same generation!

    const jobSpan = job.textEnd - job.textStart;
    const localRawStart = overlapStart - state.scriptStart;
    const localRawEnd = overlapEnd - state.scriptStart;

    let cleanStart = state.map.findIndex((rawIdx) => rawIdx >= localRawStart);
    if (cleanStart < 0) return null;
    let cleanEnd = state.clean.length;
    for (let i = cleanStart; i < state.map.length; i++) {
      if (state.map[i] >= localRawEnd) { cleanEnd = i; break; }
    }
    if (cleanEnd <= cleanStart) return null;

    // Cross-bubble slice ratios within this job's audio duration.
    const audioStartRatio = Math.max(0, Math.min(1, (overlapStart - job.textStart) / jobSpan));
    const audioEndRatio = Math.max(audioStartRatio, Math.min(1, (overlapEnd - job.textStart) / jobSpan));
    const sliceClean = state.clean.slice(cleanStart, cleanEnd);

    return {
      id: job.id,
      start: cleanStart,
      len: cleanEnd - cleanStart,
      audioStartRatio,
      audioEndRatio,
      weights: buildRhythmWeights(sliceClean),
      segmentId: job.segmentId || null,
      generationId: job.generationId || null,
      status: 'queued',
      boundBy: 'identity-range',
    };
  }

  // Fallback when beat has generationId but no shared scriptStart/scriptEnd, or legacy protocol.
  let start = -1;
  if (state.clean.startsWith(jc, state.matchCursor)) {
    start = state.matchCursor;
  } else if (!state.matched) {
    start = state.clean.indexOf(jc);
  }
  if (start < 0) return null;

  return {
    id: job.id,
    start,
    len: jc.length,
    audioStartRatio: 0,
    audioEndRatio: 1,
    weights: buildRhythmWeights(state.clean.slice(start, start + jc.length)),
    segmentId: job.segmentId || null,
    generationId: job.generationId || null,
    status: 'queued',
    boundBy: state.generationId ? 'identity-text' : 'legacy-text',
  };
}

/**
 * Advances the voice-sync state machine by one UI frame (`dt` seconds).
 *
 * Returns:
 * - `handled`: true while voice sync owns the bubble; false once degraded/text-only fallback takes over.
 * - `shown`: target UTF-16 length in `beat.text` to display (monotonically non-decreasing).
 * - `beatDone`: true when the beat finished normally or was cancelled.
 * - `holdSeconds`: how long to hold after `beatDone` (VOICE_DONE_HOLD_S on normal finish, 0 on cancel).
 * - `cancelled`: true if actively cut by worker epoch/cancellation.
 * - `syncMode` / `reason`: observable state for diagnostics.
 */
export function stepVoiceSync(state, rawClock, now, dt) {
  if (!state || state.off) {
    return { handled: false, shown: state?.lastShown ?? 0, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: state?.syncMode ?? 'fallback', reason: state?.fallbackReason ?? null };
  }

  const clock = normalizeClockSnapshot(rawClock);

  // 1. Handle clock outages explicitly: NEVER treat timeout/unavailable/error as idle or finished!
  if (!clock.ok) {
    if (state.outageSince === null) state.outageSince = now;
    const outageSec = now - state.outageSince;
    if (outageSec < CLOCK_OUTAGE_FREEZE_S) {
      state.syncMode = state.matched ? 'degraded' : 'waiting';
      return { handled: true, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: state.syncMode, reason: `clock-${clock.clockStatus}` };
    }
    state.off = true;
    state.syncMode = 'fallback';
    state.fallbackReason = `clock-${clock.clockStatus}`;
    return { handled: false, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: state.syncMode, reason: state.fallbackReason };
  }

  // Clock is healthy (`clockStatus === 'ok'`).
  state.outageSince = null;

  // 2. Worker epoch tracking: an epoch bump while this beat is actively playing means it was cut.
  if (typeof clock.epoch === 'number') {
    if (state.workerEpoch === null) {
      state.workerEpoch = clock.epoch;
    } else if (clock.epoch !== state.workerEpoch) {
      if (state.active) {
        return { handled: true, shown: state.lastShown, beatDone: true, holdSeconds: 0, cancelled: true, syncMode: 'cancelled', reason: 'worker-epoch-changed' };
      }
      state.workerEpoch = clock.epoch;
    }
  }

  // 3. Inspect current + queue jobs and bind matching ones.
  const jobs = [];
  if (clock.current) jobs.push(clock.current);
  for (const q of clock.queue) jobs.push(q);

  const seen = new Set();
  let rawTargetClean = state.doneCursor;
  let activeRate = Number(clock.cps) || 4.7;
  let crossBubbleSliceCompleted = false;

  for (const job of jobs) {
    if (!job || typeof job.id !== 'string' || typeof job.text !== 'string' || !job.text) continue;
    if (!matchesIdentity(state, job)) continue;
    seen.add(job.id);

    let rec = state.jobs.get(job.id);
    if (!rec) {
      if (state.misaligned) break;
      rec = bindJobToBeat(state, job);
      if (!rec) {
        // With trusted identity ranges, a non-overlapping job simply belongs to another beat.
        if (state.generationId && state.scriptStart !== null) continue;
        if (!state.matched) continue;
        state.misaligned = true;
        break;
      }
      state.jobs.set(job.id, rec);
      state.matchCursor = Math.max(state.matchCursor, rec.start + rec.len);
    }

    const isCurrent = Boolean(clock.current && clock.current.id === job.id);
    if (isCurrent) {
      state.matched = true;
      state.active = true;
      state.syncMode = 'synced';
      state.lastProgressAt = now;
      rec.status = 'playing';
    }

    if (job.done) {
      if (job.cancelled) {
        rec.status = 'cancelled';
        return { handled: true, shown: state.lastShown, beatDone: true, holdSeconds: 0, cancelled: true, syncMode: 'cancelled', reason: 'job-cancelled' };
      }
      if (job.error) {
        rec.status = 'failed';
        state.off = true;
        state.syncMode = 'fallback';
        state.fallbackReason = 'speak-failed';
        return { handled: false, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'fallback', reason: 'speak-failed' };
      }
      rec.status = 'finished';
      const end = rec.start + rec.len;
      rawTargetClean = Math.max(rawTargetClean, end);
      state.doneCursor = Math.max(state.doneCursor, end);
      state.matchCursor = Math.max(state.matchCursor, end);
      continue;
    }

    if (isCurrent) {
      const cps = Number(clock.cps) || 4.7;
      const fullJobCleanLen = Math.max(1, speechClean(job.text).clean.length);
      const hasFinalDur = Boolean(job.generation_done && Number(job.duration) > 0);
      const estTotalDur = hasFinalDur ? Number(job.duration) : fullJobCleanLen / cps;
      activeRate = estTotalDur > 0 ? fullJobCleanLen / estTotalDur : cps;

      const rawElapsed = Number(job.elapsed) || 0;
      const effectiveElapsed = Math.max(0, rawElapsed - AUDIO_LATENCY_S);
      const sliceStartS = estTotalDur * rec.audioStartRatio;
      const sliceEndS = estTotalDur * rec.audioEndRatio;
      const sliceDurS = Math.max(0.08, sliceEndS - sliceStartS);

      // If this job spans into a subsequent beat and audio has already passed our slice end:
      if (rec.audioEndRatio < 0.999 && effectiveElapsed >= sliceEndS) {
        crossBubbleSliceCompleted = true;
        const end = rec.start + rec.len;
        rawTargetClean = Math.max(rawTargetClean, end);
        state.doneCursor = Math.max(state.doneCursor, end);
        break;
      }

      const sliceElapsed = Math.max(0, effectiveElapsed - sliceStartS);
      let frac = Math.min(1, sliceElapsed / sliceDurS);
      // Before final duration is known, cap progress at 0.92 so we never race to the end early.
      if (!hasFinalDur) frac = Math.min(0.92, frac);

      let targetInSlice = weightedCharCount(rec.weights, frac);
      // Low-latency start: once audible playback has begun, show at least 1 char for responsiveness.
      if (rawElapsed > 0.02 && targetInSlice < 1) targetInSlice = 1;
      // Hold the very last character until authoritative completion (unless cross-bubble slice ended).
      targetInSlice = Math.min(Math.max(0, rec.len - 1), targetInSlice);
      rawTargetClean = Math.max(rawTargetClean, rec.start + targetInSlice);
      break;
    }
    break;
  }

  // 4. Authoritative terminal receipts in `recent_finished` (disappearing from current/queue is NOT proof).
  const terminal = new Map(clock.recent_finished.map((r) => [r.id, r]));
  for (const [id, rec] of state.jobs) {
    if (seen.has(id) || rec.status === 'finished') continue;
    const receipt = terminal.get(id);
    if (!receipt) continue;
    if (state.generationId && receipt.generationId && receipt.generationId !== state.generationId) continue;
    if (receipt.cancelled) {
      rec.status = 'cancelled';
      return { handled: true, shown: state.lastShown, beatDone: true, holdSeconds: 0, cancelled: true, syncMode: 'cancelled', reason: 'receipt-cancelled' };
    }
    if (!receipt.ok || receipt.error) {
      rec.status = 'failed';
      state.off = true;
      state.syncMode = 'fallback';
      state.fallbackReason = 'speak-failed';
      return { handled: false, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'fallback', reason: 'speak-failed' };
    }
    rec.status = 'finished';
    state.matched = true;
    state.lastProgressAt = now;
    const end = rec.start + rec.len;
    rawTargetClean = Math.max(rawTargetClean, end);
    state.doneCursor = Math.max(state.doneCursor, end);
    state.matchCursor = Math.max(state.matchCursor, end);
  }

  if (state.misaligned) {
    state.off = true;
    state.syncMode = 'fallback';
    state.fallbackReason = 'misaligned';
    return { handled: false, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'fallback', reason: 'misaligned' };
  }

  // 5. Smooth rate-limited progression (monotonic, no sudden full-sentence jumps after clock recovery).
  const stepDt = Math.max(0, Math.min(0.1, dt || 0.016));
  const clampedTarget = Math.min(state.clean.length, rawTargetClean);
  if (clampedTarget > state.displayCursor) {
    const gap = clampedTarget - state.displayCursor;
    const catchupCps = Math.max(MIN_CATCHUP_CPS, Math.min(MAX_CATCHUP_CPS, activeRate * 1.8 + gap * 1.5));
    state.displayCursor = Math.min(clampedTarget, state.displayCursor + catchupCps * stepDt);
  }

  const revealClean = Math.floor(state.displayCursor);
  let shown = state.lastShown;
  if (revealClean > 0) {
    const pos = Math.min(revealClean, state.clean.length);
    const idx = state.map[pos - 1];
    const mapped = idx === undefined ? state.text.length : idx + 1;
    if (mapped > shown) {
      shown = Math.min(state.text.length, mapped);
      state.lastShown = shown;
      state.lastProgressAt = now;
    }
  }

  // 6. Check authoritative beat completion.
  if (state.clean.length > 0 && state.doneCursor >= state.clean.length) {
    state.displayCursor = state.clean.length;
    state.lastShown = state.text.length;
    return {
      handled: true,
      shown: state.text.length,
      beatDone: true,
      holdSeconds: crossBubbleSliceCompleted ? 0.15 : VOICE_DONE_HOLD_S,
      cancelled: false,
      syncMode: 'synced',
      reason: crossBubbleSliceCompleted ? 'cross-bubble-slice-done' : 'finished',
    };
  }

  // 7. Waiting / stall guards.
  if (state.matched) {
    if (now - state.lastProgressAt > MATCHED_STALL_S) {
      state.off = true;
      state.syncMode = 'fallback';
      state.fallbackReason = 'clock-stalled';
      return { handled: false, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'fallback', reason: 'clock-stalled' };
    }
    return { handled: true, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: state.syncMode, reason: null };
  }

  const workerBusy = clock.playing || clock.queue.length > 0;
  if (workerBusy) state.lastBusyAt = now;
  if (workerBusy && now - state.startedAt < BUSY_QUEUE_WAIT_S) {
    return { handled: true, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'waiting', reason: null };
  }
  if (state.lastBusyAt !== undefined && now - state.lastBusyAt < INTER_JOB_GRACE_S) {
    return { handled: true, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'waiting', reason: null };
  }
  if (now - state.startedAt < IDLE_NO_AUDIO_GRACE_S) {
    return { handled: true, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'waiting', reason: null };
  }

  // Healthy idle worker with no audio queued for this beat -> bounded text-only mode.
  state.off = true;
  state.syncMode = 'text-only';
  state.fallbackReason = 'no-audio';
  return { handled: false, shown: state.lastShown, beatDone: false, holdSeconds: 0, cancelled: false, syncMode: 'text-only', reason: 'no-audio' };
}
