<!-- Owner: entry.ts -->

# browser-agent

Coo's browser page script. `entry.ts` wraps [`@page-agent/page-controller`](https://github.com/alibaba/page-agent)
and is bundled by `scripts/stage.ts` into `build/browser-agent.js`; `app/browser.cjs` injects that file after each
page load. The controller reads the page into a numbered list of interactive elements and performs clicks, typing,
scrolling and dropdown picks inside the page, so the browser window needs no Playwright, CDP port or remote debugger.

The wrapper exposes only reading and element actions. It does not expose arbitrary JavaScript execution, login
fields or payment controls; those limits live in `core/browser/world.ts`, which decides what the bot may call.
