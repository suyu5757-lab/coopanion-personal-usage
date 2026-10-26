/**
 * What the bot reads from this World: tool receipts and event text, in the model-text language.
 * The option kinds are ACP's; the bot turns them into the person's own words.
 */
import type { TaskReview } from './review.ts';

export type ModelLanguage = 'zh' | 'en';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

const zh = {
  taskStarted: (taskId: string, dir: string) =>
    `交给 opencode 了:任务 ${taskId},目录 ${dir}。它在后台自己读文件、改文件、跑命令;要动文件或跑命令时会来问你。结束时会有一个事件叫醒你。`,
  taskRefused: (reason: string) => `没有把任务交给 opencode:${reason}`,
  busy: (taskId: string) => `已经有一个任务在跑了(${taskId});先等它结束,或用 opencode_stop 叫停。`,
  starting: '上一个任务还在准备,等一下再交。',
  stopping: 'opencode 已经停了,不能再接任务。',
  emptyTask: 'task 不能为空。',
  noRoots: '还没有允许 opencode 工作的目录。先请人在设置里填一个绝对路径,再交任务。',
  badDir: (dir: string, roots: readonly string[]) =>
    `目录 ${dir} 不在允许的范围内。允许的是:${roots.join('、') || '无'}。先请人在设置里添加。`,
  dirRequired: (roots: readonly string[]) => `有多个允许的目录,请把 dir 写清楚。允许的是:${roots.join('、')}。`,
  roots: (roots: readonly string[]) => roots.length ? roots.join('\n') : '(还没有设置)',
  permission: (taskId: string, dir: string, title: string, kind: string, detail: string, options: readonly PermissionOption[]) =>
    `opencode 在「${dir}」里请求权限(任务 ${taskId}):\n${title}${kind ? `(${kind})` : ''}\n${detail}\n可选项:${options.map((o) => `${o.name}=${o.kind}`).join('、')}。\n用 pet_ask 把命令、路径和选项原样转述给人,不要改写;人回答后调用 opencode_answer,taskId 用 ${taskId},choice 用 once、always 或 reject。`,
  permissionGone: '这个权限请求已经结束了。',
  answered: (choice: string) => `已经告诉 opencode:${choice === 'once' ? '允许这一次' : choice === 'always' ? '本次会话都允许' : '拒绝'}。等它继续。`,
  result: (taskId: string, dir: string, stop: string, summary: string, files: readonly string[], sessionId: string, commands: readonly string[]) => {
    const head = `opencode 的任务 ${taskId} 结束了(${stop})。目录:${dir}。session: ${sessionId}。`;
    const said = summary ? `\n它最后说:${summary}` : '';
    const changed = files.length ? `\n改过的文件:${files.join('、')}` : '';
    const ran = commands.length ? `\n跑过的命令:\n${commands.map((c) => `- ${c}`).join('\n')}` : '';
    return `${head}${said}${changed}${ran}\n先验收:对照原来的任务要求,看总结、文件和命令是否真的做到。满足就用自己的话告诉人完成、改了什么、下一步验证什么;不满足就用 opencode_task 并把 resume 设为 true,在 task 里写明要改什么。要看具体改动用 opencode_review 并设 diff=true。不要念整段日志。`;
  },
  failed: (taskId: string, dir: string, reason: string) =>
    `opencode 的任务 ${taskId} 没有完成(${dir}):${reason}。用 opencode_review 看最后一轮的总结、改动和命令;要接着改就用 opencode_task 并把 resume 设为 true。把原因告诉人。`,
  review: (review: TaskReview, diff: boolean) => {
    const state = review.ok ? '正常结束' : '未完成';
    const files = review.files.length ? review.files.map((f) => `- ${f.path} (+${f.added}/-${f.removed})`).join('\n') : '- 无';
    const commands = review.commands.length ? review.commands.map((c) => `- ${c.command} [${c.status}] ${c.output.slice(-400)}`).join('\n') : '- 无';
    const diffs = diff && review.diffs.length
      ? review.diffs.map((d) => `--- ${d.path}\n旧:\n${d.oldText.slice(-3000) || '(空)'}\n新:\n${d.newText.slice(-3000) || '(空)'}`).join('\n\n')
      : '要看改动前后的文本,把 diff 设为 true;每份最多显示 3000 字。';
    return `任务 ${review.taskId} 的验收材料:${state}(${review.stop})。目录:${review.dir}。session: ${review.sessionId}。\n它最后说:${review.summary || '(没有总结)'}\n改过的文件:\n${files}\n跑过的命令:\n${commands}\n${diffs}\n对照原来的任务要求判断:满足就告诉人完成;不满足就用 opencode_task 并把 resume 设为 true,写明要改什么。`;
  },
  noReview: '还没有可以验收的任务。',
  reviewMismatch: (got: string, last: string) => `最后一次任务是 ${last},不是 ${got}。`,
  stopped: (taskId: string) => `已经叫停任务 ${taskId};等 opencode 收尾。`,
  noTask: '现在没有任务在跑。',
  stopNoMatch: (taskId: string) => `正在跑的是别的任务,不是 ${taskId}。`,
  noPermission: '现在没有等待回答的权限请求。',
  statusIdle: '现在没有任务在跑。',
  statusTask: (taskId: string, dir: string, startedAt: string, waiting: boolean) =>
    `任务 ${taskId} 正在「${dir}」里跑,开始于 ${startedAt}${waiting ? ',正等你回答权限' : ''}。`,
  missingBinary: (bin: string, reason: string) =>
    `启动不了 opencode(${bin}):${reason}。请人确认 opencode 已经安装并登录。`,
  sessionFailed: (reason: string) =>
    `opencode 没有开始任务:${reason}。请人确认它已经安装并登录(opencode auth login)。`,
  badChoice: 'choice 应为 once、always 或 reject。',
  stopTimeout: (taskId: string) => `任务 ${taskId} 没有在叫停后收尾,已经关掉 opencode。`,
  timeout: (minutes: number) => `任务超过 ${minutes} 分钟,已经叫停。`,
  permissionTimeout: (minutes: number) => `权限请求等了 ${minutes} 分钟没人回答,任务已经停下。`,
  exited: (code: string) => `opencode 的进程退出了(${code})。`,
};

const en: typeof zh = {
  taskStarted: (taskId, dir) =>
    `Handed to opencode: task ${taskId} in ${dir}. It reads, edits and runs commands on its own in the background; it will ask you before touching a file or running a command. An event will wake you when it ends.`,
  taskRefused: (reason) => `I did not hand the task to opencode: ${reason}`,
  busy: (taskId) => `A task is already running (${taskId}); wait for it or call opencode_stop first.`,
  starting: 'The previous task is still being set up; wait a moment.',
  stopping: 'opencode is stopping; it cannot take a task now.',
  emptyTask: 'task must not be empty.',
  noRoots: 'No directory is allowed for opencode yet. Ask the person to add one in the settings first.',
  badDir: (dir, roots) => `The directory ${dir} is not allowed. Allowed: ${roots.join(', ') || 'none'}. Ask the person to add it in the settings.`,
  dirRequired: (roots) => `There are several allowed directories; name one in dir. Allowed: ${roots.join(', ')}.`,
  roots: (roots) => roots.length ? roots.join('\n') : '(none configured)',
  permission: (taskId, dir, title, kind, detail, options) =>
    `opencode asks for permission in ${dir} (task ${taskId}):\n${title}${kind ? ` (${kind})` : ''}\n${detail}\nOptions: ${options.map((o) => `${o.name}=${o.kind}`).join(', ')}.\nUse pet_ask to repeat the command, paths and options to the person unchanged. After their answer call opencode_answer with taskId ${taskId} and choice once, always or reject.`,
  permissionGone: 'That permission request has already ended.',
  answered: (choice) => `Told opencode: ${choice === 'once' ? 'allow this time' : choice === 'always' ? 'allow for this session' : 'reject'}. Waiting for it to continue.`,
  result: (taskId, dir, stop, summary, files, sessionId, commands) => {
    const head = `opencode's task ${taskId} ended (${stop}). Directory: ${dir}. Session: ${sessionId}.`;
    const said = summary ? `\nIt said last: ${summary}` : '';
    const changed = files.length ? `\nFiles changed: ${files.join(', ')}` : '';
    const ran = commands.length ? `\nCommands run:\n${commands.map((c) => `- ${c}`).join('\n')}` : '';
    return `${head}${said}${changed}${ran}\nReview it first: does the summary, the files and the commands really meet the request? If yes, tell the person in your own words what was done and what to check next. If not, call opencode_task with resume true and say exactly what to fix. To read the changed text, call opencode_review with diff true. Do not read the whole log.`;
  },
  failed: (taskId, dir, reason) =>
    `opencode's task ${taskId} did not finish (${dir}): ${reason}. Use opencode_review to read the last summary, changes and commands; to continue, call opencode_task with resume true. Tell the person why.`,
  review: (review, diff) => {
    const state = review.ok ? 'finished' : 'unfinished';
    const files = review.files.length ? review.files.map((f) => `- ${f.path} (+${f.added}/-${f.removed})`).join('\n') : '- none';
    const commands = review.commands.length ? review.commands.map((c) => `- ${c.command} [${c.status}] ${c.output.slice(-400)}`).join('\n') : '- none';
    const diffs = diff && review.diffs.length
      ? review.diffs.map((d) => `--- ${d.path}\nold:\n${d.oldText.slice(-3000) || '(empty)'}\nnew:\n${d.newText.slice(-3000) || '(empty)'}`).join('\n\n')
      : 'Set diff true to read the old and new text; each file shows up to 3000 characters.';
    return `Review of task ${review.taskId}: ${state} (${review.stop}). Directory: ${review.dir}. Session: ${review.sessionId}.\nIt said last: ${review.summary || '(no summary)'}\nFiles changed:\n${files}\nCommands run:\n${commands}\n${diffs}\nJudge it against the original request: if it passes, tell the person it is done; if not, call opencode_task with resume true and say exactly what to fix.`;
  },
  noReview: 'There is no task to review yet.',
  reviewMismatch: (got, last) => `The last task is ${last}, not ${got}.`,
  stopped: (taskId) => `Asked opencode to stop task ${taskId}; waiting for it to wind down.`,
  noTask: 'No task is running.',
  stopNoMatch: (taskId) => `The running task is not ${taskId}.`,
  noPermission: 'No permission request is waiting for an answer.',
  statusIdle: 'No task is running.',
  statusTask: (taskId, dir, startedAt, waiting) =>
    `Task ${taskId} is running in ${dir}, started at ${startedAt}${waiting ? ', waiting for your permission answer' : ''}.`,
  missingBinary: (bin, reason) =>
    `Could not start opencode (${bin}): ${reason}. Ask the person to check that opencode is installed and signed in.`,
  sessionFailed: (reason) =>
    `opencode did not start the task: ${reason}. Ask the person to check that it is installed and signed in (opencode auth login).`,
  badChoice: 'choice must be once, always or reject.',
  stopTimeout: (taskId) => `Task ${taskId} did not wind down after the stop request; opencode was closed.`,
  timeout: (minutes) => `The task ran longer than ${minutes} minutes and was stopped.`,
  permissionTimeout: (minutes) => `Nobody answered the permission request for ${minutes} minutes; the task stopped.`,
  exited: (code) => `The opencode process exited (${code}).`,
};

export const MODEL_TEXT: Record<ModelLanguage, typeof zh> = { zh, en };
