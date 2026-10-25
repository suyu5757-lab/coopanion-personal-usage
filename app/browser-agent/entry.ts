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
    // the indices are still assigned; nothing is drawn over the page
    highlightOpacity: 0,
    highlightLabelOpacity: 0,
  });
  const internals = controller as unknown as ControllerInternals;

  const elementAt = (index: number): HTMLElement | null => internals.selectorMap?.get(index)?.ref ?? null;

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
      aria: attr('aria-label'),
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
  const applyMute = (): void => {
    for (const video of document.querySelectorAll('video')) {
      if (hostMuted && !video.muted) { video.muted = true; mutedByHost.add(video); }
      else if (!hostMuted && mutedByHost.has(video)) { video.muted = false; mutedByHost.delete(video); }
    }
  };
  new MutationObserver(applyMute).observe(document.documentElement, { childList: true, subtree: true });

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
    state: async (): Promise<AgentState> => { applyMute(); return { ...(await controller.getBrowserState()), video: video() }; },
    text: async (): Promise<{ url: string; title: string; text: string; video: VideoState | null }> =>
      ({ url: location.href, title: document.title, text: pageText(), video: video() }),
    click: (index: number): Promise<ActionResult> => controller.clickElement(index),
    input: (index: number, text: string): Promise<ActionResult> => controller.inputText(index, text),
    scroll: (options: { down: boolean; numPages: number; index?: number }): Promise<ActionResult> => controller.scroll(options),
    select: (index: number, text: string): Promise<ActionResult> => controller.selectOption(index, text),
    focus: (index: number): boolean => { const element = elementAt(index); element?.focus(); return !!element; },
    element: (index: number): AgentElement | null => describe(index),
    active,
    video,
    play,
    setMuted: (on: boolean): void => { hostMuted = on; applyMute(); },
  };
}
