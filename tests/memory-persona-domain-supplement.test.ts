import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi, ContextEvidenceInspection, EventEnvelope, EvidenceAttachment, SourceExposureRef, WorldHost } from 'cortico/core/types.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeFakePersona, makeLoaded, textReply } from '../vendor/cortico/tests/core/helpers.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { HANDOFF_NOTE_TYPE } from '../vendor/cortico/bots/cormini/persona/handoffNote.ts';
import { coopanionPersona } from '../core/persona.ts';
import type { DomainSupplementDiagnostics } from '../core/persona.ts';
import { HindsightMemory, type DomainSupplementReceipt } from '../core/memory/hindsight.ts';
import { MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE } from '../core/memory/model-text.ts';
import { loadHindsightConfig, type HindsightFileConfig } from '../core/memory/config.ts';
import { consumeDomainRelevantMemory, type CoreMemoryConsumption } from '../core/memory/domain-relevant-consume.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, MemoryStateStore } from '../core/memory/state-store.ts';
import {
  MEMORY_DOMAIN_TAXONOMY,
  type DomainId,
  type SourceDomainClassificationInput,
  type SourceDomainEvidence,
  type SourceDomainEvidenceProvider,
  type SourceDomainLinkInput,
} from '../core/memory/source-domains.ts';
import type {
  TrustedSourceReadbackEvidence,
  TrustedSourceReadbackProvider,
} from '../core/memory/source-domain-consumer.ts';

const roots: string[] = [];
const servers: Server[] = [];
const writers: MemoryStateStore[] = [];
const cores: Core[] = [];
const bankId = 'bank-d4s2-synthetic';
const at = '2026-11-10T10:00:00.000Z';
const QUERY = '请整理项目功能方面的重点决定和判断依据，并说明各自的适用范围、可以重复使用的做法以及有哪些注意事项';

interface SyntheticSource extends SourceDomainEvidence {
  sourceStatus: string;
  domains: DomainId[];
  excerpt: string;
}

interface SourceFact {
  id: string;
  text: string;
  type: string;
  document_id: string;
  occurred_start: string;
  metadata: Record<string, string>;
}

interface RecallResult {
  id: string;
  text: string;
  type: string;
  document_id: string;
  source_fact_ids: string[];
}

interface RecallResponse {
  results: RecallResult[];
  source_facts: Record<string, SourceFact>;
  source_facts_truncated: boolean;
}

interface RecallRequest {
  query: string;
  budget: string;
  maxTokens: number;
  maxSourceFactsTokens: number | null;
  types?: string[];
}

interface Injection {
  text: string;
  evidence: EvidenceAttachment[];
}

interface CoreRun {
  serializedBodies: string[];
  dispatchedBodies: string[];
  envelope: ReturnType<CoreApi['generationEvidence']>[number] | undefined;
  records: Array<{ itemId: string; text: string }>;
}

interface PersonaRig {
  root: string;
  memoryDir: string;
  memory: HindsightMemory;
  ledger: ForgetLedger;
  store: MemoryStateStore;
  endpoint: string;
  requests: RecallRequest[];
  documentReads: string[];
  sources: Map<string, SyntheticSource>;
  setResponder: (responder: (request: RecallRequest) => RecallResponse) => void;
  seed: (entries: Array<{ source: SyntheticSource; state: 'assigned' | 'unclassified' | 'ambiguous' | 'pending_review'; domains?: DomainId[] }>) => void;
  setDocumentUnavailable: (documentId: string) => void;
  setRecallDelay: (ms: number) => void;
  setRecallHold: (hold: (request: RecallRequest, callIndex: number) => Promise<void> | null) => void;
  setDocumentHold: (hold: (documentId: string, readIndex: number) => Promise<void> | null) => void;
  start: (options?: { supplementEnabled?: boolean; supplement?: HindsightFileConfig['domainSupplement']; captureOnly?: boolean }) => Promise<{
    core: Core;
    api: CoreApi;
    host: WorldHost;
    llm: FakeLLM;
    persona: InstanceType<ReturnType<typeof coopanionPersona>>;
    injections: Injection[];
    serializedBodies: string[];
    dispatchedBodies: string[];
  }>;
}

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

function deferredGate(): DeferredGate {
  let release = () => {};
  const promise = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  return { promise, release };
}

function userEvent(text: string, cursor: number): EventEnvelope {
  return {
    cursor,
    type: 'desktop-pet.message',
    ts: new Date().toISOString(),
    source: 'desktop-pet',
    origin: 'external',
    dependencyOrigin: 'user-input',
    text,
    meta: { text },
  };
}

/**
 * A source-free handoff note suppresses the batch-count notice in `onDelivery`.
 * Direct overlapping calls need that: the notice alone carries no user span and Core
 * blocks the request before the scripted model sees it.
 */
function handoffProbe(cursor: number): EventEnvelope {
  return {
    cursor,
    type: HANDOFF_NOTE_TYPE,
    ts: new Date().toISOString(),
    source: 'core',
    origin: 'external',
    text: 'Synthetic overlap probe.',
    meta: {},
  };
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function key(source: Pick<SyntheticSource, 'bankId' | 'endpoint' | 'documentId'>): string {
  return JSON.stringify([source.bankId, source.endpoint, source.documentId]);
}

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'r27-d4s2-'));
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(tmpdir()) + '/')) throw new Error('synthetic files must stay under the system temporary directory');
  roots.push(path);
  return path;
}

function source(
  endpoint: string,
  documentId: string,
  content: string,
  domain: DomainId,
): SyntheticSource {
  return {
    bankId, endpoint, documentId, content, sourceEpoch: 0,
    sourceActor: 'user', sourceKind: 'event', sourceStatus: 'completed',
    domains: [domain], excerpt: content,
  };
}

function factFor(factId: string, entry: SyntheticSource): SourceFact {
  return {
    id: factId,
    text: entry.content,
    type: 'world',
    document_id: entry.documentId,
    occurred_start: at,
    metadata: { source_actor: entry.sourceActor, kind: entry.sourceKind, status: entry.sourceStatus },
  };
}

function responseForDocs(docs: readonly SyntheticSource[]): RecallResponse {
  const results: RecallResult[] = [];
  const sourceFacts: Record<string, SourceFact> = {};
  docs.forEach((entry, index) => {
    const factId = `fact-${entry.documentId}`;
    sourceFacts[factId] = factFor(factId, entry);
    results.push({
      id: `observation-${entry.documentId}`,
      text: `Synthetic recall result ${String(index + 1).padStart(2, '0')}.`,
      type: 'observation',
      document_id: `observation:${entry.documentId}`,
      source_fact_ids: [factId],
    });
  });
  return { results, source_facts: sourceFacts, source_facts_truncated: false };
}

function linkFor(entry: SyntheticSource, domainId: DomainId, excerpt: string): SourceDomainLinkInput {
  const start = entry.content.indexOf(excerpt);
  if (start < 0) throw new Error('synthetic evidence span is not present in the source');
  return {
    domainId,
    linkState: 'confirmed',
    confidence: 0.95,
    ruleId: 'synthetic-d4s2-approved-span',
    evidenceStart: start,
    evidenceEnd: start + excerpt.length,
    evidenceDigest: hash(excerpt),
    claimVerification: 'user_verified',
  };
}

function classificationFor(entry: SyntheticSource, domains: DomainId[]): SourceDomainClassificationInput {
  return {
    bankId: entry.bankId,
    endpoint: entry.endpoint,
    documentId: entry.documentId,
    state: 'assigned',
    taxonomyVersion: MEMORY_DOMAIN_TAXONOMY,
    classifierVersion: 'synthetic-d4s2-fixture/v1',
    confidence: 0.95,
    sourceEpoch: entry.sourceEpoch,
    sourceRevision: hash(entry.content),
    classifiedAt: at,
    updatedAt: at,
    links: domains.map((domainId) => linkFor(entry, domainId, entry.excerpt)),
  };
}

async function createRig(): Promise<PersonaRig> {
  const entries = new Map<string, SyntheticSource>();
  const unavailable = new Set<string>();
  const requests: RecallRequest[] = [];
  const documentReads: string[] = [];
  let recallDelay = 0;
  let recallHold: ((request: RecallRequest, callIndex: number) => Promise<void> | null) | null = null;
  let documentHold: ((documentId: string, readIndex: number) => Promise<void> | null) | null = null;
  let responder: (request: RecallRequest) => RecallResponse = () => ({ results: [], source_facts: {}, source_facts_truncated: false });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET') {
      const match = /^\/v1\/default\/banks\/([^/]+)\/documents\/([^/]+)$/.exec(url.pathname);
      if (!match) {
        request.resume();
        response.writeHead(404);
        response.end();
        return;
      }
      const targetBank = decodeURIComponent(match[1]!);
      const documentId = decodeURIComponent(match[2]!);
      documentReads.push(documentId);
      const documentReadIndex = documentReads.filter((value) => value === documentId).length;
      const entry = [...entries.values()].find((item) => item.bankId === targetBank && item.documentId === documentId);
      const serve = () => {
        if (!entry || unavailable.has(documentId)) {
          request.resume();
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ detail: 'not found' }));
          return;
        }
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: entry.documentId,
          bank_id: entry.bankId,
          original_text: entry.content,
          content_hash: hash(entry.content),
          created_at: at,
          updated_at: at,
          memory_unit_count: 1,
          document_metadata: {
            source_actor: entry.sourceActor,
            kind: entry.sourceKind,
            status: entry.sourceStatus,
          },
        }));
      };
      const hold = documentHold?.(documentId, documentReadIndex);
      if (hold) void hold.then(serve);
      else serve();
      return;
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/memories/recall')) {
      request.resume();
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'accepted' }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        query?: string; budget?: string; max_tokens?: number; max_source_facts_tokens?: number; types?: string[];
      };
      const observed: RecallRequest = {
        query: body.query ?? '',
        budget: body.budget ?? '',
        maxTokens: Number(body.max_tokens ?? 0),
        maxSourceFactsTokens: body.max_source_facts_tokens === undefined ? null : Number(body.max_source_facts_tokens),
        ...(Array.isArray(body.types) ? { types: body.types } : {}),
      };
      requests.push(observed);
      const reply = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(responder(observed)));
      };
      const hold = recallHold?.(observed, requests.length);
      if (hold) void hold.then(reply);
      else if (recallDelay > 0 && requests.length > 1) setTimeout(reply, recallDelay);
      else reply();
    });
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;
  const endpoint = 'http://127.0.0.1:' + address.port;
  const root = tempRoot();
  const outbox = new MemoryOutbox(join(root, 'memory-outbox.jsonl'));
  if (!outbox.stateStore) throw new Error('synthetic SQLite state store did not open');
  const ledger = new ForgetLedger(outbox.stateStore);
  const memory = new HindsightMemory();
  const store = outbox.stateStore;
  const seed = (values: Array<{ source: SyntheticSource; state: 'assigned' | 'unclassified' | 'ambiguous' | 'pending_review'; domains?: DomainId[] }>) => {
    for (const value of values) {
      value.source.sourceEpoch = ledger.epoch(value.source.bankId, value.source.endpoint);
      entries.set(key(value.source), value.source);
    }
    const provider: SourceDomainEvidenceProvider = (targetBank, targetEndpoint, documentId) => {
      const entry = entries.get(key({ bankId: targetBank, endpoint: targetEndpoint, documentId }));
      return entry ? {
        bankId: entry.bankId, endpoint: entry.endpoint, documentId: entry.documentId, content: entry.content,
        sourceEpoch: entry.sourceEpoch, sourceActor: entry.sourceActor, sourceKind: entry.sourceKind, sourceStatus: entry.sourceStatus,
      } satisfies SourceDomainEvidence : null;
    };
    const writer = new MemoryStateStore(store.path, { sourceDomainEvidence: provider });
    writers.push(writer);
    for (const value of values) writer.putSourceDomainClassification(classificationFor(value.source, value.domains ?? value.source.domains));
    writer.close();
    writers.splice(writers.indexOf(writer), 1);
  };
  const memoryDir = join(root, 'persona');
  const start = async (options: { supplementEnabled?: boolean; supplement?: HindsightFileConfig['domainSupplement']; captureOnly?: boolean } = {}) => {
    const config = loadHindsightConfig(memoryDir, {
      enabled: true,
      autostart: false,
      apiUrl: endpoint,
      bankId,
      domainSupplement: {
        enabled: options.supplementEnabled ?? false,
        ...(options.supplement ?? {}),
      },
    });
    Object.assign(memory, {
      config,
      client: new HindsightClient({ baseUrl: endpoint, maxAttempts: 1 }),
      outbox,
      ledger,
      stateStore: store,
      ready: true,
      unavailableUntil: 0,
    });
    const coreCfg = makeCfg();
    coreCfg.worlds.qq.enabled = false;
    coreCfg.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
    mkdirSync(memoryDir, { recursive: true });
    const Persona = coopanionPersona(Cormini, { memory });
    const persona = new Persona({ memoryDir });
    persona.onOpening = () => {};
    const injections: Injection[] = [];
    const originalInject = (persona as unknown as { injectMemoryContext: (text: string, evidence?: EvidenceAttachment[]) => void })
      .injectMemoryContext.bind(persona);
    (persona as unknown as { injectMemoryContext: (text: string, evidence?: EvidenceAttachment[]) => void })
      .injectMemoryContext = (text, evidence) => {
        injections.push({ text, evidence: evidence ? [...evidence] : [] });
        if (!options.captureOnly) originalInject(text, evidence);
      };
    let api: CoreApi | null = null;
    const attach = persona.attach.bind(persona);
    persona.attach = (value) => { api = value; attach(value); };
    const llm = new FakeLLM();
    llm.script(textReply('Synthetic D4-S2 answer.'));
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
    const world = makeFakeIO('desktop-pet');
    let host: WorldHost | null = null;
    world.start = async (value) => { host = value; };
    const core = new Core(makeLoaded({
      config: coreCfg,
      rootDir: join(root, 'core'),
      memoryDir,
      dataDir: join(root, 'data'),
    }), {
      persona,
      worlds: [world],
      llm,
      requireCompleteEvidence: true,
      worldEventTrust: (candidate, event) => candidate === world
        && ['desktop-pet.message', 'desktop-pet.speech', 'desktop-pet.touch'].includes(event.type),
      worldPromptTrust: (candidate) => candidate === world
        ? { templateDigests: [hash('desktop-petWorld 环境。')], independentVariables: true }
        : { templateDigests: [], independentVariables: false },
    });
    cores.push(core);
    await core.start();
    const coreApi = (): CoreApi => {
      if (!api) throw new Error('CoreApi was not attached');
      return api;
    };
    const worldHost = (): WorldHost => {
      if (!host) throw new Error('WorldHost was not attached');
      return host;
    };
    return { core, api: coreApi(), host: worldHost(), llm, persona, injections, serializedBodies, dispatchedBodies };
  };
  return {
    root, memoryDir, memory, ledger, store, endpoint, requests, documentReads, sources: entries,
    setResponder: (value) => { responder = value; },
    seed,
    setDocumentUnavailable: (documentId) => { unavailable.add(documentId); },
    setRecallDelay: (ms) => { recallDelay = ms; },
    setRecallHold: (hold) => { recallHold = hold; },
    setDocumentHold: (hold) => { documentHold = hold; },
    start,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the synthetic Core turn');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function deliver(rig: PersonaRig, run: Awaited<ReturnType<PersonaRig['start']>>, text: string): Promise<void> {
  const before = run.api.generationEvidence('main').length;
  await run.host.pushEvent({
    type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input',
    ts: new Date().toISOString(), text, meta: { text },
  }, { trigger: 'flush' });
  await waitFor(() => run.api.generationEvidence('main').length > before);
  await waitFor(() => run.core.loop.getStatus().phase.state === 'idle');
}

function recordsWithMemory(core: Core): string[] {
  return core.session.records.flatMap((record) => {
    const text = textOf(record);
    return text.includes('[memory]') ? [text] : [];
  });
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

async function validateInjectionThroughCore(
  rig: PersonaRig,
  injection: Injection,
  label: string,
): Promise<CoreRun> {
  const GatePersona = coopanionPersona(Cormini, { memory: rig.memory });
  const gatePersona = new GatePersona({ memoryDir: join(rig.root, label) });
  const validate = gatePersona.validateEvidenceForRequest.bind(gatePersona);
  return runCoreBlock({ text: injection.text, evidence: injection.evidence, sourceSegments: [] }, validate);
}

async function runCoreBlock(
  block: CoreMemoryConsumption,
  validate: (sources: readonly SourceExposureRef[], inspection?: ContextEvidenceInspection) => boolean,
): Promise<CoreRun> {
  const root = tempRoot();
  const cfg = makeCfg();
  cfg.worlds.qq.enabled = false;
  cfg.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  let api: CoreApi | null = null;
  let injected = false;
  const persona = makeFakePersona([], {
    silent: true,
    onDelivery: () => {
      if (injected || !block.text) return;
      injected = true;
      api!.injectInternal(block.text, 'memory', block.evidence);
    },
  });
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { api = value; attach(value); };
  persona.validateEvidenceForRequest = (sources, inspection) => validate(sources, inspection as never);
  const llm = new FakeLLM();
  llm.script(textReply('Synthetic D4-S2 gate answer.'));
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
  const world = makeFakeIO('core-world');
  let host: WorldHost | null = null;
  world.start = async (value) => { host = value; };
  const core = new Core(makeLoaded({
    config: cfg,
    rootDir: join(root, 'core'),
    memoryDir: join(root, 'persona'),
    dataDir: join(root, 'data'),
  }), {
    persona,
    worlds: [world],
    llm,
    requireCompleteEvidence: true,
    worldEventTrust: (candidate, event) => candidate === world && event.type === 'core.message',
  });
  cores.push(core);
  await core.start();
  try {
    await host!.pushEvent({
      type: 'core.message', source: 'core-world', dependencyOrigin: 'user-input',
      ts: new Date().toISOString(), text: 'Synthetic D4-S2 evidence gate question.',
      meta: { text: 'Synthetic D4-S2 evidence gate question.' },
    }, { trigger: 'flush' });
    await waitFor(() => {
      const evidenceCount = api!.generationEvidence('main').length;
      return evidenceCount > 0 && core.loop.getStatus().phase.state === 'idle';
    });
    return {
      serializedBodies,
      dispatchedBodies,
      envelope: api!.generationEvidence('main').at(-1),
      records: core.session.records.map((record) => ({
        itemId: record.item.id ?? '',
        text: record.item.type === 'message'
          ? typeof record.item.content === 'string' ? record.item.content
            : record.item.content.map((part) => 'text' in part ? part.text : '').join('')
          : record.item.type === 'function_call' ? record.item.arguments
            : record.item.type === 'function_call_output' ? String(record.item.output) : '',
      })),
    };
  } finally {
    await core.stop();
    cores.splice(cores.indexOf(core), 1);
  }
}

function baselineTuples(recall: Awaited<ReturnType<HindsightMemory['recallForTurn']>>, endpoint: string): Array<{ bankId: string; endpoint: string; documentId: string }> {
  const ids = new Set([
    ...(recall.trace?.format.sourceSegments.map((segment) => segment.documentId) ?? []),
    ...(recall.trace?.format.includedSourceDocumentIds ?? []),
  ]);
  return [...ids].map((documentId) => ({ bankId, endpoint, documentId }));
}

function receipt(rig: PersonaRig): DomainSupplementReceipt {
  const value = rig.memory.lastDomainSupplementReceipt();
  if (!value) throw new Error('the opt-in supplement did not record a receipt');
  return value;
}

function attachmentView(attachment: EvidenceAttachment): Record<string, unknown> {
  return {
    tuple: [attachment.bankId, attachment.endpoint, attachment.documentId],
    validatedEpoch: attachment.validatedEpoch,
    revisionState: attachment.revisionState,
    validationStatus: attachment.validationStatus,
    validationReceipt: attachment.validationReceipt,
    contentDigest: attachment.contentDigest,
    segment: attachment.segment,
  };
}

function envelopeView(envelope: ReturnType<CoreApi['generationEvidence']>[number] | undefined): Record<string, unknown> | null {
  if (!envelope) return null;
  return {
    requestState: envelope.requestState,
    mappingState: envelope.mappingState,
    actualEvidenceUsed: envelope.actualEvidenceUsed,
    serializedBodyDigest: envelope.serializedBodyDigest,
    exposedSources: envelope.exposedSources,
    items: envelope.items.map((item) => ({
      itemId: item.itemId,
      spans: item.spans.map((span) => ({
        start: span.start,
        end: span.end,
        origin: span.origin,
        mappingState: span.mappingState,
        digest: span.digest,
        sourceProof: span.sourceProof,
        serializedRanges: span.serializedRanges,
        exposedSources: span.exposedSources,
      })),
    })),
  };
}

function emitEvidence(name: string, value: unknown): void {
  const dir = process.env.D4S2_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function emitDiagnosticsEvidence(name: string, value: unknown): void {
  const dir = process.env.D4S5_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function invokeDiagnostics(run: Awaited<ReturnType<PersonaRig['start']>>, args: unknown[] = []): Promise<DomainSupplementDiagnostics> {
  const invoke = run.persona.webUi('en').invoke;
  if (!invoke) throw new Error('the Persona did not expose its local invoke path');
  return invoke('hindsight', 'domain-supplement-diagnostics', args) as Promise<DomainSupplementDiagnostics>;
}

function diagnosticKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    `${prefix}${key}`,
    ...diagnosticKeys(child, `${prefix}${key}.`),
  ]);
}

afterEach(async () => {
  for (const core of cores.splice(0)) {
    try { await core.stop(); } catch { /* already stopped */ }
  }
  for (const writer of writers.splice(0)) {
    try { writer.close(); } catch { /* already closed */ }
  }
  closeMemoryStateStores();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('D4-S2 default-off domain supplement config', () => {
  it('defaults off, keeps the stock recall types and clamps its own budget', () => {
    const root = tempRoot();
    const defaults = loadHindsightConfig(root);
    expect(defaults.recall.types).toEqual(['observation', 'world', 'experience']);
    expect(defaults.domainSupplement).toMatchObject({
      enabled: false,
      timeoutMs: 20_000,
      queryTimeoutMs: 8_000,
      readbackTimeBudgetMs: 8_000,
      finalReadbackTimeBudgetMs: 3_000,
      maxSupplementSources: 2,
      maxSupplementChars: 1200,
    });
    expect(defaults.domainSupplement.timeoutMs).toBeGreaterThan(defaults.domainSupplement.queryTimeoutMs);

    const tuned = loadHindsightConfig(root, {
      enabled: true,
      domainSupplement: {
        enabled: true,
        timeoutMs: 1,
        queryTimeoutMs: 99_999,
        maxSources: 0,
        maxSupplementSources: 99,
        maxSupplementChars: 1,
        finalReadbackTimeBudgetMs: 0,
      },
    });
    expect(tuned.domainSupplement.enabled).toBe(true);
    expect(tuned.domainSupplement.timeoutMs).toBe(100);
    expect(tuned.domainSupplement.queryTimeoutMs).toBe(10_000);
    expect(tuned.domainSupplement.maxSources).toBe(50);
    expect(tuned.domainSupplement.maxSupplementSources).toBe(10);
    expect(tuned.domainSupplement.maxSupplementChars).toBe(200);
    expect(tuned.domainSupplement.finalReadbackTimeBudgetMs).toBe(3000);
    expect(tuned.recall.types).toEqual(['observation', 'world', 'experience']);
  });
});

describe('D4-S2 real Persona domain supplement wiring', () => {
  it('withholds an unproven Recall summary and performs no supplement query when off', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：基线来源必须在关闭领域补充时原样保留。', 'project-functional');
    rig.seed([{ source: baselineSource, state: 'assigned', domains: ['project-functional'] }]);
    rig.setResponder(() => responseForDocs([baselineSource]));
    const run = await rig.start({ supplementEnabled: false });

    await deliver(rig, run, QUERY);

    expect(rig.requests).toHaveLength(1);
    expect(rig.documentReads.every((documentId) => documentId === 'source-baseline')).toBe(true);
    expect(run.injections).toEqual([{ text: MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, evidence: [] }]);
    const envelope = run.api.generationEvidence('main').at(-1);
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete', actualEvidenceUsed: 'unknown' });
    expect(envelope?.exposedSources).toEqual([]);
    expect(rig.memory.lastDomainSupplementReceipt()).toBeNull();
    expect(recordsWithMemory(run.core)).toHaveLength(1);
    expect(run.serializedBodies[0]).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(run.serializedBodies[0]).not.toContain(baselineSource.content);
    expect(run.dispatchedBodies).toHaveLength(1);

    emitEvidence('persona-off.json', {
      layer: 'D4S2_PERSONA_DEFAULT_OFF',
      syntheticOnly: true,
      recallRequests: rig.requests,
      documentReads: rig.documentReads,
      injectedText: run.injections[0]!.text,
      injectedTextChars: run.injections[0]!.text.length,
      evidence: run.injections[0]!.evidence.map(attachmentView),
      envelope: envelopeView(envelope),
      receipt: null,
      serializedBodyDigest: hash(run.serializedBodies[0]!),
      serializedBodyHasBaseline: run.serializedBodies[0]!.includes(baselineSource.content),
    });
  }, 30_000);

  it('withholds an incomplete ordinary baseline and continues without historical text when off', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-incomplete-baseline', '未验证基线：不得进入模型请求。', 'project-functional');
    rig.seed([{ source: baselineSource, state: 'assigned', domains: ['project-functional'] }]);
    rig.setResponder(() => responseForDocs([baselineSource]));
    rig.setDocumentUnavailable(baselineSource.documentId);
    const run = await rig.start({ supplementEnabled: false });

    await deliver(rig, run, QUERY);

    expect(rig.requests).toHaveLength(1);
    expect(run.injections).toEqual([{ text: MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, evidence: [] }]);
    expect(run.serializedBodies).toHaveLength(1);
    expect(run.serializedBodies[0]).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(run.serializedBodies[0]).not.toContain(baselineSource.content);
    expect(run.dispatchedBodies).toHaveLength(1);
    expect(run.api.generationEvidence('main').at(-1)).toMatchObject({
      requestState: 'sent', mappingState: 'complete', actualEvidenceUsed: 'unknown',
    });
  }, 30_000);

  it('uses only verified indexed sources when the ordinary baseline cannot be read back', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-incomplete-baseline-on', '未验证基线：不得进入模型请求。', 'project-functional');
    const supplementSource = source(rig.endpoint, 'source-verified-supplement-on', '项目决定：已验证领域来源应保留其原文和来源附件。', 'project-functional');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: supplementSource, state: 'assigned', domains: ['project-functional'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([supplementSource]);
    });
    rig.setDocumentUnavailable(baselineSource.documentId);
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);

    expect(rig.requests.length, JSON.stringify(receipt(rig))).toBeGreaterThanOrEqual(2);
    expect(run.injections).toHaveLength(1);
    expect(run.injections[0]!.text).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(run.injections[0]!.text).toContain(supplementSource.content);
    expect(run.injections[0]!.text).not.toContain(baselineSource.content);
    expect(run.injections[0]!.evidence.map((attachment) => attachment.documentId)).toEqual([supplementSource.documentId]);
    expect(receipt(rig)).toMatchObject({ status: 'finalized', baselineStatus: 'absent', consumedCount: 1 });
    expect(run.serializedBodies).toHaveLength(1);
    expect(run.serializedBodies[0]).toContain(supplementSource.content);
    expect(run.serializedBodies[0]).not.toContain(baselineSource.content);
    expect(run.dispatchedBodies).toHaveLength(1);
    expect(run.api.generationEvidence('main').at(-1)).toMatchObject({
      requestState: 'sent', mappingState: 'complete', actualEvidenceUsed: 'unknown',
    });
  }, 30_000);

  it('revalidates baseline and new source segments when withholding the Recall summary', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：普通 Recall 的基线来源保持不变。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-method', '可重复做法：新增领域来源必须先回读原文，再按精确 span 补证。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);

    expect(rig.requests).toHaveLength(2);
    expect(run.injections).toHaveLength(1);
    const injected = run.injections[0]!;
    expect(injected.text).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(injected.text).toContain(baselineSource.content);
    expect(injected.text).toContain(newSource.content);
    // P3: the Core-consumed block is the exact union of source excerpts. The display header is
    // receipt-only; injecting it would leave the request unmappable after a restart.
    expect(injected.text.slice(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE.length + 1))
      .toBe([baselineSource.content, newSource.content].join('\n'));
    expect(injected.evidence.map((attachment) => attachment.documentId)).toEqual(['source-baseline', 'source-new-method']);
    const verifiedBaseline = injected.evidence[0]!;
    const supplement = injected.evidence[1]!;
    expect(verifiedBaseline.segment.sourceProof).toBeDefined();
    expect(verifiedBaseline.segment.start).toBe(injected.text.indexOf(baselineSource.content));
    expect(verifiedBaseline.segment.end).toBe(verifiedBaseline.segment.start + baselineSource.content.length);
    expect(supplement.segment.sourceProof).toBeDefined();
    expect(supplement.segment.sourceProof!.token.length).toBeGreaterThan(0);
    expect(supplement.segment.start).toBe(injected.text.indexOf(newSource.content));
    expect(supplement.segment.end).toBe(supplement.segment.start + newSource.content.length);
    expect(supplement.segment.digest).toBe(hash(newSource.content));
    expect(supplement.validationStatus).toBe('validated');
    expect(supplement.revisionState).toBe('current');

    const envelope = run.api.generationEvidence('main').at(-1);
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete', actualEvidenceUsed: 'unknown' });
    expect(envelope?.exposedSources.map((source) => source.documentId).sort()).toEqual(['source-baseline', 'source-new-method']);
    const body = run.serializedBodies[0]!;
    expect(run.dispatchedBodies).toHaveLength(1);
    expect(body).toContain(baselineSource.content);
    expect(body).toContain(newSource.content);
    expect(body.split(newSource.content)).toHaveLength(2);
    expect(body).not.toContain('Additional verified domain sources');
    const supplementSpan = envelope?.items.flatMap((item) => item.spans).find((span) =>
      span.origin === 'hindsight-source'
      && span.exposedSources.some((source) => source.documentId === 'source-new-method'));
    expect(supplementSpan).toBeDefined();
    expect(supplementSpan!.mappingState).toBe('complete');
    const range = supplementSpan!.serializedRanges[0]!;
    expect(serializedStringAt(body, range.field).slice(range.start, range.end)).toBe(newSource.content);
    expect(recordsWithMemory(run.core)).toHaveLength(1);

    const recorded = receipt(rig);
    expect(recorded).toMatchObject({
      enabled: true,
      status: 'finalized',
      fallbackReason: null,
      baselineStatus: 'absent',
      consumedCount: 2,
      addedSourceCount: 2,
      finalizedSegmentCount: 2,
      queryCalls: 1,
      finalReadbackCalls: 2,
    });
    expect(recorded.queryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(recorded.supplementalChars).toBeGreaterThan(0);
    expect(recorded.readbackCalls).toBeGreaterThanOrEqual(1);
    expect(rig.documentReads.filter((documentId) => documentId === 'source-new-method').length).toBeGreaterThanOrEqual(2);

    const marker = '\n[memory] Additional verified domain sources';
    const supplementStart = injected.text.indexOf(marker);
    emitEvidence('persona-on.json', {
      layer: 'D4S2_PERSONA_OPT_IN_FINALIZED',
      syntheticOnly: true,
      recallRequests: rig.requests,
      documentReads: rig.documentReads,
      baselineText: injected.text.slice(0, supplementStart),
      supplementText: injected.text.slice(supplementStart + 1),
      injectedText: injected.text,
      evidence: injected.evidence.map((attachment) => ({
        ...attachmentView(attachment),
        visibleText: injected.text.slice(attachment.segment.start, attachment.segment.end),
      })),
      envelope: envelopeView(envelope),
      receipt: recorded,
      serializedBodyDigest: hash(body),
      serializedBodyHasBaseline: body.includes(baselineSource.content),
      serializedBodyHasSupplement: body.includes(newSource.content),
      supplementBlockOccurrences: body.split('Additional verified domain sources').length - 1,
      sourceContents: {
        baseline: baselineSource.content,
        supplement: newSource.content,
      },
    });
  }, 30_000);

  it('rejects raw S2 attachments, a forged sourceProof and a forged segment digest, then passes the finalized block', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：证据门只接受真实回读产生的来源证明。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-proof', '判断依据：手工拼接的 sourceProof 不能绕过真实 Core 安全门。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    const run = await rig.start({ supplementEnabled: true });
    const config = (rig.memory as unknown as { config: ReturnType<typeof loadHindsightConfig> }).config;
    Object.assign(rig.memory, {
      config,
      client: new HindsightClient({ baseUrl: rig.endpoint, maxAttempts: 1 }),
      outbox: new MemoryOutbox(rig.store),
      ledger: rig.ledger,
      stateStore: rig.store,
      ready: true,
      unavailableUntil: 0,
    });

    const baseline = await rig.memory.recallForTurn(QUERY, { captureTrace: true, activationEnabled: false });
    const baselineSegments = baseline.trace?.format.sourceSegments ?? [];
    const baselineEvidence = await rig.memory.evidenceForSegments(baseline.text, baselineSegments);
    expect(baselineEvidence).toHaveLength(1);
    const deliveries: CoreMemoryConsumption[] = [];
    const result = await consumeDomainRelevantMemory({
      enabled: true,
      query: QUERY,
      bankId,
      endpoint: rig.endpoint,
      store: rig.store,
      baseline: { text: baseline.text, status: baseline.status, trace: baseline.trace, evidence: baselineEvidence },
      search: (text, options) => rig.memory.searchResultsDetailed(text, { ...options, types: [...rig.memory.domainSupplementTypes()] }),
      readbackProvider: rig.memory.domainReadbackProvider(),
      finalReadbackProvider: rig.memory.domainReadbackProvider(),
      getEvidenceEpoch: () => rig.memory.evidenceEpoch(),
      deliver: (block) => { deliveries.push(block); },
    });
    expect(result.status).toBe('supplemented');
    expect(deliveries).toHaveLength(1);

    const GatePersona = coopanionPersona(Cormini, { memory: rig.memory });
    const gatePersona = new GatePersona({ memoryDir: join(rig.root, 'gate-persona') });
    const validate = gatePersona.validateEvidenceForRequest.bind(gatePersona);

    const raw = await runCoreBlock(deliveries[0]!, validate);
    expect(raw.dispatchedBodies).toHaveLength(0);
    expect(raw.envelope).toMatchObject({ requestState: 'unobserved', actualEvidenceUsed: 'unknown' });

    const baselineKeys = new Set(baselineTuples(baseline, rig.endpoint).map((tuple) => JSON.stringify([tuple.bankId, tuple.endpoint, tuple.documentId])));
    const newSegments = result.sourceSegments.filter((segment) =>
      !baselineKeys.has(JSON.stringify([bankId, rig.endpoint, segment.documentId])));
    expect(newSegments).toHaveLength(1);
    const finalized = await rig.memory.evidenceForSegments(result.text, newSegments);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.segment.sourceProof).toBeDefined();
    const finalizedBlock: CoreMemoryConsumption = {
      text: result.text,
      evidence: [...baselineEvidence, ...finalized],
      sourceSegments: result.sourceSegments,
    };
    const passed = await runCoreBlock(finalizedBlock, validate);
    expect(passed.dispatchedBodies).toHaveLength(1);
    expect(passed.envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });

    const forgedProof: CoreMemoryConsumption = structuredClone(finalizedBlock);
    const supplementAttachment = forgedProof.evidence.find((attachment) => attachment.documentId === 'source-new-proof')!;
    supplementAttachment.segment.sourceProof = {
      token: 'forged-synthetic-token',
      startUtf16: 0,
      endUtf16: supplementAttachment.segment.end - supplementAttachment.segment.start,
    };
    const proofRun = await runCoreBlock(forgedProof, validate);
    expect(proofRun.dispatchedBodies).toHaveLength(0);
    expect(proofRun.envelope?.requestState).toBe('unobserved');

    const forgedDigest: CoreMemoryConsumption = structuredClone(finalizedBlock);
    const digestAttachment = forgedDigest.evidence.find((attachment) => attachment.documentId === 'source-new-proof')!;
    digestAttachment.segment.digest = hash('forged synthetic segment body');
    const digestRun = await runCoreBlock(forgedDigest, validate);
    expect(digestRun.dispatchedBodies).toHaveLength(0);
    expect(digestRun.envelope?.requestState).toBe('unobserved');

    emitEvidence('raw-vs-finalized.json', {
      layer: 'D4S2_RAW_VS_FINALIZED_GATE',
      syntheticOnly: true,
      s2Status: result.status,
      s2TextChars: result.text.length,
      newSegments,
      rawBlock: {
        evidence: deliveries[0]!.evidence.map(attachmentView),
        gate: envelopeView(raw.envelope),
        dispatchedBodies: raw.dispatchedBodies.length,
      },
      finalizedBlock: {
        evidence: finalizedBlock.evidence.map(attachmentView),
        gate: envelopeView(passed.envelope),
        dispatchedBodies: passed.dispatchedBodies.length,
      },
      forgedProof: {
        gate: envelopeView(proofRun.envelope),
        dispatchedBodies: proofRun.dispatchedBodies.length,
      },
      forgedDigest: {
        gate: envelopeView(digestRun.envelope),
        dispatchedBodies: digestRun.dispatchedBodies.length,
      },
      sourceContents: {
        baseline: baselineSource.content,
        supplement: newSource.content,
      },
    });
    emitDiagnosticsEvidence('core-rejection-summary.json', {
      layer: 'D4S5_CORE_REJECTION_VS_DISPATCH',
      syntheticOnly: true,
      rawAttachments: {
        requestState: raw.envelope?.requestState ?? null,
        mappingState: raw.envelope?.mappingState ?? null,
        actualEvidenceUsed: raw.envelope?.actualEvidenceUsed ?? null,
        dispatchedBodies: raw.dispatchedBodies.length,
      },
      forgedProof: {
        requestState: proofRun.envelope?.requestState ?? null,
        mappingState: proofRun.envelope?.mappingState ?? null,
        actualEvidenceUsed: proofRun.envelope?.actualEvidenceUsed ?? null,
        dispatchedBodies: proofRun.dispatchedBodies.length,
      },
      forgedDigest: {
        requestState: digestRun.envelope?.requestState ?? null,
        mappingState: digestRun.envelope?.mappingState ?? null,
        actualEvidenceUsed: digestRun.envelope?.actualEvidenceUsed ?? null,
        dispatchedBodies: digestRun.dispatchedBodies.length,
      },
      finalizedAttachments: {
        requestState: passed.envelope?.requestState ?? null,
        mappingState: passed.envelope?.mappingState ?? null,
        actualEvidenceUsed: passed.envelope?.actualEvidenceUsed ?? null,
        dispatchedBodies: passed.dispatchedBodies.length,
      },
    });

    expect(run.injections).toHaveLength(0);
    expect(run.serializedBodies).toHaveLength(0);
  }, 40_000);

  it('keeps two consecutive turns on their own supplement sources without cross-turn injection', async () => {
    const rig = await createRig();
    const baselineA = source(rig.endpoint, 'source-turn-a', '项目决定：第一轮只应使用项目基线。', 'project-functional');
    const extraA = source(rig.endpoint, 'source-turn-a-extra', '可重复做法：第一轮补充来源只属于第一轮。', 'skill-methods');
    const baselineB = source(rig.endpoint, 'source-turn-b', '关系决定：第二轮只应使用关系基线。', 'user-relationship');
    const extraB = source(rig.endpoint, 'source-turn-b-extra', '沟通做法：第二轮补充来源只属于第二轮。', 'social-context');
    rig.seed([
      { source: baselineA, state: 'assigned', domains: ['project-functional'] },
      { source: extraA, state: 'assigned', domains: ['skill-methods'] },
      { source: baselineB, state: 'assigned', domains: ['user-relationship'] },
      { source: extraB, state: 'assigned', domains: ['social-context'] },
    ]);
    const calls = new Map<string, number>();
    rig.setResponder((request) => {
      const project = request.query.includes('项目');
      const call = (calls.get(project ? 'project' : 'relationship') ?? 0) + 1;
      calls.set(project ? 'project' : 'relationship', call);
      if (project) return call === 1 ? responseForDocs([baselineA]) : responseForDocs([baselineA, extraA]);
      return call === 1 ? responseForDocs([baselineB]) : responseForDocs([baselineB, extraB]);
    });
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);
    await deliver(rig, run, '请整理关系维护方面的重点做法和判断依据，并说明适用范围、可以重复使用的沟通方式以及有哪些注意事项');

    expect(rig.requests).toHaveLength(4);
    expect(run.injections).toHaveLength(2);
    expect(run.injections[0]!.text).toContain(baselineA.content);
    expect(run.injections[0]!.text).toContain(extraA.content);
    expect(run.injections[0]!.text).not.toContain(baselineB.content);
    expect(run.injections[0]!.text).not.toContain(extraB.content);
    expect(run.injections[1]!.text).toContain(baselineB.content);
    expect(run.injections[1]!.text).toContain(extraB.content);
    expect(run.injections[1]!.text).not.toContain(baselineA.content);
    expect(run.injections[1]!.text).not.toContain(extraA.content);
    expect(recordsWithMemory(run.core)).toHaveLength(2);
    expect(run.serializedBodies).toHaveLength(2);
    expect(run.serializedBodies[0]).toContain(extraA.content);
    expect(run.serializedBodies[0]).not.toContain(extraB.content);
    // The first turn's exact block stays in the persisted history; the new turn appends its own.
    expect(run.serializedBodies[1]).toContain(extraA.content);
    expect(run.serializedBodies[1]).toContain(extraB.content);
    expect(run.serializedBodies[1]!.split(extraB.content)).toHaveLength(2);
    expect(run.serializedBodies[1]).not.toContain('Additional verified domain sources');
    const evidence = run.api.generationEvidence('main');
    expect(evidence).toHaveLength(2);
    expect(evidence[0]!.exposedSources.map((source) => source.documentId).sort()).toEqual(['source-turn-a', 'source-turn-a-extra']);
    expect(evidence[1]!.exposedSources.map((source) => source.documentId)).toEqual(expect.arrayContaining(['source-turn-b', 'source-turn-b-extra']));
    expect(receipt(rig).status).toBe('finalized');

    emitEvidence('multi-turn.json', {
      layer: 'D4S2_MULTI_TURN_ISOLATION',
      syntheticOnly: true,
      recallRequests: rig.requests,
      turns: run.injections.map((injection, index) => ({
        turn: index + 1,
        injectedText: injection.text,
        evidence: injection.evidence.map(attachmentView),
        exposedSources: evidence[index]?.exposedSources.map((source) => source.documentId) ?? [],
        serializedBodyDigest: hash(run.serializedBodies[index]!),
      })),
      latestReceipt: receipt(rig),
      recordsWithMemory: recordsWithMemory(run.core).length,
    });
  }, 40_000);

  it('uses the verified baseline source when the added source readback fails', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：补充来源回读失败时只保留基线。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-missing', '可重复做法：这条来源在回读时会消失。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    rig.setDocumentUnavailable('source-new-missing');
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);

    expect(run.injections).toHaveLength(1);
    expect(run.injections[0]!.text).toContain(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE);
    expect(run.injections[0]!.text).toContain(baselineSource.content);
    expect(run.injections[0]!.text).not.toContain(newSource.content);
    expect(run.injections[0]!.evidence.map((attachment) => attachment.documentId)).toEqual(['source-baseline']);
    const envelope = run.api.generationEvidence('main').at(-1);
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });
    expect(envelope?.exposedSources.map((source) => source.documentId)).toEqual(['source-baseline']);
    expect(receipt(rig)).toMatchObject({ status: 'finalized', baselineStatus: 'absent', consumedCount: 1, addedSourceCount: 1 });
    expect(rig.requests).toHaveLength(2);

    emitEvidence('failure-readback.json', {
      layer: 'D4S2_FAILURE_READBACK',
      syntheticOnly: true,
      recallRequests: rig.requests,
      documentReads: rig.documentReads,
      injectedText: run.injections[0]!.text,
      evidence: run.injections[0]!.evidence.map(attachmentView),
      envelope: envelopeView(run.api.generationEvidence('main').at(-1)),
      receipt: receipt(rig),
    });
  }, 30_000);

  it('withholds the incomplete baseline when the supplement query times out', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：补充查询超时不能影响普通 Recall。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-slow', '可重复做法：慢查询不会追加未定型来源。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    rig.setRecallDelay(300);
    const run = await rig.start({
      supplementEnabled: true,
      supplement: { queryTimeoutMs: 100, timeoutMs: 200 },
    });

    await deliver(rig, run, QUERY);

    expect(run.injections).toHaveLength(1);
    expect(run.injections[0]).toEqual({ text: MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, evidence: [] });
    expect(run.injections[0]!.text).not.toContain(baselineSource.content);
    expect(run.injections[0]!.text).not.toContain(newSource.content);
    expect(receipt(rig).status).toBe('fallback');
    expect(['query_unavailable', 'cancelled', 'baseline_only']).toContain(receipt(rig).fallbackReason);
    const envelope = run.api.generationEvidence('main').at(-1);
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });

    emitEvidence('failure-timeout.json', {
      layer: 'D4S2_FAILURE_TIMEOUT',
      syntheticOnly: true,
      recallRequests: rig.requests,
      injectedText: run.injections[0]!.text,
      evidence: run.injections[0]!.evidence.map(attachmentView),
      envelope: envelopeView(envelope),
      receipt: receipt(rig),
    });
  }, 30_000);

  it('keeps a late older baseline from injecting after a newer overlapping turn', async () => {
    const rig = await createRig();
    const baselineA = source(rig.endpoint, 'source-overlap-a', '项目决定：第一轮基线来源只属于第一轮。', 'project-functional');
    const extraA = source(rig.endpoint, 'source-overlap-a-extra', '可重复做法：第一轮补充来源迟到后不得注入新轮。', 'skill-methods');
    const baselineB = source(rig.endpoint, 'source-overlap-b', '关系决定：第二轮基线来源只属于第二轮。', 'user-relationship');
    const extraB = source(rig.endpoint, 'source-overlap-b-extra', '沟通做法：第二轮补充来源只属于第二轮。', 'social-context');
    rig.seed([
      { source: baselineA, state: 'assigned', domains: ['project-functional'] },
      { source: extraA, state: 'assigned', domains: ['skill-methods'] },
      { source: baselineB, state: 'assigned', domains: ['user-relationship'] },
      { source: extraB, state: 'assigned', domains: ['social-context'] },
    ]);
    const queryA = '请整理项目功能方面的第一轮重点决定和判断依据，并说明适用范围以及可以重复使用的做法？';
    const queryB = '请整理关系维护方面的第二轮重点做法和判断依据，并说明适用范围以及可以重复使用的沟通方式？';
    const calls = new Map<string, number>();
    rig.setResponder((request) => {
      const key = request.query === queryA ? 'a' : 'b';
      const call = (calls.get(key) ?? 0) + 1;
      calls.set(key, call);
      if (key === 'a') return call === 1 ? responseForDocs([baselineA]) : responseForDocs([baselineA, extraA]);
      return call === 1 ? responseForDocs([baselineB]) : responseForDocs([baselineB, extraB]);
    });
    const run = await rig.start({ supplementEnabled: true, captureOnly: true });
    const gate = deferredGate();
    let held = false;
    rig.setRecallHold((request, callIndex) => {
      if (!held && request.query === queryA && callIndex === 1) {
        held = true;
        return gate.promise;
      }
      return null;
    });

    const timeline: Array<{ event: string; at: number }> = [];
    const started = Date.now();
    const mark = (event: string) => timeline.push({ event, at: Date.now() - started });
    let turn1Done = false;
    mark('turn1_started');
    const turn1 = run.persona.onDelivery({ events: [userEvent(queryA, 9101), handoffProbe(9111)] }).then(() => {
      turn1Done = true;
      mark('turn1_resolved');
    });
    await waitFor(() => held);
    mark('turn1_baseline_held');
    expect(turn1Done).toBe(false);

    mark('turn2_started');
    const turn2 = run.persona.onDelivery({ events: [userEvent(queryB, 9102), handoffProbe(9112)] });
    await turn2;
    mark('turn2_resolved');
    expect(turn1Done).toBe(false);
    expect(run.injections).toHaveLength(1);
    expect(run.injections[0]!.text).toContain(baselineB.content);
    expect(run.injections[0]!.text).toContain(extraB.content);
    expect(run.injections[0]!.text).not.toContain(baselineA.content);
    expect(run.injections[0]!.text).not.toContain(extraA.content);

    gate.release();
    mark('turn1_baseline_released');
    await turn1;
    mark('turn1_joined');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(run.injections).toHaveLength(1);
    expect(rig.requests.filter((request) => request.query === queryA)).toHaveLength(1);
    expect(rig.memory.lastDomainSupplementReceipt()?.queryHash).toBe(hash(queryB));
    expect(timeline.some((entry) => entry.event === 'turn1_baseline_held')).toBe(true);
    expect(timeline.some((entry) => entry.event === 'turn2_resolved')).toBe(true);

    const coreRun = await validateInjectionThroughCore(rig, run.injections[0]!, 'overlap-baseline-gate');
    expect(coreRun.dispatchedBodies).toHaveLength(1);
    const envelope = coreRun.envelope;
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });
    expect(envelope?.exposedSources.map((source) => source.documentId).sort())
      .toEqual(['source-overlap-b', 'source-overlap-b-extra']);
    emitEvidence('overlap-slow-baseline.json', {
      layer: 'D4S3_OVERLAP_SLOW_BASELINE',
      syntheticOnly: true,
      turn1DoneBeforeRelease: false,
      turn1PendingAtTurn2Start: true,
      timeline,
      recallRequests: rig.requests,
      documentReads: rig.documentReads,
      injections: run.injections.map((injection) => ({
        text: injection.text,
        documents: injection.evidence.map((attachment) => attachment.documentId),
      })),
      envelope: envelopeView(envelope),
      receipt: rig.memory.lastDomainSupplementReceipt(),
    });
  }, 30_000);

  it('keeps a late older supplement query from injecting after a newer overlapping turn', async () => {
    const rig = await createRig();
    const baselineA = source(rig.endpoint, 'source-overlap-a', '项目决定：第一轮基线来源只属于第一轮。', 'project-functional');
    const extraA = source(rig.endpoint, 'source-overlap-a-extra', '可重复做法：第一轮慢查询迟到后不得注入新轮。', 'skill-methods');
    const baselineB = source(rig.endpoint, 'source-overlap-b', '关系决定：第二轮基线来源只属于第二轮。', 'user-relationship');
    const extraB = source(rig.endpoint, 'source-overlap-b-extra', '沟通做法：第二轮补充来源只属于第二轮。', 'social-context');
    rig.seed([
      { source: baselineA, state: 'assigned', domains: ['project-functional'] },
      { source: extraA, state: 'assigned', domains: ['skill-methods'] },
      { source: baselineB, state: 'assigned', domains: ['user-relationship'] },
      { source: extraB, state: 'assigned', domains: ['social-context'] },
    ]);
    const queryA = '请整理项目功能方面的第一轮重点决定和判断依据，并说明适用范围以及可以重复使用的做法？';
    const queryB = '请整理关系维护方面的第二轮重点做法和判断依据，并说明适用范围以及可以重复使用的沟通方式？';
    const calls = new Map<string, number>();
    rig.setResponder((request) => {
      const key = request.query === queryA ? 'a' : 'b';
      const call = (calls.get(key) ?? 0) + 1;
      calls.set(key, call);
      if (key === 'a') return call === 1 ? responseForDocs([baselineA]) : responseForDocs([baselineA, extraA]);
      return call === 1 ? responseForDocs([baselineB]) : responseForDocs([baselineB, extraB]);
    });
    const run = await rig.start({ supplementEnabled: true, captureOnly: true });
    const gate = deferredGate();
    let held = false;
    rig.setRecallHold((request, callIndex) => {
      if (!held && request.query === queryA && callIndex === 2) {
        held = true;
        return gate.promise;
      }
      return null;
    });

    const timeline: Array<{ event: string; at: number }> = [];
    const started = Date.now();
    const mark = (event: string) => timeline.push({ event, at: Date.now() - started });
    let turn1Done = false;
    mark('turn1_started');
    const turn1 = run.persona.onDelivery({ events: [userEvent(queryA, 9201), handoffProbe(9211)] }).then(() => {
      turn1Done = true;
      mark('turn1_resolved');
    });
    await waitFor(() => held);
    mark('turn1_supplement_held');
    expect(turn1Done).toBe(false);

    mark('turn2_started');
    const turn2 = run.persona.onDelivery({ events: [userEvent(queryB, 9202), handoffProbe(9212)] });
    await turn2;
    mark('turn2_resolved');
    expect(turn1Done).toBe(false);
    expect(run.injections).toHaveLength(1);
    expect(run.injections[0]!.text).not.toContain(extraA.content);

    gate.release();
    mark('turn1_supplement_released');
    await turn1;
    mark('turn1_joined');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(run.injections).toHaveLength(1);
    expect(rig.memory.lastDomainSupplementReceipt()?.queryHash).toBe(hash(queryB));

    const coreRun = await validateInjectionThroughCore(rig, run.injections[0]!, 'overlap-supplement-gate');
    expect(coreRun.dispatchedBodies).toHaveLength(1);
    const envelope = coreRun.envelope;
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });
    expect(envelope?.exposedSources.map((source) => source.documentId).sort())
      .toEqual(['source-overlap-b', 'source-overlap-b-extra']);
    emitEvidence('overlap-slow-supplement.json', {
      layer: 'D4S3_OVERLAP_SLOW_SUPPLEMENT',
      syntheticOnly: true,
      turn1DoneBeforeRelease: false,
      turn1PendingAtTurn2Start: true,
      timeline,
      recallRequests: rig.requests,
      documentReads: rig.documentReads,
      injections: run.injections.map((injection) => ({
        text: injection.text,
        documents: injection.evidence.map((attachment) => attachment.documentId),
      })),
      envelope: envelopeView(envelope),
      receipt: rig.memory.lastDomainSupplementReceipt(),
    });
  }, 30_000);

  it('keeps a late older finalize readback from injecting or recording a newer receipt', async () => {
    const rig = await createRig();
    const baselineA = source(rig.endpoint, 'source-overlap-a', '项目决定：第一轮基线来源只属于第一轮。', 'project-functional');
    const extraA = source(rig.endpoint, 'source-overlap-a-extra', '可重复做法：第一轮最终回读迟到后不得注入新轮。', 'skill-methods');
    const baselineB = source(rig.endpoint, 'source-overlap-b', '关系决定：第二轮基线来源只属于第二轮。', 'user-relationship');
    const extraB = source(rig.endpoint, 'source-overlap-b-extra', '沟通做法：第二轮补充来源只属于第二轮。', 'social-context');
    rig.seed([
      { source: baselineA, state: 'assigned', domains: ['project-functional'] },
      { source: extraA, state: 'assigned', domains: ['skill-methods'] },
      { source: baselineB, state: 'assigned', domains: ['user-relationship'] },
      { source: extraB, state: 'assigned', domains: ['social-context'] },
    ]);
    const queryA = '请整理项目功能方面的第一轮重点决定和判断依据，并说明适用范围以及可以重复使用的做法？';
    const queryB = '请整理关系维护方面的第二轮重点做法和判断依据，并说明适用范围以及可以重复使用的沟通方式？';
    const calls = new Map<string, number>();
    rig.setResponder((request) => {
      const key = request.query === queryA ? 'a' : 'b';
      const call = (calls.get(key) ?? 0) + 1;
      calls.set(key, call);
      if (key === 'a') return call === 1 ? responseForDocs([baselineA]) : responseForDocs([baselineA, extraA]);
      return call === 1 ? responseForDocs([baselineB]) : responseForDocs([baselineB, extraB]);
    });
    const run = await rig.start({ supplementEnabled: true, captureOnly: true });
    const gate = deferredGate();
    let held = false;
    rig.setDocumentHold((documentId, readIndex) => {
      if (!held && documentId === 'source-overlap-a-extra' && readIndex === 3) {
        held = true;
        return gate.promise;
      }
      return null;
    });

    const timeline: Array<{ event: string; at: number }> = [];
    const started = Date.now();
    const mark = (event: string) => timeline.push({ event, at: Date.now() - started });
    let turn1Done = false;
    mark('turn1_started');
    const turn1 = run.persona.onDelivery({ events: [userEvent(queryA, 9301), handoffProbe(9311)] }).then(() => {
      turn1Done = true;
      mark('turn1_resolved');
    });
    await waitFor(() => held);
    mark('turn1_finalize_held');
    expect(turn1Done).toBe(false);

    mark('turn2_started');
    const turn2 = run.persona.onDelivery({ events: [userEvent(queryB, 9302), handoffProbe(9312)] });
    await turn2;
    mark('turn2_resolved');
    // The abort listener releases the turn's await before the held HTTP read settles;
    // the late body can still arrive, so its result must be discarded.
    expect(held).toBe(true);
    expect(turn1Done).toBe(true);
    expect(run.injections).toHaveLength(1);
    const turn2Receipt = rig.memory.lastDomainSupplementReceipt();
    expect(turn2Receipt?.queryHash).toBe(hash(queryB));

    gate.release();
    mark('turn1_finalize_released');
    await turn1;
    mark('turn1_joined');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(run.injections).toHaveLength(1);
    expect(rig.memory.lastDomainSupplementReceipt()).toEqual(turn2Receipt);

    const coreRun = await validateInjectionThroughCore(rig, run.injections[0]!, 'overlap-finalize-gate');
    expect(coreRun.dispatchedBodies).toHaveLength(1);
    const envelope = coreRun.envelope;
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });
    expect(envelope?.exposedSources.map((source) => source.documentId).sort())
      .toEqual(['source-overlap-b', 'source-overlap-b-extra']);
    emitEvidence('overlap-slow-finalize.json', {
      layer: 'D4S3_OVERLAP_SLOW_FINALIZE',
      syntheticOnly: true,
      turn1DoneBeforeRelease: false,
      turn1PendingAtTurn2Start: true,
      timeline,
      recallRequests: rig.requests,
      documentReads: rig.documentReads,
      injections: run.injections.map((injection) => ({
        text: injection.text,
        documents: injection.evidence.map((attachment) => attachment.documentId),
      })),
      envelope: envelopeView(envelope),
      receipt: rig.memory.lastDomainSupplementReceipt(),
    });
  }, 30_000);

  it('withholds the incomplete baseline when the supplement output budget is too small', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：补充正文超预算时不能截断基线。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-long', '可重复做法：这是一条足够长的补充来源，用于触发独立的字符预算限制。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    const run = await rig.start({
      supplementEnabled: true,
      supplement: { maxSupplementChars: 200 },
    });

    await deliver(rig, run, QUERY);

    expect(run.injections).toHaveLength(1);
    expect(run.injections[0]).toEqual({ text: MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, evidence: [] });
    expect(run.injections[0]!.text).not.toContain(baselineSource.content);
    expect(run.injections[0]!.text).not.toContain(newSource.content);
    expect(receipt(rig).status).toBe('fallback');
    expect(receipt(rig).fallbackReason).toBe('supplement_output_budget');
    const envelope = run.api.generationEvidence('main').at(-1);
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete' });

    emitEvidence('failure-budget.json', {
      layer: 'D4S2_FAILURE_OUTPUT_BUDGET',
      syntheticOnly: true,
      recallRequests: rig.requests,
      injectedText: run.injections[0]!.text,
      evidence: run.injections[0]!.evidence.map(attachmentView),
      envelope: envelopeView(envelope),
      receipt: receipt(rig),
    });
  }, 30_000);
});

describe('D4-S5 content-free domain supplement diagnostics', () => {
  const allowedKeys = new Set([
    'available', 'enabled', 'receiptState', 'receiptPresent', 'turnActive', 'status', 'fallbackReason',
    'baselineStatus', 'candidateCount', 'verifiedCount', 'consumedCount', 'addedSourceCount',
    'withheldCount', 'fallbackCount', 'finalizedSegmentCount', 'queryCalls', 'readbackCalls',
    'finalReadbackCalls', 'supplementalChars', 'elapsedMs', 'rssDeltaBytes', 'receiptAgeMs',
    'scope', 'core', 'core.requestState', 'core.actualEvidenceUsed', 'core.evidenceObserved',
  ]);
  const forbiddenKeys = [
    'query', 'queryHash', 'bankId', 'endpoint', 'documentId', 'sourceId', 'sources', 'content', 'text',
    'token', 'sourceProof', 'readBackProofs', 'metadata', 'error', 'stack', 'nested', 'documentIds',
  ];

  function assertAllowlisted(value: DomainSupplementDiagnostics): void {
    expect(diagnosticKeys(value).filter((key) => !allowedKeys.has(key))).toEqual([]);
    for (const key of diagnosticKeys(value)) {
      expect(forbiddenKeys.some((forbidden) => key === forbidden || key.endsWith(`.${forbidden}`))).toBe(false);
    }
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.core)).toBe(true);
  }

  it('shows only a settled allowlisted receipt, hides it when off, and leaves Core dispatch unknown', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：诊断不得输出基线和补充来源正文。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-diagnostic', '可重复做法：诊断只报告数量与耗时，不报告来源身份。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);

    const recorded = receipt(rig);
    expect(recorded).toMatchObject({
      status: 'finalized', baselineStatus: 'absent', addedSourceCount: 2, finalizedSegmentCount: 2,
    });
    const onRequests = rig.requests.length;
    const onReads = rig.documentReads.length;
    const on = await invokeDiagnostics(run);
    expect(rig.requests).toHaveLength(onRequests);
    expect(rig.documentReads).toHaveLength(onReads);
    expect(on).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'settled',
      receiptPresent: true,
      turnActive: false,
      status: 'finalized',
      fallbackReason: null,
      baselineStatus: recorded.baselineStatus,
      candidateCount: recorded.candidateCount,
      verifiedCount: recorded.verifiedCount,
      consumedCount: recorded.consumedCount,
      addedSourceCount: recorded.addedSourceCount,
      withheldCount: recorded.withheldCount,
      fallbackCount: recorded.fallbackCount,
      finalizedSegmentCount: recorded.finalizedSegmentCount,
      queryCalls: recorded.queryCalls,
      readbackCalls: recorded.readbackCalls,
      finalReadbackCalls: recorded.finalReadbackCalls,
      supplementalChars: recorded.supplementalChars,
      elapsedMs: recorded.elapsedMs,
      rssDeltaBytes: recorded.rssDeltaBytes,
    });
    expect(on.receiptAgeMs).toBeGreaterThanOrEqual(0);
    expect(on.core).toEqual({ requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false });
    assertAllowlisted(on);

    const envelope = run.api.generationEvidence('main').at(-1);
    expect(envelope).toMatchObject({ requestState: 'sent', mappingState: 'complete', actualEvidenceUsed: 'unknown' });
    expect(envelope?.exposedSources.map((entry) => entry.documentId).sort()).toEqual(['source-baseline', 'source-new-diagnostic']);

    // Arguments are ignored, so a forged Core-shaped value cannot turn the Persona receipt into dispatch proof.
    const forged = await invokeDiagnostics(run, [
      QUERY, { requestState: 'sent', actualEvidenceUsed: 'used', evidenceObserved: true },
      recorded.queryHash, bankId, rig.endpoint, 'source-new-diagnostic', 'token-secret',
    ]);
    const { receiptAgeMs: forgedAge, ...forgedRest } = forged;
    const { receiptAgeMs: onAge, ...onRest } = on;
    expect(forgedAge).toBeGreaterThanOrEqual(0);
    expect(onAge).toBeGreaterThanOrEqual(0);
    expect(forgedRest).toEqual(onRest);

    const privateLiterals = [
      QUERY, baselineSource.content, newSource.content, recorded.queryHash!, bankId, rig.endpoint,
      'source-baseline', 'source-new-diagnostic', 'token-secret',
    ];
    const onJson = JSON.stringify(on);
    for (const literal of privateLiterals) expect(onJson).not.toContain(literal);
    assertAllowlisted(forged);

    const requestsBefore = rig.requests.length;
    const readsBefore = rig.documentReads.length;
    const config = (rig.memory as unknown as { config: { enabled: boolean; domainSupplement: { enabled: boolean } } }).config;
    config.domainSupplement.enabled = false;
    const off = await invokeDiagnostics(run);
    expect(off).toMatchObject({
      available: true,
      enabled: false,
      receiptState: 'disabled',
      receiptPresent: false,
      turnActive: false,
      status: null,
      fallbackReason: null,
      baselineStatus: null,
      candidateCount: null,
      verifiedCount: null,
      consumedCount: null,
      addedSourceCount: null,
      finalizedSegmentCount: null,
      receiptAgeMs: null,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(off);
    expect(rig.requests).toHaveLength(requestsBefore);
    expect(rig.documentReads).toHaveLength(readsBefore);
    const offJson = JSON.stringify(off);
    for (const literal of privateLiterals) expect(offJson).not.toContain(literal);
    expect(await invokeDiagnostics(run)).toEqual(off);

    config.domainSupplement.enabled = true;
    config.enabled = false;
    const hindsightOff = await invokeDiagnostics(run);
    expect(hindsightOff).toMatchObject({
      available: true,
      enabled: false,
      receiptState: 'disabled',
      receiptPresent: false,
      status: null,
    });
    assertAllowlisted(hindsightOff);

    emitDiagnosticsEvidence('diagnostics-on-off.json', {
      layer: 'D4S5_CONTENT_FREE_DIAGNOSTICS_ON_OFF',
      syntheticOnly: true,
      on,
      off,
      hindsightOff,
      receiptValues: {
        status: recorded.status,
        fallbackReason: recorded.fallbackReason,
        baselineStatus: recorded.baselineStatus,
        candidateCount: recorded.candidateCount,
        verifiedCount: recorded.verifiedCount,
        consumedCount: recorded.consumedCount,
        addedSourceCount: recorded.addedSourceCount,
        withheldCount: recorded.withheldCount,
        fallbackCount: recorded.fallbackCount,
        finalizedSegmentCount: recorded.finalizedSegmentCount,
        queryCalls: recorded.queryCalls,
        readbackCalls: recorded.readbackCalls,
        finalReadbackCalls: recorded.finalReadbackCalls,
        supplementalChars: recorded.supplementalChars,
        elapsedMs: recorded.elapsedMs,
        rssDeltaBytes: recorded.rssDeltaBytes,
      },
      extraRecallAfterOff: rig.requests.length - requestsBefore,
      extraDocumentReadsAfterOff: rig.documentReads.length - readsBefore,
    });
    emitDiagnosticsEvidence('diagnostics-privacy-negative.json', {
      layer: 'D4S5_DIAGNOSTIC_PRIVACY_NEGATIVE',
      syntheticOnly: true,
      allowedKeys: [...allowedKeys].sort(),
      forbiddenKeys,
      unexpectedKeys: diagnosticKeys(on).filter((key) => !allowedKeys.has(key)),
      privateLiteralsFound: privateLiterals.filter((literal) => onJson.includes(literal) || offJson.includes(literal)),
      forgedArgumentsIgnored: forged,
      offHidesPreviousOnReceipt: off.receiptPresent === false && off.status === null,
      hindsightOffHidesPreviousOnReceipt: hindsightOff.receiptPresent === false && hindsightOff.status === null,
    });
    emitDiagnosticsEvidence('core-boundary-summary.json', {
      layer: 'D4S5_PERSONA_VS_CORE_BOUNDARY',
      syntheticOnly: true,
      personaReceipt: {
        status: recorded.status,
        fallbackReason: recorded.fallbackReason,
        addedSourceCount: recorded.addedSourceCount,
        finalizedSegmentCount: recorded.finalizedSegmentCount,
      },
      independentCoreEnvelope: {
        requestState: envelope?.requestState ?? null,
        responseJoinState: envelope?.responseJoinState ?? null,
        mappingState: envelope?.mappingState ?? null,
        actualEvidenceUsed: envelope?.actualEvidenceUsed ?? null,
        exposedSourceCount: envelope?.exposedSources.length ?? 0,
      },
      diagnosticCore: on.core,
      personaFinalizedInferredAsCoreDispatch: false,
      forgedCoreInputAffectedDiagnostic: !Object.is(forged.core.requestState, 'UNKNOWN'),
    });
  }, 30_000);

  it('reports a fallback with the same counts and a safe reason', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：补充分支失败时必须回到普通基线。', 'project-functional');
    rig.seed([{ source: baselineSource, state: 'assigned', domains: ['project-functional'] }]);
    let calls = 0;
    rig.setResponder(() => calls++ === 0 ? responseForDocs([baselineSource]) : responseForDocs([]));
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);

    const recorded = receipt(rig);
    expect(recorded).toMatchObject({ status: 'fallback', fallbackReason: 'no_candidates' });
    const diagnostic = await invokeDiagnostics(run);
    expect(diagnostic).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'settled',
      receiptPresent: true,
      status: 'fallback',
      fallbackReason: 'no_candidates',
      candidateCount: recorded.candidateCount,
      verifiedCount: recorded.verifiedCount,
      consumedCount: recorded.consumedCount,
      addedSourceCount: recorded.addedSourceCount,
      withheldCount: recorded.withheldCount,
      fallbackCount: recorded.fallbackCount,
      finalizedSegmentCount: 0,
      queryCalls: recorded.queryCalls,
      readbackCalls: recorded.readbackCalls,
      finalReadbackCalls: recorded.finalReadbackCalls,
      supplementalChars: recorded.supplementalChars,
      elapsedMs: recorded.elapsedMs,
      rssDeltaBytes: recorded.rssDeltaBytes,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(diagnostic);
    expect(diagnostic.status).not.toBe('finalized');
    const json = JSON.stringify(diagnostic);
    for (const literal of [QUERY, baselineSource.content, baselineSource.documentId, recorded.queryHash!, bankId, rig.endpoint]) {
      expect(json).not.toContain(literal);
    }

    const envelope = run.api.generationEvidence('main').at(-1);
    emitDiagnosticsEvidence('diagnostics-fallback.json', {
      layer: 'D4S5_DIAGNOSTIC_FALLBACK',
      syntheticOnly: true,
      diagnostic,
      receiptStatus: recorded.status,
      receiptFallbackReason: recorded.fallbackReason,
      independentCoreEnvelope: {
        requestState: envelope?.requestState ?? null,
        mappingState: envelope?.mappingState ?? null,
        actualEvidenceUsed: envelope?.actualEvidenceUsed ?? null,
        exposedSourceCount: envelope?.exposedSources.length ?? 0,
      },
    });
  }, 30_000);

  it('drops injected private fields, normalizes an unknown reason, and reports a skipped receipt', async () => {
    const rig = await createRig();
    const run = await rig.start({ supplementEnabled: true });
    const fresh = await invokeDiagnostics(run);
    expect(fresh).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'no_receipt',
      receiptPresent: false,
      turnActive: false,
      status: null,
      candidateCount: null,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(fresh);
    const injected = {
      at: new Date().toISOString(),
      enabled: true,
      status: 'skipped',
      fallbackReason: 'PRIVATE_REASON_TEXT',
      baselineStatus: 'unavailable',
      queryHash: 'QHASH_SECRET',
      candidateCount: -3,
      verifiedCount: 2.9,
      consumedCount: 0,
      addedSourceCount: 1,
      withheldCount: 2,
      fallbackCount: 1,
      finalizedSegmentCount: 0,
      queryCalls: 0,
      readbackCalls: 0,
      finalReadbackCalls: 0,
      supplementalChars: 0,
      elapsedMs: 42,
      rssDeltaBytes: 4096,
      query: 'PRIVATE QUERY TEXT',
      content: 'PRIVATE CONTENT',
      text: 'PRIVATE TEXT',
      bankId: 'bank-secret',
      endpoint: 'http://secret.invalid',
      documentId: 'document-secret',
      sources: [{ documentId: 'document-secret', text: 'PRIVATE CONTENT' }],
      token: 'token-secret',
      sourceProof: { token: 'proof-secret' },
      readBackProofs: [{ token: 'proof-secret' }],
      error: 'PRIVATE ERROR',
      nested: { secret: 'PRIVATE NESTED' },
    } as unknown as DomainSupplementReceipt;
    rig.memory.recordDomainSupplement(injected);

    const diagnostic = await invokeDiagnostics(run);
    expect(diagnostic).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'settled',
      receiptPresent: true,
      turnActive: false,
      status: 'skipped',
      fallbackReason: 'other',
      baselineStatus: 'unavailable',
      candidateCount: 0,
      verifiedCount: 2,
      consumedCount: 0,
      addedSourceCount: 1,
      withheldCount: 2,
      fallbackCount: 1,
      finalizedSegmentCount: 0,
      queryCalls: 0,
      readbackCalls: 0,
      finalReadbackCalls: 0,
      supplementalChars: 0,
      elapsedMs: 42,
      rssDeltaBytes: 4096,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(diagnostic);
    const json = JSON.stringify(diagnostic);
    for (const literal of [
      'PRIVATE_REASON_TEXT', 'QHASH_SECRET', 'PRIVATE QUERY TEXT', 'PRIVATE CONTENT', 'PRIVATE TEXT',
      'bank-secret', 'http://secret.invalid', 'document-secret', 'token-secret', 'proof-secret',
      'PRIVATE ERROR', 'PRIVATE NESTED',
    ]) {
      expect(json).not.toContain(literal);
    }

    emitDiagnosticsEvidence('diagnostics-private-fields.json', {
      layer: 'D4S5_DIAGNOSTIC_INJECTED_FIELDS',
      syntheticOnly: true,
      freshReceiptState: fresh.receiptState,
      diagnostic,
      injectedFieldNames: Object.keys(injected).sort(),
      unexpectedKeys: diagnosticKeys(diagnostic).filter((key) => !allowedKeys.has(key)),
      unknownReasonNormalizedTo: diagnostic.fallbackReason,
      negativeCountClampedTo: diagnostic.candidateCount,
      fractionalCountFlooredTo: diagnostic.verifiedCount,
    });
  }, 30_000);

  it('clears the active marker when a turn fails before delivery', async () => {
    const rig = await createRig();
    const run = await rig.start({ supplementEnabled: true });
    const memory = rig.memory as unknown as { recallForTurn: HindsightMemory['recallForTurn'] };
    const original = memory.recallForTurn;
    memory.recallForTurn = async () => { throw new Error('synthetic pre-delivery failure'); };
    await expect(run.persona.onDelivery({ events: [userEvent(QUERY, 9501)] }))
      .rejects.toThrow('synthetic pre-delivery failure');
    memory.recallForTurn = original;
    const diagnostic = await invokeDiagnostics(run);
    expect(diagnostic).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'no_receipt',
      receiptPresent: false,
      turnActive: false,
      status: null,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(diagnostic);
  }, 30_000);

  it('does not present the previous finalized receipt after a later turn fails before delivery', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：上一轮的成功收据不能冒充下一轮的结果。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-stale', '可重复做法：诊断只展示归属于当前轮次的收据。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls % 2 === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);
    expect(receipt(rig).status).toBe('finalized');
    const before = await invokeDiagnostics(run);
    expect(before).toMatchObject({
      receiptState: 'settled',
      receiptPresent: true,
      turnActive: false,
      status: 'finalized',
    });
    assertAllowlisted(before);

    const memory = rig.memory as unknown as { recallForTurn: HindsightMemory['recallForTurn'] };
    const original = memory.recallForTurn;
    memory.recallForTurn = async () => { throw new Error('synthetic second-turn pre-delivery failure'); };
    await expect(run.persona.onDelivery({ events: [userEvent(QUERY, 9601)] }))
      .rejects.toThrow('synthetic second-turn pre-delivery failure');
    memory.recallForTurn = original;

    const failed = await invokeDiagnostics(run);
    expect(failed).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'no_receipt',
      receiptPresent: false,
      turnActive: false,
      status: null,
      fallbackReason: null,
      baselineStatus: null,
      candidateCount: null,
      addedSourceCount: null,
      receiptAgeMs: null,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(failed);
    const failedJson = JSON.stringify(failed);
    for (const literal of [QUERY, baselineSource.content, newSource.content, before.receiptAgeMs?.toString() ?? '',
      'source-baseline', 'source-new-stale']) {
      if (literal) expect(failedJson).not.toContain(literal);
    }

    // The next completed round settles normally: the older receipt is hidden, not permanently cleared.
    await deliver(rig, run, QUERY);
    const recovered = await invokeDiagnostics(run);
    expect(recovered).toMatchObject({
      receiptState: 'settled',
      receiptPresent: true,
      turnActive: false,
      status: 'finalized',
      addedSourceCount: 2,
      finalizedSegmentCount: 2,
    });
    assertAllowlisted(recovered);

    emitDiagnosticsEvidence('diagnostics-stale-receipt.json', {
      layer: 'D4S5_DIAGNOSTIC_STALE_RECEIPT_AFTER_PRE_DELIVERY_FAILURE',
      syntheticOnly: true,
      before,
      failed,
      recovered,
      previousReceiptStatus: receipt(rig).status,
      oldReceiptShownAfterFailure: failed.receiptPresent,
      turnActiveAfterFailure: failed.turnActive,
      diagnosticCore: failed.core,
    });
  }, 30_000);

  it('hides the previous receipt while a newer round runs and records only the newer result', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：并发诊断只能展示最新一轮结算后的收据。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-concurrent', '可重复做法：旧轮迟到不能覆盖新轮的诊断状态。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      if (calls === 2) return responseForDocs([baselineSource, newSource]);
      if (calls === 4) return responseForDocs([]);
      return responseForDocs([baselineSource]);
    });
    const held = { release: null as null | (() => void) };
    rig.setRecallHold((_request, index) => {
      if (index !== 4) return null;
      return new Promise<void>((resolvePromise) => { held.release = resolvePromise; });
    });
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);
    expect(receipt(rig).status).toBe('finalized');
    const before = run.api.generationEvidence('main').length;
    const pending = run.host.pushEvent(userEvent(QUERY, 9401), { trigger: 'flush' });
    await waitFor(() => rig.requests.length >= 4);
    const during = await invokeDiagnostics(run);
    expect(during).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'in_progress',
      receiptPresent: false,
      turnActive: true,
      status: null,
      fallbackReason: null,
      candidateCount: null,
      addedSourceCount: null,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(during);
    if (!held.release) throw new Error('the second supplement query was not held');
    held.release();
    await pending;
    await waitFor(() => run.api.generationEvidence('main').length > before);
    await waitFor(() => run.core.loop.getStatus().phase.state === 'idle');

    const after = await invokeDiagnostics(run);
    expect(after).toMatchObject({
      receiptState: 'settled',
      receiptPresent: true,
      turnActive: false,
      status: 'fallback',
      fallbackReason: 'no_candidates',
      addedSourceCount: 0,
      finalizedSegmentCount: 0,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(after);
    expect(after.receiptAgeMs).toBeGreaterThanOrEqual(0);

    emitDiagnosticsEvidence('diagnostics-concurrency.json', {
      layer: 'D4S5_DIAGNOSTIC_OVERLAP_CANCEL',
      syntheticOnly: true,
      during,
      after,
      firstReceiptStatus: 'finalized',
      secondReceiptStatus: after.status,
      oldReceiptShownDuringNewTurn: during.receiptPresent,
    });
  }, 30_000);

  it('does not treat a previous receipt with the same millisecond as a newer failed turn', async () => {
    const rig = await createRig();
    const baselineSource = source(rig.endpoint, 'source-baseline', '项目决定：同一毫秒的旧收据仍属于上一轮。', 'project-functional');
    const newSource = source(rig.endpoint, 'source-new-same-ms', '可重复做法：轮次归属不能只靠毫秒时间戳。', 'skill-methods');
    rig.seed([
      { source: baselineSource, state: 'assigned', domains: ['project-functional'] },
      { source: newSource, state: 'assigned', domains: ['skill-methods'] },
    ]);
    let calls = 0;
    rig.setResponder(() => {
      calls += 1;
      return calls === 1 ? responseForDocs([baselineSource]) : responseForDocs([baselineSource, newSource]);
    });
    const run = await rig.start({ supplementEnabled: true });

    await deliver(rig, run, QUERY);
    const first = receipt(rig);
    expect(first.status).toBe('finalized');
    const shared = Date.parse(first.at);
    // The previous receipt and the next turn's start are deliberately the same millisecond.
    rig.memory.recordDomainSupplement({ ...first, at: new Date(shared).toISOString() });

    const memory = rig.memory as unknown as { recallForTurn: HindsightMemory['recallForTurn'] };
    const originalRecall = memory.recallForTurn;
    memory.recallForTurn = async () => { throw new Error('synthetic same-ms pre-delivery failure'); };
    const now = vi.spyOn(Date, 'now').mockReturnValue(shared);
    try {
      await expect(run.persona.onDelivery({ events: [userEvent(QUERY, 9701)] }))
        .rejects.toThrow('synthetic same-ms pre-delivery failure');
    } finally {
      now.mockRestore();
      memory.recallForTurn = originalRecall;
    }

    const failed = await invokeDiagnostics(run);
    expect(failed).toMatchObject({
      available: true,
      enabled: true,
      receiptState: 'no_receipt',
      receiptPresent: false,
      turnActive: false,
      status: null,
      fallbackReason: null,
      receiptAgeMs: null,
      core: { requestState: 'UNKNOWN', actualEvidenceUsed: 'UNKNOWN', evidenceObserved: false },
    });
    assertAllowlisted(failed);

    await run.persona.onDelivery({ events: [userEvent(QUERY, 9702)] });
    const recovered = await invokeDiagnostics(run);
    expect(recovered).toMatchObject({
      receiptState: 'settled',
      receiptPresent: true,
      turnActive: false,
    });
    expect(recovered.status).not.toBeNull();
    assertAllowlisted(recovered);

    emitDiagnosticsEvidence('diagnostics-same-ms-receipt.json', {
      layer: 'D4S5_DIAGNOSTIC_SAME_MS_STALE_RECEIPT',
      syntheticOnly: true,
      sharedMillisecond: new Date(shared).toISOString(),
      failed,
      recovered,
      oldReceiptShownAfterFailure: failed.receiptPresent,
      turnActiveAfterFailure: failed.turnActive,
    });
  }, 30_000);
});
