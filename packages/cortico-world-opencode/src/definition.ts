/** The World's declaration: config, tools, events and the app channels it lends. */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { OPENCODE_DEFAULTS, type OpencodeConfigSection } from './config.ts';
import { describeEvents } from './describe.ts';
import { OPENCODE_TOOL_DECLS } from './tools.ts';
import type { ModelLanguage } from './model-text.ts';
import { OpencodeWorld, OPENCODE_ID, type OpencodeGuestState } from './world.ts';

export interface OpencodeAssembly {
  /** The model-text language, read at each use; Chinese when absent. */
  modelLanguage?: () => ModelLanguage;
  /** The app's guest avatar channel. */
  onState?: (state: OpencodeGuestState) => void;
}

const SUMMARIES = {
  opencode_task: {
    zh: '把一件编码任务交给 opencode;它在允许的目录里自己动手,结束或失败时用事件叫醒 Coo。',
    en: 'Hands a coding task to opencode, which works in an allowed directory and wakes Coo with an event when it ends.',
  },
  opencode_answer: {
    zh: '回答 opencode 的权限请求:允许一次、本次会话总是允许,或拒绝。',
    en: "Answers opencode's permission request: allow once, allow for this session, or reject.",
  },
  opencode_stop: {
    zh: '叫停当前的 opencode 任务。',
    en: 'Stops the running opencode task.',
  },
  opencode_status: {
    zh: '看有没有 opencode 任务在跑、在哪个目录、是否在等权限。',
    en: 'Says whether an opencode task is running, where, and whether it waits for permission.',
  },
  opencode_review: {
    zh: '看最后一次 opencode 任务的总结、改过的文件、跑过的命令;diff=true 时附改动前后的文本,用来决定过不过。',
    en: 'Reads the last opencode task review: summary, changed files and commands; diff=true adds the old and new text, for deciding whether it passes.',
  },
} as const;

const DESCRIBE = {
  tools: describeTools(OPENCODE_TOOL_DECLS, SUMMARIES),
  events: describeEvents(),
};

/** The definition, with what the app lends the World. */
export function opencodeDefinition(assembly: OpencodeAssembly = {}): WorldDefinition<OpencodeConfigSection> {
  return {
    id: OPENCODE_ID,
    label: 'opencode',
    defaults: () => structuredClone(OPENCODE_DEFAULTS),
    create: (ctx) => new OpencodeWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      modelLanguage: () => assembly.modelLanguage?.() ?? 'zh',
      onState: (state) => assembly.onState?.(state),
    }),
    describe: DESCRIBE,
  };
}

export const OPENCODE = opencodeDefinition();
