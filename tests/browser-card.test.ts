// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { accountEvidence, chosenVideo, shareTarget, videoEvidence } from '../app/browser-agent/card.ts';
/** jsdom lays nothing out; every element in these pages counts as visible. */
const laidOut = (): void => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 100; } });
  Object.defineProperty(HTMLVideoElement.prototype, 'clientWidth', { configurable: true, get() { return 320; } });
  Object.defineProperty(HTMLVideoElement.prototype, 'clientHeight', { configurable: true, get() { return 180; } });
};

/** A video the page is playing, sized so `pickedVideo` can rank it. */
const video = (playing: boolean, width = 320, height = 180): HTMLVideoElement => {
  const element = document.createElement('video');
  Object.defineProperty(element, 'paused', { configurable: true, get: () => !playing });
  Object.defineProperty(element, 'currentTime', { configurable: true, get: () => (playing ? 3 : 0) });
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => height });
  return element;
};

const share = (card: string): HTMLButtonElement => {
  const button = document.createElement('button');
  button.setAttribute('aria-label', '分享');
  button.dataset.card = card;
  button.textContent = '分享';
  return button;
};

beforeEach(() => { laidOut(); document.body.innerHTML = ''; });

describe('share target', () => {
  it('takes the share control of the playing video, not the first one in the document', () => {
    document.body.innerHTML = '<main id="feed"></main>';
    const feed = document.getElementById('feed')!;
    const second = document.createElement('article');
    second.append(video(false, 120, 70), share('second'));
    const first = document.createElement('article');
    first.append(video(true), share('first'));
    feed.append(second, first);

    const target = shareTarget(document);
    expect(target.ok).toBe(true);
    expect(target.ok && target.element.dataset.card).toBe('first');
  });

  it('refuses when the playing video\'s card holds two share controls', () => {
    document.body.innerHTML = '<article id="card"></article>';
    const card = document.getElementById('card')!;
    card.append(video(true), share('one'), share('two'));
    expect(shareTarget(document)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses when two cards are on screen and no video is playing', () => {
    document.body.innerHTML = '<main id="feed"></main>';
    const feed = document.getElementById('feed')!;
    for (const name of ['a', 'b']) {
      const card = document.createElement('article');
      card.append(video(false), share(name));
      feed.append(card);
    }
    expect(shareTarget(document)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses a share control in a sibling card when the playing video has none', () => {
    document.body.innerHTML = '<main><article id="video-card"></article><article id="other-card"></article></main>';
    document.getElementById('video-card')!.append(video(true));
    document.getElementById('other-card')!.append(share('other'));
    expect(shareTarget(document)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses when the page has no recognizable video-card boundary', () => {
    document.body.innerHTML = '<main><div id="unknown-card"></div></main>';
    document.getElementById('unknown-card')!.append(video(true), share('unknown'));
    expect(shareTarget(document)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('reports a page with no share control at all', () => {
    document.body.innerHTML = '<div><video></video></div>';
    document.body.append(video(true));
    expect(shareTarget(document)).toEqual({ ok: false, reason: 'none' });
  });
});

describe('current video evidence', () => {
  it('names the playing video\'s own link and title', () => {
    document.body.innerHTML = '<article id="card"><a href="https://www.douyin.com/video/123" aria-label="海边的下午"></a></article>';
    document.getElementById('card')!.prepend(video(true));
    expect(videoEvidence(document)).toEqual({ url: 'https://www.douyin.com/video/123', title: '海边的下午' });
  });

  it('claims no link when the page carries none, rather than the page address', () => {
    document.body.innerHTML = '<article id="card"></article>';
    document.getElementById('card')!.append(video(true));
    expect(videoEvidence(document)).toBeNull();
  });

  it('does not report a sibling video link as the current video address', () => {
    document.body.innerHTML = '<main><article id="video-card"></article><article id="other-card"><a href="https://www.douyin.com/video/999" aria-label="别的视频"></a></article></main>';
    document.getElementById('video-card')!.append(video(true));
    expect(videoEvidence(document)).toBeNull();
  });

  it('does not guess between multiple video links in the same card', () => {
    document.body.innerHTML = '<article id="card"><a href="https://www.douyin.com/video/123">当前</a><a href="https://www.douyin.com/video/456">推荐</a></article>';
    document.getElementById('card')!.append(video(true));
    expect(videoEvidence(document)).toBeNull();
  });
});

describe('signed-in account evidence', () => {
  it('returns the unique profile link explicitly labelled as the current account', () => {
    document.body.innerHTML = '<a href="/user/account-1" aria-label="我的主页"></a>';
    expect(accountEvidence(document)).toEqual({ ref: `${location.origin}/user/account-1`, label: '我的主页' });
  });

  it('does not confuse a video author with the signed-in account', () => {
    document.body.innerHTML = '<a href="/user/creator-1">作者</a>';
    expect(accountEvidence(document)).toBeNull();
  });

  it('refuses multiple profile controls', () => {
    document.body.innerHTML = '<a href="/user/account-1" aria-label="我的主页"></a><a href="/user/account-2" aria-label="个人主页"></a>';
    expect(accountEvidence(document)).toBeNull();
  });
});

describe('chosen video', () => {
  it('takes the one playing over a larger paused one', () => {
    document.body.innerHTML = '<div id="feed"></div>';
    const feed = document.getElementById('feed')!;
    feed.append(video(false, 900, 500), video(true, 200, 120));
    const choice = chosenVideo(document);
    expect(choice.ok).toBe(true);
    expect(choice.ok && choice.video.clientWidth).toBe(200);
  });

  it('reports two candidates as ambiguous rather than ranking them', () => {
    document.body.innerHTML = '<div id="feed"></div>';
    document.getElementById('feed')!.append(video(false, 900, 500), video(false, 200, 120));
    expect(chosenVideo(document)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('reports a page with no video', () => {
    expect(chosenVideo(document)).toEqual({ ok: false, reason: 'none' });
  });
});
