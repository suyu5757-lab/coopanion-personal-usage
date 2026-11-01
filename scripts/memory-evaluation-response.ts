import { createHash } from 'node:crypto';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface MemoryEvaluationAnswer {
  answer: string | null;
  citations: string[];
  abstained: boolean;
}

export interface ModelResponseReceipt {
  httpStatus: number;
  httpOk: boolean;
  responseBodyHash: string;
  outputHash: string;
  canonicalOutputHash?: string;
  outputChars: number;
  status: 'complete' | 'http-error' | 'invalid-body' | 'empty-output' | 'invalid-answer';
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  reportedCostUsd?: number;
  allowance: Record<string, number>;
  abstained?: boolean;
  answerNull?: boolean;
  citationCount?: number;
}

function numericFields(value: unknown, prefix = ''): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.assign({}, ...Object.entries(value).map(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'number' && Number.isFinite(item)) return { [path]: item };
    return item && typeof item === 'object' ? numericFields(item, path) : {};
  }));
}

/** Receipts contain hashes and usage; the answer is returned separately for in-memory scoring. */
export async function readModelResponse(response: Response): Promise<{ receipt: ModelResponseReceipt; answer: MemoryEvaluationAnswer | null }> {
  const raw = await response.text();
  const receipt: ModelResponseReceipt = {
    httpStatus: response.status,
    httpOk: response.ok,
    responseBodyHash: sha256(raw),
    outputHash: sha256(''),
    outputChars: 0,
    status: response.ok ? 'invalid-body' : 'http-error',
    allowance: {},
  };
  if (!response.ok) return { receipt, answer: null };
  let body;
  try { body = JSON.parse(raw); } catch { return { receipt, answer: null }; }
  const usage = body.usage ?? {};
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map((part: { text?: unknown }) => typeof part?.text === 'string' ? part.text : '').join('') : '';
  receipt.outputHash = sha256(text);
  receipt.outputChars = text.length;
  receipt.status = text.trim() ? 'invalid-answer' : 'empty-output';
  if (typeof choice?.finish_reason === 'string') receipt.finishReason = choice.finish_reason;
  if (Number.isFinite(usage.prompt_tokens)) receipt.inputTokens = usage.prompt_tokens;
  if (Number.isFinite(usage.completion_tokens)) receipt.outputTokens = usage.completion_tokens;
  if (Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)) receipt.reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
  if (Number.isFinite(usage.cost ?? body.cost)) receipt.reportedCostUsd = usage.cost ?? body.cost;
  receipt.allowance = numericFields(body.opencode?.allowance ?? body['opencode.allowance'] ?? usage.opencode?.allowance);
  let value;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')); } catch { return { receipt, answer: null }; }
  if (!value || (typeof value.answer !== 'string' && value.answer !== null)
    || typeof value.abstained !== 'boolean' || !Array.isArray(value.citations)
    || !value.citations.every((item: unknown) => typeof item === 'string')) return { receipt, answer: null };
  const answer: MemoryEvaluationAnswer = { answer: value.answer, abstained: value.abstained, citations: value.citations };
  receipt.canonicalOutputHash = sha256(JSON.stringify(answer));
  receipt.abstained = answer.abstained;
  receipt.answerNull = answer.answer === null;
  receipt.citationCount = answer.citations.length;
  receipt.status = 'complete';
  return { receipt, answer };
}
