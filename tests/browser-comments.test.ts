// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { replyTargetForBox } from '../app/browser-agent/comments.ts';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 24 });
});

describe('comment reply targets', () => {
  it('binds a reply box to one author, comment row, post and exact timestamp', async () => {
    document.body.innerHTML = '<article data-e2e="comment-item" data-comment-id="c-1"><a href="/user/u-1">阿青</a><p>这段配色好舒服</p><time datetime="2026-10-28T03:00:00Z">3 天前</time><textarea placeholder="回复评论"></textarea></article>';
    const row = document.querySelector('article')!;
    const box = row.querySelector('textarea')!;
    const target = await replyTargetForBox(document, box, 4, 'https://www.douyin.com/video/123');
    expect(target).toMatchObject({ boxId: 4, author: '阿青', authorRef: 'https://www.douyin.com/user/u-1', timestamp: '2026-10-28T03:00:00Z', needsExpand: false });
    expect(target?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(target?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(target?.context).toContain('这段配色好舒服');
    expect((await replyTargetForBox(document, box, 4, 'https://www.douyin.com/video/123'))?.fingerprint).toBe(target?.fingerprint);
  });

  it('marks collapsed replies and rejects duplicate rows without a stable page ID', async () => {
    document.body.innerHTML = '<article data-e2e="comment-item"><a href="/user/u-1">阿青</a><p>同一句评论</p><button>查看 2 条回复</button><textarea placeholder="回复评论"></textarea></article>'
      + '<article data-e2e="comment-item"><a href="/user/u-1">阿青</a><p>同一句评论</p><button>查看 2 条回复</button><textarea placeholder="回复评论"></textarea></article>';
    const boxes = Array.from(document.querySelectorAll('textarea'));
    expect(await replyTargetForBox(document, boxes[0]!, 1, 'https://www.douyin.com/video/123')).toBe(null);
  });

  it('does not bind a comment row with ambiguous authors', async () => {
    document.body.innerHTML = '<article><a href="/user/a">阿青</a><a href="/user/b">小鱼</a><p>评论</p><textarea placeholder="回复"></textarea></article>';
    expect(await replyTargetForBox(document, document.querySelector('textarea')!, 2, 'https://www.douyin.com/video/123')).toBe(null);
  });

  it('keeps expanded child replies out of the parent comment identity', async () => {
    document.body.innerHTML = '<article data-e2e="comment-item" data-comment-id="root"><a href="/user/a">阿青</a><p data-e2e="comment-text">原评论</p><div data-e2e="reply-item"><a href="/user/b">小鱼</a><p>已有回复</p></div><textarea placeholder="回复评论"></textarea></article>';
    const box = document.querySelector('textarea')!;
    const target = await replyTargetForBox(document, box, 5, 'https://www.douyin.com/video/123');
    expect(target?.author).toBe('阿青');
    expect(target?.context).toContain('原评论');
    expect(target?.context).not.toContain('已有回复');
  });
});
