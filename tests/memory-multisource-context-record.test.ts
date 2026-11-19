import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { functionResult } from 'cortico/protocol/open-responses/context.ts';
import { digestText, inspectRequestEvidence, verifyToolTextOrigins } from 'cortico/core/evidence.ts';
import type { EvidenceAttachment, SourceMapSpan, ToolOutcome } from 'cortico/core/types.ts';

const receipt = 'a'.repeat(64);
const content = (doc: string) => createHash('sha256').update(`whole:${doc}`).digest('hex');

function outcome(count: number): ToolOutcome {
  let text = '';
  const evidence: EvidenceAttachment[] = [];
  const sourceMapSpans: SourceMapSpan[] = [];
  for (let index = 0; index < count; index += 1) {
    const doc = `user:test:${index}`;
    const id = JSON.stringify(doc);
    const body = `Paragraph ${index} says the same verified thing.\nSecond line ${index}.`;
    if (text) text += '\n';
    const idStart = text.length;
    text += id;
    sourceMapSpans.push({ start: idStart, end: text.length, digest: digestText(id), origin: 'source-identity', exposedSources: [{
      bankId: 'bank', endpoint: 'http://127.0.0.1:1', documentId: doc, validatedEpoch: '1:0',
      revisionState: 'current', validationStatus: 'validated', validationReceipt: receipt, contentDigest: content(doc),
    }] });
    text += '\n';
    const start = text.length;
    text += body;
    evidence.push({
      bankId: 'bank', endpoint: 'http://127.0.0.1:1', documentId: doc, validatedEpoch: '1:0',
      revisionState: 'current', validationStatus: 'validated', validationReceipt: receipt, contentDigest: content(doc),
      segment: { start, end: text.length, digest: digestText(body) },
    });
  }
  return { text, evidence, sourceMapSpans };
}

function inspect(count: number) {
  const out = outcome(count);
  const spans = verifyToolTextOrigins('memory_search', out.text, out.sourceMapSpans, () => false);
  const record = functionResult('call_test', out.text, { evidence: out.evidence, sourceMapSpans: spans, toolCallId: 'call_test' });
  const request = { model: 'm', input: [record.item] } as never;
  return inspectRequestEvidence(request, [record], request as never);
}

describe('multisource memory_search ContextRecord', () => {
  for (const count of [1, 2, 8, 16]) {
    it(`keeps ${count} verified sources complete`, () => {
      const result = inspect(count);
      expect(result.mappingState).toBe('complete');
      expect(result.items[0]!.spans.every((span) => span.mappingState === 'complete')).toBe(true);
    });
  }
});
