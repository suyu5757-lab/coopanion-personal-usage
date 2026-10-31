<!-- Owner: accessible-name.ts, targets.ts, entry.ts, comments.ts, chatgpt.ts -->

# browser-agent

Coo's browser page script. `entry.ts` wraps [`@page-agent/page-controller`](https://github.com/alibaba/page-agent)
and is bundled by `scripts/stage.ts` into `build/browser-agent.js`; `app/browser.cjs` injects that file after each
page load. The controller reads the page into a numbered list of interactive elements and performs clicks, pointer
hovers, scrolling and dropdown picks. The host inserts text through Chromium, so editors that keep their own state receive real input.
The browser window needs no Playwright, CDP port or remote debugger.

`accessible-name.ts` computes the supported role/name subset and open composed-tree traversal; `targets.ts` resolves
strict locators and checks actionability. `entry.ts` also identifies a visible target under one exact viewport point,
bound to the page snapshot, for the Browser World to use only with a one-use screenshot capture and user approval.

The wrapper exposes page reading and guarded element actions. ChatGPT-specific helpers identify its message box
and a visible image save control beside a loaded image. File inputs are reported separately with a page-local id,
accept value and multiple flag; the app host uses that id to bind an explicit upload to the current page snapshot.
It does not expose arbitrary JavaScript execution. `core/browser/world.ts` refuses login and payment controls and
decides which page actions the bot may call.

Comment reply boxes are reported only when `comments.ts` can bind one visible author and comment row to the box.
The page agent returns SHA-256 fingerprints and live evidence hashes; the Core uses those to check the target
again after approval without writing comment text into the durable reply ledger.
