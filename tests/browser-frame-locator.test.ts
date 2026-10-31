/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { composedElements } from '../app/browser-agent/accessible-name.ts';
import { actionabilityPoint, findLocatorTarget } from '../app/browser-agent/targets.ts';

const frameBounds = { x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 120, width: 100, height: 100, toJSON: () => ({}) };
const buttonBounds = { x: 10, y: 10, left: 10, top: 10, right: 40, bottom: 30, width: 30, height: 20, toJSON: () => ({}) };

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
  Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [this.getBoundingClientRect()]; } });
  const native = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
    pseudo ? { content: 'none' } as CSSStyleDeclaration : native(element) });
});

function addFrameButton(frame: HTMLIFrameElement, ariaLabel: string): { frameDocument: Document; button: HTMLButtonElement } {
  Object.defineProperty(frame, 'clientWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(frame, 'clientHeight', { configurable: true, get() { return 100; } });
  const frameDocument = frame.contentDocument!;
  const frameWindow = frameDocument.defaultView!;
  Object.defineProperty(frameWindow, 'frameElement', { configurable: true, value: frame });
  Object.defineProperty(frameWindow.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(frameWindow.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
  Object.defineProperty(frameWindow.HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [this.getBoundingClientRect()]; } });
  const native = frameWindow.getComputedStyle.bind(frameWindow);
  Object.defineProperty(frameWindow, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
    pseudo ? { content: 'none' } as CSSStyleDeclaration : native(element) });
  frameDocument.body.innerHTML = `<button aria-label="${ariaLabel}"></button>`;
  const button = frameDocument.querySelector('button')!;
  Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => buttonBounds });
  Object.defineProperty(frameDocument, 'elementFromPoint', { configurable: true, value: () => button });
  return { frameDocument, button };
}

describe('same-origin iframe locator path', () => {
  it('resolves a same-origin frame target inside its composed ancestor and maps it to top viewport coordinates', () => {
    document.body.innerHTML = '<article aria-label="Clip"><iframe></iframe></article>';
    const frame = document.querySelector('iframe')!;
    Object.defineProperty(frame, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get() { return 100; } });
    const { frameDocument, button } = addFrameButton(frame, 'Follow');
    expect(frameDocument.defaultView?.frameElement).toBe(frame);
    expect(frame.ownerDocument).toBe(document);
    expect(frame.offsetWidth).toBe(100);
    expect(frame.clientLeft).toBe(0);
    expect(frame.clientTop).toBe(0);
    expect(frame.getBoundingClientRect().width / frame.offsetWidth).toBe(1);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => frame });

    expect(Array.from(composedElements(document))).toContain(button);
    const found = findLocatorTarget(document, { role: 'button', name: 'Follow', within: { role: 'article', name: 'Clip' } });
    expect(found).toMatchObject({ ok: true, element: button });
    expect(actionabilityPoint(document, button)).toMatchObject({ ok: true, x: 45, y: 40, left: 30, top: 30 });
  });

  it('rejects a target whose frame point is covered by another page element', () => {
    document.body.innerHTML = '<iframe></iframe><div id="overlay"></div>';
    const frame = document.querySelector('iframe')!;
    Object.defineProperty(frame, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get() { return 100; } });
    const { button } = addFrameButton(frame, 'Follow');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.getElementById('overlay') });

    expect(actionabilityPoint(document, button)).toEqual({ ok: false, reason: 'covered' });
  });

  it('maps a same-origin target through nested frame viewports', () => {
    document.body.innerHTML = '<iframe></iframe>';
    const outer = document.querySelector('iframe')!;
    Object.defineProperty(outer, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
    Object.defineProperty(outer, 'clientWidth', { configurable: true, get() { return 100; } });
    Object.defineProperty(outer, 'clientHeight', { configurable: true, get() { return 100; } });
    Object.defineProperty(outer, 'offsetHeight', { configurable: true, get() { return 100; } });
    const outerDocument = outer.contentDocument!;
    Object.defineProperty(outerDocument.defaultView!, 'frameElement', { configurable: true, value: outer });
    const inner = outerDocument.createElement('iframe');
    outerDocument.body.append(inner);
    Object.defineProperty(inner, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100, toJSON: () => ({}),
    }) });
    Object.defineProperty(inner, 'offsetWidth', { configurable: true, get() { return 100; } });
    Object.defineProperty(inner, 'offsetHeight', { configurable: true, get() { return 100; } });
    const { button } = addFrameButton(inner, 'Nested');
    Object.defineProperty(outerDocument, 'elementFromPoint', { configurable: true, value: () => inner });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => outer });

    expect(actionabilityPoint(document, button)).toMatchObject({ ok: true, x: 55, y: 50 });
  });

  it('accounts for iframe border offsets while mapping coordinates', () => {
    document.body.innerHTML = '<iframe></iframe>';
    const frame = document.querySelector('iframe')!;
    Object.defineProperty(frame, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get() { return 100; } });
    Object.defineProperty(frame, 'clientLeft', { configurable: true, get() { return 2; } });
    Object.defineProperty(frame, 'clientTop', { configurable: true, get() { return 3; } });
    const { button } = addFrameButton(frame, 'Bordered');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => frame });

    expect(actionabilityPoint(document, button)).toMatchObject({ ok: true, x: 47, y: 43 });
  });

  it('rejects a target when its containing iframe has left the live document', () => {
    document.body.innerHTML = '<iframe></iframe>';
    const frame = document.querySelector('iframe')!;
    Object.defineProperty(frame, 'getBoundingClientRect', { configurable: true, value: () => frameBounds });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get() { return 100; } });
    const { button } = addFrameButton(frame, 'Detached');
    frame.remove();

    expect(actionabilityPoint(document, button)).toEqual({ ok: false, reason: 'unsupported-frame' });
  });
});
