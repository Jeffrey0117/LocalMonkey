'use strict';

/**
 * `site_rules`：每個站一組「改造規則」（SPEC-rules §2）。
 *
 * 這些是**資料**不是程式碼 —— 使用者在控制台編輯，立刻生效、不用重啟、
 * 也不用寫 userscript。規則怎麼執行在 `src/rules/`，這裡只管存取。
 */

const { NotFoundError } = require('./errors.js');
const { newId, nowIso } = require('../lib/ids.js');

const UPDATABLE_COLUMNS = Object.freeze([
  'kind',
  'pattern',
  'replacement',
  'scope',
  'note',
  'enabled',
  'order_index',
]);

function toFlag(value) {
  return value === true || value === 1 ? 1 : 0;
}

function mapRow(row) {
  return row
    ? {
        id: row.id,
        site_id: row.site_id,
        kind: row.kind,
        pattern: row.pattern,
        // `replacement` 的空字串是有意義的（把一段文字刪掉），不要折成 null
        replacement: row.replacement ?? '',
        scope: row.scope,
        note: row.note,
        enabled: row.enabled === 1,
        order_index: row.order_index,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    : null;
}

function getSiteRule(db, id) {
  return mapRow(db.prepare('SELECT * FROM site_rules WHERE id = ?').get(id));
}

/** 照 order_index 排好 —— 規則是依序套用的，順序本身就是語意（規格 §1） */
function listSiteRules(db, siteId) {
  return db
    .prepare('SELECT * FROM site_rules WHERE site_id = ? ORDER BY order_index, id')
    .all(siteId)
    .map((row) => mapRow(row));
}

/** 新規則排在最後面（使用者一條一條加，預期是「加在下面」） */
function nextOrderIndex(db, siteId) {
  const row = db
    .prepare('SELECT MAX(order_index) AS highest FROM site_rules WHERE site_id = ?')
    .get(siteId);

  return (row?.highest ?? -1) + 1;
}

function createSiteRule(db, siteId, input) {
  const id = input.id ?? newId('rule');
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO site_rules
       (id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at)
     VALUES
       (@id, @site_id, @kind, @pattern, @replacement, @scope, @note, @enabled, @order_index, @created_at, @updated_at)`,
  ).run({
    id,
    site_id: siteId,
    kind: input.kind,
    pattern: input.pattern,
    replacement: input.replacement ?? null,
    scope: input.scope ?? null,
    note: input.note ?? null,
    enabled: toFlag(input.enabled ?? 1),
    order_index: input.order_index ?? nextOrderIndex(db, siteId),
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getSiteRule(db, id);
}

function updateSiteRule(db, id, patch) {
  const columns = UPDATABLE_COLUMNS.filter((column) => column in patch);
  if (columns.length === 0) throw new Error('沒有可更新的欄位');

  const params = columns.reduce(
    (acc, column) => ({
      ...acc,
      [column]: column === 'enabled' ? toFlag(patch[column]) : patch[column] ?? null,
    }),
    { id, updated_at: nowIso() },
  );

  const assignments = [...columns, 'updated_at'].map((column) => `${column} = @${column}`);
  const result = db
    .prepare(`UPDATE site_rules SET ${assignments.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) throw new NotFoundError(`找不到規則「${id}」`);

  return getSiteRule(db, id);
}

function removeSiteRule(db, id) {
  return db.prepare('DELETE FROM site_rules WHERE id = ?').run(id).changes > 0;
}

/**
 * 整批重排。前端的「上移 / 下移」給的是新的 id 順序，一次寫完 ——
 * 一條一條更新會在中途留下重複的 order_index（畫面會跳）。
 */
function reorderSiteRules(db, siteId, ids) {
  const update = db.prepare(
    'UPDATE site_rules SET order_index = @order_index, updated_at = @updated_at WHERE id = @id AND site_id = @site_id',
  );
  const timestamp = nowIso();

  const apply = db.transaction(() => {
    ids.forEach((id, index) => {
      update.run({ id, site_id: siteId, order_index: index, updated_at: timestamp });
    });
  });

  apply();
  return listSiteRules(db, siteId);
}

/** 哪些站有規則（控制台的網站清單要顯示數量） */
function countSiteRules(db) {
  return db
    .prepare('SELECT site_id, COUNT(*) AS total FROM site_rules GROUP BY site_id')
    .all()
    .reduce((acc, row) => ({ ...acc, [row.site_id]: row.total }), {});
}

module.exports = {
  createSiteRule,
  getSiteRule,
  listSiteRules,
  updateSiteRule,
  removeSiteRule,
  reorderSiteRules,
  countSiteRules,
  UPDATABLE_COLUMNS,
};
