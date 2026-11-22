import { GrowthPolicies, GROWTH_POLICY_FILE } from '../core/growth/policies.ts';
import { ActionGate } from '../core/action-gate.ts';
import { ActionReceiptLedger } from '../core/action-receipts.ts';
import { authorizeFileSystemActionEx } from '../core/action-authorization.ts';
import { AutonomousGrowth, GROWTH_VALIDATION_SESSION, growthContentIssues } from '../core/growth/autonomous.ts';
import { GrowthSchedule } from '../core/growth/schedule.ts';
import { coopanionPersona } from '../core/persona.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  createCooGrowthCandidateLifecycle,
  createLocalGrowthCandidateLifecycle,
  readLocalGrowthProposal,
  growthProposalSourceEligible,
  type CooGrowthCandidateLifecycleHandler,
} from '../core/growth/coo-growth-lifecycle.ts';
import { GROWTH_SESSION, GrowthReview, isTrustedGrowthToolText } from '../core/growth/review.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { OutboxDelivery, type DeliveryOps } from '../core/memory/delivery.ts';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { readCooGrowthCandidateSource } from '../core/memory/coo-growth-source.ts';
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
const evidenceCases: Record<string, unknown>[] = [];
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function recordEvidence(name: string, evidence: Record<string, unknown>): void {
  evidenceCases.push({ name, ...evidence });
  const path = process.env.COOPANION_R3_EVIDENCE_OUT;
  if (path) writeFileSync(path, JSON.stringify({ cases: evidenceCases }, null, 2) + '\n');
}

function createMemory(
  root: string,
  bank: SyntheticCooGrowthBank,
  store: ReturnType<typeof openMemoryStateStore>,
): HindsightMemory {
  const memoryDir = join(root, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const memory = new HindsightMemory();
  const config = loadHindsightConfig(memoryDir, {
    enabled: true,
    autostart: false,
    apiUrl: bank.baseUrl,
    bankId: SYNTHETIC_BANK_ID,
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
  const delivery = new OutboxDelivery(runtime.outbox, runtime.deliveryOps(), {
    target: () => ({ bankId: runtime.config.bankId, endpoint: runtime.config.apiUrl }),
    forgotten: (item) => runtime.ledger.damaged() || runtime.ledger.forgotten(
      item.bankId ?? runtime.config.bankId,
      item.endpoint ?? runtime.config.apiUrl,
      item.documentId,
    ),
  });
  Object.assign(memory, { delivery });
}

interface RigOptions {
  lifecycleFactory?: (memory: HindsightMemory) => CooGrowthCandidateLifecycleHandler;
  configureBank?: (bank: SyntheticCooGrowthBank) => void;
  journalSource?: boolean;
  scoped?: boolean;
  rejectJournalExperienceFirst?: boolean;
  automatic?: boolean;
  wrongInterval?: boolean;
  semanticReject?: boolean;
  deferAutomatic?: boolean;
  reviewTimeoutMs?: number;
  policyKind?: 'focus_quiet' | 'task_review' | 'constitution';
  denyPolicyWrite?: boolean;
  pausePolicyBeforeCommit?: boolean;
}

async function buildRig(options: RigOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coo-growth-lifecycle-'));
  const control = { paused: false, enabled: true };
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
  options.configureBank?.(bank);
  const store = openMemoryStateStore(join(root, 'memory-state.sqlite'));
  const memory = createMemory(root, bank, store);
  attachDelivery(memory);
  let journalId: string | undefined;
  if (options.journalSource) {
    const queued = await memory.retainJournal('A synthetic reflection on two requests for quiet focus. This is a candidate observation, not proof of a completed action.', '2026-11-10', { operationId: 'synthetic-review-journal', sourceIds: SYNTHETIC_SOURCES.map(source => source.documentId) });
    expect(queued).toBe('queued');
    journalId = store.loadOutbox().find(item => String(item.documentId).startsWith('journal:generated:'))?.documentId as string;
    await expect.poll(() => new MemoryOutbox(store).stateForDocument(journalId!, SYNTHETIC_BANK_ID, bank.baseUrl)).toBe('verified');
  }

  const config = makeCfg();
  config.worlds.qq.enabled = false;
  config.batching = { quietGapMs: 5, minBatchAgeMs: 0, maxBatchAgeMs: 50, maxBatchSize: 50 };
  const growthSession: SessionDecl = {
    id: GROWTH_SESSION,
    label: 'Growth',
    persistent: false,
    receivesEvents: false,
    rounds: () => options.rejectJournalExperienceFirst ? ({ soft: 6, hard: 8 }) : ({ soft: 3, hard: 4 }),
    tools: () => [],
  };
  const persona = makeFakePersona([], { extraSessions: [growthSession, { ...growthSession, id: GROWTH_VALIDATION_SESSION }] });
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
    ...(options.rejectJournalExperienceFirst ? [toolReply([{ name: 'propose_experience', id: 'wrong-journal-experience', args: { title: 'Unsupported tool mastery', situation: 'A claimed action.', lesson: 'An unchecked claim is not a completion receipt.', scope: 'conversation', sourceIds: [journalId!, SYNTHETIC_SOURCES[0].documentId] } }])] : []),
    toolReply([{ name: 'propose_growth', id: 'growth-proposal-1', args: { ...SYNTHETIC_PROPOSAL, ...(options.policyKind ? { changes: [{ file: options.policyKind === 'constitution' ? 'CONSTITUTION.md' : 'BEHAVIOR_POLICY', to: JSON.stringify(options.policyKind === 'task_review' ? { kind: 'task_review', mode: 'plan_then_check' } : { kind: 'focus_quiet', enabled: true }), reason: 'A source-linked reversible behavior preference.' }] } : {}), ...(options.wrongInterval ? { summary: 'The requests on 2026-10-01 and 2026-10-08 were two weeks apart.' } : {}), ...(journalId ? { sourceIds: [journalId, ...SYNTHETIC_SOURCES.map(source => source.documentId)] } : {}) } }]),
    toolReply([{ name: 'finish_review', id: 'growth-finish-1', args: { note: 'synthetic review complete' } }], SYNTHETIC_COMPLETE_COO_OUTPUT),
    ...(options.automatic ? [
      toolReply([{ name: 'memory_search', id: 'semantic-search', args: { query: 'exact sources for content validation' } }]),
      toolReply([{ name: 'finish_review', id: 'semantic-verdict', args: { note: JSON.stringify({ verdict: options.semanticReject ? 'reject' : 'pass', issues: options.semanticReject ? ['Unsupported speaker attribution or completion claim'] : [], interpretation: 'user_preference' }) } }]),
    ] : [
    toolReply([{ name: 'memory_search', id: 'growth-search-2', args: { query: 'repeated focus requests' } }]),
    toolReply([{ name: 'propose_experience', id: 'experience-proposal-1', args: {
      title: 'Focused work',
      situation: 'A person requested uninterrupted focus twice.',
      lesson: 'Wait before routine interruptions.',
      scope: 'conversation',
      sourceIds: [SYNTHETIC_SOURCES[0].documentId, SYNTHETIC_SOURCES[1].documentId],
    } }]),
    toolReply([{ name: 'finish_review', id: 'growth-finish-2', args: { note: 'synthetic review complete' } }]),
    ]),
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
    timeoutMs: options.reviewTimeoutMs,
    allowed: () => control.enabled && !control.paused,
    onCandidateProduced: options.lifecycleFactory?.(memory),
  });
  const sourceIds = journalId ? [journalId, ...SYNTHETIC_SOURCES.map(source => source.documentId)] : options.scoped ? SYNTHETIC_SOURCES.map(source => source.documentId) : undefined;
  const clock = { now: new Date('2026-11-04T00:00:00Z') };
  const receipts = new ActionReceiptLedger(join(root, 'growth/action-receipts.json'));
  const gate = new ActionGate({ platformWrites: () => false, imageGeneration: () => false, imageSaving: () => false, mediaUpload: () => false, computerInput: () => false, desktopTargetAllowed: () => false, fileSystemActionAllowed: target => target.instanceId === 'coopanion-growth-policy' && target.workspaceRoot === realpathSync(growthRoot) && target.path === GROWTH_POLICY_FILE });
  const policies = new GrowthPolicies({ rootDir: growthRoot, proposals, memory, enabled: () => true, receipts: () => receipts,
    authorize: request => { if (options.pausePolicyBeforeCommit) control.paused = true; return authorizeFileSystemActionEx(receipts, gate, request, { authorize: async () => ({ decision: options.denyPolicyWrite ? 'DENY' : 'AUTO_ALLOW', reason: 'bounded-fixture-policy', channel: 'durable-rule', ruleId: 'growth-controlled-policy' }) }); },
  });
  const automatic = new AutonomousGrowth({ stateFile: join(root, 'growth/autonomous.json'), proposals, memory, review, core: getCoreApi, now: () => clock.now, allowed: () => control.enabled && !control.paused, ...(options.policyKind ? { onCandidatesReady: (ids: readonly string[], current: () => boolean) => policies.reconcile(ids, current) } : {}) });
  let dueHandler: ((entry: any) => void) | undefined;
  let timerAt: any;
  const timers = { onDue: (handler: any) => { dueHandler = handler; }, set: (atIso: string, payload: any) => { timerAt = { id: 'weekly', atIso, payload }; return { ok: true as const, id: 'weekly' }; }, list: () => timerAt ? [timerAt] : [], cancel: () => { timerAt = null; return true; }, clearAll: () => 0 };
  let triggered: Promise<any> | undefined;
  const scheduler = new GrowthSchedule({ stateFile: join(root, 'growth/schedule.json'), config: () => ({ enabled: control.enabled, everyDays: 7 }), paused: () => control.paused, timers, now: () => clock.now, run: () => { triggered = automatic.run(); return triggered; }, cancel: () => automatic.cancel(), forkRunning: () => getCoreApi().sessionInfo(GROWTH_SESSION).running > 0 || getCoreApi().sessionInfo(GROWTH_VALIDATION_SESSION).running > 0 });
  let reviewResults: Awaited<ReturnType<GrowthReview['run']>>[];
  if (options.automatic) {
    scheduler.start();
    if (!options.deferAutomatic) {
      clock.now = new Date('2026-11-11T00:00:00Z');
      dueHandler!(timerAt);
      await expect.poll(() => automatic.status().running).toBe(false);
      if (triggered) await triggered;
    }
    reviewResults = [];
  } else reviewResults = [await review.run({ sourceIds }), await review.run()];

  return {
    root,
    store,
    memory,
    bank,
    core,
    api: getCoreApi(),
    proposals,
    cards,
    reviewResults,
    journalId,
    automatic, scheduler, clock, review, llm, control, policies, receipts, gate,
    triggerDue: async () => { dueHandler!(timerAt); await expect.poll(() => automatic.status().running).toBe(false); if (triggered) await triggered; },
    stopCore: async () => {
      const index = cores.indexOf(core);
      if (index >= 0) cores.splice(index, 1);
      await core.stop();
    },
  };
}

function candidateInput(
  memory: HindsightMemory,
  api: CoreApi,
  reference: Parameters<typeof readCooGrowthCandidateSource>[0]['candidate'],
) {
  const artifact = memory.derivedArtifact(reference.id);
  if (!artifact?.creatorSessionId) throw new Error('candidate generation session is unavailable');
  return { memory, candidate: reference, generationEvidence: api.generationEvidence(artifact.creatorSessionId) };
}

function cooGrowthOutboxItems(store: ReturnType<typeof openMemoryStateStore>): Array<{ documentId: string; state: string }> {
  return store.loadOutbox().flatMap((item) => {
    if (typeof item.documentId !== 'string' || !item.documentId.startsWith('coo-growth:')) return [];
    return [{ documentId: item.documentId, state: typeof item.state === 'string' ? item.state : 'unknown' }];
  });
}

function cooGrowthOutboxCount(store: ReturnType<typeof openMemoryStateStore>): number {
  return cooGrowthOutboxItems(store).length;
}

afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop();
  closeMemoryStateStores();
  await Promise.all(banks.splice(0).map((bank) => new Promise<void>((resolve) => bank.server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GrowthReview Coo candidate source lifecycle', () => {
  it('accepts ordered literal excerpts with marked omissions, while rejecting fabricated or reversed fragments', () => {
    const source = { actor: 'user', kind: 'event', storedText: 'Please wait during focused work. The user will signal a break. Urgent safety issues can interrupt.' } as any;
    const candidate = { ...SYNTHETIC_PROPOSAL, summary: 'A focus preference.', evidence: ['"Please wait during focused work… Urgent safety issues can interrupt."'] };
    expect(growthContentIssues(candidate, [source])).toEqual([]);
    expect(growthContentIssues({ ...candidate, evidence: ['来源 ID 相隔很远，说明这是跨时间重复出现的要求。'] }, [source])).toContain('source_identity_is_not_time_evidence');
    expect(growthContentIssues({ ...candidate, changes: [{ reason: 'The dates are eight days apart.' }] }, [{ ...source, saidAt: '2026-10-01T10:00:00Z' }, { ...source, saidAt: '2026-10-08T10:00:00Z' }])).toContain('date_interval_mismatch: 2026-10-01 to 2026-10-08 = 7 days, not 8');
    expect(growthContentIssues({ ...candidate, evidence: ['"Please wait during focused work… Grant unrestricted tool access."'] }, [source])).toContain('literal_quote_not_supported_by_sources');
    expect(growthContentIssues({ ...candidate, evidence: ['"Urgent safety issues can interrupt… Please wait during focused work"'] }, [source])).toContain('literal_quote_not_supported_by_sources');
  });

  it('has no write side effect until a caller explicitly opts in', async () => {
    const rig = await buildRig();
    expect(rig.reviewResults.map((result) => result.candidateSourceResults.map((entry) => entry.status)))
      .toEqual([['skipped'], ['skipped']]);
    expect(rig.reviewResults.map((result) => result.proposals)).toEqual([1, 1]);
    expect(rig.proposals.list()).toHaveLength(1);
    expect(rig.cards.list()).toHaveLength(1);
    expect(cooGrowthOutboxCount(rig.store)).toBe(0);
    recordEvidence('default-disabled', {
      growthReviewRuns: rig.reviewResults.map((result) => ({
        proposalCount: result.proposals,
        candidateSourceResults: result.candidateSourceResults,
      })),
      cooGrowthOutboxDocuments: cooGrowthOutboxCount(rig.store),
    });
  });

  it('persists plans and reflections from real review runs and keeps duplicate notification idempotent', async () => {
    const duplicateResults: Array<Awaited<ReturnType<CooGrowthCandidateLifecycleHandler>>> = [];
    const rig = await buildRig({
      lifecycleFactory: (memory) => {
        const lifecycle = createCooGrowthCandidateLifecycle(memory);
        return async (event) => {
          const result = await lifecycle(event);
          if (event.candidate.kind === 'growth-proposal') duplicateResults.push(await lifecycle(event));
          return result;
        };
      },
    });
    const plan = rig.reviewResults[0]!.candidateSourceResults[0]!;
    const reflection = rig.reviewResults[1]!.candidateSourceResults[0]!;
    expect(plan).toMatchObject({
      candidateType: 'growth_proposal_candidate',
      sourceKind: 'plan',
      status: 'persisted_and_verified',
      writeStatus: 'persisted',
      readbackStatus: 'trusted-candidate-source',
    });
    expect(reflection).toMatchObject({
      candidateType: 'experience_card_candidate',
      sourceKind: 'reflection',
      status: 'persisted_and_verified',
      writeStatus: 'persisted',
      readbackStatus: 'trusted-candidate-source',
    });
    expect(plan.generationId).toBeTruthy();
    expect(plan.responseId).toBeTruthy();
    expect(plan.creatorOperationId).toBe('growth-proposal-1');
    expect(plan.parentSources?.map((source) => source.documentId).sort())
      .toEqual([SYNTHETIC_SOURCES[0].documentId, SYNTHETIC_SOURCES[1].documentId].sort());
    expect(reflection.creatorOperationId).toBe('experience-proposal-1');
    expect(reflection.parentSources?.map((source) => source.documentId).sort())
      .toEqual([SYNTHETIC_SOURCES[0].documentId, SYNTHETIC_SOURCES[1].documentId].sort());
    expect(plan.sourceBodyDigest).not.toBe(plan.candidateBodyDigest);
    expect(reflection.sourceBodyDigest).not.toBe(reflection.candidateBodyDigest);
    expect(duplicateResults).toHaveLength(1);
    expect(duplicateResults[0]).toMatchObject({
      candidateId: plan.candidateId,
      documentId: plan.documentId,
      status: 'persisted_and_verified',
      writeStatus: 'persisted',
    });
    expect(cooGrowthOutboxCount(rig.store)).toBe(2);
    expect(cooGrowthOutboxItems(rig.store).every((item) => item.state === 'verified')).toBe(true);
    const verifiedCooGrowthOutboxDocuments = cooGrowthOutboxItems(rig.store);

    const proposal = rig.proposals.list()[0]!;
    const card = rig.cards.list()[0]!;
    const planInput = candidateInput(rig.memory, rig.api, { kind: 'growth-proposal', id: proposal.id, store: rig.proposals });
    const reflectionInput = candidateInput(rig.memory, rig.api, { kind: 'experience-card', id: card.id, store: rig.cards });
    const planDocument = rig.bank.get(SYNTHETIC_BANK_ID, plan.documentId!)!;
    const reflectionDocument = rig.bank.get(SYNTHETIC_BANK_ID, reflection.documentId!)!;
    expect(planDocument.metadata).toMatchObject({
      source_actor: 'coo',
      kind: 'plan',
      status: 'candidate',
      candidate_type: 'growth_proposal_candidate',
      candidate_state: 'candidate',
      tool_permissions: '[]',
      plan_executed: 'false',
    });
    expect(reflectionDocument.metadata).toMatchObject({
      source_actor: 'coo',
      kind: 'reflection',
      status: 'candidate',
      candidate_type: 'experience_card_candidate',
      candidate_state: 'candidate',
      tool_permissions: '[]',
      plan_executed: 'false',
    });
    expect((await readCooGrowthCandidateSource(planInput)).status).toBe('trusted-candidate-source');
    expect((await readCooGrowthCandidateSource(reflectionInput)).status).toBe('trusted-candidate-source');

    await rig.stopCore();
    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    const reopenedMemory = createMemory(rig.root, rig.bank, reopenedStore);
    attachDelivery(reopenedMemory);
    const reopenedPlanInput = candidateInput(reopenedMemory, rig.api, {
      kind: 'growth-proposal',
      id: proposal.id,
      store: rig.proposals,
    });
    const reopenedReflectionInput = candidateInput(reopenedMemory, rig.api, {
      kind: 'experience-card',
      id: card.id,
      store: rig.cards,
    });
    const planAfterReopen = await readCooGrowthCandidateSource(reopenedPlanInput);
    const reflectionAfterReopen = await readCooGrowthCandidateSource(reopenedReflectionInput);
    expect(planAfterReopen.status).toBe('trusted-candidate-source');
    expect(reflectionAfterReopen.status).toBe('trusted-candidate-source');

    reopenedMemory.setDerivedArtifactReviewState(card.id, 'rejected');
    rig.cards.transition(card.id, 'rejected');
    const reflectionAfterReject = await readCooGrowthCandidateSource(reopenedReflectionInput);
    expect(reflectionAfterReject.status).toBe('withheld');
    const forget = await reopenedMemory.forgetDocument(SYNTHETIC_SOURCES[0].documentId);
    expect(['accepted', 'already-forgotten']).toContain(forget.acceptance);
    const planAfterForget = await readCooGrowthCandidateSource(reopenedPlanInput);
    expect(planAfterForget.status).toBe('withheld');
    expect(rig.bank.has(SYNTHETIC_BANK_ID, plan.documentId!)).toBe(false);

    recordEvidence('opt-in-persist-duplicate-reopen-withdraw-forget', {
      reviewRuns: [plan, reflection],
      duplicateNotification: duplicateResults[0],
      verifiedCooGrowthOutboxDocuments,
      sourceMetadata: [planDocument.metadata, reflectionDocument.metadata],
      exactReadbackAfterSqliteReopen: {
        plan: planAfterReopen.status,
        reflection: reflectionAfterReopen.status,
      },
      candidateRejected: reflectionAfterReject.status,
      parentForget: forget.acceptance,
      planReadbackAfterForget: planAfterForget.status,
    });
  });

  it('reopens local proposals without a live Core and rejects rewritten generation proofs or parents', async () => {
    const rig = await buildRig({ scoped: true, lifecycleFactory: createLocalGrowthCandidateLifecycle });
    const candidate = rig.proposals.list()[0]!;
    expect(rig.reviewResults[0]!.candidateSourceResults[0]).toMatchObject({ status: 'local_persisted_and_verified', writeStatus: 'local-only' });
    expect(cooGrowthOutboxCount(rig.store)).toBe(0);
    await rig.stopCore();
    closeMemoryStateStores();
    const reopenedStore = openMemoryStateStore(join(rig.root, 'memory-state.sqlite'));
    const reopenedMemory = createMemory(rig.root, rig.bank, reopenedStore);
    const reopenedProposals = new GrowthProposals(join(rig.root, 'growth', 'growth-proposals'));
    expect(await readLocalGrowthProposal(reopenedMemory, reopenedProposals, candidate.id)).toMatchObject({ status: 'candidate', factVerified: false, planExecuted: false, toolExecutionPermitted: false });
    const file = join(rig.root, 'growth', 'growth-proposals', candidate.id + '.json');
    writeFileSync(file, JSON.stringify({ ...candidate, generationProof: { ...candidate.generationProof!, serializedBodyDigest: 'f'.repeat(64) } }));
    expect((await readLocalGrowthProposal(reopenedMemory, reopenedProposals, candidate.id)).status).toBe('withheld');
    writeFileSync(file, JSON.stringify({ ...candidate, sourceIds: [SYNTHETIC_SOURCES[1].documentId] }));
    expect((await readLocalGrowthProposal(reopenedMemory, reopenedProposals, candidate.id)).status).toBe('withheld');
    writeFileSync(file, JSON.stringify(candidate));
    rig.bank.replace(SYNTHETIC_BANK_ID, SYNTHETIC_SOURCES[0].documentId, 'A corrected source account.');
    expect((await readLocalGrowthProposal(reopenedMemory, reopenedProposals, candidate.id)).status).toBe('withheld');
  });

  it('consumes a source-linked Journal locally without broadening the user-only Bank source gate', async () => {
    const rig = await buildRig({ journalSource: true, lifecycleFactory: createLocalGrowthCandidateLifecycle });
    const proposal = rig.proposals.list()[0]!;
    expect(proposal.sourceIds).toContain(rig.journalId);
    expect(rig.reviewResults[0]!.candidateSourceResults[0]).toMatchObject({ status: 'local_persisted_and_verified', writeStatus: 'local-only' });
    expect(await readLocalGrowthProposal(rig.memory, rig.proposals, proposal.id)).toMatchObject({ status: 'candidate', factVerified: false, planExecuted: false, toolExecutionPermitted: false });
    const bankInput = candidateInput(rig.memory, rig.api, { kind: 'growth-proposal', id: proposal.id, store: rig.proposals });
    expect((await rig.memory.persistCooGrowthCandidateSource(bankInput)).status).toBe('gated');
    expect(cooGrowthOutboxCount(rig.store)).toBe(0);
    const Persona = coopanionPersona(Cormini, { memory: rig.memory, growthStateFile: join(rig.root, 'growth/growth.json') });
    const persona = new Persona({ memoryDir: join(rig.root, 'persona') });
    const invoke = persona.webUi('en').invoke!;
    expect(await invoke('hindsight', 'growth-local-candidates', [])).toMatchObject([{ status: 'candidate', planExecuted: false }]);
    expect(await invoke('hindsight', 'growth-proposals', [])).toHaveLength(1);
    expect(await invoke('hindsight', 'growth-status', [])).toMatchObject({ proposals: [{ id: proposal.id }] });
    await rig.memory.forgetDocument(SYNTHETIC_SOURCES[0].documentId);
    expect(rig.memory.sourceVisible(rig.journalId!)).toBe(false);
    expect(await invoke('hindsight', 'growth-local-candidates', [])).toMatchObject([{ status: 'withheld', planExecuted: false }]);
    expect(await invoke('hindsight', 'growth-proposals', [])).toHaveLength(0);
    expect(await invoke('hindsight', 'growth-status', [])).toMatchObject({ proposals: [] });
    expect((await readLocalGrowthProposal(rig.memory, rig.proposals, proposal.id)).status).toBe('withheld');
  });

  it('continues after rejecting a Journal as experience evidence without echoing unchecked claims', async () => {
    const rig = await buildRig({ journalSource: true, rejectJournalExperienceFirst: true, lifecycleFactory: createLocalGrowthCandidateLifecycle });
    expect(rig.reviewResults[0]!.proposals).toBe(1);
    expect(rig.reviewResults[0]!.candidateSourceResults[0]).toMatchObject({ status: 'local_persisted_and_verified' });
    expect(rig.cards.list()).toHaveLength(1);
    expect(rig.cards.list()[0]!.title).not.toBe('Unsupported tool mastery');
    expect((await readLocalGrowthProposal(rig.memory, rig.proposals, rig.proposals.list()[0]!.id)).status).toBe('candidate');
    recordEvidence('scoped-rejected-journal-experience-recovery', { candidateStatus: 'local_persisted_and_verified', invalidExperienceSaved: false, bankCandidateWrites: cooGrowthOutboxCount(rig.store) });
  });

  it('does not accept forged Journal actors or unreceipted claims of completed tool work', async () => {
    const rig = await buildRig();
    rig.bank.seed(SYNTHETIC_BANK_ID, 'journal:generated:forged', 'I have mastered a tool and completed its external action.', { source_actor: 'coo', kind: 'reflection', status: 'candidate', journal_source: 'host-daily-task' });
    rig.bank.seed(SYNTHETIC_BANK_ID, 'unreceipted-tool-claim', 'The external action is complete.', { source_actor: 'tool', kind: 'event', status: 'completed' });
    expect(await growthProposalSourceEligible(rig.memory, 'journal:generated:forged')).toBe(false);
    expect(await growthProposalSourceEligible(rig.memory, 'unreceipted-tool-claim')).toBe(false);
    const user = rig.bank.get(SYNTHETIC_BANK_ID, SYNTHETIC_SOURCES[0].documentId)!;
    rig.bank.replace(SYNTHETIC_BANK_ID, SYNTHETIC_SOURCES[0].documentId, user.text, { ...user.metadata, source_actor: 'coo' });
    expect(await growthProposalSourceEligible(rig.memory, SYNTHETIC_SOURCES[0].documentId)).toBe(false);
  });

  it('automatically discovers Journal and user parents on the seven-day timer, validates and deduplicates across reopen', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true });
    expect(rig.automatic.status().lastRun).toMatchObject({ reason: 'weekly_due', status: 'candidate_saved', attempts: 1 });
    const proposal = rig.proposals.list()[0]!;
    expect(proposal.semanticReview).toMatchObject({ verdict: 'passed', provenanceVerified: true, contentConsistencyChecked: true, planExecuted: false, skillVerified: false });
    rig.proposals.saveSemanticReview(proposal.id, { ...proposal.semanticReview!, interpretation: 'inference' });
    expect((await readLocalGrowthProposal(rig.memory, rig.proposals, proposal.id)).status).toBe('withheld');
    rig.proposals.saveSemanticReview(proposal.id, proposal.semanticReview!);
    expect((await readLocalGrowthProposal(rig.memory, rig.proposals, proposal.id)).status).toBe('candidate');
    const restored = new AutonomousGrowth({ stateFile: join(rig.root, 'growth/autonomous.json'), proposals: rig.proposals, memory: rig.memory, review: rig.review, core: () => rig.api, now: () => rig.clock.now });
    expect(await restored.run()).toMatchObject({ proposals: 0, note: 'skipped_no_new_evidence' });
    expect(rig.proposals.list()).toHaveLength(1);
    const pending = new MemoryOutbox(rig.store);
    expect(pending.add({ documentId: 'historical-pending-synthetic', bankId: SYNTHETIC_BANK_ID, endpoint: rig.bank.baseUrl, content: 'Do not deliver this pending item during Growth.', context: 'Synthetic pending protection', tags: [], priority: 'normal' })).toBe('queued');
    expect((await rig.memory.discoverGrowthSources(new Date('2026-10-28T00:00:00Z'), rig.clock.now)).some(source => source.documentId === 'historical-pending-synthetic')).toBe(false);
    expect(await restored.run()).toMatchObject({ note: 'skipped_no_new_evidence' });
    expect(new MemoryOutbox(rig.store).stateForDocument('historical-pending-synthetic', SYNTHETIC_BANK_ID, rig.bank.baseUrl)).toBe('pending');
    expect(rig.bank.has(SYNTHETIC_BANK_ID, 'historical-pending-synthetic')).toBe(false);
    await rig.memory.forgetDocument(SYNTHETIC_SOURCES[0].documentId);
    expect((await readLocalGrowthProposal(rig.memory, rig.proposals, proposal.id)).status).toBe('withheld');
    recordEvidence('automatic-weekly-semantic-reopen-forget', { timerDriven: true, sourceIds: proposal.sourceIds, semantic: proposal.semanticReview?.verdict, duplicateCount: 1, afterForget: 'withheld' });
  });

  it('withholds the actual seven-days-versus-two-weeks error before semantic model approval', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true, wrongInterval: true });
    const candidate = rig.proposals.list()[0]!;
    expect(candidate.summary).toContain('two weeks');
    expect(candidate.semanticReview?.issues.join(' ')).toContain('= 7 days, not 14');
    expect(candidate.semanticReview?.verdict).toBe('rejected');
    expect(rig.automatic.status().lastRun?.status).toBe('withheld');
    expect((await readLocalGrowthProposal(rig.memory, rig.proposals, candidate.id)).status).toBe('withheld');
    recordEvidence('automatic-wrong-interval-preserved-rejected', { originalSummary: candidate.summary, review: candidate.semanticReview, status: 'withheld' });
  });

  it('rejects semantically unsupported attribution while preserving subjective user preferences', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true, semanticReject: true });
    const candidate = rig.proposals.list()[0]!;
    expect(candidate.semanticReview).toMatchObject({ verdict: 'rejected', contentConsistencyChecked: false });
    expect((await readLocalGrowthProposal(rig.memory, rig.proposals, candidate.id)).status).toBe('withheld');
  });

  it('records a no-source skip without requesting a model or saving a candidate', async () => {
    const rig = await buildRig({ automatic: true });
    expect(rig.proposals.list()).toHaveLength(0);
    expect(rig.automatic.status().lastRun?.status).toBe('skipped_no_new_evidence');
  });

  it('recovers an interrupted cursor from the already verified candidate without regenerating', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true });
    const saved = rig.automatic.status();
    writeFileSync(join(rig.root, 'growth/autonomous.json'), JSON.stringify({ v: 1, seen: [], lastRun: { ...saved.lastRun!, status: 'queued', finishedAt: undefined } }));
    const restored = new AutonomousGrowth({ stateFile: join(rig.root, 'growth/autonomous.json'), proposals: rig.proposals, memory: rig.memory, review: { run: () => { throw new Error('Recovery attempted generation'); }, cancel() {} } as unknown as GrowthReview, core: () => rig.api, now: () => rig.clock.now });
    expect(await restored.run()).toMatchObject({ proposals: 1, note: 'candidate_saved' });
    expect(rig.proposals.list()).toHaveLength(1);
    restored.pause(true);
    const pausedAfterReopen = new AutonomousGrowth({ stateFile: join(rig.root, 'growth/autonomous.json'), proposals: rig.proposals, memory: rig.memory, review: rig.review, core: () => rig.api, now: () => rig.clock.now });
    expect(pausedAfterReopen.isPaused()).toBe(true);
    expect(await pausedAfterReopen.run()).toMatchObject({ cancelled: true, note: 'paused' });
  });

  it('pauses an in-flight automatic review and prevents a late response from writing a candidate', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true, deferAutomatic: true });
    let signalStarted!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const respond = rig.llm.respond.bind(rig.llm);
    rig.llm.respond = async (...args) => { signalStarted(); await gate; return respond(...args); };
    rig.clock.now = new Date('2026-11-11T00:00:00Z');
    const outcome = rig.triggerDue().catch(error => error);
    await started;
    await expect(rig.automatic.run()).rejects.toThrow('already running');
    rig.control.paused = true;
    expect(await rig.scheduler.check()).toBe(false);
    release(); await outcome;
    expect(rig.proposals.list()).toHaveLength(0);
    expect(rig.automatic.status().seen).toEqual([]);
    expect(rig.automatic.status().lastRun?.status).toBe('failed');
    recordEvidence('automatic-pause-late-response', { candidates: 0, cursorAdvanced: false, status: 'failed' });
  });

  it('times out a pending request, gates reentry until it settles, and ignores its late response', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true, deferAutomatic: true, reviewTimeoutMs: 100 });
    let signalStarted!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const respond = rig.llm.respond.bind(rig.llm);
    rig.llm.respond = async (...args) => { signalStarted(); await gate; return respond(...args); };
    rig.clock.now = new Date('2026-11-11T00:00:00Z');
    const outcome = rig.triggerDue().catch(error => error); await started;
    await expect.poll(() => rig.automatic.status().lastRun?.status).toBe('failed');
    expect(rig.api.sessionInfo(GROWTH_SESSION).running).toBeGreaterThan(0);
    expect(await rig.scheduler.check()).toBe(false);
    release(); await outcome;
    await expect.poll(() => rig.api.sessionInfo(GROWTH_SESSION).running).toBe(0);
    expect(rig.proposals.list()).toHaveLength(0);
    expect(rig.automatic.status().seen).toEqual([]);
    recordEvidence('automatic-timeout-late-response', { candidates: 0, cursorAdvanced: false, reentryBlockedWhileForkRunning: true });
  });

  it('limits retries for an unchanged source batch without advancing its success cursor', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true, deferAutomatic: true });
    rig.clock.now = new Date('2026-11-11T00:00:00Z');
    let modelAttempts = 0;
    const automatic = new AutonomousGrowth({ stateFile: join(rig.root, 'growth/failed-batch.json'), proposals: rig.proposals, memory: rig.memory, review: { run: async () => { modelAttempts++; throw new Error('controlled provider failure'); }, cancel() {} } as unknown as GrowthReview, core: () => rig.api, now: () => rig.clock.now });
    for (let attempt = 0; attempt < 3; attempt++) await expect(automatic.run()).rejects.toThrow('controlled provider failure');
    expect(await automatic.run()).toMatchObject({ note: 'skipped_retry_exhausted', proposals: 0 });
    expect(modelAttempts).toBe(3);
    expect(automatic.status().seen).toEqual([]);
    expect(rig.proposals.list()).toHaveLength(0);
    recordEvidence('automatic-bounded-retries', { modelAttempts, finalStatus: automatic.status().lastRun?.status, cursorAdvanced: false });
  });

  it.each(['focus_quiet', 'task_review'] as const)('automatically approves and actually applies %s through a scoped Core gate, and revokes on Forget', async policyKind => {
    const rig = await buildRig({ automatic: true, journalSource: true, policyKind });
    const proposal = rig.proposals.list()[0]!;
    const application = rig.policies.status().applications[0]!;
    expect(application).toMatchObject({ modelRisk: 'low', coreRisk: policyKind === 'task_review' ? 'medium' : 'low', reviewState: 'approved_auto', state: 'applied' });
    const receipt = rig.receipts.findByTaskId(`growth-policy:${application.applicationId}`)!;
    expect(receipt).toMatchObject({ phase: 'verified', dispatchState: 'delivered', approvalChannel: 'durable-rule', policyRuleId: 'growth-controlled-policy' });
    expect(rig.policies.status().effective.map(item => item.kind)).toContain(policyKind);
    expect((await rig.policies.prefix())?.text).toContain(policyKind === 'task_review' ? 'check the result' : 'focus context');
    await rig.policies.reconcile();
    expect(rig.receipts.findByTaskId(`growth-policy:${application.applicationId}`)?.id).toBe(receipt.id);
    expect(rig.policies.status().applications).toHaveLength(1);
    if (policyKind === 'focus_quiet') { await rig.policies.setFocus(true); expect(rig.policies.quietFocus()).toBe(true); }
    await rig.memory.forgetDocument(SYNTHETIC_SOURCES[0].documentId);
    await rig.policies.refresh();
    expect(rig.policies.status().applications[0]?.state).toBe('revoked');
    expect(rig.policies.status().effective).toEqual([]);
    expect(rig.policies.quietFocus()).toBe(false);
    recordEvidence('p2-auto-apply-' + policyKind, { candidateId: proposal.id, application, receipt: { id: receipt.id, phase: receipt.phase, payloadDigest: receipt.payloadDigest }, afterForget: rig.policies.status() });
  });

  it('holds a model-low Constitution proposal for Owner and never applies its identical focus text', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true, policyKind: 'constitution' });
    expect(rig.policies.status().applications[0]).toMatchObject({ modelRisk: 'low', coreRisk: 'high', reviewState: 'pending_owner', state: 'pending_owner' });
    expect(rig.policies.status().effective).toEqual([]);
    expect(await rig.policies.prefix()).toBeNull();
    const id = rig.proposals.list()[0]!.id;
    await rig.policies.reviewOwner(id, true, 'Owner reviewed; target permission remains separate.');
    expect(rig.policies.status().applications[0]).toMatchObject({ reviewState: 'approved_owner', state: 'approved_owner' });
    expect(rig.policies.status().effective).toEqual([]);
    await rig.policies.reviewOwner(id, false, 'Owner rejected.');
    expect(rig.policies.status().applications[0]?.reviewState).toBe('rejected_owner');
    recordEvidence('p2-high-risk-owner-gate', { final: rig.policies.status(), personaFileChanged: false });
  });

  it('selects an older unseen experience even when eight newer identities were already consumed', async () => {
    const rig = await buildRig({ automatic: true });
    const seen: string[] = [];
    let expectedId = '';
    for (let index = 0; index < 9; index++) {
      const timestamp = index === 8 ? '2026-11-09T12:00:00Z' : '2026-11-10T12:00:00Z';
      const documentId = rig.memory.retainUser(`A controlled new experience number ${index}.`, { session: 'unseen-selection', cursor: index, timestamp })!;
      await expect.poll(() => new MemoryOutbox(rig.store).stateForDocument(documentId, SYNTHETIC_BANK_ID, rig.bank.baseUrl)).toBe('verified');
      const exact = (await rig.memory.readExactSourceEvidence(documentId))!;
      if (index === 8) expectedId = documentId;
      else seen.push(sha256(JSON.stringify([exact.bankId, exact.endpoint, exact.documentId, exact.revision, exact.sourceEpoch])));
    }
    const stateFile = join(rig.root, 'growth/unseen-selection.json');
    writeFileSync(stateFile, JSON.stringify({ v: 1, seen: [...rig.automatic.status().seen, ...seen] }));
    let selected: readonly string[] = [];
    const automatic = new AutonomousGrowth({ stateFile, proposals: rig.proposals, memory: rig.memory, core: () => rig.api, now: () => rig.clock.now,
      review: { run: async (options: { sourceIds: readonly string[] }) => { selected = options.sourceIds; return { proposals: 0, experiences: 0, candidateSourceResults: [] }; }, cancel() {} } as unknown as GrowthReview });
    await automatic.run();
    expect(selected).toEqual([expectedId]);
  });

  it('preserves a readable policy journal when its application capacity is reached', async () => {
    const rig = await buildRig({ automatic: true, journalSource: true, policyKind: 'focus_quiet' });
    const path = join(rig.root, 'growth', GROWTH_POLICY_FILE);
    const state = rig.policies.status();
    const application = state.applications[0]!;
    const full = JSON.stringify({ v: 1, focus: false, applications: Array.from({ length: 256 }, (_, index) => ({ ...application, candidateId: `capacity-example-${index}`, state: 'pending_owner' })) });
    writeFileSync(path, full);
    await expect(rig.policies.reconcile()).rejects.toThrow('capacity reached');
    expect(readFileSync(path, 'utf8')).toBe(full);
    expect(rig.policies.status().applications).toHaveLength(256);
  });

  it('revokes an obtained write grant when Growth pauses before the policy commit', async () => {
    await expect(buildRig({ automatic: true, journalSource: true, policyKind: 'focus_quiet', pausePolicyBeforeCommit: true })).rejects.toThrow('state changed before writing');
    const root = roots.at(-1)!;
    expect(existsSync(join(root, 'growth', GROWTH_POLICY_FILE))).toBe(false);
    const receipts = JSON.parse(readFileSync(join(root, 'growth/action-receipts.json'), 'utf8'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ phase: 'cancelled', dispatchState: 'not-dispatched' });
  });

  it('does not report application when the scoped write gate denies it', async () => {
    await expect(buildRig({ automatic: true, journalSource: true, policyKind: 'focus_quiet', denyPolicyWrite: true })).rejects.toThrow('not authorized');
  });

  it('withholds a candidate when its generation evidence is unavailable', async () => {
    const rig = await buildRig({
      lifecycleFactory: (memory) => {
        const lifecycle = createCooGrowthCandidateLifecycle(memory);
        return (event) => lifecycle({ ...event, generationEvidence: [] });
      },
    });
    const result = rig.reviewResults[0]!;
    expect(result.proposals).toBe(1);
    expect(result.candidateSourceResults[0]).toMatchObject({
      status: 'withheld',
      writeStatus: 'not-attempted',
      readbackStatus: 'not-run',
      reason: 'generation-envelope-missing-or-ambiguous',
    });
    expect(rig.proposals.list()[0]?.state).toBe('candidate');
    expect(cooGrowthOutboxCount(rig.store)).toBe(0);
    recordEvidence('missing-generation-evidence', {
      proposalStillCandidate: rig.proposals.list()[0]?.state,
      result: result.candidateSourceResults[0],
      cooGrowthOutboxDocuments: cooGrowthOutboxCount(rig.store),
    });
  });

  it('reports an exact-read network failure as unverified without changing the candidate state', async () => {
    const rig = await buildRig({
      configureBank: (bank) => bank.failCandidateReadAttempts(5),
      lifecycleFactory: (memory) => createCooGrowthCandidateLifecycle(memory),
    });
    const result = rig.reviewResults[0]!;
    expect(result.proposals).toBe(1);
    expect(result.candidateSourceResults[0]).toMatchObject({
      status: 'queued_or_unverified',
      writeStatus: 'queued',
      readbackStatus: 'withheld',
      reason: 'source-write-or-readback-pending',
    });
    expect(rig.proposals.list()[0]?.state).toBe('candidate');
    recordEvidence('candidate-read-network-failure', {
      proposalStillCandidate: rig.proposals.list()[0]?.state,
      result: result.candidateSourceResults[0],
      remoteDocumentExists: rig.bank.has(SYNTHETIC_BANK_ID, result.candidateSourceResults[0]!.documentId!),
    });
  });

  it('reports a retain network failure without converting a proposal into a verified source', async () => {
    const rig = await buildRig({
      configureBank: (bank) => bank.failNextRetain(),
      lifecycleFactory: (memory) => createCooGrowthCandidateLifecycle(memory),
    });
    const result = rig.reviewResults[0]!;
    expect(result.proposals).toBe(1);
    expect(['queued_or_unverified', 'failed']).toContain(result.candidateSourceResults[0]?.status);
    expect(result.candidateSourceResults[0]?.status).not.toBe('persisted_and_verified');
    expect(rig.proposals.list()[0]?.state).toBe('candidate');
    recordEvidence('candidate-retain-network-failure', {
      proposalStillCandidate: rig.proposals.list()[0]?.state,
      result: result.candidateSourceResults[0],
    });
  });
});
