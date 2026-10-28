// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatGPTComposer, isChatGPTImageSaveTarget, isChatGPTPage } from '../app/browser-agent/chatgpt.ts';

vi.mock('@page-agent/page-controller', () => ({
  PageController: class {
    selectorMap = new Map<number, { ref: HTMLElement }>();
    elementTextMap = new Map<number, string>();

    async getBrowserState() {
      this.selectorMap.clear();
      Array.from(document.querySelectorAll<HTMLElement>('button, a, input, textarea, [role="button"], [contenteditable="true"]'))
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
  state(): Promise<{ snapshotId: string; elements: Array<{ id: number; label: string }>; timestamps: Array<{ text: string; datetime: string; context: string }> }>;
  element(index: number): Promise<{ label: string; snapshotId: string } | null>;
  fileInputTarget(id: number, snapshotId?: string): Promise<{ ok: true; token: string; accept: string; multiple: boolean; snapshotId: string } | { ok: false; reason: string }>;
  releaseFileInput(token: string): void;
  click(index: number, snapshotId?: string): Promise<{ success: boolean; message: string }>;
  snapshot(): Promise<string>;
} }).__cooBrowserAgent;

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Douyin';
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 30 });
  delete (window as unknown as Record<string, unknown>).__cooBrowserAgent;
  vi.resetModules();
});

describe('browser page target snapshots', () => {
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
