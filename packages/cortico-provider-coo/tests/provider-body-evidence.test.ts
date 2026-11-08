import { expect, it } from 'vitest';
import { digestText, inspectRequestEvidence, toolSchemaDigest } from 'cortico/core/evidence.ts';
import type { GenerateOptions } from 'cortico/core/generation.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
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
