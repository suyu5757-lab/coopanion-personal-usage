<!-- Owner: world.ts, app/browser.cjs -->

# core/browser

Coo's own browser window as a World. It is separate from computer use: the person's mouse never moves, and the
window has its own Chromium profile and logins.

- `bridge.ts` sends `companion:browser` messages to the Electron main process and receives their results through
  `app/core-host.cjs`.
- `world.ts` exposes `browser_*` tools, reads the page through `app/browser-agent/entry.ts`, and refuses spending,
  private messages, account changes, passwords and personal details. A session has a time limit and a call budget.
- `app/browser.cjs` owns the window, the persistent partition, the permission policy and the page script injection.
- `app/browser-agent/entry.ts` wraps [`@page-agent/page-controller`](https://github.com/alibaba/page-agent) (MIT,
  Copyright (C) 2025 Alibaba Group Holding Limited; derived from browser-use, Copyright (c) 2024 Gregor Zunic).
  `scripts/stage.ts` bundles it into `build/browser-agent.js`; `pack.ts` ships that file. Its license is in
  `app/browser-agent/LICENSE`.

The quiet-time trigger is Cormini's existing heartbeat (`../../vendor/cortico/bots/cormini/persona/heartbeat.ts`):
`core/companion.ts` sets `tickDelayMs` from `companion.selfTime`, and `core/persona.ts` replaces the quiet line with
`selfTimeLine` while the setting is on. The World's own timer closes a browsing session at its limit unless `companion.selfTime.sessionUnlimited` is on; the call budget still ends it.
