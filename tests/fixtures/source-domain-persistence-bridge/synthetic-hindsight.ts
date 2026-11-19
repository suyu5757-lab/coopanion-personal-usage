/** Synthetic Hindsight used only by the D3a-S2 bridge tests. No network, no real Bank. */
import { createHash } from 'node:crypto';
import type { DocumentResponse } from '@vectorize-io/hindsight-client';
import type { CorrectionOriginalEvent } from '../../../core/memory/source-domain-persistence-bridge.ts';
import type { HindsightDocumentReader } from '../../../core/memory/source-domain-readback-adapter.ts';
import type { SourceDomainEvidence } from '../../../core/memory/source-domains.ts';

export interface SyntheticHindsightDocumentInput {
  bankId: string;
  endpoint: string;
  documentId: string;
  content: string;
  metadata: Record<string, string>;
}

export interface SyntheticHindsightDocument extends SyntheticHindsightDocumentInput {
  createdAt: string;
  updatedAt: string;
}

export type SyntheticEpochProvider = (bankId: string, endpoint: string) => number;

function key(bankId: string, documentId: string): string {
  return JSON.stringify([bankId, documentId]);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class SyntheticHindsight implements HindsightDocumentReader {
  private readonly documents = new Map<string, SyntheticHindsightDocument>();
  private epochProvider: SyntheticEpochProvider = () => 0;

  constructor(private readonly at = '2026-11-09T11:00:00.000Z') {}

  setEpochProvider(provider: SyntheticEpochProvider): void {
    this.epochProvider = provider;
  }

  put(input: SyntheticHindsightDocumentInput): SyntheticHindsightDocument {
    const document: SyntheticHindsightDocument = {
      ...input,
      metadata: { status: 'completed', ...input.metadata },
      createdAt: this.at,
      updatedAt: this.at,
    };
    this.documents.set(key(input.bankId, input.documentId), document);
    return document;
  }

  get(bankId: string, documentId: string): SyntheticHindsightDocument | null {
    return this.documents.get(key(bankId, documentId)) ?? null;
  }

  setContent(bankId: string, documentId: string, content: string, at = this.at): void {
    const document = this.get(bankId, documentId);
    if (!document) throw new Error('synthetic document is missing');
    this.documents.set(key(bankId, documentId), { ...document, content, updatedAt: at });
  }

  async getDocument(
    bankId: string,
    documentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<DocumentResponse | null> {
    if (options?.signal?.aborted) return null;
    const document = this.get(bankId, documentId);
    if (!document) return null;
    return {
      id: document.documentId,
      bank_id: document.bankId,
      original_text: document.content,
      content_hash: digest(document.content),
      created_at: document.createdAt,
      updated_at: document.updatedAt,
      memory_unit_count: 1,
      document_metadata: { ...document.metadata },
    };
  }

  /** Synchronous trusted source evidence used by the Store and the commit barrier. */
  evidence = (bankId: string, endpoint: string, documentId: string): SourceDomainEvidence | null => {
    const document = this.get(bankId, documentId);
    if (!document || document.endpoint !== endpoint) return null;
    return {
      bankId,
      endpoint,
      documentId,
      content: document.content,
      sourceEpoch: this.epochProvider(bankId, endpoint),
      sourceActor: document.metadata.source_actor ?? 'unknown',
      sourceKind: document.metadata.kind ?? 'unknown',
      sourceStatus: document.metadata.status ?? 'unknown',
    };
  };

  /** Original user events named by a correction's `supersedes_source_ids` metadata. */
  correctionOriginals(
    bankId: string,
    endpoint: string,
    documentId: string,
  ): readonly CorrectionOriginalEvent[] | null {
    const correction = this.get(bankId, documentId);
    if (!correction) return null;
    let sourceIds: unknown;
    try {
      sourceIds = JSON.parse(correction.metadata.supersedes_source_ids ?? '[]');
    } catch {
      return null;
    }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0
      || sourceIds.some((id) => typeof id !== 'string' || id.length === 0)) return null;
    const originals: CorrectionOriginalEvent[] = [];
    for (const sourceId of sourceIds as string[]) {
      const original = this.get(bankId, sourceId);
      if (!original || original.endpoint !== endpoint) return null;
      originals.push({
        bankId,
        endpoint,
        documentId: sourceId,
        content: original.content,
        sourceRevision: digest(original.content),
        sourceEpoch: this.epochProvider(bankId, endpoint),
        sourceActor: original.metadata.source_actor ?? 'unknown',
        sourceKind: original.metadata.kind ?? 'unknown',
        sourceStatus: original.metadata.status ?? 'unknown',
      });
    }
    return originals;
  }
}
