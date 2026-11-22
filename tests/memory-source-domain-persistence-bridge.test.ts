import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { MemoryStateStore } from '../core/memory/state-store.ts';
import {
  type AutoDomainSafetyContext,
  type SourceDomainSuggestion,
  type SourceDomainSuggestionInput,
  type SourceDomainSuggestionProvider,
} from '../core/memory/source-domain-auto-classifier.ts';
import {
  readVerifiedSourceDomain,
  type TrustedSourceReadbackProvider,
} from '../core/memory/source-domain-consumer.ts';
import { createSourceDomainReadbackAdapter } from '../core/memory/source-domain-readback-adapter.ts';
import {
  persistVerifiedUserSourceDomain,
  type PersistenceBridgePersistedUnverified,
  type PersistenceBridgeResult,
  type PersistenceBridgeVerified,
  type PersistenceBridgeWithheld,
  type SourceDomainPersistenceBridgeOptions,
} from '../core/memory/source-domain-persistence-bridge.ts';
import {
  MEMORY_DOMAIN_TAXONOMY,
  type ClaimVerification,
  type DomainId,
  type SourceDomainClassificationInput,
} from '../core/memory/source-domains.ts';
import { SyntheticHindsight } from './fixtures/source-domain-persistence-bridge/synthetic-hindsight.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
const stores: MemoryStateStore[] = [];
const at = '2026-11-09T11:00:00.000Z';
const bankA = 'bank-synthetic-a';
const bankB = 'bank-synthetic-b';
const endpoint = 'https://synthetic.invalid/hindsight';

const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const spanDigest = (content: string, start: number, end: number) =>
  createHash('sha256').update(content.slice(start, end), 'utf8').digest('hex');

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'coo-source-domain-bridge-'));
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`unsafe synthetic database root: ${resolved}`);
  }
  roots.push(path);
  return path;
}

function databasePath(): string {
  return join(root(), 'memory-state.sqlite');
}

function track(store: MemoryStateStore): MemoryStateStore {
  stores.push(store);
  return store;
}

function openReader(path: string): MemoryStateStore {
  return track(new MemoryStateStore(path));
}

interface Harness {
  path: string;
  fake: SyntheticHindsight;
  writer: MemoryStateStore;
  ledger: ForgetLedger;
  reader: MemoryStateStore;
}

function harness(path = databasePath(), writerHasProvider = true): Harness {
  const fake = new SyntheticHindsight(at);
  const writer = track(new MemoryStateStore(path, writerHasProvider ? { sourceDomainEvidence: fake.evidence } : {}));
  const ledger = new ForgetLedger(writer, { now: () => new Date(at) });
  fake.setEpochProvider((bankId, target) => ledger.epoch(bankId, target));
  return { path, fake, writer, ledger, reader: openReader(path) };
}

function safetyFor(writer: MemoryStateStore, ledger: ForgetLedger): AutoDomainSafetyContext {
  return {
    epoch: (bankId, target) => ledger.epoch(bankId, target),
    isFenced: (source) => ledger.forgotten(source.bankId, source.endpoint, source.documentId),
    isSuperseded: (source) => writer.supersededSources(source.bankId, source.endpoint).has(source.documentId),
  };
}

function readbackFor(
  fake: SyntheticHindsight,
  ledger: ForgetLedger,
  bankId = bankA,
): TrustedSourceReadbackProvider {
  return createSourceDomainReadbackAdapter({
    bankId,
    endpoint,
    client: fake,
    epoch: ledger.epoch.bind(ledger),
  });
}

function putUserEvent(fake: SyntheticHindsight, bankId: string, documentId: string, content: string): void {
  fake.put({
    bankId,
    endpoint,
    documentId,
    content,
    metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: at },
  });
}

interface SuggestionSpec {
  domainId: DomainId;
  ruleId: string;
  quote: string;
  confidence?: number;
  claimVerification?: ClaimVerification;
  uncertainty?: SourceDomainSuggestionInput['uncertainty'];
  capabilityClaim?: boolean;
}

function suggesterFor(content: string, specs: readonly SuggestionSpec[]): SourceDomainSuggestionProvider {
  const inputs = specs.map((spec) => {
    const start = content.indexOf(spec.quote);
    if (start < 0) throw new Error(`fixture quote is not in the synthetic body: ${spec.quote}`);
    return {
      domainId: spec.domainId,
      ruleId: spec.ruleId,
      evidenceStart: start,
      evidenceEnd: start + spec.quote.length,
      confidence: spec.confidence,
      claimVerification: spec.claimVerification,
      uncertainty: spec.uncertainty,
      capabilityClaim: spec.capabilityClaim,
    };
  });
  return async () => inputs;
}

function bridgeFor(
  h: Harness,
  bankId: string,
  suggester: SourceDomainSuggestionProvider,
  overrides: Partial<SourceDomainPersistenceBridgeOptions> = {},
): SourceDomainPersistenceBridgeOptions {
  return {
    writer: h.writer,
    reader: h.reader,
    readback: readbackFor(h.fake, h.ledger, bankId),
    suggester,
    safety: safetyFor(h.writer, h.ledger),
    commitEvidence: h.fake.evidence,
    correctionProvenance: (correction) =>
      h.fake.correctionOriginals(correction.bankId, correction.endpoint, correction.documentId),
    now: () => Date.parse(at),
    ...overrides,
  };
}

function request(bankId: string, documentId: string, overrides: Record<string, unknown> = {}) {
  return { bankId, endpoint, documentId, ...overrides };
}

function verified(result: PersistenceBridgeResult): PersistenceBridgeVerified {
  expect(result.status).toBe('verified');
  if (result.status !== 'verified') throw new Error(`expected verified, got ${result.status}/${result.reason}`);
  return result;
}

function withheld(result: PersistenceBridgeResult): PersistenceBridgeWithheld {
  expect(result.status).toBe('withheld');
  if (result.status !== 'withheld') throw new Error(`expected withheld, got ${result.status}`);
  return result;
}

function persistedUnverified(result: PersistenceBridgeResult): PersistenceBridgePersistedUnverified {
  expect(result.status).toBe('persisted_unverified');
  if (result.status !== 'persisted_unverified') throw new Error(`expected persisted_unverified, got ${result.status}`);
  return result;
}

function toInput(suggestion: SourceDomainSuggestion): SourceDomainClassificationInput {
  return {
    bankId: suggestion.bankId,
    endpoint: suggestion.endpoint,
    documentId: suggestion.documentId,
    state: suggestion.state,
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
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

function recordCount(path: string): number {
  const database = new DatabaseSync(path);
  try {
    return (database.prepare('SELECT COUNT(*) AS count FROM source_domain_record').get() as { count: number }).count;
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('D3a-S2 synthetic source persistence bridge', () => {
  it('D3A-S2-01 writes a verified user event through the Store and reads it back through D3-S1', async () => {
    const h = harness();
    const documentId = 'user:single';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    const quote = 'I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);

    const result = verified(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote,
        confidence: 0.92,
        claimVerification: 'user_verified',
      }])),
    ));

    const start = content.indexOf(quote);
    expect(result.suggestion.persistence).toMatchObject({
      eligible: true,
      reason: 'user_event_confirmed_links',
      consumerUserGate: true,
      storeWriteRequiresUserEvent: true,
    });
    expect(result.written.state).toBe('assigned');
    expect(result.written.sourceRevision).toBe(digest(content));
    expect(result.written.sourceEpoch).toBe(0);
    expect(result.written.links).toHaveLength(1);
    expect(result.written.links[0]).toMatchObject({
      domainId: 'user-relationship',
      linkState: 'confirmed',
      evidenceStart: start,
      evidenceEnd: start + quote.length,
      evidenceDigest: spanDigest(content, start, start + quote.length),
      claimVerification: 'user_verified',
    });
    expect(result.readback.classification).toEqual(result.written);
    expect(result.readback.confirmedDomains).toEqual(['user-relationship']);
    expect(result.readback.claims).toEqual([{ domainId: 'user-relationship', claimVerification: 'user_verified' }]);
    expect(result.readback.externalFactsVerified).toBe(false);
    expect(h.reader.getSourceDomainClassification(bankA, endpoint, documentId)).toEqual(result.written);
    expect(recordCount(h.path)).toBe(1);
  });

  it('wires Hindsight writes through exact source evidence and the separate D3-S1 reader', async () => {
    const h = harness();
    const documentId = 'user:hindsight-api';
    const content = 'The person prefers a concise answer for routine questions.';
    putUserEvent(h.fake, bankA, documentId, content);
    const memory = new HindsightMemory();
    Object.assign(memory as unknown as Record<string, unknown>, {
      config: { enabled: true, readOnly: false, bankId: bankA, apiUrl: endpoint },
      client: h.fake,
      stateStore: h.reader,
      ledger: h.ledger,
      outbox: { readable: () => true },
      log: { warn: () => {} },
    });

    const persisted = await memory.classifyAndPersistUserSourceDomain(
      request(bankA, documentId),
      suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'prefers a concise answer for routine questions',
        claimVerification: 'user_verified',
      }]),
    );
    expect(persisted).not.toBeNull();
    const result = verified(persisted!);

    expect(result.written.state).toBe('assigned');
    expect(result.readback.classification).toEqual(result.written);
    expect(h.reader.getSourceDomainClassification(bankA, endpoint, documentId)).toEqual(result.written);
    expect(recordCount(h.path)).toBe(1);
  });

  it('treats an identical verified classification as idempotent across retries', async () => {
    const h = harness();
    const documentId = 'user:idempotent';
    const content = 'The person prefers jasmine tea after dinner.';
    const suggestion = suggesterFor(content, [{
      domainId: 'user-relationship',
      ruleId: 'UR-01',
      quote: 'prefers jasmine tea after dinner',
      claimVerification: 'user_verified',
    }]);
    putUserEvent(h.fake, bankA, documentId, content);
    let now = Date.parse(at);
    const first = verified(await persistVerifiedUserSourceDomain(request(bankA, documentId), bridgeFor(
      h, bankA, suggestion, { now: () => now },
    )));
    now += 60_000;
    const second = verified(await persistVerifiedUserSourceDomain(request(bankA, documentId), bridgeFor(
      h, bankA, suggestion, { now: () => now },
    )));

    expect(second.written).toEqual(first.written);
    expect(second.readback.classification).toEqual(first.written);
    expect(recordCount(h.path)).toBe(1);
  });

  it('D3A-S2-02 keeps multi-domain links independent and grants no tool permission', async () => {
    const h = harness();
    const documentId = 'user:multi';
    const content = '项目周报请先列阻塞项。按来源核对、差异比较、放行的顺序写。';
    putUserEvent(h.fake, bankA, documentId, content);

    const result = verified(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [
        { domainId: 'project-functional', ruleId: 'PF-01', quote: '项目周报请先列阻塞项' },
        { domainId: 'skill-methods', ruleId: 'SM-01', quote: '按来源核对、差异比较、放行的顺序写' },
      ])),
    ));

    expect(result.written.state).toBe('assigned');
    expect(result.written.links.map((link) => link.domainId)).toEqual(['project-functional', 'skill-methods']);
    expect(result.readback.confirmedDomains).toEqual(['project-functional', 'skill-methods']);
    expect(result.written.links[0]!.evidenceEnd!).toBeLessThan(result.written.links[1]!.evidenceStart!);
    expect(result.suggestion.permissions).toEqual({
      toolExecutionGranted: false,
      actionGateRequired: true,
      capabilityClaimIsNotVerifiedCapability: true,
    });
    expect(result.readback.claims.map((claim) => claim.claimVerification))
      .toEqual(['external_unverified', 'external_unverified']);
    expect(recordCount(h.path)).toBe(1);
  });

  it('D3A-S2-03 records a user-stated boundary as user-verified without claiming external facts', async () => {
    const h = harness();
    const documentId = 'user:boundary';
    const content = 'The person said to Coo: I do not want to be touched while I am working.';
    const quote = 'I do not want to be touched while I am working.';
    putUserEvent(h.fake, bankA, documentId, content);

    const result = verified(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote,
        claimVerification: 'user_verified',
      }])),
    ));

    expect(result.written.links[0]!.claimVerification).toBe('user_verified');
    expect(result.readback.claims[0]!.claimVerification).toBe('user_verified');
    expect(result.readback.externalFactsVerified).toBe(false);
    expect(recordCount(h.path)).toBe(1);
  });

  it('D3A-S2-04 persists a user-authored correction with a traced original user event and rejects inference corrections', async () => {
    const h = harness();
    const originalId = 'user:correction:original';
    const correctionId = 'correction:user:1';
    const inferenceId = 'correction:inference:1';
    const originalContent = 'The person said to Coo: I prefer jasmine tea after dinner.';
    const correctionContent = 'The person corrected: I now prefer oat milk after dinner, not jasmine tea.';
    const inferenceContent = 'The person corrected a past fact: I now prefer oat milk after dinner.';
    const quote = 'I now prefer oat milk after dinner';
    h.fake.put({
      bankId: bankA,
      endpoint,
      documentId: originalId,
      content: originalContent,
      metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: at },
    });
    h.fake.put({
      bankId: bankA,
      endpoint,
      documentId: correctionId,
      content: correctionContent,
      metadata: {
        source_actor: 'user',
        kind: 'correction',
        status: 'current',
        said_at: at,
        supersedes_source_ids: JSON.stringify([originalId]),
      },
    });
    h.fake.put({
      bankId: bankA,
      endpoint,
      documentId: inferenceId,
      content: inferenceContent,
      metadata: {
        source_actor: 'inference',
        kind: 'correction',
        status: 'current',
        said_at: at,
        supersedes_source_ids: JSON.stringify([originalId]),
      },
    });

    const userCorrection = verified(await persistVerifiedUserSourceDomain(
      request(bankA, correctionId),
      bridgeFor(h, bankA, suggesterFor(correctionContent, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote,
        claimVerification: 'user_verified',
      }])),
    ));
    expect(userCorrection.suggestion.sourceKind).toBe('correction');
    expect(userCorrection.suggestion.sourceActor).toBe('user');
    expect(userCorrection.readback.classification.state).toBe('assigned');
    expect(userCorrection.readback.claims[0]!.claimVerification).toBe('user_verified');

    const inference = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, inferenceId),
      bridgeFor(h, bankA, suggesterFor(inferenceContent, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote,
        claimVerification: 'user_verified',
      }])),
    ));
    expect(inference.suggestion?.sourceActor).toBe('inference');
    expect(inference.suggestion?.sourceKind).toBe('correction');
    expect(inference.suggestion?.persistence.eligible).toBe(false);
    expect(recordCount(h.path)).toBe(1);
  });

  it('D3A-S2-05 rebuilds the Store connection and still reads the classification through D3-S1', async () => {
    const h = harness();
    const documentId = 'user:restart';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const written = verified(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }])),
    ));

    h.writer.close();
    h.reader.close();
    const reader = openReader(h.path);
    const ledger = new ForgetLedger(reader, { now: () => new Date(at) });
    h.fake.setEpochProvider((bankId, target) => ledger.epoch(bankId, target));
    const restored = await readVerifiedSourceDomain(
      reader,
      readbackFor(h.fake, ledger, bankA),
      { bankId: bankA, endpoint, documentId },
      { now: () => Date.parse(at) },
    );
    expect(restored.status).toBe('verified');
    if (restored.status !== 'verified') throw new Error('expected a verified restart readback');
    expect(restored.item.classification).toEqual(written.written);
  });

  it('D3A-S2-06 withholds unknown, ambiguous, pending-review and capability-candidate suggestions', async () => {
    const cases = [
      {
        name: 'unknown rule',
        cause: 'state_pending_review',
        spec: { domainId: 'user-relationship', ruleId: 'UNKNOWN-99', quote: 'I prefer jasmine tea after dinner.' } as SuggestionSpec,
      },
      {
        name: 'ambiguous evidence',
        cause: 'state_ambiguous',
        spec: {
          domainId: 'user-relationship', ruleId: 'UR-01', quote: 'I prefer jasmine tea after dinner.',
          uncertainty: 'evidence_ambiguous',
        } as SuggestionSpec,
      },
      {
        name: 'pending review',
        cause: 'state_pending_review',
        spec: {
          domainId: 'user-relationship', ruleId: 'UR-01', quote: 'I prefer jasmine tea after dinner.',
          uncertainty: 'model_uncertain',
        } as SuggestionSpec,
      },
      {
        name: 'capability candidate',
        cause: 'state_pending_review',
        spec: {
          domainId: 'skill-methods', ruleId: 'SM-01', quote: 'I can upload files.', capabilityClaim: true,
        } as SuggestionSpec,
      },
    ];

    for (const testCase of cases) {
      const h = harness();
      const documentId = `user:negative:${testCase.name.replaceAll(' ', '-')}`;
      const content = testCase.spec.domainId === 'skill-methods'
        ? 'The person said to Coo: I can upload files.'
        : 'The person said to Coo: I prefer jasmine tea after dinner.';
      putUserEvent(h.fake, bankA, documentId, content);
      const result = withheld(await persistVerifiedUserSourceDomain(
        request(bankA, documentId),
        bridgeFor(h, bankA, suggesterFor(content, [testCase.spec])),
      ));
      expect(result.stage, testCase.name).toBe('eligibility');
      expect(result.cause, testCase.name).toBe(testCase.cause);
      expect(recordCount(h.path), testCase.name).toBe(0);
    }
  });

  it('D3A-S2-07 withholds a suggestion whose source stability was not verified', async () => {
    const h = harness();
    const documentId = 'user:unstable';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const result = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }]), { verifySourceStability: false }),
    ));
    expect(result.stage).toBe('eligibility');
    expect(result.cause).toBe('source_stability_unverified');
    expect(recordCount(h.path)).toBe(0);
  });

  it('D3A-S2-08 refuses a same-documentId source from another bank at the commit boundary', async () => {
    const h = harness();
    const documentId = 'user:same-id';
    const contentA = 'The person said to Coo: I prefer jasmine tea after dinner.';
    const contentB = 'The person said to Coo: I prefer oolong tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, contentA);
    putUserEvent(h.fake, bankB, documentId, contentB);
    const result = withheld(await persistVerifiedUserSourceDomain(
      request(bankB, documentId),
      bridgeFor(h, bankB, suggesterFor(contentB, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer oolong tea after dinner.',
        claimVerification: 'user_verified',
      }]), { commitEvidence: () => h.fake.evidence(bankA, endpoint, documentId) }),
    ));
    expect(result.stage).toBe('commit_evidence');
    expect(result.cause).toBe('identity_mismatch');
    expect(recordCount(h.path)).toBe(0);

    const endpointMismatch = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(contentA, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }]), {
        commitEvidence: () => ({
          ...h.fake.evidence(bankA, endpoint, documentId)!,
          endpoint: 'https://synthetic.invalid/other',
        }),
      }),
    ));
    expect(endpointMismatch.stage).toBe('commit_evidence');
    expect(endpointMismatch.cause).toBe('identity_mismatch');
    expect(recordCount(h.path)).toBe(0);
  });

  it('D3A-S2-09 rejects commit evidence that changed, disappeared or threw after classification', async () => {
    const scenarios = [
      {
        name: 'body changed',
        cause: 'revision_mismatch',
        provider: (h: Harness) => (bankId: string, target: string, documentId: string) => {
          h.fake.setContent(bankId, documentId, 'The person said to Coo: I prefer oolong tea after dinner.');
          return h.fake.evidence(bankId, target, documentId);
        },
      },
      {
        name: 'missing evidence',
        cause: 'commit_evidence_missing',
        provider: () => () => null,
      },
      {
        name: 'provider threw',
        cause: 'provider_error',
        provider: () => () => { throw new Error('synthetic commit provider failure'); },
      },
    ] as const;

    for (const scenario of scenarios) {
      const h = harness();
      const documentId = `user:commit:${scenario.name.replaceAll(' ', '-')}`;
      const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
      putUserEvent(h.fake, bankA, documentId, content);
      const result = withheld(await persistVerifiedUserSourceDomain(
        request(bankA, documentId),
        bridgeFor(h, bankA, suggesterFor(content, [{
          domainId: 'user-relationship',
          ruleId: 'UR-01',
          quote: 'I prefer jasmine tea after dinner.',
          claimVerification: 'user_verified',
        }]), { commitEvidence: scenario.provider(h) }),
      ));
      expect(result.stage, scenario.name).toBe('commit_evidence');
      expect(result.cause, scenario.name).toBe(scenario.cause);
      expect(recordCount(h.path), scenario.name).toBe(0);
    }
  });

  it('D3A-S2-10 fails closed when a fence lands after the bridge check but before the Store write', async () => {
    const h = harness();
    const documentId = 'user:epoch-race';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const frozen = h.fake.evidence(bankA, endpoint, documentId)!;
    const result = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }]), {
        commitEvidence: () => {
          const task = h.ledger.add({
            bankId: bankA,
            endpoint,
            documentId,
            reason: 'synthetic fence after bridge check',
          });
          expect(task).not.toBeNull();
          return frozen;
        },
      }),
    ));
    expect(result.stage).toBe('commit');
    expect(result.reason).toBe('store_rejected');
    expect(result.detail).toMatch(/fenced|epoch is stale/);
    expect(h.ledger.epoch(bankA, endpoint)).toBe(1);
    expect(recordCount(h.path)).toBe(0);
  });

  it('D3A-S2-11 rejects a source already superseded by an active correction revision', async () => {
    const h = harness();
    const documentId = 'user:superseded';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const outbox = new MemoryOutbox(h.writer, { now: () => new Date(at) });
    const queued = outbox.add({
      bankId: bankA,
      endpoint,
      documentId: 'correction:revision:1',
      content: 'The person corrected a past fact: I now prefer oat milk.',
      context: 'synthetic correction',
      tags: ['scope:life'],
      priority: 'critical',
      metadata: {
        source_actor: 'user',
        kind: 'correction',
        status: 'current',
        supersedes_source_ids: JSON.stringify([documentId]),
      },
    });
    expect(queued).toBe('queued');
    const item = outbox.due(new Date(at), 1)[0]!;
    expect(outbox.markSending(item.id)).toBe(true);
    expect(outbox.markSent(item.id, item.operationId)).toBe(true);
    expect(outbox.markDone(item.id)).toBe(true);
    expect(outbox.markVerified(item.id)).toBe(true);
    expect(h.writer.supersededSources(bankA, endpoint).has(documentId)).toBe(true);

    const result = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }])),
    ));
    expect(result.stage).toBe('classify');
    expect(result.cause).toBe('superseded');
    expect(recordCount(h.path)).toBe(0);
  });

  it('D3A-S2-12 reports a written row even when a post-commit Forget blocks the trusted readback', async () => {
    const h = harness();
    const documentId = 'user:post-commit-forget';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const base = readbackFor(h.fake, h.ledger, bankA);
    let calls = 0;
    const readback: TrustedSourceReadbackProvider = async (source, context) => {
      calls += 1;
      if (calls === 3) {
        h.ledger.add({
          bankId: source.bankId,
          endpoint: source.endpoint,
          documentId: source.documentId,
          reason: 'synthetic forget after commit',
        });
      }
      return base(source, context);
    };
    const result = persistedUnverified(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }]), { readback }),
    ));
    expect(calls).toBe(3);
    expect(result.reason).toBe('readback_rejected');
    expect(result.cause).toBe('epoch_mismatch');
    expect(result.written.sourceRevision).toBe(digest(content));
    expect(result.readback.status).toBe('blocked');
    expect(h.reader.getSourceDomainClassification(bankA, endpoint, documentId)).toBeNull();
    // Forget removes the v5 index row; the bridge still reports the row the Store returned.
    expect(recordCount(h.path)).toBe(0);
  });

  it('D3A-S2-12B keeps the written row when the post-commit trusted readback fails', async () => {
    const h = harness();
    const documentId = 'user:post-commit-provider-error';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const base = readbackFor(h.fake, h.ledger, bankA);
    let calls = 0;
    const readback: TrustedSourceReadbackProvider = async (source, context) => {
      calls += 1;
      if (calls === 3) throw new Error('synthetic post-commit readback failure');
      return base(source, context);
    };
    const result = persistedUnverified(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }]), { readback }),
    ));
    expect(calls).toBe(3);
    expect(result.reason).toBe('readback_rejected');
    expect(result.cause).toBe('provider_error');
    expect(result.written.documentId).toBe(documentId);
    expect(recordCount(h.path)).toBe(1);
    expect(h.reader.getSourceDomainClassification(bankA, endpoint, documentId)).toEqual(result.written);
  });

  it('D3A-S2-13 does not treat the raw domain list as a trusted readback', async () => {
    const h = harness();
    const documentId = 'user:raw-list';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    verified(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }])),
    ));
    const raw = h.reader.listDomainSources(bankA, endpoint, ['user-relationship']);
    expect(raw.items.map((item) => item.documentId)).toEqual([documentId]);
    const untrusted = await readVerifiedSourceDomain(
      h.reader,
      null,
      { bankId: bankA, endpoint, documentId },
      { now: () => Date.parse(at) },
    );
    expect(untrusted.status).toBe('unavailable');
    expect(untrusted.reason).toBe('provider_missing');
  });

  it('D3A-S2-14 persists B while A is fenced during B validation in another bank', async () => {
    const h = harness();
    const documentA = 'user:batch:a';
    const documentB = 'user:batch:b';
    const contentA = 'The person said to Coo: I prefer jasmine tea after dinner.';
    const contentB = 'The person said to Coo: I prefer oolong tea after dinner.';
    putUserEvent(h.fake, bankA, documentA, contentA);
    putUserEvent(h.fake, bankB, documentB, contentB);
    const baseB = readbackFor(h.fake, h.ledger, bankB);
    let calls = 0;
    const readbackB: TrustedSourceReadbackProvider = async (source, context) => {
      calls += 1;
      if (calls === 2) {
        h.ledger.add({ bankId: bankA, endpoint, documentId: documentA, reason: 'synthetic forget A during B' });
      }
      return baseB(source, context);
    };
    const resultB = verified(await persistVerifiedUserSourceDomain(
      request(bankB, documentB),
      bridgeFor(h, bankB, suggesterFor(contentB, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer oolong tea after dinner.',
        claimVerification: 'user_verified',
      }]), { readback: readbackB }),
    ));
    expect(resultB.written.bankId).toBe(bankB);
    const resultA = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentA),
      bridgeFor(h, bankA, suggesterFor(contentA, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }])),
    ));
    expect(resultA.stage).toBe('classify');
    expect(resultA.cause).toBe('fenced');
    expect(recordCount(h.path)).toBe(1);
  });

  it('D3A-S2-15 keeps coo reflection, plan and self-report out of the user-only Store gate', async () => {
    const kinds = ['reflection', 'plan', 'self_report'] as const;
    for (const kind of kinds) {
      const h = harness();
      const documentId = `coo:${kind}:1`;
      const content = 'Coo reflected: I should ask before acting on a plan.';
      h.fake.put({
        bankId: bankA,
        endpoint,
        documentId,
        content,
        metadata: { source_actor: 'coo', kind, status: 'completed', said_at: at },
      });
      const result = withheld(await persistVerifiedUserSourceDomain(
        request(bankA, documentId),
        bridgeFor(h, bankA, suggesterFor(content, [{
          domainId: 'self-growth',
          ruleId: 'SG-01',
          quote: 'I should ask before acting on a plan.',
        }])),
      ));
      expect(result.stage, kind).toBe('eligibility');
      expect(result.cause, kind).toBe('actor_not_user');
      expect(result.suggestion?.sourceActor, kind).toBe('coo');
      expect(() => h.writer.putSourceDomainClassification(toInput(result.suggestion!)))
        .toThrow(/only verified user events and corrections can be classified/);
      expect(recordCount(h.path), kind).toBe(0);
    }
  });

  it('D3A-S2-16 reports a Store write failure without claiming a persisted row', async () => {
    const h = harness(databasePath(), false);
    const documentId = 'user:store-missing-provider';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const result = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'UR-01',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }])),
    ));
    expect(result.stage).toBe('commit');
    expect(result.reason).toBe('store_rejected');
    expect(result.detail).toMatch(/provider is not configured/);
    expect(recordCount(h.path)).toBe(0);
  });

  it('D3A-S2-17 fails closed for null, throwing, timing-out and aborted readbacks', async () => {
    const baseContent = 'The person said to Coo: I prefer jasmine tea after dinner.';
    const specs = [{
      domainId: 'user-relationship',
      ruleId: 'UR-01',
      quote: 'I prefer jasmine tea after dinner.',
      claimVerification: 'user_verified',
    }] as const;

    const nullReadback = harness();
    putUserEvent(nullReadback.fake, bankA, 'user:readback-null', baseContent);
    const nullResult = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, 'user:readback-null'),
      bridgeFor(nullReadback, bankA, suggesterFor(baseContent, specs), { readback: async () => null }),
    ));
    expect(nullResult.stage).toBe('classify');
    expect(nullResult.cause).toBe('readback_missing');

    const errorReadback = harness();
    putUserEvent(errorReadback.fake, bankA, 'user:readback-error', baseContent);
    const errorResult = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, 'user:readback-error'),
      bridgeFor(errorReadback, bankA, suggesterFor(baseContent, specs), {
        readback: async () => { throw new Error('synthetic readback failure'); },
      }),
    ));
    expect(errorResult.stage).toBe('classify');
    expect(errorResult.cause).toBe('readback_error');

    const timeoutReadback = harness();
    putUserEvent(timeoutReadback.fake, bankA, 'user:readback-timeout', baseContent);
    const timeoutResult = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, 'user:readback-timeout'),
      bridgeFor(timeoutReadback, bankA, suggesterFor(baseContent, specs), {
        readback: () => new Promise(() => {}),
        providerTimeoutMs: 5,
        timeBudgetMs: 100,
      }),
    ));
    expect(timeoutResult.stage).toBe('classify');
    expect(timeoutResult.cause).toBe('readback_timeout');

    const aborted = harness();
    putUserEvent(aborted.fake, bankA, 'user:aborted', baseContent);
    const controller = new AbortController();
    controller.abort();
    const abortedResult = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, 'user:aborted'),
      bridgeFor(aborted, bankA, suggesterFor(baseContent, specs), { signal: controller.signal }),
    ));
    expect(abortedResult.stage).toBe('classify');
    expect(abortedResult.cause).toBe('cancelled');
    for (const h of [nullReadback, errorReadback, timeoutReadback, aborted]) {
      expect(recordCount(h.path)).toBe(0);
    }
  });

  it('D3A-S2-18 requires a traced original user event for every user correction', async () => {
    const scenarios = [
      { name: 'provider missing', provenance: null, cause: 'correction_provenance_missing' },
      { name: 'no original', provenance: (() => []) as never, cause: 'correction_provenance_unverified' },
      {
        name: 'original not a user event',
        provenance: ((correction: { bankId: string; endpoint: string; documentId: string }) => [{
          ...correction,
          documentId: 'coo:not-a-user-event',
          content: 'Coo reflected on the correction.',
          sourceRevision: digest('Coo reflected on the correction.'),
          sourceEpoch: 0,
          sourceActor: 'coo',
          sourceKind: 'reflection',
          sourceStatus: 'completed',
        }]) as never,
        cause: 'correction_provenance_unverified',
      },
    ] as const;

    for (const scenario of scenarios) {
      const h = harness();
      const documentId = `correction:provenance:${scenario.name.replaceAll(' ', '-')}`;
      const content = 'The person corrected: I now prefer oat milk after dinner.';
      h.fake.put({
        bankId: bankA,
        endpoint,
        documentId,
        content,
        metadata: {
          source_actor: 'user',
          kind: 'correction',
          status: 'current',
          said_at: at,
          supersedes_source_ids: JSON.stringify(['user:original']),
        },
      });
      const result = withheld(await persistVerifiedUserSourceDomain(
        request(bankA, documentId),
        bridgeFor(h, bankA, suggesterFor(content, [{
          domainId: 'user-relationship',
          ruleId: 'UR-01',
          quote: 'I now prefer oat milk after dinner.',
          claimVerification: 'user_verified',
        }]), { correctionProvenance: scenario.provenance as never }),
      ));
      expect(result.stage, scenario.name).toBe('correction_provenance');
      expect(result.cause, scenario.name).toBe(scenario.cause);
      expect(recordCount(h.path), scenario.name).toBe(0);
    }
  });

  it('D3A-S2-19 refuses identical writer and reader connections', async () => {
    const h = harness();
    const documentId = 'user:same-connection';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const options = bridgeFor(h, bankA, suggesterFor(content, [{
      domainId: 'user-relationship',
      ruleId: 'UR-01',
      quote: 'I prefer jasmine tea after dinner.',
      claimVerification: 'user_verified',
    }]));
    const result = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      { ...options, reader: h.writer },
    ));
    expect(result.stage).toBe('options');
    expect(result.reason).toBe('invalid_options');
    expect(recordCount(h.path)).toBe(0);
  });

  it('D3A-S2-20 classifies but does not write a custom caller-supplied rule', async () => {
    const h = harness();
    const documentId = 'user:custom-rule';
    const content = 'The person said to Coo: I prefer jasmine tea after dinner.';
    putUserEvent(h.fake, bankA, documentId, content);
    const result = withheld(await persistVerifiedUserSourceDomain(
      request(bankA, documentId),
      bridgeFor(h, bankA, suggesterFor(content, [{
        domainId: 'user-relationship',
        ruleId: 'CUSTOM-APPROVED',
        quote: 'I prefer jasmine tea after dinner.',
        claimVerification: 'user_verified',
      }])),
    ));
    expect(result.stage).toBe('eligibility');
    expect(result.cause).toBe('state_pending_review');
    expect(result.suggestion?.links[0]?.ruleApproval).toBe('UNKNOWN');
    expect(result.suggestion?.links[0]?.uncertainty).toContain('rule_unknown');
    expect(recordCount(h.path)).toBe(0);
  });
});
