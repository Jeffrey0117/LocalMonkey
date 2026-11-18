'use strict';

/**
 * 資源覆寫的送出端（SPEC-rules §3.6）。
 *
 * 瀏覽器來要一條被覆寫的路徑時，代理**不去上游拿**，直接回使用者上傳的檔案。
 * 所以這一段要擺在管線的最前面（SSRF、讀 body、forward 全部省掉）。
 *
 * 只處理 GET / HEAD：POST 到一條圖片路徑是上游的事，不該被我們吃掉。
 */

/** 上游 path + query → 純路徑（覆寫比對的是路徑，`?v=2` 不該讓覆寫失效） */
function pathnameOf(pathWithQuery) {
  const at = pathWithQuery.search(/[?#]/);
  return at === -1 ? pathWithQuery : pathWithQuery.slice(0, at);
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
  // ⛔ 不准長期快取：使用者換了圖之後要立刻看得到
  // （地雷 33：我們回的東西是改造過的，不是上游那份）
  res.setHeader('cache-control', 'no-store');
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

module.exports = { serveResourceOverride, pathnameOf };
