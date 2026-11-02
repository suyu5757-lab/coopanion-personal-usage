import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, World, WorldHost } from 'cortico/core/types.ts';
import { inspectContextEvidence } from 'cortico/core/evidence.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeLoaded, textReply, toolReply } from '../vendor/cortico/tests/core/helpers.ts';
import { coopanionPersona } from '../core/persona.ts';
import { ExperienceCards } from '../core/growth/experience-cards.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';

const SOURCE_TEXT = 'The person prefers jasmine tea.';
const roots: string[] = [];
const servers: Server[] = [];
const activeCores: Core[] = [];

afterEach(async () => {
  for (const core of activeCores.splice(0)) await core.stop();
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function hindsightServer(
  sourceAvailable: boolean,
  factText = SOURCE_TEXT,
  beforeDocumentRead?: () => Promise<void>,
): Promise<{ baseUrl: string; recallRequests: () => number }> {
  let recallCount = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.once('end', async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (value: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname.endsWith('/memories/recall')) {
        recallCount += 1;
        send({
          results: [{ id: 'observation-1', text: 'A past record.', type: 'observation', document_id: 'derived-1', source_fact_ids: ['fact-1'] }],
          source_facts: {
            'fact-1': {
              id: 'fact-1', text: factText, type: 'world', document_id: 'doc-1',
              occurred_start: '2024-05-01T10:00:00.000Z',
              metadata: { source_actor: 'user', kind: 'event', status: 'completed' },
            },
          },
          source_facts_truncated: false,
        });
        return;
      }
      if (url.pathname.endsWith('/documents') && req.method === 'GET') {
        send({ items: [], total: 0, limit: Number(url.searchParams.get('limit') ?? 0), offset: Number(url.searchParams.get('offset') ?? 0) });
        return;
      }
      const documentId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      if (documentId !== 'doc-1' || !sourceAvailable) {
        res.writeHead(404);
        res.end();
        return;
      }
      await beforeDocumentRead?.();
      send({
        id: 'doc-1', bank_id: 'fixture-bank', original_text: SOURCE_TEXT,
        content_hash: 'synthetic-content-hash', created_at: '2024-05-01T10:00:00.000Z',
        updated_at: '2024-05-01T10:00:00.000Z', memory_unit_count: 1,
        document_metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: '2024-05-01T10:00:00.000Z' },
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, recallRequests: () => recallCount };
}

async function buildRig(sourceAvailable: boolean, factText?: string, beforeDocumentRead?: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'coo-memory-evidence-consumer-'));
  roots.push(root);
  const memoryDir = join(root, 'persona');
  const server = await hindsightServer(sourceAvailable, factText, beforeDocumentRead);
  const store = openMemoryStateStore(join(memoryDir, 'memory-state.sqlite'));
  const memory = new HindsightMemory();
  Object.assign(memory, {
    config: loadHindsightConfig(memoryDir, { enabled: true, autostart: false, apiUrl: server.baseUrl, bankId: 'fixture-bank' }),
    client: new HindsightClient({ baseUrl: server.baseUrl, maxAttempts: 1 }),
    stateStore: store,
    outbox: new MemoryOutbox(store),
    ledger: new ForgetLedger(store),
    ready: true,
    unavailableUntil: 0,
  });

  const config = makeCfg();
  config.worlds.qq.enabled = false;
  config.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  const Persona = coopanionPersona(Cormini, { memory });
  const persona = new Persona({ memoryDir });
  persona.onOpening = () => {};
  let api: CoreApi | null = null;
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };
  let host: WorldHost | null = null;
  const world = makeFakeIO('desktop-pet');
  const startWorld = world.start?.bind(world);
  world.start = async (currentHost) => { host = currentHost; await startWorld?.(currentHost); };
  const llm = new FakeLLM();
  llm.script(
    toolReply([{ name: 'memory_search', args: { query: 'what did I say about tea?' }, id: 'memory-search-1' }]),
    toolReply([{ name: 'memory_search', args: { query: 'jasmine tea preference' }, id: 'memory-search-2' }]),
    textReply('Done.'),
  );
  const core = new Core(makeLoaded({ config, rootDir: root, memoryDir, dataDir: join(root, 'data') }), {
    persona,
    worlds: [world],
    llm,
  });
  activeCores.push(core);
  await core.start();
  const coreApi = (): CoreApi => {
    if (!api) throw new Error('CoreApi was not attached');
    return api;
  };
  const worldHost = (): WorldHost => {
    if (!host) throw new Error('WorldHost was not attached');
    return host;
  };
  return {
    root, memoryDir, core, llm, memory, persona, baseUrl: server.baseUrl, recallRequests: server.recallRequests,
    api: coreApi,
    host: worldHost,
  };
}

async function buildSourceFreeRig() {
  const root = mkdtempSync(join(tmpdir(), 'coo-source-free-handoff-'));
  roots.push(root);
  const memoryDir = join(root, 'persona');
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  config.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  const Persona = coopanionPersona(Cormini);
  const persona = new Persona({ memoryDir });
  persona.onOpening = () => {};
  let api: CoreApi | null = null;
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };
  let host: WorldHost | null = null;
  const world: World = makeFakeIO('desktop-pet');
  const startWorld = world.start?.bind(world);
  world.start = async (currentHost) => { host = currentHost; await startWorld?.(currentHost); };
  const llm = new FakeLLM();
  llm.script(textReply('Ready.'));
  const core = new Core(makeLoaded({ config, rootDir: root, memoryDir, dataDir: join(root, 'data') }), {
    persona,
    worlds: [world],
    llm,
  });
  activeCores.push(core);
  await core.start();
  const coreApi = (): CoreApi => {
    if (!api) throw new Error('CoreApi was not attached');
    return api;
  };
  const worldHost = (): WorldHost => {
    if (!host) throw new Error('WorldHost was not attached');
    return host;
  };
  return { root, memoryDir, core, persona, api: coreApi, host: worldHost, llm };
}

describe('Memory source evidence through the real Core consumer', () => {
  it('attaches exact read-back spans from two tool rounds to serialized provider requests', async () => {
    const rig = await buildRig(true);
    const candidates = await rig.memory.searchResultsDetailed('jasmine tea preference');
    expect(candidates.results).toHaveLength(1);
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);

    const envelopes = rig.api().generationEvidence('main');
    expect(rig.recallRequests()).toBe(3);
    expect(envelopes[0]).toMatchObject({ requestState: 'sent', exposedSources: [], actualEvidenceUsed: 'unknown' });
    expect(envelopes[1]?.exposedSources).toMatchObject([{
      bankId: 'fixture-bank', endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/), documentId: 'doc-1',
      revisionState: 'current', validationStatus: 'validated', contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(envelopes[2]?.exposedSources.map((source) => source.documentId)).toEqual(['doc-1']);
    expect(envelopes[1]).toMatchObject({ mappingState: 'missing', actualEvidenceUsed: 'unknown' });

    const resultRecord = rig.core.session.records.find((record) => record.context.toolCallId === 'memory-search-1');
    const attachment = resultRecord?.context.evidence?.find((item) => item.documentId === 'doc-1');
    expect(resultRecord).toBeDefined();
    expect(attachment).toBeDefined();
    expect(textOf(resultRecord!)).toContain(SOURCE_TEXT);
    expect(textOf(resultRecord!)).toContain('Supporting source evidence is incomplete');
    expect(textOf(resultRecord!).slice(attachment!.segment.start, attachment!.segment.end)).toBe(SOURCE_TEXT);
    expect(attachment?.segment.digest).toBe(createHash('sha256').update(SOURCE_TEXT, 'utf8').digest('hex'));
    expect(JSON.stringify(rig.llm.calls[1]?.messages)).toContain(SOURCE_TEXT);

    expect(rig.api().requestContextHandoff()).toBe(true);
    await waitFor(() => rig.api().handoffOutcome()?.status === 'committed');
    expect(rig.api().handoffOutcome()).toMatchObject({ status: 'committed', mappingState: 'complete' });
    const handoffDir = join(rig.memoryDir, 'handoffs');
    const files = readdirSync(handoffDir).filter((name) => name.endsWith('.md'));
    expect(files).toHaveLength(1);
    const note = readFileSync(join(handoffDir, files[0]!), 'utf8');
    expect(note).toContain(SOURCE_TEXT);
    expect(note).not.toContain('Supporting source evidence is incomplete');
    await waitFor(() => rig.api().sessionInfo('main').snapshot?.some((entry) => textOf(entry).includes(SOURCE_TEXT)) === true);
    await waitFor(() => rig.api().generationEvidence('main').length >= 4);
    const notice = rig.core.session.records.find((entry) => entry.item.type === 'message'
      && entry.item.role === 'user' && textOf(entry).includes('1 new event.'));
    expect(notice?.context.sourceDependencySpans?.flatMap((span) => span.exposedSources.map((source) => source.documentId)))
      .toContain('doc-1');
    expect(rig.api().generationEvidence('main').at(-1)).toMatchObject({
      mappingState: 'missing', actualEvidenceUsed: 'unknown',
      exposedSources: [expect.objectContaining({ documentId: 'doc-1', validationStatus: 'validated', revisionState: 'current' })],
    });
  });

  it('blocks the real Core handoff when Forget fences a source during prepare read-back', async () => {
    let pauseRead = false;
    let releaseRead!: () => void;
    let signalStarted!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const rig = await buildRig(true, undefined, async () => {
      if (!pauseRead) return;
      signalStarted();
      await readGate;
    });
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');
    const recordsBeforeHandoff = rig.core.session.records.length;
    pauseRead = true;
    expect(rig.api().requestContextHandoff()).toBe(true);
    await readStarted;

    const ledger = (rig.memory as unknown as { ledger: ForgetLedger }).ledger;
    ledger.addMany([{ bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-1', reason: 'handoff race' }], 'handoff race');
    releaseRead();
    await waitFor(() => rig.api().handoffOutcome()?.status === 'blocked');
    expect(rig.api().handoffOutcome()).toMatchObject({ status: 'blocked', mappingState: 'complete' });
    expect(rig.core.session.records).toHaveLength(recordsBeforeHandoff);
    expect(existsSync(join(rig.memoryDir, 'handoffs'))).toBe(false);
    expect(rig.api().sessionInfo('main').snapshot?.some((entry) => JSON.stringify(entry).includes('handoff-note'))).toBe(false);
  });

  it('leaves a recalled source unexposed when document read-back is missing', async () => {
    const rig = await buildRig(false);
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);

    const envelopes = rig.api().generationEvidence('main');
    expect(envelopes[1]).toMatchObject({ exposedSources: [], mappingState: 'missing', actualEvidenceUsed: 'unknown' });
    const resultRecord = rig.core.session.records.find((record) => record.context.toolCallId === 'memory-search-1');
    expect(resultRecord?.context.evidence).toBeUndefined();
    expect(textOf(resultRecord!)).toContain('Supporting source evidence is incomplete');
  });

  it('keeps a source attachment unverified when its rendered fact does not match read-back text', async () => {
    const rig = await buildRig(true, 'The person prefers dark roast coffee.');
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);

    const envelope = rig.api().generationEvidence('main')[1];
    expect(envelope).toMatchObject({ exposedSources: [], mappingState: 'unverified', actualEvidenceUsed: 'unknown' });
    const resultRecord = rig.core.session.records.find((record) => record.context.toolCallId === 'memory-search-1');
    expect(resultRecord?.context.evidence?.[0]).toMatchObject({ validationStatus: 'unknown', documentId: 'doc-1' });
    expect(textOf(resultRecord!)).toContain('Supporting source evidence is incomplete');
  });

  it('drops a late Memory tool result after its Core generation is invalidated', async () => {
    const rig = await buildRig(true);
    let startReadback!: () => void;
    let releaseReadback!: () => void;
    const readbackStarted = new Promise<void>((resolve) => { startReadback = resolve; });
    const readbackGate = new Promise<void>((resolve) => { releaseReadback = resolve; });
    const readEvidence = rig.memory.evidenceForRead.bind(rig.memory);
    rig.memory.evidenceForRead = async (read) => {
      startReadback();
      await readbackGate;
      return readEvidence(read);
    };
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await readbackStarted;

    const generation = rig.api().sessionInfo('main').generation;
    if (!generation) throw new Error('Core did not provide a generation token');
    const invalidate = rig.api().invalidateGeneration;
    if (!invalidate) throw new Error('Core did not expose generation invalidation');
    const invalidation = invalidate({
      sessionId: 'main', expectedGeneration: generation.token, reason: 'forget', idempotencyKey: 'synthetic-late-evidence',
    });
    const ledger = (rig.memory as unknown as { ledger: ForgetLedger }).ledger;
    ledger.addMany([{ bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-1', reason: 'synthetic forget fence' }], 'synthetic forget fence');
    rig.llm.queue.splice(0, rig.llm.queue.length, textReply('Fresh generation.'));
    releaseReadback();
    await expect(invalidation).resolves.toMatchObject({ status: 'acknowledged' });

    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello again', meta: { text: 'hello again' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 2);
    const envelopes = rig.api().generationEvidence('main');
    expect(envelopes.at(-1)?.exposedSources).toEqual([]);
    expect(rig.core.session.records.flatMap((record) => record.context.evidence ?? []).filter((attachment) => attachment.documentId === 'doc-1')).toEqual([]);
  });

  it('withdraws an attachment when the local forget epoch fences its source', async () => {
    const rig = await buildRig(true);
    const segments = [{ documentId: 'doc-1', start: 0, end: SOURCE_TEXT.length }];
    const beforeEpoch = rig.memory.evidenceEpoch();
    const before = await rig.memory.evidenceForSegments(SOURCE_TEXT, segments);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ validationStatus: 'validated', revisionState: 'current', validatedEpoch: beforeEpoch });

    const ledger = (rig.memory as unknown as { ledger: ForgetLedger }).ledger;
    expect(ledger.addMany([{
      bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-1', reason: 'synthetic forget fence',
    }], 'synthetic forget fence').failed).toBe(0);
    expect(rig.memory.evidenceEpoch()).not.toBe(beforeEpoch);
    expect(await rig.memory.evidenceForSegments(SOURCE_TEXT, segments)).toEqual([]);
  });

  it('blocks a staged protected handoff when the forget epoch changes before commit', async () => {
    const rig = await buildRig(true);
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');
    const generation = rig.api().sessionInfo('main').generation;
    if (!generation) throw new Error('Core did not provide a generation token');

    const sourceText = SOURCE_TEXT;
    const [attachment] = await rig.memory.evidenceForSegments(sourceText, [{ documentId: 'doc-1', start: 0, end: sourceText.length }]);
    if (!attachment) throw new Error('Synthetic source read-back did not produce an attachment');
    const snapshot = [message('user', sourceText, { evidence: [attachment] })];
    const prepared = await rig.persona.prepareHandoff(snapshot, {
      hardTokens: null, sessionId: 'main', expectedGeneration: generation.token, candidateSnapshotId: 'protected-candidate',
      sourceEvidence: inspectContextEvidence(snapshot),
      inspectCandidate: (records) => inspectContextEvidence(records),
    });
    expect(prepared.commitGuard?.()).toEqual({ status: 'allow' });
    const handoffDir = join(rig.memoryDir, 'handoffs');
    expect(readdirSync(join(handoffDir, '.staging'))).toHaveLength(1);
    expect(readdirSync(handoffDir).filter((name) => name.endsWith('.md'))).toEqual([]);

    const ledger = (rig.memory as unknown as { ledger: ForgetLedger }).ledger;
    ledger.addMany([{ bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-1', reason: 'synthetic forget fence' }], 'synthetic forget fence');
    expect(prepared.commitGuard?.()).toMatchObject({ status: 'blocked' });
    prepared.discard?.();
    expect(existsSync(handoffDir)).toBe(false);
  });

  it('publishes once and discard removes only the candidate file it owns', async () => {
    const rig = await buildRig(true);
    const generation = rig.api().sessionInfo('main').generation;
    if (!generation) throw new Error('Core did not provide a generation token');
    const [attachment] = await rig.memory.evidenceForSegments(SOURCE_TEXT, [{ documentId: 'doc-1', start: 0, end: SOURCE_TEXT.length }]);
    if (!attachment) throw new Error('Synthetic source read-back did not produce an attachment');
    const snapshot = [message('user', SOURCE_TEXT, { evidence: [attachment] })];
    const handoffDir = join(rig.memoryDir, 'handoffs');
    mkdirSync(handoffDir, { recursive: true });
    const otherFile = join(handoffDir, 'owned-elsewhere.md');
    writeFileSync(otherFile, 'preserve');
    const prepared = await rig.persona.prepareHandoff(snapshot, {
      hardTokens: null, sessionId: 'main', expectedGeneration: generation.token, candidateSnapshotId: 'owned-candidate',
      sourceEvidence: inspectContextEvidence(snapshot), inspectCandidate: (records) => inspectContextEvidence(records),
    });
    expect(prepared.commitGuard?.()).toEqual({ status: 'allow' });
    prepared.commit?.();
    expect(() => prepared.commit?.()).toThrow('already committed');
    expect(readdirSync(handoffDir).filter((name) => name.endsWith('.md'))).toHaveLength(2);
    prepared.discard?.();
    expect(readdirSync(handoffDir)).toEqual(['owned-elsewhere.md']);
    expect(readFileSync(otherFile, 'utf8')).toBe('preserve');
  });

  it('attaches approved ExperienceCard text only after validating every stored source ID', async () => {
    const rig = await buildRig(true);
    const cards = new ExperienceCards(join(rig.memoryDir, 'experience-cards'));
    const created = cards.create({
      title: 'Tea preference', situation: 'Choosing a drink.', lesson: 'Offer jasmine tea.',
      scope: 'conversation', sourceIds: ['doc-1'],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    cards.transition(created.card.id, 'approved');
    const Persona = coopanionPersona(Cormini, { memory: rig.memory, growthStateFile: join(rig.memoryDir, 'growth.json') });
    const persona = new Persona({ memoryDir: rig.memoryDir });
    const context = await (persona as unknown as { experienceContext(): Promise<{ text: string; evidence: Array<{ documentId: string; validationStatus: string }> }> }).experienceContext();

    expect(context.text).toContain('Offer jasmine tea.');
    expect(context.evidence.map((attachment) => attachment.documentId)).toEqual(['doc-1']);
    expect(context.evidence.every((attachment) => attachment.validationStatus === 'validated')).toBe(true);
  });

  it('keeps an earlier handoff note from entering the source-free compatibility path', async () => {
    const rig = await buildSourceFreeRig();
    const generation = rig.api().sessionInfo('main').generation;
    if (!generation) throw new Error('Core did not provide a generation token');
    const text = 'Earlier handoff summary.';
    const snapshot = [message('user', text, {
      frame: { events: [{ cursor: 1, ts: new Date().toISOString(), type: 'handoff-note', source: 'persona', start: 0, chars: text.length }] },
    })];
    const prepared = await rig.persona.prepareHandoff(snapshot, {
      hardTokens: null,
      sessionId: 'main',
      expectedGeneration: generation.token,
      candidateSnapshotId: 'prior-handoff-candidate',
      sourceEvidence: inspectContextEvidence(snapshot),
      inspectCandidate: (records) => inspectContextEvidence(records),
    });

    expect(prepared.protected).toBe(true);
    expect(prepared.commitGuard?.()).toMatchObject({ status: 'blocked' });
    prepared.discard?.();
    expect(existsSync(join(rig.memoryDir, 'handoffs'))).toBe(false);
  });

  it('stages, publishes and injects a source-free handoff after the guard allows it', async () => {
    const rig = await buildSourceFreeRig();
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: 'Continue the local task.', meta: { text: 'Continue the local task.' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.llm.calls.length > 0);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');

    expect(rig.api().requestContextHandoff()).toBe(true);
    await waitFor(() => rig.api().handoffOutcome() !== null);
    expect(rig.api().handoffOutcome()).toMatchObject({ status: 'committed', mappingState: 'complete' });
    const handoffDir = join(rig.memoryDir, 'handoffs');
    const files = readdirSync(handoffDir);
    const notes = files.filter((name) => name.endsWith('.md'));
    expect(notes).toHaveLength(1);
    expect(files).not.toContain('.staging');
    expect(readFileSync(join(handoffDir, notes[0]!), 'utf8')).toContain('Continue the local task.');
    expect(rig.core.session.records.map((record) => textOf(record)).join('\n')).toContain(notes[0]!);
  });
});
