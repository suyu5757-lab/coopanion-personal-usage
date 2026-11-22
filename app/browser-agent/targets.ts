/// <reference lib="dom" />
import { accessibleName, accessibleRole, composedContains, composedElements, composedParentElement, composedTextNodes, deepestElementFromPoint } from './accessible-name.ts';
/** Resolves text clicks only when the page exposes one visible target. */
export type TextTarget =
  | { ok: true; element: HTMLElement }
  | { ok: false; reason: 'none' | 'ambiguous' | 'file' };

const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
const normalizedName = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Reads the element's current accessible name before any cached controller label. */
export function currentElementLabel(element: HTMLElement): string {
  const inputValue = element.localName.toLowerCase() === 'input' ? (element as HTMLInputElement).value : '';
  return [
    accessibleName(element),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('placeholder'),
    inputValue,
    element.innerText,
    element.textContent,
    element.getAttribute('alt'),
    element.getAttribute('name'),
  ].find((value) => typeof value === 'string' && value.trim())?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '';
}

const visible = (element: HTMLElement): boolean =>
  !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

const fileInput = (element: Element | null | undefined): element is HTMLInputElement =>
  !!element && element.tagName.toLowerCase() === 'input' && element.getAttribute('type')?.toLowerCase() === 'file';

const semanticClickTarget = (element: HTMLElement): boolean =>
  element.matches('a[href], area[href], button, summary, input, select, textarea, label, [role="button"], [role="link"], [onclick], [tabindex]');

const clickable = (element: HTMLElement): boolean =>
  semanticClickTarget(element) || element.ownerDocument.defaultView?.getComputedStyle(element).cursor === 'pointer';

export type ActionabilityFailure =
  | 'detached'
  | 'hidden'
  | 'disabled'
  | 'not-interactive'
  | 'offscreen'
  | 'covered'
  | 'dom-changed'
  | 'wait-timeout'
  | 'unsupported-frame';

export type ActionPoint = {
  ok: true;
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type FrameHop = { readonly frame: HTMLElement; readonly parentDocument: Document };

/** Returns a same-origin frame chain from a document up to the Browser Agent's document. */
function frameChain(document: Document, targetDocument: Document): FrameHop[] | null {
  const chain: FrameHop[] = [];
  const visited = new Set<Document>();
  let current = targetDocument;
  while (current !== document) {
    if (visited.has(current) || chain.length >= 8) return null;
    visited.add(current);
    const frame = current.defaultView?.frameElement as HTMLIFrameElement | null;
    if (!frame || !frame.isConnected || frame.localName.toLowerCase() !== 'iframe' || frame.contentDocument !== current) return null;
    const parentDocument = frame.ownerDocument;
    if (parentDocument === current) return null;
    chain.push({ frame, parentDocument });
    current = parentDocument;
  }
  return chain;
}

export interface TargetLocator {
  role?: string;
  name?: string;
  testId?: string;
  within?: {
    role?: string;
    name?: string;
    testId?: string;
  };
}

export type LocatorResult = { ok: true; element: HTMLElement } | { ok: false; reason: 'invalid' | 'none' | 'ambiguous' };
export type PointTargetResult = { ok: true; element: HTMLElement } | { ok: false; reason: ActionabilityFailure | 'invalid' | 'none' | 'file' };

const matchesLocator = (element: HTMLElement, locator: TargetLocator): boolean => {
  if (locator.role !== undefined && accessibleRole(element) !== locator.role.trim().toLowerCase()) return false;
  if (locator.name !== undefined && accessibleName(element) !== normalizedName(locator.name)) return false;
  if (locator.testId !== undefined && element.getAttribute('data-e2e') !== locator.testId) return false;
  return true;
};

/** Resolves exact semantic fields and an optional unique ancestor scope; it never picks the first match. */
export function findLocatorTarget(doc: Document, locator: TargetLocator): LocatorResult {
  const validSelector = (value: unknown, allowWithin: boolean): value is TargetLocator => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const allowed = allowWithin ? ['role', 'name', 'testId', 'within'] : ['role', 'name', 'testId'];
    if (Object.keys(record).some((key) => !allowed.includes(key))) return false;
    const fields = [record.role, record.name, record.testId];
    if (fields.some((field) => field !== undefined && (typeof field !== 'string' || !field.trim()))) return false;
    if (!fields.some((field) => typeof field === 'string' && !!field.trim())) return false;
    if (allowWithin && record.within !== undefined && !validSelector(record.within, false)) return false;
    return true;
  };
  if (!validSelector(locator, true)) return { ok: false, reason: 'invalid' };

  const elements = Array.from(composedElements(doc));
  const scopes = locator.within
    ? elements.filter((element) => element.matches('article, li, nav, main, [role], [data-e2e]'))
      .filter((element) => visible(element) && matchesLocator(element, locator.within!))
    : [];
  if (locator.within && !scopes.length) return { ok: false, reason: 'none' };
  if (scopes.length > 1) return { ok: false, reason: 'ambiguous' };

  const scope = scopes[0];
  const candidates = elements.filter((element) => element.matches(
    'a[href], area[href], button, summary, input, select, textarea, [role], [onclick], [tabindex], [data-e2e]'
  )).filter((element) => {
    if (!visible(element) || !matchesLocator(element, locator)) return false;
    if (scope && (!composedContains(scope, element) || scope === element)) return false;
    return isFileChooserTarget(element) ? false : clickable(element);
  });
  if (!candidates.length) return { ok: false, reason: 'none' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, element: candidates[0]! };
}

/** Returns a DOM target's current, unobscured viewport point without scrolling or dispatching events. */
export function actionabilityPoint(doc: Document, element: HTMLElement): ActionPoint | { ok: false; reason: ActionabilityFailure } {
  if (!element.isConnected) return { ok: false, reason: 'detached' };
  const elementDocument = element.ownerDocument;
  const frames = frameChain(doc, elementDocument);
  if (!frames) return { ok: false, reason: 'unsupported-frame' };
  if (!clickable(element)) return { ok: false, reason: 'not-interactive' };

  const view = elementDocument.defaultView;
  const topView = doc.defaultView;
  if (!view || !topView) return { ok: false, reason: 'hidden' };
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = composedParentElement(ancestor)) {
    if (ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') {
      return { ok: false, reason: 'hidden' };
    }
    if (ancestor.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
    const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') {
      return { ok: false, reason: 'hidden' };
    }
  }

  const style = view.getComputedStyle(element);
  if (style.pointerEvents === 'none') return { ok: false, reason: 'not-interactive' };
  if (element.matches(':disabled')) {
    return { ok: false, reason: 'disabled' };
  }

  const rect = element.getBoundingClientRect();
  const width = view.innerWidth || elementDocument.documentElement.clientWidth;
  const height = view.innerHeight || elementDocument.documentElement.clientHeight;
  if (!visible(element) || rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'hidden' };
  if (rect.left < 0 || rect.top < 0 || rect.right > width || rect.bottom > height) {
    return { ok: false, reason: 'offscreen' };
  }

  const localX = rect.left + rect.width / 2;
  const localY = rect.top + rect.height / 2;
  const localHit = deepestElementFromPoint(elementDocument, localX, localY);
  if (!localHit || !(localHit === element || composedContains(element, localHit))) return { ok: false, reason: 'covered' };

  let x = localX, y = localY, left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
  for (const { frame, parentDocument } of frames) {
    const frameRect = frame.getBoundingClientRect();
    for (let ancestor: HTMLElement | null = frame; ancestor; ancestor = composedParentElement(ancestor)) {
      const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
      const zoom = style?.getPropertyValue('zoom') ?? '';
      if (style?.transform && style.transform !== 'none' || zoom && zoom !== '1' && zoom !== 'normal') {
        return { ok: false, reason: 'unsupported-frame' };
      }
    }
    const scaleX = frame.offsetWidth > 0 ? frameRect.width / frame.offsetWidth : 0;
    const scaleY = frame.offsetHeight > 0 ? frameRect.height / frame.offsetHeight : 0;
    if (!visible(frame) || frame.clientWidth <= 0 || frame.clientHeight <= 0
      || Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
      return { ok: false, reason: 'unsupported-frame' };
    }
    const offsetX = frameRect.left + frame.clientLeft;
    const offsetY = frameRect.top + frame.clientTop;
    x += offsetX;
    y += offsetY;
    left += offsetX;
    right += offsetX;
    top += offsetY;
    bottom += offsetY;
    const parentView = parentDocument.defaultView;
    if (!parentView || x < 0 || y < 0 || x > parentView.innerWidth || y > parentView.innerHeight) {
      return { ok: false, reason: 'offscreen' };
    }
    const frameHit = deepestElementFromPoint(parentDocument, x, y);
    if (!frameHit || !(frameHit === frame || composedContains(frame, frameHit))) return { ok: false, reason: 'covered' };
  }

  if (x < 0 || y < 0 || x > topView.innerWidth || y > topView.innerHeight) return { ok: false, reason: 'offscreen' };
  if (!frames.length) {
    const hit = deepestElementFromPoint(doc, x, y);
    if (!hit || !(hit === element || composedContains(element, hit))) return { ok: false, reason: 'covered' };
  }
  return { ok: true, x, y, left, top, right, bottom };
}

/** Resolves the rendered target under one screenshot coordinate without selecting a nearby element. */
export function findPointTarget(doc: Document, x: number, y: number): PointTargetResult {
  const view = doc.defaultView;
  if (!view || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'invalid' };
  if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return { ok: false, reason: 'offscreen' };

  const hit = deepestElementFromPoint(doc, x, y);
  if (!hit) return { ok: false, reason: 'none' };
  let target: HTMLElement | null = hit;
  for (let depth = 0; target && depth < 8; depth++, target = composedParentElement(target)) {
    const isCanvas = target.localName.toLowerCase() === 'canvas';
    if (!clickable(target) && !isCanvas) continue;
    if (isFileChooserTarget(target)) return { ok: false, reason: 'file' };
    if (target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
    if (!visible(target) || hiddenByComposedAncestor(target)) return { ok: false, reason: 'hidden' };
    const style = target.ownerDocument.defaultView?.getComputedStyle(target);
    if (!style || style.pointerEvents === 'none') return { ok: false, reason: 'not-interactive' };
    const rect = target.getBoundingClientRect();
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return { ok: false, reason: 'offscreen' };
    const currentHit = deepestElementFromPoint(doc, x, y);
    if (!currentHit || !(currentHit === target || composedContains(target, currentHit))) return { ok: false, reason: 'covered' };
    return { ok: true, element: target };
  }
  return { ok: false, reason: 'not-interactive' };
}

function hiddenByComposedAncestor(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = composedParentElement(current)) {
    if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return true;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || style.contentVisibility === 'hidden') return true;
  }
  return false;
}

/** Direct file inputs and their associated labels or upload buttons. */
export function isFileChooserTarget(element: HTMLElement): boolean {
  if (fileInput(element)) return true;
  if (element.tagName.toLowerCase() === 'label') {
    const label = element as HTMLLabelElement;
    const associated = label.control ?? (label.htmlFor ? element.ownerDocument.getElementById(label.htmlFor) : null);
    if (fileInput(associated) || !!element.querySelector('input[type="file"]')) return true;
  }
  return clickable(element) && !!element.querySelector('input[type="file"]');
}

function targetForTextNode(doc: Document, node: Text, query: string, exact: boolean): HTMLElement | null {
  const root = node.getRootNode();
  let element = node.parentElement
    ?? (root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host as HTMLElement : null);
  let nearestText: HTMLElement | null = null;
  let pointerTarget: HTMLElement | null = null;
  for (let depth = 0; element && depth < 8 && !(element.ownerDocument === doc && element === doc.body); depth++, element = composedParentElement(element)) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') return null;
    if (!visible(element)) continue;
    const text = normalized(element.innerText || element.textContent || '');
    if (exact ? text === query : text.includes(query)) nearestText ??= element;
    if (semanticClickTarget(element)) return element;
    if (!pointerTarget && element.ownerDocument.defaultView?.getComputedStyle(element).cursor === 'pointer') pointerTarget = element;
  }
  return pointerTarget ?? nearestText;
}

/** Exact text wins over partial matches; independent matching controls are always ambiguous. */
export function findTextTarget(doc: Document, rawQuery: string): TextTarget {
  const query = normalized(rawQuery);
  if (!query) return { ok: false, reason: 'none' };

  const collect = (exact: boolean): Set<HTMLElement> => {
    const targets = new Set<HTMLElement>();
    for (const node of composedTextNodes(doc)) {
      const value = normalized(node.textContent || '');
      if (!value || !(exact ? value === query : value.includes(query))) continue;
      const target = targetForTextNode(doc, node, query, exact);
      if (target) targets.add(target);
    }
    return targets;
  };

  const exact = collect(true);
  const targets = exact.size ? exact : collect(false);
  if (!targets.size) return { ok: false, reason: 'none' };
  if (targets.size !== 1) return { ok: false, reason: 'ambiguous' };
  const element = targets.values().next().value as HTMLElement;
  return isFileChooserTarget(element) ? { ok: false, reason: 'file' } : { ok: true, element };
}
