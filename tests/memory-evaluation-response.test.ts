import { describe, expect, it } from 'vitest';
import { readModelResponse } from '../scripts/memory-evaluation-response.ts';

function response(id: string, content: string, cost = 0): Response {
  return new Response(JSON.stringify({ id, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 40, cost }, opencode: { allowance: { cost: 0.002, remaining: 9.9 } } }), { status: 200 });
}

describe('model response receipts', () => {
  it('distinguishes identical refusals from reuse of the same HTTP body', async () => {
    const refusal = JSON.stringify({ answer: null, citations: [], abstained: true });
    const first = await readModelResponse(response('request-a', refusal));
    const second = await readModelResponse(response('request-b', refusal));
    expect(first.receipt.httpStatus).toBe(200);
    expect(first.receipt.status).toBe('complete');
    expect(first.receipt.responseBodyHash).not.toBe(second.receipt.responseBodyHash);
    expect(first.receipt.outputHash).toBe(second.receipt.outputHash);
    expect(first.receipt.canonicalOutputHash).toBe(second.receipt.canonicalOutputHash);
    expect(first.receipt).toMatchObject({ abstained: true, answerNull: true, allowance: { cost: 0.002, remaining: 9.9 } });
  });

  it('preserves usage and the output fingerprint before an answer can fail parsing', async () => {
    const invalid = await readModelResponse(response('request-c', 'private answer in an unexpected format', 0.003));
    expect(invalid.receipt).toMatchObject({ status: 'invalid-answer', inputTokens: 400, outputTokens: 40, reportedCostUsd: 0.003 });
    expect(invalid.answer).toBeNull();
    expect(JSON.stringify(invalid.receipt)).not.toContain('private answer');
  });

  it('records the actual HTTP failure without interpreting an error body as an answer', async () => {
    const result = await readModelResponse(new Response('{"error":"private diagnostic"}', { status: 429 }));
    expect(result.receipt).toMatchObject({ httpStatus: 429, httpOk: false, status: 'http-error' });
    expect(result.answer).toBeNull();
    expect(JSON.stringify(result.receipt)).not.toContain('private diagnostic');
  });
});
