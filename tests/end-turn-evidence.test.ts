import { expect, it } from 'vitest';
import { digestText, inspectRequestEvidence, verifyToolTextOrigins } from 'cortico/core/evidence.ts';
import { functionCall, functionResult, inputItem } from 'cortico/protocol/open-responses/context.ts';
import type { GenerationEvidenceEnvelope, Persona, SessionDecl, ToolDef } from 'cortico/core/types.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { END_TURN_RECEIPT, isTrustedEndTurnReceipt, sourceMapEndTurnReceipts } from '../core/end-turn-evidence.ts';

it('keeps a live outputTap getter when wrapping sessions', () => {
  const tap = { onEvent() {} };
  const session: SessionDecl = {
    id: 'main', label: 'main', rounds: () => ({ soft: 1, hard: 1 }), persistent: true, receivesEvents: true,
    get outputTap() { return tap; },
    tools: () => [],
  };
  const persona = { declareSessions: () => [session] } as Pick<Persona, 'declareSessions'>;
  sourceMapEndTurnReceipts(persona);
  expect(persona.declareSessions()[0]!.outputTap).toBe(tap);
});

it('maps only the built-in end_turn receipt as Core-generated text', async () => {
  const tool = {
    name: 'end_turn', description: 'Ends the current turn.', tags: ['flow'], endsTurn: true,
    parameters: { type: 'object', properties: {}, required: [] }, handler: async () => END_TURN_RECEIPT,
  } as ToolDef;
  const session: SessionDecl = {
    id: 'main', label: 'main', rounds: () => ({ soft: 1, hard: 1 }), persistent: true, receivesEvents: true,
    tools: () => [tool],
  };
  const persona = { declareSessions: () => [session] } as Pick<Persona, 'declareSessions'>;
  sourceMapEndTurnReceipts(persona);

  const [wrapped] = persona.declareSessions()[0]!.tools();
  const result = await wrapped!.handler({}, {} as never);
  expect(result).toMatchObject({ text: END_TURN_RECEIPT });
  if (typeof result === 'string') throw new Error('Expected a mapped tool outcome');
  expect(isTrustedEndTurnReceipt('end_turn', result.text)).toBe(true);
  expect(isTrustedEndTurnReceipt('other', result.text)).toBe(false);
  expect(isTrustedEndTurnReceipt('end_turn', `${result.text} extra`)).toBe(false);

  const call = functionCall('call-1', 'end_turn', '{}', { responseId: 'response-1', responseStatus: 'completed' });
  const callItem = inputItem(call);
  const evidenceId = 'generation-end-turn';
  call.context = {
    ...call.context,
    generationEvidenceId: evidenceId,
    generationEvidenceItemDigest: digestText(JSON.stringify(callItem)),
  };
  const envelope: GenerationEvidenceEnvelope = {
    id: evidenceId, sessionId: 'main', sessionGenerationToken: 'fixture-token',
    providerGenerationId: 'fixture-generation', providerAttemptId: 'fixture-attempt', responseId: 'response-1',
    responseJoinState: 'matched', requestState: 'sent', exposedSources: [], mappingState: 'complete',
    actualEvidenceUsed: 'unknown',
    outputToolCalls: [{ toolCallId: 'call-1', responseId: 'response-1', outputDigest: digestText(JSON.stringify(callItem)), joinState: 'matched' }],
    items: [], serializedBodyDigest: digestText('fixture-request-body'),
  };
  const wireRequest: Request = { model: 'fixture-model', input: [callItem, inputItem(functionResult('call-1', result.text))], tools: [] };
  const body = {
    model: 'fixture-model',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'end_turn', arguments: '{}' } }] },
      { role: 'tool', content: result.text, tool_call_id: 'call-1' },
    ],
  };
  const unmarked = functionResult('call-1', result.text);
  const unmarkedRecords = [call, unmarked];
  const unmarkedRequest: Request = { ...wireRequest, input: unmarkedRecords.map(inputItem) };
  expect(inspectRequestEvidence(unmarkedRequest, unmarkedRecords, JSON.stringify(body), [envelope], undefined, [], 'main').mappingState).toBe('missing');

  const spans = verifyToolTextOrigins('end_turn', result.text, result.sourceMapSpans, isTrustedEndTurnReceipt);
  const receipt = functionResult('call-1', result.text, { sourceMapSpans: spans });
  const records = [call, receipt];
  const request: Request = { ...wireRequest, input: records.map(inputItem) };
  expect(inspectRequestEvidence(request, records, JSON.stringify(body), [envelope], undefined, [], 'main').mappingState).toBe('complete');
});
