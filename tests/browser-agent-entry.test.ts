// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatGPTComposer, chatGPTImageMediaMatchesTurn, chatGPTImageTaskEvidence, chatGPTSubmittedUserTurn, chatGPTUserTurnBaseline, isChatGPTImageSaveTarget, isChatGPTPage } from '../app/browser-agent/chatgpt.ts';
import { composedTextNodes } from '../app/browser-agent/accessible-name.ts';
import { findTextTarget } from '../app/browser-agent/targets.ts';

vi.mock('@page-agent/page-controller', () => ({
  PageController: class {
    selectorMap = new Map<number, { ref: HTMLElement }>();
    elementTextMap = new Map<number, string>();

    async getBrowserState() {
      this.selectorMap.clear();
      const elements: HTMLElement[] = [];
      const visit = (root: Document | ShadowRoot): void => {
        elements.push(...Array.from(root.querySelectorAll<HTMLElement>('button, a, input, textarea, [role="button"], [contenteditable="true"]')));
        for (const host of Array.from(root.querySelectorAll<HTMLElement>('*'))) if (host.shadowRoot) visit(host.shadowRoot);
      };
      visit(document);
      elements
        .forEach((element, index) => {
          this.selectorMap.set(index, { ref: element });
          // Match a controller cache that did not refresh its text for a reused DOM node.
          if (!this.elementTextMap.has(index)) this.elementTextMap.set(index, element.innerText || element.textContent || '');
        });
      return {
        url: location.href,
        title: document.title,
        header: '',
        content: '',
        footer: '',
      };
    }

    async clickElement(index: number) {
      this.selectorMap.get(index)?.ref.click();
      return { success: true, message: 'clicked' };
    }

    async scroll() { return { success: true, message: 'scrolled' }; }
    async selectOption() { return { success: true, message: 'selected' }; }
  },
}));

const agent = () => (window as unknown as { __cooBrowserAgent: {
  state(): Promise<{ snapshotId: string; elements: Array<{ id: number; label: string; pressed?: boolean }>; timestamps: Array<{ text: string; datetime: string; context: string }>; mediaTargets: Array<{ id: number; mediaType: 'image' | 'video'; label: string; filenameHint: string; url: string }> }>;
  element(index: number): Promise<{ label: string; snapshotId: string; dataE2e: string; pressed?: boolean } | null>;
  resolveLocator(locator: { role?: string; name?: string; testId?: string; within?: { role?: string; name?: string; testId?: string } }, snapshotId?: string): Promise<{ ok: true; id: number; snapshotId: string } | { ok: false; reason: string }>;
  fileInputTarget(id: number, snapshotId?: string): Promise<{ ok: true; token: string; accept: string; multiple: boolean; snapshotId: string } | { ok: false; reason: string }>;
  releaseFileInput(token: string): void;
  click(index: number, snapshotId?: string): Promise<{ success: boolean; message: string }>;
  snapshot(): Promise<string>;
  mediaTarget(id: number, snapshotId: string): Promise<{ id: number; mediaType: 'image' | 'video'; label: string; filenameHint: string; url: string } | null>;
  textCenter(query: string): Promise<{ ok: true; x: number; y: number; snapshotId: string } | { ok: false; reason: string }>;
  pointTarget(x: number, y: number, snapshotId?: string): Promise<{ ok: true; target: { token: string; label: string; tag: string; role: string; snapshotId: string } } | { ok: false; reason: string }>;
} }).__cooBrowserAgent;

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
beforeEach(() => {
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
    pseudo ? { content: 'none' } as CSSStyleDeclaration : nativeGetComputedStyle(element) });
  document.body.innerHTML = '';
  document.title = 'Douyin';
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 30 });
  delete (window as unknown as Record<string, unknown>).__cooBrowserAgent;
  vi.resetModules();
});

describe('browser page target snapshots', () => {
  it('discovers visible direct media and file links, and binds their sources to the page snapshot', async () => {
    document.body.innerHTML = '<img src="https://cdn.example.test/images/whale.png?token=secret" alt="Blue whale"><video src="https://cdn.example.test/video/clip.mp4"></video><a href="https://cdn.example.test/downloads/another.mov">Download clip</a><img src="blob:https://cdn.example.test/asset">';
    await import('../app/browser-agent/entry.ts');
    const first = await agent().state();

    expect(first.mediaTargets.map(({ id, mediaType, label, filenameHint }) => ({ id, mediaType, label, filenameHint }))).toEqual([
      { id: 0, mediaType: 'image', label: 'Blue whale', filenameHint: 'whale.png' },
      { id: 1, mediaType: 'video', label: 'Video', filenameHint: 'clip.mp4' },
      { id: 2, mediaType: 'video', label: 'Download clip', filenameHint: 'another.mov' },
    ]);
    expect(await agent().mediaTarget(0, first.snapshotId)).toMatchObject({ url: 'https://cdn.example.test/images/whale.png?token=secret' });

    document.querySelector('img')!.setAttribute('src', 'https://cdn.example.test/images/new.png');
    expect(await agent().mediaTarget(0, first.snapshotId)).toBeNull();
  });

  it('sees a reused reply button become Delete and refuses the old index', async () => {
    document.body.innerHTML = '<button>回复</button>';
    await import('../app/browser-agent/entry.ts');
    const first = await agent().state();
    const button = document.querySelector('button')!;
    button.textContent = '删除评论';

    const current = await agent().element(first.elements[0]!.id);
    expect(current?.label).toBe('删除评论');
    expect(current?.snapshotId).not.toBe(first.snapshotId);
    await expect(agent().click(first.elements[0]!.id, first.snapshotId)).resolves.toEqual({ success: false, message: 'stale snapshot' });
  });

  it('changes the snapshot when the page or a nested list scrolls', async () => {
    document.body.innerHTML = '<div id="list" style="overflow:auto"><button>回复</button></div>';
    const list = document.getElementById('list')!;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
    await import('../app/browser-agent/entry.ts');
    const first = await agent().state();
    list.scrollTop = 240;
    await agent().state();
    const second = await agent().snapshot();
    expect(second).not.toBe(first.snapshotId);
  });

  it('reports exact time only when the visible page exposes a datetime attribute', async () => {
    document.body.innerHTML = '<article><p>Comment body</p><time datetime="2026-10-28T04:20:00Z">3 天前</time></article>';
    await import('../app/browser-agent/entry.ts');
    const state = await agent().state();
    expect(state.timestamps).toEqual([{ text: '3 天前', datetime: '2026-10-28T04:20:00Z', context: 'Comment body3 天前' }]);
  });

  it('invalidates the target snapshot when its semantic container changes', async () => {
    document.body.innerHTML = '<article aria-label="Video A"><button data-e2e="like">Like</button></article>';
    await import('../app/browser-agent/entry.ts');
    const first = await agent().state();
    document.querySelector('article')!.setAttribute('aria-label', 'Video B');
    const second = await agent().state();

    expect(second.snapshotId).not.toBe(first.snapshotId);
  });

  it('reports aria-pressed state with both element and page evidence', async () => {
    document.body.innerHTML = '<article aria-label="Video A"><button aria-label="Like" aria-pressed="false">Like</button></article>';
    await import('../app/browser-agent/entry.ts');
    const state = await agent().state();
    const index = state.elements.find((item) => item.label === 'Like')!.id;

    expect(await agent().element(index)).toMatchObject({ pressed: false });
    expect(state.elements.find((item) => item.id === index)).toMatchObject({ pressed: false });
  });

  it('exposes a stable page attribute and refuses a covered indexed click before dispatch', async () => {
    document.body.innerHTML = '<button data-e2e="submit">Continue</button><div id="overlay"></div>';
    const button = document.querySelector('button')!;
    const overlay = document.getElementById('overlay')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
    }) });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => overlay });
    let clicks = 0;
    button.addEventListener('click', () => { clicks++; });

    await import('../app/browser-agent/entry.ts');
    const first = await agent().state();
    const index = first.elements.find((item) => item.label === 'Continue')!.id;
    expect(await agent().element(index)).toMatchObject({ dataE2e: 'submit', snapshotId: first.snapshotId });
    await expect(agent().click(index, first.snapshotId)).resolves.toMatchObject({ success: false, message: 'target is not actionable: covered' });
    expect(clicks).toBe(0);
  });

  it('refuses an action when an unrelated DOM mutation occurs during bounded settling', async () => {
    document.body.innerHTML = '<button data-e2e="continue">Continue</button>';
    const button = document.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
    }) });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => button });
    let clicks = 0;
    button.addEventListener('click', () => { clicks++; });
    const original = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    let frames = 0;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames++;
        queueMicrotask(() => {
          if (frames === 1) document.body.setAttribute('data-unmapped-change', '1');
          callback(0);
        });
        return frames;
      },
    });

    try {
      await import('../app/browser-agent/entry.ts');
      const page = await agent().state();
      const index = page.elements.find((item) => item.label === 'Continue')!.id;
      const result = await agent().click(index, page.snapshotId);
      expect(result).toMatchObject({ success: false, message: 'target is not actionable: dom-changed' });
      expect(clicks).toBe(0);
      expect(await agent().snapshot()).toBe(page.snapshotId);
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', original ?? { configurable: true, writable: true, value: undefined });
    }
  });

  it('bounds actionability settling when animation frames stop', async () => {
    document.body.innerHTML = '<button data-e2e="continue">Continue</button>';
    const button = document.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
    }) });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => button });
    let clicks = 0;
    button.addEventListener('click', () => { clicks++; });
    const original = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: () => 1 });

    try {
      await import('../app/browser-agent/entry.ts');
      const page = await agent().state();
      const index = page.elements.find((item) => item.label === 'Continue')!.id;
      const startedAt = Date.now();
      const result = await agent().click(index, page.snapshotId);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(result).toMatchObject({ success: false, message: 'target is not actionable: wait-timeout' });
      expect(clicks).toBe(0);
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', original ?? { configurable: true, writable: true, value: undefined });
    }
  });

  it('resolves one matching control inside the requested semantic container', async () => {
    document.body.innerHTML = '<article aria-label="Video A"><button aria-label="Like" data-e2e="like">Like</button></article><article aria-label="Video B"><button aria-label="Like" data-e2e="like">Like</button></article>';
    const buttons = Array.from(document.querySelectorAll('button'));
    buttons.forEach((button, index) => Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20 + index * 120, y: 20, left: 20 + index * 120, top: 20, right: 120 + index * 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
    }) }));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => buttons[1] });

    await import('../app/browser-agent/entry.ts');
    const page = await agent().state();
    const resolved = await agent().resolveLocator(
      { role: 'button', name: 'Like', testId: 'like', within: { role: 'article', name: 'Video B' } },
      page.snapshotId,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const result = await agent().click(resolved.id, resolved.snapshotId);
    expect(result.success).toBe(true);
  });

  it('resolves and clicks an open-shadow target through the PageController index', async () => {
    document.body.innerHTML = '<article aria-label="Clip A"><x-toolbar></x-toolbar></article>';
    const shadow = document.querySelector('x-toolbar')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button aria-label="Follow"></button>';
    const button = shadow.querySelector('button')!;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
    }) });
    const host = document.querySelector('x-toolbar')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => host });
    Object.defineProperty(shadow, 'elementFromPoint', { configurable: true, value: () => button });

    await import('../app/browser-agent/entry.ts');
    const page = await agent().state();
    const resolved = await agent().resolveLocator({
      role: 'button', name: 'Follow', within: { role: 'article', name: 'Clip A' },
    }, page.snapshotId);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const result = await agent().click(resolved.id, resolved.snapshotId);
    expect(result.success).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('binds screenshot points to the exact live DOM target and snapshot', async () => {
    document.body.innerHTML = '<button aria-label="Play">Play</button>';
    const button = document.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
    }) });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => button });

    await import('../app/browser-agent/entry.ts');
    const page = await agent().state();
    const target = await agent().pointTarget(70, 35, page.snapshotId);
    expect(target).toMatchObject({ ok: true, target: { label: 'Play', tag: 'button', role: 'button', snapshotId: page.snapshotId } });
    button.setAttribute('aria-label', 'Pause');
    expect(await agent().pointTarget(70, 35, page.snapshotId)).toEqual({ ok: false, reason: 'stale-snapshot' });
  });
});

describe('browser text targets', () => {
  it('finds a text control in a same-origin frame and scrolls its frame into view', async () => {
    document.body.innerHTML = '<iframe></iframe>';
    const frame = document.querySelector('iframe')!;
    let frameTop = 900;
    let frameWasScrolled = false;
    Object.defineProperty(frame, 'clientWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(frame, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: frameTop, left: 20, top: frameTop, right: 120, bottom: frameTop + 100, width: 100, height: 100, toJSON: () => ({}),
    }) });
    Object.defineProperty(frame, 'scrollIntoView', { configurable: true, value: () => { frameWasScrolled = true; frameTop = 100; } });
    const childDocument = frame.contentDocument!;
    const childWindow = childDocument.defaultView!;
    Object.defineProperty(childWindow, 'frameElement', { configurable: true, value: frame });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 30 });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
    childDocument.body.innerHTML = '<button>Frame action</button>';
    const button = childDocument.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 10, y: 10, left: 10, top: 10, right: 40, bottom: 30, width: 30, height: 20, toJSON: () => ({}),
    }) });
    Object.defineProperty(childDocument, 'elementFromPoint', { configurable: true, value: () => button });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => frame });

    await import('../app/browser-agent/entry.ts');
    const result = await agent().textCenter('Frame action');
    expect(result).toMatchObject({ ok: true, x: 45, y: 120 });
    expect(frameWasScrolled).toBe(true);
  });

  it('scrolls a nested same-origin frame chain before returning a host viewport point', async () => {
    document.body.innerHTML = '<iframe></iframe>';
    const outer = document.querySelector('iframe')!;
    const outerDocument = outer.contentDocument!;
    const outerWindow = outerDocument.defaultView!;
    Object.defineProperty(outerWindow, 'frameElement', { configurable: true, value: outer });
    let outerTop = 900;
    let outerWasScrolled = false;
    Object.defineProperty(outer, 'clientWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(outer, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(outer, 'offsetHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(outer, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: outerTop, left: 20, top: outerTop, right: 120, bottom: outerTop + 100, width: 100, height: 100, toJSON: () => ({}),
    }) });
    Object.defineProperty(outer, 'scrollIntoView', { configurable: true, value: () => { outerWasScrolled = true; outerTop = 100; } });
    const inner = outerDocument.createElement('iframe');
    outerDocument.body.append(inner);
    let innerWasScrolled = false;
    Object.defineProperty(inner, 'clientWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(inner, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(inner, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(inner, 'offsetHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(inner, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 10, y: 15, left: 10, top: 15, right: 110, bottom: 115, width: 100, height: 100, toJSON: () => ({}),
    }) });
    Object.defineProperty(inner, 'scrollIntoView', { configurable: true, value: () => { innerWasScrolled = true; } });
    const innerDocument = inner.contentDocument!;
    const innerWindow = innerDocument.defaultView!;
    Object.defineProperty(innerWindow, 'frameElement', { configurable: true, value: inner });
    Object.defineProperty(innerWindow.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(innerWindow.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 30 });
    Object.defineProperty(innerWindow.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
    innerDocument.body.innerHTML = '<button>Nested action</button>';
    const button = innerDocument.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 10, y: 10, left: 10, top: 10, right: 40, bottom: 30, width: 30, height: 20, toJSON: () => ({}),
    }) });
    Object.defineProperty(innerDocument, 'elementFromPoint', { configurable: true, value: () => button });
    Object.defineProperty(outerDocument, 'elementFromPoint', { configurable: true, value: () => inner });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => outer });

    expect(Array.from(composedTextNodes(document)).map((node) => node.textContent)).toContain('Nested action');
    expect(findTextTarget(document, 'Nested action')).toMatchObject({ ok: true });

    await import('../app/browser-agent/entry.ts');
    expect(await agent().textCenter('Nested action')).toMatchObject({ ok: true, x: 55, y: 135 });
    expect(innerWasScrolled).toBe(true);
    expect(outerWasScrolled).toBe(true);
  });
});

describe('ChatGPT image controls', () => {
  it('recognizes only HTTPS ChatGPT pages and a unique visible message box', () => {
    document.body.innerHTML = '<textarea placeholder="Ask anything"></textarea>';
    expect(isChatGPTPage('https://chatgpt.com/')).toBe(true);
    expect(isChatGPTPage('https://chatgpt.com.example.org/')).toBe(false);
    expect(isChatGPTPage('http://chatgpt.com/')).toBe(false);
    expect(chatGPTComposer(document, 'https://chatgpt.com/')).toBe(document.querySelector('textarea'));
    document.body.insertAdjacentHTML('beforeend', '<textarea placeholder="Message"></textarea>');
    expect(chatGPTComposer(document, 'https://chatgpt.com/')).toBe(null);
    expect(chatGPTComposer(document, 'https://example.org/')).toBe(null);
  });

  it('requires a visible save control beside a loaded image on ChatGPT', () => {
    document.body.innerHTML = '<article data-message-author-role="assistant"><img id="generated"><button aria-label="Download"></button></article>';
    const image = document.getElementById('generated') as HTMLImageElement;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1024 },
      naturalHeight: { configurable: true, value: 1024 },
    });
    const button = document.querySelector('button')!;
    expect(isChatGPTImageSaveTarget(document, 'https://chatgpt.com/c/abc', button)).toBe(true);
    button.setAttribute('aria-label', '下載');
    expect(isChatGPTImageSaveTarget(document, 'https://chatgpt.com/c/abc', button)).toBe(true);
    expect(isChatGPTImageSaveTarget(document, 'https://example.org/', button)).toBe(false);
    image.remove();
    expect(isChatGPTImageSaveTarget(document, 'https://chatgpt.com/c/abc', button)).toBe(false);
  });

  it('binds a submitted prompt to a newly-added exact user turn, including duplicate prompt text', () => {
    const url = 'https://chatgpt.com/c/abc';
    const prompt = 'Create an image based on this prompt: A blue whale';
    document.body.innerHTML = `<article data-message-author-role="user">${prompt}</article>`;
    const baseline = chatGPTUserTurnBaseline(document, url)!;
    const priorTurn = baseline.last;
    expect(chatGPTSubmittedUserTurn(document, url, prompt, baseline)).toEqual({ submitted: false });

    const current = document.createElement('article');
    current.setAttribute('data-message-author-role', 'user');
    current.setAttribute('data-message-id', 'new-turn-1');
    current.textContent = prompt;
    document.body.append(current);
    const result = chatGPTSubmittedUserTurn(document, url, prompt, baseline);
    expect(result).toMatchObject({ submitted: true, turn: current, index: 1, marker: 'new-turn-1' });
    expect(result.submitted && result.turn === priorTurn).toBe(false);
    expect(chatGPTSubmittedUserTurn(document, 'https://example.org/', prompt, baseline)).toEqual({ submitted: false });
  });

  it('counts only loaded assistant images after the submitted user turn', () => {
    const url = 'https://chatgpt.com/c/abc';
    document.body.innerHTML = '<article data-message-author-role="assistant"><img id="old"></article><article data-message-author-role="user">prompt</article><article data-message-author-role="assistant" aria-busy="true"></article>';
    const user = document.querySelector<HTMLElement>('[data-message-author-role="user"]')!;
    const oldImage = document.getElementById('old') as HTMLImageElement;
    Object.defineProperties(oldImage, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    expect(chatGPTImageTaskEvidence(document, url, user)).toMatchObject({ status: 'generating', imageCount: 0 });

    const assistant = document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]')[1]!;
    assistant.removeAttribute('aria-busy');
    const image = document.createElement('img');
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 768 } });
    assistant.append(image);
    expect(chatGPTImageTaskEvidence(document, url, user)).toEqual({
      status: 'image_available', imageCount: 1, imageSizes: [{ width: 1024, height: 768 }],
    });
  });

  it('keeps non-image assistant completions unknown and recognizes a clear generation failure', () => {
    const url = 'https://chatgpt.com/c/abc';
    document.body.innerHTML = '<article data-message-author-role="user">prompt</article><article data-message-author-role="assistant">I could not complete that.</article>';
    const user = document.querySelector<HTMLElement>('[data-message-author-role="user"]')!;
    expect(chatGPTImageTaskEvidence(document, url, user).status).toBe('unknown');
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'There was an error generating your image';
    document.body.append(alert);
    expect(chatGPTImageTaskEvidence(document, url, user).status).toBe('failed');
  });

  it('binds a C02 direct image source to a loaded image after the task user turn', () => {
    const url = 'https://chatgpt.com/c/abc';
    document.body.innerHTML = '<article data-message-author-role="assistant"><img id="old" src="https://cdn.example.test/old.png"></article><article data-message-author-role="user">prompt</article><article data-message-author-role="assistant"><img id="new" src="https://cdn.example.test/new.png"></article>';
    const user = document.querySelector<HTMLElement>('[data-message-author-role="user"]')!;
    const oldImage = document.getElementById('old') as HTMLImageElement;
    const newImage = document.getElementById('new') as HTMLImageElement;
    Object.defineProperties(oldImage, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    Object.defineProperties(newImage, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });

    expect(chatGPTImageMediaMatchesTurn(document, url, user, 'https://cdn.example.test/new.png')).toBe(true);
    expect(chatGPTImageMediaMatchesTurn(document, url, user, 'https://cdn.example.test/old.png')).toBe(false);
    expect(chatGPTImageMediaMatchesTurn(document, 'https://example.org/', user, 'https://cdn.example.test/new.png')).toBe(false);
  });

  it('does not attribute an image after a later user turn to the earlier image task', () => {
    const url = 'https://chatgpt.com/c/abc';
    document.body.innerHTML = '<article data-message-author-role="user">task prompt</article><article data-message-author-role="user">later manual prompt</article><article data-message-author-role="assistant"><img id="later" src="https://cdn.example.test/later.png"></article>';
    const taskTurn = document.querySelector<HTMLElement>('[data-message-author-role="user"]')!;
    const image = document.getElementById('later') as HTMLImageElement;
    Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });

    expect(chatGPTImageTaskEvidence(document, url, taskTurn).status).toBe('unknown');
    expect(chatGPTImageMediaMatchesTurn(document, url, taskTurn, 'https://cdn.example.test/later.png')).toBe(false);
  });
});

describe('file input snapshots', () => {
  it('lists a file input with its accept and multiple flags and binds a token to the current snapshot', async () => {
    document.body.innerHTML = '<input type="file" accept="video/mp4,image/png" multiple>';
    await import('../app/browser-agent/entry.ts');
    const first = await agent().state();
    const fileInput = (first as unknown as { fileInputs: Array<{ id: number; accept: string; multiple: boolean }> }).fileInputs[0]!;
    expect(fileInput).toMatchObject({ accept: 'video/mp4,image/png', multiple: true });
    const target = await agent().fileInputTarget(fileInput.id, first.snapshotId);
    expect(target).toMatchObject({ ok: true, accept: 'video/mp4,image/png', multiple: true, snapshotId: first.snapshotId });
    if (target.ok) {
      expect(document.querySelector('input[type="file"]')?.getAttribute('data-coo-upload-token')).toBe(target.token);
      agent().releaseFileInput(target.token);
      expect(document.querySelector('input[type="file"]')?.hasAttribute('data-coo-upload-token')).toBe(false);
    }
  });
});
