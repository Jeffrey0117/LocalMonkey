'use strict';

/**
 * 單向 schema 版本（PRAGMA user_version）。往後要改 schema 就在陣列尾端加一筆，
 * 不改既有的 migration —— 已經跑過的機器只會跑新增的那幾筆。
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

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    up: (db) => db.exec(SCHEMA_V1),
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
