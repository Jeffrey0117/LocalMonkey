'use strict';

/**
 * 伺服器端代替使用者發 GM_xmlhttpRequest。
 *
 * ⛔ 這支函式就是「開放代理」本人，差別只在呼叫端有沒有把門關好。
 * 它自己負責三件事：
 *   1. 轉送用的 header 是**白名單組出來的**，不是把進來的請求複製一份
 *      —— 所以瀏覽器的 Cookie、LocalMonkey 的後台 token 結構上就不可能外流。
 *   2. `redirect: 'manual'` + 自己跟轉址，每一跳都重跑一次 validateUrl。
 *      用 fetch 預設的自動跟隨，等於讓目標網站用 302 把我們導去
 *      evil.test 或 127.0.0.1，直接繞過 @connect 與 SSRF 檢查。
 *   3. 回應有大小上限（邊讀邊數，不是先吞進記憶體再檢查）。
 */

const { readCapped, ContentTooLargeError } = require('../lib/read-capped.js');

const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const MAX_REDIRECTS = 5;

/** 絕對不從腳本那邊轉送出去的 request header */
const BLOCKED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'content-length',
  'accept-encoding',
]);

/** 不回給腳本的 response header */
const BLOCKED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'strict-transport-security',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

class GmForwardError extends Error {
  constructor(reason, message, { status = 502, cause } = {}) {
    super(message, { cause });
    this.name = 'GmForwardError';
    this.reason = reason;
    this.status = status;
  }
}

function normalizeMethod(method) {
  return String(method ?? 'GET').toUpperCase();
}

function isAllowedMethod(method) {
  return ALLOWED_METHODS.includes(normalizeMethod(method));
}

/**
 * 從腳本給的 headers 組出要送上游的 header。
 * `cookie` 只有在「目標就是這個站自己的 origin」時才准帶 —— 否則就是拿使用者的
 * 身分去打第三方站。
 */
function buildUpstreamHeaders(headers, { sameSiteOrigin }) {
  const source = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};

  return Object.entries(source).reduce((acc, [name, value]) => {
    const key = String(name).toLowerCase();

    if (BLOCKED_REQUEST_HEADERS.has(key)) return acc;
    if (key === 'cookie' && !sameSiteOrigin) return acc;
    if (typeof value !== 'string' && typeof value !== 'number') return acc;

    return { ...acc, [key]: String(value) };
  }, {});
}

function filterResponseHeaders(headers) {
  const result = {};

  headers.forEach((value, name) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(String(name).toLowerCase())) result[name] = value;
  });

  return result;
}

function resolveRedirect(location, currentUrl) {
  try {
    return new URL(location, currentUrl);
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   url: URL,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   data?: string,
 *   timeoutMs: number,
 *   maxBytes: number,
 *   sameSiteOrigin?: boolean,
 *   validateUrl: (url: URL) => Promise<void>,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
async function forwardGmRequest({
  url,
  method = 'GET',
  headers,
  data,
  timeoutMs,
  maxBytes,
  sameSiteOrigin = false,
  validateUrl,
  fetchImpl = fetch,
}) {
  const upperMethod = normalizeMethod(method);
  if (!isAllowedMethod(upperMethod)) {
    throw new GmForwardError('method_not_allowed', `不支援的 method：${upperMethod}`, { status: 400 });
  }

  const upstreamHeaders = buildUpstreamHeaders(headers, { sameSiteOrigin });
  const body = BODYLESS_METHODS.has(upperMethod) || data === undefined || data === null
    ? undefined
    : String(data);

  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // 每一跳都要重驗：302 到 evil.test 或 127.0.0.1 一樣要被擋下來
    await validateUrl(current);

    let response;
    try {
      response = await fetchImpl(current, {
        method: upperMethod,
        headers: upstreamHeaders,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
      throw new GmForwardError(
        timedOut ? 'timeout' : 'upstream_failed',
        timedOut ? `等 ${current.origin} 回應超過 ${timeoutMs}ms` : `連不上 ${current.origin}`,
        { status: timedOut ? 504 : 502, cause },
      );
    }

    const location = response.headers.get('location');
    if (REDIRECT_STATUSES.has(response.status) && location) {
      const next = resolveRedirect(location, current);
      if (!next) {
        throw new GmForwardError('bad_redirect', `上游給了看不懂的轉址：${location}`, { status: 502 });
      }
      current = next;
      continue;
    }

    let read;
    try {
      read = await readCapped(response, maxBytes);
    } catch (cause) {
      if (cause instanceof ContentTooLargeError) {
        throw new GmForwardError('response_too_large', cause.message, { status: 413, cause });
      }
      throw new GmForwardError('upstream_failed', `讀取 ${current.origin} 的回應時中斷`, { status: 502, cause });
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: filterResponseHeaders(response.headers),
      responseText: read.buffer.toString('utf8'),
      finalUrl: current.toString(),
      truncated: read.truncated,
    };
  }

  throw new GmForwardError('too_many_redirects', `轉址超過 ${MAX_REDIRECTS} 次`, { status: 502 });
}

module.exports = {
  forwardGmRequest,
  buildUpstreamHeaders,
  filterResponseHeaders,
  isAllowedMethod,
  GmForwardError,
  ALLOWED_METHODS,
  MAX_REDIRECTS,
};
