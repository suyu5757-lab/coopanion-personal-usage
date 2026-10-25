/**
 * Tool declarations for Coo's own browser. Descriptions are English whatever the model-text language;
 * receipts are in `model-text.ts`. Indices come from the latest read or action, and every action
 * returns the page as it is afterwards.
 */
import type { ToolDef } from 'cortico/core/types.ts';

export const BROWSER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'browser_open',
    tags: ['act'],
    interruptible: true,
    description: 'Open an http(s) page in your own browser window, or go to another page in it. The window has its own login state and does not take the person\'s mouse. Returns the page summary and its numbered interactive elements.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'An http:// or https:// address.' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_search',
    tags: ['act'],
    interruptible: true,
    description: 'Search the web (Bing) or Bilibili or Douyin, and open the result page in your browser. Use browser_read or browser_find on the result.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        site: { type: 'string', enum: ['web', 'bilibili', 'douyin'], description: 'Where to search; web is the default.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_read',
    tags: ['read'],
    description: 'Read the current page: title, address, scroll position, and the numbered interactive elements with their text and attributes. Numbers are what browser_click and browser_type take.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_text',
    tags: ['read'],
    description: 'Read the visible text of the current page, for an article or a description too long for the element tree. Returns up to about 12,000 characters.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_find',
    tags: ['read'],
    description: 'Find a word or phrase on the current page and return the matching lines with their element numbers when there are any. Use it on long pages instead of reading everything.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to find; case is ignored.' } },
      required: ['query'],
    },
  },
  {
    name: 'browser_click',
    tags: ['act'],
    description: 'Click an element by the number from the latest page read. Use it to open a video, play or pause, like, favorite, follow or open a comment box. Spending money, private messages and account changes are refused; read the page again after a navigation.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0, description: 'The number in front of the element, e.g. 12 for [12].' } },
      required: ['index'],
    },
  },
  {
    name: 'browser_type',
    tags: ['act'],
    description: 'Type into a text box, comment box or search box by element number. Password, phone, email and verification-code fields are refused; ask the person to sign in in the window instead.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: 'The text box\'s element number.' },
        text: { type: 'string', maxLength: 1000, description: 'The text to enter. It replaces what is already there.' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'browser_press',
    tags: ['act'],
    description: 'Press a key after typing, or focus an element first. Enter submits a search or sends a danmaku/comment on most sites; PageDown and ArrowDown move a feed. Supported: Enter, Escape, Tab, Space, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp, PageDown.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'] },
        index: { type: 'integer', minimum: 0, description: 'Optional element to focus before the key.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    tags: ['act'],
    description: 'Scroll the page by whole screens and read it again. Use down for the next videos in a feed.',
    parameters: {
      type: 'object',
      properties: {
        down: { type: 'boolean', description: 'true scrolls down, false up.' },
        pages: { type: 'integer', minimum: 1, maximum: 10, description: 'How many screens; default 1.' },
        index: { type: 'integer', minimum: 0, description: 'Optional scrollable element to scroll, when the page itself does not move (a feed container).' },
      },
      required: ['down'],
    },
  },
  {
    name: 'browser_play',
    tags: ['act'],
    description: 'Play or pause the largest video on the page. Playing needs no click on the site\'s player; the browser is muted unless the person turned its sound on.',
    parameters: {
      type: 'object',
      properties: { pause: { type: 'boolean', description: 'true pauses; default plays.' } },
      required: [],
    },
  },
  {
    name: 'browser_watch',
    tags: ['read', 'snapshot'],
    interruptible: true,
    description: 'Wait while the video plays, then take one screenshot and report the video\'s position. Use browser_play first. Watch a minute or two at a time, not the whole video.',
    parameters: {
      type: 'object',
      properties: { seconds: { type: 'number', minimum: 1, maximum: 30, description: 'How long to watch; default 10 seconds.' } },
      required: [],
    },
  },
  {
    name: 'browser_screenshot',
    tags: ['read', 'snapshot'],
    description: 'Take a screenshot of the current page, for layout, images or a player control the element tree does not show.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_back',
    tags: ['act'],
    description: 'Go back to the previous page in the browser window.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_close',
    tags: ['act'],
    description: 'Close your browser window. Do this when you are done looking around.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];
