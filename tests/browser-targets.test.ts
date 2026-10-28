/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { installFileChooserGuard } from '../app/browser-agent/safety.ts';
import { currentElementLabel, findTextTarget } from '../app/browser-agent/targets.ts';

const laidOut = (): void => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 30; } });
};

beforeEach(() => { laidOut(); document.body.innerHTML = ''; });

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
