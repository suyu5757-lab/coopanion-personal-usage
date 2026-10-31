import { describe, expect, it } from 'vitest';
import { advanceDouyinUploadState, douyinUploadState, freshDouyinUploadMessages, type DouyinUploadState } from '../core/browser/submission-status.ts';

const file = ['preview.mp4'];

const classificationCases: Array<{
  name: string;
  selected: string[];
  expected?: string[];
  before?: string[];
  after?: string[];
  state: DouyinUploadState;
}> = [
  { name: 'exact file input readback', selected: file, state: 'file_selected' },
  { name: 'Chinese upload notice', selected: [], after: ['正在上传'], state: 'uploading' },
  { name: 'English upload notice', selected: [], after: ['Uploading'], state: 'uploading' },
  { name: 'Chinese upload completion', selected: [], after: ['上传完成'], state: 'uploaded' },
  { name: 'English upload completion', selected: [], after: ['Uploaded successfully'], state: 'uploaded' },
  { name: 'Chinese processing notice', selected: [], after: ['处理中'], state: 'processing' },
  { name: 'English transcoding notice', selected: [], after: ['Transcoding'], state: 'processing' },
  { name: 'Chinese saved draft notice', selected: [], after: ['草稿已保存'], state: 'draft_ready' },
  { name: 'English saved draft notice', selected: [], after: ['Draft ready'], state: 'draft_ready' },
  { name: 'Chinese submission acknowledgement', selected: [], after: ['作品已提交'], state: 'platform_acknowledged' },
  { name: 'publish-success acknowledgement', selected: [], after: ['发布成功'], state: 'platform_acknowledged' },
  { name: 'English submission acknowledgement', selected: [], after: ['Submitted successfully'], state: 'platform_acknowledged' },
  { name: 'Chinese review notice', selected: [], after: ['作品审核中'], state: 'review_pending' },
  { name: 'English review notice', selected: [], after: ['Under review'], state: 'review_pending' },
  { name: 'Chinese published notice', selected: [], after: ['作品已发布'], state: 'published_verified' },
  { name: 'English live notice', selected: [], after: ['Post is live'], state: 'published_verified' },
  { name: 'Chinese upload failure', selected: [], after: ['上传失败'], state: 'failed' },
  { name: 'English upload failure', selected: [], after: ['Failed to upload'], state: 'failed' },
  { name: 'wrong selected filename with a positive notice', selected: ['other.mp4'], after: ['作品已发布'], state: 'unknown' },
  { name: 'partial file selection with an upload notice', selected: ['cover.png'], expected: ['cover.png', 'preview.mp4'], after: ['正在上传'], state: 'unknown' },
  { name: 'reordered multiple-file selection', selected: ['preview.mp4', 'cover.png'], expected: ['cover.png', 'preview.mp4'], after: ['上传完成'], state: 'unknown' },
  { name: 'different path with a matching upload notice', selected: ['other/preview.mp4'], expected: ['generated/preview.mp4'], after: ['处理中'], state: 'unknown' },
  { name: 'missing selection and status notice', selected: [], state: 'unknown' },
  { name: 'old upload notice already present before selection', selected: file, before: ['正在上传'], after: ['正在上传'], state: 'file_selected' },
  { name: 'old upload failure is not attributed to the new selection', selected: file, before: ['上传失败'], after: ['上传失败'], state: 'file_selected' },
  { name: 'one repeated upload notice beyond the baseline', selected: file, before: ['上传成功'], after: ['上传成功', '上传成功'], state: 'uploaded' },
  { name: 'English notice whitespace and case normalization', selected: file, before: ['UPLOAD   COMPLETE'], after: ['upload complete'], state: 'file_selected' },
  { name: 'one new duplicate completion notice beyond the baseline', selected: file, before: ['上传完成'], after: ['上传完成', '上传完成'], state: 'uploaded' },
  { name: 'unknown old status cannot create a state', selected: file, before: ['页面已打开'], after: ['页面已打开'], state: 'file_selected' },
  { name: 'new processing notice beside an old upload notice', selected: file, before: ['上传成功'], after: ['上传成功', '处理中'], state: 'processing' },
  { name: 'old duplicate count is consumed before a fresh completion', selected: file, before: ['上传完成', '上传完成'], after: ['上传完成', '上传完成', '处理中'], state: 'processing' },
  { name: 'empty expected list cannot confirm a selected file', selected: ['preview.mp4'], expected: [], state: 'unknown' },
];

const transitionCases: Array<{ name: string; previous: DouyinUploadState | null; observed: DouyinUploadState; expected: DouyinUploadState }> = [
  { name: 'selection advances to uploading', previous: 'file_selected', observed: 'uploading', expected: 'uploading' },
  { name: 'uploading advances to uploaded', previous: 'uploading', observed: 'uploaded', expected: 'uploaded' },
  { name: 'uploaded advances to processing', previous: 'uploaded', observed: 'processing', expected: 'processing' },
  { name: 'processing advances to a saved draft', previous: 'processing', observed: 'draft_ready', expected: 'draft_ready' },
  { name: 'draft advances to platform acknowledgement', previous: 'draft_ready', observed: 'platform_acknowledged', expected: 'platform_acknowledged' },
  { name: 'platform acknowledgement advances to review', previous: 'platform_acknowledged', observed: 'review_pending', expected: 'review_pending' },
  { name: 'review advances to a published notice', previous: 'review_pending', observed: 'published_verified', expected: 'published_verified' },
  { name: 'older selection cannot erase processing', previous: 'processing', observed: 'file_selected', expected: 'processing' },
  { name: 'upload completion cannot erase a ready draft', previous: 'draft_ready', observed: 'uploaded', expected: 'draft_ready' },
  { name: 'submission acknowledgement cannot erase review', previous: 'review_pending', observed: 'platform_acknowledged', expected: 'review_pending' },
  { name: 'unknown observation preserves a known state', previous: 'draft_ready', observed: 'unknown', expected: 'draft_ready' },
  { name: 'new evidence can resolve an unknown receipt', previous: 'unknown', observed: 'file_selected', expected: 'file_selected' },
  { name: 'failure remains terminal', previous: 'failed', observed: 'uploading', expected: 'failed' },
  { name: 'published state remains terminal', previous: 'published_verified', observed: 'unknown', expected: 'published_verified' },
];

describe('Douyin upload lifecycle case matrix', () => {
  it.each(classificationCases)('classifies $name', ({ selected, expected, before, after, state }) => {
    expect(douyinUploadState({
      selected,
      expected: expected ?? file,
      beforeMessages: before ?? [],
      afterMessages: after ?? [],
    })).toBe(state);
  });

  it.each(transitionCases)('advances when $name', ({ previous, observed, expected }) => {
    expect(advanceDouyinUploadState(previous, observed)).toBe(expected);
  });

  it('normalizes and deduplicates only notices already present before an observation', () => {
    expect(freshDouyinUploadMessages([' 上传中 '], ['上传中', '草稿 已 保存']))
      .toEqual(['草稿 已 保存']);
  });
});
