/**
 * OpenCode Go: its model catalog and the protocol each model is served by. The catalog is read at
 * run time (`GET <go>/v1/models`); nothing here lists the models that exist today. A model's
 * `api` states the API family and base URL, which choose Chat Completions, Responses, the Messages
 * API or the Gemini API. This file imports nothing, so the browser console and the app's first-run
 * seed can use it.
 */

/** The service id and endpoint name; the key is stored under `secret`. */
export const OPENCODE_GO = 'opencode-go';
export const OPENCODE_GO_SECRET = 'OPENCODE_GO_API_KEY';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
export const OPENCODE_GO_KEY_URL = 'https://opencode.ai/console/go';
/** The prompt the catalogue documents as the default model: cheap, current, reads images. */
export const OPENCODE_GO_MODEL = 'deepseek-v4.1-flash';

/** The four API families the catalogue names, as the provider's `Protocol` names them. */
export const GO_PROTOCOLS = { 'chat-completions': 'chat', responses: 'responses', messages: 'anthropic', 'generate-content': 'gemini' } as const;
export type GoProtocol = (typeof GO_PROTOCOLS)[keyof typeof GO_PROTOCOLS];

const GO_BASE_PATHS: Record<GoProtocol, string> = {
  chat: '/inference/go/openai/v1',
  responses: '/inference/go/openai/v1',
  anthropic: '/inference/go/anthropic/v1',
  gemini: '/inference/go/google/v1beta',
};
const GO_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isGoModelId(value: string): boolean {
  return GO_MODEL_ID.test(value);
}

/** Returns a canonical Go API base only for its exact official protocol path. */
export function normalizeGoBaseUrl(value: string | undefined, protocol: GoProtocol | null, allowLoopbackSimulator = false): string | undefined {
  if (!value || value !== value.trim() || value.includes('?') || value.includes('#') || value.includes('\\')) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.username || url.password || url.search || url.hash || url.pathname.includes('%')) return undefined;
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const paths = protocol ? [GO_BASE_PATHS[protocol]] : [...new Set(Object.values(GO_BASE_PATHS))];
  if (!paths.includes(path)) return undefined;

  const hostname = url.hostname.toLowerCase().replace('[', '').replace(']', '');
  const official = url.protocol === 'https:' && hostname === 'opencode.ai' && !url.port;
  const loopback = allowLoopbackSimulator && url.protocol === 'http:' && !!url.port
    && (hostname === '127.0.0.1' || hostname === '::1');
  if (!official && !loopback) return undefined;
  if (url.href !== value) return undefined;
  return url.origin + path;
}

/** The exact Go inference URL that a protocol client must send. */
export function goRequestUrl(
  baseUrl: string,
  protocol: GoProtocol,
  modelId: string,
  streaming = false,
  allowLoopbackSimulator = false,
): string {
  const base = normalizeGoBaseUrl(baseUrl, protocol, allowLoopbackSimulator);
  if (!base || !isGoModelId(modelId)) throw new Error('OpenCode Go request target or model id is invalid');
  const path = protocol === 'chat' ? '/chat/completions'
    : protocol === 'responses' ? '/responses'
      : protocol === 'anthropic' ? '/messages'
        : '/models/' + encodeURIComponent(modelId) + ':' + (streaming ? 'streamGenerateContent?alt=sse' : 'generateContent');
  return base + path;
}

/** Confirms the final URL assembled by a protocol client still matches the validated catalogue row. */
export function isGoRequestUrl(
  requestUrl: string,
  baseUrl: string,
  protocol: GoProtocol,
  modelId: string,
  streaming = false,
  allowLoopbackSimulator = false,
): boolean {
  try {
    const expected = goRequestUrl(baseUrl, protocol, modelId, streaming, allowLoopbackSimulator);
    const actual = new URL(requestUrl);
    const expectedUrl = protocol === 'anthropic' && requestUrl === expected + '?beta=true'
      ? expected + '?beta=true' : expected;
    return actual.href === requestUrl && requestUrl === expectedUrl;
  } catch {
    return false;
  }
}

/** One catalogue row, reduced to what the endpoint editor and the transports need. */
export interface GoModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputImages: boolean;
  /** Null when the catalogue names an API family this provider cannot send. */
  protocol: GoProtocol | null;
  /** The base URL the catalogue gives for this model's API family. */
  baseUrl?: string;
  /** The effort values the model takes; absent when the catalogue states none. */
  efforts: string[] | null;
  /** The model can turn reasoning on and off without naming levels. */
  toggle: boolean;
  /** Reasoning is supported at all. */
  reasoning: boolean;
  defaultEffort?: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * A catalogue reply as the endpoint sees it. Rows without an id are skipped; a row whose API family
 * is not one of the four stays listed with `protocol: null`, so the editor can show it and refuse it.
 */
export function parseOpenCodeGoModels(value: unknown, options: { allowLoopbackSimulator?: boolean } = {}): GoModel[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw new Error('OpenCode Go model catalogue returned no data array');
  const models: GoModel[] = [];
  for (const raw of data) {
    const row = record(raw);
    const id = text(row?.id);
    if (!row || !id || !isGoModelId(id)) continue;
    const api = record(row.api);
    let protocol: GoProtocol | null = null;
    let baseUrl: string | undefined;
    let rejected = false;
    if (api) {
      const supportedFamilies = Object.keys(api).filter((family) => Object.prototype.hasOwnProperty.call(GO_PROTOCOLS, family));
      if (supportedFamilies.length > 1) continue;
      for (const [family, entry] of Object.entries(api)) {
        const known = Object.prototype.hasOwnProperty.call(GO_PROTOCOLS, family)
          ? GO_PROTOCOLS[family as keyof typeof GO_PROTOCOLS] : undefined;
        if (!known) continue;
        const url = text(record(entry)?.base_url);
        const normalized = url ? normalizeGoBaseUrl(url, known, options.allowLoopbackSimulator === true) : undefined;
        if (!normalized) {
          rejected = true;
          break;
        }
        protocol = known;
        baseUrl = normalized;
        break;
      }
    }
    if (rejected) continue;
    const capabilities = record(row.capabilities);
    const reasoning = record(capabilities?.reasoning);
    const efforts = Array.isArray(reasoning?.effort)
      ? reasoning.effort.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : null;
    const modalities = record(row.modalities);
    const inputs = Array.isArray(modalities?.input) ? modalities.input : [];
    const limit = record(row.limit);
    const model: GoModel = {
      id,
      inputImages: inputs.some((item) => typeof item === 'string' && item.startsWith('image')),
      protocol,
      efforts,
      toggle: reasoning?.toggle === true,
      reasoning: reasoning?.supported === true,
      ...(text(row.name) ? { displayName: text(row.name) } : {}),
      ...(positive(limit?.context) ? { contextWindow: positive(limit?.context) } : {}),
      ...(positive(limit?.output) ? { maxOutputTokens: positive(limit?.output) } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(text(record(reasoning?.default)?.value) ? { defaultEffort: text(record(reasoning?.default)?.value) } : {}),
    };
    models.push(model);
  }
  return models;
}

/** The catalogue URL that belongs to a Go endpoint: `<prefix>/inference/go/v1/models`. */
export function goModelsUrl(baseUrl: string, allowLoopbackSimulator = false): string {
  const normalized = normalizeGoBaseUrl(baseUrl, null, allowLoopbackSimulator);
  if (!normalized) throw new Error('OpenCode Go catalogue target is invalid');
  return new URL(normalized).origin + '/inference/go/v1/models';
}

/** The Messages SDK appends `/v1/messages`; its base URL is the part before `/v1`. */
export function goMessagesBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/** The four thinking levels the provider offers, in the order the editor shows them. */
export type GoTier = 'off' | 'low' | 'high' | 'max';
export const GO_TIERS: readonly GoTier[] = ['off', 'low', 'high', 'max'];

/** Which levels `model` takes. An unlisted model keeps the provider's default four-level choice. */
export function goTierSupport(model: GoModel | undefined): Record<GoTier, boolean> {
  if (!model) return { off: true, low: true, high: true, max: true };
  if (!model.reasoning) return { off: true, low: false, high: false, max: false };
  if (model.efforts?.length) {
    const has = (...values: string[]) => values.some((value) => model.efforts!.includes(value));
    return { off: has('none'), low: has('low', 'minimal'), high: has('high', 'medium'), max: has('max', 'xhigh') };
  }
  if (model.toggle) return { off: true, low: true, high: false, max: false };
  // Reasoning is always on and the catalogue names no depth: only one on state to choose.
  return { off: false, low: true, high: false, max: false };
}

/**
 * The effort value to send for each tier, where the catalogue asks for another spelling. `null`
 * leaves the field out, which is how a toggle-only model turns reasoning on and a non-reasoning model
 * takes none.
 */
export function goEffortMap(model: GoModel | undefined): Partial<Record<GoTier, string | null>> | undefined {
  if (!model) return undefined;
  if (!model.reasoning) return { off: null, low: null, high: null, max: null };
  if (model.efforts?.length) {
    const pick = (...values: string[]) => values.find((value) => model.efforts!.includes(value)) ?? null;
    return { off: pick('none'), low: pick('low', 'minimal'), high: pick('high', 'medium'), max: pick('max', 'xhigh') };
  }
  return { off: null, low: null, high: null, max: null };
}

/** The maps the editor receives with each model, so a save carries the catalogue's own values. */
export function goModelMetadata(model: GoModel): GoModel & { tiers: Record<GoTier, boolean>; effort: Partial<Record<GoTier, string | null>> } {
  return { ...model, tiers: goTierSupport(model), effort: goEffortMap(model) ?? {} };
}
