'use strict';

/**
 * `resource_overrides`：上游路徑 → 使用者上傳的檔案（SPEC-rules §3.6）。
 *
 * 瀏覽器來要那個路徑時，代理不去上游拿，直接回使用者的檔案。
 *
 * **為什麼在請求層而不是改 DOM 的 `img.src`**：DOM 改法會閃（原圖先出現）、
 * 漏掉 CSS `background-image`、漏掉 `srcset`、漏掉 JS 動態插入的。
 * 請求層覆寫則是 HTML 完全不用動，所有引用那個路徑的地方一次全換。
 *
 * 檔案本身存在既有的 `assets`（內容定址），這張表只是映射。
 */

const { NotFoundError } = require('./errors.js');
const { newId, nowIso } = require('../lib/ids.js');
const { shortVersion } = require('../lib/cache-bust.js');

function toFlag(value) {
  return value === true || value === 1 ? 1 : 0;
}

function mapRow(row) {
  return row
    ? {
        id: row.id,
        site_id: row.site_id,
        path: row.path,
        sha256: row.sha256,
        content_type: row.content_type,
        enabled: row.enabled === 1,
        bytes: row.bytes ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    : null;
}

const SELECT_WITH_SIZE = `
  SELECT o.*, a.bytes
    FROM resource_overrides o
    LEFT JOIN assets a ON a.sha256 = o.sha256
`;

function getResourceOverride(db, id) {
  return mapRow(db.prepare(`${SELECT_WITH_SIZE} WHERE o.id = ?`).get(id));
}

function listResourceOverrides(db, siteId) {
  return db
    .prepare(`${SELECT_WITH_SIZE} WHERE o.site_id = ? ORDER BY o.path`)
    .all(siteId)
    .map((row) => mapRow(row));
}

/**
 * 代理每個請求都會問一次，所以這支要盡量便宜：一次 index 命中的 SELECT。
 * 停用的覆寫當作不存在。
 */
function findResourceOverride(db, siteId, path) {
  return mapRow(
    db
      .prepare(`${SELECT_WITH_SIZE} WHERE o.site_id = ? AND o.path = ? AND o.enabled = 1`)
      .get(siteId, path),
  );
}

/**
 * 「換一張圖」＝ upsert。`UNIQUE(site_id, path)` 讓同一條路徑只會有一列，
 * 所以使用者重複上傳不會長出一堆看起來一樣的設定。
 */
function putResourceOverride(db, siteId, input) {
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO resource_overrides
       (id, site_id, path, sha256, content_type, enabled, created_at, updated_at)
     VALUES
       (@id, @site_id, @path, @sha256, @content_type, @enabled, @created_at, @updated_at)
     ON CONFLICT(site_id, path) DO UPDATE SET
       sha256       = excluded.sha256,
       content_type = excluded.content_type,
       enabled      = excluded.enabled,
       updated_at   = excluded.updated_at`,
  ).run({
    id: input.id ?? newId('res'),
    site_id: siteId,
    path: input.path,
    sha256: input.sha256,
    content_type: input.content_type,
    enabled: toFlag(input.enabled ?? 1),
    created_at: timestamp,
    updated_at: timestamp,
  });

  return findResourceOverrideAny(db, siteId, input.path);
}

/**
 * 這個站「被覆寫的路徑 → 版本號」（`lib/cache-bust.js` 的 `?v=`）。
 *
 * 代理對每一份 HTML 問一次，所以只拿兩個欄位、走同一個 index。
 * 停用的覆寫不列 —— 它的那條路徑回去走上游，加版本號只會讓快取白白失效。
 *
 * ⛔ 空的 Map 是常見狀況（大部分站沒有任何覆寫），呼叫端要能零成本跳過。
 */
function resourceVersions(db, siteId) {
  return new Map(
    db
      .prepare('SELECT path, sha256 FROM resource_overrides WHERE site_id = ? AND enabled = 1')
      .all(siteId)
      .map((row) => [row.path, shortVersion(row.sha256)])
      .filter(([, version]) => version !== null),
  );
}

/** 含停用的（put 之後要把那一列回給 UI，即使它是停用狀態） */
function findResourceOverrideAny(db, siteId, path) {
  return mapRow(
    db.prepare(`${SELECT_WITH_SIZE} WHERE o.site_id = ? AND o.path = ?`).get(siteId, path),
  );
}

function updateResourceOverride(db, id, patch) {
  if (!('enabled' in patch)) throw new Error('沒有可更新的欄位');

  const result = db
    .prepare('UPDATE resource_overrides SET enabled = @enabled, updated_at = @updated_at WHERE id = @id')
    .run({ id, enabled: toFlag(patch.enabled), updated_at: nowIso() });

  if (result.changes === 0) throw new NotFoundError(`找不到資源覆寫「${id}」`);

  return getResourceOverride(db, id);
}

/**
 * 只刪映射，**不刪 assets 裡的檔案** —— 那是內容定址的共用儲存，
 * 同一個 sha256 可能被別的站或別的腳本的 @resource 用著。
 */
function removeResourceOverride(db, id) {
  return db.prepare('DELETE FROM resource_overrides WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  putResourceOverride,
  resourceVersions,
  getResourceOverride,
  listResourceOverrides,
  findResourceOverride,
  updateResourceOverride,
  removeResourceOverride,
};
