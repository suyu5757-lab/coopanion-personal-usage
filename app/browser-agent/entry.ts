/**
 * Injected into Coo's browser window after each page load (scripts/stage.ts bundles it into
 * `build/browser-agent.js`). It exposes DOM reading and element actions on
 * `window.__cooBrowserAgent`; the Electron main process calls them through `webContents.executeJavaScript`.
 *
 * DOM extraction and element actions come from `@page-agent/page-controller` (MIT, Alibaba Group
 * Holding Limited; derived from browser-use, MIT, Gregor Zunic). See README.md.
 */
import { PageController } from '@page-agent/page-controller';

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
}

interface AgentState {
  url: string;
  title: string;
  header: string;
  content: string;
  footer: string;
  video: VideoState | null;
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

const host = window as unknown as Record<string, unknown>;

if (!host[KEY]) {
  const controller = new PageController({
    // enough above and below the viewport to include the next row of a feed, without reading the whole page
    viewportExpansion: 160,
    includeAttributes: ['aria-label', 'title', 'placeholder', 'type', 'role', 'alt', 'name'],
    // the boxes stay invisible; the index badges are left on so a screenshot shows each number
    highlightOpacity: 0,
    highlightLabelOpacity: 0,
  });
  const internals = controller as unknown as ControllerInternals;

  const elementAt = (index: number): HTMLElement | null => internals.selectorMap?.get(index)?.ref ?? null;

  const isVisible = (element: HTMLElement): boolean =>
    !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

  /**
   * Share controls are often icon-only and carry neither a title nor a click handler of their own, so the
   * controller leaves them out when they sit inside a highlighted scroll container. They are marked for one
   * extraction pass so each one gets an index and the name 分享; the page is restored afterwards.
   */
  const SHARE_CANDIDATE = '[data-e2e*="share" i], [class*="share" i], [aria-label*="分享"], [title*="分享"], [aria-label*="share" i], [title*="share" i]';
  const SHARE_PANEL = '[data-e2e*="share-container" i], [class*="share-popover" i], [class*="share-panel" i], [class*="share-dropdown" i], [role="tooltip"]';
  const shareMarked = new WeakSet<HTMLElement>();

  const shareControl = (): HTMLElement | null => {
    const clickable = (element: HTMLElement): boolean =>
      getComputedStyle(element).cursor === 'pointer'
      || ['a', 'button'].includes(element.tagName.toLowerCase())
      || element.hasAttribute('tabindex')
      || typeof element.onclick === 'function';
    const candidates = [...document.querySelectorAll<HTMLElement>(SHARE_CANDIDATE)].filter((element) =>
      isVisible(element) && clickable(element) && !element.closest(SHARE_PANEL));
    // A share button holds its icon and count; its children are not separate controls.
    const outermost = candidates.filter((element) => !candidates.some((other) => other !== element && other.contains(element)));
    return outermost[0] ?? null;
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

  const describe = (index: number): AgentElement | null => {
    const element = elementAt(index);
    if (!element) return null;
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const attr = (name: string) => element.getAttribute(name) ?? '';
    return {
      id: index,
      tag: element.tagName.toLowerCase(),
      text,
      label: (internals.elementTextMap?.get(index) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || text,
      type: attr('type'),
      placeholder: attr('placeholder'),
      aria: attr('aria-label') || (shareMarked.has(element) ? '分享' : ''),
      title: attr('title'),
      role: attr('role'),
      href: element instanceof HTMLAnchorElement ? element.href.slice(0, 500) : '',
      disabled: (element as HTMLButtonElement).disabled === true,
      visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
    };
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
    };
  };

  const video = (): VideoState | null => {
    const candidates = [...document.querySelectorAll('video')].filter((v) => v.currentSrc || v.src);
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
    for (const video of document.querySelectorAll('video')) {
      if (captureVideo === video) continue;
      if (hostMuted && !video.muted) { video.muted = true; mutedByHost.add(video); }
      else if (!hostMuted && mutedByHost.has(video)) { video.muted = false; mutedByHost.delete(video); }
    }
  };
  new MutationObserver(applyMute).observe(document.documentElement, { childList: true, subtree: true });
  const unmuteForCapture = (): void => {
    const picked = [...document.querySelectorAll('video')].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
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
    const picked = [...document.querySelectorAll('video')].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
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
      const restore = markShareControl();
      try {
        return { ...(await controller.getBrowserState()), video: video() };
      } finally {
        restore();
      }
    },
    text: async (): Promise<{ url: string; title: string; text: string; video: VideoState | null }> =>
      ({ url: location.href, title: document.title, text: pageText(), video: video() }),
    click: (index: number): Promise<ActionResult> => controller.clickElement(index),
    /** Focus a text box and select its contents so the host's real text insertion replaces them. */
    prepareInput: (index: number): boolean => {
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
    scroll: (options: { down: boolean; numPages: number; index?: number }): Promise<ActionResult> => controller.scroll(options),
    select: (index: number, text: string): Promise<ActionResult> => controller.selectOption(index, text),
    focus: (index: number): boolean => { const element = elementAt(index); element?.focus(); return !!element; },
    /** The element's viewport center, after bringing it into view, for the host's real pointer move. */
    center: (index: number): { x: number; y: number } | null => {
      const element = elementAt(index);
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    /** The share control's viewport center; the host hovers it because Douyin and Bilibili open the panel on hover. */
    shareCenter: (): { x: number; y: number } | null => {
      const element = shareControl();
      if (!element) return null;
      const before = element.getBoundingClientRect();
      if (before.top < 0 || before.left < 0 || before.bottom > window.innerHeight || before.right > window.innerWidth) {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    /** Whether a visible share panel or its copy-link option is on the page after the pointer moved there. */
    shareOpen: (): boolean => {
      const visible = (element: HTMLElement): boolean => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      const panel = [...document.querySelectorAll<HTMLElement>(SHARE_PANEL)]
        .find((element) => visible(element) && /分享|复制|链接|微信|QQ|微博|动态/.test(element.innerText || ''));
      return !!panel;
    },
    /** The viewport center of the smallest visible element with this text, for controls the element map misses. */
    textCenter: (query: string): { x: number; y: number } | null => {
      const wanted = query.replace(/\s+/g, ' ').trim();
      if (!wanted) return null;
      const lower = wanted.toLowerCase();
      const visible = (element: HTMLElement): boolean => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      const found = new Set<HTMLElement>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value || !(value === wanted || value.toLowerCase().includes(lower))) continue;
        let element = node.parentElement;
        for (let depth = 0; element && depth < 4; depth++, element = element.parentElement) {
          if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') break;
          found.add(element);
        }
      }
      const candidates = [...found].filter(visible);
      const exact = candidates.filter((element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() === wanted);
      // The exact match is often the label inside a button; its larger ancestor is the clickable control.
      const element = exact.length
        ? exact.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]
        : candidates.sort((a, b) => (a.clientWidth * a.clientHeight) - (b.clientWidth * b.clientHeight))[0];
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === element || element.contains(top) || top.contains(element))) return null;
      return { x, y };
    },
    element: (index: number): AgentElement | null => describe(index),
    active,
    video,
    play,
    startAudio,
    stopAudio,
    setMuted: (on: boolean): void => { hostMuted = on; applyMute(); },
  };
}
