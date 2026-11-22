/**
 * Which video and which share control a page means (`entry.ts` calls these with the page's document).
 *
 * A feed keeps several videos and several share buttons in one document, so "the first share button
 * on the page" can belong to a different video than the one playing. These functions anchor on the
 * video element itself and walk up to the smallest container that also holds a share control; two
 * candidates in that container are reported as ambiguous rather than picked.
 *
 * Semantic card boundaries work across sites. Known class and `data-e2e` patterns add candidate
 * boundaries; if the page uses different markup, these functions fail closed instead of widening to
 * a feed-wide ancestor. Page labels are untrusted input and cannot reach the host through this module.
 */

const SHARE_CANDIDATE = '[data-e2e*="share" i], [class*="share" i], [aria-label*="分享"], [title*="分享"], [aria-label*="share" i], [title*="share" i]';
const SHARE_PANEL = '[data-e2e*="share-container" i], [class*="share-popover" i], [class*="share-panel" i], [class*="share-dropdown" i], [role="tooltip"]';

/** Recognizable card boundaries; an arbitrary common ancestor such as `main` is not a card. */
const CARD_MARKER = /(?:^|[-_\s])(?:video|aweme)[-_\s]?(?:card|item)(?:$|[-_\s])/i;

function isCardBoundary(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'article' || tag === 'li' || element.getAttribute('role') === 'article') return true;
  return CARD_MARKER.test(`${element.getAttribute('data-e2e') ?? ''} ${String(element.className ?? '')}`);
}

/** The nearest recognizable card that owns this video. No page-wide fallback is safe. */
function videoCard(video: HTMLVideoElement): HTMLElement | null {
  for (let node = video.parentElement, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
    if (!isCardBoundary(node)) continue;
    const videos = Array.from(node.querySelectorAll<HTMLVideoElement>('video')).filter(visible);
    if (videos.length === 1 && videos[0] === video) return node;
  }
  return null;
}

/** A control's visible box; zero in a document that never laid out. */
const visible = (element: HTMLElement): boolean =>
  !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

const clickable = (element: HTMLElement): boolean =>
  getComputedStyle(element).cursor === 'pointer'
  || ['a', 'button'].includes(element.tagName.toLowerCase())
  || element.hasAttribute('tabindex')
  || typeof element.onclick === 'function';

/** Share controls outside an open panel, outermost only: an icon and its count are one control. */
export function shareCandidates(doc: Document): HTMLElement[] {
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>(SHARE_CANDIDATE)).filter((element) =>
    visible(element) && clickable(element) && !element.closest(SHARE_PANEL));
  return candidates.filter((element) => !candidates.some((other) => other !== element && other.contains(element)));
}

/** The video the page is playing, else the largest one on screen. */
export function pickedVideo(doc: Document): HTMLVideoElement | null {
  const all = Array.from(doc.querySelectorAll('video')).filter(visible);
  const playing = all.filter((video) => !video.paused && video.currentTime > 0);
  const pool = playing.length ? playing : all;
  return pool.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] ?? null;
}

export type VideoChoice = { ok: true; video: HTMLVideoElement } | { ok: false; reason: 'none' | 'ambiguous' };

/**
 * The one video the page means: a single playing one, or a single one at all. Two candidates are
 * ambiguous rather than ranked, because acting on the wrong card is not recoverable on a feed.
 */
export function chosenVideo(doc: Document): VideoChoice {
  const all = Array.from(doc.querySelectorAll('video')).filter(visible);
  if (!all.length) return { ok: false, reason: 'none' };
  const playing = all.filter((video) => !video.paused && video.currentTime > 0);
  const pool = playing.length ? playing : all;
  if (pool.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, video: pool[0]! };
}

export type ShareTarget = { ok: true; element: HTMLElement } | { ok: false; reason: 'none' | 'ambiguous' };

/** The share control of the playing video, or why there is not exactly one. */
export function shareTarget(doc: Document): ShareTarget {
  const candidates = shareCandidates(doc);
  if (!candidates.length) return { ok: false, reason: 'none' };
  const choice = chosenVideo(doc);
  if (!choice.ok) {
    // one candidate on a page with no video at all is still the page's own share control
    return choice.reason === 'none' && candidates.length === 1 ? { ok: true, element: candidates[0]! } : { ok: false, reason: 'ambiguous' };
  }
  const card = videoCard(choice.video);
  if (!card) return { ok: false, reason: 'ambiguous' };
  const inside = candidates.filter((candidate) => card.contains(candidate));
  return inside.length === 1 ? { ok: true, element: inside[0]! } : { ok: false, reason: 'ambiguous' };
}

/** The video's own link and title, when the page carries one near the playing video. */
export interface VideoIdentityEvidence {
  url: string;
  title: string;
  itemId: string;
  authorRef: string;
  authorLabel: string;
  contentSnippet: string;
  containerIdentity: string;
  playing: boolean;
  observedAt: number;
}

export function videoEvidence(doc: Document): VideoIdentityEvidence | null {
  const choice = chosenVideo(doc);
  if (!choice.ok) return null;
  const card = videoCard(choice.video);
  if (!card) return null;
  const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((anchor) => /\/video\/|\/watch\?|\/v\//.test(anchor.getAttribute('href') ?? ''));
  if (links.length !== 1) return null;
  const link = links[0]!;
  const title = (link.getAttribute('aria-label') || link.getAttribute('title') || link.innerText || '')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  let itemId = '';
  try {
    const url = new URL(link.href);
    itemId = url.pathname.match(/\/video\/([^/]+)/)?.[1] ?? url.searchParams.get('item_id') ?? '';
  } catch { /* the anchor's href is still preserved below */ }
  const authors = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter(visible)
    .flatMap((anchor) => {
      try {
        const url = new URL(anchor.href);
        if (url.origin !== doc.location.origin || !/^\/user\/[^/]+\/?$/.test(url.pathname)) return [];
        return [{
          ref: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
          label: (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        }];
      } catch { return []; }
    });
  const uniqueAuthors = [...new Map(authors.map((author) => [author.ref, author])).values()];
  const author = uniqueAuthors.length === 1 ? uniqueAuthors[0]! : null;
  const containerIdentity = [
    card.tagName.toLowerCase(), card.getAttribute('data-e2e') ?? '', card.id, card.getAttribute('role') ?? '',
  ].join(':');
  const contentSnippet = title.slice(0, 240);
  return {
    url: link.href.slice(0, 500),
    title,
    itemId,
    authorRef: author?.ref ?? '',
    authorLabel: author?.label ?? '',
    contentSnippet,
    containerIdentity,
    playing: !choice.video.paused && choice.video.currentTime > 0,
    observedAt: Date.now(),
  };
}

/** A logged-in account link only when the page names it explicitly and the destination is unique. */
export function accountEvidence(doc: Document): { ref: string; label: string } | null {
  const candidates = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((anchor) => visible(anchor) && /^(?:我的主页|个人主页|my profile|profile)$/i.test(
      (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.innerText || '').replace(/\s+/g, ' ').trim(),
    ))
    .flatMap((anchor) => {
      try {
        const url = new URL(anchor.href);
        if (url.origin !== doc.location.origin || !/^\/user\/[^/]+\/?$/.test(url.pathname)) return [];
        return [{ ref: `${url.origin}${url.pathname.replace(/\/$/, '')}`, label: (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.innerText || '').replace(/\s+/g, ' ').trim() }];
      } catch { return []; }
    });
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Whether a share panel with share destinations is open on the page. */
export function sharePanelOpen(doc: Document): boolean {
  return Array.from(doc.querySelectorAll<HTMLElement>(SHARE_PANEL))
    .some((element) => visible(element) && /分享|复制|链接|微信|QQ|微博|动态/.test(element.innerText || ''));
}
