/**
 * Coo's browser window: one persistent, muted-by-default Chromium window that the browser World drives
 * through `{ type: 'companion:browser' }` messages relayed by core-host.cjs. The page script is
 * `build/browser-agent.js` (app/browser-agent/entry.ts, built by scripts/stage.ts); it is injected into the
 * page after every full load and exposes only reading, clicking, pointer positions, input preparation, scrolling and
 * video play/pause. The host types through Chromium so page editors receive real text input.
 *
 * The window has its own Chromium profile (`persist:coo-browser`), so signing in on Bilibili or Douyin does
 * not touch the person's browser. It is shown without focus, denies camera, microphone, location and
 * notification permission, cancels downloads, keeps public http(s) navigation in this one window, and
 * closes when the app quits. A page's `target=_blank` link is loaded here as well, not in a second window.
 * Requests to this machine and the local network are cancelled, so a page cannot reach the Core's console
 * or the pet's server.
 */
const { BrowserWindow, screen, session } = require('electron');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const PARTITION = 'persist:coo-browser';
const AGENT_FILE = ['build', 'browser-agent.js'];
const LOAD_TIMEOUT_MS = 25_000;
const SCRIPT_TIMEOUT_MS = 12_000;
const SETTLE_MS = 500;
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 760;
/** The largest screenshot sent to the model, whatever the window's device scale factor. */
const SHOT_MAX_WIDTH = 1280;
const SHOT_MAX_HEIGHT = 800;

/** A desktop Chrome user agent; Electron's own string makes some video sites refuse the page. */
function userAgent() {
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

const httpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch { return null; }
};

/**
 * Public pages only: the window must not reach the Core's own console, the pet server or another
 * service on this machine or the local network. IPv6 literals are refused outright; public sites use names.
 */
const PRIVATE_V4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const LOCAL_NAMES = ['.localhost', '.local', '.internal', '.lan', '.home'];
const isPublicHttp = (value) => {
  const url = httpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.startsWith('[')) return false;
  // public sites are named: a single label is an intranet name, and an IP literal is not needed
  if (!host.includes('.') || /^[0-9.]+$/.test(host)) return false;
  if (LOCAL_NAMES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return false;
  return !PRIVATE_V4.test(host);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `work` with a deadline; the page could be busy and never answer. */
function within(work, ms, what) {
  let timer;
  return Promise.race([
    work(),
    new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function createBrowserHost({ appRoot, icon, log = console, send }) {
  /** @type {import('electron').BrowserWindow | null} */
  let win = null;
  /** Whether the page script is present in the current document. */
  let injected = false;
  /** Whether the person's setting wants the tab silent. */
  let muted = true;
  /** The last page navigation that started, so a tool result knows the page that replaced the old one. */
  let navigating = false;
  let agent = null;

  const readAgent = () => {
    if (agent === null) {
      const file = join(appRoot, ...AGENT_FILE);
      if (!existsSync(file)) throw new Error('browser agent is not built; run pnpm run build:cortico');
      agent = readFileSync(file, 'utf8');
    }
    return agent;
  };

  const agentCall = async (method, args = []) => {
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    if (!injected) throw new Error('browser page is not ready; open a page or read it again');
    const expression = `window.__cooBrowserAgent.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    // the arguments are strings, numbers and plain option objects
    return within(() => win.webContents.executeJavaScript(expression, true), SCRIPT_TIMEOUT_MS, method);
  };

  const ensureAgent = async () => {
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    if (injected) return;
    await within(() => win.webContents.executeJavaScript(readAgent(), true), SCRIPT_TIMEOUT_MS, 'page script');
    injected = true;
    await agentCall('setMuted', [muted]);
  };

  const waitForLoad = async (start, settleMs = SETTLE_MS) => {
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    let timer;
    await Promise.race([
      start.then(() => true),
      new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('page load timed out')), LOAD_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    await sleep(settleMs);
  };

  /** After an action that may navigate or redraw: wait for the load, inject again, and read the page. */
  const settle = async () => {
    for (let i = 0; i < 50 && win && !win.isDestroyed() && (navigating || win.webContents.isLoading()); i++) await sleep(200);
    await sleep(SETTLE_MS);
    await ensureAgent();
    return state();
  };

  const load = async (url, settleMs = SETTLE_MS) => {
    const target = httpUrl(url);
    if (!target || !isPublicHttp(url)) throw new Error('only public http and https pages are opened');
    injected = false;
    navigating = true;
    const loaded = win.webContents.loadURL(target.href)
      .then(() => { navigating = false; })
      .catch((error) => { navigating = false; throw error; });
    await waitForLoad(loaded, settleMs);
    await ensureAgent();
    return state();
  };

  const state = async () => {
    const value = await agentCall('state');
    return value;
  };

  const capture = async () => {
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error('the page produced no image');
    const size = image.getSize();
    const scale = Math.min(1, SHOT_MAX_WIDTH / size.width, SHOT_MAX_HEIGHT / size.height);
    const shown = scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }) : image;
    const jpeg = shown.toJPEG(70);
    return { base64: jpeg.toString('base64'), width: shown.getSize().width, height: shown.getSize().height };
  };

  const press = async (key, index) => {
    if (index !== undefined) {
      const focused = await agentCall('focus', [index]);
      if (!focused) throw new Error(`no element at index ${index}`);
    }
    const codes = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Space: 'Space', Backspace: 'Backspace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown' };
    const code = codes[key];
    if (!code) throw new Error(`key ${key} is not one of ${Object.keys(codes).join(', ')}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code });
    await sleep(250);
  };

  const closeWindow = () => {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    injected = false;
  };

  const ensureWindow = () => {
    if (win && !win.isDestroyed()) return win;
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WINDOW_WIDTH, Math.max(680, area.width - 160));
    const height = Math.min(WINDOW_HEIGHT, Math.max(520, area.height - 200));
    const ses = session.fromPartition(PARTITION);
    ses.setSpellCheckerEnabled(false);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    // no request of this window reaches this machine or the local network, not even a subresource
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !isPublicHttp(details.url) }));
    win = new BrowserWindow({
      width, height,
      x: Math.max(area.x, area.x + area.width - width - 48),
      // leave the bottom of the screen to the pet
      y: Math.max(area.y, area.y + area.height - height - 120),
      minWidth: 640, minHeight: 480,
      title: 'Coo', icon,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0f1115',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        webviewTag: false,
        navigateOnDragDrop: false,
      },
    });
    const wc = win.webContents;
    wc.setUserAgent(userAgent());
    wc.setAudioMuted(muted);
    wc.setWindowOpenHandler(({ url }) => {
      if (isPublicHttp(url)) void load(url).catch((error) => log.warn('[browser] popup load failed', error.message));
      return { action: 'deny' };
    });
    const onlyPublic = (event, url) => { if (!isPublicHttp(url)) event.preventDefault(); };
    wc.on('will-navigate', onlyPublic);
    wc.on('will-redirect', onlyPublic);
    wc.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || /^about:(blank|srcdoc)$/.test(event.url)) return;
      if (!isPublicHttp(event.url)) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    // a page does not take the whole screen from the person; video stays in Coo's window
    wc.on('enter-html-full-screen', () => { if (win && !win.isDestroyed()) win.setFullScreen(false); });
    // only a new main document replaces the page script; iframes and in-page routes keep it
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      injected = false;
      navigating = true;
    });
    wc.on('did-finish-load', () => { injected = false; navigating = false; });
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      navigating = false;
      if (code !== -3) log.warn('[browser] page failed', { code, description, url });
    });
    wc.on('render-process-gone', (_event, details) => log.warn('[browser] renderer gone', details));
    wc.on('page-title-updated', (event, title) => {
      event.preventDefault();
      const shown = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      win?.setTitle(shown ? `Coo · ${shown}` : 'Coo');
    });
    win.once('ready-to-show', () => win?.showInactive());
    win.on('closed', () => {
      win = null;
      injected = false;
      navigating = false;
      send?.({ type: 'companion:browser-event', event: 'closed' });
    });
    return win;
  };

  const open = async (message) => {
    if (typeof message.muted === 'boolean') muted = message.muted;
    const target = httpUrl(message.url);
    if (!target || !isPublicHttp(message.url)) throw new Error('only public http and https pages are opened');
    ensureWindow();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
    win.webContents.setAudioMuted(muted);
    return load(target.href, 900);
  };

  const result = async (message) => {
    const op = message.op;
    if (op === 'open') return open(message);
    if (op === 'close') { closeWindow(); return { closed: true }; }
    if (op === 'state') return { open: !!win && !win.isDestroyed(), url: win?.webContents.getURL() ?? '', title: win?.getTitle() ?? '' };
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    if (op === 'config') {
      muted = message.muted !== false;
      win.webContents.setAudioMuted(muted);
      if (injected) await agentCall('setMuted', [muted]);
      return { muted };
    }
    if (op === 'read') { await ensureAgent(); return state(); }
    if (op === 'text') { await ensureAgent(); return agentCall('text'); }
    if (op === 'element') { await ensureAgent(); return agentCall('element', [message.index]); }
    if (op === 'click') {
      await ensureAgent();
      if (typeof message.text === 'string' && message.text.trim()) {
        const point = await agentCall('textCenter', [message.text.trim()]);
        if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') throw new Error(`no visible element with text ${message.text.trim()}`);
        const x = Math.round(point.x), y = Math.round(point.y);
        // Some controls only respond to a real click, so this path moves the pointer and clicks at the element's center.
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        await sleep(200);
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await sleep(250);
        return { answer: { success: true, message: `clicked ${message.text.trim()}` }, state: await settle() };
      }
      const answer = await agentCall('click', [message.index]);
      return { answer, state: await settle() };
    }
    if (op === 'input') {
      await ensureAgent();
      if (!await agentCall('prepareInput', [message.index])) throw new Error(`element ${message.index} is not a text box`);
      // Editors keep their own state; only real text insertion updates it.
      win.webContents.insertText(String(message.text ?? ''));
      await sleep(150);
      return { state: await settle() };
    }
    if (op === 'hover') {
      await ensureAgent();
      const point = await agentCall('center', [message.index]);
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') throw new Error(`no element at index ${message.index}`);
      // A real pointer move is what turns CSS :hover on; the page's synthetic events do not.
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
      await sleep(250);
      return { state: await settle() };
    }
    if (op === 'scroll') {
      await ensureAgent();
      const answer = await agentCall('scroll', [{ down: message.down !== false, numPages: Number(message.pages) || 1, ...(Number.isInteger(message.index) ? { index: message.index } : {}) }]);
      return { answer, state: await settle() };
    }
    if (op === 'press') {
      await ensureAgent();
      await press(message.key, message.index);
      return { state: await settle() };
    }
    if (op === 'play') {
      await ensureAgent();
      const answer = await agentCall('play', [message.pause === true]);
      await sleep(200);
      return { answer, state: await state() };
    }
    if (op === 'screenshot') {
      await ensureAgent();
      return { ...(await capture()), state: await state() };
    }
    if (op === 'back') {
      if (!win.webContents.navigationHistory.canGoBack()) return { back: false, state: await state() };
      injected = false;
      navigating = true;
      win.webContents.navigationHistory.goBack();
      await sleep(1200);
      await ensureAgent();
      return { back: true, state: await state() };
    }
    throw new Error(`unknown browser operation ${op}`);
  };

  return {
    async handle(message) {
      if (!message || typeof message.id !== 'number') return;
      try {
        const value = await result(message);
        send?.({ type: 'companion:browser-result', id: message.id, ok: true, result: value });
      } catch (error) {
        send?.({ type: 'companion:browser-result', id: message.id, ok: false, error: String(error?.message ?? error) });
      }
    },
    close() {
      closeWindow();
    },
    get open() { return !!win && !win.isDestroyed(); },
  };
}

module.exports = { createBrowserHost };
