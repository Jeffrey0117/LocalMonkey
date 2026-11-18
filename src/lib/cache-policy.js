'use strict';

/**
 * HTML 的快取政策。
 *
 * ⛔ 代理回的 HTML 是**我們改造過的**：注入了 `<script>`、改寫了根絕對路徑、
 * 改寫了 `<base href>`。沿用上游的快取指示，等於讓瀏覽器把「某一版的改造結果」
 * 存起來用一整天。
 *
 * 真實事故（2026-11-17）：templatemo 回 `cache-control: max-age=86400`，
 * `<base>` 的修正早就上線、curl 拿到的也是新的，但 Chrome 裡的 `<base href>`
 * 還是舊值 —— 使用者看到的是壞的，而所有伺服器端的證據都說它是好的。
 *
 * 而且這直接打破產品承諾：使用者在後台改腳本、存檔，打開代理網址卻是昨天那份
 * HTML（連 script tag 都還是舊的那組）。腳本本身是 `no-cache` 救不了 ——
 * **承載它的那張 HTML 被快取了**。
 *
 * 非 HTML（CSS / JS / 圖片）**不適用**：那些是原封不動轉述的 byte，
 * 沿用上游快取是對的，而且是效能的唯一來源。
 */

/** 會讓瀏覽器「不用再問」或「問了也能拿舊的出來用」的 header */
const CACHE_HEADERS = Object.freeze([
  'cache-control',
  'expires',
  'etag',
  'last-modified',
  'age',
  'pragma',
]);

const CACHE_HEADER_SET = new Set(CACHE_HEADERS);

/**
 * 丟掉上游的快取指示，換成我們自己的 `no-store`。
 *
 * 連 `etag` / `last-modified` 都要丟：留著的話瀏覽器會拿它去做條件式請求，
 * 上游回 304（沒有 body，我們也就沒得改寫）→ 瀏覽器高高興興地把**沒有改寫過的**
 * 舊副本拿出來用。
 *
 * @param {Array<[string, string]>} pairs 已經過 filterResponseHeaders 的 header
 * @returns {Array<[string, string]>} 新陣列
 */
function withHtmlCachePolicy(pairs = []) {
  const kept = (Array.isArray(pairs) ? pairs : []).filter(
    ([name]) => !CACHE_HEADER_SET.has(String(name).toLowerCase()),
  );

  return [...kept, ['cache-control', 'no-store']];
}

/**
 * 「開發模式」的快取政策（SPEC-rules §8.2）：**所有**回應都要 revalidate。
 *
 * 為什麼需要它，而 `?v=` 的內容雜湊不夠：`?v=` 只救得了「HTML 裡有引用那條
 * 路徑」的資源。被**外部 CSS 檔**的 `background-image: url()` 引用的圖拿不到
 * 版本號 —— 那個網址寫在 CSS 檔裡，而 CSS 檔自己也被瀏覽器快取著。
 *
 * ⛔ `no-cache` **不是**「不要快取」，它是「每次都要先問過」。所以 ETag 與
 * Last-Modified 要**留著**：瀏覽器帶 `If-None-Match` 來，上游回 304（沒有 body），
 * 代價只有一次 round-trip。丟掉它們的話每次都要重傳整包 byte。
 *
 * 丟掉的是舊式的 `expires` / `age` / `pragma` —— 它們會讓瀏覽器自己算出
 * 「還沒過期，不用問」，那正是我們要避免的。
 *
 * HTML 不走這條：它已經是 `no-store`（更強），而且 HTML 的 ETag 一定要丟掉
 * （304 沒有 body，我們就沒得改寫 → 瀏覽器會拿**沒改寫過**的舊副本出來用）。
 *
 * @param {Array<[string, string]>} pairs
 * @returns {Array<[string, string]>} 新陣列
 */
const REVALIDATE_DROPPED = new Set(['cache-control', 'expires', 'age', 'pragma']);

function withDevModeCachePolicy(pairs = []) {
  const kept = (Array.isArray(pairs) ? pairs : []).filter(
    ([name]) => !REVALIDATE_DROPPED.has(String(name).toLowerCase()),
  );

  return [...kept, ['cache-control', 'no-cache']];
}

module.exports = { withHtmlCachePolicy, withDevModeCachePolicy, CACHE_HEADERS };
