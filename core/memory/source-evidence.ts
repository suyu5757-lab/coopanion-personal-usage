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
