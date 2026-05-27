// ==UserScript==
// @name         Bilibili Manga Grabber
// @namespace    https://manga.bilibili.com/
// @version      1.0.0
// @description  Bilibili 漫画 canvas 截图抓取，默认 20 话一包 ZIP，手动点击 START 后运行。
// @match        https://manga.bilibili.com/mc*/*
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

/* ============================================================
 *  bilibili 漫画连续抓取脚本（canvas 截图版，默认 20 话一包 ZIP）
 *
 *  使用方法：
 *    1. 把本文件作为 Tampermonkey / Violentmonkey 用户脚本安装
 *    2. 打开 reader 页面：https://manga.bilibili.com/mc{xxx}/{ep_id}
 *    3. 页面右上角出现 START 按钮后点击开始抓取
 *    4. 点红色 STOP 按钮 → 当前话收尾后停止；最多自动抓 100 话
 *    5. 默认每满 20 话自动生成一个绿色下载按钮；结束时不足 20 话也会打尾包
 *       如需临时改批量：运行前在页面设置 window.__biliMangaBatchSize = 10
 *    6. 每张写入前都会校验当前 ep_id，发现跨话立即收束，避免串话截图
 *
 *  原理：
 *    - bilibili CDN 上的 .avif 实际是 WASM 加密字节，直接下载无法解码
 *    - 改为：iframe 取干净的 HTMLCanvasElement.prototype.toBlob
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

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
async function runBiliMangaGrabber() {
  if (window.__biliMangaGrabberRunning) {
    window.alert('Bilibili Manga Grabber 正在运行中');
    return;
  }
  window.__biliMangaGrabberRunning = true;
  let audioKeepAlive = null;
  try {
  try {
    if (!window.JSZip && typeof JSZip !== 'undefined') window.JSZip = JSZip;
  } catch (_) {}
  // ============ 0. 从隐藏 iframe 拿干净的 console + toBlob + Blob URL ============
  let CC = console;
  let rawToBlob = HTMLCanvasElement.prototype.toBlob;
  let cleanURL = URL;
  let rawCreateObjectURL = URL.createObjectURL;
  let rawRevokeObjectURL = URL.revokeObjectURL;
  try {
    const ifr = document.createElement('iframe');
    Object.assign(ifr.style, {
      display: 'none', width: '0', height: '0',
      border: '0', position: 'absolute',
    });
    ifr.src = 'about:blank';
    document.documentElement.appendChild(ifr);
    CC = ifr.contentWindow.console;
    rawToBlob = ifr.contentWindow.HTMLCanvasElement.prototype.toBlob;
    cleanURL = ifr.contentWindow.URL;
    rawCreateObjectURL = cleanURL.createObjectURL;
    rawRevokeObjectURL = cleanURL.revokeObjectURL;
    window.__cleanConsoleIframe = ifr;
    try { window.console = CC; } catch (_) {}
    try { Object.defineProperty(window, 'console', { value: CC, configurable: true, writable: true }); } catch (_) {}
    const noop = () => {};
    try { CC.clear = noop; } catch (_) {}
    try { CC.debug = noop; } catch (_) {}
    try { console.clear = noop; } catch (_) {}
    try { console.debug = noop; } catch (_) {}
    CC.log('[manga] console + toBlob + Blob URL restored, clear/debug muted');
  } catch (e) {
    console.log('iframe restore failed', e);
  }
  const createObjectURL = (blob) => rawCreateObjectURL.call(cleanURL, blob);
  const revokeObjectURL = (url) => rawRevokeObjectURL.call(cleanURL, url);
  const CL = (...a) => CC.log('[manga]', ...a);
  const CW = (...a) => CC.warn('[manga]', ...a);
  const CE = (...a) => CC.error('[manga]', ...a);

  // ============ 0.5 浮层日志 + 复制按钮 ============
  const logHistory = [];
  const logContainer = document.createElement('div');
  Object.assign(logContainer.style, {
    position: 'fixed',
    right: '8px',
    bottom: '8px',
    width: '380px',
    maxHeight: '320px',
    background: 'rgba(0,0,0,0.85)',
    zIndex: '99999',
    borderRadius: '8px',
    boxShadow: '0 2px 10px #000',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  });
  logContainer.id = '__manga_log_container';
  const logHeader = document.createElement('div');
  Object.assign(logHeader.style, {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '4px',
    padding: '4px 8px',
    background: 'rgba(0,0,0,0.95)',
    borderBottom: '1px solid #333',
    flex: '0 0 auto',
  });
  const copyLogBtn = document.createElement('button');
  Object.assign(copyLogBtn.style, {
    padding: '3px 10px',
    background: '#06c',
    color: '#fff',
    border: '1px solid #fff',
    borderRadius: '4px',
    cursor: 'pointer',
    font: 'bold 11px/1.2 ui-monospace, monospace',
  });
  copyLogBtn.textContent = '复制日志';
  const defaultCopyLabel = '复制日志';
  copyLogBtn.onclick = async () => {
    const text = logHistory.join('\n');
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        Object.assign(ta.style, { position: 'fixed', top: '-9999px', left: '-9999px' });
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) {}
    }
    copyLogBtn.textContent = ok ? '✓ 已复制 ' + logHistory.length + ' 行' : '✗ 复制失败';
    setTimeout(() => { copyLogBtn.textContent = defaultCopyLabel; }, 1500);
  };
  logHeader.appendChild(copyLogBtn);
  const box = document.createElement('div');
  Object.assign(box.style, {
    overflow: 'auto',
    color: '#0f0',
    font: '12px/1.4 ui-monospace, monospace',
    padding: '8px 10px',
    flex: '1 1 auto',
    minHeight: '0',
  });
  box.id = '__manga_log';
  logContainer.appendChild(logHeader);
  logContainer.appendChild(box);
  document.body.appendChild(logContainer);
  const ui = (msg, color) => {
    const ts = new Date().toTimeString().slice(0, 8);
    const line = '[' + ts + '] ' + msg;
    logHistory.push(line);
    const div = document.createElement('div');
    div.style.color = color || '#0f0';
    div.textContent = line;
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

  // ============ 0.7 防节流：静音 AudioContext keep-alive ============
  // Edge 的"睡眠标签页 / 效率模式"和 Chrome 的后台节流，对前台但没有最近用户输入的 tab
  // 也会降级 canvas paint / WASM 解码优先级，造成 toBlob 偶发 3-4s 卡顿。
  // 合成 mousemove 因 isTrusted=false 被忽略；播放静音音频是公认能让 tab 保持 "active" 的方式。
  // START 按钮的 click 已经提供了恢复 AudioContext 所需的 user gesture。
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      audioKeepAlive = new AC();
      const osc = audioKeepAlive.createOscillator();
      const gain = audioKeepAlive.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(audioKeepAlive.destination);
      osc.start();
      if (audioKeepAlive.state === 'suspended') {
        audioKeepAlive.resume().catch(() => {});
      }
      log('audio keep-alive active (state=' + audioKeepAlive.state + ')');
    } else {
      warn('AudioContext unavailable, tab throttling may slow captures');
    }
  } catch (e) {
    warn('audio keep-alive setup failed: ' + (e?.message || e));
    audioKeepAlive = null;
  }

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
  // 从 reader UI 文本里抽取 "current/total" 页码指示
  // 兼容：'1/62 P'、'1/62'、'第1页/共62页'、'1页/62页'、'1 / 62 P'
  const matchPageRatio = (text) => {
    if (!text) return null;
    let m = text.match(/(\d+)\s*[\/／]\s*(\d+)\s*P\b/i);
    if (!m) m = text.match(/\b(\d+)\s*[\/／]\s*(\d+)\b/);
    // 中文夹字：'1页/21页', '第1页 / 共21页', '1 / 共 21'
    if (!m) m = text.match(/(\d+)[\s一-龥]{0,4}[\/／][\s一-龥]{0,4}(\d+)/);
    if (!m) return null;
    const current = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(current) || !Number.isFinite(total)) return null;
    if (current < 1 || total < 1 || current > total) return null;
    return { current, total };
  };
  const getTotalFromBodyText = () => {
    const text = document.body.innerText || '';
    const m = text.match(/(\d+)\s*P\b/i);
    return m ? Number(m[1]) : null;
  };
  // 优先在 info-hud 内查找页码（精确语义类：.current-page；深路径作为兜底）
  // 容错：若节点内只有单个数字（仅 current），则与 body 文本里的 'NP' 总数拼出完整信息
  const getDisplayedPageInfo = () => {
    const containers = [
      '.current-page',
      'span.current-page',
      '.info-hud .current-page',
      '.reader-layout .info-layer .info-hud .hinter-image-container span',
      '.info-hud .hinter-image-container span',
      '.hinter-image-container span',
      '.info-hud .hinter-image-container',
      '.reader-layout .info-layer .info-hud',
      '.info-hud',
      '.info-text',
    ];
    for (const sel of containers) {
      try {
        const root = document.querySelector(sel);
        if (!root) continue;
        const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
        const info = matchPageRatio(text);
        if (info) return info;
        // 单数字节点：用 body 总数补齐
        const single = text.match(/^[^\d]{0,6}(\d+)[^\d]{0,6}$/);
        if (single) {
          const current = Number(single[1]);
          const total = getTotalFromBodyText();
          if (current >= 1 && total && current <= total) return { current, total };
        }
      } catch (_) {}
    }
    // 全页兜底：只接受带 P 的，避免日期等噪声
    try {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ');
      const m = text.match(/\b(\d+)\s*[\/／]\s*(\d+)\s*P\b/i);
      if (m) {
        const current = Number(m[1]);
        const total = Number(m[2]);
        if (current >= 1 && total >= 1 && current <= total) return { current, total };
      }
    } catch (_) {}
    return null;
  };
  const getDisplayedTotalPages = () => {
    const info = getDisplayedPageInfo();
    if (info) return info.total;
    return getTotalFromBodyText();
  };
  // Fast 路径：仅取 .current-page 的纯数字 textContent，O(1)，可在轮询循环里安全调用。
  // 与 getDisplayedPageInfo 不同的是：不读 total（不触发 document.body.innerText 这种 layout-aware 扫描）
  const getCurrentPageNumberFast = () => {
    try {
      const el = document.querySelector('.current-page');
      if (!el) return null;
      const t = (el.textContent || '').trim();
      const m = t.match(/^(\d+)$/);
      return m ? Number(m[1]) : null;
    } catch (_) { return null; }
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

  // 末尾 600 字节 + 总长度作为轻量哈希，避免为去重再制造整页字符串
  const sigOfBytes = (buffer) => {
    const bytes = new Uint8Array(buffer);
    const start = Math.max(0, bytes.length - 600);
    let hash = 2166136261;
    for (let i = start; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return bytes.length + ':' + hash.toString(16);
  };

  const captureCanvasBytes = async () => {
    const c = getCurrentCanvas();
    if (!c) return null;
    try {
      const blob = await new Promise((resolve) => rawToBlob.call(c, resolve, 'image/png'));
      if (!blob || blob.size < 1000) return null;
      const bytes = await blob.arrayBuffer();
      return { bytes, sig: sigOfBytes(bytes), size: blob.size };
    } catch (e) {
      warn('toBlob failed: ' + e.message);
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

  // 把 waitForNewStablePage 的内部计时拼成单行日志后缀
  //   total: 从 PageDown 到截图返回的全程
  //   pn:    从开始到 .current-page 数字翻过去（reader 真正翻页的耗时；A→B 是页号变化）
  //   sig:   翻页确认后到拿到与 prevSig 不同的 toBlob 结果（也就是 canvas 真正画完的耗时）
  //   blobs: 累计 toBlob 次数 + 总编码毫秒；prevSigSeen: pn 翻了但 canvas 还显示上一页的次数
  const formatWaitDebug = (d) => {
    if (!d) return '';
    const pnPart = d.pnFrom !== null && d.pnTo !== null
      ? ' pn=' + d.pnFrom + '→' + d.pnTo + '@' + d.pnWaitMs + 'ms'
      : (d.pnFrom !== null ? ' pn=?@' + d.pnWaitMs + 'ms' : '');
    return ' [total=' + d.totalMs + 'ms' + pnPart +
        ' sig=' + d.sigWaitMs + 'ms' +
        ' blobs=' + d.blobs + '@' + d.blobMs + 'ms' +
        (d.prevSigSeen ? ' prevSig=' + d.prevSigSeen : '') + ']';
  };

  // 等待新页面渲染完成：
  //   1) 如有 prevPageNum：先轮询 .current-page 直到数字变化（DOM 读取近乎免费，不烧 toBlob）
  //   2) 翻页后做 toBlob，sig 与 prevSig 不同即接受 —— toBlob 本身会同步到最终 paint，
  //      实测 transients 始终为 0，无需再额外做一次 toBlob 验证稳定，从而避免慢页 ~3.8s 的重复编码
  //   3) sig === prevSig 说明 canvas 还停在上一页，继续轮询
  // 返回 { bytes, sig, size, debug }、{ crossedEp } 或 null（超时）
  const waitForNewStablePage = async (prevSig, maxMs, _stableMs, expectedEp, prevPageNum) => {
    const start = Date.now();
    const hasPageNum = typeof prevPageNum === 'number';
    let pageNumChanged = false;
    let pageNumChangedAt = 0;
    let pageNumAfter = null;
    let nullPageNumStreak = 0;
    let toBlobMs = 0;
    let numCaptures = 0;
    let pageNumPolls = 0;
    let prevSigSeen = 0;
    while (Date.now() - start < maxMs) {
      await sleep(80);
      const currentEp = getEpFromUrl();
      if (expectedEp && currentEp !== expectedEp) {
        return { crossedEp: currentEp };
      }
      // 廉价信号：reader 没把页号翻过去之前，跳过昂贵的 toBlob
      if (hasPageNum && !pageNumChanged) {
        const num = getCurrentPageNumberFast();
        pageNumPolls++;
        if (num === null) {
          if (++nullPageNumStreak < 5) continue;
          // 指示器丢失，落回到纯 sig 检测
        } else if (num === prevPageNum) {
          continue;  // 还停在上一页
        } else {
          pageNumChanged = true;
          pageNumChangedAt = Date.now();
          pageNumAfter = num;
        }
      }
      const blobStart = Date.now();
      const capture = await captureCanvasBytes();
      toBlobMs += Date.now() - blobStart;
      numCaptures++;
      if (!capture) continue;
      if (capture.sig === prevSig) {
        prevSigSeen++;
        continue;
      }
      capture.debug = {
        totalMs: Date.now() - start,
        pnWaitMs: pageNumChangedAt ? pageNumChangedAt - start : 0,
        sigWaitMs: pageNumChangedAt ? Date.now() - pageNumChangedAt : Date.now() - start,
        pnPolls: pageNumPolls,
        pnFrom: hasPageNum ? prevPageNum : null,
        pnTo: pageNumAfter,
        blobs: numCaptures,
        blobMs: toBlobMs,
        prevSigSeen,
      };
      return capture;
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

    // 回到本话首页：
    //   - 主路径：用 .current-page 数字指示器，按一次 PgUp 自适应等它递减，再按下一次（避免 reader 排队累积）
    //   - 已在 page 1：直接跳过
    //   - 指示器不可用：兜底回到 sig-based 翻页 + 跨章 URL / canvas 签名连续不变检测
    log('rewind to first page of ep=' + epId);
    let rewindCount = 0;
    let initialCurrent = getCurrentPageNumberFast();
    if (initialCurrent === 1) {
      log('already at page 1 of ep=' + epId + ', skip rewind');
    } else if (initialCurrent !== null) {
      log('current page indicator ' + initialCurrent + (displayedTotal ? '/' + displayedTotal : '') + ', rewinding');
      let currentNum = initialCurrent;
      const FLIP_TIMEOUT_MS = 5000;
      while (currentNum > 1) {
        if (stopRequested) {
          return { epId, title, expectedPages: displayedTotal, captures, completed: false, endedOnEp: getEpFromUrl() };
        }
        const before = getEpFromUrl();
        press('PageUp');
        const deadline = Date.now() + FLIP_TIMEOUT_MS;
        let crossed = false;
        let newNum = currentNum;
        while (Date.now() < deadline) {
          await sleep(60);
          const after = getEpFromUrl();
          if (after !== before) { crossed = true; break; }
          const n = getCurrentPageNumberFast();
          if (n !== null && n !== currentNum) { newNum = n; break; }
        }
        if (crossed) {
          log('rewind crossed to prev ep=' + getEpFromUrl() + ', stepping forward back to ep=' + epId);
          if (!(await returnToEp(epId, 'PageDown'))) {
            return {
              epId, title, expectedPages: displayedTotal, captures, completed: false,
              endedOnEp: getEpFromUrl(), navigationMismatch: true,
            };
          }
          break;
        }
        rewindCount++;
        if (newNum === currentNum) {
          warn('rewind: PageUp had no effect within ' + (FLIP_TIMEOUT_MS / 1000) + 's at page ' + currentNum + ', giving up');
          break;
        }
        currentNum = newNum;
      }
      if (currentNum === 1) log('reached page 1 after ' + rewindCount + ' PageUps');
    } else {
      // .current-page 不可用：用旧的 sig-based 兜底
      warn('page indicator unavailable, falling back to sig-based rewind');
      const initialRewindCap = await captureCanvasBytes();
      let lastRewindSig = initialRewindCap?.sig || '';
      let rewindStuckCount = 0;
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
              epId, title, expectedPages: displayedTotal, captures, completed: false,
              endedOnEp: getEpFromUrl(), navigationMismatch: true,
            };
          }
          break;
        }
        rewindCount++;
        const cap = await captureCanvasBytes();
        if (cap) {
          if (lastRewindSig && cap.sig === lastRewindSig) {
            rewindStuckCount++;
            if (rewindStuckCount >= 2) {
              log('rewind: canvas unchanged for ' + (rewindStuckCount + 1) +
                  ' PageUps (' + rewindCount + ' steps), assuming first page of manga');
              break;
            }
          } else {
            rewindStuckCount = 0;
            lastRewindSig = cap.sig;
          }
        }
      }
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
      first = await captureCanvasBytes();
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
    captures.push({ bytes: first.bytes, sig: first.sig });
    seenSigs.add(first.sig);
    lastSig = first.sig;
    log('captured page 1 (' + Math.round((first.size || first.bytes.byteLength) / 1024) + 'KB)' +
        formatWaitDebug(first.debug));

    // 翻页 + 截图
    let stallCount = 0;
    const MAX_ITER = total + 8;
    for (let i = 1; i < MAX_ITER; i++) {
      if (stopRequested) break; // completed 保持 false → 整话被丢弃
      if (!(await rest('页间节流', RATE_LIMIT.pageRestMs))) break;
      const prevPageNum = getCurrentPageNumberFast();
      press('PageDown');
      const next = await waitForNewStablePage(lastSig, 8000, 500, epId, prevPageNum);

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
        captures.push({ bytes: next.bytes, sig: next.sig });
        lastSig = next.sig;
        stallCount = 0;
        log('captured page ' + captures.length + ' (' +
            Math.round((next.size || next.bytes.byteLength) / 1024) + 'KB)' +
            formatWaitDebug(next.debug));
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
    const blobUrl = createObjectURL(zipBlob);
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
      setTimeout(() => revokeObjectURL(blobUrl), 60000);
    }
  }

  const ZIP_CACHE_DB_NAME = 'bili-manga-grabber-zip-cache';
  const ZIP_CACHE_STORE = 'zips';

  function openZipCacheDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(ZIP_CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ZIP_CACHE_STORE)) {
          db.createObjectStore(ZIP_CACHE_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('open IndexedDB failed'));
    });
  }

  async function withZipCacheStore(mode, action) {
    const db = await openZipCacheDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ZIP_CACHE_STORE, mode);
      const store = tx.objectStore(ZIP_CACHE_STORE);
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('IndexedDB transaction failed'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error('IndexedDB transaction aborted'));
      };
    });
  }

  async function cacheZipBlob(record) {
    return withZipCacheStore('readwrite', (store) => store.put(record));
  }

  async function getCachedZipBlob(key) {
    return withZipCacheStore('readonly', (store) => store.get(key));
  }

  async function deleteCachedZipBlob(key) {
    return withZipCacheStore('readwrite', (store) => store.delete(key));
  }

  function releaseChapterPayloads(chapters) {
    chapters.forEach((ch) => {
      ch.captures.forEach((c) => {
        c.bytes = null;
        c.sig = '';
      });
      ch.captures.length = 0;
    });
    chapters.length = 0;
  }

  function makeZipWorkerSource() {
    return `
      const textEncoder = new TextEncoder();
      let crcTable = null;

      function getCrcTable() {
        if (crcTable) return crcTable;
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
          }
          crcTable[n] = c >>> 0;
        }
        return crcTable;
      }

      function crc32(bytes) {
        const table = getCrcTable();
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) {
          crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
      }

      function writeU16(view, offset, value) {
        view.setUint16(offset, value, true);
      }

      function writeU32(view, offset, value) {
        view.setUint32(offset, value >>> 0, true);
      }

      function makeStoredZip(chapters) {
        const files = [];
        let rawBytes = 0;
        let totalFiles = 0;
        chapters.forEach((chapter) => { totalFiles += chapter.captures.length; });
        let processed = 0;

        chapters.forEach((chapter) => {
          chapter.captures.forEach((capture, index) => {
            const data = new Uint8Array(capture.bytes);
            const name = chapter.folderName + '/page_' + String(index + 1).padStart(3, '0') + '.png';
            const nameBytes = textEncoder.encode(name);
            files.push({
              nameBytes,
              data,
              crc: crc32(data),
              localOffset: 0,
            });
            rawBytes += data.length;
            processed++;
            if (processed === totalFiles || processed % 20 === 0) {
              self.postMessage({ type: 'progress', processed, total: totalFiles });
            }
          });
        });

        let localSize = 0;
        files.forEach((file) => {
          file.localOffset = localSize;
          localSize += 30 + file.nameBytes.length + file.data.length;
        });
        let centralSize = 0;
        files.forEach((file) => {
          centralSize += 46 + file.nameBytes.length;
        });

        const zipArrayBuffer = new ArrayBuffer(localSize + centralSize + 22);
        const bytes = new Uint8Array(zipArrayBuffer);
        const view = new DataView(zipArrayBuffer);
        let offset = 0;
        const utf8Flag = 0x0800;
        const storeMethod = 0;
        const dosTime = 0;
        const dosDate = 33;

        files.forEach((file) => {
          writeU32(view, offset, 0x04034b50); offset += 4;
          writeU16(view, offset, 20); offset += 2;
          writeU16(view, offset, utf8Flag); offset += 2;
          writeU16(view, offset, storeMethod); offset += 2;
          writeU16(view, offset, dosTime); offset += 2;
          writeU16(view, offset, dosDate); offset += 2;
          writeU32(view, offset, file.crc); offset += 4;
          writeU32(view, offset, file.data.length); offset += 4;
          writeU32(view, offset, file.data.length); offset += 4;
          writeU16(view, offset, file.nameBytes.length); offset += 2;
          writeU16(view, offset, 0); offset += 2;
          bytes.set(file.nameBytes, offset); offset += file.nameBytes.length;
          bytes.set(file.data, offset); offset += file.data.length;
        });

        const centralOffset = offset;
        files.forEach((file) => {
          writeU32(view, offset, 0x02014b50); offset += 4;
          writeU16(view, offset, 20); offset += 2;
          writeU16(view, offset, 20); offset += 2;
          writeU16(view, offset, utf8Flag); offset += 2;
          writeU16(view, offset, storeMethod); offset += 2;
          writeU16(view, offset, dosTime); offset += 2;
          writeU16(view, offset, dosDate); offset += 2;
          writeU32(view, offset, file.crc); offset += 4;
          writeU32(view, offset, file.data.length); offset += 4;
          writeU32(view, offset, file.data.length); offset += 4;
          writeU16(view, offset, file.nameBytes.length); offset += 2;
          writeU16(view, offset, 0); offset += 2;
          writeU16(view, offset, 0); offset += 2;
          writeU16(view, offset, 0); offset += 2;
          writeU16(view, offset, 0); offset += 2;
          writeU32(view, offset, 0); offset += 4;
          writeU32(view, offset, file.localOffset); offset += 4;
          bytes.set(file.nameBytes, offset); offset += file.nameBytes.length;
        });

        const centralDirectorySize = offset - centralOffset;
        writeU32(view, offset, 0x06054b50); offset += 4;
        writeU16(view, offset, 0); offset += 2;
        writeU16(view, offset, 0); offset += 2;
        writeU16(view, offset, files.length); offset += 2;
        writeU16(view, offset, files.length); offset += 2;
        writeU32(view, offset, centralDirectorySize); offset += 4;
        writeU32(view, offset, centralOffset); offset += 4;
        writeU16(view, offset, 0); offset += 2;

        return { zipArrayBuffer, rawBytes };
      }

      self.onmessage = (event) => {
        try {
          const { chapters } = event.data;
          const { zipArrayBuffer, rawBytes } = makeStoredZip(chapters);
          const result = {
            type: 'done',
            zipArrayBuffer,
            rawBytes,
            size: zipArrayBuffer.byteLength,
          };
          self.postMessage(result, [zipArrayBuffer]);
        } catch (error) {
          self.postMessage({
            type: 'error',
            message: error && error.message ? error.message : String(error),
            stack: error && error.stack ? error.stack : '',
          });
        }
      };
    `;
  }

  function makeZipWorkerPayload(chapters) {
    let rawBytes = 0;
    const transferables = [];
    const payloadChapters = chapters.map((ch) => ({
      folderName: makeChapterFolderName(ch.title),
      captures: ch.captures.map((c) => {
        rawBytes += c.bytes.byteLength;
        transferables.push(c.bytes);
        return { bytes: c.bytes };
      }),
    }));
    return { chapters: payloadChapters, rawBytes, transferables };
  }

  async function createZipBlobInMainThread(chapters, onProgress) {
    const zip = new JSZip();
    let rawBytes = 0;
    let processed = 0;
    const total = chapters.reduce((s, c) => s + c.captures.length, 0);
    chapters.forEach((ch) => {
      const folderName = makeChapterFolderName(ch.title);
      const folder = zip.folder(folderName);
      ch.captures.forEach((c, i) => {
        folder.file('page_' + String(i + 1).padStart(3, '0') + '.png', c.bytes);
        rawBytes += c.bytes.byteLength;
        processed++;
        if (onProgress && (processed === total || processed % 20 === 0)) {
          onProgress(processed, total);
        }
      });
    });

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'STORE',
      streamFiles: true,
    }, (metadata) => {
      if (onProgress) onProgress(Math.round((metadata.percent || 0) * total / 100), total);
    });
    return {
      blob,
      rawBytes,
      zipMB: (blob.size / 1024 / 1024).toFixed(1),
      method: 'main-thread',
    };
  }

  async function createZipBlobInWorker(chapters, batchLabel, onProgress) {
    if (!window.Worker || !window.Blob || !window.URL) {
      warn('fallback to main-thread ZIP packing: Worker/Blob URL unavailable');
      return createZipBlobInMainThread(chapters, onProgress);
    }

    const payload = makeZipWorkerPayload(chapters);
    const workerBlob = new Blob([makeZipWorkerSource()], { type: 'text/javascript' });
    const workerUrl = createObjectURL(workerBlob);
    if (!workerUrl) {
      warn('fallback to main-thread ZIP packing: createObjectURL returned empty URL');
      return createZipBlobInMainThread(chapters, onProgress);
    }
    let worker = null;
    let transferredPayload = false;

    try {
      worker = new Worker(workerUrl);
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (event) => {
          const msg = event.data || {};
          if (msg.type === 'progress') {
            if (onProgress) onProgress(msg.processed, msg.total);
            return;
          }
          if (msg.type === 'done') {
            resolve(msg);
            return;
          }
          if (msg.type === 'error') {
            reject(new Error((msg.message || 'worker error') + (msg.stack ? '\n' + msg.stack : '')));
          }
        };
        worker.onerror = (event) => {
          reject(new Error(event.message || 'worker error while packing ' + batchLabel));
        };
        worker.postMessage({ chapters: payload.chapters }, payload.transferables);
        transferredPayload = true;
      });
      return {
        blob: new Blob([result.zipArrayBuffer], { type: 'application/zip' }),
        rawBytes: result.rawBytes || payload.rawBytes,
        zipMB: ((result.size || result.zipArrayBuffer.byteLength) / 1024 / 1024).toFixed(1),
        method: 'worker',
      };
    } catch (e) {
      if (transferredPayload) {
        throw new Error('worker ZIP packing failed after binary transfer: ' + (e?.message || e));
      }
      warn('fallback to main-thread ZIP packing: ' + (e?.message || e));
      return createZipBlobInMainThread(chapters, onProgress);
    } finally {
      if (worker) worker.terminate();
      revokeObjectURL(workerUrl);
    }
  }

  async function createZipDownloadButton(chapters, batchNo, startChapterNo) {
    if (!chapters.length) return null;

    const chapterCount = chapters.length;
    const totalPages = chapters.reduce((s, c) => s + c.captures.length, 0);
    const batchLabel = makeChapterRangeLabel(chapters, batchNo, startChapterNo);

    log('━━━ packing ' + batchLabel + ': ' + chapterCount + ' chapters / ' + totalPages + ' pages ━━━');

    let lastPackProgress = 0;
    const zipResult = await createZipBlobInWorker(chapters, batchLabel, (processed, total) => {
      if (!total) return;
      const pct = Math.floor(processed * 100 / total);
      if (pct >= lastPackProgress + 10 || processed >= total) {
        lastPackProgress = pct;
        log(batchLabel + ' packing progress ' + Math.min(100, pct) + '% (' + processed + '/' + total + ')');
      }
    });
    log(batchLabel + ' input ~' + Math.round(zipResult.rawBytes / 1024 / 1024) +
        'MB, ZIP ready by ' + zipResult.method);
    let zipBlob = zipResult.blob;
    const zipMB = zipResult.zipMB;
    const filename = mangaName + '_' + batchLabel + '_' + chapterCount + 'eps_' + totalPages + 'p.zip';
    const zipEntry = {
      key: 'zip_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      filename,
      batchLabel,
      chapterCount,
      totalPages,
      zipMB,
      size: zipBlob.size,
      createdAt: Date.now(),
    };
    let cachedZip = false;
    try {
      await cacheZipBlob({
        ...zipEntry,
        blob: zipBlob,
      });
      zipBlob = null;
      cachedZip = true;
      log(batchLabel + ' cached in IndexedDB (' + zipMB + 'MB)');
    } catch (e) {
      warn('IndexedDB cache failed, keep in-memory ZIP: ' + (e?.message || e));
    }
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
      chapterCount + ' 话 / ' + totalPages + ' 页 / ' + zipMB + 'MB' +
      (cachedZip ? ' / IndexedDB' : ' / memory') + ')';
    dlBtn.textContent = readyText;
    dlBtn.onclick = async function () {
      dlBtn.disabled = true;
      dlBtn.textContent = '保存中...\n' + filename;
      try {
        const cached = cachedZip ? await getCachedZipBlob(zipEntry.key) : null;
        const blobForDownload = cached?.blob || zipBlob;
        if (!blobForDownload) {
          warn('ZIP cache missing: ' + filename);
          dlBtn.disabled = false;
          dlBtn.textContent = readyText;
          return;
        }
        const method = await saveZipBlob(cached?.filename || filename, blobForDownload);
        if (!cachedZip) zipBlob = null;
        dlBtn.textContent = '✓ 已触发下载(' + method + '): ' + filename;
        dlBtn.disabled = cachedZip ? false : true;
        dlBtn.style.background = cachedZip ? '#087' : '#444';
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
  const batchChapters = []; // 当前未打包批次：[{epId, title, captures: [{bytes, sig}]}, ...]
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
  } finally {
    window.__biliMangaGrabberRunning = false;
    try { if (audioKeepAlive) audioKeepAlive.close(); } catch (_) {}
  }
}

function installBiliMangaGrabberLauncher() {
  if (document.getElementById('__manga_grabber_start')) return;
  const startBtn = document.createElement('button');
  Object.assign(startBtn.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '999999',
    padding: '12px 20px',
    background: '#06c',
    color: '#fff',
    border: '3px solid #fff',
    borderRadius: '8px',
    cursor: 'pointer',
    font: 'bold 14px/1.3 ui-monospace, monospace',
    boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
  });
  startBtn.id = '__manga_grabber_start';
  startBtn.textContent = '▶ START 抓取漫画';
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    startBtn.textContent = '运行中...';
    startBtn.style.display = 'none';
    try {
      await runBiliMangaGrabber();
      startBtn.textContent = '— 已结束 —';
    } catch (e) {
      console.error('[manga-userscript]', e);
      window.alert('Bilibili Manga Grabber 出错：' + (e?.message || e));
      startBtn.disabled = false;
      startBtn.textContent = '▶ START 抓取漫画';
      startBtn.style.display = 'block';
    }
  };
  document.body.appendChild(startBtn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installBiliMangaGrabberLauncher, { once: true });
} else {
  installBiliMangaGrabberLauncher();
}
}

})();
