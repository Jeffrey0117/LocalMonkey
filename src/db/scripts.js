'use strict';

/**
 * v1 的腳本 API —— **相容層**，不是 v2 的主要路徑。
 *
 * v2 把 scripts 拆成「腳本本體 + script_sites 綁定」，但 v1 的
 * `POST /admin/api/sites/:siteId/scripts` 與 `{ code, match_glob, site_id }`
 * 這組形狀還留著（手動建站 / 手動加一支純 JS 的路徑），所以這個檔案把
 * 新 schema 投影回 v1 的樣子：
 *
 *   code       ← scripts.source
 *   site_id    ← script_sites.site_id（第一個綁定）
 *   match_glob ← script_sites.path_glob（第一個綁定）
 *   run_at     原樣（v1 的 'head-end' / 'body-end' 仍然是合法值，注入位置與 v1 相同）
 *
 * 新的控制台一律走 db/userscripts.js，不要用這裡的函式加新功能。
 */

const { NotFoundError } = require('./errors.js');
const { newId, nowIso } = require('../lib/ids.js');
const { legacyMetadata, countBindings } = require('./userscripts.js');

const UPDATABLE_COLUMNS = Object.freeze([
  'name',
  'code',
  'enabled',
  'match_glob',
  'run_at',
  'order_index',
]);

/** v1 的欄位 → v2 的欄位。match_glob 不在這裡（它在 script_sites）。 */
const COLUMN_ALIASES = Object.freeze({ code: 'source' });

const SELECT_LEGACY = `
SELECT s.id,
       s.name,
       s.source      AS code,
       s.enabled,
       s.run_at,
       s.order_index,
       s.created_at,
       s.updated_at,
       ss.site_id    AS site_id,
       ss.path_glob  AS match_glob
  FROM scripts s
  LEFT JOIN script_sites ss ON ss.script_id = s.id
`;

function toFlag(value) {
  return value === true || value === 1 ? 1 : 0;
}

function mapRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    site_id: row.site_id,
    name: row.name,
    code: row.code,
    enabled: row.enabled === 1,
    match_glob: row.match_glob,
    run_at: row.run_at,
    order_index: row.order_index,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function siteExists(db, siteId) {
  return db.prepare('SELECT 1 FROM sites WHERE id = ?').get(siteId) !== undefined;
}

function getScript(db, id) {
  return mapRow(
    db
      .prepare(`${SELECT_LEGACY} WHERE s.id = ? ORDER BY ss.site_id, ss.path_glob LIMIT 1`)
      .get(id),
  );
}

function createScript(db, siteId, input) {
  if (!siteExists(db, siteId)) throw new NotFoundError(`找不到網站「${siteId}」`);

  const timestamp = nowIso();
  const id = newId('scr');

  const apply = db.transaction(() => {
    db.prepare(
      `INSERT INTO scripts
         (id, name, version, description, source, metadata, run_at, enabled, order_index, created_at, updated_at)
       VALUES
         (@id, @name, NULL, NULL, @source, @metadata, @run_at, @enabled, @order_index, @created_at, @updated_at)`,
    ).run({
      id,
      name: input.name,
      source: input.code,
      metadata: JSON.stringify(legacyMetadata()),
      run_at: input.run_at ?? 'body-end',
      enabled: toFlag(input.enabled ?? 1),
      order_index: input.order_index ?? 0,
      created_at: timestamp,
      updated_at: timestamp,
    });

    db.prepare(
      'INSERT INTO script_sites (script_id, site_id, path_glob, exclude_glob) VALUES (?, ?, ?, NULL)',
    ).run(id, siteId, input.match_glob ?? '*');
  });

  apply();

  return getScript(db, id);
}

function listScriptsBySite(db, siteId) {
  return db
    .prepare(
      `${SELECT_LEGACY} WHERE ss.site_id = ? ORDER BY s.order_index, s.created_at, s.id, ss.path_glob`,
    )
    .all(siteId)
    .map((row) => mapRow(row));
}

function listActiveForSite(db, siteId) {
  return db
    .prepare(
      `${SELECT_LEGACY}
        WHERE ss.site_id = ? AND s.enabled = 1
        ORDER BY s.order_index, s.created_at, s.id, ss.path_glob`,
    )
    .all(siteId)
    .map((row) => mapRow(row));
}

/**
 * match_glob 的更新要落在 script_sites 上。一支腳本掛在多個站時這個 v1 形狀
 * 是有歧義的（改哪一個？）→ 直接丟錯，不要猜。
 */
function updateBindingGlob(db, id, matchGlob) {
  const total = countBindings(db, id);

  if (total === 0) {
    throw new Error(`腳本「${id}」沒有綁定任何網站，無法用 match_glob 更新（請改 userscript header）`);
  }
  if (total > 1) {
    throw new Error(
      `腳本「${id}」掛在 ${total} 個網站上，match_glob 有歧義；請改 userscript header 的 @match`,
    );
  }

  db.prepare('UPDATE script_sites SET path_glob = ? WHERE script_id = ?').run(matchGlob, id);
}

function updateScript(db, id, patch) {
  const columns = UPDATABLE_COLUMNS.filter((column) => column in patch);
  if (columns.length === 0) throw new Error('沒有可更新的欄位');

  const scriptColumns = columns.filter((column) => column !== 'match_glob');

  const params = scriptColumns.reduce((acc, column) => {
    const target = COLUMN_ALIASES[column] ?? column;
    const value = column === 'enabled' ? toFlag(patch.enabled) : patch[column];
    return { ...acc, [target]: value };
  }, { id, updated_at: nowIso() });

  const assignments = [
    ...scriptColumns.map((column) => COLUMN_ALIASES[column] ?? column),
    'updated_at',
  ].map((column) => `${column} = @${column}`);

  const apply = db.transaction(() => {
    const result = db
      .prepare(`UPDATE scripts SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params);

    if (result.changes === 0) throw new NotFoundError(`找不到腳本「${id}」`);

    if ('match_glob' in patch) updateBindingGlob(db, id, patch.match_glob);
  });

  apply();

  return getScript(db, id);
}

function removeScript(db, id) {
  return db.prepare('DELETE FROM scripts WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  createScript,
  getScript,
  listScriptsBySite,
  listActiveForSite,
  updateScript,
  removeScript,
  UPDATABLE_COLUMNS,
};
