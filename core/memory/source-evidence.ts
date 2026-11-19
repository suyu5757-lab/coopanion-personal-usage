import { createHash } from 'node:crypto';
import type { EvidenceAttachment } from 'cortico/core/types.ts';

export function evidenceCoversText(text: string, evidence: readonly EvidenceAttachment[] | undefined): boolean {
  if (!text) return true;
  const covered = new Uint8Array(text.length);
  for (const attachment of evidence ?? []) {
    const { start, end, digest } = attachment.segment;
    if (attachment.validationStatus !== 'validated' || attachment.revisionState !== 'current'
      || ![attachment.bankId, attachment.endpoint, attachment.documentId, attachment.validatedEpoch, attachment.validationReceipt]
        .every((value) => typeof value === 'string' && value.trim().length > 0)
      || !/^[a-f0-9]{64}$/.test(attachment.contentDigest)
      || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length
      || !/^[a-f0-9]{64}$/.test(digest)) continue;
    const segment = text.slice(start, end);
    if (createHash('sha256').update(segment, 'utf8').digest('hex') !== digest) continue;
    for (let index = start; index < end; index++) covered[index] = 1;
  }
  for (let index = 0; index < text.length; index++) {
    if (!/\s/u.test(text[index]!) && covered[index] !== 1) return false;
  }
  return true;
}

/**
 * Every traced source span is present exactly once and each attachment proves the current source.
 *
 * Recall inserts a fixed `[memory]` header, per-result labels and provenance metadata around the
 * source bodies. Those spans are formatting, not historical content; this check requires the
 * source bodies themselves to be complete and rejects a missing, extra or stale attachment.
 */
export function evidenceCoversSegments(
  text: string,
  segments: readonly { documentId: string; start: number; end: number }[],
  evidence: readonly EvidenceAttachment[] | undefined,
): boolean {
  if (!text) return true;
  if (segments.length === 0 || !evidence || evidence.length !== segments.length) return false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const attachment = evidence[index]!;
    if (attachment.validationStatus !== 'validated' || attachment.revisionState !== 'current'
      || attachment.bankId.trim().length === 0 || attachment.endpoint.trim().length === 0
      || attachment.documentId !== segment.documentId
      || attachment.segment.start !== segment.start || attachment.segment.end !== segment.end
      || !/^[a-f0-9]{64}$/.test(attachment.contentDigest)
      || !/^[a-f0-9]{64}$/.test(attachment.segment.digest)) return false;
    const body = text.slice(segment.start, segment.end);
    if (createHash('sha256').update(body, 'utf8').digest('hex') !== attachment.segment.digest) return false;
  }
  return true;
}
