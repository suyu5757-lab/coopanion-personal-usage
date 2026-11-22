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
    description: 'Submit an image generation or same-thread natural-language edit prompt through the signed-in ChatGPT website. Set mode="edit" for follow-up visual revisions in the same conversation. Returns taskId; poll browser_chatgpt_image_status to check when the image is ready.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 2000, description: 'The image-generation or follow-up edit instruction to send through ChatGPT.' },
        mode: { type: 'string', enum: ['generate', 'edit'], description: 'Use "generate" for a new image (default) or "edit" for natural-language follow-up revisions in the same chat.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'browser_chatgpt_image_status',
    tags: ['read'],
    description: 'Read the state of one ChatGPT image task by its task id. Reports prompt_submitted, generating, image_available, unknown or failed.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 36, maxLength: 36, description: 'The task id returned by browser_chatgpt_generate_image.' } },
      required: ['taskId'],
    },
  },
  {
    name: 'browser_save_chatgpt_image',
    tags: ['act'],
    interruptible: true,
    description: 'Directly save the visible generated image using its Save or Download control on chatgpt.com into the media folder (or tasks/<taskSlug>/versions|final/).',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: 'The numbered Save or Download control beside the generated image.' },
        taskSlug: { type: 'string', maxLength: 64, description: 'Optional task folder name under tasks/<taskSlug>/.' },
        versionName: { type: 'string', maxLength: 64, description: 'Optional clean filename stem such as v1, v2, or cover.' },
        final: { type: 'boolean', description: 'When true with taskSlug, saves directly into tasks/<taskSlug>/final/.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'browser_gemini_generate_image',
    tags: ['act'],
    interruptible: true,
    description: 'Submit an image generation or same-thread natural-language edit prompt through the signed-in Gemini website (gemini.google.com). Set mode="edit" for follow-up revisions in the same chat. Can be used interchangeably with ChatGPT as a mutual backup.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 2000, description: 'The image-generation or follow-up edit instruction to send through Gemini.' },
        mode: { type: 'string', enum: ['generate', 'edit'], description: 'Use "generate" for a new image (default) or "edit" for natural-language follow-up revisions in the same chat.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'browser_gemini_image_status',
    tags: ['read'],
    description: 'Read the state of one Gemini web image task by its task id. Reports prompt_submitted, generating, image_available, unknown or failed.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 36, maxLength: 36, description: 'The task id returned by browser_gemini_generate_image.' } },
      required: ['taskId'],
    },
  },
  {
    name: 'browser_save_gemini_image',
    tags: ['act'],
    interruptible: true,
    description: 'Directly save the visible generated image using its Download/Save control on gemini.google.com into the media folder (or tasks/<taskSlug>/versions|final/).',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: 'The numbered Download or Save control beside the generated image.' },
        taskSlug: { type: 'string', maxLength: 64, description: 'Optional task folder name under tasks/<taskSlug>/.' },
        versionName: { type: 'string', maxLength: 64, description: 'Optional clean filename stem such as v1, v2, or cover.' },
        final: { type: 'boolean', description: 'When true with taskSlug, saves directly into tasks/<taskSlug>/final/.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'browser_image_workspace',
    tags: ['act'],
    description: 'Manage lightweight graphic-post task folders under the media root (tasks/<taskSlug>/brief.md, versions/, final/). Files inside final/ can be passed directly to browser_upload_media for Douyin graphic posts.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['init', 'update_brief', 'list', 'promote_final'], description: 'Workspace action.' },
        taskSlug: { type: 'string', maxLength: 64, description: 'Task folder name, e.g. autumn-coffee-post.' },
        brief: { type: 'string', maxLength: 4000, description: 'Markdown brief/prompts/notes to save into brief.md (for init or update_brief).' },
        sourceFile: { type: 'string', maxLength: 240, description: 'Version image filename or relative path to copy into final/ (for promote_final).' },
        finalName: { type: 'string', maxLength: 120, description: 'Optional output filename inside final/, e.g. 01-cover.png.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_download_media',
    tags: ['act'],
    interruptible: true,
    description: 'Download one visible image or direct video file from the latest browser_read or browser_open media list into an existing local directory. Images download directly when mediaDownload is enabled.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: 'The [index] in the downloadable media list returned by the latest browser_read or browser_open.' },
        directory: { type: 'string', minLength: 1, maxLength: 4096, description: 'An existing absolute local directory.' },
        filename: { type: 'string', minLength: 1, maxLength: 240, description: 'A single filename with an image or video extension that matches the selected media type.' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1073741824, description: 'Optional maximum bytes (defaults to 40 MB for images).' },
        taskId: { type: 'string', minLength: 36, maxLength: 36, description: 'Optional verified image task id.' },
      },
      required: ['index', 'directory', 'filename'],
    },
  },
  {
    name: 'browser_upload_media',
    tags: ['act'],
    interruptible: true,
    description: 'Place selected files from the media folder (including tasks/<taskSlug>/final/...) into one file input on a Douyin Creator Center page. Preparing a draft requires no popup approval and does not publish the post.',
    parameters: {
      type: 'object',
      properties: {
        fileId: { type: 'integer', minimum: 0, description: 'The page-local fileId from browser_read, bound to the current page snapshot.' },
        files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'Relative paths returned by video_list_media or browser_image_workspace, such as tasks/demo/final/01-cover.png.' },
      },
      required: ['fileId', 'files'],
    },
  },
  {
    name: 'browser_douyin_task',
    tags: ['act'],
    description: 'Manage Douyin graphic-post lifecycle files under Workspace douyin-ops/<taskId>/post_task.json and images/. Action "init" forces recall of prior operation-experiences.jsonl lessons; "record_review" writes post-mortem lessons back to Growth.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['init', 'get', 'list', 'update', 'sync_images', 'record_review'], description: 'Task lifecycle action.' },
        taskId: { type: 'string', maxLength: 64, description: 'Task ID such as dy_20261122_01.' },
        targetAccount: { type: 'string', maxLength: 120, description: 'Bound Douyin account nickname or ID.' },
        topic: { type: 'string', maxLength: 200, description: 'Post topic.' },
        title: { type: 'string', maxLength: 120, description: 'Post title.' },
        body: { type: 'string', maxLength: 2000, description: 'Post body copy.' },
        tags: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Topic hashtags without #.' },
        finalImagePaths: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Media relative paths (for sync_images) or task image paths.' },
        music: { type: 'string', maxLength: 120, description: 'Optional BGM search keyword or track title for Douyin graphic posts.' },
        aiDisclosure: { type: 'boolean', description: 'Whether to check platform AI-generated disclosure (default false).' },
        status: { type: 'string', enum: ['DRAFT', 'READY', 'PUBLISHING', 'UNDER_REVIEW', 'PUBLISHED', 'FAILED', 'UNKNOWN'], description: 'Task status.' },
        postId: { type: 'string', maxLength: 64, description: 'Published Douyin post ID.' },
        postUrl: { type: 'string', maxLength: 400, description: 'Published Douyin post URL.' },
        summary: { type: 'string', maxLength: 300, description: 'Review summary (for record_review).' },
        lesson: { type: 'string', maxLength: 400, description: 'Actionable lesson to reuse on next post (for record_review).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_douyin_ops',
    tags: ['act'],
    interruptible: true,
    description: 'Automate Douyin Creator Center graphic-post publishing, account verification, idempotent post-list deduplication/URL extraction, metrics fetching, and comment reading/replying, synced with douyin-ops/<taskId>/post_task.json.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check_account', 'fill_post', 'select_music', 'publish_post', 'check_posts', 'fetch_metrics', 'fetch_comments', 'reply_comment'],
          description: 'Douyin Creator Center operation.',
        },
        taskId: { type: 'string', maxLength: 64, description: 'Optional task ID in douyin-ops/<taskId>/post_task.json.' },
        expectedAccount: { type: 'string', maxLength: 120, description: 'Expected Douyin account nickname or ID for strict account binding.' },
        title: { type: 'string', maxLength: 120, description: 'Post title (for fill_post or matching in check_posts).' },
        body: { type: 'string', maxLength: 2000, description: 'Post body copy (for fill_post).' },
        tags: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Topic hashtags without # (for fill_post).' },
        music: { type: 'string', maxLength: 120, description: 'BGM search keyword or track title (for select_music or fill_post; e.g. "纯音乐 午后" or "推荐").' },
        requireMusic: { type: 'boolean', description: 'For publish_post: block publishing if no verified non-zero BGM is genuinely imported (default true when task has music).' },
        aiDisclosure: { type: 'boolean', description: 'Whether to check platform AI-generated content disclosure (default false; leave unchecked unless explicitly true).' },
        postId: { type: 'string', maxLength: 64, description: 'Target post ID (for check_posts, fetch_metrics, fetch_comments).' },
        commentId: { type: 'string', maxLength: 120, description: 'Target comment ID (for reply_comment).' },
        commentUser: { type: 'string', maxLength: 120, description: 'Target comment author nickname (for reply_comment).' },
        commentText: { type: 'string', maxLength: 200, description: 'Target comment text snippet (for reply_comment).' },
        replyText: { type: 'string', maxLength: 500, description: 'Reply text to post (for reply_comment).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'douyin_prepare_post',
    tags: ['act'],
    interruptible: true,
    description: 'One-shot compound Douyin graphic-post preparation: reuses or opens Creator Center upload page, uploads all images and waits for edit-page jump, idempotently clears and fills title/body/#hashtags (default aiDisclosure=false), and returns a verified readback snapshot. Stops on the draft/preview page without publishing.',
    parameters: {
      type: 'object',
      properties: {
        images: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'Relative paths in the media folder, e.g. ["tasks/demo/final/01.png", "tasks/demo/final/02.png"].' },
        title: { type: 'string', maxLength: 120, description: 'Post title.' },
        body: { type: 'string', maxLength: 2000, description: 'Post body copy.' },
        hashtags: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Topic hashtags without #.' },
        music: { type: 'string', maxLength: 120, description: 'Optional BGM search keyword or track title to select and verify real audio import (e.g. "纯音乐 午后" or "推荐").' },
        expectedAccount: { type: 'string', maxLength: 120, description: 'Expected Douyin account nickname or ID (normalized, e.g. "@肥鱼本鱼").' },
        aiDisclosure: { type: 'boolean', description: 'Whether to check platform AI-generated disclosure (default false).' },
        taskId: { type: 'string', maxLength: 64, description: 'Optional task ID in douyin-ops/<taskId>/post_task.json.' },
      },
      required: ['images', 'title', 'body'],
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
