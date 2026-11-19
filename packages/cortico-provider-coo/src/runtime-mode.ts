/**
 * RuntimeModePolicy: a small, opt-in request policy for one provider endpoint.
 *
 * It changes only the model's reasoning effort for a turn. It never adds or removes tools,
 * never changes the model, the input, the memory context, SourceProof, ActionGate or any
 * permission. Disabled (the default) the request goes through byte-for-byte unchanged.
 *
 * The first version reads only what the provider request itself exposes: the latest user text
 * and whether tools are available. Core's task/handoff state is not copied into a second
 * routing engine here; a turn with tools is ACTION, a turn that asks for analysis is REASON,
 * and ordinary conversation is CHAT_FAST.
 */
import { BaseProvider } from 'cortico/providers/base.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import type { GenerateOptions, Generation } from 'cortico/core/generation.ts';
import { toolSchemaDigest } from 'cortico/core/evidence.ts';

export type RuntimeModeName = 'chat-fast' | 'reason' | 'action';
export type RuntimeModeChoice = 'auto' | 'chat-fast' | 'reason' | 'max';
export type RuntimeEffort = 'off' | 'low' | 'high' | 'max';

export interface RuntimeModeSetting {
  enabled: boolean;
  mode: RuntimeModeChoice;
}

export interface RuntimeModeDecision {
  mode: RuntimeModeName;
  effort: RuntimeEffort;
  reason: string;
}

/** One tier map: the provider's own strings, with null where the model has no such tier. */
export type RuntimeEfforts = Partial<Record<RuntimeEffort, string | null>> | undefined;

const CHOICES: readonly RuntimeModeChoice[] = ['auto', 'chat-fast', 'reason', 'max'];

/** Reads the endpoint's `options.runtimeMode`; anything incomplete leaves the policy off. */
export function runtimeModeSetting(options: unknown): RuntimeModeSetting | null {
  if (!options || typeof options !== 'object') return null;
  const raw = (options as { runtimeMode?: unknown }).runtimeMode;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { enabled?: unknown; mode?: unknown };
  if (value.enabled !== true) return null;
  const mode = typeof value.mode === 'string' && (CHOICES as readonly string[]).includes(value.mode)
    ? value.mode as RuntimeModeChoice
    : 'auto';
  return { enabled: true, mode };
}

/** The current user turn. Core delivers a typed message inside the event-frame tool output. */
export function latestUserText(request: Request): string {
  const input = Array.isArray(request.input) ? request.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as { type?: string; role?: string; content?: unknown; output?: unknown };
    if (item?.type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : '';
      const typed = /\[typed\][^\n]*?[:：]([\s\S]*)$/u.exec(output);
      if (!typed) continue;
      // Only the Host's event-frame tool may introduce a typed user turn. A workspace file or
      // an untrusted World cannot forge `[typed]` and steer the runtime policy.
      const callId = (item as { call_id?: string }).call_id;
      const call = input.slice(0, index).reverse().find((candidate) => {
        const row = candidate as { type?: string; call_id?: string; name?: string };
        return row?.type === 'function_call' && row.call_id === callId && row.name === 'external_event_frame';
      });
      if (call) return typed[1]!.trim();
      continue;
    }
    if (item?.type !== 'message' || item.role !== 'user') continue;
    const content = item.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => {
      if (typeof part === 'string') return part;
      const text = (part as { text?: unknown })?.text;
      return typeof text === 'string' ? text : '';
    }).join(' ');
  }
  return '';
}

const REASON = /分析|推理|为什么|原因|比较|对比|权衡|取舍|评估|决策|计划|设计|方案|跨来源|矛盾|深入|仔细|总结|判断/u;
const DEEP = /深入|彻底|最大|穷尽|仔细分析|完整分析/u;
const ACTION_COMPLEX = /失败|出错|异常|恢复|重试|多步|复杂|长流程/u;
/** A provider request almost always carries the tool list; the user's wording is the signal. */
const ACTION_INTENT = /打开|点击|读取|写入|列出|搜索|查找|查看|检查|查一下|看看|发布|发送|操作|浏览器|文件|桌面|终端|运行|执行|下载|上传|登录|截图|打字|滚动|安装|删除/u;
/** Recovery wording is ACTION only when it names a tool/task/failure context. */
const ACTION_RECOVERY = /(?:工具|任务|失败|出错|中断|流程|操作).{0,8}(?:恢复|重试)|(?:恢复|重试).{0,8}(?:工具|任务|失败|出错|中断|流程|操作)/u;

/**
 * Deterministic routing. Tools are offered on nearly every request, so their presence alone is
 * not ACTION; an action verb in the user's own words is. A manual choice may raise or lower
 * effort, but an explicit action turn stays ACTION.
 */
export function selectRuntimeMode(
  text: string,
  toolCount: number,
  choice: RuntimeModeChoice = 'auto',
): RuntimeModeDecision {
  const asksForAction = ACTION_INTENT.test(text) || ACTION_RECOVERY.test(text);
  if (choice === 'chat-fast') {
    return asksForAction
      ? { mode: 'action', effort: 'low', reason: 'manual-fast + action wording -> action/low' }
      : { mode: 'chat-fast', effort: 'off', reason: 'manual fast' };
  }
  if (choice === 'reason') return asksForAction
    ? { mode: 'action', effort: 'high', reason: 'manual reason/high + action identity' }
    : { mode: 'reason', effort: 'high', reason: 'manual reason/high' };
  if (choice === 'max') return asksForAction
    ? { mode: 'action', effort: 'max', reason: 'manual reason/max + action identity' }
    : { mode: 'reason', effort: 'max', reason: 'manual reason/max' };

  if (asksForAction) {
    const effort: RuntimeEffort = ACTION_COMPLEX.test(text) || toolCount > 6 || text.length > 160 ? 'high' : 'low';
    return { mode: 'action', effort, reason: `action wording${effort === 'high' ? ' + complex hint' : ' + simple'}` };
  }
  if (REASON.test(text)) {
    return DEEP.test(text)
      ? { mode: 'reason', effort: 'max', reason: 'deep-analysis wording' }
      : { mode: 'reason', effort: 'high', reason: 'analysis wording' };
  }
  return { mode: 'chat-fast', effort: 'off', reason: 'ordinary conversation' };
}

/**
 * Applies one decision to a request. The only field replaced is `reasoning`; everything else is
 * the same object shape Core sent. A model without an `off` tier (DeepSeek V4.1 reports low/high/
 * max) gets its lowest tier instead, and the decision reason records that fallback.
 */
export function applyRuntimeMode(
  request: Request,
  setting: RuntimeModeSetting | null,
  efforts: RuntimeEfforts,
  choiceOverride?: RuntimeModeChoice,
): { request: Request; decision: RuntimeModeDecision | null; appliedEffort: string | null } {
  if (!setting) return { request, decision: null, appliedEffort: null };
  const choice = choiceOverride ?? setting.mode;
  const decision = selectRuntimeMode(latestUserText(request), request.tools?.length ?? 0, choice);
  const map = efforts ?? {};
  const wanted = map[decision.effort] ?? null;
  const lowest = map.low ?? map.off ?? null;
  const offSupported = map.off !== undefined && map.off !== null;
  let applied = wanted;
  let effective = decision;
  if (decision.effort === 'off' && !offSupported) {
    applied = lowest;
    effective = { ...decision, effort: lowest && lowest !== 'none' ? 'low' : 'off', reason: `${decision.reason}; model has no off tier -> lowest supported` };
  }
  if (!applied) return { request, decision: effective, appliedEffort: null };
  return {
    request: { ...request, reasoning: { effort: applied as never } },
    decision: effective,
    appliedEffort: applied,
  };
}

/** A thin provider wrapper: it delegates everything except the reasoning field. */
export class RuntimeModeClient extends BaseProvider {
  constructor(
    private readonly inner: BaseProvider,
    private readonly setting: RuntimeModeSetting,
    private readonly efforts: (model: string) => RuntimeEfforts,
    private readonly configuredModel: () => string,
  ) {
    super();
  }

  async respond(request: Request, options?: GenerateOptions): Promise<Generation> {
    const model = request.model ?? this.configuredModel();
    const applied = applyRuntimeMode(request, this.setting, this.efforts(model));
    if (process.env.COOPANION_RUNTIME_MODE_LOG === '1') {
      // Counts only: mode, effort, tool count and the user text length. No prompt or memory text.
      process.stderr.write(`[runtime-mode] mode=${applied.decision?.mode ?? 'off'} effort=${applied.appliedEffort ?? 'unchanged'} tools=${request.tools?.length ?? 0} chars=${latestUserText(request).length}\n`);
      process.stderr.write(`[tool-list] ${(request.tools ?? []).map((tool) => `${tool.name}:${toolSchemaDigest(tool as never) ?? 'null'}`).join(',')}\n`);
    }
    return this.inner.respond(applied.request, options);
  }
}
