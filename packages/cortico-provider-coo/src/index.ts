/**
 * Coo Pet Provider: one Cortico provider module for the model services Coo can talk through. Which
 * service and platform an endpoint is comes from its base URL (`locate`), and the platform decides
 * the protocol (`Site.protocol`): OpenAI-compatible Responses (stateless, past reasoning replayed as
 * plain text, or as the signed blocks for `encryptedReasoning` services) or Chat Completions,
 * Anthropic's Messages API, or the Gemini API. `options.protocol` overrides it; an endpoint on any
 * other URL uses Responses without it. An endpoint is plain Cortico config and nothing else is stored.
 *
 * Thinking is a four-step choice: off sends `reasoning.effort = none`, the others low / high /
 * max, each rewritten to the value a service documents where it takes other ones (`effortOf`); the
 * Messages and Gemini APIs get the levels in their own form. Images are sent only when the endpoint
 * is marked multimodal and, for a listed service, the service lists the model as reading them; tool
 * results may carry images too, which move to a user message after the results on Chat and for
 * `toolOutputText` services on Responses. Images go out only from the newest delivered batch of events on
 * (`sinceLastDelivery`). Prices are built in for DeepSeek, OpenAI, Anthropic, Gemini and xAI.
 * Streamed reasoning from services marked `lenientReasoning` is rewritten into standard events
 * (`LenientReasoningAssembly`). `nonStreamingResponses` services use a non-streaming fallback so
 * tools execute only after the complete response has been read and validated.
 */
import type { ProviderModule, ProviderInstance } from 'cortico/providers/base.ts';
import type { LLMProviderEntry, ReasoningTier } from 'cortico/core/types.ts';
import type { GenerateOptions } from 'cortico/core/generation.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { ModelCatalog } from 'cortico/providers/openai-responses-compat/native.ts';
import { ClaudeProvider } from './anthropic/client.ts';
import { VendorChat } from './chat.ts';
import { GeminiProvider, listGeminiModels } from './gemini/client.ts';
import { vendorPrices } from './pricing.ts';
import { VendorResponses } from './responses.ts';
import { cooText } from './strings.ts';
import { goEffortMap, goMessagesBaseUrl, goModelMetadata, goRequestUrl, isGoModelId, isGoRequestUrl, normalizeGoBaseUrl, OPENCODE_GO, OPENCODE_GO_SECRET, type GoModel } from './opencode-go.ts';
import { coopanionUserAgent, fetchGoCatalog, goHeaders, goLoopbackSimulatorEnabled, goSessionHeader, GoClient, readGoCatalog, redactSecret, writeGoCatalog } from './opencode-go-catalog.ts';
import { PROTOCOLS, VENDORS, effortOf, isOpenCodeGoUrl, locate, siteOf, vendorOf, vendorName, type Language as VendorLanguage, type Protocol } from './vendors.ts';
import { RuntimeModeClient, runtimeModeSetting } from './runtime-mode.ts';

/** vendors.ts spells out Cortico's `Language`; this stops compiling when the two differ. */
const SAME_LANGUAGES: [Language, VendorLanguage] extends [VendorLanguage, Language] ? true : never = true;

type CooText = ReturnType<typeof cooText>;

/** The four thinking levels, labelled from `t`. */
const tiers = (t: CooText['tiers']): ReasoningTier[] => [
  { id: 'off', label: t.off, thinking: false },
  { id: 'low', label: t.low, thinking: true, effort: 'low' },
  { id: 'high', label: t.high, thinking: true, effort: 'high' },
  { id: 'max', label: t.max, thinking: true, effort: 'max' },
];

export interface CooOptions {
  /** Unset: the listed service's own protocol, Responses for any other URL. */
  protocol?: Protocol;
}

const cooOptions = (entry: LLMProviderEntry): CooOptions => (entry.options ?? {}) as CooOptions;
/** An http address outside this computer and the private networks: what is sent there, the key included, is readable on the way. */
export function plainRemote(baseUrl: string): boolean {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return false; }
  return url.protocol === 'http:' && !privateHost(url.hostname);
}

/**
 * This computer and the private networks: loopback, RFC 1918, link-local, the 100.64/10 shared range
 * (Tailscale and carrier NAT), IPv6 unique-local and link-local, and LAN names (one label, or .local,
 * .lan, .home.arpa, .internal).
 */
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || /\.(local|lan|home\.arpa|internal)$/.test(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return !host.includes('.');
}

/** The longest Anthropic model list read; listing stops there. */
const MODELS_MAX = 2000;

export const protocolOf = (entry: LLMProviderEntry): Protocol =>
  cooOptions(entry).protocol ?? locate(entry.baseUrl)?.site.protocol ?? 'responses';

/** The metadata of each Go model the catalogues have reported this process; the key is never in it. */
const GO_MODELS = new Map<string, GoModel>();

/** A listed service reads images on the models it lists; any other URL on every model. */
function readsImages(entry: LLMProviderEntry, model: string | undefined): boolean {
  if (!model) return false;
  const vendor = vendorOf(entry.baseUrl);
  if (vendor?.id === OPENCODE_GO) return GO_MODELS.get(model)?.inputImages ?? entry.multimodal === true;
  return vendor ? (vendor.vision ?? []).includes(model) : true;
}

/** The Messages API states an oversized prompt as `prompt is too long`, the Gemini API as a token count over the maximum. */
function contextOverflow(error: { status: number; body: string }): boolean {
  return isContextOverflow(error)
    || (error.status === 400 && /prompt is too long|exceeds? the (model's )?context|input token count.*exceeds the maximum/i.test(error.body));
}

function optionsGroup(name: string, t: CooText): ConfigGroup {
  return {
    id: `llm.coo.${name}`,
    owner: 'provider:coo',
    schema: {
      type: 'object', title: name,
      properties: {
        [`providers.${name}.options.protocol`]: {
          type: 'string', enum: [...PROTOCOLS], title: t.protocol, description: t.protocolHint,
        },
      },
    },
  };
}

function normalize(entry: LLMProviderEntry): LLMProviderEntry {
  const options: Record<string, unknown> = { ...entry.options };
  if (options.protocol === '') delete options.protocol;
  return { ...entry, options };
}

export const COO = {
  id: 'coo',
  title: 'Coo Pet Provider',
  description: 'DeepSeek, Qwen, Kimi, GLM, Doubao, MiniMax, StepFun, Baidu Qianfan, OpenRouter, OpenCode Go, OpenAI, Anthropic, Gemini and xAI.',
  describe: { protocols: ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini'], auth: ['api-key'], local: false, input: ['text', 'image'] },
  localize: (language) => {
    const t = cooText(language);
    return { description: t.description(VENDORS.map((v) => vendorName(v, language))), reasoningTiers: tiers(t.tiers) };
  },
  defaultBaseUrl: siteOf(VENDORS[0]!, 'cn').baseUrl,
  baseUrlSuggestions: VENDORS.flatMap((v) => Object.values(v.sites).map((s) => s.baseUrl)),
  reasoningTiers: tiers(cooText('en').tiers),
  serviceTiers: [],
  normalize,
  config: (name, _entry, language) => [optionsGroup(name, cooText(language))],
  validateEntry: (entry, language) => {
    const { protocol } = cooOptions(entry);
    if (protocol !== undefined && !PROTOCOLS.includes(protocol))
      throw new Error(cooText(language).badProtocol(PROTOCOLS.join(' / ')));
    if (plainRemote(entry.baseUrl)) throw new Error(cooText(language).httpRemote);
    if (entry.secret === OPENCODE_GO_SECRET || isOpenCodeGoUrl(entry.baseUrl)) {
      if (entry.secret !== OPENCODE_GO_SECRET || !normalizeGoBaseUrl(entry.baseUrl, null, goLoopbackSimulatorEnabled()))
        throw new Error('OpenCode Go requires its API key and an approved Go endpoint');
    }
  },
  accepts: (entry, spec, mime) => entry.multimodal === true && mime.startsWith('image/') && readsImages(entry, spec.model),
  prices: (entry, _request, at) => vendorPrices(vendorOf(entry.baseUrl)?.id, at.startedAt),
  contextOverflow,
  create(name: string, entry: LLMProviderEntry, host): ProviderInstance {
    if (plainRemote(entry.baseUrl)) {
      // an endpoint saved before the rule stays listed; each request fails before anything is sent
      const client = new VendorResponses({ baseUrl: entry.baseUrl, log: host.log }, {});
      client.respond = () => Promise.reject(new Error(cooText('en').httpRemote));
      return { client };
    }
    const located = locate(entry.baseUrl);
    const vendor = located?.vendor ?? null;
    const go = vendor?.id === OPENCODE_GO;
    const allowGoLoopback = goLoopbackSimulatorEnabled();
    if (entry.secret === OPENCODE_GO_SECRET && !go)
      throw new Error('OpenCode Go API key cannot be used with this endpoint');
    if (go && (entry.secret !== OPENCODE_GO_SECRET || !normalizeGoBaseUrl(entry.baseUrl, null, allowGoLoopback)))
      throw new Error('OpenCode Go requires its API key and an approved Go endpoint');
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const current = () => host.currentEntry?.() ?? entry;
    const goModels = new Map<string, GoModel>();
    if (go) for (const model of readGoCatalog(host.stateDir, allowGoLoopback)) {
      goModels.set(model.id, model);
      GO_MODELS.set(model.id, model);
    }
    const modelName = entry.spec?.model ?? '';
    const goModel = go ? goModels.get(modelName) : undefined;
    const protocol = cooOptions(entry).protocol ?? (go ? goModel?.protocol ?? 'chat' : located?.site.protocol ?? 'responses');
    const media = { enabled: () => current().multimodal === true && readsImages(current(), current().spec?.model), read: host.readBlob };
    const compatibilityKey = () => [vendor?.id ?? 'coo', name, ...(protocol === 'responses' ? [] : [protocol]), ...(go ? [goModels.get(current().spec?.model ?? modelName)?.baseUrl ?? current().baseUrl] : [])];
    const stated = (model: string) => go ? goModels.get(model)?.contextWindow : vendor?.contextWindows?.[model];
    // the listing carries the windows the vendor table states, so the console fills them in instead of asking
    const withStated = <M extends { id: string; contextWindow?: number }>(models: M[]) =>
      models.map((model) => (stated(model.id) ? { ...model, contextWindow: stated(model.id) } : model));
    const modelBaseUrl = go ? goModel?.baseUrl ?? entry.baseUrl : entry.baseUrl;
    const transportBaseUrl = protocol === 'anthropic' && go ? goMessagesBaseUrl(modelBaseUrl) : modelBaseUrl;
    const goPreDispatchGuard = go ? (request: Request, options: GenerateOptions) => {
      const modelId = request.model ?? current().spec?.model ?? modelName;
      const listed = goModels.get(modelId);
      if (!isGoModelId(modelId) || !listed?.protocol || !listed.baseUrl)
        throw new Error('OpenCode Go request requires a validated catalogue model');
      if (listed.protocol !== protocol || listed.baseUrl !== modelBaseUrl
        || !normalizeGoBaseUrl(current().baseUrl, null, allowGoLoopback))
        throw new Error('OpenCode Go request does not match the selected catalogue route');
      goRequestUrl(listed.baseUrl, protocol, modelId, Boolean(options.onEvent), allowGoLoopback);
    } : undefined;
    const goRequestUrlGuard = go ? (url: string, request: Request, options: GenerateOptions) => {
      const modelId = request.model ?? current().spec?.model ?? modelName;
      const listed = goModels.get(modelId);
      if (!listed?.protocol || !listed.baseUrl || listed.protocol !== protocol
        || !isGoRequestUrl(url, listed.baseUrl, protocol, modelId, Boolean(options.onEvent), allowGoLoopback)) {
        throw new Error('OpenCode Go request target failed final validation');
      }
    } : undefined;
    const configuredOutputCap = Number(process.env.COOPANION_GO_MAX_OUTPUT_TOKENS);
    const goMaxOutputTokens = go && process.env.CORTICO_TEST_CHANNEL === '1'
      && Number.isInteger(configuredOutputCap) && configuredOutputCap > 0
      ? Math.min(1024, configuredOutputCap) : undefined;
    const extraHeaders = go ? { 'User-Agent': coopanionUserAgent() } : undefined;
    const requestHeaders = go
      ? (options: GenerateOptions) => ({ 'x-opencode-session': goSessionHeader(options.sessionId, name) })
      : undefined;
    const wrap = (client: ProviderInstance['client']) => go
      ? new GoClient(client, apiKey, () => current().spec?.model ?? modelName, goPreDispatchGuard, goMaxOutputTokens, host.log)
      : client;
    /** The catalogue is the model list; it also records each row's protocol and effort map for later requests. */
    const listGoModels = async () => {
      try {
        const models = await fetchGoCatalog(entry.baseUrl, apiKey, fetch, allowGoLoopback);
        writeGoCatalog(host.stateDir, models, allowGoLoopback);
        goModels.clear();
        for (const model of models) {
          goModels.set(model.id, model);
          GO_MODELS.set(model.id, model);
        }
        return models.map(goModelMetadata);
      } catch (error) {
        throw new Error(redactSecret(error instanceof Error ? error.message : String(error), apiKey));
      }
    };
    const effort = (model: string) => go
      ? goEffortMap(goModels.get(model))
      : (located ? effortOf(located.vendor, located.site, model) : undefined);

    if (protocol === 'anthropic') {
      const client = new ClaudeProvider({
        baseUrl: transportBaseUrl, apiKey, keepThinking: host.keepThinking, log: host.log, media, effort,
        ...(go ? { auth: 'bearer' as const } : {}), extraHeaders, requestHeaders, requestUrlGuard: goRequestUrlGuard,
      });
      const windows = new Map<string, number | undefined>();
      return {
        client: wrap(client), compatibilityKey,
        contextWindow: (model) => stated(model) ?? windows.get(model),
        listModels: go ? listGoModels : async () => {
          const models = [];
          for await (const model of client.client().models.list()) {
            // the SDK pages on while the service says there is more
            if (models.length >= MODELS_MAX) break;
            const row = model as typeof model & { max_input_tokens?: number; max_tokens?: number };
            windows.set(model.id, row.max_input_tokens);
            models.push({ id: model.id, displayName: model.display_name,
              ...(row.max_input_tokens ? { contextWindow: row.max_input_tokens } : {}), ...(row.max_tokens ? { maxOutputTokens: row.max_tokens } : {}) });
          }
          return withStated(models);
        },
      };
    }
    if (protocol === 'gemini') {
      const windows = new Map<string, number | undefined>();
      const client = new GeminiProvider({
        baseUrl: transportBaseUrl, apiKey, media, keepThinking: host.keepThinking, log: host.log, effort,
        ...(go ? { auth: 'bearer' as const } : {}), extraHeaders, requestHeaders, requestUrlGuard: goRequestUrlGuard,
      });
      return {
        client: wrap(client),
        compatibilityKey,
        contextWindow: (model) => stated(model) ?? windows.get(model),
        listModels: go ? listGoModels : async () => {
          const models = await listGeminiModels(entry.baseUrl, apiKey ?? '');
          for (const model of models) windows.set(model.id, model.contextWindow);
          return withStated(models);
        },
      };
    }
    const headers: Record<string, string> = go
      ? goHeaders(apiKey)
      : apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const catalog = new ModelCatalog(() => ({ baseUrl: transportBaseUrl, headers }));
    const client = protocol === 'chat'
      ? new VendorChat({ baseUrl: transportBaseUrl, apiKey, media, keepThinking: host.keepThinking, log: host.log, effort, syntheticReasoning: vendor?.syntheticReasoning, extraHeaders, requestHeaders, requestUrlGuard: goRequestUrlGuard })
      : new VendorResponses({
        baseUrl: transportBaseUrl,
        apiKey,
        log: host.log,
        media,
        keepThinking: host.keepThinking,
        reasoningReplay: vendor?.encryptedReasoning ? 'encrypted' : 'plaintext',
        sendSyntheticReasoning: vendor?.syntheticReasoning,
        extraHeaders,
      }, { effort, lenientReasoning: vendor?.lenientReasoning, nonStreamingResponses: vendor?.nonStreamingResponses, toolOutputText: vendor?.toolOutputText, requestHeaders, requestUrlGuard: goRequestUrlGuard });
    const policy = runtimeModeSetting(entry.options);
    const wrapped = wrap(client);
    return {
      listModels: go ? listGoModels : async () => withStated(await catalog.list()),
      contextWindow: (model) => stated(model) ?? catalog.contextWindow(model),
      compatibilityKey,
      client: policy
        ? new RuntimeModeClient(wrapped, policy, effort, () => current().spec?.model ?? modelName)
        : wrapped,
    };
  },
} satisfies ProviderModule;

export default COO;
export { OFF_PEAK } from './pricing.ts';
export {
  GoCatalogError, coopanionUserAgent, fetchGoCatalog, goHeaders, goSessionHeader, readGoCatalog, redactSecret, writeGoCatalog,
} from './opencode-go-catalog.ts';
export { GO_TIERS, OPENCODE_GO, goEffortMap, goModelMetadata, goModelsUrl, goRequestUrl, isGoModelId, isGoRequestUrl, normalizeGoBaseUrl, goTierSupport, parseOpenCodeGoModels, type GoModel, type GoTier } from './opencode-go.ts';
export {
  CHATGPT, VENDORS, defaultRegion, isOpenCodeGoUrl, localized, siteOf, vendorEntry, vendorName, vendorOf, vendorsFor,
  type Language, type Localized, type Protocol, type Region, type Site, type Vendor,
} from './vendors.ts';
export { VENDOR_ICONS } from './icons.ts';
export { CHATGPT_PROVIDER, SIGN_IN_PANEL, USAGE_LIMIT, chatgptModule, signedIn, usageLimited } from './chatgpt/index.ts';
