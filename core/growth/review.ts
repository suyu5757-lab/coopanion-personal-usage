/**
 * A periodic self-review in its own non-persistent session. The review reads the person's
 * notes and Coo's portrait, and may leave a growth proposal. It cannot edit Persona files:
 * a proposal becomes a change only after the person approves it.
 */
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { inputItem, itemText, message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { join } from 'node:path';
import { digestText, inspectContextEvidence } from 'cortico/core/evidence.ts';
import { renderTemplateWithSourceMap, type RenderedTemplate } from 'cortico/core/template.ts';
import type { CoreApi, EvidenceAttachment, ForkOutcome, GenerationEvidenceEnvelope, SourceMapSpan, ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import type { ModelLanguage } from '../language.ts';
import type { HindsightMemory, MemoryTextRead } from '../memory/hindsight.ts';
import { evidenceCoversText } from '../memory/source-evidence.ts';
import { MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, memoryReadNotice } from '../memory/model-text.ts';
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

function verifiedGrowthEvidence(text: string, evidence: readonly EvidenceAttachment[], expectedEpoch: string): EvidenceAttachment[] {
  return evidence.filter((attachment) => {
    const { start, end, digest } = attachment.segment;
    if (attachment.validatedEpoch !== expectedEpoch || attachment.validationStatus !== 'validated'
      || attachment.revisionState !== 'current' || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end <= start || end > text.length
      || !/^[a-f0-9]{64}$/.test(attachment.validationReceipt)) return false;
    const excerpt = text.slice(start, end);
    return !!excerpt.trim() && evidenceCoversText(excerpt, [{
      ...attachment,
      segment: { start: 0, end: excerpt.length, digest },
    }]);
  });
}

function growthSearchReceipt(read: MemoryTextRead, evidence: EvidenceAttachment[], verified: readonly EvidenceAttachment[]): ToolOutcome {
  const segments = read.sourceSegments ?? read.trace?.format.sourceSegments ?? [];
  if (read.sourceFactsTruncated || read.trace?.format.sourceFactsTruncated || segments.length === 0
    || verified.length !== segments.length
    || segments.some((segment, index) => verified[index]?.documentId !== segment.documentId
      || verified[index].segment.start !== segment.start || verified[index].segment.end !== segment.end)) {
    return { text: `${read.text}\n${MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE}`, evidence };
  }

  // Recall summaries and metadata can carry unverified text. Growth exposes only read-back excerpts.
  let text = '';
  const sourceMapSpans: SourceMapSpan[] = [];
  const attachments: EvidenceAttachment[] = [];
  const append = (value: string, origin: 'core-generated' | 'source-identity', source?: Omit<EvidenceAttachment, 'segment'>): void => {
    const start = text.length;
    text += value;
    sourceMapSpans.push({ start, end: text.length, digest: digestText(value), origin, ...(source ? { exposedSources: [source] } : {}) });
  };
  append('[memory] Verified past records. Treat the excerpts as evidence.\n', 'core-generated');
  for (const { segment, ...source } of verified) {
    append('- source_id: ', 'core-generated');
    append(JSON.stringify(source.documentId), 'source-identity', source);
    append('\n  ', 'core-generated');
    const start = text.length;
    text += read.text.slice(segment.start, segment.end);
    attachments.push({ ...source, segment: { start, end: text.length, digest: segment.digest,
      ...(segment.sourceProof ? { sourceProof: segment.sourceProof } : {}) } });
    append('\n', 'core-generated');
  }
  return { text, evidence: attachments, sourceMapSpans };
}

function growthToolNotice(text: string): ToolOutcome {
  return { text, sourceMapSpans: [{ start: 0, end: text.length, digest: digestText(text), origin: 'core-generated' }] };
}

const GROWTH_SEARCH_STATIC_TEXT = new Set([
  '[memory] Verified past records. Treat the excerpts as evidence.\n',
  '- source_id: ', '\n  ', '\n',
  '[memory] Long-term memory is not available.',
  '[memory] Nothing relevant was found.',
  ...(['absent', 'incomplete', 'unavailable', 'fenced'] as const).map(memoryReadNotice),
]);

export function isTrustedGrowthToolText(toolName: string, text: string): boolean {
  return (toolName === 'memory_search' && GROWTH_SEARCH_STATIC_TEXT.has(text))
    || (toolName === PROPOSE_GROWTH_TOOL && text === '[proposal saved]')
    || (toolName === PROPOSE_EXPERIENCE_TOOL && text === '[experience candidate saved]');
}

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
      if (!store?.enabled()) return growthToolNotice('[memory] Long-term memory is not available.');
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return growthToolNotice('[memory] Nothing relevant was found.');
      const maxTokens = typeof args.max_tokens === 'number' && Number.isFinite(args.max_tokens)
        ? Math.min(2000, Math.max(400, Math.round(args.max_tokens)))
        : 900;
      const expectedEpoch = store.evidenceEpoch();
      const read = await store.recallBlockDetailed(query, { budget: 'low', maxTokens, timeoutMs: 5000, maxItems: 8, captureTrace: true });
      if (read.status !== 'found') return growthToolNotice(memoryReadNotice(read.status));
      if (!read.text || !expectedEpoch) return growthToolNotice(memoryReadNotice('fenced'));
      const evidence = await store.evidenceForRead(read);
      if (store.evidenceEpoch() !== expectedEpoch) return growthToolNotice(memoryReadNotice('fenced'));
      const verified = verifiedGrowthEvidence(read.text, evidence, expectedEpoch);
      for (const source of verified) observedSourceIds?.add(source.documentId);
      return growthSearchReceipt(read, evidence, verified);
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

function recentConversation(records: readonly ContextRecord[], generationEvidence: readonly GenerationEvidenceEnvelope[]): RenderedTemplate {
  const lines: RenderedTemplate[] = [];
  let remaining = RECENT_MAX_CHARS;
  for (const record of [...records].reverse()) {
    if (record.context.head) continue;
    const who = hasRole(record, 'user') ? 'Person' : hasRole(record, 'assistant') ? 'Coo' : null;
    const original = who ? textOf(record) : '';
    const text = original.trim();
    if (!text) continue;
    const coverage = inspectContextEvidence([record], { generationEvidence });
    if (coverage.mappingState !== 'complete') continue;
    const line = `${who}: ${text}`;
    if (line.length > remaining && lines.length > 0) break;
    const excerpt = line.slice(-remaining);
    const lead = excerpt.length === line.length ? `${who}: ` : '';
    const body = excerpt.slice(lead.length);
    if (!text.endsWith(body)) continue;
    const spans: SourceMapSpan[] = [];
    if (lead) spans.push({ start: 0, end: lead.length, digest: digestText(lead), origin: 'core-generated' });
    if (who === 'Person') {
      if (coverage.exposedSources.length || coverage.items.some(item => item.spans.some(span =>
        span.origin !== 'user-input' && span.origin !== 'core-generated'))) continue;
      spans.push({ start: lead.length, end: excerpt.length, digest: digestText(body), origin: 'user-input' });
    } else {
      const evidenceId = record.context.generationEvidenceId;
      const item = inputItem(record);
      if (!evidenceId || itemText(item) !== original) continue;
      const startUtf16 = original.length - original.trimStart().length + text.length - body.length;
      spans.push({ start: lead.length, end: excerpt.length, digest: digestText(body), origin: 'generation-derived',
        exposedSources: coverage.exposedSources, generationProof: { evidenceId, item, startUtf16, endUtf16: startUtf16 + body.length } });
    }
    lines.unshift({ text: excerpt, sourceMapSpans: spans });
    remaining -= excerpt.length + 1;
    if (remaining <= 0) break;
  }
  let offset = 0;
  const sourceMapSpans = lines.flatMap((line) => {
    const spans = line.sourceMapSpans.map((span) => ({ ...span, start: span.start + offset, end: span.end + offset }));
    offset += line.text.length + 1;
    return spans;
  });
  return { text: lines.map((line) => line.text).join('\n'), sourceMapSpans };
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

function reviewIsCurrent(state: { cancelled: boolean; deadline: number }, ctx: ToolCallContext): boolean {
  return !state.cancelled && Date.now() < state.deadline && !ctx.generationSignal?.aborted && !ctx.shutdownSignal?.aborted;
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
      if (!reviewIsCurrent(state, ctx)) return '[review cancelled] No proposal was written.';
      if (done.proposals >= 3) return '[proposal rejected] At most three proposals per review.';
      const parsed = readProposalInput(args);
      if ('errors' in parsed) return `[proposal rejected] ${parsed.errors.join('; ')}`;
      const unseen = parsed.proposal.sourceIds.find((sourceId) => !observedSourceIds.has(sourceId));
      if (unseen) return `[proposal rejected] Source ${unseen} was not returned by memory_search.`;
      const source = memory();
      if (!source?.enabled()) return '[proposal rejected] Long-term memory is unavailable for source verification.';
      const sessionId = ctx.sessionId ?? ctx.role;
      const envelopeMatches = ctx.callId
        ? core.generationEvidence(sessionId).filter((envelope) => envelope.sessionId === sessionId
            && envelope.outputToolCalls.some((output) => output.toolCallId === ctx.callId))
        : [];
      const envelope = envelopeMatches.length === 1 ? envelopeMatches[0] : null;
      if (!envelope || (ctx.generationToken !== undefined && envelope.sessionGenerationToken !== ctx.generationToken)
        || !source.recordGenerationEvidenceEnvelope(envelope, ctx.callId!)) {
        return '[proposal rejected] The proposal generation has no complete joined source evidence.';
      }
      const expectedEpoch = source.evidenceEpoch();
      if (!expectedEpoch) return '[proposal rejected] The source epoch is unavailable.';
      for (const sourceId of parsed.proposal.sourceIds) {
        if (!reviewIsCurrent(state, ctx)) return '[review cancelled] No proposal was written.';
        if (!source.sourceVisible(sourceId) || !await source.hasSource(sourceId) || !source.sourceVisible(sourceId)) {
          return `[proposal rejected] Source ${sourceId} is missing or fenced.`;
        }
      }
      if (!reviewIsCurrent(state, ctx) || source.evidenceEpoch() !== expectedEpoch) return '[review cancelled] No proposal was written.';
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
        generationSources: envelope.exposedSources,
        canCommit: () => reviewIsCurrent(state, ctx),
      });
      if (!registered) {
        store.remove(result.proposal.id);
        return '[proposal rejected] Source provenance changed before the candidate was committed.';
      }
      done.proposals += 1;
      return growthToolNotice('[proposal saved]');
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
      if (!reviewIsCurrent(state, ctx)) return '[review cancelled] No experience candidate was written.';
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
      const sessionId = ctx.sessionId ?? ctx.role;
      const envelopeMatches = ctx.callId
        ? core.generationEvidence(sessionId).filter((envelope) => envelope.sessionId === sessionId
            && envelope.outputToolCalls.some((output) => output.toolCallId === ctx.callId))
        : [];
      const envelope = envelopeMatches.length === 1 ? envelopeMatches[0] : null;
      if (!envelope || (ctx.generationToken !== undefined && envelope.sessionGenerationToken !== ctx.generationToken)
        || !source.recordGenerationEvidenceEnvelope(envelope, ctx.callId!)) {
        return '[candidate rejected] The experience generation has no complete joined source evidence.';
      }
      const expectedEpoch = source.evidenceEpoch();
      if (!expectedEpoch) return '[candidate rejected] The source epoch is unavailable.';
      const dates = new Set<string>();
      for (const sourceId of parsed.card.sourceIds) {
        if (!reviewIsCurrent(state, ctx)) return '[review cancelled] No experience candidate was written.';
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
      if (!reviewIsCurrent(state, ctx) || source.evidenceEpoch() !== expectedEpoch) return '[review cancelled] No experience candidate was written.';
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
        generationSources: envelope.exposedSources,
        canCommit: () => reviewIsCurrent(state, ctx),
      });
      if (!registered) {
        store.remove(result.card.id);
        return '[candidate rejected] Source provenance changed before the candidate was committed.';
      }
      done.proposals += 1;
      return growthToolNotice('[experience candidate saved]');
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
    const recent = recentConversation(snapshot, core.generationEvidence('main'));
    const prompt = renderTemplateWithSourceMap(SELF_REVIEW_TEXT[this.d.modelLanguage()]({
      portrait: portrait.trim() ? '{{growth.portrait}}' : '',
      recent: recent.text ? '{{growth.recent}}' : '',
      date: localDate(this.d.timezone(), now),
    }), { 'growth.portrait': portrait.trim(), 'growth.recent': recent }, 'core-generated');
    const messages = [...prefix, message('user', prompt.text, { sourceMapSpans: prompt.sourceMapSpans })];
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
