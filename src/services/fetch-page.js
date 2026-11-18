'use strict';

/**
 * 「從上游抓一份 HTML 下來」。
 *
 * 兩個地方要用：爬蟲（預先翻譯整站）與控制台（規則的「試一下」、資源覆寫的
 * 候選清單）。兩邊都**不是**在服務使用者的瀏覽器，而是伺服器自己發起的請求
 * —— 但照樣要過 SSRF 防護（目標 origin 是使用者在後台打的字串）。
 */

const { assertOriginAllowed } = require('../lib/ssrf.js');

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;

/**
 * @param {object} site
 * @param {string} path
 * @param {{ fetchImpl?: typeof fetch, allowPrivate?: boolean, timeoutMs?: number }} context
 * @returns {Promise<{ html: string|null, contentType: string|null, status: number }>}
 *   `html` 是 null 代表「拿到了但不是 HTML」（或上游回了錯誤）
 */
async function fetchUpstreamPage(site, path, { fetchImpl = fetch, allowPrivate, timeoutMs } = {}) {
  await assertOriginAllowed(site.target_origin, { allowPrivate });

  const response = await fetchImpl(`${site.target_origin}${path}`, {
    redirect: 'follow',
    headers: { accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs ?? 20_000),
  });

  const contentType = response.headers.get('content-type');
  if (!response.ok || !HTML_CONTENT_TYPE.test(contentType ?? '')) {
    return { html: null, contentType, status: response.status };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { html: buffer.toString('utf8'), contentType, status: response.status };
}

module.exports = { fetchUpstreamPage, HTML_CONTENT_TYPE };
