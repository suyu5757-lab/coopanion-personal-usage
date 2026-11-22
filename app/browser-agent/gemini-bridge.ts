/// <reference lib="dom" />
import {
  geminiComposer,
  geminiImageTaskEvidence,
  geminiSubmittedUserTurn,
  geminiUserTurnBaseline,
  isGeminiPage,
  type GeminiUserTurnBaseline,
} from './gemini.ts';

interface GeminiTaskRuntime {
  initialUrl: string;
  baseline: GeminiUserTurnBaseline;
  pageUrl: string | null;
  turn: HTMLElement | null;
  turnMarker: string;
  turnIndex: number;
}

const agent = (window as unknown as { __cooBrowserAgent?: Record<string, unknown> }).__cooBrowserAgent;
if (agent && !agent.__geminiAttached) {
  agent.__geminiAttached = true;
  const tasks = new Map<string, GeminiTaskRuntime>();

  agent.geminiComposer = async () => {
    if (!isGeminiPage(location.href)) return { ok: false, reason: 'the current page is not Gemini' };
    const el = geminiComposer(document, location.href);
    if (!el) return { ok: false, reason: 'no visible Gemini prompt box' };
    const snap = typeof agent.snapshot === 'function' ? await (agent.snapshot as () => Promise<string>)() : '';
    return { ok: true, id: -1, snapshotId: snap };
  };

  agent.prepareGeminiInput = async () => {
    if (!isGeminiPage(location.href)) return null;
    const el = geminiComposer(document, location.href);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.select();
    } else if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      x: Math.round(rect.left + Math.min(rect.width * 0.5, 160)),
      y: Math.round(rect.top + rect.height / 2),
    };
  };

  agent.notifyGeminiInput = (text: string) => {
    const el = geminiComposer(document, location.href);
    if (!el) return false;
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
    } catch { /* ignore */ }
    return true;
  };

  agent.geminiImageTaskStart = (taskId: string) => {
    const baseline = geminiUserTurnBaseline(document, location.href);
    if (!baseline) return { ok: false, reason: 'the current page is not Gemini' };
    tasks.set(taskId, { initialUrl: location.href, baseline, pageUrl: null, turn: null, turnMarker: '', turnIndex: -1 });
    while (tasks.size > 16) tasks.delete(tasks.keys().next().value!);
    return { ok: true };
  };

  agent.geminiSendButtonPoint = () => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>(
      'button[aria-label="发送"], button[aria-label*="发送"], button[aria-label*="Send" i], button[aria-label*="Submit" i], button.send-button, [data-test-id="send-button"]',
    )).filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true';
    });
    const btn = buttons.at(-1);
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };

  agent.clickGeminiSendIfDraftRemains = () => {
    const el = geminiComposer(document, location.href);
    const draft = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el?.innerText ?? '');
    if (!draft.trim()) return { clicked: false, reason: 'already-cleared' };
    const buttons = Array.from(document.querySelectorAll<HTMLElement>(
      'button[aria-label="发送"], button[aria-label*="发送"], button[aria-label*="Send" i], button[aria-label*="Submit" i], button.send-button, [data-test-id="send-button"]',
    )).filter((b) => !!(b.offsetWidth || b.offsetHeight) && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true');
    const btn = buttons.at(-1);
    if (!btn) return { clicked: false, reason: 'no-send-button' };
    btn.click();
    return { clicked: true };
  };

  agent.geminiSubmission = async (taskId: string, prompt: string) => {
    const task = tasks.get(taskId);
    const hasStopOrBusy = () => Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
      .some((el) => !!(el.offsetWidth || el.offsetHeight) && /stop response|stop generating|停止回答|停止生成/i.test(
        [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText].filter(Boolean).join(' '),
      ));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const el = geminiComposer(document, location.href);
      const draft = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el?.innerText ?? '');
      const submittedTurn = task ? geminiSubmittedUserTurn(document, location.href, prompt, task.baseline) : { submitted: false as const };
      if (task && isGeminiPage(location.href) && !draft.trim() && (submittedTurn.submitted || hasStopOrBusy())) {
        const turns = Array.from(document.querySelectorAll<HTMLElement>('user-query, [data-test-id="user-query"], .user-query-container'));
        const turn = submittedTurn.submitted ? submittedTurn.turn : (turns.at(-1) ?? null);
        const idx = submittedTurn.submitted ? submittedTurn.index : Math.max(0, turns.length - 1);
        const marker = submittedTurn.submitted ? submittedTurn.marker : (turn?.id || `gemini-user-${idx}`);
        task.pageUrl = location.href;
        task.turn = turn;
        task.turnMarker = marker;
        task.turnIndex = idx;
        return { submitted: true, userTurnMarker: marker, userTurnIndex: idx };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const el = geminiComposer(document, location.href);
    const draft = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el?.innerText ?? '');
    const turns = Array.from(document.querySelectorAll<HTMLElement>('user-query, [data-test-id="user-query"], .user-query-container'));
    if (task && isGeminiPage(location.href) && !draft.trim() && (turns.length > task.baseline.count || location.href !== task.initialUrl || hasStopOrBusy())) {
      const turn = turns.at(-1) ?? null;
      const idx = Math.max(0, turns.length - 1);
      const marker = turn?.id || `gemini-user-${idx}`;
      task.pageUrl = location.href;
      task.turn = turn;
      task.turnMarker = marker;
      task.turnIndex = idx;
      return { submitted: true, userTurnMarker: marker, userTurnIndex: idx };
    }
    return { submitted: false };
  };

  agent.geminiImageTaskStatus = (taskId: string) => {
    const task = tasks.get(taskId);
    if (!task?.pageUrl) return { status: 'unknown', imageCount: 0, imageSizes: [] };
    let turn = task.turn?.isConnected ? task.turn : null;
    if (!turn) {
      const turns = Array.from(document.querySelectorAll<HTMLElement>('user-query, [data-test-id="user-query"], .user-query-container'));
      if (task.turnIndex >= 0 && task.turnIndex < turns.length) turn = turns[task.turnIndex] ?? null;
    }
    return geminiImageTaskEvidence(document, location.href, turn);
  };

  agent.geminiImageSaveTarget = async (index: number) => {
    if (!isGeminiPage(location.href)) return false;
    if (typeof agent.element !== 'function') return false;
    const info = await (agent.element as (i: number) => Promise<{ label?: string; text?: string; aria?: string } | null>)(index);
    if (!info) return false;
    const text = [info.label, info.text, info.aria].filter(Boolean).join(' ').toLowerCase();
    if (/发起新对话|新对话|new chat|settings|设置|帮助|help/.test(text)) return false;
    return /download|save|下载|下載|保存|儲存/.test(text);
  };

  const collectImagesDeep = (root: Document | ShadowRoot | Element): HTMLImageElement[] => {
    const out: HTMLImageElement[] = [];
    const walk = (node: Document | ShadowRoot | Element) => {
      for (const el of Array.from(node.querySelectorAll('*'))) {
        if (el.tagName === 'IMG') out.push(el as HTMLImageElement);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  };

  const isVisibleGeneratedImg = (img: HTMLImageElement) => {
    if (!(img.offsetWidth || img.offsetHeight || img.getClientRects().length)) return false;
    if (img.naturalWidth < 160 || img.naturalHeight < 160) return false;
    const src = img.currentSrc || img.src || '';
    if (!src || /avatar|profile|logo|icon|sparkle|googleusercontent\.com\/a\//i.test(`${img.alt} ${img.className} ${src}`)) return false;
    return true;
  };

  const latestGeneratedImg = (provider: string): HTMLImageElement | null => {
    const scopeSelector = provider === 'gemini'
      ? 'model-response, [data-test-id="model-response"], .response-container, generated-image, single-image'
      : '[data-message-author-role="assistant"], article';
    const containers = Array.from(document.querySelectorAll(scopeSelector));
    for (let i = containers.length - 1; i >= 0; i--) {
      const found = collectImagesDeep(containers[i]!).filter(isVisibleGeneratedImg);
      if (found.length) return found.at(-1) ?? null;
    }
    const fallback = collectImagesDeep(document).filter((img) => isVisibleGeneratedImg(img) && img.naturalWidth >= 256 && img.naturalHeight >= 256);
    return fallback.at(-1) ?? null;
  };

  const bytesToBase64 = (buf: Uint8Array): string => {
    let bin = '';
    for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
    return btoa(bin);
  };

  agent.extractLatestGeneratedImage = async (provider: string) => {
    const img = latestGeneratedImg(provider);
    if (!img) return null;
    const url = img.currentSrc || img.src || '';
    if (!url) return null;
    if (url.startsWith('data:image/')) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
      if (m) return { base64: m[2], mime: m[1]!.toLowerCase(), url: 'data-uri', width: img.naturalWidth, height: img.naturalHeight };
    }
    if (url.startsWith('blob:') || /^https?:\/\//i.test(url)) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) {
          const blob = await res.blob();
          const ct = (blob.type || res.headers.get('content-type') || '').toLowerCase().split(';')[0]!.trim();
          if (blob.size > 0 && (ct.startsWith('image/') || url.startsWith('blob:'))) {
            const buf = new Uint8Array(await blob.arrayBuffer());
            return { base64: bytesToBase64(buf), mime: ct.startsWith('image/') ? ct : 'image/png', url, width: img.naturalWidth, height: img.naturalHeight };
          }
        }
      } catch { /* fall through to main-process session.fetch or native download click */ }
    }
    return { url, mime: 'image/png', width: img.naturalWidth, height: img.naturalHeight };
  };

  agent.findLatestGeminiDownloadButton = async () => {
    if (!isGeminiPage(location.href)) return null;
    const img = latestGeneratedImg('gemini');
    if (!img) return null;
    img.scrollIntoView({ block: 'center', inline: 'nearest' });
    const imgRect = img.getBoundingClientRect();
    const imgPt = { x: Math.round(imgRect.left + imgRect.width / 2), y: Math.round(imgRect.top + imgRect.height / 2) };
    const collectButtonsDeep = (root: Document | ShadowRoot | Element): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const walk = (node: Document | ShadowRoot | Element) => {
        for (const el of Array.from(node.querySelectorAll('*'))) {
          if (el.matches?.('button, a, [role="button"]')) out.push(el as HTMLElement);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    };
    const isDownloadBtn = (el: HTMLElement): boolean => {
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), el.innerText, el.textContent]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text || /发起新对话|新对话|new chat|settings|设置|帮助|help|copy|复制/.test(text)) return false;
      return /(?:download|save)(?: full(?:-|\s)size)?(?: image)?|(?:下载|下載|保存|儲存)(?:完整尺寸(?:的)?|原图|原圖)?(?:图片|圖片|图像|圖像)?/i.test(text);
    };
    const container = img.closest('generated-image, single-image, model-response, [data-test-id="model-response"], .response-container') ?? img.parentElement;
    const candidates = container ? collectButtonsDeep(container).filter(isDownloadBtn) : [];
    const pick = candidates.find((btn) => {
      const r = btn.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    }) ?? candidates[0] ?? null;
    if (!pick) return { imgPt, buttonPt: null };
    pick.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = pick.getBoundingClientRect();
    return {
      imgPt,
      buttonPt: r.width > 8 && r.height > 8 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null,
    };
  };

  agent.clickLatestGeminiDownloadButton = async () => {
    if (!isGeminiPage(location.href)) return false;
    const img = latestGeneratedImg('gemini');
    if (!img) return false;
    const collectButtonsDeep = (root: Document | ShadowRoot | Element): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const walk = (node: Document | ShadowRoot | Element) => {
        for (const el of Array.from(node.querySelectorAll('*'))) {
          if (el.matches?.('button, a, [role="button"]')) out.push(el as HTMLElement);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    };
    const container = img.closest('generated-image, single-image, model-response, [data-test-id="model-response"], .response-container') ?? img.parentElement;
    if (!container) return false;
    const btn = collectButtonsDeep(container).find((el) => {
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), el.innerText, el.textContent]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text || /发起新对话|新对话|new chat|settings|设置|帮助|help|copy|复制/.test(text)) return false;
      return /(?:download|save)(?: full(?:-|\s)size)?(?: image)?|(?:下载|下載|保存|儲存)(?:完整尺寸(?:的)?|原图|原圖)?(?:图片|圖片|图像|圖像)?/i.test(text);
    });
    if (!btn) return false;
    btn.click();
    return true;
  };
}
