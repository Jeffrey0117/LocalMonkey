'use strict';

const { DuplicateIdError, NotFoundError } = require('./errors.js');
const { nowIso } = require('../lib/ids.js');

const UPDATABLE_COLUMNS = Object.freeze(['name', 'target_origin', 'enabled']);

function toFlag(value) {
  return value === true || value === 1 ? 1 : 0;
}

function mapRow(row) {
  return row ? { ...row, enabled: row.enabled === 1 } : null;
}

function createSite(db, input) {
  const timestamp = nowIso();
  const row = {
    id: input.id,
    name: input.name,
    target_origin: input.target_origin,
    enabled: toFlag(input.enabled ?? 1),
    created_at: timestamp,
    updated_at: timestamp,
  };

  try {
    db.prepare(
      `INSERT INTO sites (id, name, target_origin, enabled, created_at, updated_at)
       VALUES (@id, @name, @target_origin, @enabled, @created_at, @updated_at)`,
    ).run(row);
  } catch (cause) {
    if (String(cause.code).startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')) {
      throw new DuplicateIdError(`網站 id「${input.id}」已經存在`);
    }
    throw cause;
  }

  return mapRow(row);
}

function getSite(db, id) {
  return mapRow(db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
}

function listSites(db) {
  return db
    .prepare('SELECT * FROM sites ORDER BY created_at, id')
    .all()
    .map((row) => mapRow(row));
}

function updateSite(db, id, patch) {
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
    .prepare(`UPDATE sites SET ${assignments.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) throw new NotFoundError(`找不到網站「${id}」`);

  return getSite(db, id);
}

function removeSite(db, id) {
  return db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes > 0;
}

module.exports = { createSite, getSite, listSites, updateSite, removeSite, UPDATABLE_COLUMNS };
