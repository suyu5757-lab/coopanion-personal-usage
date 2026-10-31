/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { accessibleName, accessibleRole, composedTextNodes } from '../app/browser-agent/accessible-name.ts';
import { actionabilityPoint, findLocatorTarget, findTextTarget } from '../app/browser-agent/targets.ts';

const laidOut = (): void => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
};

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
const AUTHOR_NAME_ROLES = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'cell', 'checkbox', 'columnheader',
  'combobox', 'complementary', 'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed', 'figure', 'form',
  'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math',
  'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'note', 'option',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'sectionhead', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
  'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem', 'window',
];
const CONTENT_NAME_ROLES = [
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'sectionhead', 'switch', 'tab', 'tooltip', 'treeitem',
];
const PROHIBITED_NAME_ROLES = [
  'caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'paragraph', 'presentation', 'strong', 'subscript',
  'superscript',
];
beforeEach(() => {
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
    pseudo ? { content: 'none' } as CSSStyleDeclaration : nativeGetComputedStyle(element) });
  laidOut();
  document.body.innerHTML = '';
});

describe('accessible name computation', () => {
  it('matches the WAI-ARIA 1.2 role name-source sets', () => {
    for (const role of AUTHOR_NAME_ROLES) {
      const element = document.createElement('div');
      element.setAttribute('role', role);
      element.setAttribute('aria-label', 'Author');
      element.textContent = 'Contents';
      document.body.append(element);
      expect(accessibleName(element), `name-from-author: ${role}`).toBe('Author');
    }
    for (const role of CONTENT_NAME_ROLES) {
      const element = document.createElement('div');
      element.setAttribute('role', role);
      element.textContent = 'Contents';
      document.body.append(element);
      expect(accessibleName(element), `name-from-content: ${role}`).toBe('Contents');
    }
    for (const role of PROHIBITED_NAME_ROLES) {
      const element = document.createElement('div');
      element.setAttribute('role', role);
      element.setAttribute('aria-label', 'Must be ignored');
      element.setAttribute('title', 'Must also be ignored');
      element.textContent = 'Must remain unnamed';
      document.body.append(element);
      expect(accessibleName(element), `name-prohibited: ${role}`).toBe('');
    }
  });

  it('uses ordered aria-labelledby references before aria-label', () => {
    document.body.innerHTML = '<span id="verb">Save</span><span id="item">draft</span><button aria-label="Save only" aria-labelledby="verb item"></button>';
    expect(accessibleName(document.querySelector('button')!)).toBe('Save draft');
  });

  it('includes a hidden subtree when aria-labelledby directly references it', () => {
    document.body.innerHTML = '<span id="hidden" style="display:none">Hidden command</span><button aria-labelledby="hidden"></button>';
    expect(accessibleName(document.querySelector('button')!)).toBe('Hidden command');
  });

  it('still excludes hidden descendants inside a visible labelled subtree', () => {
    document.body.innerHTML = '<span id="label">Visible <b style="display:none">secret</b> command</span><button aria-labelledby="label"></button>';
    expect(accessibleName(document.querySelector('button')!)).toBe('Visible command');
  });

  it('omits unrelated hidden descendants from a content name', () => {
    document.body.innerHTML = '<button><span style="display:none">Hidden command</span>Visible command</button>';
    expect(accessibleName(document.querySelector('button')!)).toBe('Visible command');
  });

  it('breaks self-references and cycles while retaining fallback author text', () => {
    document.body.innerHTML = '<button id="target" aria-labelledby="label"><span id="label" aria-labelledby="target">Run</span></button>';
    expect(accessibleName(document.querySelector('button')!)).toBe('Run');
  });

  it('falls through missing or empty author labels to native and content names', () => {
    document.body.innerHTML = '<label for="search">Search terms</label><input id="search" type="search" aria-labelledby="missing" aria-label=""> <button title="Save draft"></button>';
    const input = document.querySelector('input')!;
    const button = document.querySelector('button')!;
    expect(accessibleName(input)).toBe('Search terms');
    expect(accessibleName(button)).toBe('Save draft');
  });

  it('uses values of embedded controls inside a referenced label subtree', () => {
    document.body.innerHTML = '<div id="instruction">Repeat <input type="number" value="5"> times</div><button aria-labelledby="instruction"></button>';
    expect(accessibleName(document.querySelector('button')!)).toBe('Repeat 5 times');
  });

  it('uses a control label and host-language alternatives', () => {
    document.body.innerHTML = '<label for="search">Find a page</label><input id="search" type="search"><img alt="Profile photo"><button title="Close dialog"></button>';
    expect(accessibleName(document.querySelector('input')!)).toBe('Find a page');
    expect(accessibleName(document.querySelector('img')!)).toBe('Profile photo');
    expect(accessibleName(document.querySelector('button')!)).toBe('Close dialog');
  });

  it('includes literal generated content in a name-from-content role', () => {
    const native = window.getComputedStyle.bind(window);
    document.body.innerHTML = '<button>task</button>';
    const button = document.querySelector('button')!;
    Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
      element === button && pseudo === '::before' ? { content: '"Create "' } as CSSStyleDeclaration : native(element) });
    expect(accessibleName(button)).toBe('Create task');
  });

  it('uses native figure and table labels', () => {
    document.body.innerHTML = '<figure title="Monthly chart"><img alt=""><figcaption>Revenue by month</figcaption></figure><table><caption>Quarterly totals</caption><tbody><tr><th scope="row">Sales</th><td>20</td></tr></tbody></table>';
    expect(accessibleName(document.querySelector('figure')!)).toBe('Monthly chart');
    expect(accessibleName(document.querySelector('table')!)).toBe('Quarterly totals');
    expect(accessibleName(document.querySelector('th')!)).toBe('Sales');
  });

  it('uses iframe titles and the limited HTML-AAM img figure-caption fallback', () => {
    document.body.innerHTML = '<iframe title="Embedded report"></iframe>'
      + '<figure><img id="captioned"><figcaption>Chart of monthly sales</figcaption></figure>'
      + '<figure><img id="ambiguous"><figcaption>Chart details</figcaption><span>Additional content</span></figure>';
    expect(accessibleName(document.querySelector('iframe')!)).toBe('Embedded report');
    expect(accessibleName(document.querySelector('#captioned')!)).toBe('Chart of monthly sales');
    expect(accessibleName(document.querySelector('#ambiguous')!)).toBe('');
  });

  it('uses HTML-AAM label and placeholder fallbacks in their specified order', () => {
    document.body.innerHTML = '<label for="search">Find a page</label><input id="search" type="search" placeholder="Search pages">'
      + '<input id="unlabelled" type="text" title="Title first" placeholder="Placeholder second">'
      + '<input id="placeholder" type="text" placeholder="Search here">'
      + '<textarea id="comment" aria-placeholder="Write a comment"></textarea>'
      + '<label for="result">Result</label><output id="result">7</output>';
    expect(accessibleName(document.querySelector('#search')!)).toBe('Find a page');
    expect(accessibleName(document.querySelector('#unlabelled')!)).toBe('Title first');
    expect(accessibleName(document.querySelector('#placeholder')!)).toBe('Search here');
    expect(accessibleName(document.querySelector('#comment')!)).toBe('Write a comment');
    expect(accessibleName(document.querySelector('#result')!)).toBe('Result');
  });

  it('does not include the labeled control value in its wrapping label name', () => {
    document.body.innerHTML = '<label>Search <input type="search" value="private query"></label>';
    expect(accessibleName(document.querySelector('input')!)).toBe('Search');
  });

  it('recognizes explicit fallback tokens and common native roles', () => {
    document.body.innerHTML = '<button role="unrecognized button">Continue</button><select multiple><option>One</option></select><table><tr><th scope="row">Name</th></tr></table><summary>Details</summary>';
    const [button, select, header, summary] = Array.from(document.body.querySelectorAll<HTMLElement>('button,select,th,summary'));
    expect(accessibleRole(button!)).toBe('button');
    expect(accessibleRole(select!)).toBe('listbox');
    expect(accessibleRole(header!)).toBe('rowheader');
    expect(accessibleRole(summary!)).toBe('button');
  });

  it('skips abstract role tokens and uses the first concrete role token', () => {
    document.body.innerHTML = '<div role="command button" aria-label="Run"></div><div role="range slider" aria-label="Volume"></div>';
    const [button, slider] = Array.from(document.body.querySelectorAll<HTMLElement>('div'));
    expect(accessibleRole(button!)).toBe('button');
    expect(accessibleName(button!)).toBe('Run');
    expect(accessibleRole(slider!)).toBe('slider');
    expect(accessibleName(slider!)).toBe('Volume');
  });

  it('applies exact case-sensitive accessible-name matching', () => {
    document.body.innerHTML = '<button>Like</button>';
    expect(findLocatorTarget(document, { role: 'button', name: 'Like' }).ok).toBe(true);
    expect(findLocatorTarget(document, { role: 'button', name: 'like' })).toEqual({ ok: false, reason: 'none' });
  });

  it('refuses names on prohibited roles and restores native role for presentational focusable controls', () => {
    document.body.innerHTML = '<div role="generic" aria-label="Invisible name"></div><button role="none" aria-label="Run"></button>';
    const [generic, button] = Array.from(document.body.querySelectorAll<HTMLElement>('div,button'));
    expect(accessibleName(generic!)).toBe('');
    expect(accessibleRole(button!)).toBe('button');
    expect(accessibleName(button!)).toBe('Run');
  });

  it('computes names through an open shadow root and assigned slot content', () => {
    const host = document.createElement('x-control');
    host.innerHTML = '<span slot="label">Select</span>';
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button><slot name="label"></slot> file</button>';
    expect(accessibleName(shadow.querySelector('button')!)).toBe('Select file');
  });
});

describe('open shadow DOM locator and actionability', () => {
  it('resolves one indexed action target inside an open shadow tree and its composed scope', () => {
    document.body.innerHTML = '<article aria-label="Clip A"><x-toolbar></x-toolbar></article>';
    const host = document.querySelector('x-toolbar')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button aria-label="Follow"></button>';

    const found = findLocatorTarget(document, {
      role: 'button', name: 'Follow', within: { role: 'article', name: 'Clip A' },
    });
    expect(found.ok).toBe(true);
    expect(found.ok && found.element).toBe(shadow.querySelector('button'));
  });

  it('refuses a control hidden inside a closed shadow root', () => {
    document.body.innerHTML = '<x-control></x-control>';
    const closed = document.querySelector('x-control')!.attachShadow({ mode: 'closed' });
    closed.innerHTML = '<button aria-label="Secret"></button>';
    expect(findLocatorTarget(document, { role: 'button', name: 'Secret' })).toEqual({ ok: false, reason: 'none' });
  });

  it('finds text targets inside open shadow roots', () => {
    document.body.innerHTML = '<x-control></x-control>';
    const shadow = document.querySelector('x-control')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Run action</button>';
    const button = shadow.querySelector('button')!;

    expect(Array.from(composedTextNodes(document)).map((node) => node.textContent)).toContain('Run action');
    expect(findTextTarget(document, 'Run action')).toEqual({ ok: true, element: button });
  });

  it('uses the open shadow root hit test and composed ancestors before dispatch', () => {
    document.body.innerHTML = '<x-control></x-control>';
    const host = document.querySelector('x-control')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Run</button>';
    const button = shadow.querySelector('button')!;
    Object.defineProperty(button, 'getBoundingClientRect', { configurable: true, value: () => ({
      x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30, toJSON: () => ({}),
    }) });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => host });
    Object.defineProperty(shadow, 'elementFromPoint', { configurable: true, value: () => button });

    expect(actionabilityPoint(document, button)).toMatchObject({ ok: true, x: 70, y: 35 });
    host.setAttribute('aria-hidden', 'true');
    expect(actionabilityPoint(document, button)).toEqual({ ok: false, reason: 'hidden' });
  });
});
