/**
 * Reading OpenCode Go's model catalogue and the two headers every Go request carries. A draft
 * catalogue lives outside the endpoint directory so previewing a new endpoint does not reserve its
 * name; after save, the provider can read that metadata until its next refresh writes locally.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GenerationError, type GenerateOptions, type Generation } from 'cortico/core/generation.ts';
import { BaseProvider } from 'cortico/providers/base.ts';
import type { Logger } from 'cortico/core/types.ts';
import { LLMError } from 'cortico/providers/transport/errors.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { goModelsUrl, isGoModelId, normalizeGoBaseUrl, parseOpenCodeGoModels, type GoModel, type GoProtocol } from './opencode-go.ts';

const CATALOG_FILE = '.opencode-go-models.json';
const DRAFT_CATALOG_DIR = '.opencode-go-catalogs';
const CATALOG_MS = 15_000;

function catalogFiles(stateDir: string): { local: string; draft: string; config: string } {
  const endpointDir = resolve(stateDir);
  return {
    local: join(endpointDir, CATALOG_FILE),
    draft: join(dirname(endpointDir), DRAFT_CATALOG_DIR, `${basename(endpointDir)}.json`),
    config: join(endpointDir, 'config.json'),
  };
}

/** Loopback is enabled only by the explicit console:test simulator marker. */
export function goLoopbackSimulatorEnabled(): boolean {
  return process.env.CORTICO_TEST_CHANNEL === '1' && process.env.COOPANION_LOCAL_PROVIDER_SIMULATOR === '1';
}

/** The client name OpenCode Go's documentation asks a non-OpenCode client to use. */
export function coopanionUserAgent(version = process.env.COOPANION_VERSION): string {
  return `Coopanion/${version && version.trim() ? version.trim() : 'dev'}`;
}

/** The session header: one stable value per conversation. */
export function goSessionHeader(sessionId: string | undefined, fallback: string): string {
  return `coopanion-${sessionId ?? fallback}`;
}

/** The authorization and identity headers of a Go request. */
export function goHeaders(apiKey: string | undefined, session?: string): Record<string, string> {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    'User-Agent': coopanionUserAgent(),
    ...(session ? { 'x-opencode-session': session } : {}),
  };
}

/** The model catalogue cached for this endpoint, or an empty list before the first read. */
export function readGoCatalog(stateDir: string, allowLoopbackSimulator = false): GoModel[] {
  try {
    const { local, draft, config } = catalogFiles(stateDir);
    const file = existsSync(config) ? (existsSync(local) ? local : draft) : (existsSync(draft) ? draft : local);
    const value = JSON.parse(readFileSync(file, 'utf8')) as { models?: unknown };
    if (!Array.isArray(value.models)) return [];
    const models: GoModel[] = [];
    for (const model of value.models) {
      const row = model as Partial<GoModel> | null;
      if (!row || typeof row.id !== 'string' || !isGoModelId(row.id)
        || typeof row.reasoning !== 'boolean' || typeof row.toggle !== 'boolean') continue;
      if (row.protocol === null) {
        if (row.baseUrl !== undefined) continue;
        models.push(row as GoModel);
        continue;
      }
      if (!['chat', 'responses', 'anthropic', 'gemini'].includes(String(row.protocol))) continue;
      const baseUrl = normalizeGoBaseUrl(row.baseUrl, row.protocol as GoProtocol, allowLoopbackSimulator);
      if (!baseUrl) continue;
      models.push({ ...row, baseUrl } as GoModel);
    }
    return models;
  } catch {
    return [];
  }
}

/** Writes the catalogue atomically; metadata only, never the key. */
export function writeGoCatalog(stateDir: string, models: GoModel[], allowLoopbackSimulator = false): void {
  try {
    const { local, draft, config } = catalogFiles(stateDir);
    const file = existsSync(config) ? local : draft;
    mkdirSync(dirname(file), { recursive: true });
    const staging = `${file}.${process.pid}.tmp`;
    const safeModels = models.filter((model) => model.protocol === null
      ? model.baseUrl === undefined && isGoModelId(model.id)
      : !!normalizeGoBaseUrl(model.baseUrl, model.protocol, allowLoopbackSimulator));
    writeFileSync(staging, JSON.stringify({ version: 1, models: safeModels }, null, 2));
    renameSync(staging, file);
  } catch {
    // a read-only endpoint still works from the in-memory catalogue; the next save retries
  }
}

/** A failed catalogue read, ready for the endpoint editor's error line. */
export class GoCatalogError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`OpenCode Go model catalogue ${status || 'request failed'}: ${body.slice(0, 200)}`);
  }
}

/** `GET <go>/v1/models` with the same identity headers as a model request. */
export async function fetchGoCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  allowLoopbackSimulator = false,
): Promise<GoModel[]> {
  let url: string;
  try {
    url = goModelsUrl(baseUrl, allowLoopbackSimulator);
  } catch (error) {
    throw new GoCatalogError(0, error instanceof Error ? error.message : String(error));
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { ...goHeaders(apiKey), Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(CATALOG_MS),
    });
  } catch (error) {
    throw new GoCatalogError(0, error instanceof Error ? error.message : String(error));
  }
  if (!res.ok) throw new GoCatalogError(res.status, await res.text());
  return parseOpenCodeGoModels(await res.json(), { allowLoopbackSimulator });
}

/** Removes the key from anything that may be shown, logged or recorded. */
export function redactSecret(value: string, apiKey: string | undefined): string {
  let out = apiKey ? value.split(apiKey).join('[redacted]') : value;
  out = out.replace(/Bearer\s+[^\s"']+/g, 'Bearer [redacted]');
  return out;
}

/** The upstream's own sentence, from the usual error shapes. */
function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    if (typeof message === 'string') return message;
  } catch { /* not JSON */ }
  return body;
}

/**
 * Names Go endpoint failures and Core evidence checks rejected before dispatch. It preserves status,
 * attempts, partial output and the redacted response body.
 */
export function goError(error: unknown, apiKey: string | undefined, model: string): unknown {
  if (!(error instanceof GenerationError)) return error;
  const body = redactSecret(error.body, apiKey);
  const detail = upstreamMessage(body).replace(/\s+/g, ' ').trim().slice(0, 240);
  const request = / \[req=[^\]]+\]$/.exec(error.message)?.[0] ?? '';
  const timedOut = error.status === 0 && /取消|abort|timeout|timed out/i.test(error.message);
  const evidenceBlocked = error.status === 0 && error.retryable === false
    && error.message.includes('Provider request was blocked by current evidence state');
  let text: string;
  if (evidenceBlocked) text = 'OpenCode Go request was blocked by the Core evidence check before dispatch (0)';
  else if (timedOut) text = 'OpenCode Go request timed out or was cancelled (0)';
  else if (error.status === 401) text = 'OpenCode Go rejected the API key (401)';
  else if (error.status === 403) text = 'OpenCode Go denied the request (403); the key has no permission, the workspace or region is blocked, or the plan limit applies';
  else if (error.status === 404) text = 'OpenCode Go model "' + model + '" is unavailable (404)';
  else if (error.status === 429) text = 'OpenCode Go usage limit or rate limit reached (429)';
  else if (error.status === 0) text = 'OpenCode Go could not be reached';
  else text = 'OpenCode Go request failed (' + (error.status || 'stream') + ')';
  const rawCause = error.cause;
  const safeCause = rawCause instanceof LLMError
    ? new LLMError(rawCause.message, rawCause.status, redactSecret(rawCause.body, apiKey), rawCause.retryable)
    : rawCause instanceof Error
      ? new Error(redactSecret(rawCause.message, apiKey))
      : undefined;
  const wrapped = new GenerationError(
    `${text}${detail && detail !== error.message ? `: ${detail}` : ''}${request}`,
    error.attempts,
    error.partial,
    error.origin,
    error.status,
    body,
    safeCause ? { cause: safeCause } : undefined,
  );
  wrapped.retryable = error.retryable;
  return wrapped;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function requestBodyDigest(body: unknown): string {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body ?? null) ?? 'null';
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function failureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/Provider request was blocked by current evidence state/.test(message)) return 'core-evidence-blocked';
  if (/cancel|abort/i.test(message)) return 'cancelled';
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/validated catalogue model|selected catalogue route/i.test(message)) return 'catalogue-guard';
  if (/final validation|request target/i.test(message)) return 'request-url-guard';
  if (error instanceof GenerationError) {
    const attempt = error.attempts.find((entry) => entry.status !== null);
    if (attempt) return 'http-' + attempt.status;
    if (error.attempts.length > 0) return 'transport';
    return error.status > 0 ? 'http-' + error.status : 'generation-error';
  }
  return error instanceof TypeError ? 'transport' : 'provider-error';
}

function continuationReceipts(options: GenerateOptions): Array<{ callRef: string; receiptRef: string; evidenceRef?: string }> {
  const context = options.context ?? [];
  let lastUser = -1;
  context.forEach((entry, index) => {
    if (entry.item.type === 'message' && entry.item.role === 'user') lastUser = index;
  });
  return context.slice(lastUser + 1).flatMap((entry) => {
    if (entry.item.type !== 'function_call_output' || !entry.context.toolReceiptRef) return [];
    return [{
      callRef: fingerprint(entry.item.call_id),
      receiptRef: fingerprint(entry.context.toolReceiptRef),
      ...(entry.context.generationEvidenceId ? { evidenceRef: fingerprint(entry.context.generationEvidenceId) } : {}),
    }];
  });
}

/** A client whose errors and stage records name Go conditions without logging request content. */
export class GoClient extends BaseProvider {
  constructor(
    private readonly inner: BaseProvider,
    private readonly apiKey: string | undefined,
    private readonly model: () => string,
    private readonly preDispatchGuard?: (request: Request, options: GenerateOptions) => void,
    private readonly maxOutputTokens?: number,
    private readonly log?: Logger,
  ) {
    super();
  }

  async respond(request: Parameters<BaseProvider['respond']>[0], options?: GenerateOptions): Promise<Generation> {
    const normalizedOptions = options ?? {};
    const model = request.model ?? this.model();
    const traceId = randomUUID();
    const sessionRef = normalizedOptions.sessionId ? fingerprint(normalizedOptions.sessionId) : undefined;
    const receipts = continuationReceipts(normalizedOptions);
    const stage = (name: string, data: Record<string, unknown> = {}): void => {
      this.log?.emit('debug', 'OpenCode Go generation stage', {
        event: 'opencode-go-stage',
        data: {
          traceId,
          stage: name,
          model,
          ...(sessionRef ? { sessionRef } : {}),
          ...data,
        },
      });
    };
    const limitedRequest = this.maxOutputTokens
      ? {
        ...request,
        max_output_tokens: Math.min(
          typeof request.max_output_tokens === 'number' && request.max_output_tokens > 0
            ? request.max_output_tokens : this.maxOutputTokens,
          this.maxOutputTokens,
        ),
      }
      : request;
    let catalogueGuardPassed = false;
    let requestPrepared = false;
    let dispatchAttempted = false;
    const dispatchedAttemptIds = new Set<string>();
    const noteDispatch = (generationId: string, attemptId: string, observedBy: string): void => {
      dispatchAttempted = true;
      if (dispatchedAttemptIds.has(attemptId)) return;
      dispatchedAttemptIds.add(attemptId);
      stage('request-dispatched', { generationId, attemptId, observedBy });
    };
    const noteAttempts = (attempts: Generation['attempts']): void => {
      for (const attempt of attempts) {
        noteDispatch(attempt.generationId, attempt.id, 'provider-attempt');
        stage('http-status', {
          generationId: attempt.generationId,
          attemptId: attempt.id,
          ordinal: attempt.ordinal,
          status: attempt.status,
          outcome: attempt.outcome,
          elapsedMs: attempt.elapsedMs,
        });
      }
    };
    stage('core-accepted', { sessionIdPresent: Boolean(normalizedOptions.sessionId), continuation: receipts.length > 0 });
    for (const receipt of receipts) stage('tool-receipt', receipt);
    if (receipts.length) stage('continuation-started', { receiptCount: receipts.length });
    try {
      if (this.preDispatchGuard) {
        this.preDispatchGuard({ ...limitedRequest, model } as Request, normalizedOptions);
        catalogueGuardPassed = true;
        stage('guard-passed', { guard: 'catalogue' });
      }
      const observedOptions: GenerateOptions = {
        ...normalizedOptions,
        onRequestReady: (info) => {
          requestPrepared = true;
          const serializedBodyDigest = requestBodyDigest(info.body);
          stage('provider-prepared', { generationId: info.generationId, attemptId: info.attemptId, serializedBodyDigest });
          stage('guard-passed', { guard: 'request-url', generationId: info.generationId, attemptId: info.attemptId, serializedBodyDigest });
          const allowed = normalizedOptions.onRequestReady?.(info) ?? true;
          if (allowed) stage('guard-passed', { guard: 'core-evidence', generationId: info.generationId, attemptId: info.attemptId, serializedBodyDigest });
          else stage('guard-failed', { guard: 'core-evidence', generationId: info.generationId, attemptId: info.attemptId, serializedBodyDigest, reason: 'evidence-incomplete' });
          return allowed;
        },
        onRequestSent: (info) => {
          noteDispatch(info.generationId, info.attemptId, 'pre-fetch-callback');
          normalizedOptions.onRequestSent?.(info);
        },
      };
      const result = await this.inner.respond(limitedRequest, observedOptions);
      noteAttempts(result.attempts);
      const output = result.response.output;
      const toolCallCount = output.filter((item) => item.type === 'function_call').length;
      const messageCount = output.filter((item) => item.type === 'message' && item.role === 'assistant').length;
      if (toolCallCount) stage('tool-calls-returned', { toolCallCount, messageCount });
      else stage('provider-final-reply-received', { messageCount, responseStatus: result.response.status });
      return result;
    } catch (error) {
      const category = failureCategory(error);
      const wrapped = goError(error, this.apiKey, this.model());
      if (!catalogueGuardPassed && this.preDispatchGuard) stage('guard-failed', { guard: 'catalogue', errorCategory: category });
      else if (!requestPrepared && category === 'request-url-guard') stage('guard-failed', { guard: 'request-url', errorCategory: category });
      if (!dispatchAttempted) stage('request-not-dispatched', { reason: category });
      if (error instanceof GenerationError) {
        noteAttempts(error.attempts);
        stage('generation-failed', {
          errorCategory: category,
          generationStatus: error.status,
          attemptCount: error.attempts.length,
        });
      } else stage('generation-failed', { errorCategory: category });
      throw wrapped;
    }
  }
}
