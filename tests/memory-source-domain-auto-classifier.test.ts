import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVED_SOURCE_DOMAIN_RULES,
  AUTO_DOMAIN_CLASSIFIER_VERSION,
  AUTO_DOMAIN_CONFIDENCE_SEMANTICS,
  AUTO_DOMAIN_RULE_SET_VERSION,
  classifySourceDomain,
  classifySourceDomainBatch,
  type AutoDomainBatchResult,
  type AutoDomainClassifierOptions,
  type AutoDomainResult,
  type AutoDomainSafetyContext,
  type AutoDomainSuggestedResult,
  type SourceDomainRuleAuthority,
  type SourceDomainSuggestion,
  type SourceDomainSuggestionInput,
  type SourceDomainSuggestionProvider,
} from '../core/memory/source-domain-auto-classifier.ts';
import {
  MEMORY_DOMAIN_TAXONOMY,
  assertSourceDomainClassification,
  type ClaimVerification,
  type DomainId,
  type SourceDomainClassificationInput,
  type SourceDomainEvidence,
  type SourceDomainEvidenceProvider,
} from '../core/memory/source-domains.ts';
import {
  readVerifiedSourceDomain,
  type TrustedSourceReadbackEvidence,
  type TrustedSourceReadbackProvider,
} from '../core/memory/source-domain-consumer.ts';
import { MemoryStateStore } from '../core/memory/state-store.ts';

interface FixtureSuggestion {
  domainId: DomainId;
  ruleId: string;
  evidenceQuote: string;
  confidence?: number;
  claimVerification?: ClaimVerification;
  capabilityClaim?: boolean;
  uncertainty?: SourceDomainSuggestionInput['uncertainty'];
}

interface FixtureCase {
  caseId: string;
  label: string;
  sourceActor: string;
  sourceKind: string;
  sourceStatus: string;
  content: string;
  expectedState: SourceDomainSuggestion['state'];
  expectedDomains: DomainId[];
  suggestions: FixtureSuggestion[];
}

interface Fixture {
  fixtureVersion: string;
  cases: FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/source-domain-auto-classifier/synthetic-cases.json', import.meta.url), 'utf8'),
) as Fixture;
const at = '2026-11-09T10:00:00.000Z';
const bankId = 'bank-synthetic';
const endpoint = 'https://synthetic.invalid/hindsight';
const roots: string[] = [];
const stores: MemoryStateStore[] = [];

const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const spanDigest = (content: string, start: number, end: number) =>
  createHash('sha256').update(content.slice(start, end), 'utf8').digest('hex');

function source(overrides: Partial<TrustedSourceReadbackEvidence> = {}): TrustedSourceReadbackEvidence {
  return {
    bankId,
    endpoint,
    documentId: 'synthetic:auto:case',
    content: '项目周报请先列阻塞项。',
    sourceEpoch: 0,
    sourceActor: 'user',
    sourceKind: 'event',
    sourceStatus: 'completed',
    ...overrides,
  };
}

function requestFor(entry: TrustedSourceReadbackEvidence, overrides: Record<string, unknown> = {}) {
  return {
    bankId: entry.bankId,
    endpoint: entry.endpoint,
    documentId: entry.documentId,
    expectedSourceEpoch: entry.sourceEpoch,
    ...overrides,
  };
}

function readbackFor(entry: TrustedSourceReadbackEvidence): TrustedSourceReadbackProvider {
  return async () => ({ ...entry });
}

function safetyFor(
  entry: TrustedSourceReadbackEvidence,
  overrides: { epoch?: number; fenced?: boolean; superseded?: boolean } = {},
): AutoDomainSafetyContext {
  return {
    epoch: () => overrides.epoch ?? entry.sourceEpoch,
    isFenced: () => overrides.fenced ?? false,
    isSuperseded: () => overrides.superseded ?? false,
  };
}

function mutableSafety(entry: TrustedSourceReadbackEvidence) {
  const state = { epoch: entry.sourceEpoch, fenced: false, superseded: false };
  return {
    state,
    context: {
      epoch: () => state.epoch,
      isFenced: () => state.fenced,
      isSuperseded: () => state.superseded,
    } satisfies AutoDomainSafetyContext,
  };
}

function fixtureEntry(item: FixtureCase): TrustedSourceReadbackEvidence {
  return source({
    documentId: `synthetic:auto:${item.caseId}`,
    content: item.content,
    sourceActor: item.sourceActor,
    sourceKind: item.sourceKind,
    sourceStatus: item.sourceStatus,
  });
}

function fixtureSuggestions(item: FixtureCase): SourceDomainSuggestionInput[] {
  return item.suggestions.map((suggestion) => {
    const start = item.content.indexOf(suggestion.evidenceQuote);
    if (start < 0) throw new Error(`fixture quote is not a substring: ${suggestion.evidenceQuote}`);
    return {
      domainId: suggestion.domainId,
      ruleId: suggestion.ruleId,
      evidenceStart: start,
      evidenceEnd: start + suggestion.evidenceQuote.length,
      confidence: suggestion.confidence,
      claimVerification: suggestion.claimVerification,
      capabilityClaim: suggestion.capabilityClaim,
      uncertainty: suggestion.uncertainty,
    };
  });
}

function fixtureSuggester(item: FixtureCase): SourceDomainSuggestionProvider {
  const suggestions = fixtureSuggestions(item);
  return async () => suggestions;
}

async function classifyEntry(
  entry: TrustedSourceReadbackEvidence,
  suggestions: SourceDomainSuggestionInput[] | SourceDomainSuggestionProvider,
  options: Partial<AutoDomainClassifierOptions> = {},
): Promise<AutoDomainResult> {
  const suggester = typeof suggestions === 'function' ? suggestions : async () => suggestions;
  return classifySourceDomain(requestFor(entry), {
    readback: readbackFor(entry),
    suggester,
    safety: safetyFor(entry),
    ...options,
  });
}

function suggested(result: AutoDomainResult): AutoDomainSuggestedResult {
  expect(result.outcome).toBe('suggested');
  if (result.outcome !== 'suggested') throw new Error(`expected a suggestion, got ${result.outcome}/${result.reason}`);
  return result;
}

function rejected(result: AutoDomainResult): { outcome: 'blocked' | 'unavailable'; reason: string } {
  expect(result.outcome).not.toBe('suggested');
  if (result.outcome === 'suggested') throw new Error('expected a rejection');
  return result;
}

function rule(overrides: Partial<SourceDomainRuleAuthority> = {}): SourceDomainRuleAuthority {
  return {
    ruleId: 'UR-01',
    domainId: 'user-relationship',
    approval: 'APPROVED_CONTRACT',
    version: 'A1-v1.0.6-draft',
    sourcePath: '03_taxonomy/annotator_rubric.csv',
    sourceSha256: '71dbaac34fef6269604d865d58ed57e3248993018d52cbe71746d3a4385f2935',
    conflict: null,
    confirmedActors: ['user'],
    confirmedKinds: ['event', 'correction'],
    requiresUserVerifiedClaim: true,
    ...overrides,
  };
}

function toClassificationInput(suggestion: SourceDomainSuggestion): SourceDomainClassificationInput {
  return {
    bankId: suggestion.bankId,
    endpoint: suggestion.endpoint,
    documentId: suggestion.documentId,
    state: suggestion.state,
    taxonomyVersion: suggestion.taxonomyVersion,
    classifierVersion: suggestion.classifierVersion,
    confidence: suggestion.confidence,
    sourceEpoch: suggestion.sourceEpoch,
    sourceRevision: suggestion.sourceRevision,
    classifiedAt: at,
    updatedAt: at,
    links: suggestion.links.map((link) => ({
      domainId: link.domainId,
      linkState: link.linkState,
      confidence: link.confidence,
      ruleId: link.ruleId,
      evidenceStart: link.evidenceStart,
      evidenceEnd: link.evidenceEnd,
      evidenceDigest: link.evidenceDigest,
      claimVerification: link.claimVerification,
    })),
  };
}

function tempDatabase(): string {
  const path = mkdtempSync(join(tmpdir(), 'coo-auto-domain-'));
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`unsafe synthetic database root: ${resolved}`);
  }
  roots.push(path);
  return join(path, 'memory-state.sqlite');
}

function track(store: MemoryStateStore): MemoryStateStore {
  stores.push(store);
  return store;
}

function openWriter(path: string, entries: TrustedSourceReadbackEvidence[]): MemoryStateStore {
  const byTuple = new Map(entries.map((entry) => [JSON.stringify([entry.bankId, entry.endpoint, entry.documentId]), entry]));
  const provider: SourceDomainEvidenceProvider = (targetBank, targetEndpoint, targetDocument) => {
    const entry = byTuple.get(JSON.stringify([targetBank, targetEndpoint, targetDocument]));
    return entry ? ({
      bankId: entry.bankId,
      endpoint: entry.endpoint,
      documentId: entry.documentId,
      content: entry.content,
      sourceEpoch: entry.sourceEpoch,
      sourceActor: entry.sourceActor,
      sourceKind: entry.sourceKind,
      sourceStatus: entry.sourceStatus,
    } satisfies SourceDomainEvidence) : null;
  };
  return track(new MemoryStateStore(path, { sourceDomainEvidence: provider }));
}

function openReader(path: string): MemoryStateStore {
  return track(new MemoryStateStore(path));
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('D3a-S1 source-domain auto-classifier', () => {
  it('D3A-S1-01 classifies the five approved-contract domain subjects with exact source spans', async () => {
    expect(fixture.fixtureVersion).toBe('synthetic-source-domain-auto-classifier/v1');
    for (const item of fixture.cases) {
      const entry = fixtureEntry(item);
      const result = suggested(await classifyEntry(entry, fixtureSuggester(item)));
      const suggestion = result.suggestion;
      expect(() => assertSourceDomainClassification(toClassificationInput(suggestion)), item.caseId).not.toThrow();

      expect(suggestion.state, item.caseId).toBe(item.expectedState);
      expect(suggestion.links.map((link) => link.domainId), item.caseId).toEqual(item.expectedDomains);
      expect(suggestion.taxonomyVersion).toBe(MEMORY_DOMAIN_TAXONOMY);
      expect(suggestion.ruleSetVersion).toBe(AUTO_DOMAIN_RULE_SET_VERSION);
      expect(suggestion.classifierVersion).toBe(AUTO_DOMAIN_CLASSIFIER_VERSION);
      expect(suggestion.confidenceSemantics).toBe(AUTO_DOMAIN_CONFIDENCE_SEMANTICS);
      expect(suggestion.externalFactsVerified).toBe(false);
      expect(suggestion.sourceStabilityVerified).toBe(true);
      expect(suggestion.permissions.toolExecutionGranted).toBe(false);
      expect(suggestion.permissions.actionGateRequired).toBe(true);
      expect(suggestion.permissions.capabilityClaimIsNotVerifiedCapability).toBe(true);

      for (const link of suggestion.links) {
        const quote = entry.content.slice(link.evidenceStart, link.evidenceEnd);
        expect(link.linkState, item.caseId).toBe('confirmed');
        expect(link.ruleApproval, item.caseId).toBe('APPROVED_CONTRACT');
        expect(link.evidenceQuote, item.caseId).toBe(quote);
        expect(link.evidenceDigest, item.caseId).toBe(spanDigest(entry.content, link.evidenceStart, link.evidenceEnd));
        expect(quote.length, item.caseId).toBeGreaterThan(0);
      }
    }
  });

  it('D3A-S1-02 keeps multi-domain spans independent and does not call a clear multi-domain source ambiguous', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-MULTI-01')!;
    const entry = fixtureEntry(item);
    const suggestion = suggested(await classifyEntry(entry, fixtureSuggester(item))).suggestion;
    expect(suggestion.state).toBe('assigned');
    expect(suggestion.links.map((link) => link.domainId)).toEqual(['project-functional', 'skill-methods']);
    const [project, skill] = suggestion.links;
    expect(project!.evidenceEnd).toBeLessThan(skill!.evidenceStart);
    expect(project!.evidenceQuote).toBe('项目周报请先列阻塞项');
    expect(skill!.evidenceQuote).toBe('按来源核对、差异比较、放行的顺序写');
  });

  it('D3A-S1-03 records a user first-hand preference as user-verified and leaves external facts unverified', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const suggestion = suggested(await classifyEntry(entry, fixtureSuggester(item))).suggestion;
    expect(suggestion.state).toBe('assigned');
    expect(suggestion.links[0]).toMatchObject({
      domainId: 'user-relationship',
      linkState: 'confirmed',
      claimVerification: 'user_verified',
      ruleId: 'UR-01',
    });
    expect(suggestion.externalFactsVerified).toBe(false);
    expect(suggestion.persistence).toMatchObject({
      eligible: true,
      consumerUserGate: true,
      storeWriteRequiresUserEvent: true,
    });
  });

  it('D3A-S1-04 self-growth from a Coo reflection is classified but is not persistable through the user-only store gate', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-SG-01')!;
    const entry = fixtureEntry(item);
    const suggestion = suggested(await classifyEntry(entry, fixtureSuggester(item))).suggestion;
    expect(suggestion.state).toBe('assigned');
    expect(suggestion.links[0]).toMatchObject({
      domainId: 'self-growth',
      linkState: 'confirmed',
      ruleId: 'SG-01',
      claimVerification: 'external_unverified',
    });
    expect(suggestion.persistence).toMatchObject({
      eligible: false,
      reason: 'actor_not_user',
      consumerUserGate: true,
    });

    const path = tempDatabase();
    const writer = openWriter(path, [entry]);
    expect(() => writer.putSourceDomainClassification(toClassificationInput(suggestion)))
      .toThrow(/only verified user events and corrections can be classified/);
  });

  it('D3A-S1-05 capability claims stay candidate-only and never grant tool permission', async () => {
    const entry = source({
      documentId: 'synthetic:auto:capability',
      content: '我知道如何调用上传工具，但没有实际执行过。',
    });
    const input: SourceDomainSuggestionInput = {
      domainId: 'skill-methods',
      ruleId: 'SM-02',
      evidenceStart: entry.content.indexOf('我知道如何调用上传工具'),
      evidenceEnd: entry.content.indexOf('我知道如何调用上传工具') + '我知道如何调用上传工具'.length,
      confidence: 0.8,
      claimVerification: 'user_verified',
      capabilityClaim: true,
    };
    const unknownRule = suggested(await classifyEntry(entry, [input])).suggestion;
    expect(unknownRule.state).toBe('pending_review');
    expect(unknownRule.links[0]).toMatchObject({
      linkState: 'candidate',
      ruleApproval: 'UNKNOWN',
      capabilityClaim: true,
    });
    expect(unknownRule.links[0]!.uncertainty).toEqual(expect.arrayContaining(['rule_unknown', 'capability_claim']));
    expect(unknownRule.permissions.toolExecutionGranted).toBe(false);
    expect(unknownRule.permissions.actionGateRequired).toBe(true);

    const proposal = rule({
      ruleId: 'SM-02',
      domainId: 'skill-methods',
      approval: 'PROPOSAL_NOT_APPROVED',
      confirmedActors: ['user', 'coo'],
      confirmedKinds: ['event', 'correction', 'reflection'],
      requiresUserVerifiedClaim: false,
    });
    const withProposal = suggested(await classifyEntry(entry, [input], {
      rules: [proposal, ...APPROVED_SOURCE_DOMAIN_RULES],
    })).suggestion;
    expect(withProposal.state).toBe('pending_review');
    expect(withProposal.links[0]).toMatchObject({
      linkState: 'candidate',
      ruleApproval: 'PROPOSAL_NOT_APPROVED',
    });
    expect(withProposal.links[0]!.uncertainty).toContain('rule_unapproved');
  });

  it('D3A-S1-06 approved rules cannot be forced to confirmed by an ambiguous or conflicted proposal', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const base = fixtureSuggestions(item)[0]!;
    const ambiguous = suggested(await classifyEntry(entry, [{ ...base, uncertainty: 'evidence_ambiguous' }])).suggestion;
    expect(ambiguous.state).toBe('ambiguous');
    expect(() => assertSourceDomainClassification(toClassificationInput(ambiguous))).not.toThrow();
    expect(ambiguous.links[0]).toMatchObject({ linkState: 'candidate' });
    expect(ambiguous.links[0]!.uncertainty).toContain('evidence_ambiguous');

    const conflicted = suggested(await classifyEntry(entry, [{ ...base, uncertainty: 'rule_conflict' }])).suggestion;
    expect(conflicted.state).toBe('pending_review');
    expect(conflicted.links[0]).toMatchObject({ linkState: 'candidate' });
    expect(conflicted.links[0]!.uncertainty).toContain('rule_conflict');
  });

  it('D3A-S1-07 unknown and proposal rules never become confirmed', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const base = fixtureSuggestions(item)[0]!;
    const unknown = suggested(await classifyEntry(entry, [{ ...base, ruleId: 'UNKNOWN-99' }])).suggestion;
    expect(unknown.state).toBe('pending_review');
    expect(() => assertSourceDomainClassification(toClassificationInput(unknown))).not.toThrow();
    expect(unknown.links[0]).toMatchObject({ linkState: 'candidate', ruleApproval: 'UNKNOWN' });
    expect(unknown.links[0]!.uncertainty).toContain('rule_unknown');

    const proposal = rule({
      ruleId: 'UR-03',
      domainId: 'user-relationship',
      approval: 'PROPOSAL_NOT_APPROVED',
      confirmedActors: ['user'],
      confirmedKinds: ['event', 'correction', 'report'],
      requiresUserVerifiedClaim: false,
    });
    const candidate = suggested(await classifyEntry(entry, [{ ...base, ruleId: 'UR-03' }], {
      rules: [proposal, ...APPROVED_SOURCE_DOMAIN_RULES],
    })).suggestion;
    expect(candidate.state).toBe('pending_review');
    expect(candidate.links[0]).toMatchObject({ linkState: 'candidate', ruleApproval: 'PROPOSAL_NOT_APPROVED' });
    expect(candidate.links[0]!.uncertainty).toContain('rule_unapproved');
  });

  it('D3A-S1-08 returns processed unclassified for no domain and keeps missing readback distinct', async () => {
    const entry = source({ documentId: 'synthetic:auto:unclassified', content: '今天天气不错。' });
    const suggestion = suggested(await classifyEntry(entry, [])).suggestion;
    expect(suggestion).toMatchObject({
      processed: true,
      state: 'unclassified',
      links: [],
      externalFactsVerified: false,
    });
    expect(() => assertSourceDomainClassification(toClassificationInput(suggestion))).not.toThrow();
    expect(suggestion.persistence.eligible).toBe(false);
    expect(suggestion.sourceStabilityVerified).toBe(true);

    const missing = rejected(await classifyEntry(entry, [], { readback: async () => null }));
    expect(missing).toMatchObject({ outcome: 'blocked', reason: 'readback_missing' });
  });

  it('D3A-S1-09 preserves exact UTF-16 spans around a non-BMP character and rejects malformed spans', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UTF16-01')!;
    const entry = fixtureEntry(item);
    const suggestion = suggested(await classifyEntry(entry, fixtureSuggester(item))).suggestion;
    const link = suggestion.links[0]!;
    const start = entry.content.indexOf('完成😀表情兼容检查');
    expect(link.evidenceStart).toBe(start);
    expect(link.evidenceEnd).toBe(start + '完成😀表情兼容检查'.length);
    expect(link.evidenceQuote).toBe('完成😀表情兼容检查');
    expect(link.evidenceDigest).toBe(spanDigest(entry.content, link.evidenceStart, link.evidenceEnd));

    const split = entry.content.indexOf('😀') + 1;
    const malformed = rejected(await classifyEntry(entry, [{
      domainId: 'project-functional',
      ruleId: 'PF-01',
      evidenceStart: split,
      evidenceEnd: split + 4,
      claimVerification: 'user_verified',
    }]));
    expect(malformed).toMatchObject({ outcome: 'blocked', reason: 'suggestion_invalid' });

    const outOfRange = rejected(await classifyEntry(entry, [{
      domainId: 'project-functional',
      ruleId: 'PF-01',
      evidenceStart: 0,
      evidenceEnd: entry.content.length + 1,
      claimVerification: 'user_verified',
    }]));
    expect(outOfRange).toMatchObject({ outcome: 'blocked', reason: 'suggestion_invalid' });
  });

  it('D3A-S1-10 source revision, epoch and empty-content mismatches fail closed', async () => {
    const entry = source();
    const base = fixtureSuggestions(fixture.cases.find((item) => item.caseId === 'POS-PF-01')!)[0]!;
    const cases: Array<[string, Partial<AutoDomainClassifierOptions>, Record<string, unknown>, string]> = [
      ['expected revision', {}, { expectedSourceRevision: digest('other') }, 'revision_mismatch'],
      ['expected epoch', {}, { expectedSourceEpoch: 9 }, 'epoch_mismatch'],
      ['provider revision', { readback: async () => ({ ...entry, sourceRevision: 'a'.repeat(64) }) }, {}, 'revision_mismatch'],
      ['provider epoch', { readback: async () => ({ ...entry, sourceEpoch: 9 }) }, {}, 'epoch_mismatch'],
      ['empty content', { readback: async () => ({ ...entry, content: '' }) }, {}, 'content_empty'],
      ['superseded status', { readback: async () => ({ ...entry, sourceStatus: 'superseded' }) }, {}, 'status_invalid'],
      ['unknown status', { readback: async () => ({ ...entry, sourceStatus: 'unknown' }) }, {}, 'status_invalid'],
      ['unknown actor', { readback: async () => ({ ...entry, sourceActor: 'tool' }) }, {}, 'actor_invalid'],
      ['unknown kind', { readback: async () => ({ ...entry, sourceKind: 'observation' }) }, {}, 'kind_invalid'],
      ['readback error', { readback: async () => { throw new Error('synthetic readback failure'); } }, {}, 'readback_error'],
    ];
    for (const [label, options, requestOverrides, reason] of cases) {
      const result = await classifySourceDomain(requestFor(entry, requestOverrides), {
        readback: readbackFor(entry),
        suggester: async () => [base],
        safety: safetyFor(entry),
        ...options,
      });
      expect(rejected(result), label).toMatchObject({ reason });
    }
  });

  it('D3A-S1-11 fence, superseded and Forget epoch changes fail closed', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const base = fixtureSuggestions(item);

    const fenced = rejected(await classifyEntry(entry, base, { safety: safetyFor(entry, { fenced: true }) }));
    expect(fenced).toMatchObject({ outcome: 'blocked', reason: 'fenced' });

    const superseded = rejected(await classifyEntry(entry, base, { safety: safetyFor(entry, { superseded: true }) }));
    expect(superseded).toMatchObject({ outcome: 'blocked', reason: 'superseded' });

    const mutable = mutableSafety(entry);
    const forgotten = await classifyEntry(entry, async () => {
      mutable.state.epoch = entry.sourceEpoch + 1;
      return base;
    }, { safety: mutable.context });
    expect(rejected(forgotten)).toMatchObject({ reason: 'epoch_mismatch' });
  });

  it('D3A-S1-12 a source changed after the proposal cannot return the old suggestion', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    let reads = 0;
    const readback: TrustedSourceReadbackProvider = async () => {
      reads += 1;
      return reads === 1 ? { ...entry } : { ...entry, content: `${entry.content} 已修订。` };
    };
    const result = await classifySourceDomain(requestFor(entry), {
      readback,
      suggester: fixtureSuggester(item),
      safety: safetyFor(entry),
    });
    expect(rejected(result)).toMatchObject({ outcome: 'blocked', reason: 'source_changed' });
    expect(reads).toBe(2);
  });

  it('D3A-S1-13 same document id under another bank or endpoint does not cross-contaminate', async () => {
    const contentA = '项目验收先完成接口对账。';
    const contentB = '项目发布说明需要区分内部评审者和外部用户。';
    const entryA = source({ bankId: 'bank-a', endpoint: 'https://a.invalid', documentId: 'same-id', content: contentA });
    const entryB = source({ bankId: 'bank-b', endpoint: 'https://b.invalid', documentId: 'same-id', content: contentB });
    const suggestionsA: SourceDomainSuggestionInput[] = [{
      domainId: 'project-functional', ruleId: 'PF-01',
      evidenceStart: 0, evidenceEnd: '项目验收'.length, claimVerification: 'user_verified',
    }];
    const suggestionsB: SourceDomainSuggestionInput[] = [{
      domainId: 'social-context', ruleId: 'SC-01',
      evidenceStart: 0, evidenceEnd: '项目发布说明'.length, claimVerification: 'user_verified',
    }];
    const a = suggested(await classifyEntry(entryA, suggestionsA)).suggestion;
    const b = suggested(await classifyEntry(entryB, suggestionsB)).suggestion;
    expect(a.documentId).toBe(b.documentId);
    expect(a.bankId).toBe('bank-a');
    expect(b.bankId).toBe('bank-b');
    expect(a.endpoint).toBe('https://a.invalid');
    expect(b.endpoint).toBe('https://b.invalid');
    expect(a.sourceRevision).toBe(digest(contentA));
    expect(b.sourceRevision).toBe(digest(contentB));
    expect(a.links[0]!.evidenceQuote).toBe('项目验收');
    expect(b.links[0]!.evidenceQuote).toBe('项目发布说明');

    for (const [label, readback] of [
      ['bank', async () => ({ ...entryA, bankId: 'bank-c' })],
      ['endpoint', async () => ({ ...entryA, endpoint: 'https://other.invalid' })],
      ['document', async () => ({ ...entryA, documentId: 'other-id' })],
    ] as Array<[string, TrustedSourceReadbackProvider]>) {
      const result = await classifySourceDomain(requestFor(entryA), {
        readback,
        suggester: async () => suggestionsA,
        safety: safetyFor(entryA),
      });
      expect(rejected(result), label).toMatchObject({ reason: 'identity_mismatch' });
    }
  });

  it('D3A-S1-14 a batch final barrier withholds a source changed while another source is read', async () => {
    const itemA = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const itemB = fixture.cases.find((entry) => entry.caseId === 'POS-PF-01')!;
    const entryA = fixtureEntry(itemA);
    const entryB = fixtureEntry(itemB);
    const suggestionsA = fixtureSuggestions(itemA);
    const suggestionsB = fixtureSuggestions(itemB);
    let contentA = entryA.content;
    let readB = 0;
    const readback: TrustedSourceReadbackProvider = async (target) => {
      if (target.documentId === entryA.documentId) return { ...entryA, content: contentA };
      if (target.documentId === entryB.documentId) {
        readB += 1;
        if (readB === 1) contentA = `${entryA.content} 已修订。`;
        return { ...entryB };
      }
      return null;
    };
    const suggester: SourceDomainSuggestionProvider = async (snapshot) =>
      snapshot.documentId === entryA.documentId ? suggestionsA : suggestionsB;
    const result: AutoDomainBatchResult = await classifySourceDomainBatch([entryA, entryB].map((entry) => requestFor(entry)), {
      readback,
      suggester,
      safety: safetyFor(entryA),
      maxItems: 10,
    });
    expect(result.outcome).toBe('partial');
    expect(result.suggestions.map((suggestion) => suggestion.documentId)).toEqual([entryB.documentId]);
    expect(result.withheld).toEqual([
      expect.objectContaining({ documentId: entryA.documentId, reason: 'source_changed' }),
    ]);
    expect(result.scanned).toBe(2);
  });

  it('D3A-S1-15 candidate rows stay isolated from the trusted consumer and confirmed rows pass it', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const proposal = rule({
      ruleId: 'UR-03',
      domainId: 'user-relationship',
      approval: 'PROPOSAL_NOT_APPROVED',
      confirmedActors: ['user'],
      confirmedKinds: ['event', 'correction', 'report'],
      requiresUserVerifiedClaim: false,
    });
    const base = fixtureSuggestions(item)[0]!;
    const candidateSuggestion = suggested(await classifyEntry(entry, [{ ...base, ruleId: 'UR-03' }], {
      rules: [proposal, ...APPROVED_SOURCE_DOMAIN_RULES],
    })).suggestion;
    expect(candidateSuggestion.state).toBe('pending_review');

    const path = tempDatabase();
    const writer = openWriter(path, [entry]);
    writer.putSourceDomainClassification(toClassificationInput(candidateSuggestion));
    writer.close();

    const reader = openReader(path);
    const candidateRead = await readVerifiedSourceDomain(reader, readbackFor(entry), entry);
    expect(candidateRead).toMatchObject({ status: 'blocked', reason: 'not_assigned', item: null });

    const confirmedSuggestion = suggested(await classifyEntry(entry, fixtureSuggestions(item))).suggestion;
    expect(confirmedSuggestion.state).toBe('assigned');
    const writer2 = openWriter(path, [entry]);
    writer2.putSourceDomainClassification(toClassificationInput(confirmedSuggestion));
    writer2.close();

    const reader2 = openReader(path);
    const confirmedRead = await readVerifiedSourceDomain(reader2, readbackFor(entry), entry);
    expect(confirmedRead).toMatchObject({
      status: 'verified',
      item: {
        status: 'verified',
        confirmedDomains: ['user-relationship'],
        externalFactsVerified: false,
      },
    });
  });

  it('D3A-S1-16 third-party and inference-derived claims cannot become user facts', async () => {
    const thirdParty = source({
      documentId: 'synthetic:auto:third-party',
      content: '朋友说那家店的服务很好。',
    });
    const thirdPartyResult = suggested(await classifyEntry(thirdParty, [{
      domainId: 'social-context',
      ruleId: 'SC-03',
      evidenceStart: thirdParty.content.indexOf('朋友说那家店的服务很好'),
      evidenceEnd: thirdParty.content.indexOf('朋友说那家店的服务很好') + '朋友说那家店的服务很好'.length,
      claimVerification: 'external_unverified',
    }])).suggestion;
    expect(thirdPartyResult.state).toBe('pending_review');
    expect(() => assertSourceDomainClassification(toClassificationInput(thirdPartyResult))).not.toThrow();
    expect(thirdPartyResult.links[0]).toMatchObject({
      linkState: 'candidate',
      claimVerification: 'external_unverified',
    });
    expect(thirdPartyResult.externalFactsVerified).toBe(false);

    const derived = source({
      documentId: 'synthetic:auto:derived',
      content: '用户喜欢茉莉花茶。',
      sourceActor: 'inference',
      sourceKind: 'correction',
    });
    const derivedResult = suggested(await classifyEntry(derived, [{
      domainId: 'user-relationship',
      ruleId: 'UR-01',
      evidenceStart: 0,
      evidenceEnd: '用户喜欢茉莉花茶'.length,
      claimVerification: 'user_verified',
    }])).suggestion;
    expect(derivedResult.state).toBe('pending_review');
    expect(derivedResult.links[0]).toMatchObject({
      linkState: 'candidate',
      claimVerification: 'external_unverified',
    });
    expect(derivedResult.links[0]!.uncertainty).toEqual(expect.arrayContaining([
      'claim_verification_downgraded',
      'derived_source',
    ]));
    expect(derivedResult.links.some((link) => link.linkState === 'confirmed')).toBe(false);

    const cooRelationship = source({
      documentId: 'synthetic:auto:coo-relationship',
      content: '用户喜欢茉莉花茶。',
      sourceActor: 'coo',
      sourceKind: 'event',
    });
    const cooResult = suggested(await classifyEntry(cooRelationship, [{
      domainId: 'user-relationship',
      ruleId: 'UR-01',
      evidenceStart: 0,
      evidenceEnd: '用户喜欢茉莉花茶'.length,
      claimVerification: 'user_verified',
    }])).suggestion;
    expect(cooResult.state).toBe('pending_review');
    expect(cooResult.links[0]).toMatchObject({
      linkState: 'candidate',
      claimVerification: 'external_unverified',
    });
    expect(cooResult.links[0]!.uncertainty).toEqual(expect.arrayContaining([
      'claim_verification_downgraded',
      'rule_scope_mismatch',
    ]));
  });

  it('D3A-S1-17 a missing safety context prevents confirmed links', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const suggestion = suggested(await classifyEntry(entry, fixtureSuggester(item), { safety: undefined })).suggestion;
    expect(suggestion.state).toBe('pending_review');
    expect(suggestion.links[0]).toMatchObject({ linkState: 'candidate' });
    expect(suggestion.links[0]!.uncertainty).toContain('safety_context_missing');
    expect(suggestion.persistence.eligible).toBe(false);
  });

  it('D3A-S1-18 provider, option and rule-table failures are explicit', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const base = fixtureSuggestions(item);

    const noReadback = await classifySourceDomain(requestFor(entry), {
      readback: null,
      suggester: async () => base,
      safety: safetyFor(entry),
    });
    expect(rejected(noReadback)).toMatchObject({ outcome: 'unavailable', reason: 'readback_missing' });

    const noSuggester = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: null,
      safety: safetyFor(entry),
    });
    expect(rejected(noSuggester)).toMatchObject({ outcome: 'unavailable', reason: 'provider_missing' });

    const badOptions = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: async () => base,
      safety: safetyFor(entry),
      timeBudgetMs: 0,
    });
    expect(rejected(badOptions)).toMatchObject({ outcome: 'blocked', reason: 'invalid_options' });

    const duplicateRules = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: async () => base,
      safety: safetyFor(entry),
      rules: [rule(), rule()],
    });
    expect(rejected(duplicateRules)).toMatchObject({ outcome: 'blocked', reason: 'invalid_options' });

    const nullOutput = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: async () => null,
      safety: safetyFor(entry),
    });
    expect(rejected(nullOutput)).toMatchObject({ outcome: 'blocked', reason: 'provider_error' });

    const nonArray = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: async () => ({}) as unknown as SourceDomainSuggestionInput[],
      safety: safetyFor(entry),
    });
    expect(rejected(nonArray)).toMatchObject({ outcome: 'blocked', reason: 'suggestion_invalid' });

    const duplicateDomain = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: async () => [base[0]!, base[0]!],
      safety: safetyFor(entry),
    });
    expect(rejected(duplicateDomain)).toMatchObject({ outcome: 'blocked', reason: 'duplicate_domain' });

    const wrongDomainRule = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: async () => [{ ...base[0]!, domainId: 'project-functional' }],
      safety: safetyFor(entry),
    });
    expect(rejected(wrongDomainRule)).toMatchObject({ outcome: 'blocked', reason: 'rule_domain_mismatch' });

    const unavailableRule = rule({ ruleId: 'HIST-01', approval: 'SOURCE_UNAVAILABLE', domainId: 'social-context' });
    const rejectedRule = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: async () => [{ ...base[0]!, ruleId: 'HIST-01', domainId: 'social-context' }],
      safety: safetyFor(entry),
      rules: [unavailableRule],
    });
    expect(rejected(rejectedRule)).toMatchObject({ outcome: 'blocked', reason: 'rule_rejected' });
  });

  it('D3A-S1-19 timeouts and cancellation stop without returning a stale proposal', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const slowReadback: TrustedSourceReadbackProvider = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ...entry };
    };
    const readbackTimeout = await classifySourceDomain(requestFor(entry), {
      readback: slowReadback,
      suggester: fixtureSuggester(item),
      safety: safetyFor(entry),
      providerTimeoutMs: 5,
      timeBudgetMs: 200,
    });
    expect(rejected(readbackTimeout)).toMatchObject({ outcome: 'unavailable', reason: 'readback_timeout' });

    const slowSuggester: SourceDomainSuggestionProvider = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return fixtureSuggestions(item);
    };
    const suggestionTimeout = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: slowSuggester,
      safety: safetyFor(entry),
      providerTimeoutMs: 5,
      timeBudgetMs: 200,
    });
    expect(rejected(suggestionTimeout)).toMatchObject({ outcome: 'unavailable', reason: 'provider_timeout' });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await classifySourceDomain(requestFor(entry), {
      readback: readbackFor(entry),
      suggester: fixtureSuggester(item),
      safety: safetyFor(entry),
      signal: controller.signal,
    });
    expect(rejected(cancelled)).toMatchObject({ outcome: 'unavailable', reason: 'cancelled' });
  });

  it('D3A-S1-20 batch limits and cancellation are explicit', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const second = source({ documentId: 'synthetic:auto:second' });
    const limited = await classifySourceDomainBatch([requestFor(entry), requestFor(second)], {
      readback: async (target) => target.documentId === entry.documentId ? { ...entry } : { ...second },
      suggester: fixtureSuggester(item),
      safety: safetyFor(entry),
      maxItems: 1,
    });
    expect(limited).toMatchObject({
      outcome: 'partial',
      scanned: 1,
      stopReason: 'item_limit',
    });
    expect(limited.suggestions).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await classifySourceDomainBatch([requestFor(entry)], {
      readback: readbackFor(entry),
      suggester: fixtureSuggester(item),
      safety: safetyFor(entry),
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ outcome: 'unavailable', stopReason: 'cancelled', suggestions: [] });
  });

  it('D3A-S1-21 the classifier has no production store, Recall, Hindsight or tool-permission import', () => {
    const moduleText = readFileSync(
      new URL('../core/memory/source-domain-auto-classifier.ts', import.meta.url),
      'utf8',
    );
    expect(moduleText).not.toContain("from './state-store.ts'");
    expect(moduleText).not.toContain("from './hindsight.ts'");
    expect(moduleText).not.toContain("from './tools.ts'");
    expect(moduleText).not.toContain("from '../action-gate.ts'");
    expect(moduleText).not.toContain('putSourceDomainClassification');
    expect(moduleText).not.toContain('readVerifiedSourceDomain');
    expect(moduleText).toContain("import type {\n  SourceDomainIdentity,\n  TrustedSourceReadbackEvidence,\n  TrustedSourceReadbackProvider,\n} from './source-domain-consumer.ts';");
  });

  it('F1-A-01 withholds A when B second readback fences A after A already passed verification', async () => {
    const itemA = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const itemB = fixture.cases.find((entry) => entry.caseId === 'POS-PF-01')!;
    const entryA = fixtureEntry(itemA);
    const entryB = fixtureEntry(itemB);
    const suggestionsA = fixtureSuggestions(itemA);
    const suggestionsB = fixtureSuggestions(itemB);
    let readB = 0;
    let fencedA = false;
    const readback: TrustedSourceReadbackProvider = async (target) => {
      if (target.documentId === entryA.documentId) return { ...entryA };
      if (target.documentId === entryB.documentId) {
        readB += 1;
        if (readB === 2) fencedA = true;
        return { ...entryB };
      }
      return null;
    };
    const safety: AutoDomainSafetyContext = {
      epoch: () => entryA.sourceEpoch,
      isFenced: (target) => target.documentId === entryA.documentId && fencedA,
      isSuperseded: () => false,
    };
    const suggester: SourceDomainSuggestionProvider = async (snapshot) =>
      snapshot.documentId === entryA.documentId ? suggestionsA : suggestionsB;

    const result = await classifySourceDomainBatch([entryA, entryB].map((entry) => requestFor(entry)), {
      readback,
      suggester,
      safety,
      maxItems: 10,
    });

    expect(readB).toBe(2);
    expect(result.outcome).toBe('partial');
    expect(result.suggestions.map((suggestion) => suggestion.documentId)).toEqual([entryB.documentId]);
    expect(result.withheld).toEqual([
      expect.objectContaining({ documentId: entryA.documentId, reason: 'fenced', detail: 'source is fenced' }),
    ]);
  });

  it('F1-A-02 same document id in another bank stays independent when A is fenced', async () => {
    const itemA = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const itemB = fixture.cases.find((entry) => entry.caseId === 'POS-PF-01')!;
    const entryA = source({
      ...fixtureEntry(itemA),
      bankId: 'bank-a',
      endpoint: 'https://a.invalid',
      documentId: 'shared-document-id',
    });
    const entryB = source({
      ...fixtureEntry(itemB),
      bankId: 'bank-b',
      endpoint: 'https://b.invalid',
      documentId: 'shared-document-id',
    });
    const suggestionsA = fixtureSuggestions(itemA);
    const suggestionsB = fixtureSuggestions(itemB);
    let readB = 0;
    let fencedA = false;
    const readback: TrustedSourceReadbackProvider = async (target) => {
      if (target.bankId === entryA.bankId) return { ...entryA };
      if (target.bankId === entryB.bankId) {
        readB += 1;
        if (readB === 2) fencedA = true;
        return { ...entryB };
      }
      return null;
    };
    const safety: AutoDomainSafetyContext = {
      epoch: () => 0,
      isFenced: (target) => target.bankId === 'bank-a' && target.endpoint === 'https://a.invalid'
        && target.documentId === 'shared-document-id' && fencedA,
      isSuperseded: () => false,
    };
    const suggester: SourceDomainSuggestionProvider = async (snapshot) =>
      snapshot.bankId === 'bank-a' ? suggestionsA : suggestionsB;

    const result = await classifySourceDomainBatch([entryA, entryB].map((entry) => requestFor(entry)), {
      readback,
      suggester,
      safety,
      maxItems: 10,
    });

    expect(readB).toBe(2);
    expect(result.suggestions).toEqual([
      expect.objectContaining({ bankId: 'bank-b', endpoint: 'https://b.invalid', documentId: 'shared-document-id' }),
    ]);
    expect(result.withheld).toEqual([
      expect.objectContaining({ bankId: 'bank-a', endpoint: 'https://a.invalid', documentId: 'shared-document-id', reason: 'fenced' }),
    ]);
  });

  it('F1-A-SAFE-01 a safety callback error at the final barrier withholds A without collateral loss of B', async () => {
    const itemA = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const itemB = fixture.cases.find((entry) => entry.caseId === 'POS-PF-01')!;
    const entryA = fixtureEntry(itemA);
    const entryB = fixtureEntry(itemB);
    const suggestionsA = fixtureSuggestions(itemA);
    const suggestionsB = fixtureSuggestions(itemB);
    let readB = 0;
    let throwForA = false;
    const readback: TrustedSourceReadbackProvider = async (target) => {
      if (target.documentId === entryA.documentId) return { ...entryA };
      if (target.documentId === entryB.documentId) {
        readB += 1;
        if (readB === 2) throwForA = true;
        return { ...entryB };
      }
      return null;
    };
    const safety: AutoDomainSafetyContext = {
      epoch: () => entryA.sourceEpoch,
      isFenced: (target) => {
        if (target.documentId === entryA.documentId && throwForA) throw new Error('synthetic final safety failure');
        return false;
      },
      isSuperseded: () => false,
    };
    const suggester: SourceDomainSuggestionProvider = async (snapshot) =>
      snapshot.documentId === entryA.documentId ? suggestionsA : suggestionsB;

    const result = await classifySourceDomainBatch([entryA, entryB].map((entry) => requestFor(entry)), {
      readback,
      suggester,
      safety,
      maxItems: 10,
    });

    expect(result.outcome).toBe('partial');
    expect(result.suggestions.map((suggestion) => suggestion.documentId)).toEqual([entryB.documentId]);
    expect(result.withheld).toEqual([
      expect.objectContaining({ documentId: entryA.documentId, reason: 'safety_error' }),
    ]);
  });

  it('F1-A-SAFE-02 a final barrier epoch change withholds only the affected bank', async () => {
    const itemA = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const itemB = fixture.cases.find((entry) => entry.caseId === 'POS-PF-01')!;
    const entryA = source({ ...fixtureEntry(itemA), bankId: 'bank-a', endpoint: 'https://a.invalid' });
    const entryB = source({ ...fixtureEntry(itemB), bankId: 'bank-b', endpoint: 'https://b.invalid' });
    const suggestionsA = fixtureSuggestions(itemA);
    const suggestionsB = fixtureSuggestions(itemB);
    let readB = 0;
    let epochA = 0;
    const readback: TrustedSourceReadbackProvider = async (target) => {
      if (target.bankId === 'bank-a') return { ...entryA };
      if (target.bankId === 'bank-b') {
        readB += 1;
        if (readB === 2) epochA = 1;
        return { ...entryB };
      }
      return null;
    };
    const safety: AutoDomainSafetyContext = {
      epoch: (targetBank) => targetBank === 'bank-a' ? epochA : 0,
      isFenced: () => false,
      isSuperseded: () => false,
    };
    const suggester: SourceDomainSuggestionProvider = async (snapshot) =>
      snapshot.bankId === 'bank-a' ? suggestionsA : suggestionsB;

    const result = await classifySourceDomainBatch([entryA, entryB].map((entry) => requestFor(entry)), {
      readback,
      suggester,
      safety,
      maxItems: 10,
    });

    expect(result.outcome).toBe('partial');
    expect(result.suggestions.map((suggestion) => suggestion.bankId)).toEqual(['bank-b']);
    expect(result.withheld).toEqual([
      expect.objectContaining({ bankId: 'bank-a', documentId: entryA.documentId, reason: 'epoch_mismatch' }),
    ]);
  });

  it('F1-B-01 disabling stability verification never returns confirmed or persistable single results', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const suggestion = suggested(await classifyEntry(entry, fixtureSuggester(item), {
      verifySourceStability: false,
    })).suggestion;

    expect(suggestion.sourceStabilityVerified).toBe(false);
    expect(suggestion.state).toBe('pending_review');
    expect(suggestion.links.every((link) => link.linkState === 'candidate')).toBe(true);
    expect(suggestion.links[0]!.uncertainty).toContain('stability_unverified');
    expect(suggestion.uncertainty).toContain('stability_unverified');
    expect(suggestion.persistence).toMatchObject({
      eligible: false,
      reason: 'source_stability_unverified',
      consumerUserGate: true,
      storeWriteRequiresUserEvent: true,
    });
  });

  it('F1-B-02 disabling stability verification makes every batch result non-persistable', async () => {
    const itemA = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const itemB = fixture.cases.find((entry) => entry.caseId === 'POS-PF-01')!;
    const entryA = fixtureEntry(itemA);
    const entryB = fixtureEntry(itemB);
    const entryC = source({ documentId: 'synthetic:auto:f1-b-unclassified', content: '今天天气不错。' });
    const suggestionsA = fixtureSuggestions(itemA);
    const suggestionsB = fixtureSuggestions(itemB);
    const suggester: SourceDomainSuggestionProvider = async (snapshot) => {
      if (snapshot.documentId === entryA.documentId) return suggestionsA;
      if (snapshot.documentId === entryB.documentId) return suggestionsB;
      return [];
    };

    const result = await classifySourceDomainBatch([entryA, entryB, entryC].map((entry) => requestFor(entry)), {
      readback: async (target) => {
        if (target.documentId === entryA.documentId) return { ...entryA };
        if (target.documentId === entryB.documentId) return { ...entryB };
        if (target.documentId === entryC.documentId) return { ...entryC };
        return null;
      },
      suggester,
      safety: safetyFor(entryA),
      verifySourceStability: false,
      maxItems: 10,
    });

    expect(result.suggestions).toHaveLength(3);
    for (const suggestion of result.suggestions) {
      expect(suggestion.sourceStabilityVerified).toBe(false);
      expect(suggestion.persistence.eligible).toBe(false);
      expect(suggestion.persistence.reason).toBe('source_stability_unverified');
      expect(suggestion.links.every((link) => link.linkState === 'candidate')).toBe(true);
    }
    expect(result.suggestions.map((suggestion) => suggestion.state)).toEqual([
      'pending_review',
      'pending_review',
      'unclassified',
    ]);
  });

  it('F1-C-01 a caller-declared approved custom rule id cannot become confirmed', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const base = fixtureSuggestions(item)[0]!;
    const forged = rule({
      ruleId: 'UR-X-UNAPPROVED',
      domainId: 'user-relationship',
      approval: 'APPROVED_CONTRACT',
      version: 'custom-untrusted',
      sourcePath: 'untrusted.csv',
      sourceSha256: 'a'.repeat(64),
      confirmedActors: ['user'],
      confirmedKinds: ['event'],
      requiresUserVerifiedClaim: false,
    });
    const suggestion = suggested(await classifyEntry(entry, [{ ...base, ruleId: forged.ruleId }], {
      rules: [forged],
    })).suggestion;

    expect(suggestion.state).toBe('pending_review');
    expect(suggestion.links[0]).toMatchObject({
      ruleId: forged.ruleId,
      ruleApproval: 'UNKNOWN',
      linkState: 'candidate',
    });
    expect(suggestion.links[0]!.uncertainty).toContain('rule_untrusted');
    expect(suggestion.persistence.eligible).toBe(false);
  });

  it('F1-C-02 a forged copy of a built-in rule id, or an exact custom clone, stays candidate', async () => {
    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const base = fixtureSuggestions(item)[0]!;

    const forged = rule({
      ruleId: 'UR-01',
      version: 'A1-custom-forgery',
      sourcePath: 'forged.csv',
      sourceSha256: 'b'.repeat(64),
      confirmedActors: ['user', 'coo'],
      requiresUserVerifiedClaim: false,
    });
    const forgedSuggestion = suggested(await classifyEntry(entry, [base], { rules: [forged] })).suggestion;
    expect(forgedSuggestion.state).toBe('pending_review');
    expect(forgedSuggestion.links[0]).toMatchObject({
      ruleId: 'UR-01',
      ruleApproval: 'UNKNOWN',
      linkState: 'candidate',
    });
    expect(forgedSuggestion.links[0]!.uncertainty).toContain('rule_untrusted');
    expect(forgedSuggestion.persistence.eligible).toBe(false);

    const exactClone = rule();
    const cloneSuggestion = suggested(await classifyEntry(entry, [base], { rules: [exactClone] })).suggestion;
    expect(cloneSuggestion.state).toBe('pending_review');
    expect(cloneSuggestion.links[0]).toMatchObject({
      ruleId: 'UR-01',
      ruleApproval: 'UNKNOWN',
      linkState: 'candidate',
    });
    expect(cloneSuggestion.persistence.eligible).toBe(false);
  });

  it('F1-C-IMMUT exported approved rules are deeply frozen and default confirmation still uses the trusted snapshot', async () => {
    expect(APPROVED_SOURCE_DOMAIN_RULES.map((entry) => entry.ruleId)).toEqual([
      'UR-01',
      'PF-01',
      'SM-01',
      'SC-01',
      'SG-01',
    ]);
    expect(Object.isFrozen(APPROVED_SOURCE_DOMAIN_RULES)).toBe(true);
    for (const approvedRule of APPROVED_SOURCE_DOMAIN_RULES) {
      expect(Object.isFrozen(approvedRule)).toBe(true);
      expect(Object.isFrozen(approvedRule.confirmedActors)).toBe(true);
      expect(Object.isFrozen(approvedRule.confirmedKinds)).toBe(true);
    }

    const target = APPROVED_SOURCE_DOMAIN_RULES[0]!;
    expect(() => {
      (target as unknown as { approval: string }).approval = 'PROPOSAL_NOT_APPROVED';
    }).toThrow(TypeError);
    expect(() => {
      (target.confirmedActors as unknown as string[]).push('other');
    }).toThrow(TypeError);
    expect(target.approval).toBe('APPROVED_CONTRACT');

    const item = fixture.cases.find((entry) => entry.caseId === 'POS-UR-01')!;
    const entry = fixtureEntry(item);
    const suggestion = suggested(await classifyEntry(entry, fixtureSuggester(item))).suggestion;
    expect(suggestion.links[0]).toMatchObject({ ruleId: 'UR-01', linkState: 'confirmed' });
  });
});
