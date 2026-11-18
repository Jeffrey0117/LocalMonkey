'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate, MIGRATIONS, SCHEMA_VERSION } = require('../../src/db/migrations.js');
const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');

/**
 * v8：重繪模式（SPEC-reskin）。
 *
 * ⛔ 跟 v6 / v7 最大的差別：**這一版不重建任何表**。那兩版重建了整張
 * `site_rules`，因為它們加了新的 `kind` 而 `CHECK` 不能 ALTER（地雷 58）。
 * 重繪不是一種規則 —— 它是第三種模式，設定掛在 `sites` 上，所以只有
 * `ADD COLUMN` 與 `CREATE TABLE`。「既有規則在搬家時掉了」那個風險一個都沒有，
 * 但還是要逐欄位對帳一次：**既有的站不准因為這一版掉掉任何設定**。
 */

function upTo(version) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
    migration.up(db);
    db.pragma(`user_version = ${migration.version}`);
  }
  return db;
}

function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).reduce(
    (acc, column) => ({ ...acc, [column.name]: column }),
    {},
  );
}

/**
 * ⛔ 這條故意釘**當下**的版本號（而不是跟著 SCHEMA_VERSION 浮動）：加 migration
 * 的時候要被迫回來看一眼，確認自己是「加新版本」而不是「改舊的那一版」。
 * 加了 v9 就把這個釘子搬到 migration-v9.test.js，並把這條改成只釘 v8 自己。
 */
test('schema 版本是 8', () => {
  const db = new Database(':memory:');
  assert.equal(migrate(db), 8);
  assert.equal(SCHEMA_VERSION, 8);
});

test('sites 多出四個 reskin 欄位，開關預設關', () => {
  const db = upTo(8);
  const columns = columnsOf(db, 'sites');

  for (const name of ['reskin_enabled', 'reskin_theme', 'reskin_config', 'reskin_pricing']) {
    assert.ok(columns[name], `少了 ${name}`);
  }

  // 規格 §6：「開關（預設關）」
  assert.equal(columns.reskin_enabled.notnull, 1);
  assert.equal(columns.reskin_enabled.dflt_value, '0');

  // NULL ＝「用預設版型 / 用預設價格」，語意同 translate_model
  assert.equal(columns.reskin_theme.notnull, 0);
  assert.equal(columns.reskin_config.notnull, 0);
  assert.equal(columns.reskin_pricing.notnull, 0);
});

test('reskin_enabled 的 CHECK 只收 0/1', () => {
  const db = upTo(8);
  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('s', 's', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();

  assert.throws(() => db.prepare("UPDATE sites SET reskin_enabled = 2 WHERE id = 's'").run());
});

/**
 * ⛔ 抽取設定**編不過也要存得起來**（同壞規則的紀律，SPEC-rules §4）：
 * 退回 400 的話使用者只會看到一個錯誤，沒有上下文可以改。所以這兩個欄位
 * 刻意沒有任何 CHECK。
 */
test('reskin_config 收得下編不過的 JSON', () => {
  const db = upTo(8);
  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('s', 's', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();

  assert.doesNotThrow(() =>
    db.prepare("UPDATE sites SET reskin_config = '{ 這不是 JSON' WHERE id = 's'").run(),
  );
});

test('v7 的站升到 v8 之後設定一個都沒掉', () => {
  const db = upTo(7);

  db.prepare(
    `INSERT INTO sites
       (id, name, target_origin, enabled, auto_created, from_pattern,
        translate_enabled, translate_lang, translate_model, glossary, dev_mode,
        created_at, updated_at)
     VALUES
       ('keep', '保留我', 'https://example.test', 1, 0, '*://example.test/*',
        1, 'zh-TW', 'qwen2.5:latest', '["术语"]', 1, 'then', 'then')`,
  ).run();

  db.prepare(
    `INSERT INTO site_rules (id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at)
     VALUES ('r1', 'keep', 'no-translate', '*', NULL, '.box', '樣板文', 1, 3, 'then', 'then')`,
  ).run();

  MIGRATIONS.filter((item) => item.version === 8).forEach((item) => item.up(db));

  const site = db.prepare("SELECT * FROM sites WHERE id = 'keep'").get();
  assert.equal(site.name, '保留我');
  assert.equal(site.translate_enabled, 1);
  assert.equal(site.translate_lang, 'zh-TW');
  assert.equal(site.translate_model, 'qwen2.5:latest');
  assert.equal(site.glossary, '["术语"]');
  assert.equal(site.dev_mode, 1);
  assert.equal(site.from_pattern, '*://example.test/*');
  // 新欄位是關的，不是 NULL
  assert.equal(site.reskin_enabled, 0);
  assert.equal(site.reskin_theme, null);

  const rule = db.prepare("SELECT * FROM site_rules WHERE id = 'r1'").get();
  assert.equal(rule.kind, 'no-translate');
  assert.equal(rule.scope, '.box');
  assert.equal(rule.note, '樣板文');
  assert.equal(rule.order_index, 3);
});

test('reskin_cache 跟著站一起被刪掉（純衍生資料，CASCADE 沒有損失）', () => {
  const store = createStore(openDatabase(':memory:'));

  store.sites.create({ id: 's', name: 's', target_origin: 'https://example.test' });

  const key = store.reskinCache.key({ siteId: 's', path: '/page/1', htmlSha256: 'a'.repeat(64) });
  store.reskinCache.put({
    key,
    siteId: 's',
    path: '/page/1',
    htmlSha256: 'a'.repeat(64),
    kind: 'listing',
    data: { kind: 'listing', items: [{ name: 'x' }] },
  });

  assert.equal(store.reskinCache.count('s'), 1);
  assert.deepEqual(store.reskinCache.get(key).data.items, [{ name: 'x' }]);

  store.sites.remove('s');
  assert.equal(store.reskinCache.count('s'), 0);
});

/**
 * ⛔ key 用長度前綴而不是分隔符：`('a', 'b/c')` 與 `('a/b', 'c')` 用 `/` 串
 * 會撞成同一個 key ＝某一頁拿到另一頁的資料。
 */
test('cache key 不會因為路徑裡有分隔符而撞在一起', () => {
  const store = createStore(openDatabase(':memory:'));

  const left = store.reskinCache.key({ siteId: 'a', path: '/b/c', htmlSha256: 'x' });
  const right = store.reskinCache.key({ siteId: 'a/b', path: '/c', htmlSha256: 'x' });

  assert.notEqual(left, right);
});

test('同一個站的快取有上限，超過就砍最舊的', () => {
  const store = createStore(openDatabase(':memory:'));
  store.sites.create({ id: 's', name: 's', target_origin: 'https://example.test' });

  for (let index = 0; index < 6; index += 1) {
    const path = `/item-${index}`;
    store.reskinCache.put({
      key: store.reskinCache.key({ siteId: 's', path, htmlSha256: 'h' }),
      siteId: 's',
      path,
      htmlSha256: 'h',
      kind: 'product',
      data: { kind: 'product', name: path },
    });
  }

  assert.equal(store.reskinCache.count('s'), 6);
  store.reskinCache.trim('s', 2);
  assert.equal(store.reskinCache.count('s'), 2);
});
