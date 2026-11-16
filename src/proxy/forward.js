'use strict';

const { buildUpstreamHeaders } = require('../lib/headers.js');

class UpstreamError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.cause = cause;
  }
}

function splitPathWithQuery(input) {
  const raw = typeof input === 'string' && input.length > 0 ? input : '/';
  const withoutHash = raw.split('#')[0]; // HTTP 本來就不送 fragment
  const queryIndex = withoutHash.indexOf('?');

  const pathname = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1);

  return { pathname: pathname.startsWith('/') ? pathname : `/${pathname}`, search };
}

/**
 * 把「代理後的 path + query」接到 target_origin 上。
 *
 * 刻意用 originalUrl 切出來的原始字串，不要用 express 解碼過的 params ——
 * 解碼再編碼會改掉 %2F 這種字元。
 *
 * ⛔ 也刻意**不用** `new URL(path, targetOrigin)`：那個寫法會讓
 * `//evil.test/x`（protocol-relative）或 `/\evil.test/x`（URL 解析器把 `\` 當 `/`）
 * 直接換掉主機 —— 等於把 LocalMonkey 變成開放代理，而且繞過 SSRF 檢查
 * （SSRF 檢查看的是 site.target_origin，不是這個被偷換過的主機）。
 * 用 pathname / search setter 的話，host 是釘死的，`//` 也會原樣保留在路徑裡。
 */
function buildUpstreamUrl(targetOrigin, pathWithQuery) {
  const url = new URL(targetOrigin);
  const { pathname, search } = splitPathWithQuery(pathWithQuery);

  url.pathname = pathname;
  url.search = search;
  url.hash = '';

  if (url.origin !== new URL(targetOrigin).origin) {
    // 走不到才對。留著當最後一道保險，哪天 URL 解析行為變了會立刻炸而不是靜默變開放代理。
    throw new Error(`組出來的上游網址換了主機：${url.origin} ≠ ${targetOrigin}`);
  }

  return url;
}

/**
 * @param {{
 *   site: { target_origin: string },
 *   pathWithQuery: string,
 *   method: string,
 *   headers: Record<string, string|string[]>,
 *   body?: Buffer,
 *   timeoutMs: number,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ response: Response, buffer: Buffer, url: URL }>}
 */
async function forwardToUpstream({
  site,
  pathWithQuery,
  method,
  headers,
  body,
  timeoutMs,
  fetchImpl = fetch,
}) {
  const url = buildUpstreamUrl(site.target_origin, pathWithQuery);

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: buildUpstreamHeaders(headers, { host: url.host }),
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new UpstreamError(`連不上 ${url.origin}`, cause);
  }

  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { response, buffer, url };
  } catch (cause) {
    throw new UpstreamError(`讀取 ${url.origin} 的回應時中斷`, cause);
  }
}

module.exports = { forwardToUpstream, buildUpstreamUrl, UpstreamError };
