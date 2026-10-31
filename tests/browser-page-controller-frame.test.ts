/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { PageController } from '@page-agent/page-controller';

const frameBounds = { x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 120, width: 100, height: 100, toJSON: () => ({}) };
const buttonBounds = { x: 10, y: 10, left: 10, top: 10, right: 40, bottom: 30, width: 30, height: 20, toJSON: () => ({}) };

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
  Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [this.getBoundingClientRect()]; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('iframe') });
  const native = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
    pseudo ? { content: 'none' } as CSSStyleDeclaration : native(element) });
});

describe('PageController same-origin frame indexing', () => {
  it('indexes a visible interactive element from a same-origin iframe', async () => {
    document.body.innerHTML = '<iframe></iframe>';
    const frame = document.querySelector('iframe')!;
    Object.defineProperty(frame, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get() { return 100; } });
    Object.defineProperty(frame, 'clientWidth', { configurable: true, get() { return 100; } });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, get() { return 100; } });
    const childDocument = frame.contentDocument!;
    const childWindow = childDocument.defaultView!;
    Object.defineProperty(childWindow.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [this.getBoundingClientRect()]; } });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
    childDocument.body.innerHTML = '<button aria-label="Inside frame"></button>';
    const button = childDocument.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => buttonBounds });
    Object.defineProperty(childDocument, 'elementFromPoint', { configurable: true, value: () => button });

    const controller = new PageController({ viewportExpansion: 160, highlightOpacity: 0, highlightLabelOpacity: 0 });
    await controller.getBrowserState();
    const selectorMap = (controller as unknown as { selectorMap: Map<number, { ref?: HTMLElement }> }).selectorMap;
    expect([...selectorMap.values()].some((node) => node.ref === button)).toBe(true);
  });

  it('resolves a frame control by exact role and name through the Browser Agent', async () => {
    document.body.innerHTML = '<article aria-label="Clip"><iframe></iframe></article>';
    const frame = document.querySelector('iframe')!;
    Object.defineProperty(frame, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get() { return 100; } });
    Object.defineProperty(frame, 'clientWidth', { configurable: true, get() { return 100; } });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, get() { return 100; } });
    const childDocument = frame.contentDocument!;
    const childWindow = childDocument.defaultView!;
    Object.defineProperty(childWindow, 'frameElement', { configurable: true, value: frame });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [this.getBoundingClientRect()]; } });
    Object.defineProperty(childWindow.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
    const nativeGetComputedStyle = childWindow.getComputedStyle.bind(childWindow);
    Object.defineProperty(childWindow, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
      pseudo ? { content: 'none' } as CSSStyleDeclaration : nativeGetComputedStyle(element) });
    childDocument.body.innerHTML = '<button aria-label="Inside frame"></button>';
    const button = childDocument.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => buttonBounds });
    Object.defineProperty(childDocument, 'elementFromPoint', { configurable: true, value: () => button });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => frame });
    let clicks = 0;
    button.addEventListener('click', () => { clicks++; });

    await import('../app/browser-agent/entry.ts');
    const agent = (window as unknown as { __cooBrowserAgent: {
      state(): Promise<{ snapshotId: string }>;
      resolveLocator(locator: { role?: string; name?: string; within?: { role?: string; name?: string } }, snapshotId?: string): Promise<{ ok: true; id: number } | { ok: false; reason: string }>;
      click(id: number, snapshotId?: string): Promise<{ success: boolean; message: string }>;
    } }).__cooBrowserAgent;
    const page = await agent.state();
    const resolved = await agent.resolveLocator({
      role: 'button', name: 'Inside frame', within: { role: 'article', name: 'Clip' },
    }, page.snapshotId);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const clicked = await agent.click(resolved.id, page.snapshotId);
    expect(clicked).toMatchObject({ success: true });
    expect(clicks).toBe(1);

    const latest = await agent.state();
    const latestTarget = await agent.resolveLocator({ role: 'button', name: 'Inside frame' }, latest.snapshotId);
    expect(latestTarget.ok).toBe(true);
    if (!latestTarget.ok) return;
    const originalRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
      button.setAttribute('data-state', 'mutated');
      queueMicrotask(() => callback(0));
      return 1;
    } });
    try {
      const refused = await agent.click(latestTarget.id, latest.snapshotId);
      expect(refused).toMatchObject({ success: false, message: expect.stringContaining('dom-changed') });
      expect(clicks).toBe(1);
    } finally {
      if (originalRaf) Object.defineProperty(window, 'requestAnimationFrame', originalRaf);
      else Reflect.deleteProperty(window, 'requestAnimationFrame');
    }
  });
});
