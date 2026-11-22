export type SubmissionStatus = 'pending-review' | 'published' | 'submitted';

export type DouyinUploadState = 'file_selected' | 'uploading' | 'uploaded' | 'processing' | 'draft_ready' | 'platform_acknowledged' | 'review_pending' | 'published_verified' | 'failed' | 'unknown';

export function freshDouyinUploadMessages(beforeMessages: string[], afterMessages: string[]): string[] {
  const beforeCounts = new Map<string, number>();
  for (const message of beforeMessages) {
    const key = message.replace(/\s+/g, ' ').trim().toLowerCase();
    beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
  }
  const fresh: string[] = [];
  for (const message of afterMessages) {
    const key = message.replace(/\s+/g, ' ').trim().toLowerCase();
    const count = beforeCounts.get(key) ?? 0;
    if (count > 0) beforeCounts.set(key, count - 1);
    else if (key) fresh.push(key);
  }
  return fresh;
}

/** Classifies only a newly visible upload notice or an exact file-input readback. */
export function douyinUploadState(input: {
  selected: string[];
  expected: string[];
  beforeMessages: string[];
  afterMessages: string[];
}): DouyinUploadState {
  const exactSelection = input.expected.length > 0 && input.selected.length === input.expected.length
    && input.selected.every((file, index) => file === input.expected[index]);
  if (input.selected.length > 0 && !exactSelection) return 'unknown';
  const text = freshDouyinUploadMessages(input.beforeMessages, input.afterMessages).join('\n');
  if (/(?:上传失败|上传出错|upload failed|failed to upload)/i.test(text)) return 'failed';
  if (/(?:作品已发布|已发布|published successfully|post is live)/i.test(text)) return 'published_verified';
  if (/(?:审核中|待审核|审查中|pending review|under review|reviewing)/i.test(text)) return 'review_pending';
  if (/(?:提交成功|作品已提交|发布成功|submitted successfully|post submitted)/i.test(text)) return 'platform_acknowledged';
  if (/(?:草稿.{0,8}(?:已保存|保存成功|准备就绪)|draft (?:saved|ready))/i.test(text)) return 'draft_ready';
  if (/(?:处理中|转码中|processing|transcoding)/i.test(text)) return 'processing';
  if (/(?:正在上传|上传中|uploading)/i.test(text)) return 'uploading';
  if (/(?:上传完成|上传成功|upload complete|uploaded successfully)/i.test(text)) return 'uploaded';
  return exactSelection ? 'file_selected' : 'unknown';
}

/** Upload observations advance monotonically; a later read cannot erase a confirmed state. */
export function advanceDouyinUploadState(previous: DouyinUploadState | null, observed: DouyinUploadState): DouyinUploadState {
  if (!previous || previous === 'unknown') return observed;
  if (previous === 'failed' || previous === 'published_verified') return previous;
  if (observed === 'unknown') return previous;
  if (observed === 'failed') return observed;
  const order: DouyinUploadState[] = [
    'file_selected', 'uploading', 'uploaded', 'processing', 'draft_ready',
    'platform_acknowledged', 'review_pending', 'published_verified',
  ];
  return order.indexOf(observed) >= order.indexOf(previous) ? observed : previous;
}

/** Classifies only visible status notices returned by the page. */
export function submissionStatus(messages: string[]): SubmissionStatus | null {
  const text = messages.map((message) => message.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').toLowerCase();
  if (!text) return null;
  if (/(审核中|待审核|审查中|pending review|under review|reviewing)/i.test(text)) return 'pending-review';
  if (/(已发布|published successfully|post is live)/i.test(text)) return 'published';
  if (/(提交成功|发送成功|评论成功|回复成功|发布成功|分享成功|已分享|(?:回复|回覆|评论回复)(?:已)?(?:发送|发布|提交)(?:成功)?|(?:reply|response) (?:sent|posted|submitted)|successfully replied|successfully shared|shared successfully|submitted successfully|sent successfully|posted successfully)/i.test(text)) return 'submitted';
  return null;
}

/** Requires a reply-specific notice before a comment target is recorded as completed. */
export function commentReplyConfirmed(messages: string[]): boolean {
  const text = messages.map((message) => message.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').toLowerCase();
  return /(?:回复|回覆|评论回复)(?:成功|已发送|已发布|已提交)|(?:reply|response) (?:sent|posted|submitted)|successfully replied/i.test(text);
}

/** Requires a page-visible notice confirming that a link was copied; clipboard contents are never read. */
export function clipboardCopyConfirmed(messages: string[]): boolean {
  const text = messages.map((message) => message.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').toLowerCase();
  return /(复制(?:链接|地址)?成功|链接复制成功|已复制(?:到剪贴板)?|链接已复制|copy (?:of (?:the )?)?link (?:succeeded|successful)|link copied(?: to clipboard)?|copied to clipboard)/i.test(text);
}
