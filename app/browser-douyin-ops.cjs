/**
 * S3 Douyin Creator Center automation helpers for `app/browser.cjs`:
 * - Account binding verification with nickname/ID normalization (`checkAccount`)
 * - Idempotent graphic-post form filling with Slate/Draft.js full-select clear, hashtag commit & readback snapshot (`fillPost`)
 * - Publish button trigger with content-hash idempotency lock & early exit (`publishPost`)
 * - Content management post-list scraping with 20s hard cap & aweme_id extraction (`checkPosts`)
 * - One-shot compound pipeline (`preparePost`: open/reuse upload page -> upload images -> fill post -> readback snapshot)
 * - Comment management reading & replying (`fetchComments`, `replyComment`)
 */
const { createHash } = require('node:crypto');
const { isDouyinPageUrl } = require('./browser-upload.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const UPLOAD_IMAGE_URL = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3';
const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';
const COMMENT_URL = 'https://creator.douyin.com/creator-micro/interactive/comment';
const CHECK_POSTS_TIMEOUT_MS = 25_000;
const PUBLISH_LOCK_TTL_MS = 30 * 60_000;
const MANAGE_REUSE_TTL_MS = 15_000;

/** Process-scoped idempotency lock: contentHash -> { publishedAt, status, postId, postUrl }. */
const publishLocks = new Map();
let lastManageLoadedAt = 0;

function normalizeStr(value) {
  return String(value ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeBodyForCompare(value) {
  return String(value ?? '')
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

/**
 * Extracts normalized core nickname & numeric/alphanumeric Douyin ID.
 * Examples:
 * - "@肥鱼本鱼" -> { nick: "肥鱼本鱼", id: "" }
 * - "肥鱼本鱼 (抖音号 78274536111)" -> { nick: "肥鱼本鱼", id: "78274536111" }
 * - "78274536111" -> { nick: "", id: "78274536111" }
 */
function normalizeAccountIdentity(raw) {
  const s = normalizeStr(raw);
  if (!s) return { nick: '', id: '' };
  const idMatch = s.match(/抖音号[：:\s]*([A-Za-z0-9._-]{3,40})/);
  let id = idMatch ? idMatch[1].trim().toLowerCase() : '';
  let stripped = s
    .replace(/[（(][^）)]*抖音号[^）)]*[）)]/g, ' ')
    .replace(/抖音号[：:\s]*[A-Za-z0-9._-]{3,40}/g, ' ')
    .replace(/^[@＠]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!id && /^[0-9]{5,24}$/.test(stripped)) {
    id = stripped.toLowerCase();
    stripped = '';
  }
  return { nick: stripped.toLowerCase(), id };
}

function accountMatches(expected, observed) {
  const expRaw = normalizeStr(expected);
  if (!expRaw) return true;
  if (observed && observed.loggedIn === false) return false;
  const exp = normalizeAccountIdentity(expRaw);
  const obsName = normalizeAccountIdentity(observed?.accountName || '');
  const obsId = normalizeStr(observed?.accountId || obsName.id).toLowerCase();
  const obsRef = normalizeAccountIdentity(observed?.accountRef || '');

  const obsIds = [obsId, obsName.id, obsRef.id].filter(Boolean);
  const obsNicks = [obsName.nick, obsRef.nick].filter(Boolean);
  if (!obsIds.length && !obsNicks.length) return false;

  if (exp.id && obsIds.length && obsIds.includes(exp.id)) return true;
  if (exp.nick && obsNicks.length) {
    if (obsNicks.some((n) => n === exp.nick)) return true;
    // Allow substring match only when both core nicknames have >= 2 chars (e.g., suffix decoration),
    // never matching empty strings or unrelated accounts.
    if (exp.nick.length >= 2 && obsNicks.some((n) => n.length >= 2 && (n.includes(exp.nick) || exp.nick.includes(n)))) {
      return true;
    }
  }
  return false;
}

function computePublishHash(accountRef, title, body, tags) {
  const payload = JSON.stringify([
    normalizeAccountIdentity(accountRef).nick || normalizeAccountIdentity(accountRef).id || '',
    normalizeStr(title),
    normalizeBodyForCompare(body),
    (Array.isArray(tags) ? tags : []).map((t) => String(t || '').replace(/^#+/, '').trim().toLowerCase()).filter(Boolean),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

function createDouyinOpsHandlers({ getWin, openUrl, uploadMedia, settle, capture }) {
  const requireDouyinWindow = async (fallbackUrl) => {
    let win = getWin();
    if (!win || win.isDestroyed()) {
      if (!fallbackUrl) throw new Error('browser window is closed; open creator.douyin.com first');
      await openUrl(fallbackUrl);
      win = getWin();
    }
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');
    const url = win.webContents.getURL();
    if (!isDouyinPageUrl(url)) {
      if (fallbackUrl) {
        await openUrl(fallbackUrl);
        win = getWin();
      } else {
        throw new Error(`current page is not Douyin Creator Center (${url || 'empty'})`);
      }
    }
    return win;
  };

  const clickPoint = async (win, pt) => {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
    const x = Math.round(pt.x);
    const y = Math.round(pt.y);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(50);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
    return true;
  };

  const sendSelectAllAndDelete = async (win) => {
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [mod] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [mod] });
    await sleep(60);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await sleep(60);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    await sleep(80);
  };

  /** Reads a structured snapshot of the current Douyin image-post editor form. */
  const readPostSnapshot = async (win) => {
    return win.webContents.executeJavaScript(`(() => {
      const titleSelectors = [
        'input[placeholder*="标题"]',
        'input[placeholder*="作品标题"]',
        'textarea[placeholder*="标题"]',
        '[class*="title"] input',
      ];
      let actualTitle = '';
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (!el || el.disabled) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 10) {
          actualTitle = String(el.value ?? '').trim();
          break;
        }
      }
      const bodySelectors = [
        '.zone-container[contenteditable="true"]',
        '[class*="editor"] [contenteditable="true"]',
        '[contenteditable="true"][data-placeholder*="作品简介"]',
        '[contenteditable="true"][data-placeholder*="描述"]',
        '[contenteditable="true"]',
        'textarea[placeholder*="描述"]',
        'textarea[placeholder*="简介"]',
      ];
      let actualBody = '';
      let hashtagCount = 0;
      for (const sel of bodySelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) {
          const rawBody = (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
            ? String(el.value ?? '')
            : String(el.innerText || el.textContent || '');
          // Strip Douyin's paragraph formatting bullet markers ("* " or leading "*") that Slate injects in innerText.
          actualBody = rawBody.replace(/(?:^|\\n)\\s*\\*\\s*(?=[\\u4e00-\\u9fa5A-Za-z0-9#])/g, (m) => m.includes('\\n') ? '\\n' : '');
          const hashMatches = actualBody.match(/#[^\\s#\\n]+/g);
          hashtagCount = hashMatches ? hashMatches.length : 0;
          break;
        }
      }
      const imgs = Array.from(document.querySelectorAll('img')).filter((img) => {
        if (!img.complete || img.naturalWidth < 40 || img.naturalHeight < 40) return false;
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || '';
        if (r.width < 28 || r.height < 28) return false;
        if (r.left > window.innerWidth * 0.58) return false; // exclude right-hand phone preview carousel clones
        if (/avatar|logo|icon|qrcode|cover/i.test((img.alt || '') + ' ' + (img.className || ''))) return false;
        return /^blob:|^data:image\\//i.test(src) || /tos-cn|douyinpic|byteimg|pstatp|douyin\\.com|creator-media|ibytedtos|bytedance|zijieapi/i.test(src);
      });
      const distinctImgSrcs = new Set(imgs.map((img) => (img.currentSrc || img.src || '').split('?')[0])).size;
      const bgCards = Array.from(document.querySelectorAll('[class*="image-item"], [class*="pic-item"], [class*="img-card"], [class*="preview-item"], [class*="thumb"], [class*="slide"], [style*="background-image"]'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.left > window.innerWidth * 0.58) return false;
          const bg = getComputedStyle(el).backgroundImage || '';
          return r.width >= 28 && r.height >= 28 && /url\\(/i.test(bg) && !/avatar|logo|icon/i.test(el.className || '');
        });
      let editSectionCount = 0;
      const editLabel = Array.from(document.querySelectorAll('div, span, label, p')).find((el) => el.children.length === 0 && /^编辑图片$/.test((el.innerText || '').trim()));
      if (editLabel) {
        let row = editLabel.parentElement;
        for (let depth = 0; row && depth < 4; depth++, row = row.parentElement) {
          const rowImgs = Array.from(row.querySelectorAll('img')).filter((img) => {
            const r = img.getBoundingClientRect();
            return r.width >= 40 && r.width <= 260 && r.height >= 40 && r.height <= 360 && !/avatar|logo|icon/i.test((img.alt || '') + ' ' + (img.className || ''));
          });
          const distinctRowImgs = new Set(rowImgs.map((img) => (img.currentSrc || img.src || '').split('?')[0])).size;
          const rowBgs = Array.from(row.querySelectorAll('[style*="background-image"], canvas')).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width >= 40 && r.width <= 260 && r.height >= 40 && r.height <= 360 && !/avatar|logo|icon/i.test(el.className || '');
          });
          const rowTiles = Array.from(row.querySelectorAll('[draggable="true"], [class*="image-item"], [class*="pic-item"], [class*="card-item"], [class*="img-item"], [class*="image-card"], [class*="pic-card"]')).filter((el) => {
            const r = el.getBoundingClientRect();
            const t = (el.innerText || '').trim();
            return r.width >= 50 && r.width <= 260 && r.height >= 50 && r.height <= 360 && !/添加|上传|编辑图片/.test(t);
          });
          const uniqueTiles = rowTiles.filter((el) => !rowTiles.some((other) => other !== el && el.contains(other)));
          const best = distinctRowImgs || rowBgs.length || uniqueTiles.length;
          if (best > 0 && best <= 35) {
            editSectionCount = best;
            break;
          }
          // Fallback: count uniform rectangular card boxes inside the sibling container beside "编辑图片"
          if (depth >= 1) {
            const siblingLists = Array.from(row.children).filter((c) => !c.contains(editLabel));
            for (const listEl of siblingLists) {
              const boxCandidates = Array.from(listEl.querySelectorAll(':scope > div, :scope > div > div')).filter((el) => {
                const r = el.getBoundingClientRect();
                const t = (el.innerText || '').trim();
                return r.width >= 60 && r.width <= 260 && r.height >= 60 && r.height <= 360 && !/添加|上传|编辑图片/.test(t);
              });
              const uniqueBoxes = boxCandidates.filter((el) => !boxCandidates.some((other) => other !== el && el.contains(other)));
              if (uniqueBoxes.length >= 1 && uniqueBoxes.length <= 35) {
                editSectionCount = uniqueBoxes.length;
                break;
              }
            }
            if (editSectionCount > 0) break;
          }
        }
      }
      let badgeCount = 0;
      for (const el of document.querySelectorAll('span, div')) {
        if (el.children.length > 0) continue;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 12) continue;
        const m = t.match(/^(?:共\\s*(\\d+)\\s*张|(\\d+)\\s*张图)$/);
        if (m) {
          const n = parseInt(m[1] || m[2], 10);
          if (n >= 1 && n <= 35) badgeCount = Math.max(badgeCount, n);
        }
      }
      const imageCount = editSectionCount > 0
        ? editSectionCount
        : Math.max(distinctImgSrcs || imgs.length, bgCards.length, badgeCount);
      let aiDeclarationChecked = false;
      const aiLabels = Array.from(document.querySelectorAll('label, [role="checkbox"], [role="switch"], [role="radio"]'));
      for (const el of aiLabels) {
        const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!/(?:内容由\\s*AI\\s*生成|包含\\s*AI\\s*生成|AI\\s*生成|人工智能生成)/i.test(txt)) continue;
        const inp = el instanceof HTMLInputElement ? el : el.querySelector('input[type="checkbox"], input[type="radio"]');
        if (inp?.checked || el.getAttribute('aria-checked') === 'true' || /checked|active|selected/i.test(String(el.className || ''))) {
          aiDeclarationChecked = true;
          break;
        }
      }
      // Inspect real music binding state (form row + right-hand phone preview + <audio> + shallow React Fiber music_id).
      const parseDurationSec = (raw) => {
        const m = String(raw || '').trim().match(/^(\\d{1,2}):(\\d{2})$/);
        return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0;
      };
      let musicSelected = false;
      let musicTitle = '';
      let musicDuration = '';
      let musicDurationSec = 0;
      let musicId = '';
      let musicRowEl = null;
      const musicLabel = Array.from(document.querySelectorAll('div, span, label, p')).find((el) => el.children.length === 0 && /^选择音乐$/.test((el.innerText || '').trim()));
      if (musicLabel) {
        let cur = musicLabel.parentElement;
        for (let d = 0; cur && d < 5; d++, cur = cur.parentElement) {
          const txt = (cur.innerText || '').replace(/\\r/g, '').trim();
          if (/修改音乐|更换音乐|点击添加合适作品风格音乐/.test(txt) || /\\b\\d{2}:\\d{2}\\b/.test(txt)) {
            if ((txt.match(/发布设置|谁可以看/g) || []).length === 0) {
              musicRowEl = cur;
              break;
            }
          }
        }
      }
      if (musicRowEl) {
        const rawLines = (musicRowEl.innerText || '').replace(/\\r/g, '').split('\\n').map((l) => l.trim()).filter(Boolean);
        const hasModify = rawLines.some((l) => /^(?:修改音乐|更换音乐)$/.test(l));
        const durLine = rawLines.find((l) => /^\\d{1,2}:\\d{2}$/.test(l)) || '';
        const titleLine = rawLines.find((l) => l.length >= 1 && !/^(?:扩展信息|选择音乐|修改音乐|更换音乐|点击添加合适作品风格音乐|删除|裁剪|取消|音乐|\\d{1,2}:\\d{2})$/.test(l)) || '';
        musicDuration = durLine;
        musicDurationSec = parseDurationSec(durLine);
        musicTitle = titleLine;
        musicSelected = Boolean(hasModify || (titleLine && !/点击添加/.test(titleLine)));
        const scanMusicId = (obj, depth = 0, seen = new Set()) => {
          if (!obj || typeof obj !== 'object' || depth > 3 || seen.has(obj)) return '';
          seen.add(obj);
          const idKeys = ['music_id', 'musicId', 'mid', 'music_id_str', 'id_str', 'id'];
          const looksLikeMusicObj = Boolean(obj.music_id || obj.musicId || obj.play_url || obj.playUrl || obj.music_info || obj.musicInfo || obj.author || obj.duration);
          if (looksLikeMusicObj) {
            for (const k of idKeys) {
              const v = obj[k];
              if (typeof v === 'string' && /^\\d{8,24}$/.test(v.trim())) return v.trim();
              if (typeof v === 'number' && Number.isSafeInteger(v) && String(v).length >= 8) return String(v);
            }
          }
          for (const k of Object.keys(obj).slice(0, 18)) {
            if (k.startsWith('_') || k === 'children' || k === 'stateNode' || k === 'return' || k === 'sibling' || k === 'child' || k === 'alternate') continue;
            if (!/music|audio|bgm|sound|value|data|form|info|track|clip/i.test(k) && depth > 0) continue;
            const v = obj[k];
            if (v && typeof v === 'object') {
              const hit = scanMusicId(v, depth + 1, seen);
              if (hit) return hit;
            }
          }
          return '';
        };
        const fiberNodes = [musicRowEl, ...Array.from(musicRowEl.querySelectorAll('span, button, div')).slice(0, 6)];
        for (const node of fiberNodes) {
          for (const k of Object.keys(node)) {
            if (!k.startsWith('__reactFiber$') && !k.startsWith('__reactProps$')) continue;
            let cur = node[k];
            for (let hop = 0; cur && hop < 8; hop++, cur = cur.return) {
              const hit = scanMusicId(cur.memoizedProps) || scanMusicId(cur.memoizedState);
              if (hit) { musicId = hit; break; }
            }
            if (musicId) break;
          }
          if (musicId) break;
        }
      }
      let previewMusicText = '';
      let previewShowsOriginalSound = false;
      const previewNodes = Array.from(document.querySelectorAll('div, span, p')).filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 8 || r.left < window.innerWidth * 0.5) return false;
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        return t.length >= 2 && t.length <= 90 && (t.includes('♪') || t.includes('创作的原声') || (musicTitle && t.includes(musicTitle.slice(0, 8))));
      });
      if (previewNodes.length) {
        const bestPrev = previewNodes.find((el) => (el.innerText || '').includes('♪'))
          || previewNodes.find((el) => musicTitle && (el.innerText || '').includes(musicTitle.slice(0, 8)))
          || previewNodes.find((el) => (el.innerText || '').includes('创作的原声'))
          || previewNodes[0];
        previewMusicText = (bestPrev.innerText || '').replace(/\\s+/g, ' ').replace(/^♪\\s*/, '').trim();
        previewShowsOriginalSound = /创作的原声|^原声$/.test(previewMusicText);
      } else {
        const fullTxt = (document.body?.innerText || '');
        if (/创作的原声/.test(fullTxt)) {
          previewShowsOriginalSound = true;
          const m = fullTxt.match(/[^\\n]*创作的原声[^\\n]*/);
          previewMusicText = m ? m[0].replace(/^♪\\s*/, '').trim() : '创作的原声';
        }
      }
      let audioSrc = '';
      let audioDuration = 0;
      for (const a of document.querySelectorAll('audio')) {
        const src = a.currentSrc || a.src || '';
        const dur = Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration) : 0;
        if (src && !audioSrc) audioSrc = src.slice(0, 160);
        if (dur > audioDuration) audioDuration = dur;
      }
      const effectiveDurationSec = Math.max(musicDurationSec, audioDuration);
      const previewMatchesTrack = Boolean(previewMusicText && !previewShowsOriginalSound);
      const musicImported = Boolean(musicSelected && musicTitle && effectiveDurationSec > 0 && !previewShowsOriginalSound && (previewMatchesTrack || Boolean(musicId) || Boolean(audioSrc)));
      let musicWarning = '';
      if (musicSelected && effectiveDurationSec === 0) {
        musicWarning = 'MUSIC_GHOST_ZERO_DURATION: UI displays music title with 00:00 duration (audio not actually bound; re-select via select_music)';
      } else if (musicSelected && previewShowsOriginalSound) {
        musicWarning = 'MUSIC_PREVIEW_STILL_ORIGINAL_SOUND: UI displays music title but preview still shows 创作的原声 (audio not actually bound)';
      }
      const music = {
        imported: musicImported,
        selected: musicSelected,
        title: musicTitle,
        duration: musicDuration,
        durationSec: effectiveDurationSec,
        musicId,
        audioSrc,
        previewMusicText,
        previewShowsOriginalSound,
        warning: musicWarning,
      };
      return {
        actualTitle,
        actualBody,
        hashtagCount,
        imageCount,
        aiDeclarationChecked,
        music,
        pageUrl: location.href,
      };
    })()`, true);
  };

  /** Reads the currently logged-in Douyin Creator Center nickname & ID. */
  const checkAccount = async (message = {}) => {
    const win = await requireDouyinWindow(message.navigate ? MANAGE_URL : null);
    const info = await win.webContents.executeJavaScript(`(() => {
      const bodyText = (document.body?.innerText || '').replace(/\\r/g, '');
      const idMatch = bodyText.match(/抖音号[：:\\s]*([A-Za-z0-9._-]{3,40})/);
      const accountId = idMatch ? idMatch[1].trim() : '';
      const nameSelectors = [
        '[class*="user-name"]',
        '[class*="nickname"]',
        '[class*="avatar"] + span',
        '[class*="header"] [class*="name"]',
        '[class*="author-name"]',
        '[data-e2e*="user-name"]',
        'header [class*="name"]',
      ];
      let accountName = '';
      for (const sel of nameSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (txt && txt.length >= 1 && txt.length <= 40 && !/^(抖音创作者中心|首页|发布作品|内容管理|互动管理|数据中心|登录|扫码登录)$/.test(txt)) {
            accountName = txt;
            break;
          }
        }
        if (accountName) break;
      }
      if (!accountName && idMatch) {
        const lines = bodyText.split('\\n').map((l) => l.trim()).filter(Boolean);
        const idx = lines.findIndex((l) => l.includes(idMatch[0]));
        if (idx > 0 && lines[idx - 1].length <= 40) accountName = lines[idx - 1];
      }
      if (!accountName) {
        for (const m of bodyText.matchAll(/(?:^|\\n)\\s*@([^\\s@\\n]{1,30})/g)) {
          const cand = (m[1] || '').trim();
          if (cand && !/^(?:好友|添加好友|抖音小助手)$/.test(cand)) {
            accountName = '@' + cand;
            break;
          }
        }
      }
      const loginPrompt = /扫码登录|手机号登录|验证码登录|立即登录/.test(bodyText.slice(0, 1200));
      return {
        url: location.href,
        accountName,
        accountId,
        accountRef: accountId || accountName,
        loggedIn: !loginPrompt && Boolean(accountName || accountId || !/\\/login/i.test(location.pathname)),
      };
    })()`, true);
    if (!info.accountName && !info.accountId && info.loggedIn !== false) {
      // Lightweight same-origin authenticated creator user info read (works on /upload, /post/image, /manage).
      const apiUser = await win.webContents.executeJavaScript(`(async () => {
        const urls = ['/web/api/media/user/info/', '/aweme/v1/creator/user/info/'];
        for (const u of urls) {
          try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 2000);
            const res = await fetch(u, { credentials: 'include', signal: ac.signal });
            clearTimeout(t);
            if (!res.ok) continue;
            const j = await res.json();
            const user = j?.user || j?.data?.user || j?.data || j;
            const nick = String(user?.nickname || user?.nick_name || user?.name || '').trim();
            const uid = String(user?.unique_id || user?.short_id || '').trim();
            if (nick || uid) return { accountName: nick, accountId: uid };
          } catch { /* try next */ }
        }
        return null;
      })()`, true).catch(() => null);
      if (apiUser?.accountName || apiUser?.accountId) {
        info.accountName = apiUser.accountName || info.accountName;
        info.accountId = apiUser.accountId || info.accountId;
        info.accountRef = info.accountId || info.accountName;
      }
    }
    const expected = normalizeStr(message.expectedAccount);
    const matched = expected ? accountMatches(expected, info) : true;
    return { ...info, expectedAccount: expected, matched };
  };

  /** Checks whether live snapshot already matches target title/body/tags without duplication. */
  const verifySnapshotMatches = (snap, { title, body, tags }) => {
    const titleExact = !title || normalizeStr(snap.actualTitle) === normalizeStr(title);
    const normActual = normalizeBodyForCompare(snap.actualBody);
    const normTargetBody = normalizeBodyForCompare(body);
    let bodyExact = true;
    if (normTargetBody) {
      const firstIdx = normActual.indexOf(normTargetBody);
      const secondIdx = firstIdx >= 0 ? normActual.indexOf(normTargetBody, firstIdx + normTargetBody.length) : -1;
      const allTagsPresent = tags.every((tag) => normActual.toLowerCase().includes(`#${tag.toLowerCase()}`));
      // Exact when target body appears once, is not duplicated, and all hashtags are present.
      const maxExpectedLen = normTargetBody.length + tags.reduce((s, t) => s + t.length + 3, 0) + 16;
      bodyExact = firstIdx >= 0 && secondIdx === -1 && allTagsPresent && normActual.length <= maxExpectedLen;
    } else if (tags.length) {
      bodyExact = tags.every((tag) => normActual.toLowerCase().includes(`#${tag.toLowerCase()}`));
    }
    return { titleExact, bodyExact };
  };

  /** Idempotent fill: full-select clear + single-shot overwrite + hashtag commit + readback snapshot. */
  const fillPost = async (message = {}) => {
    const win = await requireDouyinWindow(null);
    let account = await checkAccount({ expectedAccount: message.expectedAccount });
    if (message.expectedAccount && !account.matched && account.loggedIn !== false && !account.accountName && !account.accountId) {
      // Newly jumped /content/post/image or /publish-media/image-text hydrates the right-hand preview (@nickname) ~6-14s after upload jump.
      const hydrateDeadline = Date.now() + 15000;
      while (Date.now() < hydrateDeadline) {
        await sleep(500);
        account = await checkAccount({ expectedAccount: message.expectedAccount });
        if (account.matched || account.loggedIn === false || account.accountName || account.accountId) break;
      }
    }
    if (message.expectedAccount && !account.matched) {
      throw new Error(`Douyin account mismatch: expected "${message.expectedAccount}", but signed-in account is "${account.accountName || '(unknown)'}" (ID: ${account.accountId || 'unknown'})`);
    }

    const title = typeof message.title === 'string' ? message.title.trim() : '';
    const body = typeof message.body === 'string' ? message.body.trim() : '';
    const tags = Array.isArray(message.tags)
      ? message.tags.map((t) => String(t || '').replace(/^#+/, '').replace(/\s+/g, '').trim()).filter(Boolean).slice(0, 10)
      : [];
    const wantAiDisclosure = message.aiDisclosure === true;

    // Idempotency pre-check: if the live form already matches target title/body/tags (and music if requested), skip re-filling.
    const wantMusic = normalizeStr(message.music || message.musicQuery || '');
    const beforeSnap = await readPostSnapshot(win).catch(() => null);
    if (beforeSnap && (title || body || tags.length)) {
      const check = verifySnapshotMatches(beforeSnap, { title, body, tags });
      const aiMatches = !wantAiDisclosure || beforeSnap.aiDeclarationChecked === true;
      const musicMatches = !wantMusic || (
        beforeSnap.music?.imported === true
        && (/^(?:推荐|auto)$/i.test(wantMusic) || beforeSnap.music.title.toLowerCase().includes(wantMusic.toLowerCase()))
      );
      if (check.titleExact && check.bodyExact && aiMatches && musicMatches) {
        return {
          status: 'OK',
          already_applied: true,
          filled: true,
          account,
          titleFilled: Boolean(title),
          bodyFilled: Boolean(body),
          tagsApplied: tags,
          titleExact: true,
          bodyExact: true,
          bodyPreview: normalizeBodyForCompare(beforeSnap.actualBody).slice(0, 180),
          hashtagCount: beforeSnap.hashtagCount,
          imageCount: beforeSnap.imageCount,
          aiDeclarationChecked: beforeSnap.aiDeclarationChecked,
          aiDisclosureChecked: beforeSnap.aiDeclarationChecked,
          aiDisclosureNote: beforeSnap.aiDeclarationChecked ? 'already checked' : 'unchecked (default)',
          music: beforeSnap.music,
          pageUrl: beforeSnap.pageUrl,
          url: beforeSnap.pageUrl,
        };
      }
    }

    let titleFilled = false;
    if (title) {
      const titlePt = await win.webContents.executeJavaScript(`(() => {
        const candidates = [
          'input[placeholder*="标题"]',
          'input[placeholder*="作品标题"]',
          'textarea[placeholder*="标题"]',
          '[class*="title"] input',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (!el || el.disabled) continue;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 10) {
            return { x: r.left + Math.min(r.width * 0.5, 120), y: r.top + r.height / 2 };
          }
        }
        return null;
      })()`, true);
      if (titlePt) {
        await clickPoint(win, titlePt);
        for (let pass = 0; pass < 2; pass++) {
          await win.webContents.executeJavaScript(`(() => {
            const el = document.activeElement;
            if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select();
          })()`, true).catch(() => undefined);
          await sendSelectAllAndDelete(win);
          const rem = await win.webContents.executeJavaScript(`(() => {
            const el = document.activeElement;
            return (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) ? el.value : '';
          })()`, true).catch(() => '');
          if (!rem) break;
        }
        win.webContents.insertText(title);
        await sleep(160);
        titleFilled = true;
      }
    }

    let bodyFilled = false;
    const tagsApplied = [];
    if (body || tags.length) {
      const bodyPt = await win.webContents.executeJavaScript(`(() => {
        const candidates = [
          '.zone-container[contenteditable="true"]',
          '[class*="editor"] [contenteditable="true"]',
          '[contenteditable="true"][data-placeholder*="作品简介"]',
          '[contenteditable="true"][data-placeholder*="描述"]',
          '[contenteditable="true"]',
          'textarea[placeholder*="描述"]',
          'textarea[placeholder*="简介"]',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (!el) continue;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          if (r.width > 40 && r.height > 20) {
            return { x: r.left + Math.min(r.width * 0.4, 120), y: r.top + Math.min(r.height * 0.4, 30) };
          }
        }
        return null;
      })()`, true);
      if (bodyPt) {
        await clickPoint(win, bodyPt);
        // Full-select & clear for Slate/Draft.js contenteditable before single-shot overwrite.
        for (let pass = 0; pass < 3; pass++) {
          await win.webContents.executeJavaScript(`(() => {
            const candidates = [
              '.zone-container[contenteditable="true"]',
              '[class*="editor"] [contenteditable="true"]',
              '[contenteditable="true"][data-placeholder*="作品简介"]',
              '[contenteditable="true"][data-placeholder*="描述"]',
              '[contenteditable="true"]',
              'textarea[placeholder*="描述"]',
              'textarea[placeholder*="简介"]',
            ];
            const el = candidates.map((s) => document.querySelector(s)).find(Boolean) || document.activeElement;
            if (!el) return;
            el.focus();
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              el.select();
            } else {
              const sel = window.getSelection();
              if (sel) {
                const range = document.createRange();
                range.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          })()`, true).catch(() => undefined);
          await sendSelectAllAndDelete(win);
          const remaining = await win.webContents.executeJavaScript(`(() => {
            const candidates = [
              '.zone-container[contenteditable="true"]',
              '[class*="editor"] [contenteditable="true"]',
              '[contenteditable="true"][data-placeholder*="作品简介"]',
              '[contenteditable="true"][data-placeholder*="描述"]',
              '[contenteditable="true"]',
              'textarea[placeholder*="描述"]',
              'textarea[placeholder*="简介"]',
            ];
            const el = candidates.map((s) => document.querySelector(s)).find(Boolean);
            if (!el) return '';
            const raw = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.value : (el.innerText || el.textContent || '');
            return raw.replace(/[\\s\\u200b\\u00a0]/g, '');
          })()`, true).catch(() => '');
          if (!remaining) break;
        }
        if (body) {
          win.webContents.insertText(body);
          await sleep(180);
          bodyFilled = true;
        }
        for (const tag of tags) {
          win.webContents.insertText(` #${tag}`);
          await sleep(420);
          const picked = await win.webContents.executeJavaScript(`(() => {
            const needle = ${JSON.stringify(tag.toLowerCase())};
            const items = Array.from(document.querySelectorAll('[class*="topic"] [class*="item"], [class*="mention"] [class*="item"], [role="option"], [class*="suggest"] li, [class*="dropdown"] li'));
            const visible = items.filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 20 && r.height > 12 && (el.innerText || '').trim().length > 0;
            });
            const exact = visible.find((el) => (el.innerText || '').toLowerCase().includes(needle)) || visible[0];
            if (!exact) return null;
            const r = exact.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (exact.innerText || '').trim().slice(0, 60) };
          })()`, true).catch(() => null);
          if (picked) {
            await clickPoint(win, picked);
            tagsApplied.push(tag);
          } else {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
            await sleep(80);
            win.webContents.insertText(' ');
            tagsApplied.push(tag);
          }
          await sleep(180);
        }
      }
    }

    let aiDisclosureChecked = false;
    let aiDisclosureNote = 'unchecked (default)';
    if (wantAiDisclosure) {
      await win.webContents.executeJavaScript(`(() => {
        window.scrollTo(0, document.body.scrollHeight * 0.7);
      })()`, true).catch(() => undefined);
      await sleep(300);

      const aiRes = await win.webContents.executeJavaScript(`(() => {
        const matchAiText = (t) => /(?:内容由\\s*AI\\s*生成|包含\\s*AI\\s*生成|AI\\s*生成|人工智能生成)/i.test(t);
        const matchDeclSection = (t) => /(?:自主声明|添加声明|内容声明|声明)/.test(t);
        const isChecked = (el) => {
          if (!el) return false;
          if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
          if (el.getAttribute('aria-checked') === 'true') return true;
          const cls = String(el.className || '');
          if (/checked|active|selected/i.test(cls)) return true;
          const inp = el.querySelector?.('input[type="checkbox"], input[type="radio"]');
          if (inp && inp.checked) return true;
          return false;
        };
        const labels = Array.from(document.querySelectorAll('label, [role="checkbox"], [role="switch"], [role="radio"], [role="option"], li, div, span, button'));
        for (const el of labels) {
          const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!txt || txt.length > 48 || !matchAiText(txt)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) continue;
          return {
            step: 'direct',
            alreadyChecked: isChecked(el) || isChecked(el.closest('label, [role="checkbox"], [role="switch"], [class*="checkbox"], [class*="switch"]')),
            x: r.left + Math.min(r.width / 2, 40),
            y: r.top + r.height / 2,
            text: txt,
          };
        }
        const triggers = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [class*="select"], div, span'));
        for (const el of triggers) {
          const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!txt || txt.length > 24 || !matchDeclSection(txt)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 12) continue;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r2 = el.getBoundingClientRect();
          return { step: 'open-menu', x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, text: txt };
        }
        return { step: 'not-found' };
      })()`, true).catch(() => ({ step: 'not-found' }));

      if (aiRes?.step === 'direct') {
        if (aiRes.alreadyChecked) {
          aiDisclosureChecked = true;
          aiDisclosureNote = `already checked: ${aiRes.text}`;
        } else {
          await clickPoint(win, aiRes);
          await sleep(220);
          aiDisclosureChecked = true;
          aiDisclosureNote = `clicked: ${aiRes.text}`;
        }
      } else if (aiRes?.step === 'open-menu') {
        await clickPoint(win, aiRes);
        await sleep(350);
        const subTarget = await win.webContents.executeJavaScript(`(() => {
          const els = Array.from(document.querySelectorAll('label, [role="checkbox"], [role="option"], [role="menuitem"], li, div, span'));
          for (const el of els) {
            const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!txt || txt.length > 48 || !/(?:内容由\\s*AI\\s*生成|包含\\s*AI\\s*生成|AI\\s*生成|人工智能生成)/i.test(txt)) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 12 && r.height > 12) return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, text: txt };
          }
          return null;
        })()`, true).catch(() => null);
        if (subTarget) {
          await clickPoint(win, subTarget);
          await sleep(220);
          aiDisclosureChecked = true;
          aiDisclosureNote = `selected from menu: ${subTarget.text}`;
        } else {
          aiDisclosureNote = `opened "${aiRes.text}" but no AI disclosure option appeared`;
        }
      } else {
        aiDisclosureNote = 'AI disclosure control not found on current view';
      }
    }

    await sleep(200);
    if (wantMusic) {
      await selectMusic({
        music: wantMusic,
        expectedAccount: message.expectedAccount,
      });
    }
    const afterSnap = await readPostSnapshot(win).catch(() => ({
      actualTitle: title,
      actualBody: body,
      hashtagCount: tagsApplied.length,
      imageCount: 0,
      aiDeclarationChecked: aiDisclosureChecked,
      music: { imported: false, selected: false, title: '', duration: '', durationSec: 0, musicId: '', audioSrc: '', previewMusicText: '', previewShowsOriginalSound: false, warning: '' },
      pageUrl: win.webContents.getURL(),
    }));
    const verified = verifySnapshotMatches(afterSnap, { title, body, tags });

    return {
      status: 'OK',
      already_applied: false,
      filled: true,
      account,
      titleFilled,
      bodyFilled,
      tagsApplied,
      titleExact: verified.titleExact,
      bodyExact: verified.bodyExact,
      bodyPreview: normalizeBodyForCompare(afterSnap.actualBody).slice(0, 180),
      hashtagCount: afterSnap.hashtagCount,
      imageCount: afterSnap.imageCount,
      aiDeclarationChecked: afterSnap.aiDeclarationChecked,
      aiDisclosureChecked: afterSnap.aiDeclarationChecked || aiDisclosureChecked,
      aiDisclosureNote,
      music: afterSnap.music,
      pageUrl: afterSnap.pageUrl,
      url: afterSnap.pageUrl,
    };
  };

  /**
   * Deterministically selects & verifies real BGM import on Douyin Creator Center image-post editor:
   * opens "选择音乐/修改音乐" -> optional search -> hovers track row -> clicks "使用" ->
   * verifies modal closed, non-zero duration (>00:00), and right-hand preview NOT showing "创作的原声".
   */
  const selectMusic = async (message = {}) => {
    const win = await requireDouyinWindow(null);
    const curUrl = win.webContents.getURL() || '';
    if (!/\/(?:post\/image|publish-media\/image-text|publish)/i.test(curUrl)) {
      throw new Error(`select_music requires the Douyin image edit page, current URL is ${curUrl || '(empty)'}`);
    }
    const account = await checkAccount({ expectedAccount: message.expectedAccount });
    if (message.expectedAccount && !account.matched) {
      throw new Error(`Douyin account mismatch before select_music: expected "${message.expectedAccount}", got "${account.accountName || '(unknown)'}"`);
    }

    const query = normalizeStr(message.music || message.musicQuery || message.query || '');
    const force = message.force === true;
    const requestedIndex = Number.isInteger(message.index) && message.index >= 0 ? message.index : 0;

    const beforeSnap = await readPostSnapshot(win).catch(() => null);
    if (!force && beforeSnap?.music?.imported === true) {
      const titleMatches = !query || /^(?:推荐|auto)$/i.test(query) || beforeSnap.music.title.toLowerCase().includes(query.toLowerCase());
      if (titleMatches) {
        return {
          status: 'OK',
          already_applied: true,
          account,
          music: beforeSnap.music,
          pageUrl: beforeSnap.pageUrl,
        };
      }
    }

    const openMusicModal = async () => {
      const btnPt = await win.webContents.executeJavaScript(`(() => {
        const candidates = Array.from(document.querySelectorAll('button, span, div, [role="button"]')).filter((el) => {
          if (el.children.length > 2) return false;
          const t = (el.innerText || '').trim();
          return /^(?:修改音乐|更换音乐|选择音乐|添加音乐)$/.test(t);
        });
        // Prefer the actual action button (修改音乐 / 更换音乐 / clickable 选择音乐 span inside the row, not the left section heading).
        const pick = candidates.find((el) => /^(?:修改音乐|更换音乐)$/.test((el.innerText || '').trim()))
          || candidates.filter((el) => /^(?:选择音乐|添加音乐)$/.test((el.innerText || '').trim())).at(-1)
          || null;
        if (!pick) return null;
        pick.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = pick.getBoundingClientRect();
        return r.width > 10 && r.height > 10 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (pick.innerText || '').trim() } : null;
      })()`, true);
      if (!btnPt) throw new Error('music picker trigger ("选择音乐" / "修改音乐") not found on current Douyin page');
      await clickPoint(win, btnPt);
      const modalDeadline = Date.now() + 4500;
      while (Date.now() < modalDeadline) {
        const open = await win.webContents.executeJavaScript(`Boolean(document.querySelector('input[placeholder*="搜索音乐"]'))`, true).catch(() => false);
        if (open) return true;
        await sleep(250);
      }
      return false;
    };

    let modalOpen = await win.webContents.executeJavaScript(`Boolean(document.querySelector('input[placeholder*="搜索音乐"]'))`, true).catch(() => false);
    if (!modalOpen) {
      modalOpen = await openMusicModal();
      if (!modalOpen) throw new Error('Douyin music picker modal did not open after clicking 选择音乐');
    }

    const searchInModal = async (term) => {
      const inputPt = await win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('input[placeholder*="搜索音乐"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 10 ? { x: r.left + Math.min(r.width * 0.4, 100), y: r.top + r.height / 2 } : null;
      })()`, true);
      if (!inputPt) return false;
      await clickPoint(win, inputPt);
      await sendSelectAllAndDelete(win);
      if (term) {
        win.webContents.insertText(term);
        await sleep(200);
      }
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      const resDeadline = Date.now() + 4500;
      await sleep(700);
      while (Date.now() < resDeadline) {
        const hasRows = await win.webContents.executeJavaScript(`(() => {
          const inp = document.querySelector('input[placeholder*="搜索音乐"]');
          if (!inp) return false;
          let modal = inp.parentElement;
          for (let d = 0; modal && d < 8; d++, modal = modal.parentElement) {
            const txt = modal.innerText || '';
            if (/\\b\\d{2}:\\d{2}\\b/.test(txt) && /使用|人使用/.test(txt)) return true;
          }
          return false;
        })()`, true).catch(() => false);
        if (hasRows) return true;
        await sleep(300);
      }
      return false;
    };

    let fallbackUsed = false;
    if (query && !/^(?:推荐|auto)$/i.test(query)) {
      const foundSearch = await searchInModal(query);
      if (!foundSearch && message.strictQuery !== true) {
        fallbackUsed = true;
        await searchInModal('');
        // Try clicking "纯音乐" or "推荐" tab if available.
        const tabPt = await win.webContents.executeJavaScript(`(() => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"], div, span')).filter((el) => {
            if (el.children.length > 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 12 && r.height > 10 && /^(?:纯音乐|推荐)$/.test((el.innerText || '').trim());
          });
          const pick = tabs.find((el) => (el.innerText || '').trim() === '纯音乐') || tabs[0];
          if (!pick) return null;
          const r = pick.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`, true).catch(() => null);
        if (tabPt) {
          await clickPoint(win, tabPt);
          await sleep(1000);
        }
      }
    } else {
      await sleep(700);
    }

    const pickAndUseTrack = async (candidateOffset) => {
      const rowInfo = await win.webContents.executeJavaScript(`(() => {
        const inp = document.querySelector('input[placeholder*="搜索音乐"]');
        if (!inp) return null;
        let modal = inp.parentElement;
        for (let d = 0; modal && d < 8; d++, modal = modal.parentElement) {
          if (modal.getBoundingClientRect().height > 260 && /\\b\\d{2}:\\d{2}\\b/.test(modal.innerText || '')) break;
        }
        if (!modal) return null;
        const parseSec = (s) => {
          const m = s.match(/\\b(\\d{1,2}):(\\d{2})\\b/);
          return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0;
        };
        // Find leaf-most single-track row elements containing a non-zero MM:SS duration and "使用"/"人使用".
        const allDivs = Array.from(modal.querySelectorAll('div, li')).filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 180 || r.height < 36 || r.height > 150) return false;
          const txt = (el.innerText || '').trim();
          const durs = txt.match(/\\b\\d{2}:\\d{2}\\b/g) || [];
          if (durs.length !== 1) return false;
          if (parseSec(durs[0]) <= 0) return false;
          return /人使用|使用/.test(txt);
        });
        const uniqueRows = allDivs.filter((el) => !allDivs.some((other) => other !== el && el.contains(other)));
        const idx = Math.min(${Number(requestedIndex) || 0} + ${Number(candidateOffset) || 0}, Math.max(0, uniqueRows.length - 1));
        const row = uniqueRows[idx];
        if (!row) return null;
        row.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = row.getBoundingClientRect();
        const lines = (row.innerText || '').replace(/\\r/g, '').split('\\n').map((l) => l.trim()).filter(Boolean);
        return {
          x: Math.round(r.left + Math.min(r.width * 0.4, 140)),
          y: Math.round(r.top + r.height / 2),
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          title: lines[0] || '',
          duration: (row.innerText || '').match(/\\b\\d{2}:\\d{2}\\b/)?.[0] || '',
          totalCandidates: uniqueRows.length,
        };
      })()`, true);
      if (!rowInfo) return { ok: false, reason: 'no valid non-zero music track row found in modal' };

      // Hover the exact target track row so Douyin reveals its row-scoped "使用" button.
      win.webContents.sendInputEvent({ type: 'mouseMove', x: rowInfo.x, y: rowInfo.y });
      await sleep(420);

      const useBtn = await win.webContents.executeJavaScript(`(() => {
        const topBound = ${Number(rowInfo.top)} - 12;
        const bottomBound = ${Number(rowInfo.bottom)} + 12;
        const leftBound = ${Number(rowInfo.left)} - 12;
        const rightBound = ${Number(rowInfo.right)} + 40;
        const btns = Array.from(document.querySelectorAll('button, span, div, [role="button"]')).filter((el) => {
          if (el.children.length > 2) return false;
          const t = (el.innerText || '').trim();
          if (!/^(?:使用|确认使用)$/.test(t)) return false;
          const r = el.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          const cx = r.left + r.width / 2;
          return r.width >= 16 && r.height >= 12 && cy >= topBound && cy <= bottomBound && cx >= leftBound && cx <= rightBound;
        });
        const pick = btns.find((el) => el.tagName === 'BUTTON') || btns[0] || null;
        if (!pick) return null;
        const r = pick.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`, true);
      if (!useBtn) return { ok: false, reason: `hovering "${rowInfo.title}" did not reveal a clickable 使用 button` };

      await clickPoint(win, useBtn);

      // Wait up to 6s for modal close (plus optional confirm dialog) AND verified real import (duration > 0 & preview != 原声).
      const verifyDeadline = Date.now() + 6000;
      let lastSnap = null;
      while (Date.now() < verifyDeadline) {
        await sleep(400);
        // If Douyin opens a secondary clip/confirm dialog inside the picker, click "确定"/"完成".
        const confirmPt = await win.webContents.executeJavaScript(`(() => {
          const modal = document.querySelector('input[placeholder*="搜索音乐"], [class*="music-clip"], [class*="audio-clip"]');
          if (!modal) return null;
          const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
            if (el.disabled) return false;
            const t = (el.innerText || '').trim();
            const r = el.getBoundingClientRect();
            return r.width > 24 && r.height > 16 && /^(?:确定|确认使用|完成)$/.test(t);
          });
          const pick = btns.at(-1);
          if (!pick) return null;
          const r = pick.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`, true).catch(() => null);
        if (confirmPt) {
          await clickPoint(win, confirmPt);
          await sleep(400);
        }
        const stillOpen = await win.webContents.executeJavaScript(`Boolean(document.querySelector('input[placeholder*="搜索音乐"]'))`, true).catch(() => false);
        if (!stillOpen) {
          lastSnap = await readPostSnapshot(win).catch(() => null);
          if (lastSnap?.music?.imported === true) {
            return { ok: true, snap: lastSnap, pickedTitle: rowInfo.title, pickedDuration: rowInfo.duration };
          }
        }
      }
      lastSnap = await readPostSnapshot(win).catch(() => lastSnap);
      return { ok: Boolean(lastSnap?.music?.imported), snap: lastSnap, pickedTitle: rowInfo.title, reason: lastSnap?.music?.warning || 'music did not verify as imported after clicking 使用' };
    };

    let attemptRes = await pickAndUseTrack(0);
    if (!attemptRes.ok) {
      // Retry once with the next valid track row if modal is open or after reopening modal.
      const stillOpen = await win.webContents.executeJavaScript(`Boolean(document.querySelector('input[placeholder*="搜索音乐"]'))`, true).catch(() => false);
      if (!stillOpen) await openMusicModal().catch(() => false);
      attemptRes = await pickAndUseTrack(1);
    }

    if (!attemptRes.ok || !attemptRes.snap?.music?.imported) {
      throw new Error(`Douyin music import verification failed (${attemptRes.reason || 'unknown'}): ${JSON.stringify(attemptRes.snap?.music || null)}`);
    }

    return {
      status: 'OK',
      already_applied: false,
      fallbackUsed,
      account,
      music: attemptRes.snap.music,
      pageUrl: attemptRes.snap.pageUrl,
    };
  };

  /** Clicks the primary Publish button with content-hash idempotency lock, music integrity guard & early exit. */
  const publishPost = async (message = {}) => {
    const win = await requireDouyinWindow(null);
    const curUrl = win.webContents.getURL() || '';
    if (!/\/(?:post\/image|publish-media\/image-text|publish)/i.test(curUrl)) {
      throw new Error(`Douyin publish blocked: not on Douyin image edit page (current URL is "${curUrl}"). Note: navigating away to /content/manage (e.g. via check_posts) resets the draft BGM audio to 00:00 ("原声"); please return to the edit page, run select_music first, and then call publish_post directly without calling check_posts in between.`);
    }
    const account = await checkAccount({ expectedAccount: message.expectedAccount });
    if (message.expectedAccount && !account.matched) {
      throw new Error(`Douyin account mismatch before publish: expected "${message.expectedAccount}", got "${account.accountName || '(unknown)'}"`);
    }

    // Build idempotency lock key & verify music binding integrity before clicking Publish.
    let snap = await readPostSnapshot(win).catch(() => ({ actualTitle: '', actualBody: '', music: null }));
    const fallbackMusicQuery = normalizeStr(message.music || snap?.music?.title || '');
    if ((message.requireMusic === true || snap?.music?.selected) && !snap?.music?.imported && fallbackMusicQuery) {
      // Auto-recover once if a prior navigation (e.g. check_posts -> post/image draft restore) reset BGM duration to 00:00.
      const reselected = await selectMusic({
        expectedAccount: message.expectedAccount,
        music: fallbackMusicQuery,
        force: true,
      }).catch(() => null);
      if (reselected?.music?.imported) {
        snap = await readPostSnapshot(win).catch(() => snap);
      }
    }
    if (snap?.music?.selected && !snap.music.imported) {
      throw new Error(`Douyin publish blocked: UI shows music "${snap.music.title}" (${snap.music.duration || '00:00'}), but audio is NOT actually imported (${snap.music.warning || 'preview shows 原声'}). Run select_music to re-import before publishing.`);
    }
    if (message.requireMusic === true && !snap?.music?.imported) {
      throw new Error(`Douyin publish blocked: requireMusic=true, but no verified BGM is imported on the draft page (preview="${snap?.music?.previewMusicText || '原声'}"). Run select_music first.`);
    }
    const contentHash = computePublishHash(
      account.accountRef || message.expectedAccount || '',
      message.title || snap.actualTitle || '',
      message.body || snap.actualBody || '',
      message.tags || [],
    );
    const now = Date.now();
    for (const [k, v] of publishLocks) {
      if (now - v.ts > PUBLISH_LOCK_TTL_MS) publishLocks.delete(k);
    }
    const existingLock = publishLocks.get(contentHash);
    if (existingLock && existingLock.status !== 'FAILED') {
      return {
        status: existingLock.status,
        already_published: true,
        clicked: false,
        account,
        contentHash,
        url: win.webContents.getURL(),
        statusMessages: [`idempotency lock hit (${existingLock.status})`],
      };
    }

    const beforeUrl = win.webContents.getURL();
    const btn = await win.webContents.executeJavaScript(`(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const el of buttons) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!/^(?:发布|立即发布|确认发布)$/.test(txt)) continue;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        if (r.width > 24 && r.height > 16) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: txt };
        }
      }
      return null;
    })()`, true);
    if (!btn) {
      throw new Error('primary Publish button ("发布") not found or disabled on current Douyin page');
    }

    publishLocks.set(contentHash, { ts: now, status: 'PUBLISHING' });
    await clickPoint(win, btn);

    let observedStatus = 'UNKNOWN';
    let redirected = false;
    let statusMessages = [];
    const deadline = Date.now() + 14_000;
    while (Date.now() < deadline) {
      await sleep(350);
      const currentUrl = win.webContents.getURL();
      if (currentUrl !== beforeUrl && /\/content\/manage|\/manage/i.test(currentUrl)) {
        redirected = true;
        observedStatus = 'UNDER_REVIEW';
        break;
      }
      const probe = await win.webContents.executeJavaScript(`(() => {
        const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"], [class*="notice"], [class*="message"]'))
          .map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())
          .filter((t) => t && t.length <= 120);
        const body = (document.body?.innerText || '').slice(0, 1600);
        const unique = [...new Set(alerts)].slice(0, 8);
        return { alerts: unique, bodySnippet: body };
      })()`, true).catch(() => ({ alerts: [], bodySnippet: '' }));
      statusMessages = probe.alerts || [];
      const joined = `${statusMessages.join('\n')}\n${probe.bodySnippet || ''}`;
      if (/(?:发布成功|投稿成功|作品已发布|已发布|已提交)/.test(joined)) {
        observedStatus = /审核中|待审核/.test(joined) ? 'UNDER_REVIEW' : 'PUBLISHED';
        break;
      }
      if (/(?:发布失败|请添加|请上传|不能为空|违规)/.test(statusMessages.join('\n'))) {
        observedStatus = 'FAILED';
        break;
      }
    }

    publishLocks.set(contentHash, { ts: Date.now(), status: observedStatus });
    return {
      clicked: true,
      buttonText: btn.text,
      account,
      music: snap?.music || null,
      status: observedStatus,
      redirected,
      contentHash,
      url: win.webContents.getURL(),
      statusMessages,
    };
  };

  /** Opens Creator Center content management with 20s hard cap, extracting aweme_id via links/attrs/React fiber. */
  const checkPosts = async (message = {}) => {
    const startedAt = Date.now();
    const deadline = startedAt + CHECK_POSTS_TIMEOUT_MS;
    const remainingMs = () => Math.max(100, deadline - Date.now());
    const raceDeadline = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`CHECK_POSTS_TIMEOUT:${label}`)), remainingMs())),
    ]);

    let account = null;
    try {
      let win = getWin();
      let shouldNavigate = false;
      let onManage = false;
      if (!win || win.isDestroyed()) {
        shouldNavigate = true;
        await raceDeadline(openUrl(MANAGE_URL), 'open-manage');
        win = getWin();
      } else {
        const currentUrl = win.webContents.getURL() || '';
        onManage = /creator\.douyin\.com\/creator-micro\/content\/manage/i.test(currentUrl);
        const wc = win.webContents;
        const recentlyLoaded = onManage && (Date.now() - lastManageLoadedAt < MANAGE_REUSE_TTL_MS);
        shouldNavigate = !onManage || (message.refresh === true && !recentlyLoaded);
        if (shouldNavigate) {
          await raceDeadline(new Promise((resolveNav) => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolveNav(); } };
            wc.once('dom-ready', finish);
            setTimeout(finish, 4500);
            wc.loadURL(MANAGE_URL).then(finish, finish);
          }), 'open-manage');
          await sleep(600);
        }
      }
      if (!win || win.isDestroyed()) throw new Error('browser window is closed');

      const wc = win.webContents;
      // Fast-path: query Douyin Creator Center's own authenticated work_list API directly (~300ms, immune to DOM hydration delays).
      const apiExtracted = await raceDeadline(wc.executeJavaScript(`(async () => {
        const urls = [
          '/janus/douyin/creator/pc/work_list?status=0&count=15&max_cursor=0&scene=star_atlas&device_platform=android&aid=1128',
          '/web/api/media/aweme/post/?status=0&count=15&max_cursor=0',
        ];
        for (const u of urls) {
          try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 3500);
            const res = await fetch(u, { credentials: 'include', signal: ac.signal });
            clearTimeout(timer);
            if (!res.ok) continue;
            const j = await res.json();
            const list = j?.aweme_list || j?.data?.aweme_list || j?.item_info_list || j?.data?.item_info_list || [];
            if (!Array.isArray(list) || list.length === 0) continue;
            const posts = list.slice(0, 20).map((item) => {
              const info = item?.aweme_info || item?.item_info || item || {};
              const stats = info.statistics || item.statistics || item.metrics || {};
              const postId = String(info.aweme_id || info.item_id_plain || info.item_id || info.group_id || '').trim();
              const title = String(info.desc || info.title || info.caption || '').trim().slice(0, 120);
              const stObj = info.status || item.status || {};
              const inReview = stObj.in_reviewing === true || stObj.review_status === 1 || /审核中/.test(String(item.status_desc || ''));
              const isFailed = stObj.is_delete === true || stObj.review_status === 2 || /未通过|违规/.test(String(item.status_desc || ''));
              const rawStatus = inReview ? '审核中' : isFailed ? '未通过' : '已发布';
              const status = inReview ? 'UNDER_REVIEW' : isFailed ? 'FAILED' : 'PUBLISHED';
              const isImage = info.aweme_type === 68 || info.media_type === 2 || Array.isArray(info.images);
              const postUrl = postId ? ('https://www.douyin.com/' + (isImage ? 'note/' : 'video/') + postId) : '';
              return {
                title,
                status,
                rawStatus,
                postId,
                postUrl,
                publishedAtText: info.create_time ? new Date(Number(info.create_time) * 1000).toISOString() : '',
                metrics: {
                  views: Number(stats.play_count ?? stats.view_count ?? 0) || 0,
                  likes: Number(stats.digg_count ?? stats.like_count ?? 0) || 0,
                  collections: Number(stats.collect_count ?? stats.favorite_count ?? 0) || 0,
                  comments: Number(stats.comment_count ?? 0) || 0,
                  shares: Number(stats.share_count ?? 0) || 0,
                },
              };
            }).filter((p) => p.postId || p.title);
            if (posts.length > 0) return { url: location.href, posts, via: 'api' };
          } catch { /* fallback to next URL or DOM */ }
        }
        return null;
      })()`, true), 'api-posts').catch(() => null);

      let extracted = apiExtracted;
      if (!extracted || !Array.isArray(extracted.posts) || extracted.posts.length === 0) {
        const cardDeadline = Math.min(deadline - 4500, Date.now() + (onManage && !shouldNavigate ? 1500 : 9000));
        while (Date.now() < cardDeadline) {
          const hasList = await raceDeadline(wc.executeJavaScript(`(() => {
            const txt = (document.body?.textContent || '');
            if (/编辑作品|删除作品|没有更多作品|暂无作品/.test(txt)) return true;
            return Boolean(document.querySelector('[class*="video-card"], [class*="content-card"], [class*="article-card"], [class*="item-card"], [class*="works-item"], [data-e2e*="item"]'));
          })()`, true), 'wait-cards').catch(() => false);
          if (hasList) break;
          await sleep(450);
        }

        extracted = await raceDeadline(win.webContents.executeJavaScript(`(() => {
        const scriptDeadline = Date.now() + 3500;
        const parseCount = (raw) => {
          if (!raw) return 0;
          const s = String(raw).replace(/,/g, '').trim();
          const m = s.match(/([0-9]+(?:\\.[0-9]+)?)\\s*(万|w|W|千|k|K)?/);
          if (!m) return 0;
          const num = parseFloat(m[1]);
          if (!Number.isFinite(num)) return 0;
          const unit = (m[2] || '').toLowerCase();
          if (unit === '万' || unit === 'w') return Math.round(num * 10000);
          if (unit === '千' || unit === 'k') return Math.round(num * 1000);
          return Math.round(num);
        };
        const isNumericId = (v) => (typeof v === 'string' && /^\\d{15,24}$/.test(v.trim())) || (typeof v === 'number' && Number.isSafeInteger(v) && String(v).length >= 15);
        const findIdInObject = (obj, depth = 0, seen = new Set()) => {
          if (!obj || typeof obj !== 'object' || depth > 2 || seen.has(obj) || Date.now() > scriptDeadline) return '';
          seen.add(obj);
          const idKeys = ['aweme_id', 'item_id_plain', 'item_id', 'group_id', 'note_id', 'video_id', 'awemeId', 'itemId', 'groupId', 'id'];
          for (const k of idKeys) {
            const v = obj[k];
            if (isNumericId(v)) return String(v).trim();
          }
          const keys = Object.keys(obj).slice(0, 14);
          for (const k of keys) {
            if (k.startsWith('_') || k === 'children' || k === 'stateNode' || k === 'return' || k === 'sibling' || k === 'child' || k === 'alternate') continue;
            const v = obj[k];
            if (v && typeof v === 'object') {
              const found = findIdInObject(v, depth + 1, seen);
              if (found) return found;
            }
          }
          return '';
        };
        const extractIdFromFiber = (el) => {
          if (Date.now() > scriptDeadline) return '';
          const targets = [el, el.firstElementChild].filter(Boolean);
          for (const node of targets) {
            for (const k of Object.keys(node)) {
              if (!k.startsWith('__reactFiber$') && !k.startsWith('__reactProps$')) continue;
              let cur = node[k];
              for (let hop = 0; cur && hop < 5 && Date.now() < scriptDeadline; hop++, cur = cur.return) {
                const propsHit = findIdInObject(cur.memoizedProps || cur);
                if (propsHit) return propsHit;
                let st = cur.memoizedState;
                for (let sHop = 0; st && sHop < 2 && Date.now() < scriptDeadline; sHop++, st = st.next) {
                  const stHit = findIdInObject(st.memoizedState || st);
                  if (stHit) return stHit;
                }
              }
            }
          }
          return '';
        };
        const collectFiberItemMap = () => {
          const map = new Map();
          const fiberDeadline = Math.min(scriptDeadline, Date.now() + 1800);
          const roots = Array.from(document.querySelectorAll('[data-scrollable]')).slice(0, 3);
          const inspectArray = (arr) => {
            if (!Array.isArray(arr) || arr.length === 0 || arr.length > 60 || Date.now() > fiberDeadline) return;
            for (const entry of arr) {
              if (Date.now() > fiberDeadline) break;
              if (!entry || typeof entry !== 'object') continue;
              const id = findIdInObject(entry, 0, new Set());
              const desc = String(entry.desc || entry.title || entry.item_info?.desc || entry.item_info?.title || entry.aweme_info?.desc || entry.caption || '').trim();
              if (id && desc) {
                const key = desc.replace(/\\s+/g, '').slice(0, 18).toLowerCase();
                if (key && !map.has(key)) map.set(key, id);
              }
            }
          };
          const scanObjForLists = (obj, depth = 0, seen = new Set()) => {
            if (!obj || typeof obj !== 'object' || depth > 2 || seen.has(obj) || Date.now() > fiberDeadline) return;
            seen.add(obj);
            if (Array.isArray(obj)) {
              inspectArray(obj);
              return;
            }
            for (const k of Object.keys(obj).slice(0, 14)) {
              if (Date.now() > fiberDeadline) break;
              if (k.startsWith('_') || k === 'children' || k === 'stateNode' || k === 'return' || k === 'sibling' || k === 'child' || k === 'alternate') continue;
              const v = obj[k];
              if (Array.isArray(v)) inspectArray(v);
              else if (v && typeof v === 'object') scanObjForLists(v, depth + 1, seen);
            }
          };
          for (const rootEl of roots) {
            if (Date.now() > fiberDeadline) break;
            for (const k of Object.keys(rootEl)) {
              if (!k.startsWith('__reactFiber$') && !k.startsWith('__reactProps$')) continue;
              let cur = rootEl[k];
              for (let hop = 0; cur && hop < 8 && Date.now() < fiberDeadline; hop++, cur = cur.return) {
                scanObjForLists(cur.memoizedProps);
                let st = cur.memoizedState;
                for (let sHop = 0; st && sHop < 4 && Date.now() < fiberDeadline; sHop++, st = st.next) {
                  scanObjForLists(st.memoizedState);
                }
                if (map.size >= 8) return map;
              }
            }
          }
          return map;
        };

        let cards = Array.from(document.querySelectorAll('[class*="video-card"], [class*="content-card"], [class*="article-card"], [class*="item-card"], [class*="works-item"], tr, [data-e2e*="item"]'))
          .filter((el) => {
            const txt = (el.textContent || '').trim();
            if (txt.length < 6) return false;
            const r = el.getBoundingClientRect();
            return r.width > 200 && r.height > 48 && r.height < 600;
          });

        if (cards.length === 0) {
          // Anchor-based discovery using textContent (no layout reflow storm across thousands of DOM nodes).
          const anchors = Array.from(document.querySelectorAll('button, span, a, div')).filter((el) => {
            if (el.children.length > 2) return false;
            const t = (el.textContent || '').trim();
            return /^(?:编辑作品|删除作品)$/.test(t);
          });
          const discovered = [];
          const seenEl = new Set();
          for (const anchor of anchors) {
            let best = null;
            let cur = anchor.parentElement;
            for (let depth = 0; cur && cur !== document.body && depth < 12; depth++, cur = cur.parentElement) {
              const txt = (cur.textContent || '').trim();
              const delCount = (txt.match(/删除作品/g) || []).length;
              const editCount = (txt.match(/编辑作品/g) || []).length;
              if (delCount > 1 || editCount > 1) break;
              if (/(?:已发布|审核中|未通过|草稿|播放|点赞|\\d{1,2}月\\d{1,2}日|\\d{4}年)/.test(txt)) {
                const r = cur.getBoundingClientRect();
                if (r.width >= 260 && r.height >= 64 && r.height <= 560) {
                  best = cur;
                }
              }
            }
            if (best && !seenEl.has(best)) {
              seenEl.add(best);
              discovered.push(best);
            }
          }
          cards = discovered;
        }

        const fiberItemMap = collectFiberItemMap();
        const posts = [];
        const seenKey = new Set();
        const skipLineRe = /^(?:图文|视频|置顶|公开|仅自己可见|好友可见|审核中|已发布|未通过|草稿|编辑作品|设置权限|作品置顶|删除作品|\\d+张图|\\d{1,2}:\\d{2})$/;
        for (const card of cards) {
          const txt = (card.innerText || '').replace(/\\r/g, '').trim();
          if (!/(?:播放|浏览|点赞|评论|审核|已发布|公开|图文|视频|发布于|昨天|今天|前|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}月\\d{1,2}日|\\d{4}年)/.test(txt)) continue;
          const lines = txt.split('\\n').map((l) => l.trim()).filter(Boolean);
          const title = lines.find((l) => l.length >= 2 && !skipLineRe.test(l) && !/^(?:播放|点赞|评论|分享|收藏|划走率|文案展开率|平均浏览|吸粉量|[0-9.,%]+)$/.test(l)) || lines[0] || '';
          const links = Array.from(card.querySelectorAll('a[href]')).map((a) => a.href || '');
          let postId = '';
          let postUrl = '';
          for (const href of links) {
            const m = href.match(/\\/(?:video|note)\\/(\\d{10,24})/) || href.match(/[?&](?:item_id|aweme_id)=(\\d{10,24})/);
            if (m) {
              postId = m[1];
              postUrl = href;
              break;
            }
          }
          if (!postId && fiberItemMap.size > 0 && title) {
            const normKey = title.replace(/\\s+/g, '').slice(0, 18).toLowerCase();
            for (const [k, id] of fiberItemMap.entries()) {
              if (normKey.includes(k.slice(0, 10)) || k.includes(normKey.slice(0, 10))) {
                postId = id;
                postUrl = 'https://www.douyin.com/note/' + postId;
                break;
              }
            }
          }
          if (!postId) {
            const attrs = Array.from(card.attributes).map((a) => a.value).join(' ') + ' ' + card.innerHTML.slice(0, 1600);
            const m = attrs.match(/(?:item_id_plain|item_id|aweme_id|note_id|video_id)[="'\\s:]+(\\d{12,24})/i);
            if (m) {
              postId = m[1];
              postUrl = 'https://www.douyin.com/note/' + postId;
            }
          }
          if (!postId) {
            const fiberId = extractIdFromFiber(card);
            if (fiberId) {
              postId = fiberId;
              postUrl = 'https://www.douyin.com/note/' + postId;
            }
          }
          const rawStatus = /审核中|待审核|审查中/.test(txt)
            ? '审核中'
            : /未通过|审核不通过|违规|已下架/.test(txt)
              ? '未通过'
              : /已发布|公开|可看|播放|浏览/.test(txt)
                ? '已发布'
                : '未知';
          const status = rawStatus === '审核中' ? 'UNDER_REVIEW' : rawStatus === '未通过' ? 'FAILED' : rawStatus === '已发布' ? 'PUBLISHED' : 'UNKNOWN';

          const metric = (labelRe) => {
            const m = txt.match(new RegExp(labelRe.source + '[:：\\\\s]*([0-9.,]+\\\\s*[万wW千kK]?)'));
            return m ? parseCount(m[1]) : 0;
          };
          const metrics = {
            views: metric(/(?:播放|浏览|阅读)/),
            likes: metric(/(?:点赞|获赞)/),
            comments: metric(/(?:评论)/),
            collections: metric(/(?:收藏)/),
            shares: metric(/(?:分享|转发)/),
          };
          const timeMatch = txt.match(/(\\d{4}年\\d{1,2}月\\d{1,2}日(?:\\s+\\d{1,2}:\\d{2})?|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:\\s+\\d{1,2}:\\d{2})?|\\d{1,2}月\\d{1,2}日\\s*\\d{0,2}:?\\d{0,2}|今天\\s*\\d{1,2}:\\d{2}|\\d+(?:分钟|小时|天)前)/);
          const dedupeKey = postId || title.slice(0, 40);
          if (!dedupeKey || seenKey.has(dedupeKey)) continue;
          seenKey.add(dedupeKey);
          posts.push({
            title: title.slice(0, 120),
            status,
            rawStatus,
            postId,
            awemeId: postId,
            postUrl,
            publishedAtText: timeMatch ? timeMatch[1] : '',
            metrics,
          });
          if (posts.length >= 20) break;
        }
        return { url: location.href, posts };
      })()`, true), 'extract-posts');
      }

      if (extracted.posts.length > 0) lastManageLoadedAt = Date.now();
      const matchPostId = normalizeStr(message.postId);
      const matchTitle = normalizeStr(message.title).toLowerCase();
      let matchedPost = null;
      if (matchPostId) {
        matchedPost = extracted.posts.find((p) => p.postId === matchPostId) || null;
      }
      if (!matchedPost && matchTitle) {
        matchedPost = extracted.posts.find((p) => {
          const t = normalizeStr(p.title).toLowerCase();
          return t && (t === matchTitle || t.includes(matchTitle.slice(0, 14)) || matchTitle.includes(t.slice(0, 14)));
        }) || null;
      }
      const primary = matchedPost || extracted.posts[0] || null;
      const hasAwemeId = Boolean(primary?.postId);
      const acctBudget = Math.min(2000, deadline - Date.now() - 200);
      if (acctBudget >= 400) {
        account = await Promise.race([
          checkAccount({ expectedAccount: message.expectedAccount }).catch(() => null),
          sleep(acctBudget).then(() => null),
        ]);
      }
      const elapsedMs = Date.now() - startedAt;

      return {
        status: hasAwemeId ? 'OK' : 'PENDING',
        partial: !hasAwemeId,
        observedState: primary?.status || (extracted.posts.length ? 'NO_MATCH' : 'LIST_EMPTY'),
        awemeId: primary?.postId || '',
        postUrl: primary?.postUrl || '',
        elapsedMs,
        account,
        url: extracted.url,
        totalFound: extracted.posts.length,
        matchedPost,
        posts: extracted.posts.slice(0, 10),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('CHECK_POSTS_TIMEOUT:')) {
        const win = getWin();
        return {
          status: 'PENDING',
          partial: true,
          observedState: 'TIMEOUT_20S',
          awemeId: '',
          postUrl: '',
          elapsedMs: Date.now() - startedAt,
          account,
          url: win && !win.isDestroyed() ? win.webContents.getURL() : MANAGE_URL,
          totalFound: 0,
          matchedPost: null,
          posts: [],
          note: `check_posts reached 20s cap (${msg}); returning PENDING without retry`,
        };
      }
      throw err;
    }
  };

  /**
   * Compound one-shot pipeline (`douyin_prepare_post`):
   * open/reuse upload page -> upload all images & confirm jump to edit page -> idempotent fill -> readback snapshot.
   */
  const preparePost = async (message = {}) => {
    const images = Array.isArray(message.images) ? message.images.filter((f) => typeof f === 'string' && f.trim()) : [];
    const title = typeof message.title === 'string' ? message.title.trim() : '';
    const body = typeof message.body === 'string' ? message.body.trim() : '';
    const hashtags = Array.isArray(message.hashtags)
      ? message.hashtags
      : (Array.isArray(message.tags) ? message.tags : []);
    if (!images.length) throw new Error('images (non-empty array of relative media paths) is required');

    // Step 1: Open or reuse Douyin Creator Center image upload page.
    let win = getWin();
    const curUrl = win && !win.isDestroyed() ? win.webContents.getURL() : '';
    const alreadyOnImageUpload = /creator\.douyin\.com\/creator-micro\/content\/upload/i.test(curUrl)
      && /default-tab=3/i.test(curUrl);
    if (!alreadyOnImageUpload) {
      if (win && !win.isDestroyed() && isDouyinPageUrl(curUrl)) {
        const wc = win.webContents;
        await new Promise((resolveNav) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolveNav(); } };
          wc.once('dom-ready', finish);
          setTimeout(finish, 8000);
          wc.loadURL(UPLOAD_IMAGE_URL).then(finish, finish);
        });
        const readyDeadline = Date.now() + 6000;
        while (Date.now() < readyDeadline) {
          const ready = await wc.executeJavaScript(`Boolean(document.querySelector('input[type="file"]') || /继续编辑|放弃|上传图文|点击上传/.test(document.body?.innerText || ''))`, true).catch(() => false);
          if (ready) break;
          await sleep(250);
        }
      } else {
        await openUrl(UPLOAD_IMAGE_URL);
        win = getWin();
        await sleep(800);
      }
    }
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');

    // On /content/upload, Douyin often omits nickname text until /content/post/image loads.
    // Only fail fast here if logged out or a DIFFERENT non-empty account is visible; strict match runs in fillPost.
    if (message.expectedAccount) {
      const acc = await checkAccount({ expectedAccount: message.expectedAccount });
      if (acc.loggedIn === false) {
        throw new Error('Douyin Creator Center is not logged in; please sign in first');
      }
      if ((acc.accountName || acc.accountId) && !acc.matched) {
        throw new Error(`Douyin account mismatch: expected "${message.expectedAccount}", got "${acc.accountName || '(unknown)'}" (ID: ${acc.accountId || 'unknown'})`);
      }
    }

    // Auto-dismiss blocking "继续编辑 / 放弃" draft modal on /content/upload so fresh images can be uploaded.
    const discardBtn = await win.webContents.executeJavaScript(`(() => {
      const txt = (document.body?.innerText || '');
      if (!/继续编辑|未发布的图文|草稿/.test(txt)) return null;
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const pick = btns.find((el) => /^(?:放弃|放弃草稿)$/.test((el.innerText || '').trim()));
      if (!pick) return null;
      const r = pick.getBoundingClientRect();
      return r.width > 12 && r.height > 12 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`, true).catch(() => null);
    if (discardBtn) {
      await clickPoint(win, discardBtn);
      await sleep(500);
    }

    // Step 2: Upload all images & confirm jump to /content/post/image.
    if (typeof uploadMedia !== 'function') {
      throw new Error('uploadMedia handler is unavailable');
    }
    const uploadRes = await uploadMedia({
      fileId: 0,
      files: images,
      skipExpectedCheck: true,
    });

    // Give the edit page React tree a brief moment to mount inputs after jump.
    const formDeadline = Date.now() + 3000;
    while (Date.now() < formDeadline) {
      const formReady = await win.webContents.executeJavaScript(`Boolean(document.querySelector('input[placeholder*="标题"], .zone-container[contenteditable="true"], [contenteditable="true"]'))`, true).catch(() => false);
      if (formReady) break;
      await sleep(250);
    }
    await sleep(300);

    // Step 3: Fill title, body, hashtags (default aiDisclosure = false), optional BGM import, and get readback snapshot.
    const fillRes = await fillPost({
      expectedAccount: message.expectedAccount,
      title,
      body,
      tags: hashtags,
      music: message.music || message.musicQuery || '',
      aiDisclosure: message.aiDisclosure === true,
    });

    return {
      status: 'OK',
      stage: 'draft_ready',
      files: uploadRes?.files || images,
      uploadedCount: uploadRes?.imageCount ?? fillRes.imageCount,
      ...fillRes,
    };
  };

  /** Fetches visible comments from Douyin Creator Center comment management page. */
  const fetchComments = async (message = {}) => {
    let win = getWin();
    const needOpen = !win || win.isDestroyed() || !/creator\.douyin\.com\/creator-micro\/interactive\/comment/i.test(win.webContents.getURL());
    if (needOpen || message.refresh !== false) {
      await openUrl(COMMENT_URL);
      win = getWin();
      await sleep(1600);
    }
    if (!win || win.isDestroyed()) throw new Error('browser window is closed');

    const account = await checkAccount({ expectedAccount: message.expectedAccount });
    const raw = await win.webContents.executeJavaScript(`(() => {
      const rows = Array.from(document.querySelectorAll('[class*="comment-item"], [class*="comment_item"], [class*="comment-card"], [data-e2e*="comment"], li, tr'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const txt = (el.innerText || '').trim();
          return r.width > 220 && r.height > 36 && txt.length >= 4 && /回复/.test(txt);
        });
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const txt = (row.innerText || '').replace(/\\r/g, '').trim();
        const lines = txt.split('\\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const user = lines[0].slice(0, 60);
        const contentLine = lines.find((l, i) => i > 0 && l.length >= 1 && !/^(?:回复|删除|置顶|举报|点赞|展开|收起|作者|\\d+(?:分钟|小时|天)前|\\d{4}-\\d{2}-\\d{2})$/.test(l)) || '';
        if (!contentLine) continue;
        const isReplied = /作者回复|已回复|我的回复/.test(txt);
        const key = user + '|' + contentLine.slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          user,
          text: contentLine.slice(0, 300),
          isReplied,
          snippet: txt.slice(0, 200),
        });
        if (out.length >= 30) break;
      }
      return { url: location.href, comments: out };
    })()`, true);

    const comments = (raw.comments || []).map((c) => ({
      commentId: `c_${createHash('sha256').update(`${c.user}|${c.text}`).digest('hex').slice(0, 12)}`,
      user: c.user,
      text: c.text,
      isReplied: c.isReplied === true,
    }));

    return {
      account,
      url: raw.url,
      totalVisible: comments.length,
      comments,
    };
  };

  /** Replies to a specific comment on Douyin Creator Center comment management page. */
  const replyComment = async (message = {}) => {
    const win = await requireDouyinWindow(COMMENT_URL);
    const account = await checkAccount({ expectedAccount: message.expectedAccount });
    if (message.expectedAccount && !account.matched) {
      throw new Error(`Douyin account mismatch before reply: expected "${message.expectedAccount}", got "${account.accountName || '(unknown)'}"`);
    }
    const replyText = normalizeStr(message.replyText);
    if (!replyText) throw new Error('replyText is required');
    const targetUser = normalizeStr(message.commentUser).toLowerCase();
    const targetSnippet = normalizeStr(message.commentText).toLowerCase();
    if (!targetUser && !targetSnippet) {
      throw new Error('commentUser or commentText is required to locate the comment row');
    }

    const located = await win.webContents.executeJavaScript(`(() => {
      const targetUser = ${JSON.stringify(targetUser)};
      const targetSnippet = ${JSON.stringify(targetSnippet)};
      const rows = Array.from(document.querySelectorAll('[class*="comment-item"], [class*="comment_item"], [class*="comment-card"], [data-e2e*="comment"], li, tr'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 220 && r.height > 36;
        });
      for (const row of rows) {
        const txt = (row.innerText || '').replace(/\\s+/g, ' ').trim();
        const low = txt.toLowerCase();
        if (targetUser && !low.includes(targetUser)) continue;
        if (targetSnippet && !low.includes(targetSnippet.slice(0, 20))) continue;
        if (/作者回复|已回复|我的回复/.test(txt)) {
          return { found: true, alreadyReplied: true };
        }
        const replyBtn = Array.from(row.querySelectorAll('button, span, a, [role="button"]')).find((el) => {
          const t = (el.innerText || '').trim();
          const r = el.getBoundingClientRect();
          return /^回复$/.test(t) && r.width > 8 && r.height > 8;
        });
        if (!replyBtn) continue;
        replyBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = replyBtn.getBoundingClientRect();
        return { found: true, alreadyReplied: false, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return { found: false };
    })()`, true);

    if (!located?.found) {
      throw new Error('matching comment row not found on current Douyin comment page');
    }
    if (located.alreadyReplied) {
      return { replied: false, alreadyReplied: true, account, url: win.webContents.getURL() };
    }

    await clickPoint(win, located);
    await sleep(350);

    const inputPt = await win.webContents.executeJavaScript(`(() => {
      const boxes = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')).filter((el) => {
        const r = el.getBoundingClientRect();
        const ph = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
        return r.width > 60 && r.height > 18 && (/回复|评论|reply|comment/.test(ph) || el === document.activeElement);
      });
      const box = boxes.at(-1) || document.activeElement;
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return { x: r.left + Math.min(r.width * 0.4, 100), y: r.top + r.height / 2 };
    })()`, true);
    if (!inputPt) throw new Error('comment reply input box did not appear after clicking 回复');

    await clickPoint(win, inputPt);
    win.webContents.insertText(replyText);
    await sleep(250);

    const sendBtn = await win.webContents.executeJavaScript(`(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
        if (el.disabled) return false;
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 14 && /^(?:发送|回复|提交)$/.test(t);
      });
      const pick = btns.at(-1);
      if (!pick) return null;
      const r = pick.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (pick.innerText || '').trim() };
    })()`, true);
    if (!sendBtn) throw new Error('reply submit button ("发送"/"回复") not found');

    await clickPoint(win, sendBtn);
    await sleep(800);

    const verified = await win.webContents.executeJavaScript(`(() => {
      const body = (document.body?.innerText || '');
      const toast = /回复成功|发送成功|评论成功/.test(body);
      const rendered = body.includes(${JSON.stringify(replyText.slice(0, 20))});
      return { verified: toast || rendered, toast, rendered };
    })()`, true).catch(() => ({ verified: false, toast: false, rendered: false }));

    const page = await settle().catch(() => null);
    return {
      replied: true,
      verified: verified.verified === true,
      account,
      replyText,
      url: win.webContents.getURL(),
      ...(page ? { state: page } : {}),
    };
  };

  return {
    checkAccount,
    fillPost,
    selectMusic,
    publishPost,
    checkPosts,
    preparePost,
    fetchComments,
    replyComment,
  };
}

module.exports = { createDouyinOpsHandlers, normalizeAccountIdentity, accountMatches };
