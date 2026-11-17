'use strict';

/**
 * 「這個網址是不是指向我們正在代理的那個站？」—— 是就回對應的代理路徑，不是就回 `null`。
 *
 * `<base href>` 與 `<meta http-equiv="refresh">` 共用這條判斷。兩者的共通點是
 * **值可能是絕對網址**，而不像 `src` / `href` 那樣幾乎都是根絕對路徑，
 * 所以不能只做「開頭補前綴」。
 */

function proxyPrefix(siteId) {
  return `/p/${siteId}`;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isWebUrl(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** 已經是代理路徑了就不要再包一層（這個函式會被重複套用，要冪等） */
function alreadyProxied(path, siteId) {
  const prefix = proxyPrefix(siteId);
  return path === prefix || path.startsWith(`${prefix}/`);
}

function targetHostOf(targetOrigin) {
  const url = typeof targetOrigin === 'string' ? parseUrl(targetOrigin) : null;
  return url && isWebUrl(url) ? url.host.toLowerCase() : null;
}

function pathWithQuery(url) {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * @param {string} value 原始 HTML 裡的網址
 * @param {{ siteId: string, targetOrigin: string }} site
 * @returns {string|null} 要換上去的代理路徑；`null` ＝ 不要動它
 */
function toProxyPath(value, { siteId, targetOrigin } = {}) {
  if (typeof value !== 'string' || typeof siteId !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const targetHost = targetHostOf(targetOrigin);
  if (targetHost === null) return null; // target_origin 壞掉 → 什麼都別動

  // 根絕對路徑（`/foo/`）：一定是指向這個站
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return alreadyProxied(trimmed, siteId) ? null : `${proxyPrefix(siteId)}${trimmed}`;
  }

  // protocol-relative（`//host/foo`）：補上目標站的 scheme 再比主機
  const absolute = trimmed.startsWith('//') ? parseUrl(`https:${trimmed}`) : parseUrl(trimmed);
  if (!absolute || !isWebUrl(absolute)) return null; // 相對路徑、javascript:、data: 都走這條

  // 比的是 host（含 port）而不是整個 origin：同主機但 scheme 不同（舊站留著 http）
  // 照樣會把瀏覽器帶離代理，那不是「跨網域意圖」。
  if (absolute.host.toLowerCase() !== targetHost) return null;

  const path = pathWithQuery(absolute);
  return alreadyProxied(path, siteId) ? null : `${proxyPrefix(siteId)}${path}`;
}

module.exports = { toProxyPath, proxyPrefix, alreadyProxied };
