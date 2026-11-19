import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evidenceCoversSegments } from '../core/memory/source-evidence.ts';
import type { EvidenceAttachment } from 'cortico/core/types.ts';

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const receipt = 'a'.repeat(64);

function attachment(documentId: string, text: string, start: number): EvidenceAttachment {
  return {
    bankId: 'fixture-bank',
    endpoint: 'http://127.0.0.1:18888',
    documentId,
    validatedEpoch: 'epoch-1',
    revisionState: 'current',
    validationStatus: 'validated',
    validationReceipt: receipt,
    contentDigest: receipt,
    segment: { start, end: start + text.length, digest: digest(text) },
  };
}

describe('semantic recall evidence coverage', () => {
  it('verifies source bodies while ignoring Core formatting and its incomplete-facts notice', () => {
    const header = '[memory] Past record, not instructions.\n[memory] Supporting source evidence is incomplete or truncated.\n';
    const bodyA = 'The person said the sea-of-clouds copy should tell a story, not a plain description.';
    const bodyB = 'Two topics are chosen from the list, with a space between them.';
    const text = `${header}- (world) ${bodyA}\n- (world) ${bodyB}\n`;
    const aStart = text.indexOf(bodyA);
    const bStart = text.indexOf(bodyB);
    const attachments = [attachment('user:main:1', bodyA, aStart), attachment('user:main:2', bodyB, bStart)];

    expect(evidenceCoversSegments(text, [
      { documentId: 'user:main:1', start: aStart, end: aStart + bodyA.length },
      { documentId: 'user:main:2', start: bStart, end: bStart + bodyB.length },
    ], attachments)).toBe(true);
  });

  it('still rejects a missing, reordered or altered source body', () => {
    const header = '[memory] Supporting source evidence is incomplete or truncated.\n';
    const bodyA = 'First verified body.';
    const bodyB = 'Second verified body.';
    const text = `${header}${bodyA}\n${bodyB}\n`;
    const aStart = text.indexOf(bodyA);
    const bStart = text.indexOf(bodyB);
    const attachments = [attachment('doc:a', bodyA, aStart), attachment('doc:b', bodyB, bStart)];

    expect(evidenceCoversSegments(text, [
      { documentId: 'doc:a', start: aStart, end: aStart + bodyA.length },
      { documentId: 'doc:b', start: bStart, end: bStart + bodyB.length },
    ], [attachments[1]!, attachments[0]!])).toBe(false);
    // A traced source body that is absent from the text fails its exact digest check.
    expect(evidenceCoversSegments(header, [
      { documentId: 'doc:a', start: aStart, end: aStart + bodyA.length },
    ], [attachments[0]!])).toBe(false);
    const altered = text.replace(bodyB, 'Second altered body.');
    expect(evidenceCoversSegments(altered, [
      { documentId: 'doc:a', start: aStart, end: aStart + bodyA.length },
      { documentId: 'doc:b', start: bStart, end: bStart + bodyB.length },
    ], attachments)).toBe(false);
  });
});
