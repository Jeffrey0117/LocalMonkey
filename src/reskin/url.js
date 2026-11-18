'use strict';

/**
 * 抽出來的網址 → 我們頁面上能用的網址。
 *
 * ⛔ **只有指向被代理的那個站的網址會留下來，其他一律丟掉**（回空字串）。
 * 理由是規格 §4.4：縮圖照舊走 `/p/<site>/…`，不要直接連上游 —— 那會把
 * 「使用者在看哪些商品」洩漏給上游，也會失去資源覆寫（換 logo / 換圖）的能力。
 * 而外部網域的圖根本沒辦法走我們的代理路由（那條路由綁一個 origin），
 * 所以把它留在頁面上等於破洞，丟掉是正解 —— 缺欄位不是錯誤（規格 §2）。
 *
 * 這也是**版型層不知道上游是誰**的關鍵接縫：`toProxied()` 跑完之後，
 * 資料模型裡的 `image` / `url` 就只是一個本站路徑字串了。
 */

const { toProxyPath, alreadyProxied } = require('../lib/proxy-path.js');

/**
 * 相對路徑（`item-1`、`./x.jpg`、`../a`）要先補成根絕對路徑才判斷得了。
 * 基準是**上游的那一頁**，不是代理網址 —— 設定抽的是上游 HTML。
 */
function resolveAgainst(value, pathname) {
  const base = typeof pathname === 'string' && pathname.startsWith('/') ? pathname : '/';

  try {
    // origin 隨便給一個合法的；我們只要 pathname + search，不要那個 host
    const resolved = new URL(value, `http://x${base}`);
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}

/** 絕對網址、protocol-relative、`javascript:`、`data:`、`#` 都不要走相對解析 */
function needsResolving(value) {
  return !value.startsWith('/') && !/^[a-zA-Z][\w+.-]*:/.test(value) && !value.startsWith('#');
}

/**
 * @param {string} value 上游 HTML 裡的原始網址
 * @param {{ siteId: string, targetOrigin: string, pathname?: string }} context
 * @returns {string} 代理路徑；不指向這個站就是空字串
 */
function toProxied(value, { siteId, targetOrigin, pathname = '/' }) {
  if (typeof value !== 'string') return '';

  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  // 片段（`#tab`）留著：它指的是我們自己這一頁
  if (trimmed.startsWith('#')) return trimmed;

  const candidate = needsResolving(trimmed) ? resolveAgainst(trimmed, pathname) : trimmed;
  if (candidate === null) return '';

  // 已經是代理路徑（上游不太可能，但抽取設定可能指到我們改寫過的 HTML）
  if (candidate.startsWith('/') && alreadyProxied(candidate, siteId)) return candidate;

  return toProxyPath(candidate, { siteId, targetOrigin }) ?? '';
}

module.exports = { toProxied, resolveAgainst, needsResolving };
