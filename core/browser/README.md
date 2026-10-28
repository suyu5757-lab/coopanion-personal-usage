<!-- Owner: world.ts, guard.ts, actions.ts, submission-status.ts, app/browser.cjs, app/browser-agent/entry.ts, app/browser-agent/comments.ts, app/browser-agent/chatgpt.ts -->

# core/browser

Coo's own browser window as a World. It is separate from computer use: the person's mouse never moves, and the
window has its own Chromium profile and logins.

- `bridge.ts` sends `companion:browser` messages to the Electron main process and receives their results through
  `app/core-host.cjs`.
- `world.ts` exposes `browser_*` tools, reads the page through `app/browser-agent/entry.ts`, and refuses spending,
  private messages, account changes, passwords and personal details. A session has a time limit and a call budget.
- `app/browser.cjs` owns the window, the persistent partition, the permission policy and the page script injection.
- `browser_watch` takes a few frames over its wait and records the tab's audio for the same stretch. The Electron
  main process grants `getDisplayMedia` only during that call (`audio: request.frame`); `entry.ts` resamples the
  recording to 16 kHz mono WAV and `world.ts` hands it to the desktop pet's local speech model. `audio: false`
  skips the sound, and a failed recording leaves the frames in place.
- `app/browser-agent/entry.ts` wraps [`@page-agent/page-controller`](https://github.com/alibaba/page-agent) (MIT,
  Copyright (C) 2025 Alibaba Group Holding Limited; derived from browser-use, Copyright (c) 2024 Gregor Zunic).
  `scripts/stage.ts` bundles it into `build/browser-agent.js`; `pack.ts` ships that file. Its license is in
  `app/browser-agent/LICENSE`. Icon-only share controls are given an index and the name 分享 for one extraction
  pass, because the controller skips them inside a highlighted scroll container. `browser_share` hovers that
  control: Bilibili and Douyin open their share panel on hover, not on a click.
- ChatGPT image prompts are entered through the visible ChatGPT page in this profile; they do not use an OpenAI
  API key or Codex image generation. A dedicated save action accepts a verified PNG, JPEG or WebP download into
  `<data>/video/media`. Douyin uploads use an explicit list from `video_list_media` and the current page's file
  input. Selecting files only stages them in the form; `world.ts` refuses Creator Center publish controls so the
  person reviews the form and clicks Publish.
- The assembly's shared ActionGate currently refuses every desktop CUA input because the driver has no
  trusted browser-origin contract. Mouse, keyboard, drag, focus and accessibility input cannot be used as
  a replacement for a refused Browser action. Screenshots and window observation remain available.
- A comment reply is available only when the page agent binds its box to one visible author and comment on a
  post. Confirmation rechecks that row's SHA-256 evidence after the person approves. A reply-specific success
  notice is required to finish the action; otherwise the journal stays unresolved, and the hashed comment
  fingerprint blocks another attempt after restart.

The quiet-time trigger is Cormini's existing heartbeat (`../../vendor/cortico/bots/cormini/persona/heartbeat.ts`):
`core/companion.ts` sets `tickDelayMs` from `companion.selfTime`, and `core/persona.ts` replaces the quiet line with
`selfTimeLine` while the setting is on. The World's own timer closes a browsing session at its limit unless `companion.selfTime.sessionUnlimited` is on; the call budget still ends it.
