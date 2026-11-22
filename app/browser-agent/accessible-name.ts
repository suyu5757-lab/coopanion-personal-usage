/// <reference lib="dom" />

const ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox',
  'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion',
  'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'sectionhead', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
  'window',
]);

const AUTHOR_NAME_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'cell', 'checkbox', 'columnheader',
  'combobox', 'complementary', 'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed', 'figure', 'form',
  'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math',
  'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'note', 'option',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'sectionhead', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
  'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem', 'window',
]);

const CONTENT_NAME_ROLES = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'sectionhead', 'switch', 'tab', 'tooltip', 'treeitem',
]);

const PROHIBITED_NAME_ROLES = new Set([
  'caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'paragraph', 'presentation', 'strong', 'subscript',
  'superscript',
]);

const PRESENTATION_CONFLICT_ATTRIBUTES = [
  'aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-description', 'aria-details',
  'aria-disabled', 'aria-dropeffect', 'aria-errormessage', 'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden',
  'aria-invalid', 'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant',
  'aria-roledescription',
];

const normalized = (value: string): string => value.replace(/[\s\u00a0]+/g, ' ').trim();
const tag = (element: Element): string => element.localName.toLowerCase();

function composedParent(element: HTMLElement): HTMLElement | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  if (root.nodeType === 11 && 'host' in root && (root as ShadowRoot).host.nodeType === 1) return (root as ShadowRoot).host as HTMLElement;
  if (root.nodeType === 9) {
    const frame = (root as Document).defaultView?.frameElement;
    return frame?.nodeType === 1 ? frame as HTMLElement : null;
  }
  return null;
}

function hasNamedSource(element: HTMLElement): boolean {
  return !!(element.getAttribute('aria-label')?.trim()
    || element.getAttribute('aria-labelledby')?.trim()
    || element.getAttribute('title')?.trim());
}

function nativeRole(element: HTMLElement): string {
  const name = tag(element);
  if (name === 'a' || name === 'area') return element.hasAttribute('href') ? 'link' : 'generic';
  if (name === 'button' || name === 'summary') return 'button';
  if (name === 'textarea') return 'textbox';
  if (name === 'select') {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
  }
  if (name === 'option') return 'option';
  if (name === 'optgroup') return 'group';
  if (name === 'article') return 'article';
  if (name === 'aside') return 'complementary';
  if (name === 'main') return 'main';
  if (name === 'nav') return 'navigation';
  if (name === 'header' || name === 'footer') {
    for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
      if (['article', 'aside', 'main', 'nav', 'section'].includes(tag(parent))) return 'generic';
    }
    return name === 'header' ? 'banner' : 'contentinfo';
  }
  if (name === 'section') return hasNamedSource(element) ? 'region' : 'generic';
  if (name === 'form') return hasNamedSource(element) ? 'form' : 'generic';
  if (/^h[1-6]$/.test(name)) return 'heading';
  if (name === 'img') return element.getAttribute('alt') === '' ? 'presentation' : 'img';
  if (name === 'input') {
    const type = (element as HTMLInputElement).type.toLowerCase();
    if (type === 'hidden') return 'generic';
    if (['button', 'image', 'reset', 'submit'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    return 'textbox';
  }
  if (name === 'ul' || name === 'ol' || name === 'menu' || name === 'dl') return 'list';
  if (name === 'li') return 'listitem';
  if (name === 'table') return 'table';
  if (name === 'caption') return 'caption';
  if (name === 'thead' || name === 'tbody' || name === 'tfoot') return 'rowgroup';
  if (name === 'tr') return 'row';
  if (name === 'td') return 'cell';
  if (name === 'th') return (element as HTMLTableCellElement).scope === 'row' || (element as HTMLTableCellElement).scope === 'rowgroup' ? 'rowheader' : 'columnheader';
  if (name === 'progress') return 'progressbar';
  if (name === 'meter') return 'meter';
  if (name === 'output') return 'status';
  if (name === 'hr') return 'separator';
  if (name === 'dialog') return 'dialog';
  if (name === 'fieldset' || name === 'details') return 'group';
  if (name === 'figure') return 'figure';
  if (name === 'blockquote') return 'blockquote';
  if (name === 'dt') return 'term';
  if (name === 'dd') return 'definition';
  if (name === 'time') return 'time';
  if (name === 'p') return 'paragraph';
  if (name === 'code') return 'code';
  if (name === 'del' || name === 's') return 'deletion';
  if (name === 'ins') return 'insertion';
  if (name === 'em' || name === 'i') return 'emphasis';
  if (name === 'strong' || name === 'b') return 'strong';
  if (name === 'sub') return 'subscript';
  if (name === 'sup') return 'superscript';
  return 'generic';
}

function focusable(element: HTMLElement): boolean {
  return element.tabIndex >= 0 || element.isContentEditable || element.matches(
    'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, object, embed'
  );
}

/** Returns the first recognized explicit role, or the host-language role. */
export function accessibleRole(element: HTMLElement): string {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/).map((role) => role.toLowerCase()).find((role) => ARIA_ROLES.has(role));
  if (!explicit) return nativeRole(element);
  if (explicit === 'none' || explicit === 'presentation') {
    const hasGlobalState = PRESENTATION_CONFLICT_ATTRIBUTES.some((attribute) => element.hasAttribute(attribute));
    if (focusable(element) || hasGlobalState) return nativeRole(element);
    return 'presentation';
  }
  return explicit;
}

function hidden(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (element.hidden || element.inert || element.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true;
  if (style && (style.visibility === 'hidden' || style.visibility === 'collapse')) return true;
  for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
    const parentStyle = parent.ownerDocument.defaultView?.getComputedStyle(parent);
    if (parent.hidden || parent.inert || parent.getAttribute('aria-hidden')?.toLowerCase() === 'true'
      || parentStyle?.display === 'none' || parentStyle?.contentVisibility === 'hidden') return true;
  }
  return !!(style && (style.display === 'none' || style.contentVisibility === 'hidden'));
}

function getIdRef(element: HTMLElement, id: string): HTMLElement | null {
  const root = element.getRootNode();
  if (root.nodeType === 9) return (root as Document).getElementById(id);
  if (root.nodeType === 11 && 'host' in root) {
    const shadow = root as ShadowRoot & { getElementById?: (value: string) => HTMLElement | null };
    if (shadow.getElementById) return shadow.getElementById(id);
    return Array.from(shadow.querySelectorAll<HTMLElement>('[id]')).find((candidate) => candidate.id === id) ?? null;
  }
  return null;
}

function renderedChildren(element: HTMLElement): Node[] {
  if (element.shadowRoot) return Array.from(element.shadowRoot.childNodes);
  if (tag(element) === 'slot') {
    const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
    if (assigned.length) return assigned;
  }
  return Array.from(element.childNodes);
}

function pseudoContent(element: HTMLElement, pseudo: '::before' | '::after' | '::marker'): string {
  try {
    const value = element.ownerDocument.defaultView?.getComputedStyle(element, pseudo).content ?? '';
    if (!value || value === 'none' || value === 'normal') return '';
    const strings = [...value.matchAll(/(["'])(.*?)\1/g)].map((match) => match[2] ?? '');
    return strings.join('');
  } catch {
    return '';
  }
}

function embeddedControlValue(element: HTMLElement): string | null {
  const role = accessibleRole(element);
  if (role === 'textbox') {
    if (tag(element) === 'input' || tag(element) === 'textarea') return (element as HTMLInputElement | HTMLTextAreaElement).value;
    if (element.isContentEditable) return element.innerText || element.textContent || '';
  }
  if (role === 'combobox' || role === 'listbox') {
    if (tag(element) === 'select') {
      return Array.from((element as HTMLSelectElement).selectedOptions).map((option) => accessibleName(option, { referenced: true, inheritedContent: true })).filter(Boolean).join(' ');
    }
    const value = element.getAttribute('aria-valuetext');
    if (value) return value;
  }
  if (['range', 'slider', 'spinbutton', 'scrollbar', 'progressbar', 'meter'].includes(role)) {
    return element.getAttribute('aria-valuetext') || element.getAttribute('aria-valuenow')
      || ((tag(element) === 'input' ? (element as HTMLInputElement).value : '') || null);
  }
  return null;
}

function nativeAlternative(element: HTMLElement, context: NameContext, depth: number): string | null {
  const name = tag(element);
  const labels = (element as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  if (labels?.length) {
    return Array.from(labels).map((label) => computeName(label, {
      ...context,
      referenced: true,
      inheritedContent: true,
      allowHidden: hidden(label),
      excludedControl: element,
    }, depth + 1)).filter(Boolean).join(' ');
  }
  if (name === 'input') {
    const input = element as HTMLInputElement;
    if (['button', 'submit', 'reset'].includes(input.type) && input.value) return input.value;
    if (input.type === 'image' && input.hasAttribute('alt') && input.alt.trim()) return input.alt;
    if (['text', 'password', 'number', 'search', 'tel', 'email', 'url'].includes(input.type)) {
      const title = normalized(input.getAttribute('title') ?? '');
      if (title) return title;
      const placeholder = normalized(input.getAttribute('placeholder') ?? '')
        || normalized(input.getAttribute('aria-placeholder') ?? '');
      if (placeholder) return placeholder;
    }
  }
  if (name === 'textarea') {
    const title = normalized(element.getAttribute('title') ?? '');
    if (title) return title;
    const placeholder = normalized(element.getAttribute('placeholder') ?? '')
      || normalized(element.getAttribute('aria-placeholder') ?? '');
    if (placeholder) return placeholder;
  }
  if (name === 'img') {
    if (element.hasAttribute('alt')) return element.getAttribute('alt') ?? '';
    if (!element.hasAttribute('title')) {
      const figure = element.closest('figure') as HTMLElement | null;
      const caption = figure && Array.from(figure.children).find((child) => tag(child) === 'figcaption') as HTMLElement | undefined;
      const directContent = figure && Array.from(figure.childNodes).every((node) =>
        node.nodeType === 3 ? !(node.textContent ?? '').trim() : node === element || node === caption);
      if (caption && directContent) {
        return computeName(caption, { ...context, referenced: true, inheritedContent: true, allowHidden: hidden(caption) }, depth + 1);
      }
    }
  }
  if (name === 'area' && element.hasAttribute('alt')) {
    return element.getAttribute('alt') ?? '';
  }
  if (name === 'table') {
    const caption = Array.from(element.children).find((child) => tag(child) === 'caption') as HTMLElement | undefined;
    if (caption) return computeName(caption, { ...context, referenced: true, inheritedContent: true, allowHidden: hidden(caption) }, depth + 1);
  }
  if (name === 'fieldset') {
    const legend = Array.from(element.children).find((child) => tag(child) === 'legend') as HTMLElement | undefined;
    if (legend) return computeName(legend, { ...context, referenced: true, inheritedContent: true, allowHidden: hidden(legend) }, depth + 1);
  }
  if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
    const title = Array.from(element.children).find((child) => tag(child) === 'title') as HTMLElement | undefined;
    if (title) return computeName(title, { ...context, referenced: true, inheritedContent: true, allowHidden: hidden(title) }, depth + 1);
  }
  return null;
}

interface NameContext {
  readonly labelledByPath: Set<HTMLElement>;
  readonly referenced: boolean;
  readonly inheritedContent: boolean;
  readonly allowHidden: boolean;
  readonly excludedControl?: HTMLElement;
}

const defaultContext = (): NameContext => ({ labelledByPath: new Set(), referenced: false, inheritedContent: false, allowHidden: false });

function computeName(element: HTMLElement, context: NameContext, depth: number): string {
  if (context.excludedControl === element) return '';
  if (depth > 64 || (hidden(element) && !context.allowHidden)) return '';
  const role = accessibleRole(element);

  if (context.referenced) {
    const embedded = embeddedControlValue(element);
    if (embedded !== null) return normalized(embedded);
  }

  const allowsAuthor = AUTHOR_NAME_ROLES.has(role);
  const labelledBy = allowsAuthor
    ? (element.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean)
    : [];
  if (labelledBy.length && !context.labelledByPath.has(element)) {
    const refs = labelledBy.map((id) => getIdRef(element, id)).filter((ref): ref is HTMLElement => !!ref);
    if (refs.length) {
      const path = new Set(context.labelledByPath);
      path.add(element);
      const result = normalized(refs.map((ref) => computeName(ref, {
        labelledByPath: path,
        referenced: true,
        inheritedContent: true,
        allowHidden: hidden(ref),
      }, depth + 1)).filter(Boolean).join(' '));
      if (result) return result;
    }
  }

  if (allowsAuthor) {
    const ariaLabel = normalized(element.getAttribute('aria-label') ?? '');
    if (ariaLabel) return ariaLabel;
  }

  const hostAlternative = nativeAlternative(element, context, depth);
  if (hostAlternative !== null && normalized(hostAlternative)) return normalized(hostAlternative);

  if (context.inheritedContent || context.referenced || CONTENT_NAME_ROLES.has(role)) {
    const before = pseudoContent(element, '::before');
    const marker = pseudoContent(element, '::marker');
    const after = pseudoContent(element, '::after');
    const children = renderedChildren(element).map((child) => {
      if (child.nodeType === 3) {
        const parent = child.parentElement;
        return parent && hidden(parent) && !context.allowHidden ? '' : child.textContent ?? '';
      }
      return child.nodeType === 1
        ? computeName(child as HTMLElement, { ...context, inheritedContent: true }, depth + 1)
        : '';
    });
    const content = [marker, before, ...children, after].filter(Boolean).join(' ');
    if (normalized(content)) return normalized(content);
  }

  return normalized(element.getAttribute('title') ?? '');
}

/** Computes the locator-facing accessible name for HTML/ARIA markup in the current document tree. */
export function accessibleName(element: HTMLElement, overrides?: Partial<Pick<NameContext, 'referenced' | 'inheritedContent' | 'allowHidden'>>): string {
  const role = accessibleRole(element);
  if (PROHIBITED_NAME_ROLES.has(role) && !overrides?.referenced && tag(element) !== 'iframe') return '';
  return computeName(element, { ...defaultContext(), ...overrides }, 0);
}

/** Composed-tree traversal for open shadow roots and assigned slot contents. */
export function* composedElements(root: Document | ShadowRoot | HTMLElement): Generator<HTMLElement> {
  const seen = new Set<HTMLElement>();
  const descend = function* (element: HTMLElement): Generator<HTMLElement> {
    if (element.shadowRoot) {
      yield* walk(element.shadowRoot);
      return;
    }
    if (tag(element) === 'slot') {
      const assigned = (element as HTMLSlotElement).assignedElements({ flatten: true });
      if (assigned.length) {
        for (const node of assigned) {
          const assignedElement = node as HTMLElement;
          if (seen.has(assignedElement)) continue;
          seen.add(assignedElement);
          yield assignedElement;
          yield* descend(assignedElement);
        }
        return;
      }
    }
    if (tag(element) === 'iframe') {
      try {
        const childDocument = (element as HTMLIFrameElement).contentDocument;
        if (childDocument?.documentElement) yield* walk(childDocument);
      } catch {
        // Cross-origin frame contents remain outside the injected DOM agent's access.
      }
      return;
    }
    yield* walk(element);
  };
  const walk = function* (node: Document | ShadowRoot | HTMLElement): Generator<HTMLElement> {
    const children = 'children' in node ? Array.from(node.children) : [];
    for (const child of children) {
      const element = child as HTMLElement;
      if (seen.has(element)) continue;
      seen.add(element);
      yield element;
      yield* descend(element);
    }
  };
  yield* walk(root);
}

/** Text nodes in the open composed tree, including same-origin iframe documents. */
export function* composedTextNodes(root: Document | ShadowRoot | HTMLElement): Generator<Text> {
  const seen = new Set<Node>();
  const childrenOf = (element: HTMLElement): Node[] => {
    if (element.shadowRoot) return Array.from(element.shadowRoot.childNodes);
    if (tag(element) === 'slot') {
      const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) return Array.from(assigned);
    }
    if (tag(element) === 'iframe') {
      try {
        const childDocument = (element as HTMLIFrameElement).contentDocument;
        if (childDocument?.documentElement) return [childDocument.documentElement];
      } catch {
        return [];
      }
    }
    return Array.from(element.childNodes);
  };
  const walk = function* (node: Node): Generator<Text> {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.nodeType === 3) {
      yield node as Text;
      return;
    }
    if (node.nodeType === 1) {
      for (const child of childrenOf(node as HTMLElement)) yield* walk(child);
      return;
    }
    if (node.nodeType === 9 || node.nodeType === 11) {
      for (const child of Array.from(node.childNodes)) yield* walk(child);
    }
  };
  yield* walk(root);
}

export function composedParentElement(element: HTMLElement): HTMLElement | null {
  return composedParent(element);
}

export function composedContains(ancestor: HTMLElement, element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = composedParent(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

export function deepestElementFromPoint(doc: Document, x: number, y: number): HTMLElement | null {
  let element = doc.elementFromPoint(x, y) as HTMLElement | null;
  const visited = new Set<HTMLElement>();
  while (element?.shadowRoot && !visited.has(element)) {
    visited.add(element);
    const root = element.shadowRoot as ShadowRoot & { elementFromPoint?: (x: number, y: number) => Element | null };
    const inner = root.elementFromPoint?.(x, y) as HTMLElement | null;
    if (!inner) break;
    element = inner;
  }
  return element;
}
