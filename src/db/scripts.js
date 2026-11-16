'use strict';

const { NotFoundError } = require('./errors.js');
const { newId, nowIso } = require('../lib/ids.js');

const UPDATABLE_COLUMNS = Object.freeze([
  'name',
  'code',
  'enabled',
  'match_glob',
  'run_at',
  'order_index',
]);

function toFlag(value) {
  return value === true || value === 1 ? 1 : 0;
}

function mapRow(row) {
  return row ? { ...row, enabled: row.enabled === 1 } : null;
}

function siteExists(db, siteId) {
  return db.prepare('SELECT 1 FROM sites WHERE id = ?').get(siteId) !== undefined;
}

function createScript(db, siteId, input) {
  if (!siteExists(db, siteId)) throw new NotFoundError(`找不到網站「${siteId}」`);

  const timestamp = nowIso();
  const row = {
    id: newId('scr'),
    site_id: siteId,
    name: input.name,
    code: input.code,
    enabled: toFlag(input.enabled ?? 1),
    match_glob: input.match_glob ?? '*',
    run_at: input.run_at ?? 'body-end',
    order_index: input.order_index ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };

  db.prepare(
    `INSERT INTO scripts
       (id, site_id, name, code, enabled, match_glob, run_at, order_index, created_at, updated_at)
     VALUES
       (@id, @site_id, @name, @code, @enabled, @match_glob, @run_at, @order_index, @created_at, @updated_at)`,
  ).run(row);

  return mapRow(row);
}

function getScript(db, id) {
  return mapRow(db.prepare('SELECT * FROM scripts WHERE id = ?').get(id));
}

function listScriptsBySite(db, siteId) {
  return db
    .prepare('SELECT * FROM scripts WHERE site_id = ? ORDER BY order_index, created_at, id')
    .all(siteId)
    .map((row) => mapRow(row));
}

function listActiveForSite(db, siteId) {
  return db
    .prepare(
      `SELECT * FROM scripts
        WHERE site_id = ? AND enabled = 1
        ORDER BY order_index, created_at, id`,
    )
    .all(siteId)
    .map((row) => mapRow(row));
}

function updateScript(db, id, patch) {
  const columns = UPDATABLE_COLUMNS.filter((column) => column in patch);
  if (columns.length === 0) throw new Error('沒有可更新的欄位');

  const params = columns.reduce(
    (acc, column) => ({
      ...acc,
      [column]: column === 'enabled' ? toFlag(patch.enabled) : patch[column],
    }),
    { id, updated_at: nowIso() },
  );

  const assignments = [...columns, 'updated_at'].map((column) => `${column} = @${column}`);
  const result = db
    .prepare(`UPDATE scripts SET ${assignments.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) throw new NotFoundError(`找不到腳本「${id}」`);

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
