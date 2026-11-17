'use strict';

/**
 * 站點 favicon（SPEC-dashboard §2.1）。
 *
 * ⛔ 刻意**不用** `google.com/s2/favicons` 之類的第三方服務 —— 那等於把
 * 「使用者代理了哪些網站」整份洩漏給別人。自己抓，走既有的 SSRF 防護與大小上限，
 * 存進內容定址的 `assets` 表。
 *
 * 抓不到就回內建的佔位 SVG。**不要回 404** —— 列表一次畫十幾個站，
 * 十幾個破圖加十幾行 console 錯誤比沒有圖示難看得多。
 */

const { fetchAsset } = require('./fetch-asset.js');

const CANDIDATE_PATHS = Object.freeze(['/favicon.ico', '/apple-touch-icon.png']);

/**
 * ⛔ 只收點陣圖。`image/svg+xml` 一律拒收：SVG 可以內含 `<script>`，而這張圖是
 * 從**我們自己的 origin** 送出去的 —— 使用者直接開那個網址就是一個同源頁面，
 * 可以去打 `/admin/api/*`（後台 cookie 的 Path=/admin 會被帶上）。
 * 這跟 routes/internal.js 的 `safeAssetContentType` 是同一條理由。
 */
const ACCEPTED_TYPES = Object.freeze([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/ico',
  'image/icon',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

/** 一張中性的佔位圖。我們自己寫的、沒有 script、沒有外部參照。 */
const PLACEHOLDER_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">',
  '<rect width="16" height="16" rx="3" fill="#2e2e34"/>',
  '<circle cx="8" cy="8" r="3" fill="#9a9aa3"/>',
  '</svg>',
].join('');

const PLACEHOLDER_CONTENT_TYPE = 'image/svg+xml; charset=utf-8';

/** 解析結果的快取時間。失敗也要快取，不然每開一次列表就對死掉的站打一輪。 */
const RESOLUTION_TTL_MS = 10 * 60 * 1000;

function isAcceptableIconType(contentType) {
  if (typeof contentType !== 'string') return false;
  const declared = contentType.split(';')[0].trim().toLowerCase();
  return ACCEPTED_TYPES.includes(declared);
}

/** @returns {string[]} 要依序試的網址；target_origin 壞掉就是空陣列 */
function faviconCandidates(targetOrigin) {
  try {
    return CANDIDATE_PATHS.map((path) => new URL(path, targetOrigin).toString());
  } catch {
    return [];
  }
}

/**
 * @param {{ store: object, config: object, fetchImpl?: typeof fetch, lookup?: Function, now?: () => number }} context
 */
function createFaviconService({ store, config, fetchImpl, lookup, now = Date.now }) {
  /**
   * `siteId\ntarget_origin` → { sha256: string|null, expiresAt }。null ＝ 這個站抓不到。
   * key 帶上 target_origin，使用者在「網站」分頁改了目標主機就自然重抓，
   * 不用在別的模組裡插一行「記得清快取」。
   */
  const resolutions = new Map();

  const cacheKey = (site) => `${site.id}\n${site.target_origin}`;

  async function fetchFirstIcon(site) {
    for (const url of faviconCandidates(site.target_origin)) {
      const result = await fetchAsset(store, url, {
        allowPrivate: config.allowPrivate,
        timeoutMs: config.assetTimeoutMs ?? 15_000,
        maxBytes: config.assetMaxBytes ?? 5 * 1024 * 1024,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(lookup ? { lookup } : {}),
      });

      // 抓到了但不是（可接受的）圖片：上游常常用 200 回一頁 HTML 當 404
      if (result.sha256 !== null && isAcceptableIconType(result.contentType)) {
        return result.sha256;
      }
    }

    return null;
  }

  async function shaFor(site) {
    const key = cacheKey(site);
    const cached = resolutions.get(key);
    if (cached && cached.expiresAt > now()) return cached.sha256;

    const sha256 = await fetchFirstIcon(site);
    resolutions.set(key, { sha256, expiresAt: now() + RESOLUTION_TTL_MS });
    return sha256;
  }

  function placeholder() {
    return { content: Buffer.from(PLACEHOLDER_SVG, 'utf8'), contentType: PLACEHOLDER_CONTENT_TYPE };
  }

  /**
   * @param {string} siteId
   * @returns {Promise<{ content: Buffer, contentType: string }>} 一定給得出東西（抓不到就是佔位圖）
   */
  async function resolve(siteId) {
    const site = store.sites.get(siteId);
    // 站不存在也回佔位圖：兩條路的回應長得一樣，這個匿名端點就不會洩漏「哪些站存在」
    if (!site) return placeholder();

    const sha256 = await shaFor(site);
    if (sha256 === null) return placeholder();

    const asset = store.assets.get(sha256);
    if (!asset || !isAcceptableIconType(asset.content_type)) return placeholder();

    return { content: asset.content, contentType: asset.content_type.split(';')[0].trim() };
  }

  return { resolve };
}

module.exports = {
  createFaviconService,
  isAcceptableIconType,
  faviconCandidates,
  PLACEHOLDER_SVG,
  PLACEHOLDER_CONTENT_TYPE,
  CANDIDATE_PATHS,
};
