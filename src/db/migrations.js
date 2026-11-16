'use strict';

/**
 * 單向 schema 版本（PRAGMA user_version）。往後要改 schema 就在陣列尾端加一筆，
 * 不改既有的 migration —— 已經跑過的機器只會跑新增的那幾筆。
 *
 * 也因為「不改舊的」，這個檔案裡的 SQL 與常數刻意**不 import** 任何會演化的模組：
 * migration 是凍結的歷史，不該跟著 src/db/*.js 的重構一起變。
 */

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  match_glob  TEXT NOT NULL DEFAULT '*',
  run_at      TEXT NOT NULL DEFAULT 'body-end' CHECK (run_at IN ('head-end', 'body-end')),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scripts_site_order
  ON scripts (site_id, order_index, created_at);
`;

/**
 * v2：腳本不再綁單一站台。
 *
 * v1 的 `scripts.site_id` 是單一外鍵 → 一支腳本配兩個網域就得複製兩份程式碼，
 * 「改一次全部生效」這個核心賣點直接破功。所以改成多對多（script_sites）。
 *
 * `run_at` 的 CHECK 同時留著 v1 的 `head-end` / `body-end`：
 * 舊資料會被這次 migration 轉成 document-*，但 v1 的建立 API（legacy 相容層）
 * 還是會寫入那兩個值，而且它們的注入位置與 v1 完全一樣（見 lib/injection.js）。
 */
const SCHEMA_V2_STRUCTURE = `
ALTER TABLE sites ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0 CHECK (auto_created IN (0, 1));
ALTER TABLE sites ADD COLUMN from_pattern TEXT;

ALTER TABLE scripts RENAME TO scripts_v1;
DROP INDEX IF EXISTS idx_scripts_site_order;

CREATE TABLE scripts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT,
  description TEXT,
  source      TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  run_at      TEXT NOT NULL DEFAULT 'document-end'
                CHECK (run_at IN ('document-start', 'document-end', 'document-idle', 'head-end', 'body-end')),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE script_sites (
  script_id    TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  site_id      TEXT NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
  path_glob    TEXT NOT NULL,
  exclude_glob TEXT,
  PRIMARY KEY (script_id, site_id, path_glob)
);

CREATE TABLE assets (
  sha256       TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  content      BLOB NOT NULL,
  content_type TEXT,
  bytes        INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE INDEX idx_scripts_order      ON scripts (order_index, created_at, id);
CREATE INDEX idx_script_sites_site  ON script_sites (site_id);
CREATE INDEX idx_assets_url         ON assets (url);
`;

/** v1 的腳本沒有 header 可解析，先標成 legacy；使用者下次存檔才會真的解析一遍。 */
const LEGACY_METADATA_JSON = JSON.stringify({
  legacy: true,
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

const COPY_SCRIPTS_V1 = `
INSERT INTO scripts
  (id, name, version, description, source, metadata, run_at, enabled, order_index, created_at, updated_at)
SELECT
  id,
  name,
  NULL,
  NULL,
  code,
  @metadata,
  CASE run_at
    WHEN 'head-end' THEN 'document-start'
    WHEN 'body-end' THEN 'document-end'
    ELSE 'document-end'
  END,
  enabled,
  order_index,
  created_at,
  updated_at
FROM scripts_v1
`;

/**
 * `WHERE site_id IN (…)` 是給「資料庫被手動改過、留下孤兒腳本」的機器用的：
 * 孤兒的程式碼照樣搬進新表（不刪使用者的東西），只是沒有綁定。
 */
const COPY_BINDINGS_V1 = `
INSERT INTO script_sites (script_id, site_id, path_glob, exclude_glob)
SELECT id, site_id, match_glob, NULL
FROM scripts_v1
WHERE site_id IN (SELECT id FROM sites)
`;

function upgradeToV2(db) {
  db.exec(SCHEMA_V2_STRUCTURE);
  db.prepare(COPY_SCRIPTS_V1).run({ metadata: LEGACY_METADATA_JSON });
  db.prepare(COPY_BINDINGS_V1).run();
  db.exec('DROP TABLE scripts_v1;');
}

/**
 * v3：投遞模式（SPEC-console §8）。
 *
 * 每支腳本一組不可猜的 token，`GET /s/<token>/<slug>.user.js` 靠它當憑證 ——
 * Tampermonkey 抓腳本時帶不了 admin token，所以那個端點必須免認證。
 *
 * UNIQUE 索引在 SQLite 容許多個 NULL，所以先加欄位再回填既有資料。
 */
const SCHEMA_V3 = `
ALTER TABLE scripts ADD COLUMN delivery_token TEXT;
CREATE UNIQUE INDEX idx_scripts_delivery_token ON scripts (delivery_token);
`;

function upgradeToV3(db) {
  db.exec(SCHEMA_V3);

  const rows = db.prepare('SELECT id FROM scripts').all();
  const update = db.prepare('UPDATE scripts SET delivery_token = ? WHERE id = ?');

  for (const row of rows) {
    update.run(require('node:crypto').randomBytes(32).toString('hex'), row.id);
  }
}

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    up: (db) => db.exec(SCHEMA_V1),
  }),
  Object.freeze({
    version: 2,
    up: upgradeToV2,
  }),
  Object.freeze({
    version: 3,
    up: upgradeToV3,
  }),
]);

const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      apply();
    } catch (cause) {
      throw new Error(`schema migration v${migration.version} 失敗：${cause.message}`, { cause });
    }
  }

  return db.pragma('user_version', { simple: true });
}

module.exports = { migrate, MIGRATIONS, SCHEMA_VERSION };
