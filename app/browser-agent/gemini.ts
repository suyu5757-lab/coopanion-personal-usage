/// <reference lib="dom" />

import { currentElementLabel } from './targets.ts';

const visible = (element: HTMLElement): boolean =>
  !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

export interface GeminiUserTurnBaseline {
  count: number;
  last: HTMLElement | null;
}

export type GeminiImageTaskStatus = 'prompt_submitted' | 'generating' | 'image_available' | 'unknown' | 'failed';

export interface GeminiImageTaskEvidence {
  status: GeminiImageTaskStatus;
  imageCount: number;
  imageSizes: Array<{ width: number; height: number }>;
  reason?: string;
}

export function isGeminiPage(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && host === 'gemini.google.com';
  } catch { return false; }
}

/** The visible prompt composer on gemini.google.com (Quill rich-textarea or contenteditable textbox). */
export function geminiComposer(doc: Document, url: string): HTMLElement | null {
  if (!isGeminiPage(url)) return null;
  const preferred = Array.from(doc.querySelectorAll<HTMLElement>(
    'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
  )).filter((element) => {
    if (!visible(element) || (element as HTMLTextAreaElement).disabled || element.getAttribute('aria-disabled') === 'true') return false;
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('data-placeholder'),
    ].filter(Boolean).join(' ').toLowerCase();
    return type !== 'search' && !/^(?:search|搜索|查找)/.test(label);
  });
  return preferred.length >= 1 ? preferred[preferred.length - 1]! : null;
}

const geminiUserTurns = (doc: Document): HTMLElement[] => {
  const queries = Array.from(doc.querySelectorAll<HTMLElement>('user-query, [data-test-id="user-query"], .user-query-container'));
  return queries.filter((el) => visible(el) && !queries.some((other) => other !== el && other.contains(el)));
};

const geminiModelTurns = (doc: Document): HTMLElement[] => {
  const responses = Array.from(doc.querySelectorAll<HTMLElement>('model-response, [data-test-id="model-response"], .response-container'));
  return responses.filter((el) => visible(el) && !responses.some((other) => other !== el && other.contains(el)));
};

export function geminiUserTurnBaseline(doc: Document, url: string): GeminiUserTurnBaseline | null {
  if (!isGeminiPage(url)) return null;
  const turns = geminiUserTurns(doc);
  return { count: turns.length, last: turns.at(-1) ?? null };
}

export function geminiSubmittedUserTurn(
  doc: Document,
  url: string,
  prompt: string,
  baseline: GeminiUserTurnBaseline,
): { submitted: false } | { submitted: true; turn: HTMLElement; index: number; marker: string } {
  if (!isGeminiPage(url)) return { submitted: false };
  const turns = geminiUserTurns(doc);
  const turn = turns.at(-1);
  if (!turn || turns.length <= baseline.count || turn === baseline.last) return { submitted: false };
  const text = (turn.innerText || turn.textContent || '').replace(/\s+/g, ' ').trim();
  const expected = prompt.replace(/\s+/g, ' ').trim();
  if (!expected) return { submitted: false };
  // Gemini sometimes adds minor UI labels ("You said") around the user query; accept exact or substring match.
  const matched = text === expected || text.includes(expected) || (expected.length >= 16 && text.includes(expected.slice(0, 32)));
  if (!matched) return { submitted: false };
  return {
    submitted: true,
    turn,
    index: turns.length - 1,
    marker: turn.id || turn.getAttribute('data-message-id') || `gemini-user-${turns.length - 1}`,
  };
}

const isGeneratedImg = (image: HTMLImageElement): boolean => {
  if (!visible(image) || image.naturalWidth < 128 || image.naturalHeight < 128) return false;
  const src = image.currentSrc || image.src || '';
  if (!src || /avatar|profile|logo|icon|sparkle/i.test(`${image.alt} ${image.className}`)) return false;
  return true;
};

export function geminiImageTaskEvidence(doc: Document, url: string, turn: HTMLElement | null): GeminiImageTaskEvidence {
  if (!isGeminiPage(url) || !turn?.isConnected) return { status: 'unknown', imageCount: 0, imageSizes: [] };
  const follows = (candidate: HTMLElement): boolean =>
    !!(turn.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
  const nextUserTurn = geminiUserTurns(doc).find(follows) ?? null;
  const beforeNextUser = (candidate: HTMLElement): boolean =>
    !nextUserTurn || !!(candidate.compareDocumentPosition(nextUserTurn) & Node.DOCUMENT_POSITION_FOLLOWING);

  const responses = geminiModelTurns(doc).filter((candidate) => follows(candidate) && beforeNextUser(candidate));
  if (nextUserTurn && !responses.length) return { status: 'unknown', imageCount: 0, imageSizes: [] };

  const images = responses.flatMap((resp) => Array.from(resp.querySelectorAll<HTMLImageElement>('img'))).filter(isGeneratedImg);
  if (images.length) {
    return {
      status: 'image_available',
      imageCount: images.length,
      imageSizes: images.map((img) => ({ width: img.naturalWidth, height: img.naturalHeight })),
    };
  }

  const responseText = responses.map((r) => (r.innerText || r.textContent || '')).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const limitOrFail = /can(?:not|'t) generate|unable to generate|reached your (?:image )?limit|usage limit|something went wrong|无法生成|不能生成|已达到.{0,12}上限|生成.{0,12}失败/u.test(responseText);
  if (limitOrFail) {
    return { status: 'failed', imageCount: 0, imageSizes: [], reason: responseText.slice(0, 200) };
  }

  const labelOf = (el: HTMLElement): string => [
    el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText, el.textContent,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();

  const stopVisible = Array.from(doc.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .some((el) => visible(el) && /stop response|stop generating|停止回答|停止生成/u.test(labelOf(el)));
  const busy = responses.some((resp) => resp.getAttribute('aria-busy') === 'true'
    || !!resp.querySelector('[aria-busy="true"], [role="progressbar"], .loading-indicator, mat-progress-spinner'));
  if (stopVisible || busy) return { status: 'generating', imageCount: 0, imageSizes: [] };
  if (responses.length) return { status: 'unknown', imageCount: 0, imageSizes: [] };
  return { status: 'prompt_submitted', imageCount: 0, imageSizes: [] };
}

export function geminiImageMediaMatchesTurn(doc: Document, url: string, turn: HTMLElement | null, mediaUrl: string): boolean {
  if (!isGeminiPage(url) || !turn?.isConnected || !/^https?:\/\//i.test(mediaUrl)) return false;
  const follows = (candidate: HTMLElement): boolean =>
    !!(turn.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
  const nextUserTurn = geminiUserTurns(doc).find(follows) ?? null;
  const beforeNextUser = (candidate: HTMLElement): boolean =>
    !nextUserTurn || !!(candidate.compareDocumentPosition(nextUserTurn) & Node.DOCUMENT_POSITION_FOLLOWING);
  const matching = geminiModelTurns(doc)
    .filter((candidate) => follows(candidate) && beforeNextUser(candidate))
    .flatMap((resp) => Array.from(resp.querySelectorAll<HTMLImageElement>('img')))
    .filter((img) => isGeneratedImg(img) && (img.currentSrc || img.src) === mediaUrl);
  return matching.length >= 1;
}

const isGeminiSaveLabel = (value: string): boolean => {
  const label = value.replace(/[\s\u200b]+/g, ' ').trim().toLowerCase();
  return /^(?:download|save)(?: full(?:-|\s)size)?(?: image)?$/.test(label)
    || /^(?:下载|下載|保存|儲存)(?:完整尺寸(?:的)?|原图|原圖)?(?:图片|圖片|图像|圖像)?$/.test(label);
};

export function isGeminiImageSaveTarget(doc: Document, url: string, element: HTMLElement): boolean {
  if (!isGeminiPage(url) || !visible(element) || (element as HTMLButtonElement).disabled) return false;
  if (!element.matches('button, a, [role="button"]') || !isGeminiSaveLabel(currentElementLabel(element))) return false;
  let region: HTMLElement | null = element;
  for (let depth = 0; region && depth < 10 && region !== doc.body; depth++, region = region.parentElement) {
    if (Array.from(region.querySelectorAll<HTMLImageElement>('img')).some(isGeneratedImg)) return true;
    if (region.matches('model-response, [role="dialog"]')) break;
  }
  return false;
}
