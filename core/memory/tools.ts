import { createHash } from 'node:crypto';
import type { ToolDef, ToolOutcome, SourceMapSpan } from 'cortico/core/types.ts';
import type { HindsightMemory, MemoryTextRead } from './hindsight.ts';
import { evidenceCoversSegments } from './source-evidence.ts';
import { MEMORY_SEARCH_DESCRIPTION, MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, MEMORY_SOURCE_OMITTED_NOTICE, WORKSPACE_HISTORY_EVIDENCE_DESCRIPTION, isTrustedMemorySearchNotice, isTrustedMemoryWriteReceipt, memoryReadNotice } from './model-text.ts';
import { functionResult } from 'cortico/protocol/open-responses/context.ts';
import { digestText, inspectRequestEvidence, verifyToolTextOrigins } from 'cortico/core/evidence.ts';

export interface MemoryToolDeps {
  memory: () => HindsightMemory | null;
  currentUserSource?: (session: string) => string | null;
  currentReadSource?: (session: string) => string | null;
  sourceSafeToolResults?: boolean;
}

function evidenceComplete(
  read: { text: string; dateFocused?: boolean; trace?: { format: { sourceSegments: Array<{ documentId: string; start: number; end: number }> } }; sourceSegments?: Array<{ documentId: string; start: number; end: number }> },
  evidence: ToolOutcome['evidence'],
  requireFullTextCoverage: boolean,
): boolean {
  if (!read.text) return true;
  const segments = read.sourceSegments ?? read.trace?.format.sourceSegments ?? [];
  if (segments.length === 0 || evidence?.length !== segments.length
    || evidence.some((attachment) => attachment.validationStatus !== 'validated' || attachment.revisionState !== 'current')) return false;
  if (!requireFullTextCoverage) return true;
  // Source bodies are verified one by one. Core's fixed formatting (the `[memory]` header,
  // result labels and the incomplete-facts notice) is not historical content and carries no
  // source span, so it must not make an otherwise complete source body fail the gate.
  return evidenceCoversSegments(read.text, segments, evidence);
}

/** A fixed notice the tool wrote itself: it carries no source text and its span is verified as core-generated. */
function fixedOutcome(text: string, failed = false): ToolOutcome {
  return {
    text,
    ...(failed ? { failed: true } : {}),
    sourceMapSpans: [{ start: 0, end: text.length, digest: createHash('sha256').update(text).digest('hex'), origin: 'core-generated' }],
  };
}

/**
 * Compose a source view from only the attachments selected. Every character of an excerpt is
 * bound to its own evidence attachment; source IDs are separate source-identity spans. The view
 * is then checked by the same Core inspector the next Provider request uses. If the full view
 * does not map, the caller retries source by source and keeps only the sources that do.
 */
function composeSourceView(output: string, evidence: ToolOutcome['evidence'], selected: NonNullable<ToolOutcome['evidence']>): ToolOutcome | null {
  let text = '';
  const attachments: NonNullable<ToolOutcome['evidence']> = [];
  const sourceMapSpans: SourceMapSpan[] = [];
  for (const attachment of selected) {
    const segment = attachment.segment;
    if (!evidence?.length) return null;
    const same = evidence.some((candidate) => candidate.documentId === attachment.documentId
      && candidate.segment.start === segment.start && candidate.segment.end === segment.end
      && candidate.segment.digest === segment.digest);
    if (!same) continue;
    if (attachment.validationStatus !== 'validated' || attachment.revisionState !== 'current'
      || !segment.sourceProof || !Number.isInteger(segment.start) || !Number.isInteger(segment.end)
      || segment.start < 0 || segment.end <= segment.start || segment.end > output.length) continue;
    const excerpt = output.slice(segment.start, segment.end);
    if (createHash('sha256').update(excerpt).digest('hex') !== segment.digest) continue;
    const { segment: _segment, ...source } = attachment;
    const id = JSON.stringify(source.documentId);
    const piece = `${text ? '\n' : ''}${id}\n${excerpt}`;
    if (text && text.length + piece.length > 6000) continue;
    if (text) text += '\n';
    const idStart = text.length;
    text += id;
    sourceMapSpans.push({ start: idStart, end: text.length, digest: createHash('sha256').update(id).digest('hex'),
      origin: 'source-identity', exposedSources: [source] });
    text += '\n';
    const start = text.length;
    text += excerpt;
    attachments.push({ ...attachment, segment: { ...segment, start, end: text.length } });
  }
  if (!text || attachments.length === 0) return null;
  return { text, evidence: attachments, sourceMapSpans };
}

/** The same Core inspector a next Provider request would use, without generation/tool digests. */
function viewMaps(view: ToolOutcome): boolean {
  const spans = verifyToolTextOrigins('memory_search', view.text, view.sourceMapSpans, isTrustedMemorySearchNotice);
  const record = functionResult('call_readback', view.text, {
    evidence: view.evidence, sourceMapSpans: spans, toolCallId: 'call_readback',
  });
  const request = { model: 'readback', input: [record.item] } as never;
  return inspectRequestEvidence(request, [record], request as never).mappingState === 'complete';
}

function safeSearchResult(read: MemoryTextRead, output: string, evidence: ToolOutcome['evidence']): ToolOutcome {
  const format = read.trace?.format;
  if (read.status !== 'found' || read.sourceFactsTruncated || read.rejectedSourceDocumentIds?.length
    || format?.sourceFactsTruncated
    || format?.incompleteResultIds.length || format?.omittedSourceDocumentIds.length || format?.clippedResultIds.length
    || format?.clippedContextResultIds.length || format?.clippedSourceFactIds.length) {
    return fixedOutcome(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, true);
  }
  const total = evidence?.length ?? 0;
  const withOmitted = (view: ToolOutcome): ToolOutcome => {
    if (view.evidence?.length === total) return view;
    const line = MEMORY_SOURCE_OMITTED_NOTICE;
    const start = view.text.length + 1;
    return {
      ...view,
      text: `${view.text}\n${line}`,
      sourceMapSpans: [...(view.sourceMapSpans ?? []),
        { start, end: view.text.length + line.length + 1, digest: digestText(line), origin: 'core-generated' }],
    };
  };
  const all = composeSourceView(output, evidence, evidence ?? []);
  if (all && viewMaps(withOmitted(all))) return withOmitted(all);
  const kept: NonNullable<ToolOutcome['evidence']> = [];
  for (const attachment of evidence ?? []) {
    const single = composeSourceView(output, evidence, [attachment]);
    if (single && viewMaps(single)) kept.push(attachment);
  }
  if (kept.length === 0) return fixedOutcome(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, true);
  const filtered = composeSourceView(output, evidence, kept);
  if (!filtered) return fixedOutcome(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, true);
  const final = withOmitted(filtered);
  return viewMaps(final) ? final : fixedOutcome(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE, true);
}

function withIncompleteEvidence(text: string): string {
  return text.includes(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE)
    ? text
    : [text, MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE].filter(Boolean).join('\n');
}

/**
 * Runs a memory write tool and marks its own receipt as core-generated. The Persona's
 * `toolTextTrust` re-checks the exact receipt shape, so a World or model cannot self-sign.
 */
function writeReceipt(name: string, run: ToolDef['handler']): ToolDef['handler'] {
  return async (args, ctx) => {
    const outcome = await run(args, ctx);
    if (typeof outcome !== 'string' || !isTrustedMemoryWriteReceipt(name, outcome)) return outcome;
    return fixedOutcome(outcome);
  };
}

const text = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === 'string' ? (args[key] as string).trim() : '';

/**
 * The model often sends a whole phrase to a literal source scan. Split it into short
 * verbatim candidates (2-4 CJK characters) and try them in order; the gate still accepts
 * only a validated original source, so this changes recall, not trust.
 */
export function literalSourceQueries(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const cjk = /[\u3400-\u9fff]/u;
  const tokens = trimmed.split(/[\s,，。.!！?？、;；:：/\\|()（）\[\]【】"'“”‘’]+/u).filter(Boolean);
  const short = tokens.filter((token) => { const n = [...token].length; return n >= 2 && n <= 4 && cjk.test(token); });
  const long = tokens.filter((token) => [...token].length > 4);
  const windows: string[] = [];
  for (const token of long) {
    const chars = [...token];
    for (const size of [4, 3, 2]) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        const value = chars.slice(index, index + size).join('');
        if (cjk.test(value)) windows.push(value);
      }
    }
  }
  const all = [...short, ...windows, ...[...trimmed].slice(-2).join('')]
    .filter((value) => { const n = [...value].length; return n >= 2 && n <= 4 && cjk.test(value); });
  const unique = [...new Set(all)];
  // Prefer the phrase that appears latest in the user's sentence (the specific request),
  // then a longer phrase over a generic topic word.
  unique.sort((a, b) => (trimmed.lastIndexOf(b) - trimmed.lastIndexOf(a)) || ([...b].length - [...a].length));
  return unique.slice(0, 16);
}


export function memoryTools(deps: MemoryToolDeps): ToolDef[] {
  return [
    {
      name: 'memory_search',
      description: `${deps.sourceSafeToolResults ? MEMORY_SEARCH_DESCRIPTION.replace('Returns dated memories;',
        'Returns verified original source excerpts, each preceded by its quoted source ID;') : MEMORY_SEARCH_DESCRIPTION} ${WORKSPACE_HISTORY_EVIDENCE_DESCRIPTION}`,
      tags: ['read'],
      barrierAfter: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'For semantic recall, what to look for in natural language. With sources=true, one short literal phrase expected verbatim in the original text.' },
          max_tokens: { type: 'integer', description: 'How much memory text to bring back; 400–2000, default 900.' },
          sources: { type: 'boolean', description: 'Use a short literal phrase to search original retained text when semantic recall lacks a needed detail. Returns bounded source excerpts.' },
        },
        required: ['query'],
      },
      handler: async (args, ctx) => {
        const memory = deps.memory();
        if (!memory?.enabled()) return '[memory] Long-term memory is not available.';
        if (args.sources === true) {
          const excludeDocumentId = deps.currentReadSource?.(ctx.role) ?? deps.currentUserSource?.(ctx.role) ?? undefined;
          const rawQuery = text(args, 'query');
          let read = await memory.searchSourceDocuments(rawQuery, { excludeDocumentId });
          if (!read.text || read.status !== 'found') {
            for (const candidate of literalSourceQueries(rawQuery)) {
              const next = await memory.searchSourceDocuments(candidate, { excludeDocumentId });
              if (next.text && next.status === 'found') { read = next; break; }
            }
          }
          if (!read.text) {
            const notice = memoryReadNotice(read.status);
            return isTrustedMemorySearchNotice('memory_search', notice) ? fixedOutcome(notice) : notice;
          }
          const evidence = await memory.evidenceForRead(read);
          const output = evidenceComplete(read, evidence, false) ? read.text : withIncompleteEvidence(read.text);
          if (deps.sourceSafeToolResults) return safeSearchResult(read, output, evidence);
          return evidence.length ? { text: output, evidence } satisfies ToolOutcome : output;
        }
        const maxTokens = typeof args.max_tokens === 'number' && Number.isFinite(args.max_tokens)
          ? Math.min(2000, Math.max(400, Math.round(args.max_tokens)))
          : undefined;
        const read = await memory.recallBlockDetailed(text(args, 'query'), { ...(maxTokens ? { maxTokens } : {}), captureTrace: true });
        const result = read.text || memoryReadNotice(read.status);
        const notice = read.sourceFactsTruncated && read.status === 'found' && !result.includes(MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE)
          ? MEMORY_SOURCE_EVIDENCE_INCOMPLETE_NOTICE
          : '';
        let output = [result, notice].filter(Boolean).join('\n');
        if (!read.text) {
          return isTrustedMemorySearchNotice('memory_search', output) ? fixedOutcome(output) : output;
        }
        const evidence = await memory.evidenceForRead(read);
        if (!evidenceComplete(read, evidence, true)) output = withIncompleteEvidence(output);
        if (deps.sourceSafeToolResults) return safeSearchResult(read, output, evidence);
        return evidence.length ? { text: output, evidence } satisfies ToolOutcome : output;
      },
    },
    {
      name: 'memory_remember',
      description: 'Store a durable fact only when the person asks for it. If the current user message already has a source record, promote that event instead of creating a second memory. For a correction, use memory_correct with exact source_id values returned by memory_search. Do not use it for small talk.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to keep, stated plainly and in the third person about the person or your shared life.' },
        },
        required: ['text'],
      },
      handler: writeReceipt('memory_remember', async (args, ctx) => {
        const memory = deps.memory();
        if (!memory?.enabled()) return '[memory] Long-term memory is not available.';
        const body = text(args, 'text');
        if (!body) return '[memory] Nothing was stored: the fact was empty.';
        const sourceDocumentId = deps.currentUserSource?.(ctx.role) ?? undefined;
        const result = memory.remember(body, { session: ctx.role, ...(sourceDocumentId ? { sourceDocumentId } : {}) });
        if (result === 'sensitive') return '[memory] Nothing was stored: that looks like a secret or a password.';
        if (result === 'empty') return '[memory] Nothing was stored: the fact was empty.';
        if (result === 'disabled') return '[memory] Long-term memory is not available.';
        if (result === 'forgotten') return '[memory] Nothing was stored: that source was forgotten and is not kept again.';
        if (result === 'persistence-error') return '[memory] Nothing was stored: the memory queue could not be written to disk. Tell the person it was not saved.';
        if (result === 'full') return '[memory] Nothing was stored: the memory queue is full. Tell the person it was not saved.';
        if (result === 'source-missing') return '[memory] Nothing was stored: the current user event could not be found in the local memory queue.';
        if (result === 'needs-attention') return '[memory] The current user event is retained locally but needs attention before it can be delivered.';
        if (sourceDocumentId && result === 'queued') return '[remembered] The current user event was promoted in the local queue; the service has not confirmed it yet.';
        if (result === 'submitted') return '[remembered] The current user event was already submitted; the operation is still being checked.';
        if (result === 'unverified') return '[remembered] The current user event completed remotely; source read-back is still pending.';
        if (result === 'verified') return '[remembered] The current user event is verified; no second memory was created.';
        return `[remembered] ${body} (saved locally; the service has not confirmed it yet)`;
      }),
    },
    {
      name: 'memory_correct',
      description: 'Record an explicit correction on the current user event and link it to the cited earlier source records. Keep earlier records for questions about history. First use memory_search to identify exact source_id values. Do not use this for an uncertain conflict or to remove a fact.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The corrected fact, stated plainly in the third person about the person or your shared life.' },
          source_ids: { type: 'array', items: { type: 'string' }, description: 'One to eight exact source_id values returned by memory_search.' },
        },
        required: ['text', 'source_ids'],
      },
      handler: writeReceipt('memory_correct', async (args, ctx) => {
        const memory = deps.memory();
        if (!memory?.enabled()) return '[memory] Long-term memory is not available.';
        const body = text(args, 'text');
        const sourceIds = Array.isArray(args.source_ids)
          ? args.source_ids.filter((id): id is string => typeof id === 'string')
          : [];
        const sourceDocumentId = deps.currentUserSource?.(ctx.role) ?? undefined;
        const result = await memory.correct(body, sourceIds, { session: ctx.role, ...(sourceDocumentId ? { sourceDocumentId } : {}) });
        if (result === 'sensitive') return '[memory] Nothing was stored: that looks like a secret or a password.';
        if (result === 'empty') return '[memory] Nothing was stored: the corrected fact was empty.';
        if (result === 'disabled') return '[memory] Long-term memory is not available.';
        if (result === 'persistence-error') return '[memory] Nothing was stored: the correction could not be written to the local memory queue.';
        if (result === 'full') return '[memory] Nothing was stored: the memory queue is full.';
        if (result === 'forgotten') return '[memory] Nothing was stored: a cited source was already forgotten.';
        if (result === 'source-missing') return '[memory] Nothing was stored: a cited source or the current user event could not be found.';
        if (result === 'source-unavailable') return '[memory] Nothing was stored: the cited source could not be verified.';
        if (result === 'submitted') return '[correction submitted] The existing user event is linked to the cited source; its remote operation is still running.';
        if (result === 'unverified') return '[correction pending verification] The existing user event completed remotely; source read-back is still pending.';
        if (result === 'verified') return '[correction verified] The existing user event is linked to the cited source; no duplicate memory was created.';
        if (sourceDocumentId && result === 'queued') return '[correction queued] The current user event was linked to the cited source; its source document is not verified yet.';
        return `[correction queued] ${body} (saved locally; the service has not confirmed it yet)`;
      }),
    },
    {
      name: 'memory_forget',
      description: 'Remove memories matching a query from long-term memory. Use it only when the person asks you to forget something, not to correct a fact. Report the acceptance state from the result: accepted means a durable intent or fence exists; not-accepted means no request was accepted and the person must retry; unknown-blocked means Memory remains blocked and recovery is unresolved. A remote deletion can remain pending or retrying after acceptance. Do not recover the fenced source from workspace files, Handoff notes or Git history. Content already in this active conversation may remain, so do not say it was erased from the session or is gone everywhere. If they say "that thing just now" and the topic is clear from the conversation, use that topic; if it is not clear, ask which one. It cannot be undone.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The fact or topic to forget, in natural language.' },
        },
        required: ['query'],
      },
      handler: writeReceipt('memory_forget', async (args) => {
        const memory = deps.memory();
        if (!memory || (!memory.enabled() && !memory.forgetRecoveryBlocked())) return '[memory] Long-term memory is not available.';
        const result = await memory.forget(text(args, 'query'));
        const total = result.local + result.deleted + result.pending + result.failed;
        if (result.acceptance === 'not-found' || (total === 0 && !result.acceptance)) return '[forget not found] Nothing matching was found to forget.';
        if (result.acceptance === 'not-accepted') return `[forget not accepted] No durable Forget record was committed; retry is required. Failed: ${result.failed}.`;
        if (result.acceptance === 'unknown-blocked') return `[forget recovery blocked] Forget acceptance could not be confirmed. Memory remains blocked; do not claim completion. Failed: ${result.failed}.`;
        const state = result.acceptance === 'partial' ? 'partially accepted' : 'accepted';
        return `[forget ${state}] local cancellations: ${result.local}; remote deletions acknowledged: ${result.deleted}; pending or retrying: ${result.pending}; retryable failures: ${result.failed}. The active conversation may still contain this source. Do not recover it from workspace files, Handoff notes or Git history.`;
      }),
    },
    {
      name: 'memory_reflect',
      description: 'Reason over your long-term memory to answer a question about the person, your shared history or your relationship. This is slow; use it when the person explicitly asks what you remember or why something matters, or when a self-review needs the actual events, not for ordinary replies.',
      tags: ['read'],
      barrierAfter: true,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to reason about, in natural language.' },
        },
        required: ['question'],
      },
      handler: async (args) => {
        const memory = deps.memory();
        if (!memory?.enabled()) return '[memory] Long-term memory is not available.';
        const answer = await memory.reflectDetailed(text(args, 'question'));
        const result = answer.text || memoryReadNotice(answer.status);
        return answer.status === 'found' && answer.text ? withIncompleteEvidence(result) : result;
      },
    },
  ];
}

export const MEMORY_TOOL_SUMMARIES = {
  memory_search: { zh: '在长期记忆里查找事实、偏好和共同经历。', en: 'Searches long-term memory for facts, preferences and shared history.' },
  memory_remember: { zh: '把一件值得长期记住的事写进长期记忆。', en: 'Stores a durable fact in long-term memory.' },
  memory_correct: { zh: '更正长期记忆中的一项事实，并保留历史版本。', en: 'Records a correction linked to the earlier source while keeping its history.' },
  memory_forget: { zh: '按查询找到并删除长期记忆里的来源文档。', en: 'Finds and deletes source documents in long-term memory.' },
  memory_reflect: { zh: '在长期记忆上推理,回答关于你或你们关系的问题。', en: 'Reasons over long-term memory to answer questions about the person or the relationship.' },
} as const;

export function memoryToolDescribes(deps: MemoryToolDeps) {
  return memoryTools(deps).map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: MEMORY_TOOL_SUMMARIES[name as keyof typeof MEMORY_TOOL_SUMMARIES],
  }));
}
