import { describe, expect, it } from 'vitest';
import { clipboardCopyConfirmed, commentReplyConfirmed, submissionStatus } from '../core/browser/submission-status.ts';

describe('browser submission status', () => {
  it('reports pending review separately from a published page status', () => {
    expect(submissionStatus(['已提交，审核中'])).toBe('pending-review');
    expect(submissionStatus(['待审核'])).toBe('pending-review');
    expect(submissionStatus(['已发布'])).toBe('published');
  });

  it('recognizes a submission receipt without claiming public visibility', () => {
    expect(submissionStatus(['发布成功'])).toBe('submitted');
    expect(submissionStatus(['发送成功'])).toBe('submitted');
    expect(submissionStatus(['reply sent'])).toBe('submitted');
    expect(submissionStatus(['回复已发送'])).toBe('submitted');
    expect(submissionStatus(['分享成功'])).toBe('submitted');
    expect(submissionStatus(['谢谢参与'])).toBe(null);
    expect(submissionStatus([])).toBe(null);
  });

  it('requires a reply-specific receipt before marking a comment reply complete', () => {
    expect(commentReplyConfirmed(['回复成功'])).toBe(true);
    expect(commentReplyConfirmed(['Reply sent'])).toBe(true);
    expect(commentReplyConfirmed(['评论成功'])).toBe(false);
    expect(commentReplyConfirmed(['发布成功'])).toBe(false);
  });

  it('requires a visible copy notice and never needs clipboard contents', () => {
    expect(clipboardCopyConfirmed(['链接复制成功'])).toBe(true);
    expect(clipboardCopyConfirmed(['Link copied to clipboard'])).toBe(true);
    expect(clipboardCopyConfirmed(['分享面板'])).toBe(false);
  });
});
