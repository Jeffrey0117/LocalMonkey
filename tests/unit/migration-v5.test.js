'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate, SCHEMA_VERSION } = require('../../src/db/migrations.js');
const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).map((column) => column.name);
}

/**
 * ⛔ 這條故意釘**當下**的版本號（而不是跟著 SCHEMA_VERSION 浮動）：加 migration
 * 的時候要被迫回來看一眼，確認自己是「加新版本」而不是「改舊的那一版」。
 * 那個「當下」的釘子永遠在**最新那一版**的測試檔裡（現在是 migration-v7.test.js）。
 */
test('schema 版本至少到 v5（v5 是這個檔案的主角）', () => {
  assert.ok(SCHEMA_VERSION >= 5, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
  assert.equal(fresh().pragma('user_version', { simple: true }), SCHEMA_VERSION);
});

test('site_rules 的欄位齊全（含規格 §3.2 後來追加的 scope）', () => {
  assert.deepEqual(columnsOf(fresh(), 'site_rules').sort(), [
    'created_at',
    'enabled',
    'id',
    'kind',
    'note',
    'order_index',
    'pattern',
    'replacement',
    'scope',
    'site_id',
    'updated_at',
  ]);
});

test('resource_overrides 的欄位齊全', () => {
  assert.deepEqual(columnsOf(fresh(), 'resource_overrides').sort(), [
    'content_type',
    'created_at',
    'enabled',
    'id',
    'path',
    'sha256',
    'site_id',
    'updated_at',
  ]);
});

test('kind 只接受三種（打錯字要在 DB 層就被擋下來）', () => {
  const db = fresh();
  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('s', 's', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();

  const insert = (kind) =>
    db
      .prepare(
        `INSERT INTO site_rules (id, site_id, kind, pattern, enabled, order_index, created_at, updated_at)
         VALUES (@id, 's', @kind, 'x', 1, 0, 'now', 'now')`,
      )
      .run({ id: `r-${kind}`, kind });

  insert('hide');
  assert.throws(() => insert('delete-element'), /CHECK/);
});

test('刪站會連帶刪掉它的規則與資源覆寫（CASCADE）', () => {
  const store = createStore(openDatabase(':memory:'));
  store.sites.create({ id: 'demo', name: 'demo', target_origin: 'https://example.test' });
  store.siteRules.create('demo', { kind: 'hide', pattern: '.x' });

  const asset = store.assets.put({ url: 'local:x', content: Buffer.from([1, 2, 3]) });
  store.resourceOverrides.put('demo', {
    path: '/images/x.png',
    sha256: asset.sha256,
    content_type: 'image/png',
  });

  assert.equal(store.siteRules.listBySite('demo').length, 1);
  assert.equal(store.resourceOverrides.listBySite('demo').length, 1);

  store.sites.remove('demo');

  assert.equal(store.siteRules.listBySite('demo').length, 0);
  assert.equal(store.resourceOverrides.listBySite('demo').length, 0);
});

test('同一個站同一條路徑只能有一筆覆寫（再 put 就是換掉）', () => {
  const store = createStore(openDatabase(':memory:'));
  store.sites.create({ id: 'demo', name: 'demo', target_origin: 'https://example.test' });

  const first = store.assets.put({ url: 'local:a', content: Buffer.from('a') });
  const second = store.assets.put({ url: 'local:b', content: Buffer.from('b') });

  store.resourceOverrides.put('demo', {
    path: '/logo.png',
    sha256: first.sha256,
    content_type: 'image/png',
  });
  const updated = store.resourceOverrides.put('demo', {
    path: '/logo.png',
    sha256: second.sha256,
    content_type: 'image/webp',
  });

  assert.equal(store.resourceOverrides.listBySite('demo').length, 1);
  assert.equal(updated.sha256, second.sha256);
  assert.equal(updated.content_type, 'image/webp');
});

test('⛔ 覆寫不能指向不存在的 asset（外鍵）', () => {
  const store = createStore(openDatabase(':memory:'));
  store.sites.create({ id: 'demo', name: 'demo', target_origin: 'https://example.test' });

  assert.throws(
    () =>
      store.resourceOverrides.put('demo', {
        path: '/logo.png',
        sha256: 'f'.repeat(64),
        content_type: 'image/png',
      }),
    /FOREIGN KEY/,
  );
});

test('重複跑 migrate 不會壞（已經是最新版就什麼都不做）', () => {
  const db = fresh();
  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('s', 's', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();

  assert.equal(migrate(db), SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 1);
});

test('v4 的資料庫升上來之後，既有資料還在', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // 先只升到 v4
  const { MIGRATIONS } = require('../../src/db/migrations.js');
  for (const migration of MIGRATIONS.filter((item) => item.version <= 4)) {
    migration.up(db);
    db.pragma(`user_version = ${migration.version}`);
  }

  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('old', 'old site', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO translations (hash, source_text, target_lang, model, translated, origin, created_at, updated_at)
     VALUES ('h', 'Hello', 'zh-TW', 'm', '你好', 'manual', 'now', 'now')`,
  ).run();

  assert.equal(migrate(db), SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT name FROM sites WHERE id = ?').get('old').name, 'old site');
  assert.equal(db.prepare('SELECT translated FROM translations').get().translated, '你好');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_rules').get().n, 0);
});
