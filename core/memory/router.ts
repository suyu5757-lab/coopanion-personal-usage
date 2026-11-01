import { DEFAULT_RECALL_TIMEOUT_MS, MAX_DEEP_RECALL_TIMEOUT_MS, DEFAULT_SOURCE_FACTS_TOKEN_BUDGET, sourceFactsTokenBudget, recallContextCharBudget } from './recall-limits.ts';

/**
 * How much long-term memory a turn needs. Fast does no Hindsight I/O; deep is for questions
 * whose answer depends on a dated or corrected past fact. The decision is about the question,
 * not about whether it contains a word such as "remember".
 */
export type RecallRoute = 'fast' | 'standard' | 'deep';

export interface RecallPlan {
  route: RecallRoute;
  budget: 'low' | 'mid' | 'high';
  maxTokens: number;
  timeoutMs: number;
  maxChars: number;
  maxSourceFactsTokens: number;
}

const PLANS: Record<RecallRoute, Omit<RecallPlan, 'route'>> = {
  fast: { budget: 'low', maxTokens: 300, timeoutMs: 0, maxChars: 0, maxSourceFactsTokens: 0 },
  standard: { budget: 'low', maxTokens: 600, timeoutMs: DEFAULT_RECALL_TIMEOUT_MS, maxChars: 2600, maxSourceFactsTokens: DEFAULT_SOURCE_FACTS_TOKEN_BUDGET },
  deep: { budget: 'mid', maxTokens: 1200, timeoutMs: 1600, maxChars: 5600, maxSourceFactsTokens: DEFAULT_SOURCE_FACTS_TOKEN_BUDGET },
};

const GREETING = /^(?:(?:hi|hello|hey|yo|good morning|good night|thanks|thank you|ok|okay|haha|lol|good)|(?:你好|嗨|哈喽|早|早安|午安|晚安|谢谢|谢啦|在吗|在不在|辛苦了|哈哈|嗯|哦|好呀|可爱|摸摸|抱抱))[!！。.~～\s]*$/iu;

/** A short statement of something new needs no lookup; the session portrait is already in context. */
const NEW_STATEMENT = /^[^?？]{1,40}$/u;
/** Questions about the person themselves still look at the portrait and memories. */
const SELF_QUESTION = /(?:我最喜欢|我喜欢什么|我适合|我的名字|我叫什么|我是谁|我的生日|我住在|我来自|你了解我|关于我|what do i like|what is my name|who am i|when is my birthday|what do you know about me|what am i like)/iu;
const QUESTION_WORD_ZH = /(?:什么|哪|谁|为什么|怎么|多少|几|吗|呢|是否)/u;

/** A request to forget should not first pull the forgotten topic back into the turn. */
const FORGET = /(?:不要记(?!错|反|混|漏)|别记(?!错|反|混|漏)|不用记(?!错|反|混|漏)|忘记(?:这|那|刚才|刚刚|这件|那件)|忘了(?:这|那|刚才|刚刚|这件|那件)|把(?:这|那|它|这件事|那件事).{0,6}忘(?:掉|了)|删掉|删除|别提|别再提|当作没发生|\bforget (?:that|this|it|what|about|the|everything)\b|\b(?:don't|do not) remember\b|\bnever mind\b)/iu;
/** The narrower form used before retaining a message: a file deletion or "I forgot my keys" is not a memory request. */
const MEMORY_FORGET = /(?:不要记(?!错|反|混|漏)|别记(?!错|反|混|漏)|不用记(?!错|反|混|漏)|忘记(?:这|那|刚才|刚刚|这件|那件)|忘了(?:这|那|刚才|刚刚|这件|那件)|把(?:这|那|它|这件事|那件事).{0,6}忘(?:掉|了)|当作没发生|别提|别再提|\bforget (?:that|this|it|what|about|the|everything)\b|\b(?:don't|do not) remember\b|\bnever mind\b)/iu;
const DEEP_ZH = /(?:记得|记不记得|还记得|上次|上回|之前|以前|从前|去年|前年|那年|那天|当时|那时候|第一次|最后一次|我们说好|答应|承诺|原来|改主意|取消|不去了|什么时候|哪天|几月|多久|后来|现在呢|其实不是|我说错|更正|你应该知道|你忘了)/u;
const PAST_TIME_ZH = /(?:昨天|前天|上周|上个月|刚才|刚刚|那次|那天)/u;
const PAST_QUESTION_ZH = /(?:什么|哪|谁|吗|呢|多久|多少)/u;
const PAST_TIME_EN = /\b(?:yesterday|last week|last month|earlier|the other day)\b/i;
const PAST_QUESTION_EN = /\b(?:what|which|who|when|how)\b/i;
const DEEP_EN = /\b(?:remember|last time|the other day|back then|years? ago|months? ago|we talked|you said|promised|used to|changed my mind|when did|what day|which month|how long|no longer|actually|you should know)\b/i;

export function isForgetRequest(text: string): boolean {
  return FORGET.test(text);
}

export function isMemoryForgetRequest(text: string): boolean {
  return MEMORY_FORGET.test(text);
}

export interface RecallLimits {
  /** The person's `hindsight.recall.timeoutMs`, used as the standard-turn budget. */
  timeoutMs?: number;
  /** The person's `hindsight.recall.maxTokens`, used as the standard-turn budget. */
  maxTokens?: number;
  maxSourceFactsTokens?: number;
  budget?: 'low' | 'mid' | 'high';
}

const BUDGET_ORDER = { low: 0, mid: 1, high: 2 } as const;

export function planRecall(text: string, limits: RecallLimits = {}): RecallPlan {
  const query = text.trim();
  const route: RecallRoute = !query || isForgetRequest(query)
    ? 'fast'
    : GREETING.test(query) && query.length <= 40
      ? 'fast'
      : DEEP_ZH.test(query) || DEEP_EN.test(query)
        || (PAST_TIME_ZH.test(query) && PAST_QUESTION_ZH.test(query))
        || (PAST_TIME_EN.test(query) && PAST_QUESTION_EN.test(query))
        ? 'deep'
        : NEW_STATEMENT.test(query) && !SELF_QUESTION.test(query) && !QUESTION_WORD_ZH.test(query)
          ? 'fast'
          : 'standard';
  const plan = { route, ...PLANS[route] };
  if (route === 'fast') return plan;
  const baseTimeout = limits.timeoutMs ?? PLANS.standard.timeoutMs;
  const baseTokens = limits.maxTokens ?? PLANS.standard.maxTokens;
  const baseBudget = limits.budget ?? PLANS.standard.budget;
  const sourceTokens = sourceFactsTokenBudget(limits.maxSourceFactsTokens);
  if (route === 'standard') {
    return {
      route,
      budget: baseBudget,
      maxTokens: baseTokens,
      timeoutMs: baseTimeout,
      maxChars: recallContextCharBudget(baseTokens, sourceTokens),
      maxSourceFactsTokens: sourceTokens,
    };
  }
  const budget = BUDGET_ORDER[baseBudget] > BUDGET_ORDER[plan.budget] ? baseBudget : plan.budget;
  const maxTokens = Math.min(4000, Math.max(plan.maxTokens, Math.round(baseTokens * 1.5)));
  return {
    route,
    budget,
    maxTokens,
    timeoutMs: Math.min(MAX_DEEP_RECALL_TIMEOUT_MS, Math.max(plan.timeoutMs, baseTimeout * 2)),
    maxChars: recallContextCharBudget(maxTokens, sourceTokens),
    maxSourceFactsTokens: sourceTokens,
  };
}
