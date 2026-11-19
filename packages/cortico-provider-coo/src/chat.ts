/**
 * Chat Completions client (`POST <baseUrl>/chat/completions`) for the platforms whose Responses
 * endpoint is missing or takes no images, and for other URLs set to `chat`. The thinking level goes out as
 * `reasoning_effort`, rewritten where the platform takes other values; past reasoning goes back as
 * `reasoning_content` while thinking is on, reasoning before the newest user message only while
 * `keepThinking` holds (`roundReasoning`). Images are
 * limited to the newest delivered batch (`sinceLastDelivery`), and images in tool results move to a
 * user message right after the results, since Chat takes images in user messages only.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';
import type { Logger, ModelSpec, ToolSchema } from 'cortico/core/types.ts';
import type { GenerateOptions, Generation } from 'cortico/core/generation.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { dropPastThinking, mapTools, renderMessagesWithMedia, type CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import { SYNTHETIC_REASONING_TEXT } from 'cortico/providers/transport/responses-input.ts';
import { sinceLastDelivery } from './context.ts';
import type { Effort, EffortMap } from './vendors.ts';

export interface VendorChatOptions {
  baseUrl: string;
  apiKey?: string;
  media?: CompatMediaOptions;
  keepThinking?: () => boolean;
  log?: Logger;
  /** The effort values the platform takes for a model, where they differ from the levels. */
  effort?: (model: string) => EffortMap | undefined;
  /** With thinking on, the service rejects a tool call after the newest user message that has no reasoning (`Vendor.syntheticReasoning`). */
  syntheticReasoning?: boolean;
  /** Headers every request carries. */
  extraHeaders?: Record<string, string>;
  /** Headers that depend on the request, such as a conversation's session id. */
  requestHeaders?: (options: GenerateOptions) => Record<string, string> | undefined;
  /** Validates the URL assembled for this request before the transport runs. */
  requestUrlGuard?: (url: string, request: Request, options: GenerateOptions) => void;
}

/** Text of a tool result that held images only, once they move to the next user message. */
const IMAGE_RESULT = '[image]';

export type Message = Record<string, unknown>;

function requestMappedChatContext(request: Request, context: readonly ContextRecord[]): readonly ContextRecord[] {
  const inputs = request.input;
  if (!Array.isArray(inputs) || inputs.length !== context.length) return context;
  return context.map((entry, index) => {
    const input = inputs[index];
    if (entry.item.type !== 'reasoning' || !input || typeof input !== 'object' || input.type !== 'reasoning') return entry;
    return { ...entry, item: structuredClone(input) as ContextRecord['item'] };
  });
}

/** How a protocol writes tool results, their text and image parts, and a user message. */
export interface ResultFormat {
  isResult: (m: Message) => boolean;
  /** The field of a tool result that holds its parts. */
  field: string;
  text: string;
  image: string;
  /** A user message's fields besides `content`. */
  user: Message;
}

const CHAT_RESULTS: ResultFormat = { isResult: (m) => m.role === 'tool', field: 'content', text: 'text', image: 'image_url', user: { role: 'user' } };

/** Image parts of tool results moved into one user message after each run of tool results. */
export function imagesAfterResults(messages: readonly Message[], format: ResultFormat = CHAT_RESULTS): Message[] {
  const out: Message[] = [];
  let images: Message[] = [];
  const flush = () => {
    if (images.length) out.push({ ...format.user, content: images });
    images = [];
  };
  for (const m of messages) {
    const result = format.isResult(m);
    if (!result) flush();
    const parts = result && Array.isArray(m[format.field]) ? m[format.field] as Message[] : null;
    if (!parts?.some((p) => p.type === format.image)) { out.push(m); continue; }
    const text = parts.filter((p) => p.type === format.text).map((p) => String(p.text ?? '')).join('\n');
    out.push({ ...m, [format.field]: text || IMAGE_RESULT });
    images.push(...parts.filter((p) => p.type === format.image));
  }
  flush();
  return out;
}

/** `reasoning_effort` for `spec`: `none` with thinking off, else the level; `effort` rewrites a level, null leaves the field out. */
function reasoningEffort(spec: ModelSpec, effort: EffortMap = {}): Record<string, unknown> {
  const level = spec.thinking ? spec.reasoningEffort : 'none';
  const value = level && level in effort ? effort[level as Effort] : level;
  return value ? { reasoning_effort: value } : {};
}

/**
 * The reasoning a request carries. The round is everything from the newest user message on: reasoning
 * before it is dropped when `keepThinking` is false, and with `synthetic` an assistant message in the
 * round that calls tools with no reasoning (a call Core built, or one whose reasoning was never
 * recorded) gets `SYNTHETIC_REASONING_TEXT`, as the Responses path sends for the same services.
 */
function roundReasoning(messages: readonly NativeChatMessage[], opts: { keepThinking: boolean; synthetic: boolean }): NativeChatMessage[] {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== 'user') start--;
  const before = messages.slice(0, Math.max(start, 0));
  const round = messages.slice(Math.max(start, 0));
  return [
    ...(opts.keepThinking ? before : dropPastThinking(before)),
    ...(opts.synthetic
      ? round.map((m) => (m.role === 'assistant' && m.tool_calls?.length && !m.reasoning_content ? { ...m, reasoning_content: SYNTHETIC_REASONING_TEXT } : m))
      : round),
  ];
}

export class VendorChat extends OpenAIHttpClient {
  private readonly requestHeaders = new AsyncLocalStorage<Record<string, string>>();

  constructor(private readonly opts: VendorChatOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
  }

  /** Pins a request's own headers to its async call chain, so concurrent conversations keep their sessions apart. */
  override respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    this.opts.requestUrlGuard?.(this.baseUrl + this.chatPath, request, options);
    const headers = this.opts.requestHeaders?.(options);
    return headers ? this.requestHeaders.run(headers, () => super.respond(request, options)) : super.respond(request, options);
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    const context = options.context ? sinceLastDelivery(options.context) : undefined;
    return super.buildResponseBody(request, context ? { ...options, context: requestMappedChatContext(request, context) } : options);
  }

  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    const history = roundReasoning(messages, {
      keepThinking: this.opts.keepThinking?.() !== false,
      synthetic: !!spec.thinking && this.opts.syntheticReasoning === true,
    });
    const body: Record<string, unknown> = {
      model: spec.model,
      messages: imagesAfterResults(renderMessagesWithMedia(history, this.opts.media, { keepReasoning: spec.thinking })),
      ...reasoningEffort(spec, this.opts.effort?.(spec.model)),
    };
    if (spec.temperature !== undefined) body.temperature = spec.temperature;
    if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
    const mapped = mapTools(tools);
    if (mapped) body.tools = mapped;
    return body;
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.opts.extraHeaders,
      ...this.requestHeaders.getStore(),
      ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
    };
  }
}
