import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { responseRequest } from 'cortico/protocol/open-responses/context-helpers.ts';
import { ClaudeProvider } from '../src/anthropic/client.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixture() {
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-fixture', type: 'message', role: 'assistant', model: 'fixture-model',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { received, provider: new ClaudeProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture-key' }) };
}

it.each([false, true])('blocks a denied request before SDK network dispatch (streaming: %s)', async (streaming) => {
  const { provider, received } = await fixture();
  const context = [message('user', 'synthetic withheld text')];
  const request = responseRequest({ model: 'fixture-model', thinking: false }, context);
  let seen = 0;
  await expect(provider.respond(request, {
    context, diagnostic: true,
    ...(streaming ? { onEvent: () => {} } : {}),
    onRequestReady: () => { seen += 1; return false; },
  })).rejects.toThrow();
  expect(seen).toBe(1);
  expect(received).toEqual([]);
});

it('checks the exact serialized SDK body before a permitted dispatch', async () => {
  const { provider, received } = await fixture();
  const context = [message('user', 'synthetic ordinary message')];
  const request = responseRequest({ model: 'fixture-model', thinking: false }, context);
  let checked = '';
  let sent = 0;
  const result = await provider.respond(request, {
    context,
    onRequestReady: (info) => { checked = String(info.body); return true; },
    onRequestSent: () => { sent += 1; },
  });
  expect(received).toHaveLength(1);
  expect(checked).toBe(received[0]);
  expect(JSON.parse(checked).messages).toBeDefined();
  expect(sent).toBe(1);
  expect(result.attempts).toHaveLength(1);
});

it('keeps the evidence check attached to concurrent SDK requests', async () => {
  const { provider, received } = await fixture();
  const good = [message('user', 'allowed synthetic content')];
  const bad = [message('user', 'blocked synthetic content')];
  const [allowed, blocked] = await Promise.allSettled([
    provider.respond(responseRequest({ model: 'fixture-model', thinking: false }, good), { context: good, diagnostic: true, onRequestReady: () => true }),
    provider.respond(responseRequest({ model: 'fixture-model', thinking: false }, bad), { context: bad, diagnostic: true, onRequestReady: () => false }),
  ]);
  expect(allowed.status).toBe('fulfilled');
  expect(blocked.status).toBe('rejected');
  expect(received).toHaveLength(1);
  expect(received[0]).toContain('allowed synthetic content');
  expect(received[0]).not.toContain('blocked synthetic content');
});
