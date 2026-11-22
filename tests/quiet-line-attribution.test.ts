import { describe, expect, it } from 'vitest';
import { digestText, inspectContextEvidence } from '../vendor/cortico/src/core/evidence.ts';
import { message, type ContextRecord } from '../vendor/cortico/src/protocol/open-responses/context.ts';
import { selfTimeLine } from '../core/browser/model-text.ts';

/**
 * The heartbeat line is Host text, not the person's message and not a historical fact. It must
 * carry an exact core-generated span, otherwise the evidence gate blocks every later dispatch in
 * a session once a quiet period has passed.
 */
function record(text: string, attributed: boolean): ContextRecord {
  const entry = message('user', text);
  if (!attributed) return entry;
  return {
    ...entry,
    context: { sourceMapSpans: [{ start: 0, end: text.length, digest: digestText(text), origin: 'core-generated' }] },
  };
}

describe('quiet-time Host line attribution', () => {
  it('accepts the hosted quiet line only when its Host span covers the whole text', () => {
    const text = selfTimeLine('zh', 48, 30, false, '');
    expect(inspectContextEvidence([record(text, true)]).mappingState).toBe('complete');
    expect(inspectContextEvidence([record(text, false)]).mappingState).toBe('missing');
  });

  it('keeps the English quiet line in the same trust shape', () => {
    const text = selfTimeLine('en', 48, 30, false, '');
    expect(inspectContextEvidence([record(text, true)]).mappingState).toBe('complete');
  });

  it('discharges a source-free dependency span with the exact Host span after a restart', () => {
    const text = selfTimeLine('zh', 48, 30, false, '');
    const entry = record(text, true);
    entry.context.sourceDependencySpans = [{ start: 0, end: text.length, digest: digestText(text), exposedSources: [], proofId: 'proof-lost-after-restart' }];
    expect(inspectContextEvidence([entry], { verifyDependency: () => null }).mappingState).toBe('complete');
  });

  it('does not discharge a dependency span that names a source', () => {
    const text = selfTimeLine('zh', 48, 30, false, '');
    const entry = record(text, true);
    entry.context.sourceDependencySpans = [{
      start: 0, end: text.length, digest: digestText(text), proofId: 'proof-lost-after-restart',
      exposedSources: [{
        bankId: 'bank', endpoint: 'http://127.0.0.1', documentId: 'doc', validatedEpoch: '1',
        revisionState: 'current', validationStatus: 'validated', validationReceipt: 'a'.repeat(64), contentDigest: 'b'.repeat(64),
      }],
    }];
    expect(inspectContextEvidence([entry], { verifyDependency: () => null }).mappingState).toBe('unverified');
  });

  it('does not cover a dynamic body merely because it has the Host prefix', () => {
    const text = `${selfTimeLine('zh', 48, 30, false, '')} 用户动态正文`;
    const truncated = record(text, true);
    truncated.context.sourceMapSpans = [{ start: 0, end: text.length - 5, digest: digestText(text.slice(0, -5)), origin: 'core-generated' }];
    expect(inspectContextEvidence([truncated]).mappingState).toBe('missing');
  });
});
