/* ============================================================
 *  bilibili 漫画连续抓取脚本（canvas 截图版，默认 20 话一包 ZIP）
 *
 *  使用方法：
 *    1. 在 reader 页面打开 DevTools（https://manga.bilibili.com/mc{xxx}/{ep_id}）
 *    2. Sources 面板按 Cmd+F8 关掉断点暂停（避免 anti-debug 卡住）
 *    3. 把本文件完整内容粘贴到 Console 回车
 *    4. 脚本会自动一话一话往后抓，每抓完一话显示累计话数
 *    5. 点红色 STOP 按钮 → 当前话收尾后停止；最多自动抓 100 话
 *    6. 默认每满 20 话自动生成一个绿色下载按钮；结束时不足 20 话也会打尾包
 *       如需临时改批量：运行前在 Console 设置 window.__biliMangaBatchSize = 10
 *    7. 每张写入前都会校验当前 ep_id，发现跨话立即收束，避免串话截图
 *
 *  原理：
 *    - bilibili CDN 上的 .avif 实际是 WASM 加密字节，直接下载无法解码
 *    - 改为：iframe 取干净的 HTMLCanvasElement.prototype.toDataURL
 *      （reader 把它覆盖成 anti-screenshot 版本了）
 *    - PgUp 回本话首页 → 截图 → PgDn 翻页 → 截图（hash 去重 + 稳定性校验 + URL 跨章监测）
 *    - 单话结束后 PgDn 推进到下一话，循环；每批独立 JSZip + Blob URL 下载按钮
 * ============================================================ */
function parseChineseChapterNumber(text) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return null;

  if (/^[零〇一二两三四五六七八九]+$/.test(s)) {
    const value = Array.from(s).reduce((n, ch) => n * 10 + digits[ch], 0);
    return value > 0 ? value : null;
  }

  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(digits, ch)) {
      current = digits[ch];
    } else if (Object.prototype.hasOwnProperty.call(units, ch)) {
      total += (current || 1) * units[ch];
      current = 0;
    } else {
      return null;
    }
  }

  const value = total + current;
  return value > 0 ? value : null;
}

function getChapterNumberFromTitle(title) {
  const text = String(title || '');
  const arabic = text.match(/第\s*0*(\d+)\s*[话話章回]/);
  if (arabic) {
    const value = Number(arabic[1]);
    return value > 0 ? value : null;
  }

  const chinese = text.match(/第\s*([零〇一二两三四五六七八九十百千]+)\s*[话話章回]/);
  return chinese ? parseChineseChapterNumber(chinese[1]) : null;
}

function sanitizeFileName(s, fallback) {
  return String(s || fallback || 'manga')
    .replace(/[\/\\?<>:*|"\n\r\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || fallback || 'manga';
}

function getMangaNameFromTitle(title) {
  const raw = String(title || '').trim();
  const parts = raw
    .replace(/\s*[-—｜|]\s*(哔哩哔哩漫画|bilibili.*)$/i, '')
    .split(/\s*[-—｜|]\s*/)
    .map(s => s.trim())
    .filter(Boolean);
  const picked = parts.find(part =>
    !getChapterNumberFromTitle(part) &&
    !/(漫画全集在线观看|全集在线观看|在线观看|哔哩哔哩漫画|bilibili)/i.test(part)
  );
  return sanitizeFileName(picked || parts[0] || raw || 'manga', 'manga');
}

function makeChapterFolderName(title) {
  const chapterNumber = getChapterNumberFromTitle(title);
  return chapterNumber
    ? String(chapterNumber).padStart(3, '0') + '_' + title
    : title;
}

function makeChapterRangeLabel(chapters, batchNo, fallbackStartNo) {
  const nums = chapters.map(ch => getChapterNumberFromTitle(ch.title));
  if (nums.length > 0 && nums.every(n => Number.isFinite(n) && n > 0)) {
    const first = nums[0];
    const last = nums[nums.length - 1];
    return first === last ? '第' + first + '话' : '第' + first + '-' + last + '话';
  }
  const fallbackEndNo = fallbackStartNo + chapters.length - 1;
  return 'batch_' + String(batchNo).padStart(2, '0') + '_' +
    String(fallbackStartNo).padStart(3, '0') + '-' + String(fallbackEndNo).padStart(3, '0');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getChapterNumberFromTitle,
    getMangaNameFromTitle,
    makeChapterFolderName,
    makeChapterRangeLabel,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
(async () => {
  // ============ 0. 从隐藏 iframe 拿干净的 console + toDataURL ============
  let CC = console;
  let rawToDataURL = HTMLCanvasElement.prototype.toDataURL;
  try {
    const ifr = document.createElement('iframe');
    Object.assign(ifr.style, {
      display: 'none', width: '0', height: '0',
      border: '0', position: 'absolute',
    });
    ifr.src = 'about:blank';
    document.documentElement.appendChild(ifr);
    CC = ifr.contentWindow.console;
    rawToDataURL = ifr.contentWindow.HTMLCanvasElement.prototype.toDataURL;
    window.__cleanConsoleIframe = ifr;
    try { window.console = CC; } catch (_) {}
    try { Object.defineProperty(window, 'console', { value: CC, configurable: true, writable: true }); } catch (_) {}
    const noop = () => {};
    try { CC.clear = noop; } catch (_) {}
    try { CC.debug = noop; } catch (_) {}
    try { console.clear = noop; } catch (_) {}
    try { console.debug = noop; } catch (_) {}
    CC.log('[manga] console + toDataURL restored, clear/debug muted');
  } catch (e) {
    console.log('iframe restore failed', e);
  }
  const CL = (...a) => CC.log('[manga]', ...a);
  const CW = (...a) => CC.warn('[manga]', ...a);
  const CE = (...a) => CC.error('[manga]', ...a);

  // ============ 0.5 浮层日志 ============
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    right: '8px',
    bottom: '8px',
    width: '380px',
    maxHeight: '320px',
    overflow: 'auto',
    background: 'rgba(0,0,0,0.85)',
    color: '#0f0',
    font: '12px/1.4 ui-monospace, monospace',
    padding: '8px 10px',
    zIndex: '99999',
    borderRadius: '8px',
    boxShadow: '0 2px 10px #000',
  });
  box.id = '__manga_log';
  document.body.appendChild(box);
  const ui = (msg, color) => {
    const ts = new Date().toTimeString().slice(0, 8);
    const div = document.createElement('div');
    div.style.color = color || '#0f0';
    div.textContent = '[' + ts + '] ' + msg;
    box.appendChild(div);
    box.scrollTop = 1e9;
  };
  const log = (...a) => { CL(...a); ui(a.join(' '), '#0f0'); };
  const warn = (...a) => { CW(...a); ui(a.join(' '), '#fa0'); };
  const err = (...a) => { CE(...a); ui(a.join(' '), '#f55'); };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const RATE_LIMIT = {
    pageRestMs: [0, 0],
    chapterRestMs: [3000, 5000],
  };
  const MAX_CHAPTER_RETRIES = 3;
  const BATCH_SIZE = Math.max(1, Math.min(50, Number(window.__biliMangaBatchSize) || 20));
  const randomMs = ([min, max]) => Math.floor(min + Math.random() * (max - min + 1));
  const rest = async (label, range) => {
    const ms = randomMs(range);
    if (ms <= 0) return !stopRequested;
    log(label + '，休息 ' + (ms / 1000).toFixed(1) + 's');
    const endAt = Date.now() + ms;
    while (!stopRequested && Date.now() < endAt) {
      await sleep(Math.min(250, endAt - Date.now()));
    }
    return !stopRequested;
  };
  log('rate limit: pages ' + (RATE_LIMIT.pageRestMs[0] / 1000).toFixed(1) + '-' +
      (RATE_LIMIT.pageRestMs[1] / 1000).toFixed(1) + 's, chapters ' +
      (RATE_LIMIT.chapterRestMs[0] / 1000).toFixed(1) + '-' +
      (RATE_LIMIT.chapterRestMs[1] / 1000).toFixed(1) + 's');

  // ============ 1. 加载 JSZip ============
  if (!window.JSZip) {
    const cdns = [
      'https://fastly.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
      'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
      'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    ];
    let loaded = false;
    for (const url of cdns) {
      try {
        log('try ' + new URL(url).host);
        const code = await fetch(url, { cache: 'reload' }).then(r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        });
        new Function(code)();
        if (window.JSZip) { loaded = true; log('JSZip OK'); break; }
      } catch (e) { warn('fail: ' + e.message); }
    }
    if (!loaded) { err('all CDNs failed'); return; }
  }

  // ============ 2. 初始 canvas 检查 + 独立浮窗 STOP 按钮 + 章节标题提取 ============
  // canvas 不缓存：reader 翻页时会替换 DOM 节点。getCurrentCanvas() 在第 4 节定义
  const _initCanvases = Array.from(document.querySelectorAll('canvas'));
  log('canvases=' + _initCanvases.length + ' [' +
      _initCanvases.map(c => c.width + 'x' + c.height).join(', ') + ']');
  if (_initCanvases.length === 0) { err('no canvas found'); return; }

  // 漫画作品名（从 document.title 提取，去掉站点后缀）→ 用作分批 ZIP 文件名
  const mangaName = getMangaNameFromTitle(document.title);

  // 当前章节标题（每话调用一次，需在话切换后给一点 reader 更新 DOM 的时间）
  // 优先从已知的 reader UI 标题位拿；fallback 用 document.title 中"第 N 话 ..."部分
  const getChapterTitle = (epId) => {
    // 按优先级尝试多个 selector（从用户提供的精确路径到宽松匹配）
    const selectors = [
      // 用户实测精确路径：info-hud 浮层里的第二个 div 是话标题
      '.reader-layout .info-layer .info-hud .info-text > div:nth-child(2)',
      '.info-hud .info-text > div:nth-child(2)',
      '.info-text > div:nth-child(2)',
      // 其他可能的 reader UI 标题节点（宽松类名匹配）
      '.manga-reader-header', '.reader-header', '.ep-name', '.episode-title',
      '[class*="EpisodeTitle"]', '[class*="chapter-title"]',
    ];
    let raw = '';
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        const t = el?.textContent?.trim();
        if (t) { raw = t; break; }
      } catch (_) {}
    }
    // 兜底：document.title 里通常含"第 X 话 标题"
    if (!raw) {
      const t = (document.title || '').trim();
      const m = t.match(/第\s*[0-9一二三四五六七八九十百千零]+\s*[话話章回]\s*[^-—｜|]*/);
      raw = m ? m[0].trim() : '';
    }
    if (!raw) raw = 'ep_' + epId;
    // 文件名安全化：去掉 /\?<>:*|" 和换行，限长 100
    return sanitizeFileName(raw, 'ep_' + epId);
  };

  // 独立浮窗 STOP 按钮（top-right，固定位置，不随日志滚动）
  let stopRequested = false;
  const stopBtn = document.createElement('button');
  Object.assign(stopBtn.style, {
    position: 'fixed', top: '12px', right: '12px', zIndex: '999999',
    padding: '12px 20px', background: '#c33', color: '#fff',
    border: '3px solid #fff', borderRadius: '8px', cursor: 'pointer',
    font: 'bold 14px/1.3 ui-monospace, monospace',
    boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
  });
  stopBtn.id = '__manga_stop';
  stopBtn.textContent = '■ STOP & 打包';
  stopBtn.onclick = () => {
    stopRequested = true;
    stopBtn.textContent = '⏸ 停止中（等本话收尾）...';
    stopBtn.disabled = true;
    stopBtn.style.background = '#888';
  };
  document.body.appendChild(stopBtn);

  // 分批 ZIP 下载按钮容器（也独立 fixed，避免被日志覆盖）
  const finalBtnHost = document.createElement('div');
  Object.assign(finalBtnHost.style, {
    position: 'fixed', top: '60px', right: '12px', zIndex: '999999',
    maxWidth: '320px',
    maxHeight: 'calc(100vh - 72px)',
    overflow: 'auto',
  });
  document.body.appendChild(finalBtnHost);

  // ============ 3. 翻页助手 ============
  // 单一 dispatch 在 canvas 上：事件 bubble=true 会向上传播到 reader 容器、body、document、window
  // 任何在祖先链上的监听器都会触发一次（不会像 multi-target 那样多次触发）
  // 不在 canvas 上 dispatch 是因为 document/window 不一定能触发 reader 的捕获
  const press = (key) => {
    const c = getCurrentCanvas();
    if (!c) { warn('press: no canvas'); return; }
    const code = key === 'PageDown' ? 34 : 33;
    const opts = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true };
    c.dispatchEvent(new KeyboardEvent('keydown', opts));
    c.dispatchEvent(new KeyboardEvent('keyup', opts));
  };

  // 当前章节 ep_id（从 URL 提取），用于检测翻过头跨章
  const getEpFromUrl = () => location.pathname.split('/').filter(Boolean).pop();
  const getDisplayedTotalPages = () => {
    const text = document.body.innerText || '';
    const m = text.match(/(\d+)\s*P\b/i);
    return m ? Number(m[1]) : null;
  };
  const returnToEp = async (epId, preferredKey) => {
    if (getEpFromUrl() === epId) return true;
    warn('returning to ep=' + epId + ' for retry...');
    const keys = preferredKey === 'PageDown' ? ['PageDown', 'PageUp'] : ['PageUp', 'PageDown'];
    for (const key of keys) {
      for (let i = 0; i < 8; i++) {
        press(key);
        await sleep(700);
        if (getEpFromUrl() === epId) {
          await sleep(800);
          return true;
        }
      }
    }
    warn('could not return to ep=' + epId + ', current=' + getEpFromUrl());
    return false;
  };

  // ============ 4. canvas 截图 + 哈希去重 ============
  // 关键修正：reader 翻页时可能换/重建 canvas DOM 节点，
  // 必须每次截图前实时重新查询（不能缓存 canvas 引用）
  function getCurrentCanvas() {
    const all = Array.from(document.querySelectorAll('canvas'))
      .filter(c => c.isConnected && c.width > 100 && c.height > 100);
    return all.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  }

  // 末尾 600 字符 + 总长度作为轻量哈希
  const sigOf = (url) => url.length + ':' + url.slice(-600);

  const captureCanvas = () => {
    const c = getCurrentCanvas();
    if (!c) return null;
    try {
      return rawToDataURL.call(c, 'image/png');
    } catch (e) {
      warn('toDataURL failed: ' + e.message);
      return null;
    }
  };

  // 诊断：每次 stall 时打印 canvas 列表，便于排查
  const dumpCanvases = () => {
    const all = Array.from(document.querySelectorAll('canvas'));
    warn('canvas dump (' + all.length + '): ' + all.map((c, i) =>
      i + ':' + c.width + 'x' + c.height + (c.isConnected ? '' : '[detached]')
    ).join(', '));
  };

  // 等待新页面渲染完成：
  //   1) sig 必须与 prevSig 不同（说明翻到了新页）
  //   2) 新 sig 必须连续 stableMs 毫秒不变（说明 WASM 解密+渲染已完成，不再有 loading/过渡帧）
  // 返回 { url, sig }、{ crossedEp } 或 null（超时）
  const waitForNewStablePage = async (prevSig, maxMs, stableMs, expectedEp) => {
    const start = Date.now();
    let currentSig = null;
    let stableSince = 0;
    while (Date.now() - start < maxMs) {
      await sleep(120);
      const currentEp = getEpFromUrl();
      if (expectedEp && currentEp !== expectedEp) {
        return { crossedEp: currentEp };
      }
      const url = captureCanvas();
      if (!url || url.length < 1000) continue;
      const sig = sigOf(url);
      if (sig === prevSig) {
        // 仍是上一页，等翻页生效
        currentSig = null; stableSince = 0;
        continue;
      }
      if (sig === currentSig) {
        // 连续两次采样一致，累积稳定时长
        if (Date.now() - stableSince >= stableMs) return { url, sig };
      } else {
        // 首次看到这个新 sig（或与上次采样不同，可能是过渡帧）
        currentSig = sig;
        stableSince = Date.now();
      }
    }
    return null;
  };

  // ============ 5. 单话抓取函数：rewind → 逐页截图 → 返回 {epId, title, captures} ============
  async function captureChapter() {
    const epId = getEpFromUrl();
    const displayedTotal = getDisplayedTotalPages();
    const total = displayedTotal || 50;
    const title = getChapterTitle(epId);
    log('━━━ ep=' + epId + ' "' + title + '" total=' + total + ' ━━━');

    const captures = [];
    const seenSigs = new Set();
    let lastSig = '';
    let completed = false; // true 表示本话已自然结束（跨章/抓满/stall 3 次）；false=被 STOP 中断

    // 回到本话首页（已在首页时 PgUp 会跨到上一话，立即 PgDown 回来）
    log('rewind to first page of ep=' + epId);
    let rewindCount = 0;
    for (let i = 0; i < total + 5; i++) {
      if (stopRequested) {
        return { epId, title, expectedPages: displayedTotal, captures, completed: false, endedOnEp: getEpFromUrl() };
      }
      const before = getEpFromUrl();
      press('PageUp');
      await sleep(300);
      const after = getEpFromUrl();
      if (after !== before) {
        log('rewind crossed to prev ep=' + after + ', stepping forward back to ep=' + epId);
        if (!(await returnToEp(epId, 'PageDown'))) {
          return {
            epId,
            title,
            expectedPages: displayedTotal,
            captures,
            completed: false,
            endedOnEp: getEpFromUrl(),
            navigationMismatch: true,
          };
        }
        break;
      }
      rewindCount++;
    }
    log('rewind done (' + rewindCount + ' steps)');
    await sleep(500);

    // 等首页稳定
    let first = await waitForNewStablePage('', 8000, 500, epId);
    if (first?.crossedEp) {
      warn('ep mismatch before first capture: expected ' + epId + ', current ' + first.crossedEp);
      return {
        epId,
        title,
        expectedPages: displayedTotal,
        captures,
        completed: false,
        endedOnEp: first.crossedEp,
        navigationMismatch: true,
      };
    }
    if (!first) {
      const currentEp = getEpFromUrl();
      if (currentEp !== epId) {
        warn('ep mismatch before fallback first capture: expected ' + epId + ', current ' + currentEp);
        return {
          epId,
          title,
          expectedPages: displayedTotal,
          captures,
          completed: false,
          endedOnEp: currentEp,
          navigationMismatch: true,
        };
      }
      const url = captureCanvas();
      if (url && url.length > 1000) first = { url, sig: sigOf(url) };
    }
    if (!first) {
      err('first page never rendered for ep=' + epId);
      return { epId, title, expectedPages: displayedTotal, captures, completed: false, endedOnEp: getEpFromUrl() };
    }
    const firstCaptureEp = getEpFromUrl();
    if (firstCaptureEp !== epId) {
      warn('ep mismatch before writing first capture: expected ' + epId + ', current ' + firstCaptureEp);
      return {
        epId,
        title,
        expectedPages: displayedTotal,
        captures,
        completed: false,
        endedOnEp: firstCaptureEp,
        navigationMismatch: true,
      };
    }
    captures.push({ b64: first.url.split(',')[1], sig: first.sig });
    seenSigs.add(first.sig);
    lastSig = first.sig;
    log('captured page 1 (' + Math.round(first.url.length / 1024) + 'KB)');

    // 翻页 + 截图
    let stallCount = 0;
    const MAX_ITER = total + 8;
    for (let i = 1; i < MAX_ITER; i++) {
      if (stopRequested) break; // completed 保持 false → 整话被丢弃
      if (!(await rest('页间节流', RATE_LIMIT.pageRestMs))) break;
      press('PageDown');
      const next = await waitForNewStablePage(lastSig, 8000, 500, epId);

      if (next?.crossedEp) {
        log('crossed to next ep (' + next.crossedEp + '), end of ' + epId);
        completed = true;
        break;
      }

      const nowEp = getEpFromUrl();
      if (nowEp !== epId) {
        log('crossed to next ep (' + nowEp + '), end of ' + epId);
        completed = true;
        break;
      }

      if (next && !seenSigs.has(next.sig)) {
        const captureEp = getEpFromUrl();
        if (captureEp !== epId) {
          log('crossed to next ep (' + captureEp + '), end of ' + epId);
          completed = true;
          break;
        }
        seenSigs.add(next.sig);
        captures.push({ b64: next.url.split(',')[1], sig: next.sig });
        lastSig = next.sig;
        stallCount = 0;
        log('captured page ' + captures.length + ' (' + Math.round(next.url.length / 1024) + 'KB)');
      } else {
        stallCount++;
        warn('no new stable page (stall ' + stallCount + '/3)');
        if (stallCount === 1) dumpCanvases();
        if (stallCount >= 3) { warn('end of chapter ' + epId); completed = true; break; }
      }

      if (captures.length >= total) { log('got all ' + total + ' pages of ' + epId); completed = true; break; }
    }

    return { epId, title, expectedPages: displayedTotal, captures, completed, endedOnEp: getEpFromUrl() };
  }

  async function captureChapterWithRetry() {
    for (let attempt = 1; attempt <= MAX_CHAPTER_RETRIES; attempt++) {
      const result = await captureChapter();
      if (result.navigationMismatch) {
        warn('navigation mismatch ep=' + result.epId + ': current=' +
            result.endedOnEp + ' (retry ' + attempt + '/' + MAX_CHAPTER_RETRIES + ')');
        if (attempt >= MAX_CHAPTER_RETRIES || stopRequested) {
          return { ...result, completed: false, pageCountMismatch: true };
        }
        if (!(await returnToEp(result.epId, 'PageDown'))) {
          return { ...result, completed: false, pageCountMismatch: true };
        }
        await rest('重试前节流', RATE_LIMIT.chapterRestMs);
        continue;
      }
      if (!result.completed || !result.expectedPages) return result;
      if (result.captures.length === result.expectedPages) {
        log('page count OK ep=' + result.epId + ' (' + result.captures.length + '/' + result.expectedPages + ')');
        return result;
      }

      warn('page count mismatch ep=' + result.epId + ': got ' + result.captures.length +
          ', expected ' + result.expectedPages + ' (retry ' + attempt + '/' + MAX_CHAPTER_RETRIES + ')');
      if (attempt >= MAX_CHAPTER_RETRIES || stopRequested) {
        return { ...result, completed: false, pageCountMismatch: true };
      }
      if (!(await returnToEp(result.epId))) {
        return { ...result, completed: false, pageCountMismatch: true };
      }
      await rest('重试前节流', RATE_LIMIT.chapterRestMs);
    }
    return { epId: getEpFromUrl(), title: '', expectedPages: null, captures: [], completed: false, endedOnEp: getEpFromUrl() };
  }

  // ============ 6. 分批打包：每批生成一个不覆盖旧按钮的 ZIP ============
  async function saveZipBlob(filename, zipBlob) {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'ZIP archive',
          accept: { 'application/zip': ['.zip'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(zipBlob);
      await writable.close();
      return 'file-picker';
    }

    const blobUrl = URL.createObjectURL(zipBlob);
    try {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return 'blob-url';
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
  }

  function releaseChapterPayloads(chapters) {
    chapters.forEach((ch) => {
      ch.captures.forEach((c) => {
        c.b64 = '';
        c.sig = '';
      });
      ch.captures.length = 0;
    });
    chapters.length = 0;
  }

  async function createZipDownloadButton(chapters, batchNo, startChapterNo) {
    if (!chapters.length) return null;

    const chapterCount = chapters.length;
    const totalPages = chapters.reduce((s, c) => s + c.captures.length, 0);
    const batchLabel = makeChapterRangeLabel(chapters, batchNo, startChapterNo);

    log('━━━ packing ' + batchLabel + ': ' + chapterCount + ' chapters / ' + totalPages + ' pages ━━━');

    const zip = new JSZip();
    let rawBytes = 0;
    chapters.forEach((ch) => {
      const folderName = makeChapterFolderName(ch.title);
      const folder = zip.folder(folderName);
      ch.captures.forEach((c, i) => {
        folder.file('page_' + String(i + 1).padStart(3, '0') + '.png', c.b64, { base64: true });
        rawBytes += Math.round(c.b64.length * 0.75);
      });
    });

    log(batchLabel + ' input ~' + Math.round(rawBytes / 1024 / 1024) + 'MB, generating Blob...');
    let zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'STORE',
      streamFiles: true,
    });
    const zipMB = (zipBlob.size / 1024 / 1024).toFixed(1);
    const filename = mangaName + '_' + batchLabel + '_' + chapterCount + 'eps_' + totalPages + 'p.zip';
    releaseChapterPayloads(chapters);

    const dlBtn = document.createElement('button');
    Object.assign(dlBtn.style, {
      display: 'block', width: '100%', marginTop: '8px', padding: '12px 16px',
      background: '#0a6', color: '#fff', border: '3px solid #fff',
      borderRadius: '8px', cursor: 'pointer',
      font: 'bold 14px/1.4 ui-monospace, monospace',
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)', textAlign: 'left',
      wordBreak: 'break-all', whiteSpace: 'pre-wrap',
    });
    const readyText = '⬇ 下载 ZIP ' + batchLabel + '\n' + filename + '\n(' +
      chapterCount + ' 话 / ' + totalPages + ' 页 / ' + zipMB + 'MB)';
    dlBtn.textContent = readyText;
    dlBtn.onclick = async function () {
      if (!zipBlob) {
        warn('ZIP blob already released: ' + filename);
        return;
      }
      dlBtn.disabled = true;
      dlBtn.textContent = '保存中...\n' + filename;
      try {
        const method = await saveZipBlob(filename, zipBlob);
        zipBlob = null;
        dlBtn.textContent = '✓ 已保存(' + method + '): ' + filename;
        dlBtn.style.background = '#444';
      } catch (e) {
        const isAbort = e?.name === 'AbortError';
        warn((isAbort ? 'save canceled: ' : 'save failed: ') + (e?.message || e));
        dlBtn.disabled = false;
        dlBtn.textContent = readyText;
      }
    };
    finalBtnHost.appendChild(dlBtn);
    finalBtnHost.scrollTop = finalBtnHost.scrollHeight;

    log(batchLabel + ' ready — 右上角新增下载按钮，不会覆盖旧按钮');
    return { batchLabel, totalPages, zipMB };
  }

  // ============ 7. 主循环：连续抓多话，每批打一包 ============
  const MAX_CHAPTERS = 100;
  const batchChapters = []; // 当前未打包批次：[{epId, title, captures: [{b64, sig}]}, ...]
  const doneEps = new Set();
  let completedChapterCount = 0;
  let totalCapturedPages = 0;
  let generatedBatchCount = 0;

  while (!stopRequested && completedChapterCount < MAX_CHAPTERS) {
    const beforeEp = getEpFromUrl();
    if (doneEps.has(beforeEp)) {
      warn('ep=' + beforeEp + ' already captured, stop to avoid loop');
      break;
    }
    const result = await captureChapterWithRetry();
    if (result.pageCountMismatch) {
      warn('discard mismatched ep=' + result.epId + ' after retries');
      break;
    }
    // 只收完整抓完的话；中途被 STOP 打断的不计入（用户要求舍弃）
    if (result.completed && result.captures.length > 0) {
      batchChapters.push(result);
      completedChapterCount++;
      totalCapturedPages += result.captures.length;
      doneEps.add(result.epId);
      log('已抓完 ' + completedChapterCount + ' 话，本批 ' + batchChapters.length + '/' +
          BATCH_SIZE + '，累计 ' + totalCapturedPages + ' 页');
      if (batchChapters.length >= BATCH_SIZE) {
        const batch = batchChapters.splice(0, batchChapters.length);
        generatedBatchCount++;
        await createZipDownloadButton(batch, generatedBatchCount, completedChapterCount - batch.length + 1);
      }
    } else if (!result.completed && result.captures.length > 0) {
      warn('discard partial ep=' + result.epId + ' (' + result.captures.length + ' incomplete pages, STOP mid-chapter)');
    }

    if (stopRequested) { log('STOP requested, halting'); break; }
    if (completedChapterCount >= MAX_CHAPTERS) { log('reached MAX_CHAPTERS=' + MAX_CHAPTERS); break; }
    if (!(await rest('话间节流', RATE_LIMIT.chapterRestMs))) {
      log('STOP requested during chapter rest, halting');
      break;
    }

    if (result.completed && result.endedOnEp && result.endedOnEp !== result.epId) {
      log('already at next chapter ep=' + result.endedOnEp + ', skip extra advance');
      await sleep(1500);
      continue;
    }

    // 推进到下一话
    log('advancing to next chapter...');
    const epBefore = getEpFromUrl();
    let advanced = false;
    for (let i = 0; i < 5; i++) {
      press('PageDown');
      await sleep(800);
      if (getEpFromUrl() !== epBefore) { advanced = true; break; }
    }
    if (!advanced) {
      log('could not advance past ep=' + epBefore + ', end of manga');
      break;
    }
    await sleep(1500); // 新话给 reader 加载缓冲
  }

  // ============ 8. 收尾：不足一批时生成尾包 ============
  if (completedChapterCount === 0) {
    err('no chapter captured');
    return;
  }

  if (batchChapters.length > 0) {
    const batch = batchChapters.splice(0, batchChapters.length);
    generatedBatchCount++;
    await createZipDownloadButton(batch, generatedBatchCount, completedChapterCount - batch.length + 1);
  }

  stopBtn.textContent = '— 完成 —';
  stopBtn.disabled = true;
  stopBtn.style.background = '#444';
  log('━━━ done: ' + completedChapterCount + ' chapters / ' + totalCapturedPages +
      ' pages, batches=' + generatedBatchCount + ' ━━━');
  log('ZIP ready — 点右上角绿色按钮下载各批次');
})();
}
