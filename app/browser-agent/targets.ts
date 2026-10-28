/// <reference lib="dom" />
/** Resolves text clicks only when the page exposes one visible target. */
export type TextTarget =
  | { ok: true; element: HTMLElement }
  | { ok: false; reason: 'none' | 'ambiguous' | 'file' };

const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** Reads the element's current accessible name before any cached controller label. */
export function currentElementLabel(element: HTMLElement): string {
  const inputValue = element instanceof HTMLInputElement ? element.value : '';
  return [
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
  element.matches('a, button, input, select, textarea, label, [role="button"], [role="link"], [onclick], [tabindex]');

const clickable = (element: HTMLElement): boolean =>
  semanticClickTarget(element) || getComputedStyle(element).cursor === 'pointer';

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
  let element = node.parentElement;
  let nearestText: HTMLElement | null = null;
  let pointerTarget: HTMLElement | null = null;
  for (let depth = 0; element && depth < 8 && element !== doc.body; depth++, element = element.parentElement) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') return null;
    if (!visible(element)) continue;
    const text = normalized(element.innerText || element.textContent || '');
    if (exact ? text === query : text.includes(query)) nearestText ??= element;
    if (semanticClickTarget(element)) return element;
    if (!pointerTarget && getComputedStyle(element).cursor === 'pointer') pointerTarget = element;
  }
  return pointerTarget ?? nearestText;
}

/** Exact text wins over partial matches; independent matching controls are always ambiguous. */
export function findTextTarget(doc: Document, rawQuery: string): TextTarget {
  const query = normalized(rawQuery);
  if (!query) return { ok: false, reason: 'none' };

  const collect = (exact: boolean): Set<HTMLElement> => {
    const targets = new Set<HTMLElement>();
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = normalized(node.textContent || '');
      if (!value || !(exact ? value === query : value.includes(query))) continue;
      const target = targetForTextNode(doc, node as Text, query, exact);
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
