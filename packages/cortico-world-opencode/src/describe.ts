/** The event declarations, apart from the definition so tests can pin their shape. */
import type { EventDescribe } from 'cortico/core/types.ts';

export function describeEvents(): readonly EventDescribe[] {
  return [
    {
      type: 'opencode.permission',
      description: {
        zh: 'opencode 请求写文件、跑命令或取网页,附原始输入与可选项;Coo 用 pet_ask 原样转述给人。',
        en: 'opencode asks to write a file, run a command or fetch a page, with the original input and the options; Coo relays it unchanged with pet_ask.',
      },
      trigger: 'preempt',
    },
    {
      type: 'opencode.result',
      description: {
        zh: 'opencode 的任务结束,附总结、改过的文件、跑过的命令、session 和任务 id。',
        en: 'The opencode task ended, with its summary, changed files, commands run, session and task id.',
      },
      trigger: 'preempt',
    },
    {
      type: 'opencode.failed',
      description: {
        zh: 'opencode 的任务失败、被叫停或超时,附原因。',
        en: 'The opencode task failed, was stopped or timed out, with the reason.',
      },
      trigger: 'preempt',
    },
  ];
}
