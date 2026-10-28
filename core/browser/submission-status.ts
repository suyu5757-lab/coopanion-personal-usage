export type SubmissionStatus = 'pending-review' | 'published' | 'submitted';

/** Classifies only visible status notices returned by the page. */
export function submissionStatus(messages: string[]): SubmissionStatus | null {
  const text = messages.map((message) => message.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').toLowerCase();
  if (!text) return null;
  if (/(审核中|待审核|审查中|pending review|under review|reviewing)/i.test(text)) return 'pending-review';
  if (/(已发布|published successfully|post is live)/i.test(text)) return 'published';
  if (/(提交成功|发送成功|评论成功|回复成功|发布成功|(?:回复|回覆|评论回复)(?:已)?(?:发送|发布|提交)(?:成功)?|(?:reply|response) (?:sent|posted|submitted)|successfully replied|submitted successfully|sent successfully|posted successfully)/i.test(text)) return 'submitted';
  return null;
}

/** Requires a reply-specific notice before a comment target is recorded as completed. */
export function commentReplyConfirmed(messages: string[]): boolean {
  const text = messages.map((message) => message.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').toLowerCase();
  return /(?:回复|回覆|评论回复)(?:成功|已发送|已发布|已提交)|(?:reply|response) (?:sent|posted|submitted)|successfully replied/i.test(text);
}
