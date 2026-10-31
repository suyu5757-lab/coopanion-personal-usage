/// <reference lib="dom" />

import { currentElementLabel } from './targets.ts';

const visible = (element: HTMLElement): boolean =>
  !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

export interface ChatGPTUserTurnBaseline {
  count: number;
  last: HTMLElement | null;
}

export type ChatGPTImageTaskStatus = 'prompt_submitted' | 'generating' | 'image_available' | 'unknown' | 'failed';

export interface ChatGPTImageTaskEvidence {
  status: ChatGPTImageTaskStatus;
  imageCount: number;
  imageSizes: Array<{ width: number; height: number }>;
}

export function isChatGPTPage(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'chatgpt.com' || host === 'chat.openai.com');
  } catch { return false; }
}

/** The one visible text editor used to compose a ChatGPT message. */
export function chatGPTComposer(doc: Document, url: string): HTMLElement | null {
  if (!isChatGPTPage(url)) return null;
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"], [role="textbox"]'))
    .filter((element) => {
      if (!visible(element) || (element as HTMLTextAreaElement).disabled || element.getAttribute('aria-disabled') === 'true') return false;
      const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
      const label = [element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.getAttribute('data-placeholder')]
        .filter(Boolean).join(' ').toLowerCase();
      return type !== 'search' && !/search|搜索|查找/.test(label);
    });
  return candidates.length === 1 ? candidates[0]! : null;
}

const userTurns = (doc: Document): HTMLElement[] =>
  Array.from(doc.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'));

/** Captures the last visible turn before a single approved prompt is dispatched. */
export function chatGPTUserTurnBaseline(doc: Document, url: string): ChatGPTUserTurnBaseline | null {
  if (!isChatGPTPage(url)) return null;
  const turns = userTurns(doc);
  return { count: turns.length, last: turns.at(-1) ?? null };
}

/** Accepts only a newly-added last user turn that exactly matches the submitted prompt. */
export function chatGPTSubmittedUserTurn(
  doc: Document,
  url: string,
  prompt: string,
  baseline: ChatGPTUserTurnBaseline,
): { submitted: false } | { submitted: true; turn: HTMLElement; index: number; marker: string } {
  if (!isChatGPTPage(url)) return { submitted: false };
  const turns = userTurns(doc);
  const turn = turns.at(-1);
  if (!turn || turns.length <= baseline.count || turn === baseline.last) return { submitted: false };
  const text = (turn.innerText || turn.textContent || '').replace(/\s+/g, ' ').trim();
  const expected = prompt.replace(/\s+/g, ' ').trim();
  if (!expected || text !== expected) return { submitted: false };
  return {
    submitted: true,
    turn,
    index: turns.length - 1,
    marker: turn.getAttribute('data-message-id') || turn.id || '',
  };
}

/** Classifies only assistant content after the exact user turn identified at dispatch. */
export function chatGPTImageTaskEvidence(doc: Document, url: string, turn: HTMLElement | null): ChatGPTImageTaskEvidence {
  if (!isChatGPTPage(url) || !turn?.isConnected) return { status: 'unknown', imageCount: 0, imageSizes: [] };
  const follows = (candidate: HTMLElement): boolean =>
    !!(turn.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
  const nextUserTurn = userTurns(doc).find(follows) ?? null;
  const beforeNextUser = (candidate: HTMLElement): boolean =>
    !nextUserTurn || !!(candidate.compareDocumentPosition(nextUserTurn) & Node.DOCUMENT_POSITION_FOLLOWING);
  const assistants = Array.from(doc.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'))
    .filter((candidate) => follows(candidate) && beforeNextUser(candidate));
  if (nextUserTurn && !assistants.length) return { status: 'unknown', imageCount: 0, imageSizes: [] };
  const images = assistants.flatMap((message) => Array.from(message.querySelectorAll<HTMLImageElement>('img')))
    .filter((image) => visible(image) && image.naturalWidth >= 64 && image.naturalHeight >= 64);
  if (images.length) {
    return {
      status: 'image_available',
      imageCount: images.length,
      imageSizes: images.map((image) => ({ width: image.naturalWidth, height: image.naturalHeight })),
    };
  }

  const alerts = Array.from(doc.querySelectorAll<HTMLElement>('[role="alert"]')).filter(follows);
  const failed = alerts.some((alert) => /could(?: not|n.t) generate|failed to generate|error generating|无法生成|生成.{0,12}失败/u.test(
    (alert.innerText || alert.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase(),
  ));
  if (failed) return { status: 'failed', imageCount: 0, imageSizes: [] };

  const stopLabel = (element: HTMLElement): string => [
    element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const stopControl = assistants.some((message) =>
    Array.from(message.querySelectorAll<HTMLElement>('button, [role="button"]')).some((element) =>
      visible(element) && /stop generating|stop response|停止生成/u.test(stopLabel(element))),
  );
  const busy = assistants.some((message) => message.getAttribute('aria-busy') === 'true'
    || !!message.querySelector('[aria-busy="true"]'));
  const liveGenerating = assistants.some((message) =>
    Array.from(message.querySelectorAll<HTMLElement>('[role="status"], [aria-live]')).some((element) =>
      /generating|正在生成/u.test(stopLabel(element))),
  );
  if (stopControl || busy || liveGenerating) return { status: 'generating', imageCount: 0, imageSizes: [] };
  if (assistants.length) return { status: 'unknown', imageCount: 0, imageSizes: [] };
  return { status: 'prompt_submitted', imageCount: 0, imageSizes: [] };
}

/** Confirms a direct C02 media source is one loaded image in this task's later assistant turn. */
export function chatGPTImageMediaMatchesTurn(doc: Document, url: string, turn: HTMLElement | null, mediaUrl: string): boolean {
  if (!isChatGPTPage(url) || !turn?.isConnected || !/^https?:\/\//i.test(mediaUrl)) return false;
  const follows = (candidate: HTMLElement): boolean =>
    !!(turn.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
  const nextUserTurn = userTurns(doc).find(follows) ?? null;
  const beforeNextUser = (candidate: HTMLElement): boolean =>
    !nextUserTurn || !!(candidate.compareDocumentPosition(nextUserTurn) & Node.DOCUMENT_POSITION_FOLLOWING);
  const matching = Array.from(doc.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'))
    .filter((candidate) => follows(candidate) && beforeNextUser(candidate))
    .flatMap((message) => Array.from(message.querySelectorAll<HTMLImageElement>('img')))
    .filter((image) => visible(image) && image.naturalWidth >= 64 && image.naturalHeight >= 64
      && (image.currentSrc || image.src) === mediaUrl);
  return matching.length === 1;
}

const isImageSaveLabel = (value: string): boolean => {
  const label = value.replace(/[\s\u200b]+/g, ' ').trim().toLowerCase();
  return /^(?:save|download)(?: image)?$/.test(label) || /^(?:保存|儲存|下载|下載)(?:图片|圖片|图像|圖像)?$/.test(label);
};

/** A Save/Download control is accepted only beside a loaded image on the ChatGPT site. */
export function isChatGPTImageSaveTarget(doc: Document, url: string, element: HTMLElement): boolean {
  if (!isChatGPTPage(url) || !visible(element) || (element as HTMLButtonElement).disabled) return false;
  if (!element.matches('button, a, [role="button"]') || !isImageSaveLabel(currentElementLabel(element))) return false;

  let region: HTMLElement | null = element;
  for (let depth = 0; region && depth < 8 && region !== doc.body; depth++, region = region.parentElement) {
    const image = Array.from(region.querySelectorAll<HTMLImageElement>('img')).some((candidate) =>
      visible(candidate) && candidate.naturalWidth >= 64 && candidate.naturalHeight >= 64,
    );
    if (image) return true;
    if (region.matches('[data-message-author-role="assistant"], [role="dialog"], article')) return false;
  }
  return false;
}
