'use strict';

const { DuplicateIdError, NotFoundError } = require('./errors.js');
const { nowIso } = require('../lib/ids.js');
const { parseGlossary, serializeGlossary } = require('../translate/glossary.js');

const UPDATABLE_COLUMNS = Object.freeze([
  'name',
  'target_origin',
  'enabled',
  // v4：伺服器端翻譯層（SPEC-translate §2）
  'translate_enabled',
  'translate_lang',
  'translate_model',
  'glossary',
  // v6：開發模式（SPEC-rules §8.2）—— 所有回應改成 revalidate
  'dev_mode',
]);

/** 存成 0/1 的欄位（SQLite 沒有 boolean） */
const FLAG_COLUMNS = new Set(['enabled', 'translate_enabled', 'dev_mode']);

function toFlag(value) {
  return value === true || value === 1 ? 1 : 0;
}

function mapRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    target_origin: row.target_origin,
    enabled: row.enabled === 1,
    auto_created: row.auto_created === 1,
    from_pattern: row.from_pattern,
    translate_enabled: row.translate_enabled === 1,
    translate_lang: row.translate_lang,
    // NULL = 用全域預設（規格 §2）。這裡原樣轉述，不在 DB 層套預設值 ——
    // 不然 UI 分不出「使用者選了這個模型」與「跟著全域走」。
    translate_model: row.translate_model,
    glossary: parseGlossary(row.glossary),
    dev_mode: row.dev_mode === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getSite(db, id) {
  return mapRow(db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
}

function createSite(db, input) {
  const timestamp = nowIso();

  try {
    db.prepare(
      `INSERT INTO sites
         (id, name, target_origin, enabled, auto_created, from_pattern, created_at, updated_at)
       VALUES
         (@id, @name, @target_origin, @enabled, @auto_created, @from_pattern, @created_at, @updated_at)`,
    ).run({
      id: input.id,
      name: input.name,
      target_origin: input.target_origin,
      enabled: toFlag(input.enabled ?? 1),
      auto_created: toFlag(input.auto_created ?? 0),
      from_pattern: input.from_pattern ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    });
  } catch (cause) {
    if (String(cause.code).startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')) {
      throw new DuplicateIdError(`網站 id「${input.id}」已經存在`);
    }
    throw cause;
  }

  return getSite(db, input.id);
}

function listSites(db) {
  return db
    .prepare('SELECT * FROM sites ORDER BY created_at, id')
    .all()
    .map((row) => mapRow(row));
}

/** 「網站」分頁要顯示每個站掛了哪些腳本 */
function listSitesWithScripts(db) {
  const attached = db
    .prepare(
      `SELECT DISTINCT ss.site_id, s.id, s.name, s.enabled, s.order_index, s.created_at
         FROM script_sites ss
         JOIN scripts s ON s.id = ss.script_id
        ORDER BY s.order_index, s.created_at, s.id`,
    )
    .all()
    .reduce((acc, row) => {
      const entry = { id: row.id, name: row.name, enabled: row.enabled === 1 };
      return acc.set(row.site_id, [...(acc.get(row.site_id) ?? []), entry]);
    }, new Map());

  return listSites(db).map((site) => ({ ...site, scripts: attached.get(site.id) ?? [] }));
}

function updateSite(db, id, patch) {
  const columns = UPDATABLE_COLUMNS.filter((column) => column in patch);
  if (columns.length === 0) throw new Error('沒有可更新的欄位');

  const params = columns.reduce((acc, column) => {
    if (FLAG_COLUMNS.has(column)) return { ...acc, [column]: toFlag(patch[column]) };
    // glossary 欄位存 JSON 陣列（跟 script_sites.exclude_glob 同一個做法）
    if (column === 'glossary') return { ...acc, glossary: serializeGlossary(patch.glossary) };
    return { ...acc, [column]: patch[column] };
  }, { id, updated_at: nowIso() });

  const assignments = [...columns, 'updated_at'].map((column) => `${column} = @${column}`);
  const result = db
    .prepare(`UPDATE sites SET ${assignments.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) throw new NotFoundError(`找不到網站「${id}」`);

  return getSite(db, id);
}

/**
 * 刪站。
 *
 * v2 的腳本不再被 sites 的外鍵綁住（一支腳本可以掛多個站，也可以暫時誰都不掛），
 * 但 v1 的語意是「刪站連帶刪它的腳本」。折衷：只刪掉**因為這次刪站而變成沒有任何
 * 綁定**的腳本，其他（還掛在別站的、本來就還沒掛上去的）一律留著 ——
 * 使用者還沒寫好 @match 的腳本不該因為刪了個無關的站就消失。
 */
function removeSite(db, id) {
  const apply = db.transaction(() => {
    const affected = db
      .prepare('SELECT script_id FROM script_sites WHERE site_id = ?')
      .all(id)
      .map((row) => row.script_id);

    const changes = db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes;
    if (changes === 0) return false;

    const remaining = db.prepare(
      'SELECT COUNT(*) AS total FROM script_sites WHERE script_id = ?',
    );
    const removeScript = db.prepare('DELETE FROM scripts WHERE id = ?');

    for (const scriptId of affected) {
      if (remaining.get(scriptId).total === 0) removeScript.run(scriptId);
    }

    return true;
  });

  return apply();
}

module.exports = {
  createSite,
  getSite,
  listSites,
  listSitesWithScripts,
  updateSite,
  removeSite,
  UPDATABLE_COLUMNS,
};
