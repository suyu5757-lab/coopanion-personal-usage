import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, SessionDecl } from 'cortico/core/types.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakePersona, makeLoaded, toolReply } from '../vendor/cortico/tests/core/helpers.ts';
import { COOPANION_TOOL_SCHEMA_DIGESTS } from '../core/tool-schema-roots.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { GrowthProposals, growthProposalArtifactText } from '../core/growth/proposals.ts';
import { GROWTH_SESSION, GrowthReview, isTrustedGrowthToolText } from '../core/growth/review.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { verifyCooSelfGrowthCandidate } from '../core/memory/coo-self-growth-trust.ts';
import {
  SYNTHETIC_BANK_ID,
  SYNTHETIC_COMPLETE_COO_OUTPUT,
  SYNTHETIC_PROPOSAL,
  SYNTHETIC_SOURCES,
} from './fixtures/coo-self-growth-trust/synthetic.ts';

const roots: string[] = [];
const servers: Server[] = [];
const cores: Core[] = [];
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

interface SyntheticDocument {
  text: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

interface SyntheticHindsightServer {
  baseUrl: string;
  seed(documentId: string, text: string, metadata?: Record<string, unknown>): void;
  setSourceText(documentId: string, text: string): void;
  setSourceStatus(documentId: string, status: string): void;
  holdDocumentRead(documentId: string): { started: Promise<void>; release(): void };
}

async function createSyntheticHindsightServer(): Promise<SyntheticHindsightServer> {
  const documents = new Map<string, SyntheticDocument>();
  const deleted = new Set<string>();
  const readGates = new Map<string, { markStarted: () => void; wait: Promise<void> }>();
  const recalled: Array<{
    documentId: string;
    text: string;
    saidAt: string;
    factId: string;
    observationId: string;
  }> = SYNTHETIC_SOURCES.map((source, index) => ({
    ...source,
    factId: `synthetic-fact-${index + 1}`,
    observationId: `synthetic-observation-${index + 1}`,
  }));
  const now = '2026-11-09T00:00:00.000Z';
  for (const source of recalled) {
    documents.set(source.documentId, {
      text: source.text,
      updatedAt: now,
      metadata: {
        source_actor: 'user', kind: 'event', status: 'completed', said_at: source.saidAt,
      },
    });
  }

  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.once('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const bankId = decodeURIComponent(/\/banks\/([^/]+)/.exec(url.pathname)?.[1] ?? SYNTHETIC_BANK_ID);
      const send = (value: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const documentId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const key = `${bankId}:${documentId}`;

      if (req.method === 'DELETE' && url.pathname.includes('/documents/')) {
        deleted.add(key);
        send({ success: true });
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/memories/recall')) {
        const sources = recalled.filter((source) => !deleted.has(`${bankId}:${source.documentId}`));
        send({
          results: sources.map((source) => ({
            id: source.observationId,
            text: 'A synthetic past record.',
            type: 'observation',
            document_id: `synthetic-derived-${source.observationId}`,
            source_fact_ids: [source.factId],
          })),
          source_facts: Object.fromEntries(sources.map((source) => [source.factId, {
            id: source.factId,
            text: source.text,
            type: 'world',
            document_id: source.documentId,
            occurred_start: source.saidAt,
            metadata: {
              source_actor: 'user', kind: 'event', status: 'completed', said_at: source.saidAt,
            },
          }])),
          source_facts_truncated: false,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/documents')) {
        send({ items: [], total: 0, limit: Number(url.searchParams.get('limit') ?? 0), offset: 0 });
        return;
      }

      const document = documents.get(documentId);
      if (!document || deleted.has(key)) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        const response = {
          id: documentId,
          bank_id: bankId,
          original_text: document.text,
          content_hash: sha256(document.text),
          created_at: document.updatedAt,
          updated_at: document.updatedAt,
          memory_unit_count: 1,
          document_metadata: document.metadata,
        };
        const gate = readGates.get(documentId);
        if (gate) {
          readGates.delete(documentId);
          gate.markStarted();
          void gate.wait.then(() => send(response));
        } else send(response);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    seed: (documentId, text, metadata = {
      source_actor: 'coo', kind: 'event', status: 'completed', said_at: now,
    }) => {
      documents.set(documentId, { text, metadata, updatedAt: now });
    },
    setSourceText: (documentId, text) => {
      const source = recalled.find((entry) => entry.documentId === documentId);
      if (!source) throw new Error('unknown synthetic source');
      source.text = text;
      documents.set(documentId, { text, updatedAt: now, metadata: {
        source_actor: 'user', kind: 'event', status: 'completed', said_at: source.saidAt,
      } });
    },
    setSourceStatus: (documentId, status) => {
      const current = documents.get(documentId);
      if (!current) throw new Error('unknown synthetic source');
      documents.set(documentId, { ...current, metadata: { ...current.metadata, status } });
    },
    holdDocumentRead: (documentId) => {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      readGates.set(documentId, { markStarted, wait });
      return { started, release };
    },
  };
}

function createMemory(root: string, server: SyntheticHindsightServer, store: ReturnType<typeof openMemoryStateStore>, bankId = SYNTHETIC_BANK_ID): HindsightMemory {
  const memoryDir = join(root, 'persona');
  mkdirSync(memoryDir, { recursive: true });
  const memory = new HindsightMemory();
  Object.assign(memory, {
    config: loadHindsightConfig(memoryDir, { enabled: true, autostart: false, apiUrl: server.baseUrl, bankId }),
    client: new HindsightClient({ baseUrl: server.baseUrl, maxAttempts: 1 }),
    stateStore: store,
    outbox: new MemoryOutbox(store),
    ledger: new ForgetLedger(store),
    ready: true,
    unavailableUntil: 0,
  });
  return memory;
}

async function buildRig() {
  const root = mkdtempSync(join(tmpdir(), 'coo-self-growth-trust-'));
  roots.push(root);
  const memoryDir = join(root, 'persona');
  const dataDir = join(root, 'data');
  const growthRoot = join(root, 'growth');
  const proposalsDir = join(growthRoot, 'growth-proposals');
  const cardsDir = join(growthRoot, 'experience-cards');
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(growthRoot, { recursive: true });
  const server = await createSyntheticHindsightServer();
  const store = openMemoryStateStore(join(root, 'memory-state.sqlite'));
  const memory = createMemory(root, server, store);

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
  getCoreApi();

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
    memoryDir,
    proposalsDir,
    cardsDir,
    store,
    memory,
    server,
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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Coo self-growth trust boundary', () => {
  it('reads persisted generation evidence and verifies real Growth candidates without promoting them', async () => {
    const rig = await buildRig();
    const proposal = rig.proposals.list()[0]!;
    const card = rig.cards.list()[0]!;
    const proposalArtifact = rig.memory.derivedArtifact(proposal.id)!;
    const cardArtifact = rig.memory.derivedArtifact(card.id)!;
    const proposalEnvelopes = rig.api.generationEvidence(proposalArtifact.creatorSessionId!);
    const cardEnvelopes = rig.api.generationEvidence(cardArtifact.creatorSessionId!);

    const proposalResult = await verifyCooSelfGrowthCandidate({
      memory: rig.memory,
      candidate: { kind: 'growth-proposal', id: proposal.id, store: rig.proposals },
      generationEvidence: proposalEnvelopes,
    });
    const cardResult = await verifyCooSelfGrowthCandidate({
      memory: rig.memory,
      candidate: { kind: 'experience-card', id: card.id, store: rig.cards },
      generationEvidence: cardEnvelopes,
    });

    expect(proposal.state).toBe('candidate');
    expect(proposalResult).toMatchObject({
      status: 'candidate',
      candidateType: 'growth_proposal_candidate',
      candidateId: proposal.id,
      persistable: false,
      userVerified: false,
      toolExecutionPermitted: false,
      evidence: {
        sessionId: proposalArtifact.creatorSessionId,
        generationId: proposalArtifact.creatorGenerationId,
        candidateArtifactBodyDigest: proposalArtifact.bodyDigest,
        parentSources: [expect.objectContaining({
          documentId: SYNTHETIC_SOURCES[0].documentId,
          actor: 'user',
          kind: 'event',
          contentDigest: sha256(SYNTHETIC_SOURCES[0].text),
        }), expect.objectContaining({ documentId: SYNTHETIC_SOURCES[1].documentId, actor: 'user' })],
      },
    });
    expect(proposalResult.status === 'candidate' ? proposalResult.toolPermissions : []).toEqual([]);
    expect(proposalResult.status === 'candidate' ? proposalResult.evidence.candidateSnapshotDigest : '').toBe(sha256(JSON.stringify(proposal)));
    expect(card.userExplicit).toBe(false);
    expect(cardResult).toMatchObject({
      status: 'candidate',
      candidateType: 'experience_card_candidate',
      candidateId: card.id,
      persistable: false,
      userVerified: false,
      toolExecutionPermitted: false,
    });

    const generation = rig.memory.getGenerationEvidence(proposalArtifact.creatorSessionId!, proposalArtifact.creatorGenerationId!);
    expect(generation).toMatchObject({ sessionId: proposalArtifact.creatorSessionId, generationId: proposalArtifact.creatorGenerationId });
    expect(generation && Object.isFrozen(generation)).toBe(true);
    expect(generation && Object.isFrozen(generation.sources)).toBe(true);
    expect(generation && generation.sources.every((source) => Object.isFrozen(source))).toBe(true);
    expect(rig.memory.getGenerationEvidence('wrong-session', proposalArtifact.creatorGenerationId!)).toBeNull();
    expect(rig.memory.getGenerationEvidence(proposalArtifact.creatorSessionId!, 'wrong-generation')).toBeNull();

    const sourceRead = await rig.memory.readExactSourceEvidence(SYNTHETIC_SOURCES[0].documentId);
    expect(sourceRead).toMatchObject({
      bankId: SYNTHETIC_BANK_ID,
      endpoint: rig.server.baseUrl,
      endpointBinding: 'configured-client',
      documentId: SYNTHETIC_SOURCES[0].documentId,
      storedText: SYNTHETIC_SOURCES[0].text,
      contentDigest: sha256(SYNTHETIC_SOURCES[0].text),
      actor: 'user',
      kind: 'event',
      status: 'completed',
    });

    const finishEnvelope = rig.api.generationEvidence(proposalArtifact.creatorSessionId!).find((envelope) =>
      envelope.outputToolCalls.some((call) => call.toolCallId === 'growth-finish-1'));
    expect(finishEnvelope).toBeDefined();
    rig.memory.retainCoo(SYNTHETIC_COMPLETE_COO_OUTPUT, {
      session: finishEnvelope!.sessionId,
      callId: 'growth-finish-1',
    }, finishEnvelope!);
    const retainedItem = new MemoryOutbox(rig.store).matching((item) => item.documentId.includes('growth-finish-1'))[0]!;
    rig.server.seed(retainedItem.documentId, retainedItem.content, {
      source_actor: 'coo', kind: 'event', status: 'completed', said_at: retainedItem.timestamp,
    });
    const retainedRead = await rig.memory.readExactSourceEvidence(retainedItem.documentId);
    const cooArtifact = rig.memory.derivedArtifact(`coo-output:${retainedItem.documentId}`)!;
    const candidateArtifactText = growthProposalArtifactText(proposal);
    const distinctDigests = [
      cooArtifact.bodyDigest,
      retainedRead?.contentDigest,
      proposalArtifact.bodyDigest,
      sha256(JSON.stringify(proposal)),
    ];
    expect(retainedItem.content).toBe(`Coo said to the person: ${SYNTHETIC_COMPLETE_COO_OUTPUT.slice(0, 4000)}`);
    expect(retainedRead?.storedText).toBe(retainedItem.content);
    expect(cooArtifact.bodyDigest).toBe(sha256(SYNTHETIC_COMPLETE_COO_OUTPUT));
    expect(proposalArtifact.bodyDigest).toBe(sha256(candidateArtifactText));
    expect(new Set(distinctDigests).size).toBe(4);
    expect(retainedRead?.actor).toBe('coo');

    await rig.stopCore();
    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    const reopenedMemory = createMemory(rig.root, rig.server, reopenedStore);
    expect(reopenedMemory.getGenerationEvidence(proposalArtifact.creatorSessionId!, proposalArtifact.creatorGenerationId!))
      .toEqual(generation);
  });

  it('withholds a candidate when Forget changes the epoch during exact-source readback', async () => {
    const rig = await buildRig();
    const proposal = rig.proposals.list()[0]!;
    const artifact = rig.memory.derivedArtifact(proposal.id)!;
    const envelopes = rig.api.generationEvidence(artifact.creatorSessionId!);
    const gate = rig.server.holdDocumentRead(SYNTHETIC_SOURCES[0].documentId);
    const verification = verifyCooSelfGrowthCandidate({
      memory: rig.memory,
      candidate: { kind: 'growth-proposal', id: proposal.id, store: rig.proposals },
      generationEvidence: envelopes,
    });
    try {
      const readStarted = await Promise.race([gate.started.then(() => true), verification.then(() => false)]);
      expect(readStarted).toBe(true);
      await rig.memory.forgetDocument(SYNTHETIC_SOURCES[0].documentId);
    } finally {
      gate.release();
    }
    await expect(verification).resolves.toMatchObject({
      status: 'withheld', reason: 'source-readback-unavailable-or-stale',
    });
  });

  it('withholds stale, mismatched, withdrawn, forgotten, and cross-namespace candidates', async () => {
    const rig = await buildRig();
    const proposal = rig.proposals.list()[0]!;
    const card = rig.cards.list()[0]!;
    const proposalArtifact = rig.memory.derivedArtifact(proposal.id)!;
    const cardArtifact = rig.memory.derivedArtifact(card.id)!;
    const proposalEnvelopes = rig.api.generationEvidence(proposalArtifact.creatorSessionId!);
    const cardEnvelopes = rig.api.generationEvidence(cardArtifact.creatorSessionId!);
    const proposalRef = { kind: 'growth-proposal' as const, id: proposal.id, store: rig.proposals };
    const cardRef = { kind: 'experience-card' as const, id: card.id, store: rig.cards };
    const withheld = async (
      memory: HindsightMemory,
      reference: Parameters<typeof verifyCooSelfGrowthCandidate>[0]['candidate'] = proposalRef,
      envelopes: Parameters<typeof verifyCooSelfGrowthCandidate>[0]['generationEvidence'] = proposalEnvelopes,
    ) => verifyCooSelfGrowthCandidate({ memory, candidate: reference, generationEvidence: envelopes });

    expect((await withheld(rig.memory, proposalRef, [])).status).toBe('withheld');
    const tamperedEnvelope = proposalEnvelopes.map((envelope) => envelope.id === proposalArtifact.creatorGenerationId
      ? { ...envelope, serializedBodyDigest: '0'.repeat(64) }
      : envelope);
    expect(await withheld(rig.memory, proposalRef, tamperedEnvelope)).toMatchObject({
      status: 'withheld', reason: 'generation-receipt-mismatch',
    });
    const wrongGeneration = proposalEnvelopes.map((envelope) => envelope.id === proposalArtifact.creatorGenerationId
      ? { ...envelope, id: 'synthetic-wrong-generation' }
      : envelope);
    expect(await withheld(rig.memory, proposalRef, wrongGeneration)).toMatchObject({
      status: 'withheld', reason: 'generation-envelope-missing-or-ambiguous',
    });
    const wrongResponse = proposalEnvelopes.map((envelope) => envelope.id === proposalArtifact.creatorGenerationId
      ? { ...envelope, responseId: 'synthetic-wrong-response' }
      : envelope);
    expect(await withheld(rig.memory, proposalRef, wrongResponse)).toMatchObject({
      status: 'withheld', reason: 'generation-receipt-mismatch',
    });

    const otherStore = openMemoryStateStore(join(rig.root, 'other-memory-state.sqlite'));
    const otherMemory = createMemory(rig.root, rig.server, otherStore);
    expect((await withheld(otherMemory)).status).toBe('withheld');

    const otherBankMemory = createMemory(rig.root, rig.server, rig.store, 'synthetic-other-bank');
    expect((await withheld(otherBankMemory)).status).toBe('withheld');
    const otherEndpointServer = await createSyntheticHindsightServer();
    const otherEndpointMemory = createMemory(rig.root, otherEndpointServer, rig.store);
    expect((await withheld(otherEndpointMemory)).status).toBe('withheld');

    const oneCharacterTamper = SYNTHETIC_SOURCES[0].text.replace('A person', 'a person');
    expect(oneCharacterTamper).not.toBe(SYNTHETIC_SOURCES[0].text);
    rig.server.setSourceText(SYNTHETIC_SOURCES[0].documentId, oneCharacterTamper);
    expect((await withheld(rig.memory)).status).toBe('withheld');
    rig.server.setSourceText(SYNTHETIC_SOURCES[0].documentId, SYNTHETIC_SOURCES[0].text);
    expect((await withheld(rig.memory)).status).toBe('candidate');

    rig.server.setSourceStatus(SYNTHETIC_SOURCES[0].documentId, 'superseded');
    expect(await withheld(rig.memory)).toMatchObject({ status: 'withheld', reason: 'source-readback-unavailable-or-stale' });
    rig.server.setSourceStatus(SYNTHETIC_SOURCES[0].documentId, 'completed');
    expect((await withheld(rig.memory)).status).toBe('candidate');

    expect(rig.proposals.remove(proposal.id)).toBe(true);
    expect(await withheld(rig.memory)).toMatchObject({ status: 'withheld', reason: 'candidate-unavailable-or-withdrawn' });
    expect((await withheld(rig.memory, cardRef, cardEnvelopes)).status).toBe('candidate');

    await rig.memory.forgetDocument(SYNTHETIC_SOURCES[0].documentId);
    expect(await withheld(rig.memory, cardRef, cardEnvelopes)).toMatchObject({
      status: 'withheld', reason: 'artifact-does-not-match-candidate',
    });
    expect(rig.memory.withdrawDerivedArtifact(card.id, 'synthetic candidate withdrawal')).toMatchObject({ lifecycleState: 'withdrawn' });
    expect(await withheld(rig.memory, cardRef, cardEnvelopes)).toMatchObject({
      status: 'withheld', reason: 'artifact-does-not-match-candidate',
    });
  });
});
