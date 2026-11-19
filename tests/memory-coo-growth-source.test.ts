import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, SessionDecl } from 'cortico/core/types.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakePersona, makeLoaded, toolReply } from '../vendor/cortico/tests/core/helpers.ts';
import { COOPANION_TOOL_SCHEMA_DIGESTS } from '../core/tool-schema-roots.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { GrowthProposals } from '../core/growth/proposals.ts';
import { GROWTH_SESSION, GrowthReview, isTrustedGrowthToolText } from '../core/growth/review.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { OutboxDelivery, type DeliveryOps } from '../core/memory/delivery.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { persistCooGrowthCandidateSource, readCooGrowthCandidateSource } from '../core/memory/coo-growth-source.ts';
import {
  SYNTHETIC_BANK_ID,
  SYNTHETIC_COMPLETE_COO_OUTPUT,
  SYNTHETIC_PROPOSAL,
  SYNTHETIC_SOURCES,
} from './fixtures/coo-self-growth-trust/synthetic.ts';
import { createSyntheticCooGrowthBank, type SyntheticCooGrowthBank } from './fixtures/coo-growth-source/synthetic.ts';

const roots: string[] = [];
const banks: SyntheticCooGrowthBank[] = [];
const cores: Core[] = [];
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function createMemory(root: string, bank: SyntheticCooGrowthBank, store: ReturnType<typeof openMemoryStateStore>, bankId = SYNTHETIC_BANK_ID): HindsightMemory {
  const memoryDir = join(root, `memory-${bankId}`);
  mkdirSync(memoryDir, { recursive: true });
  const memory = new HindsightMemory();
  const config = loadHindsightConfig(memoryDir, {
    enabled: true,
    autostart: false,
    apiUrl: bank.baseUrl,
    bankId,
    retain: { async: false },
  });
  const outbox = new MemoryOutbox(store);
  const ledger = new ForgetLedger(store);
  Object.assign(memory, {
    config,
    client: new HindsightClient({ baseUrl: bank.baseUrl, maxAttempts: 1 }),
    stateStore: store,
    outbox,
    ledger,
    ready: true,
    unavailableUntil: 0,
  });
  return memory;
}

function attachDelivery(memory: HindsightMemory): void {
  const runtime = memory as unknown as {
    config: ReturnType<typeof loadHindsightConfig>;
    ledger: ForgetLedger;
    outbox: MemoryOutbox;
    deliveryOps(): DeliveryOps;
  };
  const outbox = runtime.outbox;
  const ledger = runtime.ledger;
  const delivery = new OutboxDelivery(outbox, runtime.deliveryOps(), {
    target: () => ({ bankId: runtime.config.bankId, endpoint: runtime.config.apiUrl }),
    forgotten: (item) => ledger.damaged() || ledger.forgotten(
      item.bankId ?? runtime.config.bankId,
      item.endpoint ?? runtime.config.apiUrl,
      item.documentId,
    ),
  });
  Object.assign(memory, { delivery });
}

async function buildRig() {
  const root = mkdtempSync(join(tmpdir(), 'coo-growth-source-'));
  roots.push(root);
  const memoryDir = join(root, 'persona');
  const dataDir = join(root, 'data');
  const growthRoot = join(root, 'growth');
  const proposalsDir = join(growthRoot, 'growth-proposals');
  const cardsDir = join(growthRoot, 'experience-cards');
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(growthRoot, { recursive: true });
  const bank = await createSyntheticCooGrowthBank();
  banks.push(bank);
  const store = openMemoryStateStore(join(root, 'memory-state.sqlite'));
  const memory = createMemory(root, bank, store);

  const config = makeCfg();
  config.worlds.qq.enabled = false;
  config.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  const growthSession: SessionDecl = {
    id: GROWTH_SESSION,
    label: 'Growth',
    persistent: false,
    receivesEvents: false,
    rounds: () => ({ soft: 3, hard: 4 }),
    tools: () => [],
  };
  const persona = makeFakePersona([], { extraSessions: [growthSession] });
  const baseSystemSegments = persona.systemSegments.bind(persona);
  persona.systemSegments = async (context) => (await baseSystemSegments(context)).map((segment) => ({
    ...segment,
    sourceMapSpans: [{ start: 0, end: segment.text.length, digest: sha256(segment.text), origin: 'core-generated' as const }],
  }));
  persona.validateEvidenceForRequest = (sources, inspection) => sources.length === 0
    || (!!inspection && memory.sourceEvidenceCurrent(inspection) === true);
  persona.onOpening = () => {};
  let api: CoreApi | null = null;
  const getCoreApi = (): CoreApi => {
    const attached = api as CoreApi | null;
    if (!attached) throw new Error('CoreApi was not attached');
    return attached;
  };
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };

  const llm = new FakeLLM();
  llm.script(
    toolReply([{ name: 'memory_search', id: 'growth-search-1', args: { query: 'focus time' } }]),
    toolReply([{ name: 'propose_growth', id: 'growth-proposal-1', args: SYNTHETIC_PROPOSAL }]),
    toolReply([{ name: 'finish_review', id: 'growth-finish-1', args: { note: 'synthetic review complete' } }], SYNTHETIC_COMPLETE_COO_OUTPUT),
    toolReply([{ name: 'memory_search', id: 'growth-search-2', args: { query: 'repeated focus requests' } }]),
    toolReply([{ name: 'propose_experience', id: 'experience-proposal-1', args: {
      title: 'Focused work',
      situation: 'A person requested uninterrupted focus twice.',
      lesson: 'Wait before routine interruptions.',
      scope: 'conversation',
      sourceIds: [SYNTHETIC_SOURCES[0].documentId, SYNTHETIC_SOURCES[1].documentId],
    } }]),
    toolReply([{ name: 'finish_review', id: 'growth-finish-2', args: { note: 'synthetic review complete' } }]),
  );
  const core = new Core(makeLoaded({ config, rootDir: root, memoryDir, dataDir }), {
    persona,
    worlds: [],
    llm,
    toolTextTrust: (tool, text) => isTrustedGrowthToolText(tool, text),
    requireCompleteEvidence: true,
    trustedToolSchemaDigests: [...COOPANION_TOOL_SCHEMA_DIGESTS],
  });
  cores.push(core);
  await core.start();
  await core.loop.reloadSystemPrefix();

  const proposals = new GrowthProposals(proposalsDir);
  const cards = new ExperienceCards(cardsDir);
  const review = new GrowthReview({
    core: getCoreApi,
    snapshot: () => core.session.records.slice(),
    tools: () => [],
    memory: () => memory,
    proposalsDir,
    experienceCardsDir: cardsDir,
    modelLanguage: () => 'en',
    timezone: () => 'UTC',
  });
  await review.run();
  await review.run();

  return {
    root,
    store,
    memory,
    bank,
    core,
    api: getCoreApi(),
    proposals,
    cards,
    stopCore: async () => {
      const index = cores.indexOf(core);
      if (index >= 0) cores.splice(index, 1);
      await core.stop();
    },
  };
}

afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop();
  closeMemoryStateStores();
  await Promise.all(banks.splice(0).map((bank) => new Promise<void>((resolve) => bank.server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Coo Growth source synthetic persistence loop', () => {
  it('writes candidate sources through the Hindsight SDK, reopens SQLite and withholds changed or unauthorized sources', async () => {
    const rig = await buildRig();
    const proposal = rig.proposals.list()[0]!;
    const card = rig.cards.list()[0]!;
    const proposalArtifact = rig.memory.derivedArtifact(proposal.id)!;
    const cardArtifact = rig.memory.derivedArtifact(card.id)!;
    let activeMemory = rig.memory;
    let activeStore = rig.store;
    let proposalInput = {
      memory: rig.memory,
      candidate: { kind: 'growth-proposal' as const, id: proposal.id, store: rig.proposals },
      generationEvidence: rig.api.generationEvidence(proposalArtifact.creatorSessionId!),
    };
    let cardInput = {
      memory: rig.memory,
      candidate: { kind: 'experience-card' as const, id: card.id, store: rig.cards },
      generationEvidence: rig.api.generationEvidence(cardArtifact.creatorSessionId!),
    };

    const finishEnvelope = proposalInput.generationEvidence.find((envelope) => envelope.outputToolCalls
      .some((call) => call.toolCallId === 'growth-finish-1'))!;
    rig.memory.retainCoo(SYNTHETIC_COMPLETE_COO_OUTPUT, {
      session: finishEnvelope.sessionId,
      callId: 'growth-finish-1',
    }, finishEnvelope);
    const retainedItem = new MemoryOutbox(rig.store).matching((item) => item.documentId.includes('growth-finish-1'))[0]!;
    rig.bank.seed(SYNTHETIC_BANK_ID, retainedItem.documentId, retainedItem.content, {
      source_actor: 'coo', kind: 'event', status: 'completed', said_at: retainedItem.timestamp ?? proposal.createdAt,
    });
    attachDelivery(rig.memory);

    const proposalWrite = await persistCooGrowthCandidateSource(proposalInput);
    const cardWrite = await persistCooGrowthCandidateSource(cardInput);
    expect(proposalWrite, JSON.stringify(proposalWrite)).toMatchObject({ status: 'persisted', candidateId: proposal.id });
    expect(cardWrite, JSON.stringify(cardWrite)).toMatchObject({ status: 'persisted', candidateId: card.id });
    if (proposalWrite.status !== 'persisted' || cardWrite.status !== 'persisted') return;

    const proposalRead = await readCooGrowthCandidateSource(proposalInput);
    const cardRead = await readCooGrowthCandidateSource(cardInput);
    expect(proposalRead).toMatchObject({
      status: 'trusted-candidate-source',
      sourceKind: 'plan',
      candidateState: 'candidate',
      factVerified: false,
      planExecuted: false,
      toolExecutionPermitted: false,
      toolPermissions: [],
    });
    expect(cardRead).toMatchObject({ status: 'trusted-candidate-source', sourceKind: 'reflection', candidateState: 'candidate' });
    expect(proposalRead.status === 'trusted-candidate-source' ? proposalRead.toolPermissions : ['unexpected']).toEqual([]);
    expect(cardRead.status === 'trusted-candidate-source' ? cardRead.toolPermissions : ['unexpected']).toEqual([]);

    const proposalDocumentId = proposalWrite.documentId;
    const cardDocumentId = cardWrite.documentId;
    const proposalStored = rig.bank.get(SYNTHETIC_BANK_ID, proposalDocumentId)!;
    const cooOutput = rig.store.listDerivedArtifacts('coo-output').find((artifact) => artifact.target.startsWith('coo:'))!;
    const cooOutputDocument = rig.bank.get(SYNTHETIC_BANK_ID, cooOutput.target)!;
    expect(cooOutput.bodyDigest).toBe(sha256(SYNTHETIC_COMPLETE_COO_OUTPUT));
    expect(cooOutputDocument.text).toBe(`Coo said to the person: ${SYNTHETIC_COMPLETE_COO_OUTPUT.slice(0, 4000)}`);
    expect(cooOutputDocument.metadata.kind).toBe('event');
    expect(proposalStored.metadata).toMatchObject({ source_actor: 'coo', kind: 'plan', status: 'candidate', candidate_state: 'candidate' });
    expect(proposalStored.metadata.candidate_body_sha256).toBe(proposalArtifact.bodyDigest);
    expect(proposalStored.metadata.source_body_sha256).toBe(sha256(proposalStored.text));
    expect(proposalStored.metadata.source_body_sha256).not.toBe(proposalStored.metadata.candidate_body_sha256);
    expect(await rig.memory.readExactSourceEvidence(proposalDocumentId)).toBeNull();
    expect(rig.store.getSourceDomainClassification(SYNTHETIC_BANK_ID, rig.bank.baseUrl, proposalDocumentId)).toBeNull();
    expect(rig.store.loadOutbox().some((item) => (item as { documentId?: string; state?: string }).documentId === proposalDocumentId
      && (item as { state?: string }).state === 'verified')).toBe(true);
    expect(rig.bank.has(SYNTHETIC_BANK_ID, cardDocumentId)).toBe(true);

    await rig.stopCore();
    closeMemoryStateStores();
    activeStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    activeMemory = createMemory(rig.root, rig.bank, activeStore);
    attachDelivery(activeMemory);
    proposalInput = { ...proposalInput, memory: activeMemory };
    cardInput = { ...cardInput, memory: activeMemory };
    expect((await readCooGrowthCandidateSource(proposalInput)).status).toBe('trusted-candidate-source');
    expect((await readCooGrowthCandidateSource(cardInput)).status).toBe('trusted-candidate-source');

    const wrongGeneration = await readCooGrowthCandidateSource({ ...proposalInput, generationEvidence: [] });
    expect(wrongGeneration.status).toBe('withheld');
    const wrongResponse = proposalInput.generationEvidence.map((envelope) => envelope.id === proposalArtifact.creatorGenerationId
      ? { ...envelope, responseId: 'synthetic-wrong-response' }
      : envelope);
    expect((await readCooGrowthCandidateSource({ ...proposalInput, generationEvidence: wrongResponse })).status).toBe('withheld');

    const wrongBankMemory = createMemory(rig.root, rig.bank, activeStore, 'synthetic-other-bank');
    expect((await readCooGrowthCandidateSource({ ...proposalInput, memory: wrongBankMemory })).status).toBe('withheld');
    const otherEndpoint = await createSyntheticCooGrowthBank();
    banks.push(otherEndpoint);
    const wrongEndpointMemory = createMemory(rig.root, otherEndpoint, activeStore);
    expect((await readCooGrowthCandidateSource({ ...proposalInput, memory: wrongEndpointMemory })).status).toBe('withheld');

    const parent = rig.bank.get(SYNTHETIC_BANK_ID, SYNTHETIC_SOURCES[0].documentId)!;
    rig.bank.replace(SYNTHETIC_BANK_ID, SYNTHETIC_SOURCES[0].documentId, parent.text, { ...parent.metadata, source_actor: 'coo' });
    expect((await readCooGrowthCandidateSource(proposalInput)).status).toBe('withheld');
    rig.bank.replace(SYNTHETIC_BANK_ID, SYNTHETIC_SOURCES[0].documentId, parent.text, parent.metadata);

    const cardSource = rig.bank.get(SYNTHETIC_BANK_ID, cardDocumentId)!;
    rig.bank.replace(SYNTHETIC_BANK_ID, cardDocumentId, `${cardSource.text}tampered`, cardSource.metadata);
    expect((await readCooGrowthCandidateSource(cardInput)).status).toBe('withheld');
    rig.bank.replace(SYNTHETIC_BANK_ID, cardDocumentId, cardSource.text, cardSource.metadata);
    rig.bank.replace(SYNTHETIC_BANK_ID, cardDocumentId, cardSource.text, { ...cardSource.metadata, kind: 'self_report' });
    expect(await readCooGrowthCandidateSource(cardInput)).toMatchObject({
      status: 'withheld',
      toolExecutionPermitted: false,
      toolPermissions: [],
    });
    rig.bank.replace(SYNTHETIC_BANK_ID, cardDocumentId, cardSource.text, cardSource.metadata);

    const gate = rig.bank.holdRead(SYNTHETIC_BANK_ID, proposalDocumentId);
    const concurrentRead = readCooGrowthCandidateSource(proposalInput);
    await gate.started;
    rig.bank.replace(SYNTHETIC_BANK_ID, proposalDocumentId, `${proposalStored.text}changed`, proposalStored.metadata);
    gate.release();
    expect((await concurrentRead).status).toBe('withheld');
    rig.bank.replace(SYNTHETIC_BANK_ID, proposalDocumentId, proposalStored.text, proposalStored.metadata);

    expect(rig.cards.transition(card.id, 'rejected')).not.toBeNull();
    expect((await readCooGrowthCandidateSource(cardInput)).status).toBe('withheld');
    expect(activeStore.markDerivedArtifactState(proposal.id, 'withdrawn', 'synthetic artifact withdrawal', new Date().toISOString())).not.toBeNull();
    expect((await readCooGrowthCandidateSource(proposalInput)).status).toBe('withheld');

    const forget = await activeMemory.forgetDocument(SYNTHETIC_SOURCES[0].documentId);
    expect(['accepted', 'already-forgotten']).toContain(forget.acceptance);
    expect(rig.bank.has(SYNTHETIC_BANK_ID, proposalDocumentId)).toBe(false);
    expect((await readCooGrowthCandidateSource(proposalInput)).status).toBe('withheld');
  });
});
