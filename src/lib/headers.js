'use strict';

/**
 * Header 過濾。兩個方向都要過：
 * - 往上游：拿掉 hop-by-hop 與會打壞上游的 header，host 換成上游 host
 * - 往瀏覽器：拿掉會擋掉注入（CSP / X-Frame-Options）或與「已解壓 body」不符的 header
 */

const DROPPED_REQUEST_HEADERS = Object.freeze([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'host',
  'content-length',
  // 不自己決定壓縮；Node fetch 會自己談並解壓
  'accept-encoding',
]);

const DROPPED_RESPONSE_HEADERS = Object.freeze([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'strict-transport-security',
  'report-to',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  // set-cookie 要逐條改寫，由 cookies 模組處理
  'set-cookie',
  // 連線層的 header 不該被轉述
  'connection',
  'keep-alive',
]);

const REQUEST_DROP_SET = new Set(DROPPED_REQUEST_HEADERS);
const RESPONSE_DROP_SET = new Set(DROPPED_RESPONSE_HEADERS);

function flatten(value) {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * @param {Record<string, string|string[]>} incoming Node 的 req.headers
 * @param {{ host: string }} upstream
 * @returns {Record<string, string>} 全新的物件
 */
function buildUpstreamHeaders(incoming, { host }) {
  const source = incoming && typeof incoming === 'object' ? incoming : {};

  const forwarded = Object.entries(source).reduce((acc, [name, value]) => {
    const lower = name.toLowerCase();
    if (REQUEST_DROP_SET.has(lower)) return acc;
    if (value === undefined || value === null) return acc;
    return { ...acc, [lower]: flatten(value) };
  }, {});

  return { ...forwarded, host };
}

/**
 * @param {Headers} headers fetch Response 的 headers
 * @returns {Array<[string, string]>} 可以直接丟給 res.setHeader 的 pairs
 */
function filterResponseHeaders(headers) {
  const pairs = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (RESPONSE_DROP_SET.has(lower)) continue;
    pairs.push([lower, value]);
  }
  return pairs;
}

module.exports = {
  buildUpstreamHeaders,
  filterResponseHeaders,
  DROPPED_REQUEST_HEADERS,
  DROPPED_RESPONSE_HEADERS,
};
