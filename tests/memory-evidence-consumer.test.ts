import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, ToolDef, World, WorldHost } from 'cortico/core/types.ts';
import { inspectContextEvidence } from 'cortico/core/evidence.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeLoaded, makeTool, textReply, toolReply } from '../vendor/cortico/tests/core/helpers.ts';
import { coopanionPersona, PARTNER_FILE } from '../core/persona.ts';
import { ExperienceCards, experienceCardArtifactText } from '../core/growth/experience-cards.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, memoryArtifactScope, openMemoryStateStore } from '../core/memory/state-store.ts';
import { partnerProvenancePath, partnerSegmentDigest, partnerSourceScopeDigest, partnerWorkspaceDigest, readPartnerProvenance, writePartnerProvenance } from '../core/memory/partner-provenance.ts';

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

function serializedStringAt(body: string, field: string): string {
  const tokens = field.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let value: unknown = JSON.parse(body);
  for (const token of tokens) {
    if (value && typeof value === 'object') value = (value as Record<string, unknown>)[token];
    else throw new Error(`serialized field is not an object at ${token}`);
  }
  if (typeof value !== 'string') throw new Error(`serialized field is not text: ${field}`);
  return value;
}

async function hindsightServer(
  sourceAvailable: boolean,
  factText = SOURCE_TEXT,
  beforeDocumentRead?: () => Promise<void>,
  additionalSources: Array<{ documentId: string; text: string }> = [],
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
        const sources = [
          { factId: 'fact-1', observationId: 'observation-1', documentId: 'doc-1', text: factText },
          ...additionalSources.map((source, index) => ({
            factId: `fact-${index + 2}`, observationId: `observation-${index + 2}`,
            documentId: source.documentId, text: source.text,
          })),
        ];
        send({
          results: sources.map((source, index) => ({ id: source.observationId, text: 'A past record.', type: 'observation',
            document_id: `derived-${index + 1}`, source_fact_ids: [source.factId] })),
          source_facts: Object.fromEntries(sources.map((source) => [source.factId, {
              id: source.factId, text: source.text, type: 'world', document_id: source.documentId,
              occurred_start: '2024-05-01T10:00:00.000Z',
              metadata: { source_actor: 'user', kind: 'event', status: 'completed' },
            }])),
          source_facts_truncated: false,
        });
        return;
      }
      if (url.pathname.endsWith('/documents') && req.method === 'GET') {
        send({ items: [], total: 0, limit: Number(url.searchParams.get('limit') ?? 0), offset: Number(url.searchParams.get('offset') ?? 0) });
        return;
      }
      const documentId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const document = documentId === 'doc-1'
        ? { text: SOURCE_TEXT }
        : additionalSources.find((source) => source.documentId === documentId);
      if (!document || !sourceAvailable) {
        res.writeHead(404);
        res.end();
        return;
      }
      await beforeDocumentRead?.();
      send({
        id: documentId, bank_id: 'fixture-bank', original_text: document.text,
        content_hash: createHash('sha256').update(document.text, 'utf8').digest('hex'), created_at: '2024-05-01T10:00:00.000Z',
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

async function buildRig(
  sourceAvailable: boolean,
  factText?: string,
  beforeDocumentRead?: () => Promise<void>,
  options: {
    partnerSummary?: string;
    partnerAdditionalDerived?: Array<{ documentId: string; text: string }>;
    partnerUserNote?: string;
    additionalSources?: Array<{ documentId: string; text: string }>;
    tools?: ToolDef[];
    worldPrompt?: string;
    llmSetup?: (llm: FakeLLM) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'coo-memory-evidence-consumer-'));
  roots.push(root);
  const memoryDir = join(root, 'persona');
  const server = await hindsightServer(sourceAvailable, factText, beforeDocumentRead, options.additionalSources);
  const store = openMemoryStateStore(join(root, 'memory-state.sqlite'));
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
  const derivedPartnerParagraphs = [
    ...(options.partnerSummary ? [{ documentId: 'doc-1', text: options.partnerSummary }] : []),
    ...(options.partnerAdditionalDerived ?? []),
  ];
  const hasPartnerDocument = derivedPartnerParagraphs.length > 0 || !!options.partnerUserNote;
  const growthStateFile = hasPartnerDocument ? join(root, 'growth', 'state.json') : undefined;
  if (growthStateFile) mkdirSync(join(root, 'growth'), { recursive: true });
  const Persona = coopanionPersona(Cormini, { memory, ...(growthStateFile ? { growthStateFile } : {}) });
  const persona = new Persona({ memoryDir });
  if (hasPartnerDocument) {
    const partnerText = [...derivedPartnerParagraphs.map((entry) => entry.text), options.partnerUserNote].filter(Boolean).join('\n\n');
    writeFileSync(join(memoryDir, PARTNER_FILE), `${partnerText}\n`, 'utf8');
    writePartnerProvenance(partnerProvenancePath(join(root, 'growth'), memoryDir), {
      v: 1,
      workspaceDigest: partnerWorkspaceDigest(memoryDir),
      entries: [
        ...derivedPartnerParagraphs.map((entry, index) => ({
          id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
          segmentDigest: partnerSegmentDigest(entry.text), origin: 'derived' as const,
          sourceIds: [entry.documentId], sourceScopeDigest: partnerSourceScopeDigest('fixture-bank', server.baseUrl), state: 'current' as const,
        })),
        ...(options.partnerUserNote ? [{
          id: `00000000-0000-0000-0000-${String(derivedPartnerParagraphs.length + 1).padStart(12, '0')}`,
          segmentDigest: partnerSegmentDigest(options.partnerUserNote), origin: 'user-authored' as const,
          sourceIds: [], sourceScopeDigest: null, state: 'current' as const,
        }] : []),
      ],
    });
  }
  persona.onOpening = () => {};
  let api: CoreApi | null = null;
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };
  let host: WorldHost | null = null;
  const world = makeFakeIO('desktop-pet', options.tools ?? [], options.worldPrompt ?? '');
  const startWorld = world.start?.bind(world);
  world.start = async (currentHost) => { host = currentHost; await startWorld?.(currentHost); };
  const llm = new FakeLLM();
  const serializedBodies: string[] = [];
  const dispatchedBodies: string[] = [];
  const respond = llm.respond.bind(llm);
  llm.respond = (request, providerOptions) => respond(request, {
    ...providerOptions,
    onRequestReady: (info) => {
      if (typeof info.body === 'string') serializedBodies.push(info.body);
      return providerOptions?.onRequestReady?.(info) ?? true;
    },
    onRequestSent: (info) => {
      if (typeof info.body === 'string') dispatchedBodies.push(info.body);
      providerOptions?.onRequestSent?.(info);
    },
  });
  if (options.llmSetup) options.llmSetup(llm);
  else llm.script(
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
    root, memoryDir, core, llm, memory, persona, baseUrl: server.baseUrl, recallRequests: server.recallRequests, serializedBodies, dispatchedBodies,
    api: coreApi,
    host: worldHost,
  };
}

async function buildSourceFreeRig(reply = 'Ready.') {
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
  llm.script(textReply(reply));
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
    const partnerSummary = 'Coo 保存的偏好：茉莉茶 🌿；茉莉茶';
    const rig = await buildRig(true, undefined, undefined, { partnerSummary });
    const candidates = await rig.memory.searchResultsDetailed('jasmine tea preference');
    expect(candidates.results).toHaveLength(1);
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);

    const envelopes = rig.api().generationEvidence('main');
    expect(rig.recallRequests()).toBe(3);
    expect(envelopes[0]).toMatchObject({ requestState: 'sent', actualEvidenceUsed: 'unknown' });
    expect(envelopes[0]?.exposedSources.map((source) => source.documentId)).toContain('doc-1');
    const initialSystem = rig.core.session.records.find((record) => record.item.type === 'message' && record.item.role === 'system');
    const initialSystemCoverage = envelopes[0]?.items.find((item) => item.itemId === initialSystem?.item.id);
    expect(initialSystemCoverage?.mappingState).toBe('missing');
    expect(initialSystemCoverage?.spans.some((span) => span.origin === 'hindsight-source'
      && span.mappingState === 'complete' && span.exposedSources.some((source) => source.documentId === 'doc-1'))).toBe(true);
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
      actualEvidenceUsed: 'unknown',
      exposedSources: [expect.objectContaining({ documentId: 'doc-1', validationStatus: 'validated', revisionState: 'current' })],
    });
    expect(rig.api().generationEvidence('main').at(-1)?.mappingState).not.toBe('complete');

    const nextRequest = rig.api().generationEvidence('main').at(-1)!;
    const systemRecord = rig.core.session.records.find((entry) => entry.item.type === 'message' && entry.item.role === 'system');
    if (!systemRecord) throw new Error('rebuilt system prefix is absent after Handoff');
    const systemCoverage = nextRequest.items.find((item) => item.itemId === systemRecord.item.id);
    const partnerSpan = systemCoverage?.spans.find((span) => span.origin === 'hindsight-source'
      && span.exposedSources.some((source) => source.documentId === 'doc-1'));
    expect(systemCoverage?.mappingState).toBe('missing');
    expect(partnerSpan).toMatchObject({ mappingState: 'complete' });
    const mappedSource = partnerSpan?.exposedSources[0];
    expect(partnerSpan?.exposedSources).toEqual([nextRequest.exposedSources.find((source) => source.documentId === 'doc-1')]);
    expect(mappedSource).toMatchObject({
      bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-1', revisionState: 'current', validationStatus: 'validated',
      validatedEpoch: expect.any(String), validationReceipt: expect.stringMatching(/^[a-f0-9]{64}$/),
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const systemText = textOf(systemRecord);
    const partnerText = systemText.slice(partnerSpan!.start, partnerSpan!.end);
    expect(partnerText).toContain(partnerSummary);
    expect(partnerSpan!.digest).toBe(createHash('sha256').update(partnerText, 'utf8').digest('hex'));
    expect(partnerSpan!.serializedRanges).toHaveLength(1);
    expect(partnerSpan!.end - partnerSpan!.start).toBe(partnerText.length);
    const body = rig.serializedBodies.at(-1)!;
    expect(nextRequest.serializedBodyDigest).toBe(createHash('sha256').update(body, 'utf8').digest('hex'));
    const range = partnerSpan!.serializedRanges[0]!;
    expect(range.end - range.start).toBe(partnerText.length);
    expect(serializedStringAt(body, range.field).slice(range.start, range.end)).toBe(partnerText);
    const workspaceMarker = 'Files in your workspace:';
    const workspaceStart = systemText.indexOf(workspaceMarker);
    expect(workspaceStart).toBeGreaterThanOrEqual(0);
    const workspaceSpans = systemCoverage!.spans.filter((span) => span.start < workspaceStart + workspaceMarker.length
      && span.end > workspaceStart);
    expect(workspaceSpans).toMatchObject([{ origin: 'core-generated', mappingState: 'complete' }]);
    const partnerPathStart = systemText.indexOf(`- ${PARTNER_FILE}`, workspaceStart);
    expect(partnerPathStart).toBeGreaterThanOrEqual(0);
    const partnerPath = systemCoverage!.spans.find((span) => span.start <= partnerPathStart
      && span.end >= partnerPathStart + PARTNER_FILE.length + 2);
    expect(partnerPath).toMatchObject({ origin: 'hindsight-source', mappingState: 'complete',
      exposedSources: [expect.objectContaining({ documentId: 'doc-1' })] });
    const unknownSystemSpan = systemCoverage!.spans.find((span) => span.origin === 'unknown-derived'
      && span.mappingState === 'missing');
    expect(unknownSystemSpan).toBeDefined();
    expect(systemText.slice(unknownSystemSpan!.start, unknownSystemSpan!.end)).toContain('desktop-petWorld 环境。');
    const handoffMemoryItem = nextRequest.items.find((item) => item.spans.some((span) => span.origin === 'generation-derived'
      && span.mappingState === 'complete' && span.exposedSources.some((source) => source.documentId === 'doc-1')));
    expect(handoffMemoryItem).toBeDefined();
  });

  it('blocks a rebuilt source span when Forget fences it before provider dispatch', async () => {
    const rig = await buildRig(true, undefined, undefined, { partnerSummary: 'Coo saved the note: jasmine tea 🌿' });
    const validate = rig.persona.validateEvidenceForRequest.bind(rig.persona);
    let validationCount = 0;
    let forgetResult: Promise<unknown> | null = null;
    rig.persona.validateEvidenceForRequest = (sources) => {
      validationCount += 1;
      if (validationCount === 4) forgetResult = rig.memory.forgetDocument('doc-1');
      return validate(sources);
    };
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');
    expect(rig.api().requestContextHandoff()).toBe(true);
    await waitFor(() => rig.api().handoffOutcome()?.status === 'committed');
    await waitFor(() => rig.api().generationEvidence('main').some((entry) => entry.requestState === 'unobserved'));
    if (!forgetResult) throw new Error('the fourth serialized request did not enter the Forget race');
    await forgetResult;

    const blocked = rig.api().generationEvidence('main').find((entry) => entry.requestState === 'unobserved')!;
    expect(validationCount).toBeGreaterThanOrEqual(4);
    expect(rig.dispatchedBodies).toHaveLength(3);
    expect(blocked).toMatchObject({ requestState: 'unobserved', actualEvidenceUsed: 'unknown', exposedSources: [] });
    expect(blocked.items.some((item) => item.mappingState === 'stale'
      && item.spans.some((span) => span.origin === 'hindsight-source' && span.mappingState === 'stale'
        && span.exposedSources.length === 0 && span.serializedRanges.length === 0))).toBe(true);
    expect(rig.memory.sourceVisible('doc-1')).toBe(false);
  });

  it('blocks a rebuilt source span when a verified local revision supersedes it before dispatch', async () => {
    const rig = await buildRig(true, undefined, undefined, { partnerSummary: 'Coo saved the note: jasmine tea 🌿' });
    const validate = rig.persona.validateEvidenceForRequest.bind(rig.persona);
    let validationCount = 0;
    rig.persona.validateEvidenceForRequest = (sources) => {
      validationCount += 1;
      if (validationCount === 4) {
        const outbox = (rig.memory as unknown as { outbox: MemoryOutbox }).outbox;
        expect(outbox.add({
          bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-2', content: 'The preference changed.',
          context: 'synthetic correction', tags: ['correction'], metadata: { kind: 'correction', supersedes_source_ids: '["doc-1"]' },
          priority: 'critical',
        })).toBe('queued');
        const correction = outbox.matching((item) => item.documentId === 'doc-2')[0]!;
        expect(outbox.linkCorrection('doc-2', 'fixture-bank', rig.baseUrl, ['doc-1'])).toBe('pending');
        expect(outbox.markDone(correction.id)).toBe(true);
        expect(outbox.markVerified(correction.id)).toBe(true);
      }
      return validate(sources);
    };
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(), text: 'hello', meta: { text: 'hello' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.api().generationEvidence('main').length >= 3);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');
    expect(rig.api().requestContextHandoff()).toBe(true);
    await waitFor(() => rig.api().handoffOutcome()?.status === 'committed');
    await waitFor(() => rig.api().generationEvidence('main').some((entry) => entry.requestState === 'unobserved'));

    const blocked = rig.api().generationEvidence('main').find((entry) => entry.requestState === 'unobserved')!;
    expect(validationCount).toBeGreaterThanOrEqual(4);
    expect(rig.dispatchedBodies).toHaveLength(3);
    expect(blocked).toMatchObject({ requestState: 'unobserved', actualEvidenceUsed: 'unknown', exposedSources: [] });
    expect(blocked.items.some((item) => item.mappingState === 'stale'
      && item.spans.some((span) => span.origin === 'hindsight-source' && span.mappingState === 'stale'
        && span.exposedSources.length === 0 && span.serializedRanges.length === 0))).toBe(true);
    expect(rig.memory.sourceCurrentForContext('doc-1')).toBe(false);
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

  it('keeps a handoff published before a failed SQLite commit out of later workspace reads', async () => {
    const rig = await buildRig(true);
    const generation = rig.api().sessionInfo('main').generation;
    if (!generation) throw new Error('Core did not provide a generation token');
    const attachment = (await rig.memory.evidenceForSegments(SOURCE_TEXT, [
      { documentId: 'doc-1', start: 0, end: SOURCE_TEXT.length },
    ]))[0];
    if (!attachment) throw new Error('Synthetic source read-back did not produce an attachment');
    const snapshot = [message('user', SOURCE_TEXT, { evidence: [attachment] })];
    const handoffDir = join(rig.memoryDir, 'handoffs');
    const recordsBefore = rig.core.session.records.length;
    const prepared = await rig.persona.prepareHandoff(snapshot, {
      hardTokens: null, sessionId: 'main', expectedGeneration: generation.token, candidateSnapshotId: 'commit-crash-window',
      sourceEvidence: inspectContextEvidence(snapshot), inspectCandidate: (records) => inspectContextEvidence(records),
    });
    expect(prepared.commitGuard?.()).toEqual({ status: 'allow' });

    const state = rig.memory as unknown as { stateStore: ReturnType<typeof openMemoryStateStore> };
    const database = (state.stateStore as unknown as { db: { exec: (sql: string) => void } }).db;
    const originalExec = database.exec.bind(database);
    let publishedBeforeCommit = false;
    database.exec = (sql) => {
      if (sql === 'COMMIT') {
        publishedBeforeCommit = readdirSync(handoffDir).some((name) => name.endsWith('.md'));
        if (publishedBeforeCommit) throw new Error('synthetic SQLite commit failure after file publication');
      }
      originalExec(sql);
    };
    expect(() => prepared.commit?.()).toThrow('synthetic SQLite commit failure after file publication');
    database.exec = originalExec;

    const published = readdirSync(handoffDir).find((name) => name.endsWith('.md'));
    expect(publishedBeforeCommit).toBe(true);
    expect(published).toBeDefined();
    if (!published) throw new Error('the commit failure did not leave the published candidate available for review');
    const artifactId = `handoff:${createHash('sha256')
      .update(JSON.stringify(['main', 'commit-crash-window', published]), 'utf8').digest('hex')}`;
    expect(rig.memory.derivedArtifact(artifactId)).toBeNull();
    expect(rig.core.session.records).toHaveLength(recordsBefore);

    await rig.core.stop();
    activeCores.splice(activeCores.indexOf(rig.core), 1);
    closeMemoryStateStores();
    const persistentMemory = rig.memory as unknown as {
      stateStore: ReturnType<typeof openMemoryStateStore>;
      outbox: MemoryOutbox;
      ledger: ForgetLedger;
    };
    const reopenedStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    persistentMemory.stateStore = reopenedStore;
    persistentMemory.outbox = new MemoryOutbox(reopenedStore);
    persistentMemory.ledger = new ForgetLedger(reopenedStore);
    expect(reopenedStore.getDerivedArtifact(artifactId)).toBeNull();

    const Persona = coopanionPersona(Cormini, { memory: rig.memory });
    const restartedPersona = new Persona({ memoryDir: rig.memoryDir });
    const readFile = (restartedPersona as unknown as { tools(): ToolDef[] }).tools().find((tool) => tool.name === 'read_file');
    if (!readFile) throw new Error('Persona did not declare read_file');
    await expect(readFile.handler({ path: `handoffs/${published}` }, { role: 'main', callId: 'read-orphan' } as never))
      .resolves.toBe('[read failed] This workspace area is withheld until its content has provenance sidecar entries.');
    prepared.discard?.();
    expect(existsSync(handoffDir)).toBe(false);
  });

  it('attaches approved ExperienceCard text only after validating every stored source ID', async () => {
    const rig = await buildRig(true);
    const cards = new ExperienceCards(join(rig.memoryDir, 'experience-cards'));
    const created = cards.create({
      title: 'Tea preference', situation: 'Choosing a drink.', lesson: 'Offer jasmine tea.',
      scope: 'conversation', sourceIds: ['doc-1'],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const expectedEpoch = rig.memory.evidenceEpoch();
    if (!expectedEpoch) throw new Error('Memory evidence epoch is unavailable');
    const artifact = await rig.memory.registerDerivedArtifactFromSources({
      artifactId: created.card.id,
      kind: 'experience-card',
      target: `experience-cards/${created.card.id}.json`,
      content: experienceCardArtifactText(created.card),
      origin: 'user-authored',
      reviewState: 'unreviewed',
      creatorOperationId: `test-experience:${created.card.id}`,
      sourceIds: created.card.sourceIds,
      expectedEpoch,
    });
    if (!artifact) throw new Error('Experience artifact provenance was not saved');
    cards.transition(created.card.id, 'approved');
    rig.memory.setDerivedArtifactReviewState(created.card.id, 'approved');
    const Persona = coopanionPersona(Cormini, { memory: rig.memory, growthStateFile: join(rig.memoryDir, 'growth.json') });
    const persona = new Persona({ memoryDir: rig.memoryDir });
    const context = await (persona as unknown as { experienceContext(): Promise<{ text: string; evidence: Array<{ documentId: string; validationStatus: string }> }> }).experienceContext();

    expect(context.text).toContain('Offer jasmine tea.');
    expect(context.evidence.map((attachment) => attachment.documentId)).toEqual(['doc-1']);
    expect(context.evidence.every((attachment) => attachment.validationStatus === 'validated')).toBe(true);

    const original = rig.memory as unknown as { config: unknown; client: unknown };
    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    const reopenedMemory = new HindsightMemory();
    Object.assign(reopenedMemory, {
      config: original.config,
      client: original.client,
      stateStore: reopenedStore,
      outbox: new MemoryOutbox(reopenedStore),
      ledger: new ForgetLedger(reopenedStore),
      ready: true,
      unavailableUntil: 0,
    });
    expect(reopenedMemory.derivedArtifact(created.card.id)).toMatchObject({
      lifecycleState: 'active', reviewState: 'approved', lineageState: 'complete',
      sources: [expect.objectContaining({ documentId: 'doc-1', validationState: 'validated' })],
    });
    expect(await reopenedMemory.verifyDerivedArtifact(created.card.id, experienceCardArtifactText(created.card))).toBe(true);
  });

  it('persists Coo output as withheld when its tool call has no joined source envelope', async () => {
    const rig = await buildRig(true);
    const text = 'Coo gave an answer without source mapping.';
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const documentId = `coo:main:call-unmapped:${digest.slice(0, 8)}`;
    rig.memory.retainCoo(text, { session: 'main', callId: 'call-unmapped' });

    const state = rig.memory as unknown as {
      stateStore: ReturnType<typeof openMemoryStateStore>;
      outbox: MemoryOutbox;
    };
    expect(state.stateStore.getDerivedArtifact(`coo-output:${documentId}`)).toMatchObject({
      lifecycleState: 'withheld', lineageState: 'unknown', reviewState: 'unreviewed',
      target: documentId, bodyDigest: digest,
    });
    expect(state.outbox.matching((item) => item.documentId === documentId)).toEqual([]);
    expect(rig.memory.sourceVisible(documentId)).toBe(false);
  });

  it('withholds Coo output when its World environment prompt has no source map', async () => {
    const rig = await buildRig(true, undefined, undefined, {
      tools: [makeTool('pet_say', 'The controlled fake pet accepted the script.')],
      llmSetup: (llm) => llm.script(
        toolReply([{ name: 'pet_say', args: { script: 'A source-free line from Coo.' }, id: 'pet-say-call' }]),
        textReply('Done.'),
      ),
    });
    const text = 'A source-free line from Coo.';
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: 'Say hello.', meta: { text: 'Say hello.' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.llm.calls.length === 2);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');

    const envelope = rig.api().generationEvidence('main').find((entry) =>
      entry.outputToolCalls.some((output) => output.toolCallId === 'pet-say-call'));
    const systemRecord = rig.core.session.records.find((record) => record.item.type === 'message' && record.item.role === 'system');
    const systemCoverage = envelope?.items.find((item) => item.itemId === systemRecord?.item.id);
    expect(envelope).toMatchObject({
      requestState: 'sent', responseJoinState: 'matched', mappingState: 'missing',
      exposedSources: [], actualEvidenceUsed: 'unknown',
      sessionId: 'main', providerGenerationId: expect.any(String), providerAttemptId: expect.any(String),
      responseId: expect.any(String),
      outputToolCalls: [expect.objectContaining({ toolCallId: 'pet-say-call', joinState: 'matched' })],
    });
    if (!envelope || !systemRecord) throw new Error('Core did not retain the pet_say generation envelope');
    const unknownPrompt = systemCoverage?.spans.find((span) => span.origin === 'unknown-derived'
      && span.mappingState === 'missing');
    expect(unknownPrompt).toMatchObject({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      serializedRanges: [expect.objectContaining({ field: '$.instructions' })],
    });
    if (!unknownPrompt) throw new Error('Core did not retain the unmapped World prompt span');
    const promptText = textOf(systemRecord).slice(unknownPrompt.start, unknownPrompt.end);
    expect(promptText).toBe('\n## desktop-pet\ndesktop-petWorld 环境。');
    expect(createHash('sha256').update(promptText, 'utf8').digest('hex')).toBe(unknownPrompt.digest);
    const serializedBody = rig.serializedBodies.find((body) =>
      createHash('sha256').update(body, 'utf8').digest('hex') === envelope.serializedBodyDigest);
    if (!serializedBody) throw new Error('The envelope has no matching serialized request body');
    const range = unknownPrompt.serializedRanges[0]!;
    expect(range.end - range.start).toBe(promptText.length);
    expect(serializedStringAt(serializedBody, range.field).slice(range.start, range.end)).toBe(promptText);
    rig.persona.retainCooOutput(text, { session: 'main', callId: 'pet-say-call' });

    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const documentId = `coo:main:pet-say-call:${digest.slice(0, 8)}`;
    const state = rig.memory as unknown as {
      stateStore: ReturnType<typeof openMemoryStateStore>;
      outbox: MemoryOutbox;
    };
    expect(state.stateStore.getGenerationEvidence(envelope.sessionId, envelope.id)).toMatchObject({
      mappingState: 'missing', actualEvidenceUsed: 'unknown', sources: [],
    });
    expect(state.stateStore.getDerivedArtifact(`coo-output:${documentId}`)).toMatchObject({
      lifecycleState: 'withheld', lineageState: 'missing', bodyDigest: digest,
    });
    expect(state.outbox.matching((item) => item.documentId === documentId)).toEqual([]);
    expect(rig.memory.sourceVisible(documentId)).toBe(false);
  });

  it('records a source-independent pet_say from a fully mapped Core request', async () => {
    const rig = await buildRig(true, undefined, undefined, {
      tools: [makeTool('pet_say', 'The controlled fake pet accepted the script.')], worldPrompt: ' ',
      llmSetup: (llm) => llm.script(
        toolReply([{ name: 'pet_say', args: { script: 'A source-free line from Coo.' }, id: 'pet-say-independent-call' }]),
        textReply('Done.'),
      ),
    });
    const text = 'A source-free line from Coo.';
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: 'Say hello.', meta: { text: 'Say hello.' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.llm.calls.length === 2);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');

    const envelope = rig.api().generationEvidence('main').find((entry) =>
      entry.outputToolCalls.some((output) => output.toolCallId === 'pet-say-independent-call'));
    expect(envelope).toMatchObject({
      requestState: 'sent', responseJoinState: 'matched', mappingState: 'complete',
      exposedSources: [], actualEvidenceUsed: 'unknown',
      outputToolCalls: [expect.objectContaining({ toolCallId: 'pet-say-independent-call', joinState: 'matched' })],
    });
    if (!envelope) throw new Error('Core did not retain the source-independent pet_say envelope');
    expect(envelope.items.every((item) => item.mappingState === 'complete'
      && item.disposition !== 'unknown-derived-incomplete' && item.exposedSources.length === 0
      && item.spans.every((span) => span.mappingState === 'complete' && span.exposedSources.length === 0))).toBe(true);

    rig.persona.retainCooOutput(text, { session: 'main', callId: 'pet-say-independent-call' });
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const documentId = `coo:main:pet-say-independent-call:${digest.slice(0, 8)}`;
    const state = rig.memory as unknown as {
      stateStore: ReturnType<typeof openMemoryStateStore>;
      outbox: MemoryOutbox;
    };
    expect(state.stateStore.getGenerationEvidence(envelope.sessionId, envelope.id)).toMatchObject({
      mappingState: 'source-independent', actualEvidenceUsed: 'unknown', sources: [],
    });
    expect(state.stateStore.getDerivedArtifact(`coo-output:${documentId}`)).toMatchObject({
      lifecycleState: 'active', lineageState: 'source-independent', bodyDigest: digest,
    });
    expect(state.outbox.matching((item) => item.documentId === documentId)).toHaveLength(1);
  });

  it('records source-bearing pet_say from a read-back PARTNER source span', async () => {
    const partnerSummary = 'Coo saved the note: jasmine tea 🌿';
    const secondSummary = 'The person also likes tea before breakfast.';
    const rig = await buildRig(true, undefined, undefined, {
      partnerSummary,
      partnerAdditionalDerived: [{ documentId: 'doc-2', text: secondSummary }],
      additionalSources: [{ documentId: 'doc-2', text: secondSummary }],
      tools: [makeTool('pet_say', 'The controlled fake pet accepted the script.')], worldPrompt: ' ',
      llmSetup: (llm) => llm.script(
        toolReply([{ name: 'pet_say', args: { script: 'A line grounded in the recalled preference.' }, id: 'pet-say-source-call' }]),
        textReply('Done.'),
      ),
    });
    const text = 'A line grounded in the recalled preference.';
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: 'What should I drink?', meta: { text: 'What should I drink?' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.llm.calls.length === 2);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');

    const envelope = rig.api().generationEvidence('main').find((entry) =>
      entry.outputToolCalls.some((output) => output.toolCallId === 'pet-say-source-call'));
    expect(envelope).toMatchObject({
      requestState: 'sent', responseJoinState: 'matched', mappingState: 'complete', actualEvidenceUsed: 'unknown',
      exposedSources: expect.arrayContaining([
        expect.objectContaining({
          bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-1',
          revisionState: 'current', validationStatus: 'validated', validatedEpoch: expect.any(String),
          validationReceipt: expect.stringMatching(/^[a-f0-9]{64}$/), contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-2',
          revisionState: 'current', validationStatus: 'validated', validatedEpoch: expect.any(String),
          validationReceipt: expect.stringMatching(/^[a-f0-9]{64}$/), contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
      outputToolCalls: [expect.objectContaining({ toolCallId: 'pet-say-source-call', joinState: 'matched' })],
    });
    if (!envelope) throw new Error('Core did not retain the source-bearing pet_say envelope');
    const sourceSpan = envelope.items.flatMap((item) => item.spans)
      .find((span) => span.origin === 'hindsight-source' && span.mappingState === 'complete'
        && span.exposedSources.some((source) => source.documentId === 'doc-1'));
    expect(sourceSpan).toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/), serializedRanges: [expect.any(Object)] });
    if (!sourceSpan) throw new Error('The request has no serialized source-bearing span');
    const serializedBody = rig.serializedBodies.find((body) =>
      createHash('sha256').update(body, 'utf8').digest('hex') === envelope.serializedBodyDigest);
    if (!serializedBody) throw new Error('The source envelope has no matching serialized request body');
    const range = sourceSpan.serializedRanges[0]!;
    const sourceText = serializedStringAt(serializedBody, range.field).slice(range.start, range.end);
    expect(sourceText).toContain(partnerSummary);
    expect(createHash('sha256').update(sourceText, 'utf8').digest('hex')).toBe(sourceSpan.digest);
    const sourceSpans = envelope.items.flatMap((item) => item.spans)
      .filter((span) => span.origin === 'hindsight-source' && span.mappingState === 'complete');
    expect(new Set(sourceSpans.flatMap((span) => span.exposedSources.map((source) => source.documentId)))).toEqual(new Set(['doc-1', 'doc-2']));

    rig.persona.retainCooOutput(text, { session: 'main', callId: 'pet-say-source-call' });
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const documentId = `coo:main:pet-say-source-call:${digest.slice(0, 8)}`;
    const state = rig.memory as unknown as {
      stateStore: ReturnType<typeof openMemoryStateStore>;
      outbox: MemoryOutbox;
    };
    expect(state.stateStore.getGenerationEvidence(envelope.sessionId, envelope.id)).toMatchObject({
      mappingState: 'complete', actualEvidenceUsed: 'unknown',
      sources: expect.arrayContaining([
        expect.objectContaining({ bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-1' }),
        expect.objectContaining({ bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId: 'doc-2' }),
      ]),
    });
    expect(state.stateStore.getDerivedArtifact(`coo-output:${documentId}`)).toMatchObject({
      lifecycleState: 'active', lineageState: 'complete', bodyDigest: digest,
      sources: expect.arrayContaining([
        expect.objectContaining({ documentId: 'doc-1', validationState: 'validated' }),
        expect.objectContaining({ documentId: 'doc-2', validationState: 'validated' }),
      ]),
    });
    expect(state.outbox.matching((item) => item.documentId === documentId)).toHaveLength(1);

    const bOnly = await rig.memory.registerDerivedArtifactFromSources({
      artifactId: 'experience-b-only', kind: 'experience-card', target: 'experience-cards/b-only.json',
      content: secondSummary, origin: 'user-authored', reviewState: 'approved',
      creatorOperationId: 'experience-b-only-fixture', sourceIds: ['doc-2'],
    });
    expect(bOnly).toMatchObject({ lifecycleState: 'active', sources: [expect.objectContaining({ documentId: 'doc-2' })] });

    const otherBankText = 'Independent artifact from another bank.';
    const otherBankAt = new Date().toISOString();
    const otherBankEndpoint = 'http://other-bank.example.test';
    state.stateStore.saveDerivedArtifact({
      artifactId: 'other-bank-same-document-id', kind: 'experience-card', target: 'experience-cards/other-bank.json',
      scope: memoryArtifactScope('other-bank', otherBankEndpoint), creatorSessionId: null, creatorGenerationId: null,
      creatorOperationId: 'other-bank-fixture', bodyDigest: createHash('sha256').update(otherBankText, 'utf8').digest('hex'),
      origin: 'model-derived', reviewState: 'approved', lifecycleState: 'active', lineageState: 'complete',
      lineageReceiptDigest: 'd'.repeat(64), lineageValidatedAt: otherBankAt, statusReason: null,
      createdAt: otherBankAt, updatedAt: otherBankAt,
      sources: [{
        bankId: 'other-bank', endpoint: otherBankEndpoint, documentId: 'doc-1', validatedEpoch: 0,
        validatedFence: null, revision: 'other-bank-rev-1',
        contentDigest: createHash('sha256').update(otherBankText, 'utf8').digest('hex'),
        segmentDigest: createHash('sha256').update(otherBankText, 'utf8').digest('hex'),
        validationState: 'validated', correlationId: 'other-bank-readback',
      }],
    });

    const original = rig.memory as unknown as { config: unknown; client: unknown };
    await rig.core.stop();
    activeCores.splice(activeCores.indexOf(rig.core), 1);
    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    const reopenedMemory = new HindsightMemory();
    Object.assign(reopenedMemory, {
      config: original.config, client: original.client, stateStore: reopenedStore,
      outbox: new MemoryOutbox(reopenedStore), ledger: new ForgetLedger(reopenedStore), ready: true, unavailableUntil: 0,
    });
    expect(reopenedStore.getDerivedArtifact(`coo-output:${documentId}`)?.sources.map((source) => source.documentId).sort())
      .toEqual(['doc-1', 'doc-2']);
    expect(await reopenedMemory.verifyDerivedArtifact('experience-b-only', secondSummary)).toBe(true);

    await reopenedMemory.forgetDocument('doc-1');
    expect(reopenedStore.getDerivedArtifact(`coo-output:${documentId}`)).toMatchObject({ lifecycleState: 'stale' });
    expect(reopenedStore.getDerivedArtifact('experience-b-only')).toMatchObject({
      lifecycleState: 'active', lineageState: 'complete',
    });
    expect(await reopenedMemory.verifyDerivedArtifact('experience-b-only', secondSummary)).toBe(true);
    expect(reopenedStore.getDerivedArtifact('other-bank-same-document-id')).toMatchObject({
      lifecycleState: 'active', lineageState: 'complete',
      sources: [expect.objectContaining({ bankId: 'other-bank', documentId: 'doc-1' })],
    });
  });

  it('withholds output when a dynamic workspace path has no origin proof', async () => {
    const rig = await buildRig(true, undefined, undefined, {
      tools: [makeTool('pet_say', 'The controlled fake pet accepted the script.')], worldPrompt: ' ',
    });
    writeFileSync(join(rig.memoryDir, 'unmapped-note.md'), 'Synthetic unknown workspace content.\n', 'utf8');
    rig.llm.queue.splice(0, rig.llm.queue.length);
    const text = 'A line without a mapped workspace source.';
    rig.llm.script(toolReply([{ name: 'pet_say', args: { script: text }, id: 'pet-say-unknown-workspace-call' }]), textReply('Done.'));
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: 'Say hello.', meta: { text: 'Say hello.' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.llm.calls.length === 2);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');

    const envelope = rig.api().generationEvidence('main').find((entry) =>
      entry.outputToolCalls.some((output) => output.toolCallId === 'pet-say-unknown-workspace-call'));
    expect(envelope).toMatchObject({ mappingState: 'missing', exposedSources: [], actualEvidenceUsed: 'unknown' });
    if (!envelope) throw new Error('Core did not retain the incomplete workspace envelope');
    const systemRecord = rig.core.session.records.find((record) => record.item.type === 'message' && record.item.role === 'system');
    const systemCoverage = envelope.items.find((item) => item.itemId === systemRecord?.item.id);
    expect(systemCoverage?.spans.some((span) => span.origin === 'unknown-derived' && span.mappingState === 'missing'
      && span.end > span.start && /^[a-f0-9]{64}$/u.test(span.digest))).toBe(true);

    rig.persona.retainCooOutput(text, { session: 'main', callId: 'pet-say-unknown-workspace-call' });
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const documentId = `coo:main:pet-say-unknown-workspace-call:${digest.slice(0, 8)}`;
    const state = rig.memory as unknown as {
      stateStore: ReturnType<typeof openMemoryStateStore>;
      outbox: MemoryOutbox;
    };
    expect(state.stateStore.getDerivedArtifact(`coo-output:${documentId}`)).toMatchObject({
      lifecycleState: 'withheld', lineageState: 'missing',
    });
    expect(state.outbox.matching((item) => item.documentId === documentId)).toEqual([]);
  });

  it('keeps a user-authored PARTNER paragraph when a derived paragraph is forgotten', async () => {
    const derivedSummary = 'Derived paragraph from the jasmine tea source.';
    const userNote = 'User-authored note: ask before scheduling a call.';
    const rig = await buildRig(true, undefined, undefined, {
      partnerSummary: derivedSummary, partnerUserNote: userNote,
    });
    const persona = rig.persona as unknown as {
      ensurePartnerArtifacts(): Promise<void>;
      partnerDocumentForRead(): string;
    };
    await persona.ensurePartnerArtifacts();
    expect(persona.partnerDocumentForRead()).toContain(derivedSummary);
    expect(persona.partnerDocumentForRead()).toContain(userNote);

    await rig.memory.forgetDocument('doc-1');
    expect(persona.partnerDocumentForRead()).toContain(userNote);
    expect(persona.partnerDocumentForRead()).not.toContain(derivedSummary);
    expect(readFileSync(join(rig.memoryDir, PARTNER_FILE), 'utf8')).toContain(derivedSummary);
    expect(readFileSync(join(rig.memoryDir, PARTNER_FILE), 'utf8')).toContain(userNote);
    const sidecar = readPartnerProvenance(partnerProvenancePath(join(rig.root, 'growth'), rig.memoryDir), partnerWorkspaceDigest(rig.memoryDir));
    expect(sidecar.status).toBe('ok');
    if (sidecar.status !== 'ok') throw new Error('synthetic PARTNER sidecar should remain readable');
    expect(sidecar.file.entries.map((entry) => entry.state)).toEqual(['stale', 'current']);
  });

  it('recomputes activation from current revisions after reopening SQLite', async () => {
    const rig = await buildRig(true, undefined, undefined, {
      additionalSources: [
        { documentId: 'doc-2', text: 'Current corrected tea preference.' },
        { documentId: 'doc-3', text: 'Independent preference from another source.' },
      ],
    });
    const state = rig.memory as unknown as {
      stateStore: ReturnType<typeof openMemoryStateStore>;
      outbox: MemoryOutbox;
    };
    const verifiedEvent = (documentId: string, at: string, extra: Record<string, string> = {}): void => {
      expect(state.outbox.add({
        bankId: 'fixture-bank', endpoint: rig.baseUrl, documentId, content: `Synthetic ${documentId}.`,
        context: 'revision integration fixture', tags: ['scope:life'], priority: 'normal', timestamp: at,
        metadata: { source_actor: 'user', kind: 'event', status: 'completed', said_at: at, ...extra },
      })).toBe('queued');
      const item = state.outbox.due(new Date(Date.now() + 1000), 20).find((entry) => entry.documentId === documentId);
      if (!item) throw new Error(`Outbox did not retain ${documentId}`);
      expect(state.outbox.markSending(item.id)).toBe(true);
      expect(state.outbox.markSent(item.id, item.operationId)).toBe(true);
      expect(state.outbox.markDone(item.id)).toBe(true);
      expect(state.outbox.markVerified(item.id)).toBe(true);
    };

    verifiedEvent('user-event-old-mention', '2024-05-02T10:00:00.000Z');
    expect(state.stateStore.recordUserMention({
      bankId: 'fixture-bank', endpoint: rig.baseUrl, targetDocumentId: 'doc-1',
      userEventDocumentId: 'user-event-old-mention', targetCreatedAt: '2024-05-01T10:00:00.000Z',
      semanticMatch: 0.95, intensity: 0.2,
    }).status).toBe('applied');
    verifiedEvent('user-event-current-mention', '2024-05-10T10:00:00.000Z');
    verifiedEvent('doc-2', '2024-05-11T10:00:00.000Z', {
      kind: 'correction', supersedes_source_ids: JSON.stringify(['doc-1']),
    });
    verifiedEvent('user-event-independent-mention', '2024-05-12T10:00:00.000Z');
    expect(state.stateStore.recordUserMention({
      bankId: 'fixture-bank', endpoint: rig.baseUrl, targetDocumentId: 'doc-2',
      userEventDocumentId: 'user-event-current-mention', targetCreatedAt: '2024-05-01T10:00:00.000Z',
      semanticMatch: 0.95, intensity: 0.2,
    }).status).toBe('applied');
    expect(state.stateStore.recordUserMention({
      bankId: 'fixture-bank', endpoint: rig.baseUrl, targetDocumentId: 'doc-3',
      userEventDocumentId: 'user-event-independent-mention', targetCreatedAt: '2024-05-01T10:00:00.000Z',
      semanticMatch: 0.95, intensity: 0.2,
    }).status).toBe('applied');
    expect(state.stateStore.supersededSources('fixture-bank', rig.baseUrl)).toEqual(new Set(['doc-1']));
    expect(state.stateStore.currentRevisionSources('fixture-bank', rig.baseUrl)).toContain('doc-2');

    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    const original = rig.memory as unknown as { config: unknown; client: unknown };
    const reopenedMemory = new HindsightMemory();
    Object.assign(reopenedMemory, {
      config: original.config, client: original.client, stateStore: reopenedStore,
      outbox: new MemoryOutbox(reopenedStore), ledger: new ForgetLedger(reopenedStore), ready: true, unavailableUntil: 0,
    });
    expect(reopenedStore.supersededSources('fixture-bank', rig.baseUrl)).toEqual(new Set(['doc-1']));
    const reopenedRead = await reopenedMemory.searchResultsDetailed('synthetic revision integration', { captureTrace: true });
    const old = reopenedRead.results.find((result) => result.sourceFacts?.some((source) => source.documentId === 'doc-1'));
    const current = reopenedRead.results.find((result) => result.sourceFacts?.some((source) => source.documentId === 'doc-2'));
    const independent = reopenedRead.results.find((result) => result.sourceFacts?.some((source) => source.documentId === 'doc-3'));
    expect(!old || old.sourceFacts?.filter((source) => source.documentId === 'doc-1')
      .every((source) => source.metadata?.status === 'superseded')).toBe(true);
    expect(old?.activationWeight).toBeUndefined();
    expect(current?.sourceFacts?.find((source) => source.documentId === 'doc-2')?.metadata?.status).toBe('current');
    expect(current?.activationWeight).toBeGreaterThan(0);
    expect(independent?.activationWeight).toBeGreaterThan(0);
    await reopenedMemory.forgetDocument('doc-1');
    expect(reopenedMemory.sourceVisible('doc-1')).toBe(false);
    expect(reopenedMemory.sourceVisible('doc-2')).toBe(false);
    expect(reopenedMemory.sourceVisible('doc-3')).toBe(true);
    const afterForget = await reopenedMemory.searchResultsDetailed('synthetic revision integration', { captureTrace: true });
    const afterForgetCurrent = afterForget.results.find((result) => result.sourceFacts?.some((source) => source.documentId === 'doc-2'));
    const afterForgetIndependent = afterForget.results.find((result) => result.sourceFacts?.some((source) => source.documentId === 'doc-3'));
    expect(afterForgetCurrent?.activationWeight).toBeUndefined();
    expect(afterForgetIndependent?.activationWeight).toBeGreaterThan(0);
    expect(await reopenedMemory.sourceCurrentForContext('doc-1')).toBe(false);
    expect(await reopenedMemory.sourceCurrentForContext('doc-2')).toBe(false);
    expect(await reopenedMemory.sourceCurrentForContext('doc-3')).toBe(true);
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

  it('answers an ordinary no-history question through a FakeLLM request and response', async () => {
    const question = 'What is two plus two?';
    const answer = 'Two plus two is four.';
    const rig = await buildSourceFreeRig(answer);
    expect(rig.llm.calls).toHaveLength(0);
    expect(rig.core.session.records.some((record) => textOf(record).includes(question))).toBe(false);

    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: question, meta: { text: question },
    }, { trigger: 'flush' });
    await waitFor(() => rig.llm.calls.length === 1);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');

    expect(JSON.stringify(rig.llm.calls[0]?.messages)).toContain(question);
    expect(rig.llm.queue).toHaveLength(0);
    const replies = rig.core.session.records.filter((record) => record.item.type === 'message'
      && record.item.role === 'assistant' && textOf(record).includes(answer));
    expect(replies).toHaveLength(1);
    expect(rig.api().generationEvidence('main')).toMatchObject([
      { requestState: 'sent', exposedSources: [], actualEvidenceUsed: 'unknown' },
    ]);
  });

  it('stages, publishes and injects a source-free handoff after the guard allows it', async () => {
    const rig = await buildSourceFreeRig();
    await rig.host().pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input', ts: new Date().toISOString(),
      text: 'Continue the local task.', meta: { text: 'Continue the local task.' },
    }, { trigger: 'flush' });
    await waitFor(() => rig.llm.calls.length > 0);
    await waitFor(() => rig.core.loop.getStatus().phase.state === 'idle');
    expect(rig.api().generationEvidence('main')).toMatchObject([
      { requestState: 'sent', exposedSources: [], actualEvidenceUsed: 'unknown' },
    ]);

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
