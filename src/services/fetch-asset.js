'use strict';

/**
 * 把 `@require` / `@resource` 抓回來存進 assets（內容定址）。
 *
 * 政策：
 *   - 已經抓過同一個 URL 就直接重用，不再打 CDN（規格：重複 URL 只抓一次）
 *   - 走 SSRF 防護：@require 指向 127.0.0.1 不能變成打內網的跳板
 *   - 截斷等於壞檔 → 當成失敗（半個 jQuery 比沒有 jQuery 更難查）
 *   - 失敗**不丟錯**，回 `{ sha256: null, error }`：一個掛掉的 CDN 不該擋住存腳本
 */

const { assertOriginAllowed } = require('../lib/ssrf.js');
const { readCapped, ContentTooLargeError } = require('../lib/read-capped.js');

function describe(error) {
  return String(error?.message ?? error ?? '未知錯誤');
}

/**
 * @param {object} store
 * @param {string} url
 * @param {{
 *   allowPrivate?: boolean,
 *   timeoutMs: number,
 *   maxBytes: number,
 *   fetchImpl?: typeof fetch,
 *   lookup?: Function,
 * }} options
 * @returns {Promise<{ url: string, sha256: string|null, bytes?: number, contentType?: string|null, error?: string, cached?: boolean }>}
 */
async function fetchAsset(store, url, options) {
  const { allowPrivate = false, timeoutMs, maxBytes, fetchImpl = fetch, lookup } = options;

  const existing = store.assets.findByUrl(url);
  if (existing) {
    return {
      url,
      sha256: existing.sha256,
      bytes: existing.bytes,
      contentType: existing.content_type,
      cached: true,
    };
  }

  try {
    await assertOriginAllowed(new URL(url).origin, { allowPrivate, ...(lookup ? { lookup } : {}) });
  } catch (error) {
    return { url, sha256: null, error: `SSRF 防護擋下來了：${describe(error)}` };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { url, sha256: null, error: `抓不到：${describe(error)}` };
  }

  if (!response.ok) {
    return { url, sha256: null, error: `上游回 HTTP ${response.status}` };
  }

  let read;
  try {
    read = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof ContentTooLargeError) {
      return { url, sha256: null, error: `檔案太大（上限 ${maxBytes} bytes）` };
    }
    return { url, sha256: null, error: `讀取中斷：${describe(error)}` };
  }

  if (read.truncated) {
    return { url, sha256: null, error: `檔案太大（超過上限 ${maxBytes} bytes，已放棄）` };
  }

  const saved = store.assets.put({
    url,
    content: read.buffer,
    content_type: response.headers.get('content-type'),
  });

  return {
    url,
    sha256: saved.sha256,
    bytes: saved.bytes,
    contentType: saved.content_type,
    cached: false,
  };
}

module.exports = { fetchAsset };
