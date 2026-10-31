/**
 * Coo's browser window: one persistent, muted-by-default Chromium window that the browser World drives
 * through `{ type: 'companion:browser' }` messages relayed by core-host.cjs. The page script is
 * `build/browser-agent.js` (app/browser-agent/entry.ts, built by scripts/stage.ts); it is injected into the
 * page after every full load and exposes reading, element actions, video play/pause, opening a share panel and
 * ChatGPT image controls. The host types through Chromium so page editors receive real text input.
 *
 * The window has its own Chromium profile (`persist:coo-browser`), so signing in on ChatGPT, Bilibili or Douyin does
 * not touch the person's browser. It is shown without focus, denies camera, microphone, location and
 * notification permission, refuses downloads except one checked ChatGPT image save into the video media folder,
 * keeps public http(s) navigation in this one window, and
 * closes when the app quits. A page's `target=_blank` link is loaded here as well, not in a second window.
 * The app uses Electron's internal debugger only to set a validated media selection on a page file input; it
 * does not open a remote debugging port.
 * Requests to this machine and the local network are cancelled, so a page cannot reach the Core's console
 * or the pet's server.
 */
const { BrowserWindow, screen, session } = require('electron');
const { randomUUID } = require('node:crypto');
const { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { MAX_IMAGE_BYTES, generatedImagePath, isChatGPTImageDownloadUrl, isChatGPTPageUrl, verifyGeneratedImage } = require('./browser-image-download.cjs');
const { acceptsUpload, isDouyinPageUrl, resolveUploadFiles } = require('./browser-upload.cjs');
const { imagePointToViewport } = require('./browser-visual-point.cjs');
const { compositeSnapshotId, inspectFrameHost, mapFramePointToMain: mapFramePoint } = require('./browser-frame-bridge.cjs');
const { isPublicResolvedHost } = require('./browser-network-policy.cjs');
const { setFileInputFiles } = require('./browser-cdp-upload.cjs');

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
 * service on this machine or the local network. URL checks are followed by resolved-address checks.
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
/** A tab recording decodes its audio in the page after the stop; give that call more room than a page read. */
const AUDIO_TIMEOUT_MS = 30_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Runs `work` with a deadline; the page could be busy and never answer. */
function within(work, ms, what) {
  let timer;
  return Promise.race([
    work(),
    new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function createBrowserHost({ appRoot, icon, log = console, send, mediaDir = () => null, partition = PARTITION, resolveHostForUrl }) {
  /** @type {import('electron').BrowserWindow | null} */
  let win = null;
  /** Whether the page script is present in the current document. */
  let injected = false;
  /** Whether the person's setting wants the tab silent. */
  let muted = true;
  /** The last page navigation that started, so a tool result knows the page that replaced the old one. */
  let navigating = false;
  /** A browser_watch is recording the tab; the page's display-media request is granted only then. */
  let audioCaptureRequested = false;
  let agent = null;
  /** One verified ChatGPT image download requested by Coo's image-save tool. */
  let pendingImageDownload = null;
  /** The latest screenshot's one-use viewport mapping. */
  let activeVisualCapture = null;
  let compositeStateCache = null;
  let nextFrameTargetId = 2_000_000_000;
  let activeTextFrame = null;
  const frameTargetIds = new Map();
  const frameTargets = new Map();
  /** Images downloaded for hash review but not yet approved for the media folder. */
  const stagedChatGPTImages = new Map();
  const clearStagedChatGPTImages = () => {
    for (const staged of stagedChatGPTImages.values()) {
      try { unlinkSync(staged.stagedPath); } catch { /* a staged image may already be gone */ }
    }
    stagedChatGPTImages.clear();
  };
  const clearOrphanedChatGPTImages = (directory) => {
    for (const name of readdirSync(directory)) {
      if (!/^chatgpt-image-\d+-[0-9a-f-]{36}\.(png|jpg|webp)$/i.test(name)) continue;
      const file = join(directory, name);
      try { if (lstatSync(file).isFile()) unlinkSync(file); } catch { /* a staging file may already be gone */ }
    }
  };

  const finishImageDownload = (pending, error, value) => {
    if (pendingImageDownload !== pending) return;
    pendingImageDownload = null;
    clearTimeout(pending.timer);
    if (error && pending.item) {
      try { pending.item.cancel(); } catch { /* the download may already have ended */ }
    }
    if (error) pending.reject(error instanceof Error ? error : new Error(String(error)));
    else pending.resolve(value);
  };

  const waitForImageDownload = (mediaDir) => {
    if (pendingImageDownload) throw new Error('a ChatGPT image download is already in progress');
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const pending = { mediaDir, seen: false, resolve, reject, timer: null };
    pending.timer = setTimeout(() => finishImageDownload(pending, new Error('ChatGPT image download timed out')), IMAGE_DOWNLOAD_TIMEOUT_MS);
    pendingImageDownload = pending;
    return { promise, cancel: (error) => finishImageDownload(pending, error || new Error('ChatGPT image download was cancelled')) };
  };

  const handleImageDownload = (event, item, contents) => {
    const pending = pendingImageDownload;
    if (!pending) { event.preventDefault(); return; }
    if (pending.seen) { event.preventDefault(); item.cancel(); return; }
    const pageUrl = contents === win?.webContents ? contents.getURL() : '';
    const mime = String(item.getMimeType() || '').toLowerCase().split(';')[0].trim();
    if (!isChatGPTPageUrl(pageUrl) || !isChatGPTImageDownloadUrl(item.getURL()) || !mime.startsWith('image/')) {
      event.preventDefault();
      item.cancel();
      finishImageDownload(pending, new Error('the download did not come from a ChatGPT image save control'));
      return;
    }
    let target;
    try {
      if (item.getTotalBytes() > MAX_IMAGE_BYTES) throw new Error('ChatGPT image download exceeds 40 MB');
      target = generatedImagePath(pending.mediaDir, mime);
      item.setSavePath(target.file);
      pending.seen = true;
    } catch (error) {
      event.preventDefault();
      item.cancel();
      finishImageDownload(pending, error);
      return;
    }
    item.on('updated', () => {
      if (item.getReceivedBytes() > MAX_IMAGE_BYTES) item.cancel();
    });
    item.once('done', (_doneEvent, state) => {
      const removePartial = () => { try { unlinkSync(target.file); } catch { /* no file was written */ } };
      if (state !== 'completed') {
        removePartial();
        return finishImageDownload(pending, new Error(`ChatGPT image download ${state}`));
      }
      try {
        const verified = verifyGeneratedImage(target.file, mime);
        finishImageDownload(pending, null, { file: target.name, bytes: verified.bytes, mime: target.mime });
      } catch (error) {
        removePartial();
        finishImageDownload(pending, error);
      }
    });
    pending.item = item;
  };

  const restoreMute = () => {
    if (win && !win.isDestroyed()) win.webContents.setAudioMuted(muted);
  };

  const readAgent = () => {
    if (agent === null) {
      const file = join(appRoot, ...AGENT_FILE);
      if (!existsSync(file)) throw new Error('browser agent is not built; run pnpm run build:cortico');
      agent = readFileSync(file, 'utf8');
    }
    return agent;
  };

  const isPublicDestination = async (value) => {
    const target = httpUrl(value);
    if (!target || !isPublicHttp(value)) return false;
    try {
      const resolver = resolveHostForUrl
        ? () => resolveHostForUrl(target.hostname)
        : () => session.fromPartition(partition).resolveHost(target.hostname, { cacheUsage: 'allowed' });
      const resolved = await within(resolver, 2500, 'public destination check');
      return isPublicResolvedHost(resolved);
    } catch {
      return false;
    }
  };

  const frameAgentCall = async (frame, method, args = [], timeout = SCRIPT_TIMEOUT_MS) => {
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    if (!injected) throw new Error('browser page is not ready; open a page or read it again');
    if (!frame || frame.isDestroyed() || frame.detached) throw new Error('browser frame is no longer attached');
    const expression = `window.__cooBrowserAgent.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return within(() => frame.executeJavaScript(expression, true), timeout, method);
  };

  const rootAgentCall = async (method, args = [], timeout = SCRIPT_TIMEOUT_MS) => {
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    if (!injected) throw new Error('browser page is not ready; open a page or read it again');
    return frameAgentCall(win.webContents.mainFrame, method, args, timeout);
  };

  const crossOriginFrame = async (frame) => {
    if (!frame?.parent || frame.isDestroyed() || frame.detached) return false;
    try {
      return await within(() => frame.executeJavaScript(`(() => {
        try { void window.parent.location.href; return false; }
        catch { return true; }
      })()`, true), 1000, 'frame origin check') === true;
    } catch { return false; }
  };

  const ensureFrameAgent = async (frame) => {
    if (!frame || frame.isDestroyed() || frame.detached) throw new Error('browser frame is no longer attached');
    const ready = await frame.executeJavaScript("window.__cooBrowserAgent?.version === 1", true).catch(() => false);
    if (!ready) await within(() => frame.executeJavaScript(readAgent(), true), SCRIPT_TIMEOUT_MS, 'frame page script');
    await frame.executeJavaScript(`window.__cooBrowserAgent.setMuted(${JSON.stringify(muted)})`, true);
  };

  const mapFramePointToMain = async (frame, localPoint) => {
    const main = win?.webContents.mainFrame;
    if (!main || !frame || !localPoint || !Number.isFinite(localPoint.x) || !Number.isFinite(localPoint.y)) {
      return { ok: false, reason: 'invalid' };
    }
    let current = frame;
    let point = { x: localPoint.x, y: localPoint.y };
    const hops = [];
    while (current !== main && hops.length < 8) {
      const geometry = await inspectFrameHost(current.parent, current, point);
      if (!geometry) return { ok: false, reason: 'unsupported-frame' };
      const mapped = mapFramePoint(point, [geometry]);
      if (!mapped.ok) return mapped;
      hops.push({ frameToken: current.frameToken, frameTreeNodeId: current.frameTreeNodeId,
        parentFrameToken: current.parent?.frameToken ?? '', url: current.url, parentUrl: current.parent?.url ?? '',
        ...geometry });
      point = { x: mapped.x, y: mapped.y };
      current = current.parent;
    }
    if (current !== main) return { ok: false, reason: 'unsupported-frame' };
    return { ok: true, ...point, hops };
  };

  const frameTargetId = (frame, localId) => {
    const key = `${frame.frameTreeNodeId}:${frame.frameToken}:${localId}`;
    let id = frameTargetIds.get(key);
    if (id === undefined) { id = nextFrameTargetId++; frameTargetIds.set(key, id); }
    return id;
  };

  const visibleCrossFrameStates = async () => {
    const main = win?.webContents.mainFrame;
    if (!main) return [];
    const frames = main.framesInSubtree.filter((frame) => frame !== main && frame.parent);
    const results = [];
    for (const frame of frames) {
      if (!await crossOriginFrame(frame)) continue;
      try {
        const frameUrl = frame.url;
        if (!httpUrl(frameUrl) || !await isPublicDestination(frameUrl)) continue;
        await ensureFrameAgent(frame);
        const viewport = await frameAgentCall(frame, 'viewport');
        if (!Number.isFinite(viewport?.width) || !Number.isFinite(viewport?.height) || viewport.width <= 0 || viewport.height <= 0) continue;
        const center = { x: viewport.width / 2, y: viewport.height / 2 };
        const position = await mapFramePointToMain(frame, center);
        if (!position.ok) continue;
        const value = await frameAgentCall(frame, 'state');
        if (!value?.snapshotId) continue;
        results.push({ frame, state: value, viewport, position });
      } catch {
        // A frame that navigates or stops responding during inspection is omitted.
      }
    }
    return results;
  };

  const agentCall = async (method, args = [], timeout = SCRIPT_TIMEOUT_MS) => {
    if (method === 'state') return state();
    if (method === 'snapshot') return (await state())?.snapshotId ?? '';
    if (method === 'resolveLocator') return resolveLocator(args[0], args[1]);
    if (method === 'element') return frameElement(args[0]);
    if (method === 'textCenter') return frameTextCenter(args[0]);
    if (method === 'click') return frameClick(args[0], args[1]);
    if (method === 'pointTarget') return framePointTarget(args[0], args[1], args[2]);
    if (method === 'center') return frameMethod('center', args[0], args[1]);
    if (method === 'focus' || method === 'prepareInput') return frameMethod(method, args[0], args[1]);
    if (method === 'scroll') return frameScroll(args[0], args[1]);
    if (method === 'setAgentAction') {
      const value = await rootAgentCall(method, args, timeout);
      if (activeTextFrame) await frameAgentCall(activeTextFrame, method, args, timeout).catch(() => undefined);
      if (args[0] === false) activeTextFrame = null;
      return value;
    }
    return rootAgentCall(method, args, timeout);
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

  const collectState = async () => {
    const root = await rootAgentCall('state');
    if (!root?.snapshotId) return root;
    const frames = await visibleCrossFrameStates();
    const evidence = frames.map(({ frame, state: frameState, viewport, position }) => ({
      frameTreeNodeId: frame.frameTreeNodeId,
      frameToken: frame.frameToken,
      url: frame.url,
      parentFrameToken: frame.parent?.frameToken ?? '',
      parentUrl: frame.parent?.url ?? '',
      childSnapshotId: frameState.snapshotId,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      hops: position.hops,
    }));
    const snapshotId = compositeSnapshotId(root.snapshotId, evidence) ?? root.snapshotId;
    const elements = Array.isArray(root.elements) ? [...root.elements] : [];
    const content = [typeof root.content === 'string' ? root.content : ''];
    for (const [id, target] of frameTargets) {
      if (target.compositeSnapshotId !== snapshotId) frameTargets.delete(id);
    }
    for (const { frame, state: frameState, viewport, position } of frames) {
      const recordBase = {
        frame,
        frameToken: frame.frameToken,
        frameTreeNodeId: frame.frameTreeNodeId,
        frameSnapshotId: frameState.snapshotId,
        compositeSnapshotId: snapshotId,
        viewport,
        hops: position.hops,
      };
      const title = String(frameState.title ?? '').trim();
      const url = String(frameState.url ?? frame.url);
      if (typeof frameState.content === 'string' && frameState.content.trim()) {
        content.push(`[Embedded frame: ${title || url}]\n${frameState.content}`);
      }
      for (const element of Array.isArray(frameState.elements) ? frameState.elements : []) {
        if (!Number.isInteger(element.id)) continue;
        const id = frameTargetId(frame, element.id);
        const record = { ...recordBase, id, localId: element.id, label: String(element.label ?? '') };
        frameTargets.set(id, record);
        elements.push({ id, label: record.label, ...(typeof element.pressed === 'boolean' ? { pressed: element.pressed } : {}) });
      }
    }
    const value = { ...root, content: content.join('\n\n'), elements, snapshotId };
    compositeStateCache = { root, frames, evidence, state: value, snapshotId };
    return value;
  };

  const state = async () => collectState();

  const resolveLocator = async (locator, expectedSnapshotId) => {
    const current = await state();
    if (!expectedSnapshotId || current?.snapshotId !== expectedSnapshotId || !compositeStateCache) {
      return { ok: false, reason: 'stale-snapshot' };
    }
    const matches = [];
    const rootResult = await rootAgentCall('resolveLocator', [locator, compositeStateCache.root.snapshotId]);
    if (rootResult?.reason === 'ambiguous') return { ok: false, reason: 'ambiguous' };
    if (rootResult?.ok === true) matches.push({ id: rootResult.id });
    for (const { frame, state: frameState, viewport, position } of compositeStateCache.frames) {
      let result;
      try { result = await frameAgentCall(frame, 'resolveLocator', [locator, frameState.snapshotId]); }
      catch { continue; }
      if (result?.reason === 'ambiguous') return { ok: false, reason: 'ambiguous' };
      if (result?.ok !== true) continue;
      const id = frameTargetId(frame, result.id);
      frameTargets.set(id, {
        frame,
        frameToken: frame.frameToken,
        frameTreeNodeId: frame.frameTreeNodeId,
        frameSnapshotId: frameState.snapshotId,
        compositeSnapshotId: current.snapshotId,
        viewport,
        hops: position.hops,
        id,
        localId: result.id,
        locator,
      });
      matches.push({ id });
    }
    if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
    if (!matches.length) return { ok: false, reason: rootResult?.reason === 'invalid' ? 'invalid' : 'none' };
    return { ok: true, id: matches[0].id, snapshotId: current.snapshotId };
  };

  const frameElement = async (id) => {
    const prior = compositeStateCache;
    if (!prior) return null;
    const current = await state();
    if (!prior || current?.snapshotId !== prior.snapshotId) return null;
    const frameTarget = frameTargets.get(id);
    try {
      const value = frameTarget
        ? await frameAgentCall(frameTarget.frame, 'element', [frameTarget.localId])
        : await rootAgentCall('element', [id]);
      if (!value) return null;
      return { ...value, id, snapshotId: current.snapshotId };
    } catch { return null; }
  };

  const frameMethod = async (method, id, expectedSnapshotId) => {
    const prior = compositeStateCache;
    if (!prior) return method === 'center' ? null : false;
    const current = await state();
    if (current?.snapshotId !== prior.snapshotId || (expectedSnapshotId && expectedSnapshotId !== prior.snapshotId)) {
      return method === 'center' ? null : false;
    }
    const target = frameTargets.get(id);
    if (!target) return rootAgentCall(method, [id, compositeStateCache.root.snapshotId]);
    let result;
    try { result = await frameAgentCall(target.frame, method, [target.localId, target.frameSnapshotId]); }
    catch { return method === 'center' ? null : false; }
    if (method !== 'center' || !result) return result;
    const mapped = await mapFramePointToMain(target.frame, result);
    if (!mapped.ok) return null;
    const after = await state();
    return after?.snapshotId === prior.snapshotId ? { x: mapped.x, y: mapped.y } : null;
  };

  const frameScroll = async (options, expectedSnapshotId) => {
    const prior = compositeStateCache;
    if (!prior) return { success: false, message: 'stale snapshot' };
    const current = await state();
    if (current?.snapshotId !== prior.snapshotId || (expectedSnapshotId && expectedSnapshotId !== prior.snapshotId)) {
      return { success: false, message: 'stale snapshot' };
    }
    const index = Number.isInteger(options?.index) ? options.index : null;
    const target = index === null ? null : frameTargets.get(index);
    if (!target) return rootAgentCall('scroll', [options, compositeStateCache.root.snapshotId]);
    return frameAgentCall(target.frame, 'scroll', [{ ...options, index: target.localId }, target.frameSnapshotId]);
  };

  const framePointTarget = async (x, y, expectedSnapshotId) => {
    const current = await state();
    if (!current?.snapshotId || current.snapshotId !== expectedSnapshotId || !compositeStateCache) {
      return { ok: false, reason: 'stale-snapshot' };
    }
    const root = await rootAgentCall('pointTarget', [x, y, compositeStateCache.root.snapshotId]);
    if (root?.ok === true) return { ...root, target: { ...root.target, snapshotId: current.snapshotId } };
    return root;
  };

  const frameTextCenter = async (query) => {
    const before = await state();
    if (!before?.snapshotId || !compositeStateCache) return { ok: false, reason: 'stale-snapshot' };
    const matches = [];
    const root = await rootAgentCall('textCenter', [query]);
    if (root?.ok === true) matches.push({ point: root, frame: null });
    else if (root?.reason === 'ambiguous') return { ok: false, reason: 'ambiguous' };
    for (const { frame, state: frameState } of compositeStateCache.frames) {
      let point;
      try { point = await frameAgentCall(frame, 'textCenter', [query]); }
      catch { continue; }
      if (point?.reason === 'ambiguous') return { ok: false, reason: 'ambiguous' };
      if (point?.ok !== true) continue;
      const mapped = await mapFramePointToMain(frame, point);
      if (mapped.ok) matches.push({ point: mapped, frame, frameSnapshotId: frameState.snapshotId });
    }
    const after = await state();
    if (after?.snapshotId !== before.snapshotId) return { ok: false, reason: 'stale-snapshot' };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
    if (!matches.length) return { ok: false, reason: root?.reason || 'none' };
    activeTextFrame = matches[0].frame;
    return { ok: true, x: matches[0].point.x, y: matches[0].point.y, snapshotId: before.snapshotId };
  };

  const frameClick = async (id, expectedSnapshotId) => {
    const before = await state();
    if (!before?.snapshotId || before.snapshotId !== expectedSnapshotId || !compositeStateCache) {
      return { success: false, message: 'stale snapshot' };
    }
    const target = frameTargets.get(id);
    if (!target) return rootAgentCall('click', [id, compositeStateCache.root.snapshotId]);
    if (target.compositeSnapshotId !== before.snapshotId || target.frame.isDestroyed() || target.frame.detached
      || target.frame.frameToken !== target.frameToken) return { success: false, message: 'stale snapshot' };
    const point = await frameAgentCall(target.frame, 'actionPoint', [target.localId, target.frameSnapshotId]);
    if (point?.ok !== true) return { success: false, message: point?.reason || 'target is not actionable' };
    const mapped = await mapFramePointToMain(target.frame, point);
    if (!mapped.ok) return { success: false, message: mapped.reason || 'unsupported frame' };
    const after = await state();
    if (after?.snapshotId !== before.snapshotId || target.frame.isDestroyed() || target.frame.detached) {
      return { success: false, message: 'stale snapshot' };
    }
    let dispatched = false;
    try {
      await frameAgentCall(target.frame, 'setAgentAction', [true]);
      const x = Math.round(mapped.x), y = Math.round(mapped.y);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      dispatched = true;
      return { success: true, message: 'click dispatched through the current frame point' };
    } catch (error) {
      return { success: dispatched, message: String(error?.message ?? error) };
    } finally {
      await frameAgentCall(target.frame, 'setAgentAction', [false]).catch(() => undefined);
    }
  };

  const resetFrameState = () => {
    compositeStateCache = null;
    frameTargets.clear();
    activeTextFrame = null;
  };

  const load = async (url, settleMs = SETTLE_MS) => {
    const target = httpUrl(url);
    if (!target || !await isPublicDestination(target.href)) throw new Error('only public http and https pages are opened');
    injected = false;
    resetFrameState();
    activeVisualCapture = null;
    navigating = true;
    const loaded = win.webContents.loadURL(target.href)
      .then(() => { navigating = false; })
      .catch((error) => { navigating = false; throw error; });
    await waitForLoad(loaded, settleMs);
    await ensureAgent();
    return state();
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

  const captureForVisualClick = async () => {
    await ensureAgent();
    const before = await state();
    const viewport = await agentCall('viewport');
    if (!before?.snapshotId || !Number.isFinite(viewport?.width) || !Number.isFinite(viewport?.height)
      || viewport.width <= 0 || viewport.height <= 0) throw new Error('the page has no stable screenshot viewport');
    const image = await capture();
    const after = await state();
    const currentViewport = await agentCall('viewport');
    if (!after?.snapshotId || after.snapshotId !== before.snapshotId || after.url !== before.url
      || currentViewport?.width !== viewport.width || currentViewport?.height !== viewport.height) {
      throw new Error('the page changed while the screenshot was taken; read it again');
    }
    const captureId = randomUUID();
    activeVisualCapture = {
      captureId,
      url: after.url,
      snapshotId: after.snapshotId,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      imageWidth: image.width,
      imageHeight: image.height,
      createdAt: Date.now(),
      used: false,
    };
    return { ...image, state: after, captureId, viewportWidth: viewport.width, viewportHeight: viewport.height };
  };

  const inspectVisualPoint = async (message, allowUsed = false) => {
    const capture = activeVisualCapture;
    const x = Number(message.x), y = Number(message.y);
    if (!capture || message.captureId !== capture.captureId || (capture.used && !allowUsed)
      || Date.now() - capture.createdAt > 30_000) throw new Error('the screenshot capture expired; take a new screenshot');
    if (message.snapshotId !== undefined && message.snapshotId !== capture.snapshotId) throw new Error('the screenshot snapshot does not match');
    const mapped = imagePointToViewport(capture, { x, y });
    if (!mapped) throw new Error('the screenshot point is outside the captured image');
    if (!win || win.isDestroyed() || win.webContents.getURL() !== capture.url) throw new Error('the page changed after the screenshot');
    await ensureAgent();
    const page = await state();
    const viewport = await agentCall('viewport');
    if (page?.snapshotId !== capture.snapshotId || page.url !== capture.url
      || viewport?.width !== capture.viewportWidth || viewport?.height !== capture.viewportHeight) {
      throw new Error('the page or viewport changed after the screenshot');
    }
    const { x: cssX, y: cssY } = mapped;
    const point = await agentCall('pointTarget', [cssX, cssY, capture.snapshotId]);
    if (point?.ok !== true || !point.target?.token || point.target.snapshotId !== capture.snapshotId) {
      throw new Error(point?.reason || 'the screenshot point is not a current interactive target');
    }
    return { capture, cssX, cssY, target: point.target };
  };

  const press = async (key, index, expectedSnapshotId) => {
    if (expectedSnapshotId && await agentCall('snapshot') !== expectedSnapshotId) throw new Error('the page changed; read it again');
    if (index !== undefined) {
      const focused = await agentCall('focus', [index, expectedSnapshotId]);
      if (!focused) throw new Error(`no element at index ${index} or the page changed`);
    }
    const codes = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Space: 'Space', Backspace: 'Backspace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown' };
    const code = codes[key];
    if (!code) throw new Error(`key ${key} is not one of ${Object.keys(codes).join(', ')}`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code });
    if (key === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: code });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code });
    await sleep(250);
  };

  const closeWindow = () => {
    if (pendingImageDownload) finishImageDownload(pendingImageDownload, new Error('browser window closed'));
    clearStagedChatGPTImages();
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    injected = false;
    resetFrameState();
    activeVisualCapture = null;
  };

  const ensureWindow = () => {
    if (win && !win.isDestroyed()) return win;
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WINDOW_WIDTH, Math.max(680, area.width - 160));
    const height = Math.min(WINDOW_HEIGHT, Math.max(520, area.height - 200));
    const ses = session.fromPartition(partition);
    ses.setSpellCheckerEnabled(false);
    // only the page script's own recording may ask for display media; everything else stays denied
    const capturePermission = (permission, details) => {
      if (!audioCaptureRequested) return false;
      if (permission === 'display-capture') return true;
      if (permission !== 'media') return false;
      // getDisplayMedia asks with no media types; a direct getUserMedia names audio or video
      const types = details && details.mediaTypes;
      return !Array.isArray(types) || types.length === 0;
    };
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(capturePermission(permission, details)));
    ses.setPermissionCheckHandler((_contents, permission) => audioCaptureRequested && (permission === 'display-capture' || permission === 'media'));
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame;
      if (!audioCaptureRequested || !frame) { callback({}); return; }
      // the whole tab's audio, not this machine's or another window's; echo off keeps it silent
      callback({ audio: frame });
    });
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', handleImageDownload);
    // Check the session's resolved endpoints before every HTTP request, including frame subresources.
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      void isPublicDestination(details.url)
        .then((allowed) => callback({ cancel: !allowed }))
        .catch(() => callback({ cancel: true }));
    });
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
        partition,
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
      activeVisualCapture = null;
      if (event.isMainFrame || /^about:(blank|srcdoc)$/.test(event.url)) return;
      if (!isPublicHttp(event.url)) event.preventDefault();
    });
    wc.on('did-navigate-in-page', () => { activeVisualCapture = null; });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    // a page does not take the whole screen from the person; video stays in Coo's window
    wc.on('enter-html-full-screen', () => { if (win && !win.isDestroyed()) win.setFullScreen(false); });
    // only a new main document replaces the page script; iframes and in-page routes keep it
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      injected = false;
      navigating = true;
      resetFrameState();
      activeVisualCapture = null;
      audioCaptureRequested = false;
      restoreMute();
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
      clearStagedChatGPTImages();
      win = null;
      injected = false;
      resetFrameState();
      activeVisualCapture = null;
      navigating = false;
      audioCaptureRequested = false;
      send?.({ type: 'companion:browser-event', event: 'closed' });
    });
    return win;
  };

  const open = async (message) => {
    if (typeof message.muted === 'boolean') muted = message.muted;
    const target = httpUrl(message.url);
    if (!target || !await isPublicDestination(target.href)) throw new Error('only public http and https pages are opened');
    ensureWindow();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
    win.webContents.setAudioMuted(muted);
    return load(target.href, 900);
  };

  const generateChatGPTImage = async (message) => {
    if (!win || !isChatGPTPageUrl(win.webContents.getURL())) throw new Error('open chatgpt.com in this browser first');
    const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
    if (!prompt || prompt.length > 2000) throw new Error('prompt must be 1 to 2000 characters');
    await ensureAgent();
    const target = await agentCall('chatGPTComposer');
    if (!target?.ok) throw new Error(target?.reason || 'the ChatGPT message box could not be identified');
    if ((message.composerId && target.id !== message.composerId)
      || (message.snapshotId && target.snapshotId !== message.snapshotId)) throw new Error('the ChatGPT composer changed after approval');
    const before = await agentCall('draft', [target.id, target.snapshotId]);
    if (typeof before !== 'string' || before.trim()) throw new Error('the ChatGPT message box already contains text; read it before continuing');
    if (!await agentCall('prepareInput', [target.id, target.snapshotId])) throw new Error('the ChatGPT message box changed before typing');

    const fullPrompt = `Create an image based on this prompt:\n\n${prompt}`;
    await agentCall('setAgentAction', [true]);
    try {
      win.webContents.insertText(fullPrompt);
      await sleep(150);
      const current = await agentCall('chatGPTComposer');
      if (!current?.ok) throw new Error(current?.reason || 'the ChatGPT message box changed after typing');
      const draft = await agentCall('draft', [current.id, current.snapshotId]);
      if (draft !== fullPrompt) throw new Error('the visible ChatGPT draft did not match the image prompt');
      await press('Enter', current.id, current.snapshotId);
    } finally {
      await agentCall('setAgentAction', [false]).catch(() => undefined);
    }

    const outcome = await agentCall('chatGPTSubmission', [fullPrompt]);
    const screenshot = await capture().catch(() => null);
    return {
      submitted: outcome?.submitted === true,
      state: outcome?.state ?? await state(),
      ...(screenshot ?? {}),
    };
  };

  const stageChatGPTImage = async (message) => {
    if (!win || !isChatGPTPageUrl(win.webContents.getURL())) throw new Error('the current page is not ChatGPT');
    const index = Number.isInteger(message.index) && message.index >= 0 ? message.index : null;
    if (index === null) throw new Error('image save target needs a page element number');
    await ensureAgent();
    if (!await agentCall('chatGPTImageSaveTarget', [index, message.snapshotId])) throw new Error('the selected control is not a visible ChatGPT image save button');
    const dir = mediaDir();
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('the video media directory is unavailable');
    const stageDir = join(dirname(dir), 'work', 'browser-image-staging');
    mkdirSync(stageDir, { recursive: true });
    if (!stagedChatGPTImages.size) clearOrphanedChatGPTImages(stageDir);
    const transfer = waitForImageDownload(stageDir);
    let stagedPath = '';
    try {
      await agentCall('setAgentAction', [true]);
      try {
        const answer = await agentCall('click', [index, message.snapshotId]);
        if (answer?.success === false) throw new Error(answer.message || 'the image save button could not be clicked');
      } finally {
        await agentCall('setAgentAction', [false]).catch(() => undefined);
      }
      const saved = await transfer.promise;
      stagedPath = join(stageDir, saved.file);
      const verified = verifyGeneratedImage(stagedPath, saved.mime);
      const destination = generatedImagePath(dir, saved.mime);
      const stageToken = randomUUID();
      const page = await settle();
      const pageUrl = win.webContents.getURL();
      if (!page?.snapshotId || page.url !== pageUrl || !isChatGPTPageUrl(pageUrl)) throw new Error('the ChatGPT page changed while the image was staged');
      stagedChatGPTImages.set(stageToken, {
        stagedPath,
        destinationPath: destination.file,
        file: destination.name,
        mime: saved.mime,
        bytes: verified.bytes,
        digest: verified.digest,
        pageUrl,
        snapshotId: page.snapshotId,
        expiresAt: Date.now() + 5 * 60_000,
      });
      const screenshot = await capture().catch(() => null);
      return {
        stageToken,
        file: destination.name,
        bytes: verified.bytes,
        mime: saved.mime,
        digest: verified.digest,
        ...(screenshot ?? {}),
        ...(page ? { state: page } : {}),
      };
    } catch (error) {
      transfer.cancel(error);
      if (stagedPath) { try { unlinkSync(stagedPath); } catch { /* the failed transfer may already have removed it */ } }
      throw error;
    }
  };

  const commitStagedChatGPTImage = async (message) => {
    const stageToken = typeof message.stageToken === 'string' ? message.stageToken : '';
    const staged = stagedChatGPTImages.get(stageToken);
    if (!staged) throw new Error('the staged ChatGPT image is unavailable');
    stagedChatGPTImages.delete(stageToken);
    if (Date.now() > staged.expiresAt) {
      try { unlinkSync(staged.stagedPath); } catch { /* expired file may already be gone */ }
      throw new Error('the staged ChatGPT image expired; inspect the page and start again');
    }
    if (!win || win.isDestroyed() || win.webContents.getURL() !== staged.pageUrl || !isChatGPTPageUrl(staged.pageUrl)) {
      try { unlinkSync(staged.stagedPath); } catch { /* a staged image may already be gone */ }
      throw new Error('the ChatGPT page changed after the image approval');
    }
    if (message.file !== staged.file || message.bytes !== staged.bytes || message.digest !== staged.digest
      || message.mime !== staged.mime || message.snapshotId !== staged.snapshotId) {
      try { unlinkSync(staged.stagedPath); } catch { /* a staged image may already be gone */ }
      throw new Error('the staged image does not match the approved file');
    }
    try {
      await ensureAgent();
      if (await agentCall('snapshot') !== staged.snapshotId) throw new Error('the ChatGPT page changed after the image approval');
      const current = verifyGeneratedImage(staged.stagedPath, staged.mime);
      if (current.bytes !== staged.bytes || current.digest !== staged.digest) throw new Error('the staged image changed after approval');
    } catch (error) {
      try { unlinkSync(staged.stagedPath); } catch { /* a staged image may already be gone */ }
      throw error;
    }
    let copied = false;
    try {
      copyFileSync(staged.stagedPath, staged.destinationPath, constants.COPYFILE_EXCL);
      copied = true;
      const saved = verifyGeneratedImage(staged.destinationPath, staged.mime);
      if (saved.bytes !== staged.bytes || saved.digest !== staged.digest) throw new Error('the saved image does not match the approved file');
      unlinkSync(staged.stagedPath);
      return { file: staged.file, bytes: saved.bytes, mime: staged.mime, digest: saved.digest };
    } catch (error) {
      if (copied) { try { unlinkSync(staged.destinationPath); } catch { /* remove only the file copied above */ } }
      try { unlinkSync(staged.stagedPath); } catch { /* a staged image may already be gone */ }
      throw error;
    }
  };

  const discardStagedChatGPTImage = (message) => {
    const stageToken = typeof message.stageToken === 'string' ? message.stageToken : '';
    const staged = stagedChatGPTImages.get(stageToken);
    if (!staged) return { discarded: false };
    stagedChatGPTImages.delete(stageToken);
    try { unlinkSync(staged.stagedPath); } catch { /* staged file may already be gone */ }
    return { discarded: true };
  };

  const uploadMedia = async (message) => {
    if (!win || !isDouyinPageUrl(win.webContents.getURL())) throw new Error('open a Douyin upload page first');
    if (!Number.isInteger(message.fileId) || message.fileId < 0) throw new Error('a current file input id is required');
    const dir = mediaDir();
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('the video media directory is unavailable');
    const files = await resolveUploadFiles(dir, message.files);
    const expectedFiles = Array.isArray(message.expectedFiles) ? message.expectedFiles : [];
    if (expectedFiles.length !== files.length || expectedFiles.some((item, index) => !item || item.path !== files[index]?.name
      || item.bytes !== files[index]?.bytes || item.digest !== files[index]?.digest || item.mime !== files[index]?.mime)) {
      throw new Error('the selected media changed after approval');
    }
    await ensureAgent();
    const target = await agentCall('fileInputTarget', [message.fileId, message.snapshotId]);
    if (!target?.ok) throw new Error(target?.reason || 'the file input changed; read the page again');
    try {
      if (!target.multiple && files.length > 1) throw new Error('the page input accepts one file at a time');
      const refused = files.find((file) => !acceptsUpload(target.accept, file));
      if (refused) throw new Error(`${refused.name} does not match the page input accept value`);
      const existing = await agentCall('fileInputSelection', [message.fileId]);
      if (existing?.names?.length) throw new Error('the page input already has files selected; read the preview before changing it');
      if (!isDouyinPageUrl(win.webContents.getURL()) || await agentCall('snapshot') !== target.snapshotId) throw new Error('the upload page changed; read it again');
      await setFileInputFiles(win.webContents.debugger, target.token, files.map((file) => file.path));
    } finally {
      await agentCall('releaseFileInput', [target.token]).catch(() => undefined);
    }
    let selection = null;
    const expected = files.map((file) => file.visibleName);
    for (let attempt = 0; attempt < 20; attempt++) {
      selection = await agentCall('fileInputSelection', [message.fileId]).catch(() => null);
      if (Array.isArray(selection?.names) && selection.names.join('\n') === expected.join('\n')) break;
      await sleep(100);
    }
    if (!Array.isArray(selection?.names) || selection.names.join('\n') !== expected.join('\n')) throw new Error('the page did not confirm the selected files; read the page before deciding whether to try again');
    const page = await settle().catch(() => null);
    const screenshot = await capture().catch(() => null);
    return { files: files.map((file) => file.name), ...(page ? { state: page } : {}), ...(screenshot ?? {}) };
  };

  const inspectUpload = async (message) => {
    if (!win || !isDouyinPageUrl(win.webContents.getURL())) throw new Error('open a Douyin upload page first');
    if (!Number.isInteger(message.fileId) || message.fileId < 0) throw new Error('a current file input id is required');
    const dir = mediaDir();
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('the video media directory is unavailable');
    const files = await resolveUploadFiles(dir, message.files);
    await ensureAgent();
    const target = await agentCall('fileInputTarget', [message.fileId, message.snapshotId]);
    if (!target?.ok) throw new Error(target?.reason || 'the file input changed; read the page again');
    if (!target.multiple && files.length > 1) throw new Error('the page input accepts one file at a time');
    const refused = files.find((file) => !acceptsUpload(target.accept, file));
    if (refused) throw new Error(`${refused.name} does not match the page input accept value`);
    const existing = await agentCall('fileInputSelection', [message.fileId]);
    if (existing?.names?.length) throw new Error('the page input already has files selected; read the preview before changing it');
    if (!isDouyinPageUrl(win.webContents.getURL()) || await agentCall('snapshot') !== target.snapshotId) throw new Error('the upload page changed; read it again');
    const state = await agentCall('state');
    return {
      url: win.webContents.getURL(),
      snapshotId: target.snapshotId,
      accept: target.accept,
      multiple: target.multiple,
      account: state?.account ?? null,
      files: files.map((file) => ({ path: file.name, bytes: file.bytes, digest: file.digest, mime: file.mime })),
    };
  };

  const result = async (message) => {
    const op = message.op;
    if (!['state', 'screenshot', 'inspect-screenshot-point', 'click-screenshot-point', 'element', 'active', 'read', 'find', 'resolveLocator'].includes(op)) {
      activeVisualCapture = null;
    }
    if (op === 'open') return open(message);
    if (op === 'chatgpt-composer') {
      if (!win || !isChatGPTPageUrl(win.webContents.getURL())) throw new Error('open chatgpt.com in this browser first');
      await ensureAgent();
      const target = await agentCall('chatGPTComposer');
      if (!target?.ok || typeof target.id !== 'string' || typeof target.snapshotId !== 'string') {
        throw new Error(target?.reason || 'the ChatGPT message box could not be identified');
      }
      return { id: target.id, snapshotId: target.snapshotId };
    }
    if (op === 'chatgpt-generate-image') return generateChatGPTImage(message);
    if (op === 'stage-chatgpt-image') return stageChatGPTImage(message);
    if (op === 'commit-staged-chatgpt-image') return commitStagedChatGPTImage(message);
    if (op === 'discard-staged-chatgpt-image') return discardStagedChatGPTImage(message);
    if (op === 'inspect-upload') return inspectUpload(message);
    if (op === 'upload-media') return uploadMedia(message);
    if (op === 'close') { closeWindow(); return { closed: true }; }
    if (op === 'state') return { open: !!win && !win.isDestroyed(), url: win?.webContents.getURL() ?? '', title: win?.getTitle() ?? '' };
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    if (op === 'config') {
      muted = message.muted !== false;
      win.webContents.setAudioMuted(muted);
      if (injected) await agentCall('setMuted', [muted]);
      return { muted };
    }
    if (op === 'audio-start') {
      await ensureAgent();
      audioCaptureRequested = true;
      // the tab's own output must be live for the capture; the handler keeps it from reaching the speakers
      win.webContents.setAudioMuted(false);
      try {
        const answer = await agentCall('startAudio', [], AUDIO_TIMEOUT_MS);
        if (!answer?.ok) { audioCaptureRequested = false; restoreMute(); }
        return answer;
      } catch (error) {
        audioCaptureRequested = false;
        restoreMute();
        throw error;
      }
    }
    if (op === 'audio-stop') {
      try {
        await ensureAgent();
        return await agentCall('stopAudio', [], AUDIO_TIMEOUT_MS);
      } finally {
        audioCaptureRequested = false;
        restoreMute();
      }
    }
    if (op === 'read') { await ensureAgent(); return state(); }
    if (op === 'text') { await ensureAgent(); return agentCall('text'); }
    if (op === 'element') { await ensureAgent(); return agentCall('element', [message.index]); }
    if (op === 'resolveLocator') { await ensureAgent(); return agentCall('resolveLocator', [message.locator, message.expectedSnapshotId]); }
    if (op === 'active') { await ensureAgent(); return agentCall('active'); }
    if (op === 'share') {
      await ensureAgent();
      const point = await agentCall('shareCenter');
      if (!point?.ok) throw new Error(point?.reason === 'ambiguous' ? 'ambiguous share target' : 'no share control on this page');
      if (await agentCall('snapshot') !== point.snapshotId) throw new Error('the page changed; read it again');
      const x = Math.round(point.x), y = Math.round(point.y);
      // The panel renders a moment after the pointer arrives; polling avoids clicking a panel that is still opening.
      const opened = async () => {
        for (let i = 0; i < 20; i++) {
          if (await agentCall('shareOpen')) return true;
          await sleep(100);
        }
        return false;
      };
      // Douyin and Bilibili open their share panel on hover; a click would close it again on Douyin.
      await agentCall('setAgentAction', [true]);
      try {
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        if (!await opened()) {
          // Other sites may open the same panel on a click; Douyin opens it on hover.
          win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          if (!await opened()) throw new Error('the share panel did not open');
        }
      } finally {
        await agentCall('setAgentAction', [false]).catch(() => undefined);
      }
      return { answer: { success: true, message: 'share panel opened' }, state: await settle() };
    }
    if (op === 'click') {
      await ensureAgent();
      if (typeof message.text === 'string' && message.text.trim()) {
        const point = await agentCall('textCenter', [message.text.trim()]);
        if (!point?.ok) throw new Error(point?.reason === 'ambiguous' ? 'ambiguous text target' : point?.reason === 'file' ? 'file chooser target is blocked' : `no visible element with text ${message.text.trim()}`);
        if (await agentCall('snapshot') !== point.snapshotId) throw new Error('the page changed; read it again');
        const x = Math.round(point.x), y = Math.round(point.y);
        await agentCall('setAgentAction', [true]);
        try {
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          await sleep(200);
          const currentPoint = await agentCall('textCenter', [message.text.trim()]);
          if (!currentPoint?.ok || currentPoint.snapshotId !== point.snapshotId
            || Math.abs(currentPoint.x - point.x) > 0.5 || Math.abs(currentPoint.y - point.y) > 0.5) {
            throw new Error('the target changed or became blocked before the click; read the page again');
          }
          win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          await sleep(250);
        } finally {
          await agentCall('setAgentAction', [false]).catch(() => undefined);
        }
        return { answer: { success: true, message: `clicked ${message.text.trim()}` }, state: await settle() };
      }
      await agentCall('setAgentAction', [true]);
      try {
        const answer = await agentCall('click', [message.index, message.snapshotId]);
        if (answer?.success === false) throw new Error(answer.message || 'click refused');
        return { answer, state: await settle() };
      } finally {
        await agentCall('setAgentAction', [false]).catch(() => undefined);
      }
    }
    if (op === 'input') {
      await ensureAgent();
      if (!await agentCall('prepareInput', [message.index, message.snapshotId])) throw new Error(`element ${message.index} is not a text box or the page changed`);
      // Editors keep their own state; only real text insertion updates it.
      await agentCall('setAgentAction', [true]);
      try {
        win.webContents.insertText(String(message.text ?? ''));
        await sleep(150);
      } finally {
        await agentCall('setAgentAction', [false]).catch(() => undefined);
      }
      return { state: await settle() };
    }
    if (op === 'hover') {
      await ensureAgent();
      const point = await agentCall('center', [message.index, message.snapshotId]);
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') throw new Error(`no element at index ${message.index}`);
      // A real pointer move is what turns CSS :hover on; the page's synthetic events do not.
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
      await sleep(250);
      return { state: await settle() };
    }
    if (op === 'scroll') {
      await ensureAgent();
      const answer = await agentCall('scroll', [{ down: message.down !== false, numPages: Number(message.pages) || 1, ...(Number.isInteger(message.index) ? { index: message.index } : {}) }, message.snapshotId]);
      return { answer, state: await settle() };
    }
    if (op === 'inspect-screenshot-point') {
      return inspectVisualPoint(message);
    }
    if (op === 'click-screenshot-point') {
      let before;
      try {
        before = await inspectVisualPoint(message);
        if (before.target.token !== message.targetToken) throw new Error('the screenshot target changed before approval');
      } catch (error) {
        return { answer: { success: false, message: String(error?.message ?? error) }, state: await state().catch(() => null) };
      }
      const capture = before.capture;
      capture.used = true;
      let dispatched = false;
      try {
        await agentCall('setAgentAction', [true]);
      } catch (error) {
        activeVisualCapture = null;
        return { answer: { success: false, message: String(error?.message ?? error) }, state: await state().catch(() => null) };
      }
      try {
        const x = Math.round(before.cssX), y = Math.round(before.cssY);
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        await sleep(120);
        let current;
        try { current = await inspectVisualPoint(message, true); }
        catch (error) {
          return { answer: { success: false, message: String(error?.message ?? error) }, state: await state().catch(() => null) };
        }
        if (current.target.token !== before.target.token
          || Math.abs(current.cssX - before.cssX) > 0.5 || Math.abs(current.cssY - before.cssY) > 0.5) {
          return { answer: { success: false, message: 'the target changed after pointer movement; take a new screenshot' }, state: await state().catch(() => null) };
        }
        dispatched = true;
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await sleep(250);
      } catch (error) {
        if (dispatched) return { answer: { success: true, message: 'click dispatched; page result unavailable' }, state: null };
        return { answer: { success: false, message: String(error?.message ?? error) }, state: await state().catch(() => null) };
      } finally {
        await agentCall('setAgentAction', [false]).catch(() => undefined);
        if (activeVisualCapture === capture) activeVisualCapture = null;
      }
      try { return { answer: { success: true, message: 'screenshot target clicked once' }, state: await settle() }; }
      catch { return { answer: { success: true, message: 'click dispatched; page result unavailable' }, state: null }; }
    }
    if (op === 'press') {
      await ensureAgent();
      await agentCall('setAgentAction', [true]);
      try {
        await press(message.key, message.index, message.snapshotId);
      } finally {
        await agentCall('setAgentAction', [false]).catch(() => undefined);
      }
      return { state: await settle() };
    }
    if (op === 'play') {
      await ensureAgent();
      const answer = await agentCall('play', [message.pause === true]);
      await sleep(200);
      return { answer, state: await state() };
    }
    if (op === 'screenshot') {
      return captureForVisualClick();
    }
    if (op === 'back') {
      if (!win.webContents.navigationHistory.canGoBack()) return { back: false, state: await state() };
      injected = false;
      resetFrameState();
      activeVisualCapture = null;
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
