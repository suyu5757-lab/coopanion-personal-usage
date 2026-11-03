/**
 * A periodic self-review in its own non-persistent session. The review reads the person's
 * notes and Coo's portrait, and may leave a growth proposal. It cannot edit Persona files:
 * a proposal becomes a change only after the person approves it.
 */
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { join } from 'node:path';
import type { CoreApi, ForkOutcome, ToolDef } from 'cortico/core/types.ts';
import type { ModelLanguage } from '../language.ts';
import type { HindsightMemory } from '../memory/hindsight.ts';
import { memoryReadNotice } from '../memory/model-text.ts';
import { ExperienceCards, experienceCardArtifactText, readExperienceCardInput } from './experience-cards.ts';
import { SELF_REVIEW_TEXT } from './model-text.ts';
import { GrowthProposals, growthProposalArtifactText, readProposalInput } from './proposals.ts';

/** The temporary session id of a self-review; declared by Coo's Persona. */
export const GROWTH_SESSION = 'growth';
const RECENT_MAX_CHARS = 8_000;

/** Tools the review may use. Speaking, writing files and computer use stay out. */
export const GROWTH_TOOL_NAMES = [
  'read_file',
  'list_files',
  'glob_files',
  'grep_files',
  'memory_search',
  'memory_reflect',
] as const;

export const PROPOSE_GROWTH_TOOL = 'propose_growth';
export const PROPOSE_EXPERIENCE_TOOL = 'propose_experience';

/** Growth reads include the exact source document id that a proposal must carry. */
export function growthMemorySearchTool(memory: () => HindsightMemory | null, observedSourceIds?: Set<string>): ToolDef {
  return {
    name: 'memory_search',
    description: 'Search long-term memory for dated facts. Results include source_id values for the record and verified supporting sources; use exact IDs in a growth proposal so a later forget request can remove the derived proposal.',
    tags: ['read'],
    barrierAfter: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural language.' },
        max_tokens: { type: 'integer', description: 'How much memory text to bring back; 400–2000, default 900.' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const store = memory();
      if (!store?.enabled()) return '[memory] Long-term memory is not available.';
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return '[memory] Nothing relevant was found.';
      const maxTokens = typeof args.max_tokens === 'number' && Number.isFinite(args.max_tokens)
        ? Math.min(2000, Math.max(400, Math.round(args.max_tokens)))
        : 900;
      const read = await store.recallBlockDetailed(query, { budget: 'low', maxTokens, timeoutMs: 5000, maxItems: 8, captureTrace: true });
      for (const sourceId of read.trace?.format.includedSourceDocumentIds ?? []) observedSourceIds?.add(sourceId);
      if (read.status !== 'found') return memoryReadNotice(read.status);
      return read.text || memoryReadNotice('fenced');
    },
  };
}

const PROPOSE_GROWTH_DECL: Omit<ToolDef, 'handler'> = {
  name: PROPOSE_GROWTH_TOOL,
  description: 'Leave a growth proposal for the person to review. The proposal is a file; it does not change CONSTITUTION.md or SELF.md by itself. Call it only when concrete evidence supports a durable change, then call finish_review.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short name for the proposed change.' },
      summary: { type: 'string', description: 'What should change and why, in a few sentences.' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'One to eight dated quotes, memory references or observed repeated patterns supporting the change.',
      },
      sourceIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'One to eight exact source_id values returned by memory_search.',
      },
      risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How much this would change how Coo behaves toward the person.' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', enum: ['CONSTITUTION.md', 'SELF.md'] },
            from: { type: 'string', description: 'The existing line to replace; omit when adding a new line.' },
            to: { type: 'string', description: 'The replacement or new line.' },
            reason: { type: 'string', description: 'Why this line should change.' },
          },
          required: ['file', 'to', 'reason'],
        },
        description: 'One to three minimal changes; never rewrite the whole file.',
      },
    },
    required: ['title', 'summary', 'evidence', 'sourceIds', 'risk', 'changes'],
  },
};

const FINISH_REVIEW_DECL: Omit<ToolDef, 'handler'> = {
  name: 'finish_review',
  description: 'Finish the self-review. Call it once, after leaving a Persona proposal or an experience candidate, or deciding that nothing should change.',
  tags: ['flow'],
  barrierAfter: true,
  endsTurn: true,
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'One line on what was proposed, or that nothing changed.' },
    },
    required: [],
  },
};

/** A review that cannot finish in this long stops at its next tool boundary; the schedule retries in an hour. */
const REVIEW_TIMEOUT_MS = 15 * 60_000;

export interface GrowthLog {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface GrowthReviewDeps {
  core: () => CoreApi | null;
  /** The main session's request context; its system records and recent messages are used. */
  snapshot: () => ContextRecord[];
  /** Persona read tools; Growth supplies a tracked memory_search tool for each run. */
  tools: () => ToolDef[];
  memory: () => HindsightMemory | null;
  /** Where candidate proposals are written, outside the Persona workspace. */
  proposalsDir: string;
  /** Where source-linked experience candidates are written, outside the Persona workspace. */
  experienceCardsDir?: string;
  modelLanguage: () => ModelLanguage;
  timezone: () => string;
  now?: () => Date;
  /** Test override for the 15-minute review deadline. */
  timeoutMs?: number;
  log?: GrowthLog;
}

export interface GrowthRunResult {
  proposals: number;
  note: string;
  cancelled: boolean;
  cancellationStatus?: 'acknowledged' | 'unknown' | 'shutdown';
}

function recentConversation(records: ContextRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    if (record.context.head) continue;
    if (hasRole(record, 'user')) {
      const text = textOf(record).trim();
      if (text) lines.push(`Person: ${text}`);
    } else if (hasRole(record, 'assistant')) {
      const text = textOf(record).trim();
      if (text) lines.push(`Coo: ${text}`);
    }
  }
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = out ? `${lines[i]}\n${out}` : lines[i]!;
    if (next.length > RECENT_MAX_CHARS) {
      if (!out) out = next.slice(-RECENT_MAX_CHARS);
      break;
    }
    out = next;
  }
  return out;
}

function localDate(timezone: string, date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function finishReviewTool(done: { note: string }): ToolDef {
  return {
    ...FINISH_REVIEW_DECL,
    handler: async (args) => {
      done.note = typeof args.note === 'string' ? args.note.trim().slice(0, 500) : '';
      return '[review finished]';
    },
  };
}

/**
 * A read that starts or finishes after the deadline is dropped: the fork cannot be aborted, so the
 * next tool boundary is where a timed-out review stops spending on reads.
 */
function guardRead(tool: ToolDef, state: { cancelled: boolean; deadline: number }): ToolDef {
  return {
    ...tool,
    handler: async (args, ctx) => {
      if (state.cancelled || Date.now() >= state.deadline) return '[review cancelled] No further reads were made.';
      const out = await tool.handler(args, ctx);
      if (state.cancelled || Date.now() >= state.deadline) return '[review cancelled] The review is over; this result is not used.';
      return out;
    },
  };
}

function proposeGrowthTool(
  store: GrowthProposals,
  state: { cancelled: boolean; deadline: number },
  done: { proposals: number },
  memory: () => HindsightMemory | null,
  observedSourceIds: ReadonlySet<string>,
  core: CoreApi,
): ToolDef {
  return {
    ...PROPOSE_GROWTH_DECL,
    handler: async (args, ctx) => {
      if (state.cancelled || Date.now() >= state.deadline) return '[review cancelled] No proposal was written.';
      if (done.proposals >= 3) return '[proposal rejected] At most three proposals per review.';
      const parsed = readProposalInput(args);
      if ('errors' in parsed) return `[proposal rejected] ${parsed.errors.join('; ')}`;
      const unseen = parsed.proposal.sourceIds.find((sourceId) => !observedSourceIds.has(sourceId));
      if (unseen) return `[proposal rejected] Source ${unseen} was not returned by memory_search.`;
      const source = memory();
      if (!source?.enabled()) return '[proposal rejected] Long-term memory is unavailable for source verification.';
      const envelopeMatches = ctx.callId
        ? core.generationEvidence(ctx.role).filter((envelope) => envelope.sessionId === ctx.role
            && envelope.outputToolCalls.some((output) => output.toolCallId === ctx.callId))
        : [];
      const envelope = envelopeMatches.length === 1 ? envelopeMatches[0] : null;
      if (!envelope || !source.recordGenerationEvidenceEnvelope(envelope, ctx.callId!)) {
        return '[proposal rejected] The proposal generation has no complete joined source evidence.';
      }
      const expectedEpoch = source.evidenceEpoch();
      if (!expectedEpoch) return '[proposal rejected] The source epoch is unavailable.';
      for (const sourceId of parsed.proposal.sourceIds) {
        if (state.cancelled || Date.now() >= state.deadline) return '[review cancelled] No proposal was written.';
        if (!source.sourceVisible(sourceId) || !await source.hasSource(sourceId) || !source.sourceVisible(sourceId)) {
          return `[proposal rejected] Source ${sourceId} is missing or fenced.`;
        }
      }
      if (state.cancelled || Date.now() >= state.deadline || source.evidenceEpoch() !== expectedEpoch) return '[review cancelled] No proposal was written.';
      const result = store.write(args);
      if (!result.ok) return `[proposal rejected] ${result.errors.join('; ')}`;
      const registered = await source.registerDerivedArtifactFromSources({
        artifactId: result.proposal.id,
        kind: 'growth-proposal',
        target: `growth-proposals/${result.proposal.id}.json`,
        content: growthProposalArtifactText(result.proposal),
        origin: 'model-derived',
        reviewState: 'unreviewed',
        creatorOperationId: ctx.callId!,
        creatorSessionId: envelope.sessionId,
        creatorGenerationId: envelope.id,
        sourceIds: [...new Set([...result.proposal.sourceIds, ...envelope.exposedSources.map((entry) => entry.documentId)])],
        expectedEpoch,
      });
      if (!registered) {
        store.remove(result.proposal.id);
        return '[proposal rejected] Source provenance changed before the candidate was committed.';
      }
      done.proposals += 1;
      return `[proposal saved] ${result.proposal.id}`;
    },
  };
}

const PROPOSE_EXPERIENCE_DECL: Omit<ToolDef, 'handler'> = {
  name: PROPOSE_EXPERIENCE_TOOL,
  description: 'Leave one source-linked experience card for the person to review. Use only a repeated, useful pattern supported by user-source records from different times. Set kind=skill only for a repeatable action strategy; a skill candidate stays inactive until a later real task has an actual Action Receipt, the person confirms it was not candidate evidence, and the person approves the candidate. Skills never grant action permission.',
  tags: ['write'],
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short name for the candidate.' },
      situation: { type: 'string', description: 'The recurring situation in which the experience applies.' },
      lesson: { type: 'string', description: 'A short, concrete conversational lesson.' },
      scope: { type: 'string', enum: ['conversation', 'proactive_speech', 'browser_exploration'] },
      kind: { type: 'string', enum: ['policy', 'skill'], description: 'Use skill for a repeatable action strategy that will need a later receipt-backed trial; otherwise use policy.' },
      sourceIds: { type: 'array', items: { type: 'string' }, description: 'One to eight exact source_id values returned by memory_search.' },
    },
    required: ['title', 'situation', 'lesson', 'scope', 'sourceIds'],
  },
};

function proposeExperienceTool(
  store: ExperienceCards,
  state: { cancelled: boolean; deadline: number },
  done: { proposals: number },
  memory: () => HindsightMemory | null,
  observedSourceIds: ReadonlySet<string>,
  core: CoreApi,
): ToolDef {
  return {
    ...PROPOSE_EXPERIENCE_DECL,
    handler: async (args, ctx) => {
      if (state.cancelled || Date.now() >= state.deadline) return '[review cancelled] No experience candidate was written.';
      if (done.proposals >= 3) return '[candidate rejected] At most three candidates per review.';
      const parsed = readExperienceCardInput(args);
      if ('errors' in parsed) return `[candidate rejected] ${parsed.errors.join('; ')}`;
      const unseen = parsed.card.sourceIds.find((sourceId) => !observedSourceIds.has(sourceId));
      if (unseen) return `[candidate rejected] Source ${unseen} was not returned by memory_search.`;
      if (new Set(parsed.card.sourceIds).size < 2) {
        return '[candidate rejected] A recurring experience needs at least two different user-event sources.';
      }
      const source = memory();
      if (!source?.enabled()) return '[candidate rejected] Long-term memory is unavailable for source verification.';
      const envelopeMatches = ctx.callId
        ? core.generationEvidence(ctx.role).filter((envelope) => envelope.sessionId === ctx.role
            && envelope.outputToolCalls.some((output) => output.toolCallId === ctx.callId))
        : [];
      const envelope = envelopeMatches.length === 1 ? envelopeMatches[0] : null;
      if (!envelope || !source.recordGenerationEvidenceEnvelope(envelope, ctx.callId!)) {
        return '[candidate rejected] The experience generation has no complete joined source evidence.';
      }
      const expectedEpoch = source.evidenceEpoch();
      if (!expectedEpoch) return '[candidate rejected] The source epoch is unavailable.';
      const dates = new Set<string>();
      for (const sourceId of parsed.card.sourceIds) {
        if (state.cancelled || Date.now() >= state.deadline) return '[review cancelled] No experience candidate was written.';
        const evidence = await source.sourceEvidence(sourceId);
        if (!evidence.present || !evidence.visible || evidence.actor !== 'user' || evidence.kind !== 'event'
          || (evidence.status !== 'completed' && evidence.status !== 'current') || !source.sourceVisible(sourceId)) {
          return `[candidate rejected] Source ${sourceId} is missing or fenced.`;
        }
        if (!evidence.occurredAt || !Number.isFinite(Date.parse(evidence.occurredAt))) {
          return `[candidate rejected] Source ${sourceId} has no verifiable user-event date.`;
        }
        dates.add(new Date(evidence.occurredAt).toISOString().slice(0, 10));
      }
      if (dates.size < 2) return '[candidate rejected] User-event sources must span different dates.';
      if (state.cancelled || Date.now() >= state.deadline || source.evidenceEpoch() !== expectedEpoch) return '[review cancelled] No experience candidate was written.';
      if (!parsed.card.sourceIds.every((sourceId) => source.sourceVisible(sourceId))) {
        return '[candidate rejected] One or more sources are now fenced.';
      }
      const result = store.propose(args);
      if (!result.ok) return `[candidate rejected] ${result.errors.join('; ')}`;
      const registered = await source.registerDerivedArtifactFromSources({
        artifactId: result.card.id,
        kind: 'experience-card',
        target: `experience-cards/${result.card.id}.json`,
        content: experienceCardArtifactText(result.card),
        origin: 'model-derived',
        reviewState: 'unreviewed',
        creatorOperationId: ctx.callId!,
        creatorSessionId: envelope.sessionId,
        creatorGenerationId: envelope.id,
        sourceIds: [...new Set([...result.card.sourceIds, ...envelope.exposedSources.map((entry) => entry.documentId)])],
        expectedEpoch,
      });
      if (!registered) {
        store.remove(result.card.id);
        return '[candidate rejected] Source provenance changed before the candidate was committed.';
      }
      done.proposals += 1;
      return `[experience candidate saved] ${result.card.id}`;
    },
  };
}

export class GrowthReview {
  constructor(private readonly d: GrowthReviewDeps) {}

  async run(): Promise<GrowthRunResult> {
    const core = this.d.core();
    if (!core) throw new Error('the Persona is not attached to Core');
    if (core.sessionInfo(GROWTH_SESSION).running > 0) throw new Error('a self-review is already running');
    const snapshot = this.d.snapshot();
    const prefix = snapshot.filter((record) => hasRole(record, 'system'));
    if (prefix.length === 0) throw new Error('the main session has no system prefix');
    const memory = this.d.memory();
    const portrait = memory?.enabled() ? await memory.selfPortrait().catch(() => '') : '';
    const now = (this.d.now ?? (() => new Date()))();
    const done = { note: '', proposals: 0 };
    const timeoutMs = this.d.timeoutMs ?? REVIEW_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const state = { cancelled: false, deadline };
    const store = new GrowthProposals(this.d.proposalsDir, this.d.now ?? (() => new Date()));
    const observedSourceIds = new Set<string>();
    const experienceCards = new ExperienceCards(
      this.d.experienceCardsDir ?? join(this.d.proposalsDir, 'experience-cards'),
      this.d.now ?? (() => new Date()),
    );
    const messages = [
      ...prefix,
      message('user', SELF_REVIEW_TEXT[this.d.modelLanguage()]({
        portrait,
        recent: recentConversation(snapshot),
        date: localDate(this.d.timezone(), now),
      })),
    ];
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const forkOptions = {
      id: GROWTH_SESSION,
      messages,
      tools: [
        ...this.d.tools().filter((tool) => tool.name !== 'memory_search').map((tool) => guardRead(tool, state)),
        guardRead(growthMemorySearchTool(() => memory, observedSourceIds), state),
        proposeGrowthTool(store, state, done, () => memory, observedSourceIds, core),
        proposeExperienceTool(experienceCards, state, done, () => memory, observedSourceIds, core),
        finishReviewTool(done),
      ],
      stopWhen: () => {
        if (Date.now() >= deadline) state.cancelled = true;
        return state.cancelled;
      },
      wrapUpHint: 'Wrap up: call finish_review now. If nothing durable changed, say so there and end. Do not edit files.',
    };
    if (!core.spawnForkWithOutcome) throw new Error('Core does not report fork outcomes');
    const fork: Promise<ForkOutcome> = core.spawnForkWithOutcome(forkOptions);
    let cancellationStatus: GrowthRunResult['cancellationStatus'];
    const recordOutcome = (outcome: ForkOutcome): void => {
      if (outcome.status === 'cancelled') {
        state.cancelled = true;
        cancellationStatus = outcome.invalidationStatus;
      } else if (outcome.status === 'shutdown') {
        state.cancelled = true;
        cancellationStatus = 'shutdown';
      }
    };
    fork.then(
      (outcome) => {
        recordOutcome(outcome);
        this.d.log?.info('[growth] review fork exited', {
          ms: Date.now() - started,
          outcome: outcome.status,
          ...(outcome.status === 'cancelled' ? { invalidationStatus: outcome.invalidationStatus } : {}),
          cancelled: state.cancelled,
        });
      },
      (err) => this.d.log?.warn('[growth] review fork ended with an error', { ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) }),
    );
    try {
      const outcome = await Promise.race([
        fork,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            state.cancelled = true;
            reject(new Error('self-review timed out; no Persona writes were made'));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
      recordOutcome(outcome);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.d.log?.info('[growth] self-review finished', {
      note: done.note || null,
      proposals: done.proposals,
      ms: Date.now() - started,
      ...(cancellationStatus ? { cancellationStatus } : {}),
    });
    return {
      proposals: done.proposals,
      note: done.note,
      cancelled: state.cancelled,
      ...(cancellationStatus ? { cancellationStatus } : {}),
    };
  }
}
