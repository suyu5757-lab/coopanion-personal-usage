/**
 * Injected into Coo's browser window after each page load (scripts/stage.ts bundles it into
 * `build/browser-agent.js`). It exposes DOM reading and element actions on
 * `window.__cooBrowserAgent`; the Electron main process calls them through `webContents.executeJavaScript`.
 *
 * DOM extraction and element actions come from `@page-agent/page-controller` (MIT, Alibaba Group
 * Holding Limited; derived from browser-use, MIT, Gregor Zunic). See README.md.
 */
import { PageController } from '@page-agent/page-controller';
import { accountEvidence, sharePanelOpen, shareTarget, videoEvidence } from './card.ts';
import { chatGPTComposer, isChatGPTImageSaveTarget, isChatGPTPage } from './chatgpt.ts';
import { replyTargetForBox } from './comments.ts';
import { installFileChooserGuard } from './safety.ts';
import { currentElementLabel, findTextTarget, isFileChooserTarget } from './targets.ts';

interface AgentElement {
  id: number;
  tag: string;
  text: string;
  label: string;
  type: string;
  placeholder: string;
  aria: string;
  title: string;
  role: string;
  href: string;
  disabled: boolean;
  visible: boolean;
  filePicker: boolean;
  snapshotId: string;
}

/** An element's number and the label it was read with, so a renumbered page can be spotted. */
interface AgentElementLite { id: number; label: string }

interface AgentState {
  url: string;
  title: string;
  header: string;
  content: string;
  footer: string;
  video: VideoState | null;
  elements: AgentElementLite[];
  current: { url: string; title: string } | null;
  account: { ref: string; label: string } | null;
  timestamps: Array<{ text: string; datetime: string; context: string }>;
  fileInputs: Array<{ id: number; label: string; accept: string; multiple: boolean; disabled: boolean; visible: boolean }>;
  replyTargets: Array<{ boxId: number; fingerprint: string; evidenceHash: string; author: string; context: string; timestamp: string; needsExpand: boolean }>;
  statusMessages: string[];
  snapshotId: string;
}

interface VideoState {
  current: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  width: number;
  height: number;
  src: string;
}

interface ActionResult { success: boolean; message: string }

type ControllerInternals = {
  selectorMap?: Map<number, { ref?: HTMLElement }>;
  elementTextMap?: Map<number, string>;
};

const KEY = '__cooBrowserAgent';
const HIGHLIGHTS = 'playwright-highlight-container';
/** The most element labels one page read reports back; a feed page can hold far more than the model reads. */
const ELEMENT_LIST_MAX = 400;

const host = window as unknown as Record<string, unknown>;

if (!host[KEY]) {
  const controller = new PageController({
    // enough above and below the viewport to include the next row of a feed, without reading the whole page
    viewportExpansion: 160,
    includeAttributes: [
      'aria-label', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-expanded',
      'title', 'placeholder', 'type', 'role', 'alt', 'name', 'data-e2e', 'data-state', 'datetime', 'accept', 'multiple',
    ],
    // the boxes stay invisible; the index badges are left on so a screenshot shows each number
    highlightOpacity: 0,
    highlightLabelOpacity: 0,
  });
  const fileChooserGuard = installFileChooserGuard(document);
  const internals = controller as unknown as ControllerInternals;
  const elementIds = new WeakMap<HTMLElement, number>();
  let nextElementId = 1;
  const shareMarked = new WeakSet<HTMLElement>();
  const elementId = (element: HTMLElement): number => {
    let id = elementIds.get(element);
    if (id === undefined) { id = nextElementId++; elementIds.set(element, id); }
    return id;
  };
  const elementAt = (index: number): HTMLElement | null => {
    const element = internals.selectorMap?.get(index)?.ref;
    return element?.isConnected ? element : null;
  };

  const scrollOffsets = (): Array<[number, number, number]> => {
    const scrollable = new Set<HTMLElement>();
    for (const node of internals.selectorMap?.values() ?? []) {
      for (let parent = node.ref?.parentElement ?? null; parent && parent !== document.body; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) scrollable.add(parent);
      }
    }
    const root = document.scrollingElement;
    const offsets: Array<[number, number, number]> = [
      [0, window.scrollX || root?.scrollLeft || 0, window.scrollY || root?.scrollTop || 0],
      ...[...scrollable].map((element) => [elementId(element), element.scrollLeft, element.scrollTop] as [number, number, number]),
    ];
    return offsets.sort((a, b) => a[0] - b[0]);
  };

  /** Changes when the live page reuses, reorders or scrolls an indexed target. */
  const snapshotId = (): string => {
    const current = videoEvidence(document)?.url ?? '';
    const account = accountEvidence(document)?.ref ?? '';
    const rows = [...(internals.selectorMap?.entries() ?? [])]
      .map(([index, node]) => {
        const element = node.ref;
        if (!element) return [index, ''];
        const label = currentElementLabel(element) || (shareMarked.has(element) ? '分享' : '');
        return [index, elementId(element), element.isConnected, element.tagName.toLowerCase(),
          label.replace(/\s+/g, ' ').trim().toLowerCase(),
          (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          element instanceof HTMLAnchorElement ? element.href : '',
          element.getAttribute('aria-label') ?? '', element.getAttribute('title') ?? '',
          element.getAttribute('aria-pressed') ?? '', element.getAttribute('aria-selected') ?? '',
          element.getAttribute('aria-checked') ?? '', element.getAttribute('aria-expanded') ?? '',
          element.getAttribute('role') ?? '', element.getAttribute('type') ?? '',
          element.getAttribute('placeholder') ?? '', element.getAttribute('name') ?? '',
          element.getAttribute('data-e2e') ?? '', element.getAttribute('data-state') ?? '',
          element.getAttribute('datetime') ?? '', element.getAttribute('accept') ?? '',
          element.hasAttribute('multiple'), (element as HTMLButtonElement).disabled === true];
      })
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const files = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .map((input) => [elementId(input), input.accept, input.multiple, input.disabled])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const source = JSON.stringify([location.href, current, account, scrollOffsets(), rows, files]);
    let a = 2166136261, b = 2246822519;
    for (let index = 0; index < source.length; index++) {
      const code = source.charCodeAt(index);
      a = Math.imul(a ^ code, 16777619);
      b = Math.imul(b ^ code, 3266489917);
    }
    return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
  };

  const isVisible = (element: HTMLElement): boolean =>
    !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

  /**
   * Share controls are often icon-only and carry neither a title nor a click handler of their own, so the
   * controller leaves them out when they sit inside a highlighted scroll container. They are marked for one
   * extraction pass so each one gets an index and the name 分享; the page is restored afterwards.
   */
  /** The share control of the video being played, not the first one in document order. */
  const shareControl = (): HTMLElement | null => {
    const target = shareTarget(document);
    return target.ok ? target.element : null;
  };

  const markShareControl = (): () => void => {
    const element = shareControl();
    if (!element) return () => {};
    shareMarked.add(element);
    const restores: Array<() => void> = [];
    const indexed = [...(internals.selectorMap?.values() ?? [])].some((node) => node.ref === element);
    if (!indexed && typeof element.onclick !== 'function') {
      const previous = element.onclick;
      element.onclick = () => {};
      restores.push(() => { element.onclick = previous; });
    }
    if (!/分享|share/i.test(element.getAttribute('aria-label') ?? '')) {
      const previous = element.getAttribute('aria-label');
      element.setAttribute('aria-label', '分享');
      restores.push(() => {
        if (previous === null) element.removeAttribute('aria-label');
        else element.setAttribute('aria-label', previous);
      });
    }
    return () => { for (const restore of restores.reverse()) restore(); };
  };

  /** Refreshes PageController's numbered-element map before returning or using an index. */
  const readPage = async () => {
    const restore = markShareControl();
    try { return await controller.getBrowserState(); }
    finally { restore(); }
  };

  const describe = (index: number): AgentElement | null => {
    const element = elementAt(index);
    if (!element) return null;
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const attr = (name: string) => element.getAttribute(name) ?? '';
    return {
      id: index,
      tag: element.tagName.toLowerCase(),
      text,
      label: currentElementLabel(element) || (shareMarked.has(element) ? '分享' : '') || text,
      type: attr('type'),
      placeholder: attr('placeholder'),
      aria: attr('aria-label') || (shareMarked.has(element) ? '分享' : ''),
      title: attr('title'),
      role: attr('role'),
      href: element instanceof HTMLAnchorElement ? element.href.slice(0, 500) : '',
      disabled: (element as HTMLButtonElement).disabled === true,
      visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
      filePicker: isFileChooserTarget(element),
      snapshotId: snapshotId(),
    };
  };

  /** Every numbered element's label, for the World to spot a page renumbered under it. */
  const elements = (): AgentElementLite[] => {
    const list: AgentElementLite[] = [];
    for (const index of internals.selectorMap?.keys() ?? []) {
      if (list.length >= ELEMENT_LIST_MAX) break;
      const element = elementAt(index);
      if (!element || !isVisible(element)) continue;
      const label = currentElementLabel(element)
        || (shareMarked.has(element) ? '分享' : '')
        || (internals.elementTextMap?.get(index) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      list.push({ id: index, label });
    }
    return list;
  };

  const timestamps = (): AgentState['timestamps'] => Array.from(document.querySelectorAll<HTMLTimeElement>('time[datetime]'))
    .filter((element) => isVisible(element) && !!element.dateTime)
    .slice(0, 30)
    .map((element) => {
      const row = element.closest<HTMLElement>('[data-e2e*="comment" i], [role="article"], article, li') ?? element.parentElement;
      return {
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        datetime: element.dateTime,
        context: (row?.innerText || row?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      };
    });

  const fileInputs = (): AgentState['fileInputs'] => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    .slice(0, 20)
    .map((input) => ({
      id: elementId(input),
      label: Array.from(input.labels ?? []).map((label) => (label.innerText || label.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
        || currentElementLabel(input) || 'file input',
      accept: input.accept,
      multiple: input.multiple,
      disabled: input.disabled,
      visible: isVisible(input),
    }));

  const replyTargets = async (): Promise<AgentState['replyTargets']> => {
    const postUrl = videoEvidence(document)?.url ?? '';
    const targets: AgentState['replyTargets'] = [];
    for (const [boxId, node] of internals.selectorMap?.entries() ?? []) {
      if (!node.ref || targets.length >= 30) continue;
      const target = await replyTargetForBox(document, node.ref, boxId, postUrl);
      if (target) targets.push(target);
    }
    return targets;
  };

  const statusMessages = (): string[] => [...new Set(Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]'))
    .filter(isVisible)
    .map((element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))].slice(0, 20);

  const fileInputTarget = async (id: number, expectedSnapshotId?: string): Promise<{ ok: true; token: string; accept: string; multiple: boolean; snapshotId: string } | { ok: false; reason: string }> => {
    await readPage();
    if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'the page changed' };
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((candidate) => elementId(candidate) === id);
    if (!input || !input.isConnected || input.disabled) return { ok: false, reason: 'no enabled file input with that id' };
    const token = `coo-upload-${crypto.randomUUID()}`;
    input.setAttribute('data-coo-upload-token', token);
    return { ok: true, token, accept: input.accept, multiple: input.multiple, snapshotId: snapshotId() };
  };

  const releaseFileInput = (token: string): void => {
    if (!/^coo-upload-[\da-f-]{36}$/.test(token)) return;
    const input = document.querySelector<HTMLInputElement>(`input[type="file"][data-coo-upload-token="${token}"]`);
    input?.removeAttribute('data-coo-upload-token');
  };

  const fileInputSelection = async (id: number): Promise<{ names: string[]; accept: string; multiple: boolean } | null> => {
    await readPage();
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((candidate) => elementId(candidate) === id);
    if (!input || !input.isConnected) return null;
    return { names: Array.from(input.files ?? []).map((file) => file.name), accept: input.accept, multiple: input.multiple };
  };

  const chatGPTComposerTarget = async (): Promise<{ ok: true; id: number; snapshotId: string } | { ok: false; reason: string }> => {
    await readPage();
    if (!isChatGPTPage(location.href)) return { ok: false, reason: 'the current page is not ChatGPT' };
    const element = chatGPTComposer(document, location.href);
    if (!element) return { ok: false, reason: 'no unique visible ChatGPT message box' };
    const id = [...(internals.selectorMap?.entries() ?? [])].find(([, node]) => node.ref === element)?.[0];
    return id === undefined ? { ok: false, reason: 'the ChatGPT message box is not in the current page map' } : { ok: true, id, snapshotId: snapshotId() };
  };

  const chatGPTSubmission = async (prompt: string): Promise<{ submitted: boolean; state: AgentState }> => {
    const page = await readPage();
    const composer = chatGPTComposer(document, location.href);
    const draft = composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement
      ? composer.value
      : composer?.innerText ?? '';
    const turns = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'));
    const lastTurn = turns.at(-1)?.innerText ?? turns.at(-1)?.textContent ?? '';
    const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
    const visiblePrompt = norm(lastTurn) === norm(prompt) || (!turns.length && (document.body?.innerText ?? '').includes(prompt));
    return { submitted: isChatGPTPage(location.href) && !draft.trim() && visiblePrompt, state: { ...page, elements: elements(), current: videoEvidence(document), account: accountEvidence(document), timestamps: timestamps(), fileInputs: fileInputs(), replyTargets: await replyTargets(), statusMessages: statusMessages(), snapshotId: snapshotId(), video: video() } };
  };

  const active = (): AgentElement | null => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const index = [...(internals.selectorMap?.entries() ?? [])].find(([, node]) => node.ref === element)?.[0];
    if (index !== undefined) return describe(index);
    return {
      id: -1, tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      label: '', type: element.getAttribute('type') ?? '', placeholder: element.getAttribute('placeholder') ?? '',
      aria: element.getAttribute('aria-label') ?? '', title: element.getAttribute('title') ?? '',
      role: element.getAttribute('role') ?? '', href: element instanceof HTMLAnchorElement ? element.href.slice(0, 500) : '',
      disabled: (element as HTMLButtonElement).disabled === true, visible: true,
      filePicker: isFileChooserTarget(element),
      snapshotId: snapshotId(),
    };
  };

  const video = (): VideoState | null => {
    const candidates = Array.from(document.querySelectorAll('video')).filter((v) => v.currentSrc || v.src);
    const picked = candidates.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    if (!picked) return null;
    return {
      current: Number.isFinite(picked.currentTime) ? picked.currentTime : 0,
      duration: Number.isFinite(picked.duration) ? picked.duration : 0,
      paused: picked.paused,
      muted: picked.muted || picked.volume === 0,
      volume: picked.volume,
      width: picked.videoWidth || picked.clientWidth,
      height: picked.videoHeight || picked.clientHeight,
      src: (picked.currentSrc || picked.src || '').slice(0, 300),
    };
  };

  const pageText = (): string => {
    const container = document.getElementById(HIGHLIGHTS);
    const shown = container?.style.display;
    if (container) container.style.display = 'none';
    const text = document.body?.innerText ?? '';
    if (container) container.style.display = shown ?? '';
    return text.slice(0, 20_000);
  };

  // The host mutes the whole tab; muting the video element too lets play() start without a gesture.
  let hostMuted = true;
  const mutedByHost = new WeakSet<HTMLVideoElement>();
  /** The video unmuted for a tab recording; its previous state is put back when the recording stops. */
  let captureVideo: HTMLVideoElement | null = null;
  let captureWasMuted = false;
  const applyMute = (): void => {
    for (const video of Array.from(document.querySelectorAll('video'))) {
      if (captureVideo === video) continue;
      if (hostMuted && !video.muted) { video.muted = true; mutedByHost.add(video); }
      else if (!hostMuted && mutedByHost.has(video)) { video.muted = false; mutedByHost.delete(video); }
    }
  };
  new MutationObserver(applyMute).observe(document.documentElement, { childList: true, subtree: true });
  const unmuteForCapture = (): void => {
    const picked = Array.from(document.querySelectorAll('video')).sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    if (!picked) return;
    captureVideo = picked;
    captureWasMuted = picked.muted;
    picked.muted = false;
  };
  const restoreCaptureMute = (): void => {
    if (captureVideo) captureVideo.muted = captureWasMuted;
    captureVideo = null;
    applyMute();
  };

  const PCM_RATE = 16_000;
  interface AudioCapture {
    stream: MediaStream;
    recorder: MediaRecorder;
    chunks: Blob[];
    stopped: Promise<void>;
  }
  let audioCapture: AudioCapture | null = null;

  const base64 = (bytes: Uint8Array): string => {
    let text = '';
    const chunk = 0x8000;
    for (let at = 0; at < bytes.length; at += chunk) {
      text += String.fromCharCode(...bytes.subarray(at, at + chunk));
    }
    return btoa(text);
  };

  const wav = (samples: Float32Array): string => {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (at: number, text: string): void => {
      for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
    };
    ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, PCM_RATE, true); view.setUint32(28, PCM_RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]!));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return base64(bytes);
  };

  /** The recording as 16 kHz mono samples, the rate the speech models take. */
  const pcm = async (blob: Blob): Promise<Float32Array> => {
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const length = Math.max(1, Math.ceil(decoded.duration * PCM_RATE));
      const offline = new OfflineAudioContext(1, length, PCM_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      return (await offline.startRendering()).getChannelData(0);
    } finally {
      await context.close();
    }
  };

  const startAudio = async (): Promise<{ ok: boolean; error?: string }> => {
    if (audioCapture) return { ok: false, error: 'already recording' };
    if (!navigator.mediaDevices?.getDisplayMedia) return { ok: false, error: 'display capture is not available on this page' };
    unmuteForCapture();
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
      const audio = new MediaStream(stream.getAudioTracks());
      for (const track of stream.getVideoTracks()) track.stop();
      if (!audio.getAudioTracks().length) {
        for (const track of stream.getTracks()) track.stop();
        restoreCaptureMute();
        return { ok: false, error: 'the page gave no audio track' };
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(audio, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.start(1000);
      audioCapture = { stream, recorder, chunks, stopped };
      return { ok: true };
    } catch (error) {
      if (stream) for (const track of stream.getTracks()) track.stop();
      restoreCaptureMute();
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  };

  const stopAudio = async (): Promise<{ ok: boolean; wav?: string; seconds?: number; error?: string }> => {
    const capture = audioCapture;
    audioCapture = null;
    if (!capture) return { ok: false, error: 'not recording' };
    try {
      if (capture.recorder.state !== 'inactive') capture.recorder.stop();
      await capture.stopped;
      for (const track of capture.stream.getTracks()) track.stop();
      const blob = new Blob(capture.chunks, { type: capture.recorder.mimeType || 'audio/webm' });
      const samples = await pcm(blob);
      return { ok: true, wav: wav(samples), seconds: samples.length / PCM_RATE };
    } catch (error) {
      for (const track of capture.stream.getTracks()) track.stop();
      return { ok: false, error: String((error as Error)?.message ?? error) };
    } finally {
      restoreCaptureMute();
    }
  };

  const play = async (pause: boolean): Promise<{ ok: boolean; error?: string; video: VideoState | null }> => {
    const picked = Array.from(document.querySelectorAll('video')).sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    if (!picked) return { ok: false, error: 'no video on this page', video: null };
    try {
      if (pause) picked.pause();
      else { applyMute(); await picked.play(); }
      return { ok: true, video: video() };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error), video: video() };
    }
  };

  host[KEY] = {
    version: 1,
    state: async (): Promise<AgentState> => {
      applyMute();
      const page = await readPage();
      const current = videoEvidence(document), account = accountEvidence(document);
      return { ...page, elements: elements(), current, account, timestamps: timestamps(), fileInputs: fileInputs(), replyTargets: await replyTargets(), statusMessages: statusMessages(), snapshotId: snapshotId(), video: video() };
    },
    text: async (): Promise<{ url: string; title: string; text: string; video: VideoState | null }> =>
      ({ url: location.href, title: document.title, text: pageText(), video: video() }),
    click: async (index: number, expectedSnapshotId?: string): Promise<ActionResult> => {
      await readPage();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return { success: false, message: 'stale snapshot' };
      const element = elementAt(index);
      if (!element) return { success: false, message: 'no element' };
      if (isFileChooserTarget(element)) return { success: false, message: 'file chooser is blocked' };
      return controller.clickElement(index);
    },
    setAgentAction: (active: boolean): void => { fileChooserGuard.setAgentAction(active); },
    /** Focus a text box and select its contents so the host's real text insertion replaces them. */
    prepareInput: async (index: number, expectedSnapshotId?: string): Promise<boolean> => {
      await readPage();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return false;
      const element = elementAt(index);
      if (!element) return false;
      element.focus({ preventScroll: true });
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.select();
        return true;
      }
      if (!element.isContentEditable) return false;
      const selection = (element.ownerDocument.defaultView ?? window).getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    },
    scroll: async (options: { down: boolean; numPages: number; index?: number }, expectedSnapshotId?: string): Promise<ActionResult> => {
      await readPage();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return { success: false, message: 'stale snapshot' };
      return controller.scroll(options);
    },
    select: (index: number, text: string): Promise<ActionResult> => controller.selectOption(index, text),
    focus: async (index: number, expectedSnapshotId?: string): Promise<boolean> => {
      await readPage();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return false;
      const element = elementAt(index); element?.focus(); return !!element;
    },
    /** The element's viewport center, after bringing it into view, for the host's real pointer move. */
    center: async (index: number, expectedSnapshotId?: string): Promise<{ x: number; y: number } | null> => {
      await readPage();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return null;
      const element = elementAt(index);
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    /** The share control's viewport center; the host hovers it because Douyin and Bilibili open the panel on hover. */
    shareCenter: async (): Promise<{ ok: true; x: number; y: number; snapshotId: string } | { ok: false; reason: 'none' | 'ambiguous' }> => {
      await readPage();
      const target = shareTarget(document);
      if (!target.ok) return target;
      const element = target.element;
      const before = element.getBoundingClientRect();
      if (before.top < 0 || before.left < 0 || before.bottom > window.innerHeight || before.right > window.innerWidth) {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      const rect = element.getBoundingClientRect();
      return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, snapshotId: snapshotId() };
    },
    /** Whether a visible share panel or its copy-link option is on the page after the pointer moved there. */
    shareOpen: (): boolean => sharePanelOpen(document),
    /** The viewport center of the smallest visible element with this text, for controls the element map misses. */
    textCenter: async (query: string): Promise<{ ok: true; x: number; y: number; snapshotId: string } | { ok: false; reason: 'none' | 'ambiguous' | 'file' }> => {
      await readPage();
      const target = findTextTarget(document, query);
      if (!target.ok) return target;
      const element = target.element;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === element || element.contains(top) || top.contains(element))) return { ok: false, reason: 'none' };
      return { ok: true, x, y, snapshotId: snapshotId() };
    },
    snapshot: async (): Promise<string> => { await readPage(); return snapshotId(); },
    element: async (index: number): Promise<AgentElement | null> => { await readPage(); return describe(index); },
    chatGPTComposer: chatGPTComposerTarget,
    chatGPTSubmission,
    fileInputTarget,
    releaseFileInput,
    fileInputSelection,
    chatGPTImageSaveTarget: async (index: number, expectedSnapshotId?: string): Promise<boolean> => {
      await readPage();
      if (!isChatGPTPage(location.href) || (expectedSnapshotId && snapshotId() !== expectedSnapshotId)) return false;
      const element = elementAt(index);
      return !!element && isChatGPTImageSaveTarget(document, location.href, element);
    },
    /** The live text of one box, for the confirmation the host shows before a public write. */
    draft: async (index: number, expectedSnapshotId?: string): Promise<string | null> => {
      await readPage();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return null;
      const element = elementAt(index);
      if (!element) return null;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value.slice(0, 2000);
      return (element.innerText || element.textContent || '').slice(0, 2000);
    },
    active: async (): Promise<AgentElement | null> => { await readPage(); return active(); },
    video,
    play,
    startAudio,
    stopAudio,
    setMuted: (on: boolean): void => { hostMuted = on; applyMute(); },
  };
}
