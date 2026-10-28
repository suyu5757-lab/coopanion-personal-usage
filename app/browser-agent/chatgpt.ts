/// <reference lib="dom" />

import { currentElementLabel } from './targets.ts';

const visible = (element: HTMLElement): boolean =>
  !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

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
