/**
 * The browser World's definition for Coopanion. The window and page script belong to the app
 * (`app/browser.cjs`, `app/browser-agent/`); this definition only carries the live settings and the
 * transport into the World.
 */
import type { Language } from 'cortico/core/language.ts';
import { describeTools, type WorldDefinition, type WorldSection } from 'cortico/world.ts';
import type { ModelLanguage } from '../language.ts';
import type { BrowserTransport } from './bridge.ts';
import type { SelfTimeConfig } from './config.ts';
import { BROWSER_TOOL_DECLS } from './tools.ts';
import { BrowserWorld, BROWSER_WORLD_ID } from './world.ts';

export const BROWSER_ID = BROWSER_WORLD_ID;

export interface BrowserAssembly {
  bridge: BrowserTransport;
  selfTime: () => SelfTimeConfig;
  modelLanguage: () => ModelLanguage;
  language?: () => Language;
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
      ...(assembly.transcribe ? { transcribe: assembly.transcribe } : {}),
      ...(assembly.onSessionEnd ? { onSessionEnd: assembly.onSessionEnd } : {}),
    }),
    describe: {
      tools: describeTools(BROWSER_TOOL_DECLS, SUMMARIES),
      events: [{
        type: 'browser.closed',
        description: { zh: '她自己的浏览器窗口被关掉了。', en: 'Her own browser window was closed.' },
        trigger: 'debounce',
      }],
    },
  };
}
