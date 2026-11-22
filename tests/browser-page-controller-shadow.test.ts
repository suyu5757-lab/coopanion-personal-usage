/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { PageController } from '@page-agent/page-controller';
import { findLocatorTarget } from '../app/browser-agent/targets.ts';

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({
    x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
  }) });
  Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [this.getBoundingClientRect()]; } });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('x-toolbar') });
  const native = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
    pseudo ? { content: 'none' } as CSSStyleDeclaration : native(element) });
});

describe('PageController open-shadow indexing', () => {
  it('indexes an interactive control from an open shadow root with a resolvable element reference', async () => {
    document.body.innerHTML = '<x-toolbar></x-toolbar>';
    const shadow = document.querySelector('x-toolbar')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button aria-label="Follow"></button>';
    const button = shadow.querySelector('button')!;
    Object.defineProperty(shadow, 'elementFromPoint', { configurable: true, value: () => button });
    expect(findLocatorTarget(document, { role: 'button', name: 'Follow' })).toMatchObject({ ok: true, element: button });
    const controller = new PageController({ viewportExpansion: 160, highlightOpacity: 0, highlightLabelOpacity: 0 });

    await controller.getBrowserState();

    const selectorMap = (controller as unknown as { selectorMap: Map<number, { ref?: HTMLElement }> }).selectorMap;
    const indexed = [...selectorMap.entries()].find(([, node]) => node.ref === button);
    expect(indexed).toBeDefined();

    await import('../app/browser-agent/entry.ts');
    const agent = (window as unknown as { __cooBrowserAgent: {
      state(): Promise<{ snapshotId: string; elements: Array<{ id: number; label: string }> }>;
      resolveLocator(locator: { role?: string; name?: string }, snapshotId?: string): Promise<{ ok: true; id: number } | { ok: false; reason: string }>;
    } }).__cooBrowserAgent;
    const page = await agent.state();
    expect(page.elements.some((element) => element.label === 'Follow')).toBe(true);
    const resolved = await agent.resolveLocator({ role: 'button', name: 'Follow' }, page.snapshotId);
    expect(resolved).toMatchObject({ ok: true, id: indexed?.[0] });

  });
});
