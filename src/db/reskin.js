'use strict';

/**
 * `reskin_cache`：抽出來的資料（SPEC-reskin §3.3）。
 *
 * key ＝ **上游路徑 + 上游 HTML 的 sha256 + 資料模型的版本**。所以上游一改內容
 * key 就自然錯開，**不需要任何失效邏輯** —— 這跟 `assets` 的內容定址是同一個
 * 做法，也跟 v6 的 `?v=<sha>` cache busting 同一個判準（能用網址／key 表達
 * 「哪一份內容」，就不要靠「什麼時候過期」）。
 *
 * ⛔ **`version` 是後來補的，而且它擋的是一個真的踩過的坑**（2026-11-19）：
 * 上游的雜湊只描述「上游那一份」，描述不了「**我們的抽取層**那一份」。
 * 資料模型加了一個欄位（無限載入要的 `nextPath`）之後，舊的快取照樣命中 ——
 * 於是程式是新的、畫面是舊的，而且 server log 顯示 `cache=hit` 一切正常。
 * 症狀是「改了抽取層完全沒反應」，跟「設定沒存到」長得一模一樣。
 * 所以資料模型的形狀一變，`extract.js` 的 `DATA_MODEL_VERSION` 就要 +1。
 *
 * ⛔ 快取是**純衍生資料**：清掉只是下一次重算一遍，不會掉任何使用者的東西。
 * 所以它可以放心 CASCADE、可以放心整站清掉，而這也是為什麼抽取失敗**不寫**
 * 快取（寫了的話改好設定還得先想辦法把失敗的那筆弄掉）。
 */

const crypto = require('node:crypto');

const { nowIso } = require('../lib/ids.js');

/** 一個站留幾筆。抽取只有兩三種頁型，但每個商品頁都是一筆 → 要有上限。 */
const MAX_ROWS_PER_SITE = 500;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * ⛔ 長度前綴，不是用分隔符串起來。
 * `('a', 'b/c')` 與 `('a/b', 'c')` 用 `/` 串會撞成同一個 key ＝某一頁拿到
 * 另一頁的資料。擋掉它的成本是兩個數字（同 `translate/cache.js` 的 hash）。
 */
function cacheKey({ siteId, path, htmlSha256, version = '' }) {
  return sha256(
    `${siteId.length}:${siteId}${path.length}:${path}${htmlSha256.length}:${htmlSha256}` +
      `${version.length}:${version}`,
  );
}

function getReskinCache(db, key) {
  const row = db.prepare('SELECT * FROM reskin_cache WHERE key = ?').get(key);
  if (!row) return null;

  try {
    return { ...row, data: JSON.parse(row.data) };
  } catch {
    // 寫進去的時候是合法 JSON，所以這裡壞掉代表資料被外力弄壞了。
    // 當成「沒有快取」而不是丟錯 —— 重算一次就好。
    return null;
  }
}

function putReskinCache(db, { key, siteId, path, htmlSha256, kind, data }) {
  db.prepare(
    `INSERT INTO reskin_cache (key, site_id, path, html_sha256, kind, data, created_at)
     VALUES (@key, @site_id, @path, @html_sha256, @kind, @data, @created_at)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
  ).run({
    key,
    site_id: siteId,
    path,
    html_sha256: htmlSha256,
    kind,
    data: JSON.stringify(data),
    created_at: nowIso(),
  });
}

/** 超過上限就砍最舊的（LRU 太重，而重算的成本是幾毫秒） */
function trimReskinCache(db, siteId, limit = MAX_ROWS_PER_SITE) {
  return db
    .prepare(
      `DELETE FROM reskin_cache
        WHERE site_id = @site_id
          AND key NOT IN (
            SELECT key FROM reskin_cache WHERE site_id = @site_id
             ORDER BY created_at DESC, key LIMIT @limit
          )`,
    )
    .run({ site_id: siteId, limit }).changes;
}

/** 控制台改了抽取設定之後要整站重算 */
function clearReskinCache(db, siteId) {
  return db.prepare('DELETE FROM reskin_cache WHERE site_id = ?').run(siteId).changes;
}

function countReskinCache(db, siteId) {
  return db
    .prepare('SELECT COUNT(*) AS total FROM reskin_cache WHERE site_id = ?')
    .get(siteId).total;
}

module.exports = {
  cacheKey,
  sha256,
  getReskinCache,
  putReskinCache,
  trimReskinCache,
  clearReskinCache,
  countReskinCache,
  MAX_ROWS_PER_SITE,
};
