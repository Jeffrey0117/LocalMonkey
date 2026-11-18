'use strict';

/**
 * 資源覆寫的送出端（SPEC-rules §3.6）。
 *
 * 瀏覽器來要一條被覆寫的路徑時，代理**不去上游拿**，直接回使用者上傳的檔案。
 * 所以這一段要擺在管線的最前面（SSRF、讀 body、forward 全部省掉）。
 *
 * 只處理 GET / HEAD：POST 到一條圖片路徑是上游的事，不該被我們吃掉。
 */

const { shortVersion } = require('../lib/cache-bust.js');

/** 一年。`?v=` 是內容定址的，內容變了網址就變，所以永不過期是安全的。 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** 上游 path + query → 純路徑（覆寫比對的是路徑，`?v=2` 不該讓覆寫失效） */
function pathnameOf(pathWithQuery) {
  const at = pathWithQuery.search(/[?#]/);
  return at === -1 ? pathWithQuery : pathWithQuery.slice(0, at);
}

/** 網址上帶的 `?v=` 跟這份檔案的雜湊對得上嗎 */
function versionMatches(pathWithQuery, sha256) {
  const at = pathWithQuery.indexOf('?');
  if (at === -1) return false;

  const version = shortVersion(sha256);
  return (
    version !== null &&
    pathWithQuery
      .slice(at + 1)
      .split(/[&#]/)
      .includes(`v=${version}`)
  );
}

/**
 * 覆寫的快取政策。
 *
 * ⛔ 預設 `no-store`：使用者換了圖要立刻看得到，而**沒有辦法從伺服器端回頭清掉
 * 瀏覽器已經存下的那一份**（地雷 46）。
 *
 * 但 `?v=<對得上的雜湊>` 是另一回事 —— 那個網址只會對應到這一份內容，所以可以
 * 放心長快取。HTML 裡的引用點由 `lib/cache-bust.js` 加上版本號，換圖 → 雜湊變 →
 * 網址變 → 舊的那筆快取再也不會被用到。這就是「不用按 Ctrl+F5」的來源。
 *
 * 開發模式（`sites.dev_mode`）一律 revalidate，連 `?v=` 也不給長快取 ——
 * 打開它的意思就是「我正在反覆改，什麼都別快取」。
 */
function cacheControlFor(site, pathWithQuery, override) {
  if (site.dev_mode === true) return 'no-cache';
  return versionMatches(pathWithQuery, override.sha256) ? IMMUTABLE : 'no-store';
}

/**
 * 回 true 代表「已經回應了」，呼叫端就不要再往上游跑。
 *
 * @param {{ method: string }} req
 * @param {import('express').Response} res
 * @param {{ store: object, site: object, pathWithQuery: string, logger: object }} context
 */
function serveResourceOverride(req, res, { store, site, pathWithQuery, logger }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const override = store.resourceOverrides.find(site.id, pathnameOf(pathWithQuery));
  if (!override) return false;

  const asset = store.assets.get(override.sha256);
  if (!asset) {
    // 外鍵擋得住「寫入時指到不存在的檔案」，但資料庫被手動改過的機器還是可能
    // 走到這裡。退回去走上游，比回一張破圖好。
    logger.warn(`${site.id} 的覆寫 ${override.path} 指向不存在的 asset ${override.sha256}`);
    return false;
  }

  res.setHeader('content-type', override.content_type);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', cacheControlFor(site, pathWithQuery, override));
  res.setHeader('x-lm-resource-override', '1');
  res.status(200);

  if (req.method === 'HEAD') {
    res.setHeader('content-length', String(asset.bytes));
    res.end();
    return true;
  }

  res.end(asset.content);
  return true;
}

module.exports = { serveResourceOverride, pathnameOf, versionMatches, cacheControlFor, IMMUTABLE };
