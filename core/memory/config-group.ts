import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
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
  timeoutDesc: '超过这个时间就跳过本轮记忆，默认 800。',
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
  timeoutDesc: 'Skip memory for this turn after this long. Default 800.',
  affection: 'Daily relationship journal',
  affectionDesc: 'Once a day, turn affection events, relationship changes and long-term memories into a journal entry in Hindsight. Runs silently in the background.',
};

const TEXT = { zh, en };

export function hindsightConfigGroup(language: Language): ConfigGroup {
  const t = TEXT[language === 'zh' || language === 'zh-Hant' ? 'zh' : 'en'];
  const s = memoryStorageText(language);
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
        'hindsight.recall.timeoutMs': { type: 'integer', title: t.timeout, description: t.timeoutDesc, minimum: 100, maximum: 5000, 'x-hot': false },
        'hindsight.affection.enabled': { type: 'boolean', title: t.affection, description: t.affectionDesc, 'x-hot': false },
      },
    },
  };
}
