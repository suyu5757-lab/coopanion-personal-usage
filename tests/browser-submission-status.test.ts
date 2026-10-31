import { describe, expect, it } from 'vitest';
import { advanceDouyinUploadState, clipboardCopyConfirmed, commentReplyConfirmed, douyinUploadState, submissionStatus } from '../core/browser/submission-status.ts';

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

  it('separates file selection from new upload, processing, draft and failure notices', () => {
    const files = ['generated/cover.png', 'preview.mp4'];
    const base = { selected: files, expected: files, beforeMessages: [], afterMessages: [] };
    expect(douyinUploadState(base)).toBe('file_selected');
    expect(douyinUploadState({ ...base, afterMessages: ['正在上传'] })).toBe('uploading');
    expect(douyinUploadState({ ...base, afterMessages: ['上传成功', '处理中'] })).toBe('processing');
    expect(douyinUploadState({ ...base, afterMessages: ['草稿已保存'] })).toBe('draft_ready');
    expect(douyinUploadState({ ...base, afterMessages: ['作品提交成功'] })).toBe('platform_acknowledged');
    expect(douyinUploadState({ ...base, afterMessages: ['发布成功'] })).toBe('platform_acknowledged');
    expect(douyinUploadState({ ...base, afterMessages: ['作品审核中'] })).toBe('review_pending');
    expect(douyinUploadState({ ...base, afterMessages: ['作品已发布'] })).toBe('published_verified');
    expect(douyinUploadState({ ...base, afterMessages: ['作品已发布'] })).not.toBe('platform_acknowledged');
    expect(douyinUploadState({ ...base, afterMessages: ['上传失败，请重试'] })).toBe('failed');
    expect(douyinUploadState({ ...base, beforeMessages: ['上传成功'], afterMessages: ['上传成功'] })).toBe('file_selected');
  });

  it('does not infer file selection when the page input differs from the approved list', () => {
    expect(douyinUploadState({
      selected: ['wrong.mp4'], expected: ['preview.mp4'], beforeMessages: [], afterMessages: [],
    })).toBe('unknown');
    expect(advanceDouyinUploadState('processing', 'file_selected')).toBe('processing');
    expect(advanceDouyinUploadState('draft_ready', 'published_verified')).toBe('published_verified');
    expect(advanceDouyinUploadState('draft_ready', 'unknown')).toBe('draft_ready');
  });
});
