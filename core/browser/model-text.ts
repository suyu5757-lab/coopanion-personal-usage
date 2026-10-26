/** What Coo reads from the browser World: receipts of each tool, the page summary, and the self-time wake-up. */
import type { ModelLanguage } from '../language.ts';
import type { ClickRefusal } from './guard.ts';

export interface VideoState {
  current: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  width: number;
  height: number;
  src: string;
}

export interface PageState {
  url: string;
  title: string;
  header: string;
  content: string;
  footer: string;
  video: VideoState | null;
}

export interface AgentElement {
  id: number;
  tag: string;
  text: string;
  label: string;
  type: string;
  placeholder: string;
  aria: string;
  title: string;
  role: string;
  href: string;
  disabled: boolean;
  visible: boolean;
}

export interface BrowserText {
  opened(url: string): string;
  searched(query: string, site: string): string;
  clicked(label: string): string;
  hovered(label: string): string;
  typed(label: string): string;
  pressed(key: string): string;
  scrolled(down: boolean, pages: number): string;
  played(paused: boolean): string;
  screenshot: string;
  watched(seconds: number): string;
  closed: string;
  closedEvent: string;
  notOpen: string;
  timeUp: string;
  budget: string;
  interrupted: string;
  noWindow: string;
  noElement(index: number): string;
  refusedClick(label: string, why: ClickRefusal): string;
  refusedType(label: string): string;
  lookOnly(label: string): string;
  failed(tool: string, why: string): string;
  noBack: string;
  noVideo: string;
  videoProblem(why: string): string;
  found(query: string, count: number): string;
  none(query: string): string;
  truncated: string;
  imageFallback(width: number, height: number): string;
  noImage: string;
  pageLine(title: string, url: string): string;
  video(video: VideoState | null): string;
  textPage: string;
}

const time = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

const zh: BrowserText = {
  opened: (url) => `[浏览器] 打开了 ${url}`,
  searched: (query, site) => `[浏览器] 在${site}搜索了「${query}」`,
  clicked: (label) => `[浏览器] 点了「${label}」`,
  hovered: (label) => `[浏览器] 鼠标移到「${label}」上`,
  typed: (label) => `[浏览器] 在「${label}」里输入了文字`,
  pressed: (key) => `[浏览器] 按了 ${key}`,
  scrolled: (down, pages) => `[浏览器] ${down ? '向下' : '向上'}翻了 ${pages} 屏`,
  played: (paused) => `[浏览器] ${paused ? '暂停' : '播放'}了视频`,
  screenshot: '[浏览器] 当前页面截图',
  watched: (seconds) => `[浏览器] 看了 ${seconds} 秒`,
  closed: '[浏览器] 浏览器关上了。',
  closedEvent: '[浏览器] 浏览器窗口被关掉了。',
  notOpen: '[浏览器] 浏览器还没打开;先用 browser_open 打开一个页面。',
  timeUp: '[浏览器] 这一段自己的时间到了,浏览器已经关上。',
  budget: '[浏览器] 这一段上网的次数用完了,浏览器已经关上。',
  interrupted: '[浏览器] 被打断了,这一步没有继续。',
  noWindow: '[浏览器] 浏览器窗口不在了。',
  noElement: (index) => `[浏览器] 页面上没有第 ${index} 个可点元素;重新 browser_read 一次。`,
  refusedClick: (label, why) => `[浏览器] 没有点「${label}」:${why === 'payment' ? '看起来会花钱' : why === 'private' ? '看起来会发私信' : '会改动登录或账号'}。`,
  refusedType: (label) => `[浏览器] 没有在「${label}」里输入:它要密码或个人信息。`,
  lookOnly: (label) => `[浏览器] 现在只允许看,没有动「${label}」。`,
  failed: (tool, why) => `[${tool} 没执行] ${why}`,
  noBack: '[浏览器] 没有上一页了。',
  noVideo: '[浏览器] 这个页面上没有视频。',
  videoProblem: (why) => `[浏览器] 视频没能播放:${why}。`,
  found: (query, count) => `[浏览器] 页面里找到 ${count} 处「${query}」:`,
  none: (query) => `[浏览器] 页面里没有找到「${query}」。`,
  truncated: '…(后面还有,用 browser_scroll 或 browser_find 继续看)',
  imageFallback: (width, height) => `[页面截图 ${width}×${height};当前模型看不了图片]`,
  noImage: '(当前模型看不了图片)',
  pageLine: (title, url) => `页面: ${title} — ${url}`,
  video: (video) => {
    if (!video) return '视频: 没有';
    const when = video.duration > 0 ? `${time(video.current)} / ${time(video.duration)}` : `${time(video.current)} / 直播`;
    return `视频: ${video.paused ? '暂停' : '播放中'} ${when}, ${video.muted ? '静音' : '有声音'}`;
  },
  textPage: '[浏览器] 页面正文:',
};

const en: BrowserText = {
  opened: (url) => `[browser] Opened ${url}`,
  searched: (query, site) => `[browser] Searched ${site} for "${query}"`,
  clicked: (label) => `[browser] Clicked "${label}"`,
  hovered: (label) => `[browser] Moved the pointer over "${label}"`,
  typed: (label) => `[browser] Typed into "${label}"`,
  pressed: (key) => `[browser] Pressed ${key}`,
  scrolled: (down, pages) => `[browser] Scrolled ${down ? 'down' : 'up'} ${pages} screen${pages === 1 ? '' : 's'}`,
  played: (paused) => `[browser] ${paused ? 'Paused' : 'Played'} the video`,
  screenshot: '[browser] Screenshot of the page',
  watched: (seconds) => `[browser] Watched for ${seconds} seconds`,
  closed: '[browser] Closed the browser.',
  closedEvent: '[browser] The browser window was closed.',
  notOpen: '[browser] The browser is not open; use browser_open first.',
  timeUp: '[browser] This turn of your own time is over; the browser is closed.',
  budget: '[browser] The tool calls for this browsing session are used up; the browser is closed.',
  interrupted: '[browser] Interrupted; this step did not continue.',
  noWindow: '[browser] The browser window is gone.',
  noElement: (index) => `[browser] There is no element ${index} on the page; read the page again.`,
  refusedClick: (label, why) => `[browser] Did not click "${label}": it ${why === 'payment' ? 'looks like it spends money' : why === 'private' ? 'looks like a private message' : 'would change the login or account'}.`,
  refusedType: (label) => `[browser] Did not type into "${label}": it asks for a password or personal information.`,
  lookOnly: (label) => `[browser] Only looking for now; left "${label}" alone.`,
  failed: (tool, why) => `[${tool} not run] ${why}`,
  noBack: '[browser] There is no earlier page.',
  noVideo: '[browser] There is no video on this page.',
  videoProblem: (why) => `[browser] The video did not play: ${why}.`,
  found: (query, count) => `[browser] Found ${count} place${count === 1 ? '' : 's'} with "${query}" on the page:`,
  none: (query) => `[browser] Found no "${query}" on the page.`,
  truncated: '…(more follows; use browser_scroll or browser_find)',
  imageFallback: (width, height) => `[page screenshot ${width}×${height}; this model cannot see images]`,
  noImage: '(this model cannot see images)',
  pageLine: (title, url) => `Page: ${title} — ${url}`,
  video: (video) => {
    if (!video) return 'video: none';
    const when = video.duration > 0 ? `${time(video.current)} / ${time(video.duration)}` : `${time(video.current)} / live`;
    return `video: ${video.paused ? 'paused' : 'playing'} ${when}, ${video.muted ? 'muted' : 'sound on'}`;
  },
  textPage: '[browser] Visible page text:',
};

export const BROWSER_TEXT: Record<ModelLanguage, BrowserText> = { zh, en };

/** The line Cormini's heartbeat delivers when Coo has time of her own. */
export function selfTimeLine(language: ModelLanguage, quietSeconds: number, minutes: number, unlimited = false): string {
  if (language === 'en') {
    const quiet = quietSeconds < 60 ? `${quietSeconds} seconds` : `${Math.floor(quietSeconds / 60)} minutes`;
    const span = unlimited ? 'with no time limit' : `up to ${minutes} minutes`;
    return `[system] Quiet for ${quiet}. This is your own time, ${span}: speak if you want to; `
      + 'if you want to go online, open your browser and look around Bilibili, Douyin or anywhere else. '
      + 'If you would rather not, end_turn.';
  }
  const quiet = quietSeconds < 60 ? `${quietSeconds} 秒` : `${Math.floor(quietSeconds / 60)} 分钟`;
  const span = unlimited ? '不限时长' : `最多 ${minutes} 分钟`;
  return `[system] 已经安静了 ${quiet}。这是你自己的时间,${span}:想说话就说;`
    + '想自己上网逛逛,可以打开你的浏览器,去 B 站、抖音或别的地方看看。不想动就 end_turn。';
}
