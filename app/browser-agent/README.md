<!-- Owner: entry.ts, comments.ts, chatgpt.ts -->

# browser-agent

Coo's browser page script. `entry.ts` wraps [`@page-agent/page-controller`](https://github.com/alibaba/page-agent)
and is bundled by `scripts/stage.ts` into `build/browser-agent.js`; `app/browser.cjs` injects that file after each
page load. The controller reads the page into a numbered list of interactive elements and performs clicks, pointer
hovers, scrolling and dropdown picks. The host inserts text through Chromium, so editors that keep their own state receive real input.
The browser window needs no Playwright, CDP port or remote debugger.

The wrapper exposes page reading and guarded element actions. ChatGPT-specific helpers identify its message box
and a visible image save control beside a loaded image. File inputs are reported separately with a page-local id,
accept value and multiple flag; the app host uses that id to bind an explicit upload to the current page snapshot.
It does not expose arbitrary JavaScript execution, login fields or payment controls; those limits live in
`core/browser/world.ts`, which decides what the bot may call.

Comment reply boxes are reported only when `comments.ts` can bind one visible author and comment row to the box.
The page agent returns SHA-256 fingerprints and live evidence hashes; the Core uses those to check the target
again after approval without writing comment text into the durable reply ledger.
