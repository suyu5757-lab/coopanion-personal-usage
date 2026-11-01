import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import { DEFAULT_RECALL_TIMEOUT_MS, MAX_CONFIGURED_RECALL_TIMEOUT_MS, MAX_SOURCE_FACTS_TOKEN_BUDGET } from './recall-limits.ts';
import { memoryStorageText } from './strings.ts';

const zh = {
  groupDesc: '连接本机或远程的 Hindsight。修改后重启应用生效。留空的项继续使用 hindsight.json 或环境变量。',
  autostart: '后台自动启动 Hindsight',
  autostartDesc: '应用启动时如果本机 Hindsight 没在运行，就在后台启动它；只对 127.0.0.1 / localhost 生效。',
  enabled: '启用长期记忆',
  enabledDesc: '关闭后不再写入或读取 Hindsight；现有 bank 不会被删除。',
  apiUrl: 'Hindsight 地址',
  apiUrlDesc: '例如 http://127.0.0.1:8888。',
  bankId: '记忆 bank',
  bankIdDesc: '留空时按部署目录生成；不同人格可以各自用一个 bank。',
  maxTokens: '每轮注入上限',
  maxTokensDesc: 'recall 每次最多带回多少 token 的记忆，默认 900。',
  timeout: 'recall 超时（毫秒）',
  timeoutDesc: `超过这个时间就跳过本轮记忆，默认 ${DEFAULT_RECALL_TIMEOUT_MS} 毫秒。`,
  affection: '每日关系日记',
  affectionDesc: '每天把好感事件、关系变化和长期记忆整理成一篇日记写进 Hindsight；后台静默运行。',
};

const en: typeof zh = {
  groupDesc: 'Connect a local or remote Hindsight server. Changes apply after restarting the app. Empty fields keep using hindsight.json or the environment.',
  autostart: 'Start Hindsight in the background',
  autostartDesc: 'When the app starts, start a local Hindsight daemon if one is not already running. Only applies to 127.0.0.1 / localhost.',
  enabled: 'Enable long-term memory',
  enabledDesc: 'When off, nothing is written to or read from Hindsight; the existing bank is not deleted.',
  apiUrl: 'Hindsight URL',
  apiUrlDesc: 'For example http://127.0.0.1:8888.',
  bankId: 'Memory bank',
  bankIdDesc: 'Leave empty to derive one from the deployment directory; different personas can use different banks.',
  maxTokens: 'Recall token budget',
  maxTokensDesc: 'How much memory text one recall may bring back. Default 900.',
  timeout: 'Recall timeout (ms)',
  timeoutDesc: `Skip memory for this turn after this long. Default ${DEFAULT_RECALL_TIMEOUT_MS} ms.`,
  affection: 'Daily relationship journal',
  affectionDesc: 'Once a day, turn affection events, relationship changes and long-term memories into a journal entry in Hindsight. Runs silently in the background.',
};

const TEXT = { zh, en };

const SOURCE_FACTS_TEXT: Record<Language, { title: string; description: string }> = {
  en: { title: 'Supporting source token budget', description: 'Token budget for facts supporting recalled observations, independent of the recall text budget.' },
  zh: { title: '来源事实 token 上限', description: '召回汇总记忆时附带来源事实的 token 上限，独立于主结果预算。' },
  'zh-Hant': { title: '來源事實 token 上限', description: '召回彙總記憶時附帶來源事實的 token 上限，獨立於主要結果預算。' },
  ja: { title: '根拠となる事実のトークン上限', description: '想起した観察を裏付ける事実のトークン上限。想起本文の予算とは独立しています。' },
  ko: { title: '근거 사실 토큰 한도', description: '회상된 관찰을 뒷받침하는 사실의 토큰 한도이며 회상 본문 예산과 별개입니다.' },
  fr: { title: 'Budget de tokens des faits sources', description: 'Budget des faits étayant les observations rappelées, indépendant du budget du texte rappelé.' },
  de: { title: 'Tokenbudget für Quellenfakten', description: 'Budget für Fakten, die abgerufene Beobachtungen belegen, unabhängig vom Budget des Erinnerungstexts.' },
  'es-419': { title: 'Presupuesto de tokens de fuentes', description: 'Límite de los hechos que respaldan las observaciones recuperadas, independiente del texto recordado.' },
  'pt-BR': { title: 'Orçamento de tokens dos fatos de origem', description: 'Limite dos fatos que sustentam as observações recuperadas, independente do texto da memória.' },
  it: { title: 'Budget di token dei fatti di origine', description: 'Limite dei fatti a sostegno delle osservazioni richiamate, indipendente dal testo della memoria.' },
  ru: { title: 'Бюджет токенов исходных фактов', description: 'Бюджет фактов, подтверждающих извлечённые наблюдения, независимо от бюджета текста памяти.' },
};

export function hindsightConfigGroup(language: Language): ConfigGroup {
  const t = TEXT[language === 'zh' || language === 'zh-Hant' ? 'zh' : 'en'];
  const s = memoryStorageText(language);
  const sourceFacts = SOURCE_FACTS_TEXT[language];
  return {
    id: 'hindsight',
    owner: 'persona',
    schema: {
      type: 'object',
      title: s.hindsightLabel,
      description: t.groupDesc,
      properties: {
        'hindsight.autostart': { type: 'boolean', title: t.autostart, description: t.autostartDesc, 'x-hot': false },
        'hindsight.enabled': { type: 'boolean', title: t.enabled, description: t.enabledDesc, 'x-hot': false },
        'hindsight.apiUrl': { type: 'string', title: t.apiUrl, description: t.apiUrlDesc, 'x-hot': false },
        'hindsight.bankId': { type: 'string', title: t.bankId, description: t.bankIdDesc, 'x-hot': false },
        'hindsight.recall.maxTokens': { type: 'integer', title: t.maxTokens, description: t.maxTokensDesc, minimum: 200, maximum: 4000, 'x-hot': false },
        'hindsight.recall.maxSourceFactsTokens': { type: 'integer', title: sourceFacts.title, description: sourceFacts.description, minimum: 1, maximum: MAX_SOURCE_FACTS_TOKEN_BUDGET, 'x-hot': false },
        'hindsight.recall.timeoutMs': { type: 'integer', title: t.timeout, description: t.timeoutDesc, minimum: 100, maximum: MAX_CONFIGURED_RECALL_TIMEOUT_MS, 'x-hot': false },
        'hindsight.affection.enabled': { type: 'boolean', title: t.affection, description: t.affectionDesc, 'x-hot': false },
      },
    },
  };
}
