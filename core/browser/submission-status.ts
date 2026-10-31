export type SubmissionStatus = 'pending-review' | 'published' | 'submitted';

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
