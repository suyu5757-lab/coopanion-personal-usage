/**
 * Tool declarations for Coo's own browser. Descriptions are English whatever the model-text language;
 * receipts are in `model-text.ts`. Page indices and file input ids come from the latest read or action.
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
    description: 'Read the current page: title, address, scroll position, numbered interactive elements and file inputs with accept/multiple attributes. Element numbers are what browser_click and browser_type take; fileIds are for browser_upload_media.',
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
    description: 'Click an element by number, unique visible text, or a strict role/name/data-e2e locator. If those cannot identify the target, a vision-capable model may use one coordinate from the latest browser_screenshot captureId. Screenshot clicks always require a separate one-step approval, are refused for send, publish, share, clipboard, destructive and file-picker targets, and return an unknown outcome until reviewed. Spending money, private messages and account changes are refused. Read the page again after it changes.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: 'The number in front of the element, e.g. 12 for [12]. Omit when using text.' },
        text: { type: 'string', description: 'The visible text of an element that has no number, e.g. 添加音乐. Omit when using index.' },
        locator: {
          type: 'object', additionalProperties: false,
          properties: {
            role: { type: 'string', description: 'Exact ARIA role, such as button or link.' },
            name: { type: 'string', description: 'Exact name from aria-label, aria-labelledby, native labels, button value or text; title, placeholder and name are fallbacks.' },
            testId: { type: 'string', description: 'Exact data-e2e value.' },
            within: {
              type: 'object', additionalProperties: false,
              properties: {
                role: { type: 'string' },
                name: { type: 'string' },
                testId: { type: 'string' },
              },
            },
          },
        },
        point: {
          type: 'object', additionalProperties: false,
          properties: {
            x: { type: 'number', minimum: 0, description: 'The horizontal pixel coordinate in the exact screenshot image.' },
            y: { type: 'number', minimum: 0, description: 'The vertical pixel coordinate in the exact screenshot image.' },
            captureId: { type: 'string', minLength: 1, description: 'The one-use captureId returned with the latest browser_screenshot image.' },
            description: { type: 'string', minLength: 1, maxLength: 160, description: 'A short visible description of the intended target.' },
          },
          required: ['x', 'y', 'captureId', 'description'],
        },
      },
      required: [],
    },
  },
  {
    name: 'browser_hover',
    tags: ['act'],
    description: 'Move the pointer over an element by number, without clicking. Some controls appear only on hover, such as a song\'s 使用 button in a music picker or a share panel; read the page again afterwards.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0, description: 'The number in front of the element, e.g. 12 for [12].' } },
      required: ['index'],
    },
  },
  {
    name: 'browser_share',
    tags: ['act'],
    description: 'Open the share panel of the current page or video and return the page with its numbered options. Copying a link or choosing a destination requires a separate one-time Core approval and action receipt. Refused while browsing is read-only.',
    parameters: { type: 'object', properties: {}, required: [] },
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
    description: 'Press a key after typing, or focus an element first. Enter submits a search or sends a danmaku/comment on most sites; in read-only mode Enter and Space on write controls are refused; PageDown and ArrowDown move a feed. Text already in a box is a public post: the person is asked to confirm that exact text, and it is sent once. Enter and Space on delete/remove controls are refused. Supported: Enter, Escape, Tab, Space, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp, PageDown.',
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
    description: 'Wait while the video plays, take a few frames, transcribe its sound (even when the window is muted) and report the video\'s position. Use browser_play first. Watch a minute or two at a time, not the whole video; ask for more frames when motion or a quick change matters.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', minimum: 1, maximum: 30, description: 'How long to watch; default 10 seconds.' },
        frames: { type: 'integer', minimum: 1, maximum: 6, description: 'How many frames to take during the wait; default 3, at most one per second.' },
        audio: { type: 'boolean', description: 'Transcribe the page\'s sound during the wait; default true, false skips it.' },
      },
      required: [],
    },
  },
  {
    name: 'browser_screenshot',
    tags: ['read', 'snapshot'],
    description: 'Take a screenshot of the current page for layout, images or a control the element list does not show. When the model can see images, the result includes a one-use captureId for coordinates measured in that exact image.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_chatgpt_generate_image',
    tags: ['act'],
    interruptible: true,
    description: 'Submit one image prompt through the visible composer on the signed-in ChatGPT website in this browser. This uses the ChatGPT webpage, not an API or Codex. If the result is unclear, read the page and do not send the prompt again.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string', minLength: 1, maxLength: 2000, description: 'The image-generation prompt to send through ChatGPT.' } },
      required: ['prompt'],
    },
  },
  {
    name: 'browser_save_chatgpt_image',
    tags: ['act'],
    interruptible: true,
    description: 'Save the visible generated image using its Save or Download control on chatgpt.com. The image is checked and written to the video media folder; the result reports its filename. The target must be a visible image save control from the latest page read.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0, description: 'The numbered Save or Download control beside the generated image.' } },
      required: ['index'],
    },
  },
  {
    name: 'browser_download_media',
    tags: ['act'],
    interruptible: true,
    description: 'Download one visible image or direct video file from the latest browser_read or browser_open media list. Requires the separate mediaDownload permission and a one-time Core approval bound to the current page snapshot, source, existing destination directory, filename and byte limit. Only public HTTP(S) files are supported; redirects must remain on the selected origin. The file is checked by its response MIME, extension, signature, size and SHA-256 before it is published without overwriting. Does not bypass sign-in, DRM, paywalls or site restrictions.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: 'The [index] in the downloadable media list returned by the latest browser_read or browser_open.' },
        directory: { type: 'string', minLength: 1, maxLength: 4096, description: 'An existing absolute local directory selected by the user. It may not contain symlink components.' },
        filename: { type: 'string', minLength: 1, maxLength: 240, description: 'A single filename with an image or video extension that matches the selected media type.' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1073741824, description: 'The maximum number of bytes this one download may write.' },
      },
      required: ['index', 'directory', 'filename', 'maxBytes'],
    },
  },
  {
    name: 'browser_upload_media',
    tags: ['act'],
    interruptible: true,
    description: 'Place selected files from the video media folder into one file input on a Douyin page. Use fileId and accept/multiple values from the latest browser_read and file paths from video_list_media. Only relative files under the media folder are accepted; this prepares the page and does not publish the post.',
    parameters: {
      type: 'object',
      properties: {
        fileId: { type: 'integer', minimum: 0, description: 'The page-local fileId from browser_read, bound to the current page snapshot.' },
        files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'Relative paths returned by video_list_media, such as generated/cover.png or clip.mp4.' },
      },
      required: ['fileId', 'files'],
    },
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
