export interface AgentMediaTarget {
  id: number;
  mediaType: 'image' | 'video';
  label: string;
  filenameHint: string;
  url: string;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);

function visible(element: Element): boolean {
  const html = element as HTMLElement;
  return !!(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
}

function normalizedLabel(value: string, fallback: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return text || fallback;
}

function filenameHint(value: string, mediaType: 'image' | 'video'): string {
  let path = '';
  try { path = decodeURIComponent(new URL(value).pathname); } catch { return ''; }
  const name = path.split('/').filter(Boolean).at(-1) ?? '';
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return '';
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  const supported = mediaType === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
  if (!supported.has(extension)) return '';
  if (/[A-Za-z0-9_-]{36,}/.test(name.replace(/\.[^.]+$/, ''))) return `asset.${extension}`;
  return name;
}

function isHttpUrl(value: string, base: string): boolean {
  try {
    const url = new URL(value, base);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch { return false; }
}

/** Finds visible direct media and explicit media-file links without returning them to the model. */
export function discoverMediaTargets(owner: Document, limit = 40, elements: readonly HTMLElement[] = Array.from(owner.querySelectorAll<HTMLElement>('*'))): AgentMediaTarget[] {
  const found: Array<Omit<AgentMediaTarget, 'id'>> = [];
  const seen = new Set<string>();
  const add = (element: Element, type: 'image' | 'video', rawUrl: string, label: string): void => {
    if (!visible(element) || !isHttpUrl(rawUrl, owner.baseURI) || seen.has(`${type}\n${rawUrl}`)) return;
    let url: URL;
    try { url = new URL(rawUrl, owner.baseURI); } catch { return; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return;
    const absolute = url.href;
    seen.add(`${type}\n${absolute}`);
    found.push({ mediaType: type, label: normalizedLabel(label, type === 'image' ? 'Image' : 'Video'), filenameHint: filenameHint(absolute, type), url: absolute });
  };

  for (const element of elements.filter((item) => item.matches('img'))) {
    const image = element as HTMLImageElement;
    add(image, 'image', image.currentSrc || image.src || image.getAttribute('src') || '', image.alt || image.getAttribute('aria-label') || image.title || '');
    if (found.length >= limit) break;
  }
  if (found.length < limit) {
    for (const element of elements.filter((item) => item.matches('video'))) {
      const video = element as HTMLVideoElement;
      const source = video.currentSrc || video.src || video.querySelector('source')?.src || video.getAttribute('src') || '';
      add(video, 'video', source, video.getAttribute('aria-label') || video.title || '');
      if (found.length >= limit) break;
    }
  }
  if (found.length < limit) {
    for (const element of elements.filter((item) => item.matches('a[href]'))) {
      const anchor = element as HTMLAnchorElement;
      const url = anchor.href || anchor.getAttribute('href') || '';
      const extension = (() => { try { return new URL(url).pathname.split('.').at(-1)?.toLowerCase() ?? ''; } catch { return ''; } })();
      const type = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : null;
      if (!type) continue;
      add(anchor, type, url, anchor.getAttribute('aria-label') || anchor.title || anchor.innerText || anchor.textContent || '');
      if (found.length >= limit) break;
    }
  }

  return found.slice(0, limit).map((target, id) => ({ ...target, id }));
}
