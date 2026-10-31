const { createHash, randomUUID } = require('node:crypto');

const MAX_FRAME_DEPTH = 8;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Maps one frame-local CSS viewport point through verified parent iframe boxes. */
function mapFramePointToMain(point, hops) {
  if (!point || !finite(point.x) || !finite(point.y) || !Array.isArray(hops) || hops.length > MAX_FRAME_DEPTH) {
    return { ok: false, reason: 'invalid' };
  }
  let x = point.x, y = point.y;
  for (const hop of hops) {
    if (!hop || hop.connected !== true || hop.visible !== true || hop.hit !== true
      || hop.transformed !== false || hop.zoomed !== false
      || !finite(hop.left) || !finite(hop.top) || !finite(hop.clientLeft) || !finite(hop.clientTop)
      || !finite(hop.offsetWidth) || !finite(hop.offsetHeight) || !finite(hop.rectWidth) || !finite(hop.rectHeight)
      || !finite(hop.clientWidth) || !finite(hop.clientHeight)
      || !finite(hop.parentViewportWidth) || !finite(hop.parentViewportHeight)) {
      return { ok: false, reason: hop?.hit === false ? 'covered' : 'unsupported-frame' };
    }
    if (hop.offsetWidth <= 0 || hop.offsetHeight <= 0 || hop.clientWidth <= 0 || hop.clientHeight <= 0
      || hop.rectWidth <= 0 || hop.rectHeight <= 0
      || Math.abs(hop.rectWidth / hop.offsetWidth - 1) > 0.01
      || Math.abs(hop.rectHeight / hop.offsetHeight - 1) > 0.01) {
      return { ok: false, reason: 'unsupported-frame' };
    }
    x += hop.left + hop.clientLeft;
    y += hop.top + hop.clientTop;
    if (x < 0 || y < 0 || x > hop.parentViewportWidth || y > hop.parentViewportHeight) {
      return { ok: false, reason: 'offscreen' };
    }
  }
  return { ok: true, x, y };
}

function compositeSnapshotId(rootSnapshotId, frames) {
  if (typeof rootSnapshotId !== 'string' || !Array.isArray(frames)) return null;
  if (frames.length === 0) return rootSnapshotId;
  const evidence = frames.map((frame) => [frame.frameTreeNodeId, frame.frameToken, frame.url, frame.parentFrameToken,
    frame.parentUrl, frame.childSnapshotId, frame.viewportWidth, frame.viewportHeight, frame.hops]);
  return createHash('sha256').update(JSON.stringify([rootSnapshotId, evidence])).digest('hex').slice(0, 32);
}

async function inspectFrameHost(parent, child, point, timeoutMs = 1500) {
  if (!parent || !child || child.isDestroyed() || child.detached
    || !point || !finite(point.x) || !finite(point.y)) return null;
  let origin;
  try { origin = new URL(child.url).origin; } catch { return null; }
  if (!origin || origin === 'null') return null;
  const nonce = randomUUID();
  const expectedOrigin = JSON.stringify(origin);
  const frameToken = JSON.stringify(child.frameToken);
  const pointData = JSON.stringify({ x: point.x, y: point.y });
  const listener = `new Promise(resolve => {
    let complete = false;
    const done = value => { if (complete) return; complete = true; clearTimeout(timer); window.removeEventListener('message', receive); resolve(value); };
    const timer = setTimeout(() => done(null), ${Math.max(1, Math.floor(timeoutMs))});
    const receive = event => {
      const message = event.data;
      if (event.origin !== ${expectedOrigin} || message?.channel !== ${JSON.stringify(nonce)}
        || message?.frameToken !== ${frameToken}) return;
      const frame = Array.from(document.querySelectorAll('iframe')).find(candidate => candidate.contentWindow === event.source);
      if (!frame || !frame.isConnected || frame.getRootNode() !== document) return done(null);
      const rect = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      let transformed = false, zoomed = false;
      for (let ancestor = frame; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (ancestorStyle.transform && ancestorStyle.transform !== 'none') transformed = true;
        const zoom = ancestorStyle.getPropertyValue('zoom');
        if (zoom && zoom !== '1' && zoom !== 'normal') zoomed = true;
      }
      const mappedX = rect.left + frame.clientLeft + message.point.x;
      const mappedY = rect.top + frame.clientTop + message.point.y;
      const visible = frame.getClientRects().length > 0 && rect.width >= 16 && rect.height >= 16
        && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && style.opacity !== '0';
      done({ connected: frame.isConnected, visible, hit: document.elementFromPoint(mappedX, mappedY) === frame,
        transformed, zoomed, left: rect.left, top: rect.top, rectWidth: rect.width, rectHeight: rect.height,
        offsetWidth: frame.offsetWidth, offsetHeight: frame.offsetHeight, clientLeft: frame.clientLeft,
        clientTop: frame.clientTop, clientWidth: frame.clientWidth, clientHeight: frame.clientHeight,
        parentViewportWidth: window.innerWidth, parentViewportHeight: window.innerHeight });
    };
    window.addEventListener('message', receive);
  })`;
  const pending = parent.executeJavaScript(listener, true).catch(() => null);
  try {
    await child.executeJavaScript(`window.parent.postMessage({ channel: ${JSON.stringify(nonce)}, frameToken: ${frameToken}, point: ${pointData} }, '*')`, true);
    let timer;
    return await Promise.race([
      pending,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs + 100); }),
    ]).finally(() => clearTimeout(timer));
  } catch {
    return null;
  }
}

module.exports = { MAX_FRAME_DEPTH, compositeSnapshotId, inspectFrameHost, mapFramePointToMain };
