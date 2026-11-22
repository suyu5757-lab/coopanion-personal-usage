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
import {
  chatGPTComposer,
  chatGPTGenerationActive,
  chatGPTImageMediaMatchesTurn,
  chatGPTImageTaskEvidence,
  chatGPTSubmittedUserTurn,
  chatGPTUserTurnBaseline,
  isChatGPTImageSaveTarget,
  isChatGPTPage,
  type ChatGPTUserTurnBaseline,
} from './chatgpt.ts';
import {
  geminiComposer,
  geminiImageMediaMatchesTurn,
  geminiImageTaskEvidence,
  geminiSubmittedUserTurn,
  geminiUserTurnBaseline,
  isGeminiImageSaveTarget,
  isGeminiPage,
  type GeminiUserTurnBaseline,
} from './gemini.ts';
import { replyTargetForBox } from './comments.ts';
import { installFileChooserGuard } from './safety.ts';
import { accessibleRole, composedElements, composedParentElement } from './accessible-name.ts';
import { discoverMediaTargets, type AgentMediaTarget } from './media.ts';
import { actionabilityPoint, currentElementLabel, findLocatorTarget, findPointTarget, findTextTarget, isFileChooserTarget, type ActionabilityFailure, type TargetLocator } from './targets.ts';

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
  dataE2e: string;
  href: string;
  disabled: boolean;
  visible: boolean;
  filePicker: boolean;
  snapshotId: string;
  pressed?: boolean;
}

/** An element's number and the label it was read with, so a renumbered page can be spotted. */
interface AgentElementLite { id: number; label: string; pressed?: boolean }

interface AgentState {
  url: string;
  title: string;
  header: string;
  content: string;
  footer: string;
  video: VideoState | null;
  elements: AgentElementLite[];
  current: ReturnType<typeof videoEvidence>;
  mediaTargets: AgentMediaTarget[];
  account: { ref: string; label: string } | null;
  timestamps: Array<{ text: string; datetime: string; context: string }>;
  fileInputs: Array<{ id: number; label: string; accept: string; multiple: boolean; disabled: boolean; visible: boolean }>;
  replyTargets: Array<{ boxId: number; fingerprint: string; evidenceHash: string; author: string; authorRef: string; context: string; timestamp: string; needsExpand: boolean }>;
  statusMessages: string[];
  snapshotId: string;
}

interface ChatGPTImageTaskRuntime {
  initialUrl: string;
  baseline: ChatGPTUserTurnBaseline;
  pageUrl: string | null;
  turn: HTMLElement | null;
  turnMarker: string;
  turnIndex: number;
}

interface GeminiImageTaskRuntime {
  initialUrl: string;
  baseline: GeminiUserTurnBaseline;
  pageUrl: string | null;
  turn: HTMLElement | null;
  turnMarker: string;
  turnIndex: number;
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
  const chatGPTImageTasks = new Map<string, ChatGPTImageTaskRuntime>();
  const geminiImageTasks = new Map<string, GeminiImageTaskRuntime>();
  const elementId = (element: HTMLElement): number => {
    let id = elementIds.get(element);
    if (id === undefined) { id = nextElementId++; elementIds.set(element, id); }
    return id;
  };
  const documentIds = new WeakMap<Document, number>();
  let nextDocumentId = 1;
  const documentId = (owner: Document): number => {
    let id = documentIds.get(owner);
    if (id === undefined) { id = nextDocumentId++; documentIds.set(owner, id); }
    return id;
  };
  const mediaTargets = (): AgentMediaTarget[] => {
    const fastNodes = document.getElementsByTagName('*').length > 4000
      ? Array.from(document.querySelectorAll<HTMLElement>('img, video, picture, source'))
      : [...composedElements(document)];
    return discoverMediaTargets(document, 40, fastNodes);
  };
  const elementAt = (index: number): HTMLElement | null => {
    const element = internals.selectorMap?.get(index)?.ref;
    return element?.isConnected ? element : null;
  };

  const framePathForDocument = (initial: Document): unknown[] => {
    const path: unknown[] = [];
    const seen = new Set<Document>();
    let owner = initial;
    while (owner !== document && !seen.has(owner) && path.length < 8) {
      seen.add(owner);
      const frame = owner.defaultView?.frameElement;
      if (!frame || frame.nodeType !== 1) return [...path, 'unbound-frame'];
      const host = frame as HTMLElement;
      path.push([elementId(host), documentId(owner), host.getAttribute('src') ?? '', owner.URL]);
      owner = host.ownerDocument;
    }
    return path.reverse();
  };
  const framePath = (element: HTMLElement): unknown[] => framePathForDocument(element.ownerDocument);

  const scrollOffsets = (): unknown[] => {
    const scrollable = new Set<HTMLElement>();
    const documents = new Set<Document>([document]);
    for (const node of internals.selectorMap?.values() ?? []) {
      if (node.ref) documents.add(node.ref.ownerDocument);
      for (let parent = node.ref ? composedParentElement(node.ref) : null; parent; parent = composedParentElement(parent)) {
        if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) scrollable.add(parent);
      }
    }
    const offsets: unknown[] = [
      ...[...documents].map((owner) => [framePathForDocument(owner), owner.defaultView?.scrollX || owner.scrollingElement?.scrollLeft || 0,
        owner.defaultView?.scrollY || owner.scrollingElement?.scrollTop || 0]),
      ...[...scrollable].map((element) => [framePath(element), elementId(element), element.scrollLeft, element.scrollTop]),
    ];
    return offsets.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };

  /** Changes when the live page reuses, reorders or scrolls an indexed target. */
  const snapshotId = (): string => {
    const current = videoEvidence(document);
    const account = accountEvidence(document)?.ref ?? '';
    const scopeCache = new WeakMap<HTMLElement, unknown[]>();
    const scopeEvidenceFor = (element: HTMLElement): unknown[] => {
      const isScope = (candidate: HTMLElement): boolean => candidate.matches('article, [role], li, [data-e2e]');
      const semanticParent = (candidate: HTMLElement): HTMLElement | null => {
        for (let parent = composedParentElement(candidate); parent; parent = composedParentElement(parent)) {
          if (isScope(parent)) return parent;
        }
        return null;
      };
      const nearest = semanticParent(element);
      if (!nearest) return [];
      const cached = scopeCache.get(nearest);
      if (cached) return cached;
      const evidence: unknown[] = [];
      let scope: HTMLElement | null = nearest;
      while (scope && evidence.length < 3) {
        evidence.push([
          elementId(scope), scope.tagName.toLowerCase(),
          currentElementLabel(scope).replace(/\s+/g, ' ').trim().toLowerCase(),
          scope.getAttribute('role') ?? '', scope.getAttribute('data-e2e') ?? '',
          (scope.innerText || scope.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        ]);
        scope = semanticParent(scope);
      }
      scopeCache.set(nearest, evidence);
      return evidence;
    };
    const rows = [...(internals.selectorMap?.entries() ?? [])]
      .map(([index, node]) => {
        const element = node.ref;
        if (!element) return [index, ''];
        const label = currentElementLabel(element) || (shareMarked.has(element) ? '分享' : '');
        return [index, elementId(element), framePath(element), element.isConnected, element.tagName.toLowerCase(),
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
          element.hasAttribute('multiple'), (element as HTMLButtonElement).disabled === true, scopeEvidenceFor(element)];
      })
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const files = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .map((input) => [elementId(input), input.accept, input.multiple, input.disabled])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const media = mediaTargets().map((target) => [target.id, target.mediaType, target.label, target.url]);
    const source = JSON.stringify([location.href, current && [
      current.url, current.title, current.itemId, current.authorRef, current.authorLabel,
      current.contentSnippet, current.containerIdentity, current.playing,
    ], account, scrollOffsets(), rows, files, media]);
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

  const nextFrame = (timeoutMs = 100): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    const finish = (receivedFrame: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(receivedFrame);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => finish(true));
    else queueMicrotask(() => finish(true));
  });

  /** Requires the same page snapshot and hit target across two animation frames. */
  const stableActionPoint = async (element: HTMLElement, expectedSnapshotId: string): Promise<
    | { ok: true; x: number; y: number }
    | { ok: false; reason: ActionabilityFailure | 'stale-snapshot' | 'unstable' }
  > => {
    let previous: string | undefined;
    let domChanged = false;
    const markChanged = (): void => { domChanged = true; };
    const observer = new MutationObserver(markChanged);
    const roots = new Set<Node>([document.documentElement]);
    const observedFrames: HTMLIFrameElement[] = [];
    try {
      for (const element of composedElements(document)) {
        if (element.shadowRoot) roots.add(element.shadowRoot);
        if (element.ownerDocument.documentElement) roots.add(element.ownerDocument.documentElement);
        if (element.localName.toLowerCase() === 'iframe') {
          const frame = element as HTMLIFrameElement;
          frame.addEventListener('load', markChanged);
          observedFrames.push(frame);
        }
      }
      for (const root of roots) observer.observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
      for (let frame = 0; frame < 4; frame++) {
        if (domChanged) return { ok: false, reason: 'dom-changed' };
        if (snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'stale-snapshot' };
        const point = actionabilityPoint(document, element);
        if (!point.ok) return point;
        if (domChanged) return { ok: false, reason: 'dom-changed' };
        if (snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'stale-snapshot' };
        const geometry = `${point.left},${point.top},${point.right},${point.bottom}`;
        if (geometry === previous) return { ok: true, x: point.x, y: point.y };
        previous = geometry;
        if (!await nextFrame()) return { ok: false, reason: 'wait-timeout' };
      }
    } finally {
      observer.disconnect();
      for (const frame of observedFrames) frame.removeEventListener('load', markChanged);
    }
    return { ok: false, reason: 'unstable' };
  };

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

  const OVERLAY_STYLE_ID = 'coo-browser-badge-style';
  let overlayScrollBound = false;
  let overlayRaf = 0;

  /** Computes the element's visible rect clipped by both the viewport and any overflow-clipping ancestors. */
  const visibleClippedRect = (el: HTMLElement): { left: number; top: number; right: number; bottom: number; width: number; height: number } | null => {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const rect = el.getBoundingClientRect();
    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(vw, rect.right);
    let bottom = Math.min(vh, rect.bottom);
    if (right <= left || bottom <= top) return null;
    for (let parent = composedParentElement(el); parent && parent !== document.documentElement; parent = composedParentElement(parent)) {
      const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
      if (!style) continue;
      if (style.position === 'fixed') break;
      const ox = style.overflowX;
      const oy = style.overflowY;
      if (ox === 'hidden' || ox === 'clip' || ox === 'scroll' || ox === 'auto'
        || oy === 'hidden' || oy === 'clip' || oy === 'scroll' || oy === 'auto') {
        const pr = parent.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          left = Math.max(left, pr.left);
          top = Math.max(top, pr.top);
          right = Math.min(right, pr.right);
          bottom = Math.min(bottom, pr.bottom);
          if (right <= left || bottom <= top) return null;
        }
      }
    }
    const width = right - left;
    const height = bottom - top;
    return width >= 4 && height >= 4 ? { left, top, right, bottom, width, height } : null;
  };

  /** Removes misaligned default badges and renders layout-adaptive, clip-aware, non-overlapping badges aligned to each element's real visible box. */
  const alignHighlightOverlay = (): void => {
    const map = internals.selectorMap;
    if (!map || !document.body) return;
    let styleEl = document.getElementById(OVERLAY_STYLE_ID) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = OVERLAY_STYLE_ID;
      styleEl.textContent = [
        `#${HIGHLIGHTS} .coo-badge{position:fixed;z-index:2147483647;pointer-events:none;background:rgba(15,23,42,0.88);color:#fff;border:1px solid rgba(255,255,255,0.75);border-radius:4px;padding:1px 4px;font:600 10px/1.15 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.45);white-space:nowrap;}`,
        `#${HIGHLIGHTS} .coo-box{position:fixed;z-index:2147483646;pointer-events:none;border:1px solid rgba(56,189,248,0.45);border-radius:4px;box-sizing:border-box;}`,
      ].join('');
      (document.head || document.documentElement).appendChild(styleEl);
    }
    let container = document.getElementById(HIGHLIGHTS);
    if (!container) {
      container = document.createElement('div');
      container.id = HIGHLIGHTS;
      container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      document.documentElement.appendChild(container);
    }
    container.replaceChildren();

    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const placed: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    const frag = document.createDocumentFragment();
    const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) =>
      a.left < b.right + 2 && a.right + 2 > b.left && a.top < b.bottom + 2 && a.bottom + 2 > b.top;

    const indexedEls = new Set<HTMLElement>();
    for (const node of map.values()) { if (node?.ref?.isConnected) indexedEls.add(node.ref); }

    for (const [index, node] of map.entries()) {
      const el = node?.ref;
      if (!el || !el.isConnected || !isVisible(el)) continue;
      const rect = visibleClippedRect(el);
      if (!rect) continue;
      // Skip giant full-viewport scroll/page wrappers that should never carry corner badges.
      if (rect.width > vw * 0.85 && rect.height > vh * 0.75) continue;
      // Skip redundant nested non-semantic children inside an already-indexed semantic control (e.g. icon/label divs inside <a>/<button>).
      const tag = el.tagName.toLowerCase();
      const isOwnSemantic = el.matches('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"]');
      if (!isOwnSemantic) {
        let coveredByIndexedParent = false;
        for (let p = composedParentElement(el); p && p !== document.body; p = composedParentElement(p)) {
          if (indexedEls.has(p) && p.matches('a[href], button, [role="button"], [role="link"], [role="tab"]')) {
            coveredByIndexedParent = true;
            break;
          }
        }
        if (coveredByIndexedParent) continue;
      }
      // Skip ghost elements covered by a foreground modal/header.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) continue;

      const labelText = String(index);
      const badgeW = Math.max(16, labelText.length * 6 + 9);
      const badgeH = 15;
      const isInputLike = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
      const isCard = rect.width >= 140 && rect.height >= 90;
      const isCompact = rect.height <= 44 && rect.width <= 110;

      const clampL = (v: number) => Math.max(2, Math.min(v, vw - badgeW - 2));
      const clampT = (v: number) => Math.max(2, Math.min(v, vh - badgeH - 2));

      const candidates = isInputLike
        ? [
          { left: clampL(rect.right - badgeW - 3), top: clampT(rect.top + Math.max(2, (rect.height - badgeH) / 2)) },
          { left: clampL(rect.left + 2), top: clampT(rect.top - badgeH - 2) },
        ]
        : isCard
          ? [
            { left: clampL(rect.left + 4), top: clampT(rect.top + 4) },
            { left: clampL(rect.right - badgeW - 4), top: clampT(rect.top + 4) },
            { left: clampL(rect.left + 4), top: clampT(rect.bottom - badgeH - 4) },
          ]
          : isCompact
            ? [
              { left: clampL(rect.left), top: clampT(rect.top - badgeH + 3) },
              { left: clampL(rect.left), top: clampT(rect.top + 1) },
              { left: clampL(rect.right - badgeW), top: clampT(rect.top - badgeH + 3) },
              { left: clampL(rect.left), top: clampT(rect.bottom - 2) },
            ]
            : [
              { left: clampL(rect.left + 2), top: clampT(rect.top + 2) },
              { left: clampL(rect.right - badgeW - 2), top: clampT(rect.top + 2) },
              { left: clampL(rect.left + 2), top: clampT(rect.bottom - badgeH - 2) },
            ];

      let chosen = candidates[0]!;
      for (const cand of candidates) {
        const box = { left: cand.left, top: cand.top, right: cand.left + badgeW, bottom: cand.top + badgeH };
        if (!placed.some((p) => overlaps(p, box))) {
          chosen = cand;
          break;
        }
      }
      placed.push({ left: chosen.left, top: chosen.top, right: chosen.left + badgeW, bottom: chosen.top + badgeH });

      if (isCard) {
        const outline = document.createElement('div');
        outline.className = 'coo-box';
        outline.style.left = `${Math.round(rect.left)}px`;
        outline.style.top = `${Math.round(rect.top)}px`;
        outline.style.width = `${Math.round(rect.width)}px`;
        outline.style.height = `${Math.round(rect.height)}px`;
        frag.appendChild(outline);
      }

      const badge = document.createElement('div');
      badge.className = 'coo-badge';
      badge.textContent = labelText;
      badge.style.left = `${Math.round(chosen.left)}px`;
      badge.style.top = `${Math.round(chosen.top)}px`;
      frag.appendChild(badge);
    }
    container.appendChild(frag);

    if (!overlayScrollBound) {
      overlayScrollBound = true;
      const schedule = () => {
        if (overlayRaf) return;
        overlayRaf = window.requestAnimationFrame(() => {
          overlayRaf = 0;
          alignHighlightOverlay();
        });
      };
      window.addEventListener('scroll', schedule, { passive: true, capture: true });
      window.addEventListener('resize', schedule, { passive: true });
    }
  };

  /**
   * Whole-page augmentation: PageController skips interactive descendants inside highlighted scroll containers
   * (such as feed cards, links, and buttons inside <main> or overflow-scroll lists). Discover visible,
   * unobscured interactive targets across the entire viewport and add them to selectorMap & page content.
   */
  const augmentViewportTargets = (page: { content?: string; [k: string]: unknown }) => {
    const map = internals.selectorMap;
    if (!map) return page;
    const existingRefs = new Set<HTMLElement>();
    let maxIndex = -1;
    for (const [idx, node] of map.entries()) {
      if (idx > maxIndex) maxIndex = idx;
      if (node?.ref) existingRefs.add(node.ref);
    }
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const extraLines: string[] = [];
    const addedRects: Array<{ left: number; top: number; width: number; height: number; el: HTMLElement }> = [];

    const isSameBox = (r1: DOMRect, r2: { left: number; top: number; width: number; height: number }) =>
      Math.abs(r1.left - r2.left) < 8 && Math.abs(r1.top - r2.top) < 8
      && Math.abs(r1.width - r2.width) < 12 && Math.abs(r1.height - r2.height) < 12;

    const candidateNodes = document.getElementsByTagName('*').length > 4000
      ? Array.from(document.querySelectorAll<HTMLElement>('a[href], button, summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [data-e2e], article, li'))
      : composedElements(document);
    for (const el of candidateNodes) {
      if (map.size >= ELEMENT_LIST_MAX) break;
      if (existingRefs.has(el)) continue;
      if (el.id === HIGHLIGHTS || el.closest?.(`#${HIGHLIGHTS}`)) continue;
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12) continue;
      if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
      if (rect.width > vw * 0.92 && rect.height > vh * 0.85) continue;

      const tag = el.tagName.toLowerCase();
      const semantic = el.matches('a[href], button, summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"]');
      let isInteractiveCard = false;
      if (!semantic) {
        const style = el.ownerDocument.defaultView?.getComputedStyle(el);
        if (style?.cursor === 'pointer' && rect.width >= 48 && rect.height >= 40) {
          // Prefer leaf-ish clickable cards/controls rather than huge page wrappers.
          const hasSemanticChildSameBox = !!el.querySelector('a[href], button') && rect.width * rect.height > vw * vh * 0.35;
          if (!hasSemanticChildSameBox) isInteractiveCard = true;
        }
      }
      if (!semantic && !isInteractiveCard) continue;

      const label = currentElementLabel(el);
      if (!label) continue;

      // Skip if an existing indexed element or previously added element covers the exact same box.
      let dup = false;
      for (const prev of addedRects) {
        if (isSameBox(rect, prev) || (prev.el.contains(el) && isSameBox(rect, prev))) { dup = true; break; }
      }
      if (dup) continue;
      for (const ref of existingRefs) {
        if (!ref.isConnected) continue;
        const r = ref.getBoundingClientRect();
        if (isSameBox(rect, r)) { dup = true; break; }
      }
      if (dup) continue;

      const point = actionabilityPoint(document, el);
      if (!point.ok) continue;

      const nextIndex = ++maxIndex;
      map.set(nextIndex, { ref: el });
      internals.elementTextMap?.set(nextIndex, label);
      existingRefs.add(el);
      addedRects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, el });
      const href = el instanceof HTMLAnchorElement && el.href ? ` href="${el.href.slice(0, 200)}"` : '';
      extraLines.push(`[${nextIndex}]<${tag}${href}>${label.slice(0, 140)}</${tag}>`);
      if (extraLines.length >= 60) break;
    }

    if (extraLines.length && typeof page.content === 'string') {
      return { ...page, content: `${page.content}\n\n[Viewport interactive targets]\n${extraLines.join('\n')}` };
    }
    return page;
  };

  /** Refreshes PageController's numbered-element map before returning or using an index. */
  const readPage = async () => {
    const restore = markShareControl();
    try {
      const raw = await controller.getBrowserState();
      const augmented = augmentViewportTargets(raw as unknown as { content?: string; [k: string]: unknown });
      alignHighlightOverlay();
      return augmented as unknown as typeof raw;
    }
    finally { restore(); }
  };

  /** Ensures selectorMap is populated without renumbering an existing map before an indexed lookup/action. */
  const ensureSelectorMap = async () => {
    if (!internals.selectorMap?.size) await readPage();
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
      dataE2e: attr('data-e2e'),
      href: element instanceof HTMLAnchorElement ? element.href.slice(0, 500) : '',
      disabled: (element as HTMLButtonElement).disabled === true,
      visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
      filePicker: isFileChooserTarget(element),
      snapshotId: snapshotId(),
      ...((element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-pressed') === 'false')
        ? { pressed: element.getAttribute('aria-pressed') === 'true' }
        : {}),
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
      const pressed = element.getAttribute('aria-pressed');
      list.push({ id: index, label, ...((pressed === 'true' || pressed === 'false') ? { pressed: pressed === 'true' } : {}) });
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

  const fileInputTarget = async (id: number, expectedSnapshotId?: string): Promise<{ ok: true; token: string; accept: string; multiple: boolean; snapshotId: string; id: number } | { ok: false; reason: string }> => {
    if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'the page changed' };
    const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((candidate) => candidate.isConnected && !candidate.disabled);
    let input = allInputs.find((candidate) => elementId(candidate) === id) ?? null;
    if (!input && allInputs.length) {
      input = allInputs.find((candidate) => /image/i.test(candidate.accept) && candidate.multiple)
        ?? allInputs.find((candidate) => /image/i.test(candidate.accept))
        ?? allInputs[0]
        ?? null;
    }
    if (!input || !input.isConnected || input.disabled) return { ok: false, reason: 'no enabled file input with that id' };
    const token = `coo-upload-${crypto.randomUUID()}`;
    input.setAttribute('data-coo-upload-token', token);
    return { ok: true, token, accept: input.accept, multiple: input.multiple, snapshotId: snapshotId(), id: elementId(input) };
  };

  const releaseFileInput = (token: string): void => {
    if (!/^coo-upload-[\da-f-]{36}$/.test(token)) return;
    const input = document.querySelector<HTMLInputElement>(`input[type="file"][data-coo-upload-token="${token}"]`);
    input?.removeAttribute('data-coo-upload-token');
  };

  const fileInputSelection = async (id: number): Promise<{ names: string[]; accept: string; multiple: boolean } | null> => {
    const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((candidate) => candidate.isConnected);
    const input = allInputs.find((candidate) => elementId(candidate) === id)
      ?? allInputs.find((candidate) => /image/i.test(candidate.accept))
      ?? allInputs[0]
      ?? null;
    if (!input || !input.isConnected) return null;
    return { names: Array.from(input.files ?? []).map((file) => file.name), accept: input.accept, multiple: input.multiple };
  };

  const uploadObservation = async (id: number) => {
    await readPage();
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((candidate) => elementId(candidate) === id);
    return {
      url: location.href,
      snapshotId: snapshotId(),
      account: accountEvidence(document),
      statusMessages: statusMessages(),
      selection: input?.isConnected
        ? { names: Array.from(input.files ?? []).map((file) => file.name), accept: input.accept, multiple: input.multiple }
        : null,
    };
  };

  const chatGPTComposerTarget = async (): Promise<{ ok: true; id: number; snapshotId: string } | { ok: false; reason: string }> => {
    await readPage();
    if (!isChatGPTPage(location.href)) return { ok: false, reason: 'the current page is not ChatGPT' };
    const element = chatGPTComposer(document, location.href);
    if (!element) return { ok: false, reason: 'no unique visible ChatGPT message box' };
    const id = [...(internals.selectorMap?.entries() ?? [])].find(([, node]) => node.ref === element)?.[0];
    return id === undefined ? { ok: false, reason: 'the ChatGPT message box is not in the current page map' } : { ok: true, id, snapshotId: snapshotId() };
  };

  const chatGPTImageTaskStart = (taskId: string): { ok: boolean; reason?: string } => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId) || chatGPTImageTasks.has(taskId)) {
      return { ok: false, reason: 'invalid or duplicate image task id' };
    }
    const baseline = chatGPTUserTurnBaseline(document, location.href);
    if (!baseline) return { ok: false, reason: 'the current page is not ChatGPT' };
    chatGPTImageTasks.set(taskId, {
      initialUrl: location.href,
      baseline,
      pageUrl: null,
      turn: null,
      turnMarker: '',
      turnIndex: -1,
    });
    while (chatGPTImageTasks.size > 16) chatGPTImageTasks.delete(chatGPTImageTasks.keys().next().value!);
    return { ok: true };
  };

  const chatGPTSubmission = async (taskId: string, prompt: string): Promise<{ submitted: boolean; userTurnMarker?: string; userTurnIndex?: number; state: AgentState }> => {
    const page = await readPage();
    const task = chatGPTImageTasks.get(taskId);
    const composer = chatGPTComposer(document, location.href);
    const draft = composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement
      ? composer.value
      : composer?.innerText ?? '';
    const sameOrigin = !!task && new URL(task.initialUrl).origin === new URL(location.href).origin;
    const submittedTurn = sameOrigin
      ? chatGPTSubmittedUserTurn(document, location.href, prompt, task.baseline)
      : { submitted: false as const };
    const generating = sameOrigin && chatGPTGenerationActive(document, location.href, task.baseline);
    const navigatedToThread = sameOrigin && location.href !== task.initialUrl && /\/c\//.test(location.pathname);
    const allTurns = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'));
    const fallbackTurn = !submittedTurn.submitted && (generating || navigatedToThread) ? (allTurns.at(-1) ?? null) : null;
    const submitted = !!task && isChatGPTPage(location.href) && !draft.trim()
      && (submittedTurn.submitted || generating || (navigatedToThread && !!fallbackTurn));
    let resolvedMarker = '';
    let resolvedIndex = -1;
    if (submitted) {
      task.pageUrl = location.href;
      if (submittedTurn.submitted) {
        task.turn = submittedTurn.turn;
        task.turnMarker = submittedTurn.marker;
        task.turnIndex = submittedTurn.index;
      } else if (fallbackTurn) {
        task.turn = fallbackTurn;
        task.turnMarker = fallbackTurn.getAttribute('data-message-id') || fallbackTurn.id || `chatgpt-user-${Math.max(0, allTurns.length - 1)}`;
        task.turnIndex = Math.max(0, allTurns.length - 1);
      } else {
        task.turnIndex = Math.max(0, allTurns.length - 1);
      }
      resolvedMarker = task.turnMarker;
      resolvedIndex = task.turnIndex;
    }
    return {
      submitted,
      ...(submitted ? { userTurnMarker: resolvedMarker, userTurnIndex: resolvedIndex } : {}),
      state: { ...page, elements: elements(), current: videoEvidence(document), account: accountEvidence(document), timestamps: timestamps(), fileInputs: fileInputs(), replyTargets: await replyTargets(), statusMessages: statusMessages(), snapshotId: snapshotId(), video: video(), mediaTargets: mediaTargets() },
    };
  };

  const chatGPTImageTaskTurn = (task: ChatGPTImageTaskRuntime): HTMLElement | null => {
    let turn = task.turn?.isConnected ? task.turn : null;
    if (!turn && task.turnMarker) {
      const matches = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'))
        .filter((candidate) => (candidate.getAttribute('data-message-id') || candidate.id) === task.turnMarker);
      if (matches.length === 1) turn = matches[0]!;
    }
    return turn;
  };

  const chatGPTImageTaskStatus = (taskId: string): ReturnType<typeof chatGPTImageTaskEvidence> => {
    const task = chatGPTImageTasks.get(taskId);
    if (!task?.pageUrl || location.href !== task.pageUrl) return { status: 'unknown', imageCount: 0, imageSizes: [] };
    const turn = chatGPTImageTaskTurn(task);
    return chatGPTImageTaskEvidence(document, location.href, turn);
  };

  const chatGPTImageTaskMediaTarget = (taskId: string, targetId: number, expectedSnapshotId: string): boolean => {
    const task = chatGPTImageTasks.get(taskId);
    if (!task?.pageUrl || location.href !== task.pageUrl || snapshotId() !== expectedSnapshotId) return false;
    const turn = chatGPTImageTaskTurn(task);
    if (chatGPTImageTaskEvidence(document, location.href, turn).status !== 'image_available') return false;
    const selected = mediaTargets().filter((target) => target.id === targetId && target.mediaType === 'image');
    return selected.length === 1 && chatGPTImageMediaMatchesTurn(document, location.href, turn, selected[0]!.url);
  };

  const chatGPTImageTaskRelease = (taskId: string): void => { chatGPTImageTasks.delete(taskId); };

  const geminiComposerTarget = async (): Promise<{ ok: true; id: number; snapshotId: string } | { ok: false; reason: string }> => {
    await readPage();
    if (!isGeminiPage(location.href)) return { ok: false, reason: 'the current page is not Gemini' };
    const element = geminiComposer(document, location.href);
    if (!element) return { ok: false, reason: 'no visible Gemini prompt box' };
    const id = [...(internals.selectorMap?.entries() ?? [])].find(([, node]) => node.ref === element)?.[0];
    return id === undefined ? { ok: false, reason: 'the Gemini prompt box is not in the current page map' } : { ok: true, id, snapshotId: snapshotId() };
  };

  const geminiImageTaskStart = (taskId: string): { ok: boolean; reason?: string } => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId) || geminiImageTasks.has(taskId)) {
      return { ok: false, reason: 'invalid or duplicate image task id' };
    }
    const baseline = geminiUserTurnBaseline(document, location.href);
    if (!baseline) return { ok: false, reason: 'the current page is not Gemini' };
    geminiImageTasks.set(taskId, {
      initialUrl: location.href,
      baseline,
      pageUrl: null,
      turn: null,
      turnMarker: '',
      turnIndex: -1,
    });
    while (geminiImageTasks.size > 16) geminiImageTasks.delete(geminiImageTasks.keys().next().value!);
    return { ok: true };
  };

  const geminiSubmission = async (taskId: string, prompt: string): Promise<{ submitted: boolean; userTurnMarker?: string; userTurnIndex?: number; state: AgentState }> => {
    const page = await readPage();
    const task = geminiImageTasks.get(taskId);
    const composer = geminiComposer(document, location.href);
    const draft = composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement
      ? composer.value
      : composer?.innerText ?? '';
    const submittedTurn = task && new URL(task.initialUrl).origin === new URL(location.href).origin
      ? geminiSubmittedUserTurn(document, location.href, prompt, task.baseline)
      : { submitted: false as const };
    const submitted = !!task && isGeminiPage(location.href) && !draft.trim() && submittedTurn.submitted;
    if (submitted && submittedTurn.submitted) {
      task.pageUrl = location.href;
      task.turn = submittedTurn.turn;
      task.turnMarker = submittedTurn.marker;
      task.turnIndex = submittedTurn.index;
    }
    return {
      submitted,
      ...(submitted && submittedTurn.submitted ? { userTurnMarker: submittedTurn.marker, userTurnIndex: submittedTurn.index } : {}),
      state: { ...page, elements: elements(), current: videoEvidence(document), account: accountEvidence(document), timestamps: timestamps(), fileInputs: fileInputs(), replyTargets: await replyTargets(), statusMessages: statusMessages(), snapshotId: snapshotId(), video: video(), mediaTargets: mediaTargets() },
    };
  };

  const geminiImageTaskTurn = (task: GeminiImageTaskRuntime): HTMLElement | null => {
    if (task.turn?.isConnected) return task.turn;
    const turns = Array.from(document.querySelectorAll<HTMLElement>('user-query, [data-test-id="user-query"], .user-query-container'));
    if (task.turnIndex >= 0 && task.turnIndex < turns.length) return turns[task.turnIndex] ?? null;
    return null;
  };

  const geminiImageTaskStatus = (taskId: string): ReturnType<typeof geminiImageTaskEvidence> => {
    const task = geminiImageTasks.get(taskId);
    if (!task?.pageUrl || location.href !== task.pageUrl) return { status: 'unknown', imageCount: 0, imageSizes: [] };
    const turn = geminiImageTaskTurn(task);
    return geminiImageTaskEvidence(document, location.href, turn);
  };

  const geminiImageTaskMediaTarget = (taskId: string, targetId: number, expectedSnapshotId: string): boolean => {
    const task = geminiImageTasks.get(taskId);
    if (!task?.pageUrl || location.href !== task.pageUrl || snapshotId() !== expectedSnapshotId) return false;
    const turn = geminiImageTaskTurn(task);
    if (geminiImageTaskEvidence(document, location.href, turn).status !== 'image_available') return false;
    const selected = mediaTargets().filter((target) => target.id === targetId && target.mediaType === 'image');
    return selected.length === 1 && geminiImageMediaMatchesTurn(document, location.href, turn, selected[0]!.url);
  };

  const geminiImageTaskRelease = (taskId: string): void => { geminiImageTasks.delete(taskId); };

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
      role: element.getAttribute('role') ?? '', dataE2e: element.getAttribute('data-e2e') ?? '',
      href: element instanceof HTMLAnchorElement ? element.href.slice(0, 500) : '',
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
      return { ...page, elements: elements(), current, account, timestamps: timestamps(), fileInputs: fileInputs(), replyTargets: await replyTargets(), statusMessages: statusMessages(), snapshotId: snapshotId(), video: video(), mediaTargets: mediaTargets() };
    },
    text: async (): Promise<{ url: string; title: string; text: string; video: VideoState | null }> =>
      ({ url: location.href, title: document.title, text: pageText(), video: video() }),
    click: async (index: number, expectedSnapshotId?: string): Promise<ActionResult> => {
      await ensureSelectorMap();
      const expected = expectedSnapshotId ?? snapshotId();
      if (snapshotId() !== expected) return { success: false, message: 'stale snapshot' };
      const element = elementAt(index);
      if (!element) return { success: false, message: 'no element' };
      if (isFileChooserTarget(element)) return { success: false, message: 'file chooser is blocked' };
      const point = await stableActionPoint(element, expected);
      if (!point.ok) return { success: false, message: `target is not actionable: ${point.reason}` };
      if (snapshotId() !== expected) return { success: false, message: 'stale snapshot' };
      return controller.clickElement(index);
    },
    actionPoint: async (index: number, expectedSnapshotId?: string): Promise<
      | { ok: true; x: number; y: number; snapshotId: string }
      | { ok: false; reason: ActionabilityFailure | 'stale-snapshot' | 'none' | 'unstable' }
    > => {
      await ensureSelectorMap();
      if (!expectedSnapshotId || snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'stale-snapshot' };
      const element = elementAt(index);
      if (!element) return { ok: false, reason: 'none' };
      const point = await stableActionPoint(element, expectedSnapshotId);
      return point.ok
        ? { ok: true, x: point.x, y: point.y, snapshotId: expectedSnapshotId }
        : { ok: false, reason: point.reason };
    },
    setAgentAction: (active: boolean): void => { fileChooserGuard.setAgentAction(active); },
    /** Focus a text box and select its contents so the host's real text insertion replaces them. */
    prepareInput: async (index: number, expectedSnapshotId?: string): Promise<boolean> => {
      await ensureSelectorMap();
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
      await ensureSelectorMap();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return { success: false, message: 'stale snapshot' };
      return controller.scroll(options);
    },
    select: (index: number, text: string): Promise<ActionResult> => controller.selectOption(index, text),
    focus: async (index: number, expectedSnapshotId?: string): Promise<boolean> => {
      await ensureSelectorMap();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return false;
      const element = elementAt(index); element?.focus(); return !!element;
    },
    /** The element's viewport center, after bringing it into view, for the host's real pointer move. */
    center: async (index: number, expectedSnapshotId?: string): Promise<{ x: number; y: number } | null> => {
      await ensureSelectorMap();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return null;
      const element = elementAt(index);
      if (!element) return null;
      const expected = expectedSnapshotId ?? snapshotId();
      const point = await stableActionPoint(element, expected);
      return point.ok ? { x: point.x, y: point.y } : null;
    },
    /** The share control's viewport center; the host hovers it because Douyin and Bilibili open the panel on hover. */
    shareCenter: async (): Promise<
      | { ok: true; x: number; y: number; snapshotId: string }
      | { ok: false; reason: 'none' | 'ambiguous' | ActionabilityFailure | 'stale-snapshot' | 'unstable' }
    > => {
      await readPage();
      const target = shareTarget(document);
      if (!target.ok) return target;
      const element = target.element;
      const before = element.getBoundingClientRect();
      if (before.top < 0 || before.left < 0 || before.bottom > window.innerHeight || before.right > window.innerWidth) {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      const currentSnapshotId = snapshotId();
      const point = await stableActionPoint(element, currentSnapshotId);
      return point.ok ? { ok: true, x: point.x, y: point.y, snapshotId: currentSnapshotId } : { ok: false, reason: point.reason };
    },
    /** Whether a visible share panel or its copy-link option is on the page after the pointer moved there. */
    shareOpen: (): boolean => sharePanelOpen(document),
    viewport: (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight }),
    pointTarget: async (x: number, y: number, expectedSnapshotId?: string): Promise<
      | { ok: true; target: { token: string; label: string; tag: string; role: string; type: string; placeholder: string; href: string; disabled: boolean; filePicker: boolean; snapshotId: string; pressed?: boolean } }
      | { ok: false; reason: ActionabilityFailure | 'invalid' | 'none' | 'file' | 'stale-snapshot' }
    > => {
      await readPage();
      if (expectedSnapshotId && snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'stale-snapshot' };
      const found = findPointTarget(document, x, y);
      if (!found.ok) return found;
      const element = found.element;
      const rect = element.getBoundingClientRect();
      const label = currentElementLabel(element);
      const tokenSource = JSON.stringify([
        elementId(element), element.localName.toLowerCase(), rect.left, rect.top, rect.right, rect.bottom,
        element.getAttribute('data-e2e') ?? '', element.getAttribute('type') ?? '',
        element.getAttribute('placeholder') ?? '', element.getAttribute('href') ?? '', label,
      ]);
      let tokenA = 2166136261, tokenB = 2246822519;
      for (let index = 0; index < tokenSource.length; index++) {
        const code = tokenSource.charCodeAt(index);
        tokenA = Math.imul(tokenA ^ code, 16777619);
        tokenB = Math.imul(tokenB ^ code, 3266489917);
      }
      const target = {
        token: `${(tokenA >>> 0).toString(16).padStart(8, '0')}${(tokenB >>> 0).toString(16).padStart(8, '0')}`,
        label,
        tag: element.localName.toLowerCase(),
        role: accessibleRole(element),
        type: element.getAttribute('type') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        href: element.getAttribute('href') ?? '',
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
        filePicker: isFileChooserTarget(element),
        snapshotId: snapshotId(),
        ...((element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-pressed') === 'false')
          ? { pressed: element.getAttribute('aria-pressed') === 'true' }
          : {}),
      };
      return { ok: true, target };
    },
    /** The viewport center of the smallest visible element with this text, for controls the element map misses. */
    textCenter: async (query: string): Promise<
      | { ok: true; x: number; y: number; snapshotId: string }
      | { ok: false; reason: 'none' | 'ambiguous' | 'file' | ActionabilityFailure | 'stale-snapshot' | 'unstable' }
    > => {
      await readPage();
      const target = findTextTarget(document, query);
      if (!target.ok) return target;
      const element = target.element;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const visited = new Set<Document>();
      let owner = element.ownerDocument;
      while (owner !== document) {
        if (visited.has(owner) || visited.size >= 8) return { ok: false, reason: 'unsupported-frame' };
        visited.add(owner);
        const frame = owner.defaultView?.frameElement as HTMLIFrameElement | null;
        if (!frame || frame.contentDocument !== owner) return { ok: false, reason: 'unsupported-frame' };
        frame.scrollIntoView({ block: 'center', inline: 'nearest' });
        owner = frame.ownerDocument;
      }
      const currentSnapshotId = snapshotId();
      const point = await stableActionPoint(element, currentSnapshotId);
      return point.ok
        ? { ok: true, x: point.x, y: point.y, snapshotId: currentSnapshotId }
        : { ok: false, reason: point.reason };
    },
    snapshot: async (): Promise<string> => { await readPage(); return snapshotId(); },
    mediaTarget: async (id: number, expectedSnapshotId: string): Promise<AgentMediaTarget | null> => {
      await readPage();
      if (!expectedSnapshotId || snapshotId() !== expectedSnapshotId) return null;
      return mediaTargets().find((target) => target.id === id) ?? null;
    },
    element: async (index: number): Promise<AgentElement | null> => { await ensureSelectorMap(); return describe(index); },
    resolveLocator: async (locator: TargetLocator, expectedSnapshotId?: string): Promise<
      | { ok: true; id: number; snapshotId: string }
      | { ok: false; reason: 'invalid' | 'none' | 'ambiguous' | 'stale-snapshot' }
    > => {
      await readPage();
      if (!expectedSnapshotId || snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'stale-snapshot' };
      const found = findLocatorTarget(document, locator);
      if (!found.ok) return found;
      const id = [...(internals.selectorMap?.entries() ?? [])].find(([, node]) => node.ref === found.element)?.[0];
      if (id === undefined || !found.element.isConnected) return { ok: false, reason: 'none' };
      if (snapshotId() !== expectedSnapshotId) return { ok: false, reason: 'stale-snapshot' };
      return { ok: true, id, snapshotId: expectedSnapshotId };
    },
    chatGPTComposer: chatGPTComposerTarget,
    chatGPTImageTaskStart,
    chatGPTSubmission,
    chatGPTImageTaskStatus,
    chatGPTImageTaskMediaTarget,
    chatGPTImageTaskRelease,
    geminiComposer: geminiComposerTarget,
    geminiImageTaskStart,
    geminiSubmission,
    geminiImageTaskStatus,
    geminiImageTaskMediaTarget,
    geminiImageTaskRelease,
    fileInputTarget,
    releaseFileInput,
    fileInputSelection,
    uploadObservation,
    chatGPTImageSaveTarget: async (index: number, expectedSnapshotId?: string): Promise<boolean> => {
      await readPage();
      if (!isChatGPTPage(location.href) || (expectedSnapshotId && snapshotId() !== expectedSnapshotId)) return false;
      const element = elementAt(index);
      return !!element && isChatGPTImageSaveTarget(document, location.href, element);
    },
    geminiImageSaveTarget: async (index: number, expectedSnapshotId?: string): Promise<boolean> => {
      await readPage();
      if (!isGeminiPage(location.href) || (expectedSnapshotId && snapshotId() !== expectedSnapshotId)) return false;
      const element = elementAt(index);
      return !!element && isGeminiImageSaveTarget(document, location.href, element);
    },
    /** The live text of one box, for the confirmation the host shows before a public write. */
    draft: async (index: number, expectedSnapshotId?: string): Promise<string | null> => {
      await ensureSelectorMap();
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
