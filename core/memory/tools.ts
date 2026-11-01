import type { ToolDef } from 'cortico/core/types.ts';
import type { HindsightMemory } from './hindsight.ts';
import { MEMORY_SEARCH_DESCRIPTION, memoryReadNotice } from './model-text.ts';

export interface MemoryToolDeps {
  memory: () => HindsightMemory | null;
  currentUserSource?: (session: string) => string | null;
  currentReadSource?: (session: string) => string | null;
}

const text = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === 'string' ? (args[key] as string).trim() : '';

export function memoryTools(deps: MemoryToolDeps): ToolDef[] {
  return [
    {
      name: 'memory_search',
      description: MEMORY_SEARCH_DESCRIPTION,
      tags: ['read'],
      barrierAfter: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in natural language.' },
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
          const read = await memory.searchSourceDocuments(text(args, 'query'), { excludeDocumentId });
          return read.text || memoryReadNotice(read.status);
        }
        const maxTokens = typeof args.max_tokens === 'number' && Number.isFinite(args.max_tokens)
          ? Math.min(2000, Math.max(400, Math.round(args.max_tokens)))
          : undefined;
        const read = await memory.recallBlockDetailed(text(args, 'query'), maxTokens ? { maxTokens } : {});
        return read.text || memoryReadNotice(read.status);
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
      handler: async (args, ctx) => {
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
      },
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
      handler: async (args, ctx) => {
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
      },
    },
    {
      name: 'memory_forget',
      description: 'Remove memories matching a query from long-term memory. Use it only when the person asks you to forget something, not to correct a fact. The source is fenced from historical reads immediately; removing it from the service can still be pending. Do not recover the fenced source from workspace files, Handoff notes or Git history. Content already in this active conversation may remain, so do not say it was erased from the session or is gone everywhere. If they say "that thing just now" and the topic is clear from the conversation, use that topic; if it is not clear, ask which one. It cannot be undone.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The fact or topic to forget, in natural language.' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const memory = deps.memory();
        if (!memory?.enabled()) return '[memory] Long-term memory is not available.';
        const result = await memory.forget(text(args, 'query'));
        const total = result.local + result.deleted + result.pending + result.failed;
        if (total === 0) return '[memory] Nothing matching was found to forget.';
        return `[forget status] local cancellations: ${result.local}; remote deletions: ${result.deleted}; pending: ${result.pending}; failed: ${result.failed}. The active conversation may still contain this source. Do not recover it from workspace files, Handoff notes or Git history.`;
      },
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
        return answer.text || memoryReadNotice(answer.status);
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
