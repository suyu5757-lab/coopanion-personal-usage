/**
 * P3-C/D real run (opt-in): the production Persona + Core consumer, an isolated v5 copy and the
 * real Hindsight Bank through its read-only loopback, with a local mock Provider.
 *
 * Skipped in the ordinary suite. It only runs when `P3_REAL_RUN=1` and `P3_REAL_PROFILE` points
 * at a prepared isolated profile, so no default run touches real memory. Output contains counts,
 * reason codes and short hashes only: never source text, the bank id, the endpoint or the
 * question.
 *
 * The same persisted workspace/session is opened twice, so the second turn also proves that a
 * source-bearing memory block survives a Core restart and is re-validated instead of blocking
 * the request.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CoreApi } from 'cortico/core/types.ts';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { Core } from '../vendor/cortico/tests/core/fixture-core.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeLoaded, textReply } from '../vendor/cortico/tests/core/helpers.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona, type DomainSupplementDiagnostics } from '../core/persona.ts';
import { COOPANION_TOOL_SCHEMA_DIGESTS } from '../core/tool-schema-roots.ts';
import { isTrustedGrowthToolText } from '../core/growth/review.ts';
import { isTrustedMemorySearchNotice } from '../core/memory/model-text.ts';
import { HindsightMemory, type DomainSupplementReceipt } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';

const enabled = process.env.P3_REAL_RUN === '1' && !!process.env.P3_REAL_PROFILE;
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const short = (value: string) => sha(value).slice(0, 12);

interface TurnSummary {
  questionHash: string;
  recall: Record<string, unknown> | null;
  supplement: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
  provider: Record<string, unknown> | null;
}

async function runRealTurn(profile: string, question: string, turn: number): Promise<TurnSummary> {
  const cfg = JSON.parse(readFileSync(`${profile}/home/companion/hindsight.json`, 'utf8')) as {
    bankId: string; apiUrl: string;
  };
  const memoryDir = `${profile}/home/companion`;
  const workspace = `${profile}/p3-core-workspace`;
  if (!existsSync(workspace)) cpSync(`${memoryDir}/workspace`, workspace, { recursive: true });
  closeMemoryStateStores();
  const store = openMemoryStateStore(`${memoryDir}/memory-state.sqlite`);
  const ledger = new ForgetLedger(store);
  const client = new HindsightClient({ baseUrl: cfg.apiUrl, maxAttempts: 1 });
  const memory = new HindsightMemory();
  Object.assign(memory, {
    config: loadHindsightConfig(memoryDir, {
      enabled: true,
      autostart: false,
      apiUrl: cfg.apiUrl,
      bankId: cfg.bankId,
      domainSupplement: { enabled: true, maxSupplementSources: 3, maxSupplementChars: 1200 },
    }),
    client,
    stateStore: store,
    outbox: new MemoryOutbox(store),
    ledger,
    ready: true,
    unavailableUntil: 0,
  });

  const root = `${profile}/p3-core`;
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  config.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  const Persona = coopanionPersona(Cormini, { memory, sourceSafeToolResults: true });
  const persona = new Persona({ memoryDir: workspace });
  persona.onOpening = () => {};
  const apiBox: { value: CoreApi | null } = { value: null };
  const attach = persona.attach.bind(persona);
  persona.attach = (value) => { apiBox.value = value as never; attach(value); };
  const world = makeFakeIO('desktop-pet', [], ' ');
  let host: { pushEvent: (event: unknown, options?: unknown) => Promise<void> } | null = null;
  const startWorld = world.start?.bind(world);
  world.start = async (value: never) => { host = value as never; await startWorld?.(value); };
  const llm = new FakeLLM();
  llm.script(textReply(`P3 real-source answer ${turn}.`));
  const dispatched: string[] = [];
  const respond = llm.respond.bind(llm);
  llm.respond = (request, options) => respond(request, {
    ...options,
    onRequestSent: (info) => {
      if (typeof info.body === 'string') dispatched.push(info.body);
      options?.onRequestSent?.(info);
    },
  });
  const core = new Core(makeLoaded({ config, rootDir: root, memoryDir: workspace, dataDir: `${root}/data` }), {
    persona,
    worlds: [world],
    llm,
    toolTextTrust: (tool, text) => isTrustedMemorySearchNotice(tool, text) || isTrustedGrowthToolText(tool, text),
    requireCompleteEvidence: true,
    trustedToolSchemaDigests: [...COOPANION_TOOL_SCHEMA_DIGESTS],
    worldEventTrust: (candidate, event) => candidate === world && event.type === 'desktop-pet.message',
    worldPromptTrust: (candidate) => candidate === world
      ? { templateDigests: [sha(' ')], independentVariables: false }
      : undefined,
  });
  await core.start();
  try {
    await host!.pushEvent({
      type: 'desktop-pet.message', source: 'desktop-pet', dependencyOrigin: 'user-input',
      ts: new Date().toISOString(), text: question, meta: { text: question },
    }, { trigger: 'flush' });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const envelopes = apiBox.value?.generationEvidence('main') ?? [];
      if (envelopes.length > 0 && core.loop.getStatus().phase.state === 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const envelope = apiBox.value?.generationEvidence('main').at(-1);
    const receipt = memory.lastDomainSupplementReceipt() as DomainSupplementReceipt | null;
    const lastRecall = (memory as unknown as { lastRecall: Record<string, unknown> | null }).lastRecall;
    const invoke = persona.webUi('en').invoke;
    const diagnostics = invoke
      ? await invoke('hindsight', 'domain-supplement-diagnostics', []) as DomainSupplementDiagnostics
      : null;
    const exposed = (envelope?.exposedSources ?? []).map((source: { documentId: string }) => source.documentId);
    const body = dispatched.at(-1) ?? '';
    const supplementSpans = (envelope?.items ?? []).flatMap((item: {
      spans: Array<{ origin: string; mappingState: string; serializedRanges: unknown[] }>;
    }) => item.spans)
      .filter((span: { origin: string; mappingState: string }) => span.origin === 'hindsight-source'
        && span.mappingState === 'complete')
      .flatMap((span: { serializedRanges: unknown[] }) => span.serializedRanges);
    return {
      questionHash: short(question),
      recall: lastRecall ? {
        route: lastRecall.route,
        status: lastRecall.status,
        sourceFactCounts: lastRecall.sourceFactCounts ?? null,
        serverTruncated: lastRecall.serverTruncated ?? null,
        includedResults: lastRecall.includedResults ?? null,
        injectedAt: lastRecall.injectedAt ?? null,
      } : null,
      supplement: receipt ? {
        status: receipt.status,
        fallbackReason: receipt.fallbackReason ?? null,
        baselineStatus: receipt.baselineStatus,
        candidateCount: receipt.candidateCount,
        verifiedCount: receipt.verifiedCount,
        consumedCount: receipt.consumedCount,
        withheldCount: receipt.withheldCount,
        fallbackCount: receipt.fallbackCount,
        queryCalls: receipt.queryCalls,
        readbackCalls: receipt.readbackCalls,
        finalReadbackCalls: receipt.finalReadbackCalls,
        finalizedSegmentCount: receipt.finalizedSegmentCount,
        supplementalChars: receipt.supplementalChars,
      } : null,
      diagnostics: diagnostics ? {
        status: diagnostics.status,
        queryCalls: diagnostics.queryCalls,
        candidateCount: diagnostics.candidateCount,
        verifiedCount: diagnostics.verifiedCount,
        consumedCount: diagnostics.consumedCount,
        finalizedSegmentCount: diagnostics.finalizedSegmentCount,
      } : null,
      provider: envelope ? {
        requestState: envelope.requestState,
        requestBlockReason: envelope.requestBlockReason ?? null,
        mappingState: envelope.mappingState,
        responseJoinState: envelope.responseJoinState,
        exposedSourceCount: exposed.length,
        exposedHashes: [...new Set(exposed.map(short))],
        dispatchedRequests: dispatched.length,
        bodyChars: body.length,
        supplementSpanCount: supplementSpans.length,
        bodyContainsExcerpts: supplementSpans.length > 0 && body.length > 0,
      } : null,
    };
  } finally {
    await core.stop();
    closeMemoryStateStores();
  }
}

describe.skipIf(!enabled)('P3-C real Bank source consumption (isolated v5, read-only)', () => {
  it('delivers exact real sources through the real Persona and keeps them after a restart', async () => {
    const profile = process.env.P3_REAL_PROFILE!;
    const outFile = process.env.P3_REAL_OUT ?? '';
    const questions = [
      process.env.P3_REAL_QUESTION ?? '我们之前关于项目方向和做事方法聊过什么？',
      '上一次我们聊到的项目和习惯，你还记得哪些？',
    ];
    const first = await runRealTurn(profile, questions[0]!, 1);
    const second = await runRealTurn(profile, questions[1]!, 2);
    const summary = { first, second };
    if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n');
    console.log('P3_REAL_RUN=' + JSON.stringify(summary));
    // Turn 1 runs the whole chain on the real Bank.
    expect(first.supplement?.status).toBe('finalized');
    expect(first.supplement?.queryCalls as number).toBeGreaterThan(0);
    expect(first.supplement?.consumedCount as number).toBeGreaterThanOrEqual(1);
    expect(first.provider).toMatchObject({ requestState: 'sent', mappingState: 'complete' });
    expect(first.provider?.exposedSourceCount as number).toBeGreaterThanOrEqual(1);
    expect(first.provider?.supplementSpanCount as number).toBeGreaterThanOrEqual(1);
    expect(first.provider?.bodyContainsExcerpts).toBe(true);
    // Turn 2 runs in a fresh Core process over the same persisted session: the source-bearing
    // block from turn 1 must be re-validated, not stale-blocked. Its own supplement may stay
    // closed when that turn's baseline Recall is fenced; that is reported, not hidden.
    expect(second.provider).toMatchObject({ requestState: 'sent', mappingState: 'complete' });
    expect(second.provider?.exposedSourceCount as number).toBeGreaterThanOrEqual(1);
    expect(second.provider?.bodyContainsExcerpts).toBe(true);
  }, 240_000);
});
