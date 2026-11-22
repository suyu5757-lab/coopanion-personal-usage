/**
 * Maps a Hindsight document readback to the evidence shape consumed by
 * `source-domain-consumer.ts`.
 *
 * The adapter is not wired into Recall, Hindsight, MemorySearch or any model-visible
 * path. A caller constructs it explicitly with one bank, one endpoint, the real
 * `HindsightClient` (or a fake with the same `getDocument` contract) and the durable
 * Forget epoch for that bank namespace.
 *
 * The adapter maps the payload; the consumer validates identity, epoch, actor, kind,
 * status, body revision and UTF-16 spans, and runs the final barrier. Returning an
 * evidence object here does not make it verified.
 */
import { createHash } from 'node:crypto';
import type { DocumentResponse } from '@vectorize-io/hindsight-client';
import type {
  TrustedSourceReadbackEvidence,
  TrustedSourceReadbackProvider,
} from './source-domain-consumer.ts';

/** The real readback surface used by `HindsightMemory`; `HindsightClient` satisfies it. */
export interface HindsightDocumentReader {
  getDocument(
    bankId: string,
    documentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<DocumentResponse | null>;
}

/**
 * Durable Forget epoch for a bank namespace. The caller must bind this to
 * `ForgetLedger.epoch`, which is bumped by every fence. The adapter reads it after the
 * document so a fence that lands during the read is reported as the newer epoch.
 */
export type SourceDomainEpochProvider = (bankId: string, endpoint: string) => number;

export interface SourceDomainReadbackAdapterOptions {
  /** Bank the client is scoped to. A request for another bank is refused. */
  bankId: string;
  /** Endpoint the client was constructed for. A request for another endpoint is refused. */
  endpoint: string;
  client: HindsightDocumentReader;
  epoch: SourceDomainEpochProvider;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function metadataOf(document: DocumentResponse): Record<string, unknown> {
  const value = document.document_metadata;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textField(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === 'string' ? value : 'unknown';
}

/**
 * Builds the provider for one bank/endpoint. Every returned body is the exact
 * `original_text` from `getDocument`, so its SHA-256 is the same revision the store
 * computed when the classification was written.
 */
export function createSourceDomainReadbackAdapter(
  options: SourceDomainReadbackAdapterOptions,
): TrustedSourceReadbackProvider {
  const bankId = requiredText(options.bankId, 'bankId');
  const endpoint = requiredText(options.endpoint, 'endpoint');
  const { client, epoch } = options;
  if (!client || typeof client.getDocument !== 'function') {
    throw new Error('client.getDocument must be a function');
  }
  if (typeof epoch !== 'function') {
    throw new Error('epoch must be a function');
  }

  return async (source, context) => {
    if (source.bankId !== bankId || source.endpoint !== endpoint) return null;
    if (context.signal.aborted) return null;

    const document = await client.getDocument(bankId, source.documentId, { signal: context.signal });
    if (context.signal.aborted) return null;
    if (!document || document.id !== source.documentId || document.bank_id !== bankId) return null;

    const content = document.original_text;
    if (typeof content !== 'string' || content.trim().length === 0) return null;

    const currentEpoch = epoch(bankId, endpoint);
    if (!Number.isInteger(currentEpoch) || currentEpoch < 0) return null;

    const metadata = metadataOf(document);
    return {
      bankId,
      endpoint,
      documentId: source.documentId,
      content,
      sourceEpoch: currentEpoch,
      sourceRevision: createHash('sha256').update(content, 'utf8').digest('hex'),
      sourceActor: textField(metadata, 'source_actor'),
      sourceKind: textField(metadata, 'kind'),
      sourceStatus: textField(metadata, 'status'),
    } satisfies TrustedSourceReadbackEvidence;
  };
}
