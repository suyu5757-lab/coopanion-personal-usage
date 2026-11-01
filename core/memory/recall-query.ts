import { sanitizeForMemory } from './policy.ts';

export interface RecallQueryPlan {
  sourcePhrases: string[];
  supplementalQueries: string[];
}

export type SourceMatchType = 'query_prefix' | 'literal_phrase' | 'semantic_candidate';

const MAX_SOURCE_PHRASES = 4;
const MAX_SOURCE_PHRASE_CHARS = 48;
const MAX_SUPPLEMENTAL_QUERIES = 2;
const MAX_SUPPLEMENTAL_QUERY_CHARS = 180;
const GENERIC_PHRASES = new Set(['什么', '哪个', '哪里', '方式', '方案', '功能', '决定', '约定', '结果', '说法', '一起', '我们', '你我', '之前', '以前', '关于', '最终', '最后', '去年', '前年', '当时', '具体', '采用', '选择', '计划', '一下', '同学', '同事', '项目', '什么是', '人工智能']);
const QUERY_FILLER = /(?:我们|咱们|你我|之前|以前|上次|上回|去年|前年|关于|最终|最后|当时|这个|那个|那项|这项|决定|约定|选择|采用|采取|功能|具体|请问|告诉我|记得|还记得|什么|哪种|哪一个|哪个|方式|方案|做法|结果|是什么|如何|怎么|的|吗|呢|吧)/gu;
const LATIN_STOP = new Set(['about', 'at', 'back', 'did', 'do', 'for', 'from', 'had', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'our', 'the', 'to', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your']);

function safePhrase(value: string): string {
  const safe = sanitizeForMemory(value);
  return safe.skip ? '' : safe.text.replace(/\s+/gu, ' ').trim();
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
    .replace(QUERY_FILLER, '')
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function salientWords(text: string): string[] {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  return [...segmenter.segment(text)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((word) => [...word].length >= 2
      && !GENERIC_PHRASES.has(word.toLocaleLowerCase())
      && !LATIN_STOP.has(word.toLocaleLowerCase()));
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

export function planRecallQueries(input: string): RecallQueryPlan {
  const safe = sanitizeForMemory(input);
  if (safe.skip || !safe.text) return { sourcePhrases: [], supplementalQueries: [] };
  const text = safe.text.trim();
  const phrases: string[] = [];
  const addPhrase = (candidate: string): void => {
    const value = safePhrase(candidate);
    if (!value || GENERIC_PHRASES.has(value.toLocaleLowerCase())
      || [...value].length < 2 || [...value].length > MAX_SOURCE_PHRASE_CHARS) return;
    if (!phrases.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) phrases.push(value);
  };

  const quoted = /[“「"']([^”」"']{2,80})[”」"']/gu;
  for (const match of text.matchAll(quoted)) addPhrase(match[1] ?? '');
  const stated = text.match(/(?:原话|原文|具体表述|约定(?:是|为)|决定(?:是|为)|采用的是|选择的是)(?:是)?[：:]\s*([^。；;？！?]{2,80})/u)?.[1];
  if (stated) addPhrase(stated);

  const stem = questionStem(text);
  const topic = compactTopic(stem);
  addPhrase(stem);
  addPhrase(topic);
  for (const phrase of salientWords(stem)) addPhrase(phrase);
  for (const phrase of englishPhrases(stem)) addPhrase(phrase);

  const supplementalQueries: string[] = [];
  const addQuery = (candidate: string): void => {
    const safeQuery = safePhrase(candidate);
    if ([...safeQuery].length < 2 || [...safeQuery].length > MAX_SUPPLEMENTAL_QUERY_CHARS) return;
    const normalized = safeQuery.toLocaleLowerCase();
    if (normalized === text.slice(0, 120).toLocaleLowerCase()) return;
    if (supplementalQueries.some((query) => query.toLocaleLowerCase() === normalized)) return;
    supplementalQueries.push(safeQuery);
  };
  const queryTerms = [...new Set(salientWords(stem))];
  addQuery(topic);
  addQuery(queryTerms.slice(0, 6).join(' '));
  addQuery(stem);

  return {
    sourcePhrases: phrases.slice(0, MAX_SOURCE_PHRASES),
    supplementalQueries: supplementalQueries.slice(0, MAX_SUPPLEMENTAL_QUERIES),
  };
}
