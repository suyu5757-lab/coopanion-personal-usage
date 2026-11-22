/**
 * The browser World's definition for Coopanion. The window and page script belong to the app
 * (`app/browser.cjs`, `app/browser-agent/`); this definition only carries the live settings and the
 * transport into the World.
 */
import type { Language } from 'cortico/core/language.ts';
import { describeTools, type WorldDefinition, type WorldSection } from 'cortico/world.ts';
import type { ActionGate } from '../action-gate.ts';
import type { BrowserTaskActionJournal } from './task-actions.ts';
import type { ModelLanguage } from '../language.ts';
import type { BrowserTransport } from './bridge.ts';
import type { SelfTimeConfig } from './config.ts';
import { BROWSER_TOOL_DECLS } from './tools.ts';
import { BrowserWorld, BROWSER_WORLD_ID, type ApprovalAnswer } from './world.ts';

export const BROWSER_ID = BROWSER_WORLD_ID;

export interface BrowserAssembly {
  bridge: BrowserTransport;
  selfTime: () => SelfTimeConfig;
  modelLanguage: () => ModelLanguage;
  language?: () => Language;
  /** Core's write gate, shared with the other Worlds that reach outside. */
  gate?: ActionGate;
  /** Asks the person to confirm one public write, in the pet's bubble; absent: no public write is sent. */
  ask?: (question: string, choices: [yes: string, no: string]) => Promise<ApprovalAnswer>;
  /** The file of unresolved public writes. */
  journalFile?: string;
  /** Durable duplicate guard for completed comment replies. */
  replyJournalFile?: string;
  /** Durable transaction log for scoped image and media actions. */
  taskJournalFile?: string;
  /** Core's shared action receipt ledger. */
  taskJournal?: BrowserTaskActionJournal;
  /** Companion workspace directory (stores douyin-ops/<taskId>/post_task.json). */
  workspaceDir?: string;
  /** Video/image media directory (stores tasks/<taskSlug>/final/...). */
  mediaDir?: string;
  /** Transcribes one finished 16 kHz mono utterance from the page's audio; absent when speech recognition is unavailable. */
  transcribe?: (pcm: Int16Array) => Promise<{ text: string; error?: string | null }>;
  /** A browsing session ended; Coo's next heartbeat starts from now. */
  onSessionEnd?: () => void;
}

const SUMMARIES = {
  browser_open: { zh: '在她自己的浏览器里打开一个网页。', en: 'Opens a page in her own browser window.' },
  browser_search: { zh: '在网上、B站或抖音搜索并打开结果页。', en: 'Searches the web, Bilibili or Douyin and opens the results.' },
  browser_read: { zh: '读当前页面和带编号的可点元素。', en: 'Reads the page and its numbered interactive elements.' },
  browser_text: { zh: '读整页正文。', en: 'Reads the visible page text.' },
  browser_find: { zh: '在当前页面里找词。', en: 'Finds a word on the current page.' },
  browser_click: { zh: '按编号或可见文字点开视频、点赞或打开输入框。', en: 'Clicks an element by number or by its visible text.' },
  browser_hover: { zh: '把鼠标移到元素上,露出悬停才出现的按钮。', en: 'Moves the pointer over an element to reveal hover-only controls.' },
  browser_share: { zh: '打开视频或页面的分享面板。', en: 'Opens the share panel of the video or page.' },
  browser_type: { zh: '在搜索框、弹幕或评论框里输入文字。', en: 'Types into a search, danmaku or comment box.' },
  browser_press: { zh: '按 Enter 发送,或按方向键翻动。', en: 'Presses Enter to send, or an arrow key to move.' },
  browser_scroll: { zh: '翻一屏再看。', en: 'Scrolls by screens and reads again.' },
  browser_play: { zh: '播放或暂停页面上的视频。', en: 'Plays or pauses the page video.' },
  browser_watch: { zh: '看一会儿视频，截几帧并把声音转成文字。', en: 'Watches the video for a while, takes a few frames and transcribes its sound.' },
  browser_screenshot: { zh: '截当前页面。', en: 'Takes a screenshot of the page.' },
  browser_chatgpt_generate_image: { zh: '在 ChatGPT 网页提交生图或同会话多轮改图指令。', en: 'Submits an image generation or same-thread edit prompt on ChatGPT.' },
  browser_chatgpt_image_status: { zh: '读取 ChatGPT 网页生图任务状态。', en: 'Reads the status of a ChatGPT web image task.' },
  browser_save_chatgpt_image: { zh: '一步保存 ChatGPT 网页生成的图片到素材目录或任务版本目录。', en: 'Directly saves a generated ChatGPT image into the media or task folder.' },
  browser_gemini_generate_image: { zh: '在 Gemini 网页提交生图或同会话多轮改图指令。', en: 'Submits an image generation or same-thread edit prompt on Gemini.' },
  browser_gemini_image_status: { zh: '读取 Gemini 网页生图任务状态。', en: 'Reads the status of a Gemini web image task.' },
  browser_save_gemini_image: { zh: '一步保存 Gemini 网页生成的图片到素材目录或任务版本目录。', en: 'Directly saves a generated Gemini image into the media or task folder.' },
  browser_image_workspace: { zh: '管理轻量图文任务目录（brief.md、versions/、final/）。', en: 'Manages lightweight task folders (brief.md, versions/, final/).' },
  browser_download_media: { zh: '下载当前页面摘要中选定的公开图片或视频。', en: 'Downloads one selected public image or video from the current page.' },
  browser_upload_media: { zh: '从素材目录选择文件，免确认放进抖音页面的投稿控件。', en: 'Places selected files from the media folder into a Douyin upload control.' },
  browser_douyin_task: { zh: '管理抖音运营任务文件（douyin-ops/<taskId>/post_task.json）并召回/写入运营复盘经验。', en: 'Manages Douyin operation task files (post_task.json) and recalls/records Growth lessons.' },
  browser_douyin_ops: { zh: '执行抖音创作者中心账号校验、填表/话题/AI声明、防重发发布、作品ID与数据抓取及评论回复。', en: 'Automates Douyin Creator Center account checks, post filling, AI disclosure, idempotent publish, metrics and comment replies.' },
  douyin_prepare_post: { zh: '一步串联抖音创作者中心复用上传页、多图上传跳页、防叠字幂等填表与回读校验快照（停在草稿页不发布）。', en: 'One-shot Douyin upload, edit-page transition, idempotent form fill and verified snapshot (stops at draft).' },
  browser_back: { zh: '回到上一页。', en: 'Goes back a page.' },
  browser_close: { zh: '关上她的浏览器窗口。', en: 'Closes her browser window.' },
} as const;

export function browserDefinition(assembly: BrowserAssembly): WorldDefinition<WorldSection> {
  return {
    id: BROWSER_ID,
    get label() {
      const language = assembly.language?.();
      return language === 'zh' || language === 'zh-Hant' ? '浏览器' : 'Browser';
    },
    defaults: () => ({ enabled: false }),
    create: (ctx) => new BrowserWorld({
      bridge: assembly.bridge,
      selfTime: assembly.selfTime,
      modelLanguage: assembly.modelLanguage,
      timezone: ctx.timezone,
      ...(assembly.language ? { language: assembly.language } : {}),
      ...(assembly.gate ? { gate: assembly.gate } : {}),
      ...(assembly.ask ? { ask: assembly.ask } : {}),
      ...(assembly.journalFile ? { journalFile: assembly.journalFile } : {}),
      ...(assembly.replyJournalFile ? { replyJournalFile: assembly.replyJournalFile } : {}),
      ...(assembly.taskJournalFile ? { taskJournalFile: assembly.taskJournalFile } : {}),
      ...(assembly.taskJournal ? { taskJournal: assembly.taskJournal } : {}),
      ...(assembly.workspaceDir ? { workspaceDir: assembly.workspaceDir } : {}),
      ...(assembly.mediaDir ? { mediaDir: assembly.mediaDir } : {}),
      ...(assembly.transcribe ? { transcribe: assembly.transcribe } : {}),
      ...(assembly.onSessionEnd ? { onSessionEnd: assembly.onSessionEnd } : {}),
    }),
    describe: {
      tools: describeTools(BROWSER_TOOL_DECLS, SUMMARIES),
      events: [{
        type: 'browser.closed',
        description: { zh: '她自己的浏览器窗口被关掉了。', en: 'Her own browser window was closed.' },
        trigger: 'debounce',
      }, {
        type: 'browser.unresolved',
        description: { zh: '上一次对外发的内容没能确认有没有发出去;先到网页上看一眼。', en: 'An earlier post could not be confirmed as sent; check the page before trying again.' },
        trigger: 'debounce',
      }],
    },
  };
}
