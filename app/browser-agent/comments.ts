/// <reference lib="dom" />

const ROW = '[data-e2e*="comment-item" i], [data-e2e*="comment-card" i], [data-e2e*="comment-container" i], [role="article"], article, li';
const REPLY_BOX = /(?:reply|respond|回复|回覆)/i;
const EXPAND_REPLIES = /(?:查看|展开|顯示|显示).{0,8}(?:\d+\s*)?(?:条|則|则)?\s*回复|(?:view|show)\s+\d*\s*repl(?:y|ies)/i;
const REPLY_CONTAINERS = '[data-e2e*="reply" i], [class*="reply-list" i], [class*="sub-comment" i], [role="group"]';
const ACTIONS = 'button, [role="button"], input, textarea, select, script, style, time, [aria-hidden="true"], [data-e2e*="like" i], [data-e2e*="reply" i]';

const visible = (element: HTMLElement): boolean =>
  !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 1000);

async function hash(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function postIdentity(postUrl: string): string | null {
  try {
    const url = new URL(postUrl);
    if (url.protocol !== 'https:' || !url.hostname) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function insideThisRow(element: HTMLElement, row: HTMLElement): boolean {
  return element.closest<HTMLElement>(ROW) === row;
}

function textOutsideControls(row: HTMLElement): string {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !insideThisRow(parent, row) || parent.closest(ACTIONS) || parent.closest('a[href*="/user/"]') || parent.closest(REPLY_CONTAINERS)) continue;
    const text = clean(node.textContent ?? '');
    if (text) parts.push(text);
  }
  return clean(parts.join(' '));
}

interface RowEvidence {
  identity: string;
  author: string;
  authorRef: string;
  commentText: string;
  context: string;
  timestamp: string;
  needsExpand: boolean;
}

function rowEvidence(row: HTMLElement, postUrl: string): RowEvidence | null {
  const post = postIdentity(postUrl);
  if (!post) return null;

  const candidates = Array.from(row.querySelectorAll<HTMLElement>(
    'a[href*="/user/"], [data-e2e*="comment-user" i], [data-e2e*="user-name" i]',
  ))
    .filter((element) => visible(element) && insideThisRow(element, row) && !element.closest(REPLY_CONTAINERS))
    .map((element) => clean(element.innerText || element.textContent || ''))
    .filter(Boolean);
  const authors = [...new Set(candidates)];
  if (authors.length !== 1) return null;
  const author = authors[0]!;

  const authorRefs = Array.from(row.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((anchor) => visible(anchor) && insideThisRow(anchor, row) && !anchor.closest(REPLY_CONTAINERS))
    .flatMap((anchor) => {
      try {
        const url = new URL(anchor.getAttribute('href') || anchor.href, post);
        if (url.origin !== new URL(post).origin || !/^\/user\/[^/]+\/?$/.test(url.pathname)) return [];
        return [`${url.origin}${url.pathname.replace(/\/$/, '')}`];
      } catch { return []; }
    });
  const uniqueAuthorRefs = [...new Set(authorRefs)];
  const authorRef = uniqueAuthorRefs.length === 1 ? uniqueAuthorRefs[0]! : '';
  if (/^(?:www\.)?douyin\.com$/i.test(new URL(post).hostname) && !authorRef) return null;

  const semanticText = Array.from(row.querySelectorAll<HTMLElement>(
    '[data-e2e*="comment-content" i], [data-e2e*="comment-text" i], [class*="comment-content" i], [class*="comment-text" i]',
  )).find((element) => visible(element) && insideThisRow(element, row));
  const commentText = clean(semanticText?.innerText || semanticText?.textContent || textOutsideControls(row));
  const imageAlt = Array.from(row.querySelectorAll<HTMLImageElement>('img[alt]'))
    .filter((image) => visible(image) && insideThisRow(image, row) && !image.closest(REPLY_CONTAINERS))
    .map((image) => clean(image.alt))
    .filter(Boolean)
    .join(' ');
  const body = commentText || clean(imageAlt);
  if (!body || body === author) return null;

  const context = `${author}: ${body}`.slice(0, 1200);

  const timestampElement = Array.from(row.querySelectorAll<HTMLTimeElement>('time[datetime]'))
    .find((time) => visible(time) && insideThisRow(time, row));
  const timestamp = timestampElement?.dateTime ?? '';
  const controls = Array.from(row.querySelectorAll<HTMLElement>('button, [role="button"], a'))
    .filter((control) => visible(control) && insideThisRow(control, row));
  const needsExpand = controls.some((control) => EXPAND_REPLIES.test(clean(control.innerText || control.textContent || '')));
  const stableId = row.getAttribute('data-comment-id') || row.getAttribute('data-id');
  const identity = stableId
    ? JSON.stringify(['id', post, stableId, authorRef || author])
    : JSON.stringify(['text', post, authorRef || author, body, timestamp]);
  return { identity, author, authorRef, commentText: body, context, timestamp, needsExpand };
}

/** Binds a visible reply editor only when its comment row has one readable author and unique evidence. */
export async function replyTargetForBox(doc: Document, box: HTMLElement, boxId: number, postUrl: string): Promise<{
  boxId: number; fingerprint: string; evidenceHash: string; author: string; authorRef: string; context: string; timestamp: string; needsExpand: boolean;
} | null> {
  if (!visible(box) || !REPLY_BOX.test([box.getAttribute('aria-label'), box.getAttribute('placeholder'), box.getAttribute('data-placeholder')].filter(Boolean).join(' '))) return null;
  const row = box.closest<HTMLElement>(ROW);
  if (!row || !visible(row)) return null;
  const evidence = rowEvidence(row, postUrl);
  if (!evidence) return null;

  const matches = Array.from(doc.querySelectorAll<HTMLElement>(ROW))
    .filter((candidate) => visible(candidate))
    .map((candidate) => rowEvidence(candidate, postUrl))
    .filter((candidate) => candidate?.identity === evidence.identity).length;
  if (matches !== 1) return null;

  try {
    const [fingerprint, evidenceHash] = await Promise.all([
      hash(evidence.identity),
      hash(JSON.stringify([evidence.author, evidence.authorRef, evidence.context, evidence.timestamp, evidence.needsExpand])),
    ]);
    return { boxId, fingerprint, evidenceHash, author: evidence.author, authorRef: evidence.authorRef, context: evidence.context, timestamp: evidence.timestamp, needsExpand: evidence.needsExpand };
  } catch {
    return null;
  }
}
