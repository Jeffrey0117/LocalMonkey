'use strict';

/**
 * v2 的腳本 repository：腳本本體 + 它掛在哪些站（多對多）。
 *
 * `source`（原始 .user.js 全文）是唯一真相來源；`metadata` 是解析結果的快取，
 * 存成 JSON TEXT。讀不回來的 metadata 一律退回安全預設 —— 代理頁面不能因為
 * 一筆壞資料就掛掉。
 */

const { NotFoundError } = require('./errors.js');
const { newId, nowIso } = require('../lib/ids.js');
const { scriptFeatures } = require('../lib/script-features.js');
const { newDeliveryToken } = require('../services/delivery.js');

const UPDATABLE_COLUMNS = Object.freeze([
  'name',
  'version',
  'description',
  'source',
  'metadata',
  'run_at',
  'enabled',
  'order_index',
]);

/** metadata 讀不回來時的樣子：什麼都不做，但不會讓呼叫端 undefined 爆炸 */
const METADATA_FALLBACK = Object.freeze({
  broken: true,
  hasMetadataBlock: false,
  needsShim: false,
  grants: [],
  canonicalGrants: [],
  supportedGrants: [],
  unsupportedGrants: [],
  connect: [],
  connectAll: false,
  requires: [],
  resources: [],
  requireAssets: [],
  resourceAssets: [],
  noframes: false,
  targets: [],
  excludes: [],
  notices: [],
});

function legacyMetadata() {
  return { ...METADATA_FALLBACK, broken: false, legacy: true };
}

function toFlag(value) {
  return value === true || value === 1 ? 1 : 0;
}

function parseMetadata(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...METADATA_FALLBACK };
    }
    return parsed;
  } catch {
    return { ...METADATA_FALLBACK };
  }
}

/** exclude_glob 存的是 JSON 陣列（一個站可能有多條排除規則）。壞掉就當沒有排除。 */
function decodeExcludes(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((glob) => typeof glob === 'string') : [];
  } catch {
    return [];
  }
}

function encodeExcludes(globs) {
  const list = Array.isArray(globs) ? globs.filter((glob) => typeof glob === 'string') : [];
  return list.length > 0 ? JSON.stringify(list) : null;
}

function mapScript(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    source: row.source,
    metadata: parseMetadata(row.metadata),
    run_at: row.run_at,
    enabled: row.enabled === 1,
    order_index: row.order_index,
    delivery_token: row.delivery_token,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapBinding(row) {
  return {
    site_id: row.site_id,
    path_glob: row.path_glob,
    exclude_globs: decodeExcludes(row.exclude_glob),
  };
}

function listBindings(db, scriptId) {
  return db
    .prepare(
      `SELECT site_id, path_glob, exclude_glob
         FROM script_sites
        WHERE script_id = ?
        ORDER BY site_id, path_glob`,
    )
    .all(scriptId)
    .map((row) => mapBinding(row));
}

function scriptExists(db, id) {
  return db.prepare('SELECT 1 FROM scripts WHERE id = ?').get(id) !== undefined;
}

function getUserscript(db, id) {
  const row = db.prepare('SELECT * FROM scripts WHERE id = ?').get(id);
  if (!row) return null;

  return { ...mapScript(row), sites: listBindings(db, id) };
}

function createUserscript(db, input) {
  const timestamp = nowIso();
  const id = newId('scr');

  db.prepare(
    `INSERT INTO scripts
       (id, name, version, description, source, metadata, run_at, enabled, order_index, delivery_token, created_at, updated_at)
     VALUES
       (@id, @name, @version, @description, @source, @metadata, @run_at, @enabled, @order_index, @delivery_token, @created_at, @updated_at)`,
  ).run({
    id,
    delivery_token: newDeliveryToken(),
    name: input.name,
    version: input.version ?? null,
    description: input.description ?? null,
    source: input.source,
    metadata: JSON.stringify(input.metadata ?? {}),
    run_at: input.run_at ?? 'document-end',
    enabled: toFlag(input.enabled ?? 1),
    order_index: input.order_index ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getUserscript(db, id);
}

function updateUserscript(db, id, patch) {
  const columns = UPDATABLE_COLUMNS.filter((column) => column in patch);
  if (columns.length === 0) throw new Error('沒有可更新的欄位');

  const params = columns.reduce((acc, column) => {
    if (column === 'enabled') return { ...acc, enabled: toFlag(patch.enabled) };
    if (column === 'metadata') return { ...acc, metadata: JSON.stringify(patch.metadata ?? {}) };
    return { ...acc, [column]: patch[column] };
  }, { id, updated_at: nowIso() });

  const assignments = [...columns, 'updated_at'].map((column) => `${column} = @${column}`);
  const result = db
    .prepare(`UPDATE scripts SET ${assignments.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) throw new NotFoundError(`找不到腳本「${id}」`);

  return getUserscript(db, id);
}

function removeUserscript(db, id) {
  return db.prepare('DELETE FROM scripts WHERE id = ?').run(id).changes > 0;
}

/**
 * 整批換掉這支腳本的綁定（不是累加）。重複的 (site, path) 會先在記憶體裡收斂，
 * 指到不存在的 site 則讓外鍵把整個 transaction 擋掉 —— 寧可丟錯也不要留壞資料。
 */
function setBindings(db, scriptId, bindings) {
  const unique = [...
    (Array.isArray(bindings) ? bindings : []).reduce((acc, binding) => {
      const key = `${binding.site_id}|${binding.path_glob}`;
      return acc.has(key) ? acc : acc.set(key, binding);
    }, new Map()).values(),
  ];

  const apply = db.transaction(() => {
    if (!scriptExists(db, scriptId)) throw new NotFoundError(`找不到腳本「${scriptId}」`);

    db.prepare('DELETE FROM script_sites WHERE script_id = ?').run(scriptId);

    const insert = db.prepare(
      `INSERT INTO script_sites (script_id, site_id, path_glob, exclude_glob)
       VALUES (?, ?, ?, ?)`,
    );

    for (const binding of unique) {
      insert.run(scriptId, binding.site_id, binding.path_glob, encodeExcludes(binding.exclude_globs));
    }
  });

  apply();
  return listBindings(db, scriptId);
}

/**
 * 列表刻意不帶 source（可能 1MB），但帶 metadata 與掛在哪些站，後台列表就夠畫了。
 *
 * ⛔ 大小用 `LENGTH(CAST(source AS BLOB))`：SQLite 的 `LENGTH()` 對 TEXT 回的是
 * **字元數**，中文註解的腳本會被短報三倍。儀表板顯示的是檔案大小，要 byte。
 */
function listUserscripts(db) {
  const scripts = db
    .prepare(
      `SELECT id, name, version, description, metadata, run_at, enabled, order_index,
              delivery_token, LENGTH(CAST(source AS BLOB)) AS size_bytes, created_at, updated_at
         FROM scripts
        ORDER BY order_index, created_at, id`,
    )
    .all();

  const bindings = db
    .prepare('SELECT script_id, site_id FROM script_sites ORDER BY site_id')
    .all()
    .reduce((acc, row) => {
      const current = acc.get(row.script_id) ?? [];
      return current.includes(row.site_id)
        ? acc
        : acc.set(row.script_id, [...current, row.site_id]);
    }, new Map());

  return scripts.map((row) => {
    const metadata = parseMetadata(row.metadata);
    const siteIds = bindings.get(row.id) ?? [];

    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      metadata,
      run_at: row.run_at,
      enabled: row.enabled === 1,
      order_index: row.order_index,
      created_at: row.created_at,
      updated_at: row.updated_at,
      site_ids: siteIds,

      // 儀表板欄位（SPEC-dashboard §2）。camelCase 的是新的，snake_case 的是
      // v2 既有的契約 —— 兩個都留著，不要為了「整理」而拔掉舊名字。
      size: row.size_bytes ?? 0,
      updatedAt: row.updated_at,
      siteIds,
      featureFlags: scriptFeatures({ metadata, deliveryToken: row.delivery_token }),
    };
  });
}

/**
 * 注入用：一個綁定一列（同一支腳本在同一個站可以有多條 path_glob）。
 * 真正的 glob 比對與去重在 lib/injection.js，這裡只負責把資料撈出來。
 */
function listForInjection(db, siteId) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.run_at, s.metadata, s.order_index, s.created_at,
              ss.path_glob, ss.exclude_glob
         FROM scripts s
         JOIN script_sites ss ON ss.script_id = s.id
        WHERE ss.site_id = ? AND s.enabled = 1
        ORDER BY s.order_index, s.created_at, s.id, ss.path_glob`,
    )
    .all(siteId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      run_at: row.run_at,
      metadata: parseMetadata(row.metadata),
      order_index: row.order_index,
      path_glob: row.path_glob,
      exclude_globs: decodeExcludes(row.exclude_glob),
    }));
}

/**
 * 用投遞 token 找腳本。查無一律回 null —— 呼叫端要回 404，不能洩漏腳本存不存在。
 */
function getByDeliveryToken(db, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;

  const row = db.prepare('SELECT * FROM scripts WHERE delivery_token = ?').get(token);
  if (!row) return null;

  return { ...mapScript(row), sites: listBindings(db, row.id) };
}

/** 重新產生 token＝撤銷舊網址（已安裝的裝置之後會更新失敗，要重裝） */
function rotateDeliveryToken(db, id) {
  const token = newDeliveryToken();
  const result = db
    .prepare('UPDATE scripts SET delivery_token = ?, updated_at = ? WHERE id = ?')
    .run(token, nowIso(), id);

  if (result.changes === 0) throw new NotFoundError(`找不到腳本「${id}」`);

  return getUserscript(db, id);
}

/** 這支腳本掛在幾個站（legacy 相容層要用來判斷 match_glob 能不能改） */
function countBindings(db, scriptId) {
  return db
    .prepare('SELECT COUNT(*) AS total FROM script_sites WHERE script_id = ?')
    .get(scriptId).total;
}

module.exports = {
  createUserscript,
  getUserscript,
  listUserscripts,
  listForInjection,
  updateUserscript,
  removeUserscript,
  setBindings,
  listBindings,
  getByDeliveryToken,
  rotateDeliveryToken,
  countBindings,
  scriptExists,
  legacyMetadata,
  decodeExcludes,
  encodeExcludes,
  UPDATABLE_COLUMNS,
  METADATA_FALLBACK,
};
