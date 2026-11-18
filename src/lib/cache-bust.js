'use strict';

/**
 * 內容雜湊 cache busting：被覆寫的資源，引用點加上 `?v=<sha256 前 8 碼>`。
 *
 * ⛔ 真實事故（2026-11-18 實測）：代理對**非 HTML** 的回應是照抄上游快取指示的
 * （那是效能的唯一來源），而 templatemo 的圖片給 `max-age=604800` ——
 * **換了 logo，使用者七天內看不到**。覆寫本身回 `no-store`，但那只對「瀏覽器
 * 真的來問我們」的時候有用；而伺服器端完全看不出症狀（`curl` 永遠拿到新的）。
 * 這是地雷 33 / 46 的第三個變體。
 *
 * 解法是把網址變成**內容定址**的：
 *
 * ```
 * /p/<site>/images/logo.png   →   /p/<site>/images/logo.png?v=abcd1234
 * ```
 *
 * 換圖 → sha 變 → 網址變 → 瀏覽器**根本不會碰到**舊快取那一筆，所以不需要
 * Ctrl+F5。而新網址可以放心長快取（`proxy/resource-override.js` 看到對得上的
 * `?v=` 就回 immutable）。HTML 本身已經是 `no-store`，所以在這裡改寫是安全的。
 *
 * ⛔ **只對有覆寫的路徑動手**。沒覆寫的資源一個都不碰，不然等於把整站的快取
 * 關掉（速度是代理的賣點之一）。
 *
 * ⛔ **碰不到的邊界**：只被**外部 CSS 檔**的 `background-image: url()` 引用的
 * 資源拿不到版本號 —— 那個網址寫在 CSS 檔裡，而 CSS 檔自己也被快取著。
 * 那個邊界的解法是 per-site 的開發模式（`lib/cache-policy.js`）。
 */

/** sha256 → 網址上的版本號。內容變了版本就變，這就是「內容定址」。 */
function shortVersion(sha256) {
  if (typeof sha256 !== 'string') return null;

  const hex = sha256.trim().toLowerCase();
  // 看起來不像雜湊就回 null —— 瞎掰一個版本號會讓「換圖沒反應」更難查
  return /^[0-9a-f]{8,}$/.test(hex) ? hex.slice(0, 8) : null;
}

/**
 * 加上（或換掉）`?v=`。
 *
 * ⛔ 分隔符用**裸的 `&`**，不是 `&amp;`：同一支函式要改寫兩種上下文 ——
 * `src="…"`（屬性值，entity 會被解碼）與 `<style>` 裡的 `url(…)`（raw text，
 * entity **不會**被解碼）。寫 `&amp;` 的話 CSS 那邊會真的去要一條含 `&amp;`
 * 的網址 → 404，而且症狀只出現在 background-image 上。
 */
function withVersion(pathWithQuery, version) {
  const hashAt = pathWithQuery.indexOf('#');
  const hash = hashAt === -1 ? '' : pathWithQuery.slice(hashAt);
  const head = hashAt === -1 ? pathWithQuery : pathWithQuery.slice(0, hashAt);

  const queryAt = head.indexOf('?');
  const path = queryAt === -1 ? head : head.slice(0, queryAt);
  const params = queryAt === -1 ? [] : head.slice(queryAt + 1).split('&').filter(Boolean);

  // 已經是對的版本 → 回 null 表示「不用改」（重複改寫要是冪等的）
  if (params.includes(`v=${version}`)) return null;

  const kept = params.filter((param) => !param.startsWith('v='));
  return `${path}?${[...kept, `v=${version}`].join('&')}${hash}`;
}

/**
 * 這條引用網址對應到哪個上游路徑？不是這個站的就回 null。
 *
 * 兩種形狀都要認，而且**第二種是必要的不是順手**：
 *
 * 1. `/p/<siteId>/images/logo.png` —— 代理改寫過的（`src` / `href` / `srcset`）
 * 2. `/images/logo.png` —— **沒被改寫的根絕對路徑**。`lib/html.js` 只改
 *    `src` / `href` / `action` / `poster` / `formaction` 這幾個屬性，**不動
 *    `url()`** —— 所以 `style="background:url(/images/logo.png)"` 會原樣留著，
 *    由根路徑 fallback（cookie → siteId）接住。少了這一種，`background-image`
 *    的 logo 就拿不到版本號，而那正是換圖最常漏掉的地方。
 *
 * `//cdn/x` 與 `/p/<別的站>/…` 一律不算（跟 `lib/html.js` 同一個判準）。
 */
function upstreamPathOf(url, prefix) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
  if (url.startsWith(prefix)) return url.slice(prefix.length - 1); // 留著開頭的 `/`
  return url.startsWith('/p/') ? null : url;
}

/** 一條引用網址 → 加過版本號的網址（不用改就回 null） */
function bustOne(url, prefix, versions) {
  const upstream = upstreamPathOf(url, prefix);
  if (upstream === null) return null;

  // versions 的 key 是上游路徑（`/images/logo.png`）
  const version = versions.get(upstream.split(/[?#]/)[0]);
  if (!version) return null;

  const next = withVersion(upstream, version);
  if (next === null) return null;

  // 改寫過的形狀原樣保留（代理路徑維持代理路徑、根絕對路徑維持根絕對路徑）
  return url.startsWith(prefix) ? `${prefix.slice(0, -1)}${next}` : next;
}

/** 回 null 代表「這一筆不用改」，呼叫端就原樣保留（連引號都不要重組） */
function bustQuoted(quoted, transform) {
  const quote = quoted[0];
  const next = transform(quoted.slice(1, -1));
  return next === null ? quoted : `${quote}${next}${quote}`;
}

function bustSrcset(value, prefix, versions) {
  let changed = false;

  const rewritten = value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) return trimmed;

      const separator = trimmed.search(/\s/);
      const url = separator === -1 ? trimmed : trimmed.slice(0, separator);
      const descriptor = separator === -1 ? '' : ` ${trimmed.slice(separator).trim()}`;

      const busted = bustOne(url, prefix, versions);
      if (busted === null) return trimmed;

      changed = true;
      return `${busted}${descriptor}`;
    })
    .filter((candidate) => candidate.length > 0)
    .join(', ');

  return changed ? rewritten : null;
}

/** 子資源屬性。`href` **刻意不在這裡** —— `<a href>` 是導航不是子資源。 */
const SUBRESOURCE_PATTERN = /(\s(?:src|poster)\s*=\s*)("[^"]*"|'[^']*')/gi;
const SRCSET_PATTERN = /(\ssrcset\s*=\s*)("[^"]*"|'[^']*')/gi;
const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;
const LINK_HREF_PATTERN = /(\shref\s*=\s*)("[^"]*"|'[^']*')/i;
const URL_FUNCTION_PATTERN = /(url\(\s*)("[^"]*"|'[^']*'|[^)'"\s]+)(\s*\))/gi;

/**
 * @param {string} html latin1 管線字串（這裡只動 ASCII，所以編碼無關）
 * @param {{ siteId?: string, versions?: Map<string, string> }} input
 *        `versions`：上游路徑 → 版本號（`shortVersion()` 的輸出）
 * @returns {string}
 */
function bustCacheReferences(html, { siteId, versions } = {}) {
  if (typeof html !== 'string') return html;
  if (typeof siteId !== 'string' || !(versions instanceof Map) || versions.size === 0) return html;

  const prefix = `/p/${siteId}/`;
  const bust = (url) => bustOne(url, prefix, versions);

  return html
    .replace(SUBRESOURCE_PATTERN, (match, lead, quoted) => `${lead}${bustQuoted(quoted, bust)}`)
    .replace(
      SRCSET_PATTERN,
      (match, lead, quoted) =>
        `${lead}${bustQuoted(quoted, (value) => bustSrcset(value, prefix, versions))}`,
    )
    .replace(LINK_TAG_PATTERN, (tag) =>
      tag.replace(LINK_HREF_PATTERN, (match, lead, quoted) => `${lead}${bustQuoted(quoted, bust)}`),
    )
    .replace(URL_FUNCTION_PATTERN, (match, lead, value, tail) => {
      const quoted = /^["']/.test(value);
      const next = quoted ? bustQuoted(value, bust) : bust(value) ?? value;
      return `${lead}${next}${tail}`;
    });
}

module.exports = { bustCacheReferences, shortVersion, withVersion };
