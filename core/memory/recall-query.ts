import { sanitizeForMemory } from './policy.ts';
import { recallDateContext, recallDateQuery, type RecallDateContext } from './recall-date.ts';

export interface RecallQueryPlan {
  sourcePhrases: string[];
  supplementalQueries: string[];
  /** Present when the question names one calendar day that has an indexed date arm. */
  dateContext?: RecallDateContext;
}

export type SourceMatchType = 'query_prefix' | 'literal_phrase' | 'semantic_candidate';

const MAX_SOURCE_PHRASES = 4;
const MAX_SOURCE_PHRASE_CHARS = 48;
const MAX_SUPPLEMENTAL_QUERIES = 2;
const MAX_SUPPLEMENTAL_QUERY_CHARS = 180;
const MAX_PLANNED_QUERY_CHARS = 1800;
const QUERY_EDGE_CHARS = MAX_PLANNED_QUERY_CHARS / 2;
const QUERY_CANDIDATE_SCORE = {
  explicitQuote: 2_000,
  explicitRestatement: 1_900,
  markedTopic: 1_500,
  backgroundTopic: 820,
  focusedTopic: 1_400,
  focusedQuestionTarget: 1_460,
  linkedChineseSubject: 1_760,
  focusedTokens: 1_100,
  markedTopicTokens: 1_120,
  timeWhenAsked: 1_180,
  focusStem: 850,
  nearbyClause: 760,
  wholeTopic: 700,
  wholeStem: 660,
  timeContext: 620,
  wholeQuestionTokens: 520,
  englishNgrams: 450,
} as const;
const TOKEN_POSITION_WEIGHT = 90;
const TOPIC_POSITION_WEIGHT = 80;
const CONTEXT_POSITION_WEIGHT = 55;
const REDUNDANCY_PENALTY = 100;
const GENERIC_PHRASES = new Set(['什么', '哪个', '哪里', '谁', '怎么', '如何', '为什么', '是否', '吗', '呢', '方式', '方案', '功能', '决定', '约定', '结果', '说法', '一起', '我们', '你我', '之前', '以前', '关于', '最终', '最后', '去年', '前年', '当时', '具体', '采用', '选择', '计划', '一下', '同学', '同事', '项目', '什么是', '人工智能']);
const QUERY_FILLER = /(?:我们|咱们|你我|之前|以前|上次|上回|去年|前年|关于|最终|最后|当时|这个|那个|那项|这项|决定|约定|选择|采用|采取|功能|具体|请问|告诉我|记得|还记得|什么|哪种|哪一个|哪个|方式|方案|做法|结果|是什么|如何|怎么|的|吗|呢|吧)/gu;
const LATIN_STOP = new Set(['a', 'about', 'and', 'an', 'as', 'at', 'back', 'be', 'but', 'by', 'can', 'could', 'did', 'do', 'for', 'from', 'had', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'our', 'the', 'that', 'then', 'there', 'these', 'this', 'those', 'to', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your']);
const CLAUSE_BOUNDARY = /[,，;；。！？?!\n]+|(?<!\d)[:：](?!\d)/u;
const SENTENCE_BOUNDARY = /(?<=[。！？?!\n])/u;
const TOPIC_MARKER = /(?:关于|针对|围绕|有关|对于|about|regarding|concerning)\s*([^,，;；。！？?!\n]{2,100})/giu;
const ENGLISH_FOCUS_RELATION = /\b(?:about|for|on|regarding|concerning)\s+(?:(?:the|a|an|our|their|my|your)\s+)?([^,，;；。！？?!\n]{2,100})/giu;
const ENGLISH_QUESTION_TARGET = /^(?:what|which)\s+([A-Za-z][A-Za-z0-9'-]{1,})\s+(?:(?:did|do|have|had|will|would|should|can)\s+)?(?:we|i|you|they)\b/iu;
const TIME_QUESTION = /(?:什么时候|哪年|哪月|哪天|何时|多久|几月|周几|when|what time|which day|what date|how long)/iu;
const TIME_HINT = /(?:\b(?:19|20)\d{2}(?:年)?\b|去年|前年|今年|明年|上周|上个月|昨天|前天|刚才|刚刚|那天|那年|周[一二三四五六日天]|星期[一二三四五六日天])/gu;
const ANAPHORIC_TAIL = /(?:这个|那个|上述|前述|该决定|该方案|该选择|同一个决定)|\b(?:that decision|this decision|the decision|what was it|what about it)\b/iu;
const ZH_WORD_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const CHINESE_TOPIC_MARKER = /(?:关于|针对|围绕|有关|对于)(.{2,100})|在(.{2,100}?)方面/u;
const CHINESE_LEADING_FRAME = /^(?:(?:我们|咱们|你我|大家|之前|以前|上次|上回|去年|前年|当时|最后|最终|后来|曾经|一起|先|又|已经|还|再|这个|那个|(?:讨论|谈论|聊|提)(?:了|过|到)(?:的)?|(?:确认|决定|确定|约定)(?:了)?)\s*)+/u;
const CHINESE_QUERY_PREDICATE = /(?:我们|咱们|你我|大家|最后|最终|当时|应该|应当|需要|采用|使用|采取|选用|选定|选择|决定|确定|约定|更正|改为|改到|定了|选了|(?:是)?用(?=什么|哪)|按(?=什么|哪)|按照|如何|怎么|怎样|是什么|什么|哪一?种|哪个|哪天|几|多久|多少|何时|谁|是否|吗)/u;
const CHINESE_GENERIC_TOPIC = /(?:材料|顺序|方案|方式|安排|结果|决定|约定|讨论|使用|采用|采取|处理|进行|一种|几次|后来|然后|什么|哪个|如何|怎么|呢)/gu;

interface WordToken {
  text: string;
  position: number;
}

interface PhraseCandidate {
  text: string;
  score: number;
  order: number;
  tokens: Set<string>;
}

function safePhrase(value: string): string {
  const safe = sanitizeForMemory(value);
  return safe.skip ? '' : safe.text.replace(/\s+/gu, ' ').trim();
}

// Keep both an early quoted source cue and the final question focus within the analysis bound.
function boundedQueryText(value: string): string {
  if (value.length <= MAX_PLANNED_QUERY_CHARS) return value;
  const head = value.slice(0, QUERY_EDGE_CHARS).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = value.slice(-QUERY_EDGE_CHARS).replace(/^[\uDC00-\uDFFF]/u, '');
  return `${head}\n${tail}`;
}

function questionStem(text: string): string {
  return text.trim()
    .replace(/[？?！!。；;]+$/u, '')
    .replace(/[,，、\s]*(?:(?:这个|那个|那项|这项|该|最终|最后|当时|之前|上次|最初)?(?:决定|约定|选择|方案|结果|说法|安排))?(?:具体)?(?:采用|选择)?(?:是什么|怎么做|如何做|什么|哪种|哪个|哪一个|什么样|什么时候|哪天|多久|多少|谁|为什么)(?:方式|方案|结果|时间)?$/u, '')
    .replace(/[,，、\s]*(?:采用|选择)(?:的是|的)?(?:什么|哪种|哪个)(?:方式|方案)?$/u, '')
    .replace(/[,，、\s]*(?:这个|那个|那项|这项|当时|最终|最后|最初)?(?:决定|约定|选择|方案|结果|说法|安排)$/u, '')
    .replace(/^[,，、\s]+|[,，、\s]+$/gu, '');
}

function compactTopic(text: string): string {
  return text
    .replace(/^(?:(?:我们|咱们|你我|一起|共同)\s*)?(?:(?:之前|以前|上次|上回|去年|前年|当时)\s*)?(?:关于\s*)?/u, '')
    .replace(/^(?:(?:about|for|on|regarding|concerning)\s+)+/iu, '')
    .replace(/^(?:(?:the|a|an|our|their|my|your)\s+)/iu, '')
    .replace(QUERY_FILLER, '')
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function wordTokens(text: string): WordToken[] {
  if (!text) return [];
  return [...ZH_WORD_SEGMENTER.segment(text)]
    .filter((part) => part.isWordLike)
    .flatMap((part) => {
      const word = part.segment;
      const normalized = word.toLocaleLowerCase();
      if ([...word].length < 2 || GENERIC_PHRASES.has(normalized) || LATIN_STOP.has(normalized)) return [];
      return [{ text: word, position: text.length ? (part.index + word.length / 2) / text.length : 0 }];
    });
}

function termBonus(term: string): number {
  const lengthBonus = Math.min([...term].length, 12) * 2;
  const scriptBonus = /\p{Script=Han}/u.test(term) ? 18 : 0;
  return lengthBonus + scriptBonus;
}

function salientWords(text: string): string[] {
  return wordTokens(text).map((token) => token.text);
}

function englishPhrases(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z0-9'-]*/gu)?.map((word) => word.toLowerCase()) ?? [];
  const useful = words.filter((word) => word.length >= 3 && !LATIN_STOP.has(word));
  const phrases: string[] = [];
  for (let index = 0; index < useful.length - 1; index += 1) {
    phrases.push(`${useful[index]} ${useful[index + 1]}`);
  }
  if (useful.length > 0) phrases.push(useful.at(-1)!);
  return phrases;
}

function chineseSubject(clause: string): string {
  const marked = clause.match(CHINESE_TOPIC_MARKER);
  let subject = (marked?.[1] ?? marked?.[2] ?? clause).trim().replace(CHINESE_LEADING_FRAME, '');
  const predicate = subject.search(CHINESE_QUERY_PREDICATE);
  if (predicate >= 0) subject = subject.slice(0, predicate);
  subject = subject.replace(/(?:的)?(?:讨论|话题|事情|问题)$/u, '').replace(/[的\s]+$/u, '').trim();
  if (!/^\p{Script=Han}/u.test(subject) || subject.length > 100
    || subject.replace(CHINESE_GENERIC_TOPIC, '').replace(/[^\p{L}\p{N}]/gu, '').length < 2) return '';
  return subject;
}

// This literal fallback links a question tail to one nearby subject; it does not establish historical relevance.
function chineseFocusFallback(clauses: readonly string[]): { topic: string; sourcePhrases: string[] } | undefined {
  const question = clauses.at(-1) ?? '';
  if (!/(?:什么|哪|如何|怎么|怎样|几|多久|多少|何时|谁|是否|吗|呢)/u.test(question)) return undefined;
  let topic = chineseSubject(question);
  if (!topic) {
    const preceding = clauses.slice(-4, -1).reverse();
    const markedClause = preceding.find((clause) => CHINESE_TOPIC_MARKER.test(clause));
    if (markedClause) topic = chineseSubject(markedClause);
    else {
      const previous = preceding[0] ?? '';
      const possessive = previous.includes('的');
      const discussion = /^(?:(?:我们|咱们|你我|之前|以前|上次|当时)\s*)*(?:讨论|谈|聊|提)(?:过|了|到)/u.test(previous);
      const list = [...ZH_WORD_SEGMENTER.segment(previous)].some((segment) => ['和', '与', '及', '以及', '、'].includes(segment.segment));
      if (possessive || (discussion && !list)) topic = chineseSubject(previous);
    }
  }
  if (!topic) return undefined;

  const parts: string[] = [];
  let start = 0;
  for (const segment of ZH_WORD_SEGMENTER.segment(topic)) {
    if (!['和', '与', '及', '以及', '、'].includes(segment.segment)) continue;
    parts.push(topic.slice(start, segment.index).trim());
    start = segment.index + segment.segment.length;
  }
  parts.push(topic.slice(start).trim());
  const subjects = parts.filter((part, index) => part && (index === 0 || part.includes('的')
    || !parts.slice(0, index).some((previous) => previous.includes('的'))));
  const phrases: string[] = [];
  const add = (value: string): void => {
    const phrase = safePhrase(value);
    if ([...phrase].length < 2 || [...phrase].length > MAX_SOURCE_PHRASE_CHARS) return;
    if (!phrases.includes(phrase)) phrases.push(phrase);
  };
  for (const subject of subjects) add(subject.split('的')[0] ?? subject);
  add(topic);
  for (const subject of subjects) {
    add(subject);
    add(compactTopic(subject));
    const unwrapped = compactTopic(subject.replace(/(?:功能|话题|事项|问题)$/u, ''));
    if ([...unwrapped].length <= 4) for (const word of salientWords(unwrapped)) add(word);
  }
  return phrases.length ? { topic, sourcePhrases: phrases } : undefined;
}

export function planRecallQueries(input: string): RecallQueryPlan {
  const safe = sanitizeForMemory(input);
  if (safe.skip || !safe.text) return { sourcePhrases: [], supplementalQueries: [] };
  const text = boundedQueryText(safe.text.trim());
  const dateContext = recallDateContext(text) ?? undefined;
  const clauses = text.split(CLAUSE_BOUNDARY).map((part) => part.trim()).filter(Boolean);
  const focusText = clauses.at(-1) ?? text;
  const nearbyClauses = clauses.slice(Math.max(0, clauses.length - 3), -1);
  const sentences = text.split(SENTENCE_BOUNDARY).map((part) => part.trim()).filter(Boolean);
  const precedingSentence = sentences.length > 1 ? sentences.at(-2) ?? '' : '';
  const focusStem = questionStem(focusText) || focusText;
  const focusTopic = compactTopic(focusStem) || compactTopic(focusText);
  const stem = questionStem(text);
  const topic = compactTopic(stem);
  const chineseFocus = chineseFocusFallback(clauses);
  const chineseLiterals = new Set(chineseFocus?.sourcePhrases.map((phrase) => phrase.toLocaleLowerCase()));
  const asksTime = TIME_QUESTION.test(text);
  const phraseCandidates = new Map<string, PhraseCandidate>();
  let candidateOrder = 0;
  const addPhrase = (candidate: string, score: number, allowGeneric = false): void => {
    const value = safePhrase(candidate);
    if (!value || (!allowGeneric && (GENERIC_PHRASES.has(value.toLocaleLowerCase()) || LATIN_STOP.has(value.toLocaleLowerCase())))
      || [...value].length < 2 || [...value].length > MAX_SOURCE_PHRASE_CHARS) return;
    const key = value.toLocaleLowerCase();
    const existing = phraseCandidates.get(key);
    if (existing) {
      if (score > existing.score) existing.score = score;
      return;
    }
    phraseCandidates.set(key, {
      text: value,
      score,
      order: candidateOrder++,
      tokens: new Set(wordTokens(value).map((token) => token.text.toLocaleLowerCase())),
    });
  };

  const quoted = /[“「"']([^”」"']{2,80})[”」"']/gu;
  for (const match of text.matchAll(quoted)) addPhrase(match[1] ?? '', QUERY_CANDIDATE_SCORE.explicitQuote);
  const stated = text.match(/(?:原话|原文|具体表述|约定(?:是|为)|决定(?:是|为)|采用的是|选择的是)(?:是)?[：:]\s*([^。；;？！?]{2,80})/u)?.[1];
  if (stated) addPhrase(stated, QUERY_CANDIDATE_SCORE.explicitRestatement);
  if (precedingSentence && ANAPHORIC_TAIL.test(focusText)) addPhrase(precedingSentence, QUERY_CANDIDATE_SCORE.explicitRestatement - 50);
  for (const [index, phrase] of (chineseFocus?.sourcePhrases ?? []).entries()) {
    addPhrase(phrase, QUERY_CANDIDATE_SCORE.linkedChineseSubject - index * 10);
  }

  const focusOffset = Math.max(0, text.lastIndexOf(focusText));
  const topicMatches = [...text.matchAll(TOPIC_MARKER)].flatMap((match) => {
    const value = (match[1] ?? '').trim();
    if (!value) return [];
    const start = match.index ?? 0;
    return [{ text: value, position: start / Math.max(1, text.length), focused: start >= focusOffset }];
  }).concat([...focusText.matchAll(ENGLISH_FOCUS_RELATION)].flatMap((match) => {
    const value = (match[1] ?? '').trim();
    if (!value) return [];
    const start = focusOffset + (match.index ?? 0);
    return [{ text: value, position: start / Math.max(1, text.length), focused: true }];
  }));
  for (const match of topicMatches) {
    const baseScore = match.focused ? QUERY_CANDIDATE_SCORE.markedTopic : QUERY_CANDIDATE_SCORE.backgroundTopic;
    const tokenScore = match.focused ? QUERY_CANDIDATE_SCORE.markedTopicTokens : QUERY_CANDIDATE_SCORE.backgroundTopic;
    const score = baseScore + Math.round(match.position * TOPIC_POSITION_WEIGHT);
    const compactMatch = compactTopic(match.text) || match.text;
    addPhrase(compactMatch, score);
    for (const token of wordTokens(compactMatch)) {
      addPhrase(token.text, tokenScore + Math.round(token.position * 70) + termBonus(token.text));
    }
    for (const [index, phrase] of englishPhrases(compactMatch).entries()) {
      addPhrase(phrase, tokenScore - 60 + index);
    }
  }

  addPhrase(focusTopic, QUERY_CANDIDATE_SCORE.focusedTopic);
  addPhrase(focusStem, QUERY_CANDIDATE_SCORE.focusStem);
  const englishQuestionTarget = focusText.match(ENGLISH_QUESTION_TARGET)?.[1];
  if (englishQuestionTarget) addPhrase(englishQuestionTarget, QUERY_CANDIDATE_SCORE.focusedQuestionTarget);
  const focusTokens = wordTokens(focusText);
  for (const [index, token] of focusTokens.entries()) {
    addPhrase(token.text, QUERY_CANDIDATE_SCORE.focusedTokens + Math.round(token.position * TOKEN_POSITION_WEIGHT)
      + termBonus(token.text) + index / Math.max(1, focusTokens.length));
  }
  for (const [clauseIndex, clause] of nearbyClauses.entries()) {
    const proximity = clauseIndex / Math.max(1, nearbyClauses.length);
    const clauseTopic = compactTopic(questionStem(clause));
    addPhrase(clauseTopic, QUERY_CANDIDATE_SCORE.nearbyClause + Math.round(proximity * 140));
    for (const token of wordTokens(clause)) {
      addPhrase(token.text, QUERY_CANDIDATE_SCORE.nearbyClause + Math.round(proximity * 140)
        + Math.round(token.position * CONTEXT_POSITION_WEIGHT) + termBonus(token.text));
    }
  }

  for (const [index, hint] of [...text.matchAll(TIME_HINT)].entries()) {
    const temporalScore = asksTime ? QUERY_CANDIDATE_SCORE.timeWhenAsked : QUERY_CANDIDATE_SCORE.timeContext;
    addPhrase(hint[0], temporalScore + index, true);
  }

  addPhrase(topic, QUERY_CANDIDATE_SCORE.wholeTopic);
  addPhrase(stem, QUERY_CANDIDATE_SCORE.wholeStem);
  const allWords = wordTokens(text);
  for (const token of allWords) {
    addPhrase(token.text, QUERY_CANDIDATE_SCORE.wholeQuestionTokens + Math.round(token.position * 130) + termBonus(token.text));
  }
  for (const [index, phrase] of englishPhrases(text).entries()) {
    addPhrase(phrase, QUERY_CANDIDATE_SCORE.englishNgrams + index / Math.max(1, text.length));
  }

  const rankedCandidates = [...phraseCandidates.values()].filter((candidate) => !chineseFocus
    || chineseLiterals.has(candidate.text.toLocaleLowerCase())
    || candidate.score >= QUERY_CANDIDATE_SCORE.explicitRestatement - 50);
  const selected: PhraseCandidate[] = [];
  // Topic and focus candidates outrank background terms; short overlapping phrases remain useful as literal fallbacks.
  while (selected.length < MAX_SOURCE_PHRASES && selected.length < rankedCandidates.length) {
    let best: PhraseCandidate | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of rankedCandidates) {
      if (selected.includes(candidate)) continue;
      let overlap = 0;
      for (const prior of selected) {
        const priorTokens = prior.tokens;
        const candidateTokens = candidate.tokens;
        if (candidateTokens.size === 0 || priorTokens.size === 0) continue;
        const shared = [...candidateTokens].filter((token) => priorTokens.has(token)).length;
        const tokenOverlap = shared / Math.min(candidateTokens.size, priorTokens.size);
        const lengthOverlap = Math.min([...candidate.text].length, [...prior.text].length)
          / Math.max([...candidate.text].length, [...prior.text].length);
        overlap = Math.max(overlap, tokenOverlap * lengthOverlap);
      }
      const score = candidate.score - overlap * REDUNDANCY_PENALTY;
      if (score > bestScore || (score === bestScore && candidate.order < (best?.order ?? Number.POSITIVE_INFINITY))) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) break;
    selected.push(best);
  }

  const supplementalQueries: string[] = [];
  const addQuery = (candidate: string): void => {
    const safeQuery = safePhrase(candidate);
    if ([...safeQuery].length < 2 || [...safeQuery].length > MAX_SUPPLEMENTAL_QUERY_CHARS
      || GENERIC_PHRASES.has(safeQuery.toLocaleLowerCase()) || LATIN_STOP.has(safeQuery.toLocaleLowerCase())) return;
    const normalized = safeQuery.toLocaleLowerCase();
    if (normalized === text.slice(0, 120).toLocaleLowerCase()) return;
    if (supplementalQueries.some((query) => query.toLocaleLowerCase() === normalized)) return;
    supplementalQueries.push(safeQuery);
  };
  if (chineseFocus) {
    addQuery(chineseFocus.topic);
    const question = safePhrase(focusText).slice(0, Math.max(0, MAX_SUPPLEMENTAL_QUERY_CHARS - chineseFocus.topic.length - 1));
    addQuery(`${chineseFocus.topic} ${question}`);
  } else {
    const bestTopic = topicMatches
      .filter((match) => match.focused)
      .map((match) => ({ text: compactTopic(match.text) || match.text, position: match.position }))
      .sort((left, right) => right.position - left.position)[0]?.text;
    addQuery(bestTopic || focusTopic || focusStem);
    const complementaryTokens = [...new Set([
      ...(englishQuestionTarget ? [englishQuestionTarget] : []),
      ...topicMatches.filter((match) => match.focused).flatMap((match) => salientWords(match.text)),
      ...salientWords(focusText),
      ...(asksTime ? [...text.matchAll(TIME_HINT)].map((match) => match[0]) : []),
      ...nearbyClauses.slice(-2).flatMap((clause) => salientWords(clause)),
    ])];
    addQuery(complementaryTokens.slice(0, 8).join(' '));
  }

  if (dateContext) {
    // The generic compactor removes separators, so `2026-10-25` can become three unrelated
    // numbers. Add the untouched calendar date before the other supplemental candidates.
    supplementalQueries.unshift(recallDateQuery(dateContext));
    if (dateContext.recordKind === 'journal') supplementalQueries.splice(1, 0, `${dateContext.date} diary`);
    while (supplementalQueries.length > MAX_SUPPLEMENTAL_QUERIES) supplementalQueries.pop();
  }

  return {
    sourcePhrases: selected.map((candidate) => candidate.text),
    supplementalQueries: supplementalQueries.slice(0, MAX_SUPPLEMENTAL_QUERIES),
    ...(dateContext ? { dateContext } : {}),
  };
}
