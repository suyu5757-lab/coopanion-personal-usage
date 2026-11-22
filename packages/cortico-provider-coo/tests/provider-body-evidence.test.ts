import { expect, it } from 'vitest';
import { digestText, inspectRequestEvidence, toolSchemaDigest } from 'cortico/core/evidence.ts';
import type { GenerationEvidenceEnvelope } from 'cortico/core/types.ts';
import type { GenerateOptions } from 'cortico/core/generation.ts';
import { functionCall, functionResult, message, record, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { responseRequest } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { buildResponsesBody } from 'cortico/providers/openai-responses-compat/native.ts';
import { VendorChat } from '../src/chat.ts';
import { claudeRequest } from '../src/anthropic/wire.ts';
import { geminiRequest } from '../src/gemini/wire.ts';

class ChatFixture extends VendorChat {
  body(request: Request, options: GenerateOptions): Record<string, unknown> { return this.buildResponseBody(request, options); }
}

it('maps complete synthetic requests in the supported provider wire formats', () => {
  const system = 'Controlled synthetic instruction.';
  const user = 'Ordinary synthetic user question.';
  const context = [
    message('system', system, { sourceIndependentSpans: [{ start: 0, end: system.length, digest: digestText(system), origin: 'core-generated' }] }),
    message('user', user, { sourceIndependentSpans: [{ start: 0, end: user.length, digest: digestText(user), origin: 'user-input' }] }),
  ];
  const tool = { name: 'fixture_lookup', description: 'A fixed synthetic tool.', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
  const digest = toolSchemaDigest(tool);
  if (!digest) throw new Error('Synthetic tool schema has no digest');
  for (const spec of [{ model: 'fixture-model', thinking: false }, { model: 'fixture-model', thinking: true, reasoningEffort: 'high' }] as const) {
  const request = responseRequest(spec, context, [tool]);
  const options: GenerateOptions = { context, nativeSpec: spec, sessionId: 'main' };
  const chat = new ChatFixture({ baseUrl: 'https://fixture.invalid' });
  const bodies: Array<[string, Record<string, unknown>]> = [
    ['responses', buildResponsesBody(request, options, {})],
    ['chat', chat.body(request, options)],
    ['messages', { ...claudeRequest(request, options).params, stream: false }],
    ['contents', geminiRequest(request, options)],
  ];
  for (const [label, body] of bodies) {
    expect(inspectRequestEvidence(request, context, JSON.stringify(body), [], undefined, [digest], 'main').mappingState, label).toBe('complete');
    expect(inspectRequestEvidence(request, context, JSON.stringify({ ...body, extra_provider_field: 'Unverified synthetic text.' }), [], undefined, [digest], 'main').mappingState, label).toBe('missing');
  }
  }
});

it('maps Chat tool continuations without replaying unrepresentable reasoning content', () => {
  const instruction = 'Synthetic instruction.';
  const userText = 'Synthetic user request.';
  const reasoningText = 'Private reasoning returned by the model.';
  const responseId = 'fixture-response';
  const evidenceId = 'fixture-generation-evidence';
  const system = message('system', instruction, { sourceIndependentSpans: [
    { start: 0, end: instruction.length, digest: digestText(instruction), origin: 'core-generated' },
  ] });
  const user = message('user', userText, { sourceIndependentSpans: [
    { start: 0, end: userText.length, digest: digestText(userText), origin: 'user-input' },
  ] });
  const reasoning = record({
    type: 'reasoning', id: 'rs_fixture', summary: [],
    content: [{ type: 'reasoning_text', text: reasoningText }],
  } as ContextRecord['item'], { responseId, responseStatus: 'completed' });
  const call = functionCall('fixture-call', 'fixture_lookup', '{"query":"synthetic"}', {
    responseId, responseStatus: 'completed',
  });
  const receipt = functionResult('fixture-call', '');
  const context = [system, user, reasoning, call, receipt];
  const tool = { name: 'fixture_lookup', description: 'A fixed synthetic tool.', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
  const spec = { model: 'fixture-model', thinking: true } as const;
  const request = responseRequest(spec, context, [tool]);
  if (!Array.isArray(request.input)) throw new Error('expected array input');
  const reasoningInput = request.input.find((item) => item.type === 'reasoning');
  const callInput = request.input.find((item) => item.type === 'function_call');
  if (reasoningInput?.type !== 'reasoning' || callInput?.type !== 'function_call') throw new Error('request evidence items are missing');
  const callDigest = digestText(JSON.stringify(callInput));
  const envelope: GenerationEvidenceEnvelope = {
    id: evidenceId, sessionId: 'main', sessionGenerationToken: 'fixture-token',
    providerGenerationId: 'fixture-generation', providerAttemptId: 'fixture-attempt', responseId,
    responseJoinState: 'matched', requestState: 'sent', exposedSources: [], mappingState: 'complete',
    actualEvidenceUsed: 'unknown',
    outputToolCalls: [{ toolCallId: callInput.call_id, responseId, outputDigest: callDigest, joinState: 'matched' }],
    outputReasoning: [{ itemDigest: digestText(JSON.stringify(reasoningInput)), summaryDigest: digestText(''), contentDigest: digestText(reasoningText) }],
    items: [], serializedBodyDigest: digestText('fixture-request-body'),
  };
  reasoning.context = {
    ...reasoning.context, generationEvidenceId: evidenceId,
    generationEvidenceItemDigest: digestText(JSON.stringify(reasoningInput)),
  };
  call.context = {
    ...call.context, generationEvidenceId: evidenceId,
    generationEvidenceItemDigest: callDigest,
  };

  const options: GenerateOptions = { context, nativeSpec: spec, sessionId: 'main' };
  const body = new ChatFixture({ baseUrl: 'https://fixture.invalid' }).body(request, options);
  const digest = toolSchemaDigest(tool);
  if (!digest) throw new Error('Synthetic tool schema has no digest');
  expect(JSON.stringify(body)).not.toContain(reasoningText);
  expect(inspectRequestEvidence(request, context, JSON.stringify(body), [envelope], undefined, [digest], 'main').mappingState).toBe('complete');
});
