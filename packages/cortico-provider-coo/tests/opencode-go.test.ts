import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { secretReader } from 'cortico/core/secrets.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { LLMProviderEntry, Logger } from 'cortico/core/types.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import COO, {
  GO_TIERS, OPENCODE_GO, VENDORS, fetchGoCatalog, goEffortMap, goHeaders, goModelsUrl, goRequestUrl, goSessionHeader, goTierSupport,
  isGoModelId, isGoRequestUrl, normalizeGoBaseUrl, parseOpenCodeGoModels, readGoCatalog, redactSecret, type GoModel,
} from '../src/index.ts';
import { connectVendor, type WebUiCall } from '../src/connect.ts';
import { goMessagesBaseUrl } from '../src/opencode-go.ts';

const KEY = 'oc_sk_fake_go_test_1017';
const VERSION = '0.4.0-b0';
const previousTestEnv = {
  CORTICO_TEST_CHANNEL: process.env.CORTICO_TEST_CHANNEL,
  COOPANION_LOCAL_PROVIDER_SIMULATOR: process.env.COOPANION_LOCAL_PROVIDER_SIMULATOR,
  COOPANION_GO_MAX_OUTPUT_TOKENS: process.env.COOPANION_GO_MAX_OUTPUT_TOKENS,
};
process.env.CORTICO_TEST_CHANNEL = '1';
process.env.COOPANION_LOCAL_PROVIDER_SIMULATOR = '1';
process.env.COOPANION_GO_MAX_OUTPUT_TOKENS = '1024';

type GoListed = GoModel & { tiers: Record<string, boolean>; effort: Record<string, string | null> };

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.COOPANION_VERSION;
});

afterAll(() => {
  for (const [name, value] of Object.entries(previousTestEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'go-catalog-'));
  dirs.push(root);
  return join(root, 'providers', 'opencode-go');
}

function catalog(base: string) {
  return {
    object: 'list',
    data: [
      {
        id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', modalities: { input: ['text', 'image/png'] },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['low', 'high', 'max'] } },
        limit: { context: 1_000_000, output: 384_000 },
        api: { 'chat-completions': { base_url: `${base}/inference/go/openai/v1` } },
      },
      {
        id: 'gpt-6-luna', name: 'GPT 6 Luna', modalities: { input: ['text', 'image/png'] },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] } },
        limit: { context: 1_050_000, output: 128_000 },
        api: { responses: { base_url: `${base}/inference/go/openai/v1` } },
      },
      {
        id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', modalities: { input: ['text', 'image/png'] },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, toggle: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] } },
        limit: { context: 1_000_000, output: 128_000 },
        api: { messages: { base_url: `${base}/inference/go/anthropic/v1` } },
      },
      {
        id: 'gemini-4-argon', name: 'Gemini 4 Argon', modalities: { input: ['text', 'image/png'] },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['low', 'medium', 'high'] } },
        limit: { context: 1_048_576, output: 65_536 },
        api: { 'generate-content': { base_url: `${base}/inference/go/google/v1beta` } },
      },
      {
        id: 'kimi-k3', name: 'Kimi K3', modalities: { input: ['text', 'image/png'] },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['max'] } },
        limit: { context: 1_048_576, output: 131_072 },
        api: { 'chat-completions': { base_url: `${base}/inference/go/openai/v1` } },
      },
      {
        id: 'glm-5.2', name: 'GLM-5.2', modalities: { input: ['text'] },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['high', 'max'] } },
        limit: { context: 1_000_000, output: 131_072 },
        api: { 'chat-completions': { base_url: `${base}/inference/go/openai/v1` } },
      },
      {
        id: 'minimax-m3', name: 'MiniMax-M3', modalities: { input: ['text', 'image/png'] },
        capabilities: { tools: { supported: true }, reasoning: { supported: true, toggle: true } },
        limit: { context: 1_000_000, output: 131_072 },
        api: { messages: { base_url: `${base}/inference/go/anthropic/v1` } },
      },
    ],
  };
}

function chatBody(model: string, content = '好') {
  return { id: 'chat-1', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

function responsesBody(model: string, text = '好') {
  return {
    id: 'resp-1', object: 'response', model, status: 'completed', created_at: 1,
    output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

function anthropicBody(model: string, text = '好') {
  return { id: 'msg-1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}

function geminiBody(text = '好') {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
}

interface Seen { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }

/** A local service that answers each Go API family; `answers` may replace the model catalogue. */
async function goServer(options: {
  catalogue?: (base: string) => unknown;
  fail?: (seen: Seen, res: import('node:http').ServerResponse) => boolean;
  redirect?: (seen: Seen) => string | undefined;
  reply?: (seen: Seen, model: string, inferenceNumber: number) => unknown;
} = {}) {
  const seen: Seen[] = [];
  let base = '';
  base = await serve(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = (req.url ?? '').split('?')[0]!;
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { body = {}; }
    const row = { path, headers: req.headers, body };
    seen.push(row);
    const redirectTo = options.redirect?.(row);
    if (redirectTo) {
      res.writeHead(302, { location: redirectTo }).end();
      return;
    }
    if (path === '/inference/go/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify((options.catalogue ?? catalog)(base)));
      return;
    }
    if (options.fail?.(row, res)) return;
    const model = String(body.model ?? 'model');
    if (path.endsWith('/chat/completions')) {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'chat-1', model, choices: [{ index: 0, delta: { role: 'assistant', content: '好' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'chat-1', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'chat-1', model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        const inferenceNumber = seen.filter((entry) => entry.path.endsWith('/chat/completions')).length;
        const body = options.reply?.(row, model, inferenceNumber) ?? chatBody(model);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      }
      return;
    }
    if (path.endsWith('/responses')) {
      if (body.stream) {
        const output = responsesBody(model).output;
        const events = [
          { type: 'response.created', response: { id: 'resp-1', object: 'response', model, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', output_index: 0, item_id: 'm1', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', content_index: 0, delta: '好' },
          { type: 'response.output_text.done', output_index: 0, item_id: 'm1', content_index: 0, text: '好' },
          { type: 'response.content_part.done', output_index: 0, item_id: 'm1', content_index: 0, part: { type: 'output_text', text: '好', annotations: [] } },
          { type: 'response.output_item.done', output_index: 0, item: output[0] },
          { type: 'response.completed', response: responsesBody(model) },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [index, event] of events.entries()) res.write(`data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`);
        res.end();
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(responsesBody(model)));
      return;
    }
    if (path.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(anthropicBody(model)));
      return;
    }
    if (path.includes(':generateContent')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(geminiBody()));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  return { base, seen };
}

function entry(base: string, model: string, patch: Partial<LLMProviderEntry> = {}): LLMProviderEntry {
  return {
    kind: 'coo', baseUrl: `${base}/inference/go/openai/v1`, secret: 'OPENCODE_GO_API_KEY',
    spec: { model, thinking: true, reasoningEffort: 'high' }, multimodal: true, ...patch,
  };
}

function host(stateDir: string, secret: string | ((name: string) => string) = KEY, log: Logger = nullLogger()) {
  return { stateDir, secret: typeof secret === 'string' ? () => secret : secret, readBlob: () => null, keepThinking: () => true, log };
}

function captureLogger(): { log: Logger; stages: Array<Record<string, unknown>> } {
  const stages: Array<Record<string, unknown>> = [];
  const log: Logger = {
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    emit: (_level, _message, options) => {
      if (options?.event === 'opencode-go-stage' && options.data && typeof options.data === 'object') {
        stages.push(options.data as Record<string, unknown>);
      }
    },
    child: () => log,
  };
  return { log, stages };
}

const request = (model: string, text = '在吗'): Request => ({ model, max_output_tokens: 4096, input: [message('user', text).item] } as unknown as Request);

describe('OpenCode Go target validation', () => {
  it('accepts the four exact official protocol bases and rejects URL and model-path lookalikes', () => {
    const cases = [
      ['chat', 'https://opencode.ai/inference/go/openai/v1'],
      ['responses', 'https://opencode.ai/inference/go/openai/v1'],
      ['anthropic', 'https://opencode.ai/inference/go/anthropic/v1'],
      ['gemini', 'https://opencode.ai/inference/go/google/v1beta'],
    ] as const;
    for (const [protocol, url] of cases) expect(normalizeGoBaseUrl(url, protocol)).toBe(url);
    for (const url of [
      'https://opencode.ai.attacker.invalid/inference/go/openai/v1',
      'https://attacker.invalid/inference/go/openai/v1',
      'http://opencode.ai/inference/go/openai/v1',
      'https://opencode.ai:8443/inference/go/openai/v1',
      'https://opencode.ai:443/inference/go/openai/v1',
      'https://user:pass@opencode.ai/inference/go/openai/v1',
      'https://opencode.ai/inference/go/openai/v1/extra',
      'https://opencode.ai/other/inference/go/openai/v1',
      'https://opencode.ai/inference/go/openai%2fv1',
      'https://opencode.ai/inference/go/openai/v1?next=https://attacker.invalid',
    ]) expect(normalizeGoBaseUrl(url, 'chat')).toBeUndefined();
    expect(normalizeGoBaseUrl('https://opencode.ai/inference/go/google/v1beta', 'chat')).toBeUndefined();
    expect(isGoModelId('gemini-4-argon')).toBe(true);
    for (const id of ['../other', 'gemini-4-argon:generateContent', 'model%2fother', 'model?next=other']) {
      expect(isGoModelId(id)).toBe(false);
      expect(() => goRequestUrl('https://opencode.ai/inference/go/google/v1beta', 'gemini', id)).toThrow();
    }
    const gemini = 'https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse';
    expect(goRequestUrl('https://opencode.ai/inference/go/google/v1beta', 'gemini', 'gemini-4-argon', true)).toBe(gemini);
    expect(isGoRequestUrl(gemini, 'https://opencode.ai/inference/go/google/v1beta', 'gemini', 'gemini-4-argon', true)).toBe(true);
    expect(isGoRequestUrl(gemini.replace('opencode.ai', 'opencode.ai.attacker.invalid'), 'https://opencode.ai/inference/go/google/v1beta', 'gemini', 'gemini-4-argon', true)).toBe(false);
    const messages = 'https://opencode.ai/inference/go/anthropic/v1/messages';
    expect(isGoRequestUrl(messages, 'https://opencode.ai/inference/go/anthropic/v1', 'anthropic', 'claude-haiku-5-5')).toBe(true);
    expect(isGoRequestUrl(messages + '?beta=true', 'https://opencode.ai/inference/go/anthropic/v1', 'anthropic', 'claude-haiku-5-5')).toBe(true);
    expect(isGoRequestUrl(messages + '?next=https://attacker.invalid', 'https://opencode.ai/inference/go/anthropic/v1', 'anthropic', 'claude-haiku-5-5')).toBe(false);
  });

  it('allows loopback catalogues only when the local simulator is explicitly enabled', () => {
    const local = 'http://127.0.0.1:18992/inference/go/openai/v1';
    expect(normalizeGoBaseUrl(local, 'chat')).toBeUndefined();
    expect(normalizeGoBaseUrl(local, 'chat', true)).toBe(local);
    expect(normalizeGoBaseUrl('http://192.168.1.5:18992/inference/go/openai/v1', 'chat', true)).toBeUndefined();
    expect(goModelsUrl(local, true)).toBe('http://127.0.0.1:18992/inference/go/v1/models');
  });

  it('blocks an OpenCode Go key on an unrecognized external endpoint before reading the secret', () => {
    let secretReads = 0;
    const unsafeHost = { ...host(tempDir()), secret: () => { secretReads++; return KEY; } };
    expect(() => COO.create(OPENCODE_GO, entry('https://opencode.ai.attacker.invalid', 'deepseek-v4.1-flash'), unsafeHost as never))
      .toThrow('OpenCode Go API key cannot be used with this endpoint');
    expect(secretReads).toBe(0);
  });

  it('drops a tampered disk-catalogue URL and blocks dispatch without a validated model row', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.opencode-go-models.json'), JSON.stringify({ version: 1, models: [{
      id: 'deepseek-v4.1-flash', inputImages: false, protocol: 'chat',
      baseUrl: 'https://opencode.ai.attacker.invalid/inference/go/openai/v1',
      efforts: null, toggle: false, reasoning: false,
    }] }));
    expect(readGoCatalog(dir)).toEqual([]);
    const instance = COO.create(OPENCODE_GO, entry('http://127.0.0.1:18992', 'deepseek-v4.1-flash'), host(dir) as never);
    await expect(instance.client.respond(request('deepseek-v4.1-flash'))).rejects.toThrow('validated catalogue model');
  });
});

describe('OpenCode Go catalogue and routing', () => {
  it('reads the catalogue at run time, keeps each model protocol and its stated limits, and caches metadata without the key', async () => {
    process.env.COOPANION_VERSION = VERSION;
    const { base, seen } = await goServer();
    const dir = tempDir();
    const instance = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never);
    const models = await instance.listModels!() as unknown as GoListed[];
    expect(seen[0]!.path).toBe('/inference/go/v1/models');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers['user-agent']).toBe(`Coopanion/${VERSION}`);
    expect(models.map((model) => model.id)).toEqual([
      'deepseek-v4.1-flash', 'gpt-6-luna', 'claude-haiku-5-5', 'gemini-4-argon', 'kimi-k3', 'glm-5.2', 'minimax-m3',
    ]);
    expect(models.find((model) => model.id === 'gpt-6-luna')).toMatchObject({
      protocol: 'responses', contextWindow: 1_050_000, maxOutputTokens: 128_000, inputImages: true,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], tiers: { off: true, low: true, high: true, max: true },
    });
    expect(models.find((model) => model.id === 'claude-haiku-5-5')).toMatchObject({ protocol: 'anthropic', toggle: true });
    expect(models.find((model) => model.id === 'gemini-4-argon')).toMatchObject({ protocol: 'gemini' });
    expect(models.find((model) => model.id === 'glm-5.2')).toMatchObject({ inputImages: false, tiers: { off: false, low: false, high: true, max: true } });
    const cached = readFileSync(join(dirname(dir), '.opencode-go-catalogs', `${basename(dir)}.json`), 'utf8');
    expect(cached).not.toContain(KEY);
    expect(cached).not.toContain('Authorization');
    expect(cached).toContain('claude-haiku-5-5');
  });

  it('keeps a preview catalogue outside the endpoint name and reads it after save', async () => {
    const { base, seen } = await goServer();
    const dir = tempDir();
    const preview = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never);
    await preview.listModels!();
    expect(existsSync(dir)).toBe(false);
    expect(readGoCatalog(dir, true).map((model) => model.id)).toContain('deepseek-v4.1-flash');

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ kind: 'coo' }));
    const saved = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never);
    await saved.client.respond(request('deepseek-v4.1-flash'), { diagnostic: true });
    expect(seen.filter((row) => row.path !== '/inference/go/v1/models').map((row) => row.path)).toEqual([
      '/inference/go/openai/v1/chat/completions',
    ]);
  });

  it('routes each model by the catalogue protocol and base URL, with the bearer key, the Coopanion user agent and one stable session per conversation', async () => {
    process.env.COOPANION_VERSION = VERSION;
    const { base, seen } = await goServer();
    const dir = tempDir();
    await COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never).listModels!();
    const send = async (model: string, sessionId: string) => {
      const instance = COO.create(OPENCODE_GO, entry(base, model), host(dir) as never);
      return instance.client.respond(request(model), { sessionId, diagnostic: true });
    };
    await send('deepseek-v4.1-flash', 'session-A');
    await send('gpt-6-luna', 'session-A');
    await send('claude-haiku-5-5', 'session-A');
    await send('gemini-4-argon', 'session-A');
    await send('deepseek-v4.1-flash', 'session-B');
    const calls = seen.filter((row) => row.path !== '/inference/go/v1/models');
    expect(calls.map((row) => row.path)).toEqual([
      '/inference/go/openai/v1/chat/completions',
      '/inference/go/openai/v1/responses',
      '/inference/go/anthropic/v1/messages',
      '/inference/go/google/v1beta/models/gemini-4-argon:generateContent',
      '/inference/go/openai/v1/chat/completions',
    ]);
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers['user-agent']).toBe(`Coopanion/${VERSION}`);
      expect(String(call.body.model)).not.toContain('opencode-go/');
    }
    expect(calls.filter((row) => !row.path.includes(':generateContent')).map((row) => row.body.model)).toEqual([
      'deepseek-v4.1-flash', 'gpt-6-luna', 'claude-haiku-5-5', 'deepseek-v4.1-flash',
    ]);
    expect(calls[3]!.path).toContain('/models/gemini-4-argon:generateContent');
    expect(calls[0]!.body.max_tokens).toBe(1024);
    expect(calls[1]!.body.max_output_tokens).toBe(1024);
    expect(calls[2]!.body.max_tokens).toBe(1024);
    expect((calls[3]!.body.generationConfig as { maxOutputTokens?: number }).maxOutputTokens).toBe(1024);
    expect(calls.map((row) => row.headers['x-opencode-session'])).toEqual([
      'coopanion-session-A', 'coopanion-session-A', 'coopanion-session-A', 'coopanion-session-A', 'coopanion-session-B',
    ]);
    expect(seen.filter((row) => row.path !== '/inference/go/v1/models').every((row) => row.headers['x-api-key'] === undefined && row.headers['x-goog-api-key'] === undefined)).toBe(true);
  });

  it('fails catalogue and all four inference redirects before following them', async () => {
    let redirectedHits = 0;
    const target = await serve((_req, res) => {
      redirectedHits++;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    let redirect = false;
    const { base, seen } = await goServer({ redirect: () => redirect ? target : undefined });
    const dir = tempDir();
    const catalogClient = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never);
    redirect = true;
    await expect(catalogClient.listModels!()).rejects.toThrow();
    expect(redirectedHits).toBe(0);
    redirect = false;
    await catalogClient.listModels!();
    redirect = true;
    for (const model of ['deepseek-v4.1-flash', 'gpt-6-luna', 'claude-haiku-5-5', 'gemini-4-argon']) {
      const instance = COO.create(OPENCODE_GO, entry(base, model), host(dir) as never);
      await expect(instance.client.respond(request(model), { diagnostic: true })).rejects.toThrow();
    }
    expect(redirectedHits).toBe(0);
    expect(seen.some((row) => row.headers.authorization !== 'Bearer ' + KEY)).toBe(false);
  });

  it('sends the reasoning value the catalogue states for the model, and leaves it out where the model takes only a toggle', async () => {
    const { base, seen } = await goServer();
    const dir = tempDir();
    await COO.create(OPENCODE_GO, entry(base, 'glm-5.2'), host(dir) as never).listModels!();
    const call = async (model: string, reasoningEffort: string) => COO.create(OPENCODE_GO, entry(base, model, { spec: { model, thinking: true, reasoningEffort } }), host(dir) as never)
      .client.respond({ ...request(model), reasoning: { effort: reasoningEffort } } as unknown as Request, {});
    await call('glm-5.2', 'max');
    await call('kimi-k3', 'max');
    await call('minimax-m3', 'high');
    const bodies = seen.filter((row) => row.path.endsWith('/chat/completions') || row.path.endsWith('/v1/messages')).map((row) => row.body);
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'max' });
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'max' });
    expect(bodies[2]).not.toHaveProperty('reasoning');
    expect(bodies[2]).not.toHaveProperty('output_config');
  });

  it('follows a catalogue that changes between reads instead of a model list written into the code', async () => {
    let extra = false;
    const { base } = await goServer({
      catalogue: (url) => {
        const list = catalog(url);
        if (!extra) return list;
        return { ...list, data: [...list.data, {
          id: 'future-model', name: 'Future Model', modalities: { input: ['text'] },
          capabilities: { reasoning: { supported: true, effort: ['high'] } }, limit: { context: 10_000, output: 1_000 },
          api: { 'chat-completions': { base_url: `${url}/inference/go/openai/v1` } },
        }] };
      },
    });
    const dir = tempDir();
    const first = await COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never).listModels!();
    expect(first.map((model) => model.id)).not.toContain('future-model');
    extra = true;
    const second = await COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never).listModels!();
    expect(second.map((model) => model.id)).toContain('future-model');
  });

  it('streams Chat Completions and Responses answers', async () => {
    const { base } = await goServer();
    const dir = tempDir();
    await COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never).listModels!();
    for (const model of ['deepseek-v4.1-flash', 'gpt-6-luna']) {
      const events: string[] = [];
      const out = await COO.create(OPENCODE_GO, entry(base, model), host(dir) as never)
        .client.respond(request(model), { sessionId: 'stream', onEvent: (event) => events.push(event.type) });
      expect(out.response.output.find((item) => item.type === 'message')).toMatchObject({ content: [{ text: '好' }] });
      expect(events).toContain('response.output_text.delta');
    }
  });

  it('answers directly and carries a tool receipt into the next Go generation with metadata-only stages', async () => {
    const { base, seen } = await goServer({
      reply: (_row, model, inferenceNumber) => inferenceNumber === 1
        ? chatBody(model, 'A direct synthetic answer.')
        : inferenceNumber === 2
          ? {
            id: 'chat-tool', model,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{
              id: 'memory-search-1', type: 'function',
              function: { name: 'memory_search', arguments: '{"query":"synthetic jasmine tea"}' },
            }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }
          : inferenceNumber === 3
            ? chatBody(model, 'The synthetic preference is jasmine tea.')
            : {
              id: 'chat-refusal', model,
              choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'This synthetic request cannot be answered.' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
            },
    });
    const captured = captureLogger();
    const dir = tempDir();
    const instance = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir, KEY, captured.log));
    await instance.listModels!();

    const direct = await instance.client.respond(request('deepseek-v4.1-flash', 'Say hello.'), {
      sessionId: 'synthetic-session', diagnostic: true,
    });
    expect(direct.response.output.find((item) => item.type === 'message')).toMatchObject({
      content: [{ text: 'A direct synthetic answer.' }],
    });

    const search = await instance.client.respond(request('deepseek-v4.1-flash', 'What synthetic preference was saved?'), {
      sessionId: 'synthetic-session',
    });
    const call = search.response.output.find((item) => item.type === 'function_call');
    expect(call).toMatchObject({ type: 'function_call', name: 'memory_search', call_id: 'memory-search-1' });
    const context = [
      message('user', 'What synthetic preference was saved?'),
      functionCall('memory-search-1', 'memory_search', '{"query":"synthetic jasmine tea"}', { generationEvidenceId: 'evidence-fixture' }),
      functionResult('memory-search-1', '[synthetic source result] Jasmine tea.', {
        generationEvidenceId: 'evidence-fixture', toolReceiptRef: 'tool-call:run-test:1',
      }),
    ];
    const continued = await instance.client.respond({
      ...request('deepseek-v4.1-flash', 'What synthetic preference was saved?'),
      input: context.map((record) => record.item) as Request['input'],
    }, { sessionId: 'synthetic-session', context });
    expect(continued.response.output.find((item) => item.type === 'message')).toMatchObject({
      content: [{ text: 'The synthetic preference is jasmine tea.' }],
    });
    const refused = await instance.client.respond(request('deepseek-v4.1-flash', 'Try a separate synthetic request.'), {
      sessionId: 'synthetic-session',
    });
    expect(refused.response.output.find((item) => item.type === 'message')).toMatchObject({
      content: [{ type: 'refusal', refusal: 'This synthetic request cannot be answered.' }],
    });

    const requests = seen.filter((record) => record.path.endsWith('/chat/completions'));
    expect(requests).toHaveLength(4);
    const messages = requests[2]!.body.messages as Array<Record<string, unknown>>;
    expect(messages.some((item) => item.role === 'assistant' && Array.isArray(item.tool_calls))).toBe(true);
    expect(messages.some((item) => item.role === 'tool' && item.tool_call_id === 'memory-search-1')).toBe(true);
    const stages = captured.stages.map((record) => record.stage);
    for (const stage of ['core-accepted', 'provider-prepared', 'guard-passed', 'request-dispatched', 'http-status',
      'tool-calls-returned', 'tool-receipt', 'continuation-started', 'provider-final-reply-received']) {
      expect(stages).toContain(stage);
    }
    const diagnostic = JSON.stringify(captured.stages);
    for (const privateText of [KEY, 'Say hello.', 'What synthetic preference was saved?', '[synthetic source result] Jasmine tea.',
      'This synthetic request cannot be answered.', 'tool-call:run-test:1']) expect(diagnostic).not.toContain(privateText);
    expect(requests[0]!.headers['x-opencode-session']).toBe('coopanion-synthetic-session');
    expect(captured.stages.some((record) => record.stage === 'request-dispatched' && record.observedBy === 'provider-attempt')).toBe(true);
  });

  it('reports a Core evidence rejection as not dispatched without an HTTP request', async () => {
    const { base, seen } = await goServer();
    const captured = captureLogger();
    const dir = tempDir();
    const instance = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir, KEY, captured.log));
    await instance.listModels!();

    await expect(instance.client.respond(request('deepseek-v4.1-flash'), {
      sessionId: 'synthetic-session', onRequestReady: () => false,
    })).rejects.toThrow(/blocked by the Core evidence check before dispatch/);

    expect(seen.some((record) => record.path.endsWith('/chat/completions'))).toBe(false);
    expect(captured.stages.map((record) => record.stage)).toContain('request-not-dispatched');
    expect(captured.stages.some((record) => record.stage === 'guard-failed' && record.guard === 'core-evidence')).toBe(true);
    expect(captured.stages.some((record) => record.stage === 'http-status')).toBe(false);
  });

  it('keeps a continuation HTTP failure correlated to its dispatched attempt', async () => {
    const { base, seen } = await goServer({
      fail: (record, response) => {
        if (!record.path.endsWith('/chat/completions')
          || seen.filter((entry) => entry.path.endsWith('/chat/completions')).length !== 2) return false;
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'synthetic service failure' } }));
        return true;
      },
      reply: (_row, model) => ({
        id: 'chat-tool', model,
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{
          id: 'memory-search-1', type: 'function',
          function: { name: 'memory_search', arguments: '{"query":"synthetic jasmine tea"}' },
        }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
    });
    const captured = captureLogger();
    const dir = tempDir();
    const instance = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir, KEY, captured.log));
    await instance.listModels!();
    const first = await instance.client.respond(request('deepseek-v4.1-flash'), { sessionId: 'synthetic-session' });
    const call = first.response.output.find((item) => item.type === 'function_call');
    expect(call).toMatchObject({ call_id: 'memory-search-1', name: 'memory_search' });
    const context = [
      message('user', 'What synthetic preference was saved?'),
      functionCall('memory-search-1', 'memory_search', '{"query":"synthetic jasmine tea"}', { generationEvidenceId: 'evidence-fixture' }),
      functionResult('memory-search-1', '[synthetic source result] Jasmine tea.', {
        generationEvidenceId: 'evidence-fixture', toolReceiptRef: 'tool-call:run-test:2',
      }),
    ];
    const error = await instance.client.respond({
      ...request('deepseek-v4.1-flash', 'What synthetic preference was saved?'),
      input: context.map((record) => record.item) as Request['input'],
    }, { sessionId: 'synthetic-session', context }).then(() => null, (value: unknown) => value as Error & { status?: number; attempts?: Array<{ status: number | null }> });
    expect(error).toMatchObject({ status: 400, attempts: [{ status: 400 }] });
    expect(error!.message).toContain('request failed (400)');
    expect(captured.stages.some((record) => record.stage === 'http-status' && record.status === 400)).toBe(true);
    expect(captured.stages.some((record) => record.stage === 'generation-failed' && record.errorCategory === 'http-400')).toBe(true);
  });

  it('records a cancelled Go request as not dispatched', async () => {
    const { base, seen } = await goServer();
    const captured = captureLogger();
    const dir = tempDir();
    const instance = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir, KEY, captured.log));
    await instance.listModels!();
    const controller = new AbortController();
    controller.abort(new Error('synthetic cancellation'));

    await expect(instance.client.respond(request('deepseek-v4.1-flash'), {
      sessionId: 'synthetic-session', signal: controller.signal,
    })).rejects.toThrow(/timed out or was cancelled/);
    expect(seen.some((record) => record.path.endsWith('/chat/completions'))).toBe(false);
    expect(captured.stages.some((record) => record.stage === 'request-not-dispatched' && record.reason === 'cancelled')).toBe(true);
  });

  it('names a refused key, a denied workspace, a usage limit, an unavailable model and a timeout, and never repeats the key', async () => {
    let failStatus = 0;
    const { base } = await goServer({
      fail: (_row, res) => {
        if (!failStatus) return false;
        res.writeHead(failStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `upstream echoed ${KEY}` } }));
        return true;
      },
    });
    const dir = tempDir();
    await COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never).listModels!();
    const status = async (code: number, model = 'deepseek-v4.1-flash') => {
      const instance = COO.create(OPENCODE_GO, entry(base, model, { spec: { model, thinking: true, reasoningEffort: 'low' } }), host(dir) as never);
      failStatus = code;
      try {
        await instance.client.respond(request(model), { diagnostic: true });
        throw new Error('expected a failure');
      } catch (error) {
        return error as Error & { status?: number; body?: string };
      } finally {
        failStatus = 0;
      }
    };
    const refused = await status(401);
    expect(refused.message).toContain('rejected the API key (401)');
    expect(refused.status).toBe(401);
    expect(refused.message).not.toContain(KEY);
    expect(refused.body).not.toContain(KEY);
    expect((refused as Error & { cause?: { body?: string } }).cause?.body ?? '').not.toContain(KEY);
    expect((await status(403)).message).toContain('denied the request (403)');
    expect((await status(429)).message).toContain('usage limit or rate limit reached (429)');
    const missing = await status(404, 'gpt-6-luna');
    expect(missing.message).toContain('gpt-6-luna');
    expect(missing.message).toContain('unavailable (404)');
  });

  it('names an unanswered request as a timeout instead of a generic network failure', async () => {
    const { base } = await goServer({ fail: (row) => row.path !== '/inference/go/v1/models' });
    const dir = tempDir();
    const instance = COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir) as never);
    await instance.listModels!();
    await expect(instance.client.respond(request('deepseek-v4.1-flash'), { diagnostic: true, signal: AbortSignal.timeout(50) }))
      .rejects.toThrow(/timed out or was cancelled/);
  });

  it('redacts the key from the header helpers and a thrown transport error', () => {
    expect(goHeaders(KEY, 's')).toMatchObject({ Authorization: `Bearer ${KEY}`, 'User-Agent': 'Coopanion/dev', 'x-opencode-session': 's' });
    expect(goSessionHeader(undefined, 'probe')).toBe('coopanion-probe');
    expect(goHeaders(KEY, undefined)).not.toHaveProperty('x-opencode-session');
    expect(redactSecret(`key ${KEY}; Bearer ${KEY}`, KEY)).toBe('key [redacted]; Bearer [redacted]');
    expect(goModelsUrl('https://opencode.ai/inference/go/openai/v1')).toBe('https://opencode.ai/inference/go/v1/models');
    expect(goModelsUrl('http://127.0.0.1:9/inference/go/anthropic/v1', true)).toBe('http://127.0.0.1:9/inference/go/v1/models');
    expect(goMessagesBaseUrl('https://opencode.ai/inference/go/anthropic/v1')).toBe('https://opencode.ai/inference/go/anthropic');
  });
});

describe('catalogue metadata maps to the four thinking tiers', () => {
  const model = (patch: Partial<GoModel>): GoModel => ({ id: 'm', inputImages: false, protocol: 'chat', efforts: null, toggle: false, reasoning: true, ...patch });

  it('offers only the levels the model names, with the nearest spelling', () => {
    expect(goTierSupport(model({ efforts: ['none', 'minimal', 'medium', 'xhigh'] }))).toEqual({ off: true, low: true, high: true, max: true });
    expect(goTierSupport(model({ efforts: ['high', 'max'] }))).toEqual({ off: false, low: false, high: true, max: true });
    expect(goTierSupport(model({ efforts: ['max'] }))).toEqual({ off: false, low: false, high: false, max: true });
    expect(goTierSupport(model({ toggle: true }))).toEqual({ off: true, low: true, high: false, max: false });
    expect(goTierSupport(model({ reasoning: false }))).toEqual({ off: true, low: false, high: false, max: false });
    expect(goEffortMap(model({ efforts: ['minimal', 'medium', 'xhigh'] }))).toEqual({ off: null, low: 'minimal', high: 'medium', max: 'xhigh' });
    expect(GO_TIERS).toEqual(['off', 'low', 'high', 'max']);
  });

  it('parses the documented catalogue shape and skips an API family this provider cannot send', () => {
    const parsed = parseOpenCodeGoModels({
      data: [
        { id: 'a', name: 'A', modalities: { input: ['text', 'image/jpeg'] }, capabilities: { reasoning: { supported: true, effort: ['high'] } }, limit: { context: 10, output: 5 }, api: { responses: { base_url: 'https://opencode.ai/inference/go/openai/v1' } } },
        { id: 'b', api: { unknown: { base_url: 'https://x' } } },
        { id: 'fake-domain', api: { 'chat-completions': { base_url: 'https://opencode.ai.attacker.invalid/inference/go/openai/v1' } } },
        { id: 'bad-model/id', api: { 'generate-content': { base_url: 'https://opencode.ai/inference/go/google/v1beta' } } },
        { api: {} },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ id: 'a', protocol: 'responses', contextWindow: 10, maxOutputTokens: 5, inputImages: true, efforts: ['high'] });
    expect(parsed[1]).toMatchObject({ id: 'b', protocol: null });
  });
});

describe('the endpoint keeps the key out of its config and restores it from .env', () => {
  it('reads a key from .env, sees a changed key after a rewrite, and sends no Authorization after the file is cleared', async () => {
    const { base, seen } = await goServer();
    const dir = tempDir();
    const envFile = join(dir, '.env');
    const make = () => COO.create(OPENCODE_GO, entry(base, 'deepseek-v4.1-flash'), host(dir, secretReader(envFile)) as never);
    mkdirSync(dir, { recursive: true });
    writeFileSync(envFile, `OPENCODE_GO_API_KEY=${KEY}\n`);
    await make().listModels!();
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    writeFileSync(envFile, 'OPENCODE_GO_API_KEY=oc_sk_replaced\n');
    await make().listModels!();
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer oc_sk_replaced');
    writeFileSync(envFile, '');
    await make().listModels!();
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
    expect(readFileSync(join(dirname(dir), '.opencode-go-catalogs', `${basename(dir)}.json`), 'utf8')).not.toContain('oc_sk_');
  });
});

describe('connecting OpenCode Go through the WebUI routes', () => {
  it('saves the selected model, protocol, thinking level, image support and context window, with the key only in secretValue', async () => {
    const calls: Array<[string, unknown]> = [];
    const call = (async (path: string, body?: unknown) => {
      calls.push([path, body]);
      if (path === '/api/providers' && body === undefined) return { providers: [] };
      if (path.endsWith('/test')) return { ok: true, elapsedMs: 10 };
      return {};
    }) as WebUiCall;
    const go = VENDORS.find((item) => item.id === OPENCODE_GO)!;
    const result = await connectVendor(call, go, KEY, 'gpt-6-luna', 'cn', {
      protocol: 'responses', thinking: true, reasoningEffort: 'max', multimodal: true, contextWindow: 1_050_000,
    });
    expect(result).toEqual({ ok: true, ms: 10, why: null });
    const create = calls.find(([path, body]) => path === '/api/providers' && body !== undefined)!;
    const payload = create[1] as { entry: Record<string, unknown>; secretValue: string };
    expect(payload.secretValue).toBe(KEY);
    expect(JSON.stringify(payload.entry)).not.toContain(KEY);
    expect(payload.entry).toMatchObject({
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      secret: 'OPENCODE_GO_API_KEY',
      multimodal: true,
      options: { protocol: 'responses' },
      spec: { model: 'gpt-6-luna', thinking: true, reasoningEffort: 'max', contextWindow: 1_050_000 },
    });
  });

  it('loads a catalogue model before testing a Guide connection', async () => {
    const calls: string[] = [];
    let catalogLoaded = false;
    const call = (async (path: string, body?: unknown) => {
      calls.push(path);
      if (path === '/api/providers' && body === undefined) return { providers: [] };
      if (path.endsWith('/models')) {
        catalogLoaded = true;
        return { models: [{ id: 'fixture-model' }] };
      }
      if (path.endsWith('/test')) return catalogLoaded
        ? { ok: true, elapsedMs: 10 }
        : { ok: false, error: 'No validated catalogue model is loaded' };
      return {};
    }) as WebUiCall;
    const go = VENDORS.find((item) => item.id === OPENCODE_GO)!;
    const result = await connectVendor(call, go, KEY, 'fixture-model', 'cn');
    expect(result).toEqual({ ok: true, ms: 10, why: null });
    expect(calls.indexOf('/api/providers/opencode-go/models'))
      .toBeLessThan(calls.indexOf('/api/providers/opencode-go/test'));
  });
});
