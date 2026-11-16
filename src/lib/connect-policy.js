'use strict';

/**
 * `@connect` 白名單判斷。純函式。
 *
 * 這是 `/__lm/gm/xhr` 的第二道門：伺服器會「代替使用者」發這個請求，
 * 所以目標主機必須是腳本自己宣告過的，或是這個站本來就在代理的那個 origin。
 * 判斷不出來一律不放行（fail closed）。
 */

const HOST_PATTERN = /^[a-z0-9.-]+$/;

const CONNECT_ALL_REASON =
  '@connect * 不被接受：請在腳本裡列出具體主機（例如 @connect api.example.com），否則 GM_xmlhttpRequest 一律被擋';

function normalizeHost(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** `example.com` 也涵蓋 `api.example.com`（Tampermonkey 的語意） */
function hostMatchesEntry(host, entry) {
  const candidate = normalizeHost(entry).replace(/^\*\./, '');
  if (candidate.length === 0 || !HOST_PATTERN.test(candidate)) return false;

  return host === candidate || host.endsWith(`.${candidate}`);
}

/**
 * @param {{
 *   targetUrl: URL,
 *   siteOrigin: string,
 *   connect?: readonly string[],
 *   connectAll?: boolean,
 * }} input
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function isConnectAllowed({ targetUrl, siteOrigin, connect, connectAll }) {
  if (connectAll === true) return { allowed: false, reason: CONNECT_ALL_REASON };

  if (!(targetUrl instanceof URL)) {
    return { allowed: false, reason: '目標網址不合法' };
  }

  const host = normalizeHost(targetUrl.hostname);
  const site = parseOrigin(siteOrigin);

  if (site && targetUrl.origin === site.origin) {
    return { allowed: true, reason: null };
  }

  const entries = Array.isArray(connect) ? connect : [];

  for (const entry of entries) {
    if (normalizeHost(entry) === 'self') {
      if (site && targetUrl.origin === site.origin) return { allowed: true, reason: null };
      continue;
    }
    if (hostMatchesEntry(host, entry)) return { allowed: true, reason: null };
  }

  const declared = entries.filter((entry) => normalizeHost(entry).length > 0);
  const listed = declared.length > 0 ? declared.join('、') : '（沒有宣告）';

  return {
    allowed: false,
    reason: `目標主機 ${host} 不在 @connect 清單裡：${listed}。請在腳本的 header 加上 @connect ${host}`,
  };
}

module.exports = { isConnectAllowed, hostMatchesEntry, CONNECT_ALL_REASON };
