import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { functionResult } from 'cortico/protocol/open-responses/context.ts';
import { digestText, inspectRequestEvidence, verifyToolTextOrigins } from 'cortico/core/evidence.ts';
import type { EvidenceAttachment, SourceMapSpan, ToolOutcome } from 'cortico/core/types.ts';
import { memoryTools } from '../core/memory/tools.ts';
import { isTrustedMemorySearchNotice } from '../core/memory/model-text.ts';

const receipt = 'a'.repeat(64);
const content = (doc: string) => createHash('sha256').update(`whole:${doc}`).digest('hex');

function fixture(count: number) {
  let text = '[memory] Original retained user source excerpts.\n';
  const evidence: EvidenceAttachment[] = [];
  const sourceSegments: Array<{ documentId: string; start: number; end: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const doc = `user:test:${index}`;
    const body = `Paragraph ${index} says the same verified thing.`;
    if (index) text += '\n';
    text += body;
    const start = text.length - body.length;
    sourceSegments.push({ documentId: doc, start, end: text.length });
    evidence.push({
      bankId: 'bank', endpoint: 'http://127.0.0.1:1', documentId: doc, validatedEpoch: '1:0',
      revisionState: 'current', validationStatus: 'validated', validationReceipt: receipt, contentDigest: content(doc),
      segment: { start, end: text.length, digest: digestText(body), sourceProof: { token: `proof-${index}`, startUtf16: 0, endUtf16: body.length } },
    });
  }
  return { text, evidence, sourceSegments };
}

function fakeMemory(f: ReturnType<typeof fixture>) {
  return {
    enabled: () => true,
    searchSourceDocuments: async () => ({
      status: 'found' as const, text: f.text, sourceSegments: f.sourceSegments,
      trace: { format: { sourceSegments: f.sourceSegments, sourceFactsTruncated: false, incompleteResultIds: [], omittedSourceDocumentIds: [], clippedResultIds: [], clippedContextResultIds: [], clippedSourceFactIds: [] } },
    }),
    evidenceForRead: async () => f.evidence,
  } as never;
}

function inspect(count: number) {
  return inspectWith(fixture(count));
}

function inspectWith(f: ReturnType<typeof fixture>) {
  const tools = memoryTools({ memory: () => fakeMemory(f), sourceSafeToolResults: true });
  const search = tools.find((tool) => tool.name === 'memory_search')!;
  return search.handler({ query: '云海', sources: true }, { role: 'main' } as never) as Promise<ToolOutcome>;
}

function recordOf(out: ToolOutcome) {
  const spans = verifyToolTextOrigins('memory_search', out.text, out.sourceMapSpans, isTrustedMemorySearchNotice);
  const record = functionResult('call_test', out.text, { evidence: out.evidence, sourceMapSpans: spans, toolCallId: 'call_test' });
  const request = { model: 'm', input: [record.item] } as never;
  return inspectRequestEvidence(request, [record], request as never);
}

describe('verified memory_search ToolOutcome to ContextRecord', () => {
  it('drops one invalid source and keeps the other three', async () => {
    const f = fixture(4);
    f.evidence[2]!.validationStatus = 'unknown';
    const out = await inspectWith(f) as ToolOutcome;
    expect(out.evidence).toHaveLength(3);
    expect(out.text).toContain('Some sources were omitted');
    const result = recordOf(out);
    expect(result.mappingState).toBe('complete');
  });

  for (const count of [1, 2, 8, 16]) {
    it(`keeps ${count} sources complete through the tool outcome`, async () => {
      const out = await inspect(count);
      expect(out).not.toBeTypeOf('string');
      const result = recordOf(out as ToolOutcome);
      const bad = result.items[0]!.spans.filter((span) => span.mappingState !== 'complete');
      expect(bad, JSON.stringify(bad).slice(0, 1200)).toEqual([]);
      expect(result.mappingState).toBe('complete');
    });
  }
});
