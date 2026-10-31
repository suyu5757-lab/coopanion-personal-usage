/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { installFileChooserGuard } from '../app/browser-agent/safety.ts';
import { actionabilityPoint, currentElementLabel, findLocatorTarget, findPointTarget, findTextTarget } from '../app/browser-agent/targets.ts';

const laidOut = (): void => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
};

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
beforeEach(() => {
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element, pseudo?: string) =>
    pseudo ? { content: 'none' } as CSSStyleDeclaration : nativeGetComputedStyle(element) });
  laidOut();
  document.body.innerHTML = '';
});

const rect = (element: HTMLElement, bounds = { left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30 }): void => {
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => ({ ...bounds, x: bounds.left, y: bounds.top, toJSON: () => bounds }) });
};

const hitTest = (target: Element | null): void => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
};

describe('text click target', () => {
  it('reads the current DOM name when a page reuses one button for a different action', () => {
    document.body.innerHTML = '<button>回复</button>';
    const button = document.querySelector('button')!;
    expect(currentElementLabel(button)).toBe('回复');
    button.textContent = '删除评论';
    expect(currentElementLabel(button)).toBe('删除评论');
  });

  it('resolves nested text to its one button', () => {
    document.body.innerHTML = '<button><span>发送</span></button>';
    const target = findTextTarget(document, '发送');
    expect(target.ok).toBe(true);
    expect(target.ok && target.element.tagName).toBe('BUTTON');
  });

  it('refuses repeated labels instead of choosing one by size', () => {
    document.body.innerHTML = '<button>收藏</button><button>收藏</button>';
    expect(findTextTarget(document, '收藏')).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('deduplicates text nodes inside the same button', () => {
    document.body.innerHTML = '<button><span>Share</span><span>Share</span></button>';
    const target = findTextTarget(document, 'Share');
    expect(target.ok).toBe(true);
    expect(target.ok && target.element.tagName).toBe('BUTTON');
  });

  it('refuses a file input and its label as a click target', () => {
    document.body.innerHTML = '<label for="upload">选择文件</label><input id="upload" type="file">';
    expect(findTextTarget(document, '选择文件')).toEqual({ ok: false, reason: 'file' });
  });
});

describe('DOM target actionability', () => {
  it('returns the center of a visible, enabled target that receives the hit test', () => {
    document.body.innerHTML = '<button>Continue</button>';
    const button = document.querySelector('button')!;
    rect(button);
    hitTest(button);

    expect(actionabilityPoint(document, button)).toMatchObject({ ok: true, x: 70, y: 35 });
  });

  it('refuses disabled and hidden targets before dispatch', () => {
    document.body.innerHTML = '<button disabled>Continue</button><div aria-disabled="true"><button id="inherited">Continue</button></div><button id="hidden">Continue</button>';
    const disabled = document.querySelector<HTMLButtonElement>('button[disabled]')!;
    const inherited = document.getElementById('inherited') as HTMLElement;
    const hidden = document.getElementById('hidden') as HTMLButtonElement;
    rect(disabled!);
    rect(inherited!);
    rect(hidden!);
    hitTest(disabled!);
    hidden!.style.display = 'none';

    expect(actionabilityPoint(document, disabled!)).toEqual({ ok: false, reason: 'disabled' });
    expect(actionabilityPoint(document, inherited!)).toEqual({ ok: false, reason: 'disabled' });
    expect(actionabilityPoint(document, hidden!)).toEqual({ ok: false, reason: 'hidden' });
  });

  it('refuses covered and offscreen targets rather than clicking through overlays', () => {
    document.body.innerHTML = '<button>Continue</button><div id="overlay"></div>';
    const button = document.querySelector('button')!;
    const overlay = document.getElementById('overlay')!;
    rect(button);
    hitTest(overlay);
    expect(actionabilityPoint(document, button)).toEqual({ ok: false, reason: 'covered' });

    rect(button, { left: -5, top: 20, right: 95, bottom: 50, width: 100, height: 30 });
    hitTest(button);
    expect(actionabilityPoint(document, button)).toEqual({ ok: false, reason: 'offscreen' });
  });
});

describe('structured DOM locator', () => {
  it('resolves exact role, name and data-e2e within one unique semantic container', () => {
    document.body.innerHTML = '<article aria-label="Video A"><button aria-label="Like" data-e2e="like"></button></article><article aria-label="Video B"><button aria-label="Like" data-e2e="like"></button></article>';

    const result = findLocatorTarget(document, {
      role: 'button', name: 'Like', testId: 'like',
      within: { role: 'article', name: 'Video B' },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.element.parentElement?.getAttribute('aria-label')).toBe('Video B');
  });

  it('refuses repeated and incomplete locators instead of selecting document order', () => {
    document.body.innerHTML = '<article aria-label="Video A"><button>Like</button><button>Like</button></article>';

    expect(findLocatorTarget(document, { role: 'button', name: 'Like', within: { role: 'article', name: 'Video A' } }))
      .toEqual({ ok: false, reason: 'ambiguous' });
    expect(findLocatorTarget(document, { within: { role: 'article', name: 'Video A' } }))
      .toEqual({ ok: false, reason: 'invalid' });
  });

  it('computes a multi-reference accessible name and falls through an empty aria-label', () => {
    document.body.innerHTML = '<span id="verb">Save</span><span id="object">draft</span><button role="custom-role button" aria-labelledby="verb object" aria-label="">Save</button>';
    const result = findLocatorTarget(document, { role: 'button', name: 'Save draft' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.element.tagName).toBe('BUTTON');
  });

  it('uses native control roles and host-language image names', () => {
    document.body.innerHTML = '<input id="search" type="search" aria-label="Search terms"><input type="image" alt="Submit"><summary>More details</summary><table><tr><td data-e2e="cell" style="cursor:pointer">Name</td></tr></table>';
    expect(findLocatorTarget(document, { role: 'searchbox', name: 'Search terms' }).ok).toBe(true);
    expect(findLocatorTarget(document, { role: 'button', name: 'Submit' }).ok).toBe(true);
    expect(findLocatorTarget(document, { role: 'button', name: 'More details' }).ok).toBe(true);
    expect(findLocatorTarget(document, { role: 'cell', name: 'Name', testId: 'cell' }).ok).toBe(true);
  });

  it('uses the HTML-AAM placeholder fallback and ignores the form name attribute', () => {
    document.body.innerHTML = '<input type="text" placeholder="Search here" name="Search">';
    expect(findLocatorTarget(document, { role: 'textbox', name: 'Search here' }).ok).toBe(true);
    expect(findLocatorTarget(document, { role: 'textbox', name: 'Search' })).toEqual({ ok: false, reason: 'none' });
  });
});

describe('screenshot coordinate target', () => {
  it('resolves the exact visible interactive target under a viewport point', () => {
    document.body.innerHTML = '<button>Play</button>';
    const button = document.querySelector('button')!;
    rect(button);
    hitTest(button);

    expect(findPointTarget(document, 70, 35)).toEqual({ ok: true, element: button });
    expect(findPointTarget(document, 150, 35)).toEqual({ ok: false, reason: 'offscreen' });
  });

  it('refuses covered, disabled, hidden and noninteractive point targets', () => {
    document.body.innerHTML = '<button disabled>Save</button><div id="cover"></div><p>Article text</p>';
    const button = document.querySelector<HTMLButtonElement>('button')!;
    const cover = document.querySelector<HTMLElement>('#cover')!;
    const paragraph = document.querySelector<HTMLElement>('p')!;
    rect(button!);
    rect(cover!);
    rect(paragraph!);
    hitTest(button!);
    expect(findPointTarget(document, 70, 35)).toEqual({ ok: false, reason: 'disabled' });

    button.disabled = false;
    hitTest(cover!);
    expect(findPointTarget(document, 70, 35)).toEqual({ ok: false, reason: 'not-interactive' });

    paragraph!.setAttribute('style', 'display:none;cursor:pointer');
    hitTest(paragraph!);
    expect(findPointTarget(document, 70, 35)).toEqual({ ok: false, reason: 'hidden' });
  });

  it('identifies a visible canvas hit target for the Core label and approval checks', () => {
    document.body.innerHTML = '<canvas></canvas>';
    const canvas = document.querySelector('canvas')!;
    rect(canvas);
    hitTest(canvas);
    expect(findPointTarget(document, 70, 35)).toEqual({ ok: true, element: canvas });
  });
});

describe('file chooser guard', () => {
  it('blocks agent-triggered file input clicks and lets direct user clicks through', () => {
    document.body.innerHTML = '<button id="upload">Upload</button><input id="file" type="file">';
    const button = document.getElementById('upload')!;
    const input = document.getElementById('file') as HTMLInputElement;
    let chooserClicks = 0;
    input.addEventListener('click', () => { chooserClicks++; });
    button.addEventListener('click', () => input.click());
    const guard = installFileChooserGuard(document);

    guard.setAgentAction(true);
    button.click();
    expect(chooserClicks).toBe(0);

    guard.setAgentAction(false);
    button.click();
    expect(chooserClicks).toBe(1);
  });
});
