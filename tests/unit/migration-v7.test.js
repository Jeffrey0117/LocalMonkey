'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate, MIGRATIONS, SCHEMA_VERSION } = require('../../src/db/migrations.js');
const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');

/**
 * v7：`no-translate` 規則型別（SPEC-rules §12）。
 *
 * ⛔ 跟 v6 同一個風險：`site_rules.kind` 的 CHECK 寫在建表語句裡，SQLite 不能
 * ALTER 掉 —— 只能**重建整張表**。這一版欄位一個都沒變，所以唯一的危險是
 * **既有的規則在重建的過程中掉了**。那是靜默的：使用者的站會突然變回沒改造過
 * 的樣子，而且沒有任何錯誤訊息。
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

function seedSite(db) {
  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('s', 's', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();
}

/**
 * ⛔ 這條故意釘**當下**的版本號（而不是跟著 SCHEMA_VERSION 浮動）：加 migration
 * 的時候要被迫回來看一眼，確認自己是「加新版本」而不是「改舊的那一版」。
 * 加了 v8 就把這個釘子搬到 migration-v8.test.js。
 */
test('schema 版本是 7', () => {
  const db = new Database(':memory:');
  assert.equal(migrate(db), 7);
  assert.equal(SCHEMA_VERSION, 7);
});

test('site_rules 現在收 no-translate（而且五種之外還是擋）', () => {
  const db = upTo(7);
  seedSite(db);

  const insert = (kind) =>
    db
      .prepare(
        `INSERT INTO site_rules (id, site_id, kind, pattern, enabled, order_index, created_at, updated_at)
         VALUES (@id, 's', @kind, 'x', 1, 0, 'now', 'now')`,
      )
      .run({ id: `r-${kind}`, kind });

  for (const kind of ['hide', 'css', 'text-replace', 'text-rewrite', 'no-translate']) insert(kind);
  assert.throws(() => insert('dont-translate'), /CHECK/);
});

/** v6 的 CHECK 還沒有這個型別 —— 釘住「v7 真的有做事」 */
test('v6 的時候 no-translate 還是被擋的', () => {
  const db = upTo(6);
  seedSite(db);

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO site_rules (id, site_id, kind, pattern, enabled, order_index, created_at, updated_at)
           VALUES ('r', 's', 'no-translate', 'x', 1, 0, 'now', 'now')`,
        )
        .run(),
    /CHECK/,
  );
});

/**
 * ⛔ 重建表 ＝ 搬資料，而這是這一版唯一真正危險的地方。
 * 掉了 `enabled` 的 0 會讓停用的規則突然生效，掉了 `order_index` 會讓套用順序
 * 變掉（順序本身就是語意 —— 後面的 CSS 覆蓋前面的）。
 */
test('⛔ v6 的規則在重建表之後一列不少、每個欄位都對', () => {
  const db = upTo(6);
  seedSite(db);

  const insert = db.prepare(
    `INSERT INTO site_rules
       (id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at)
     VALUES (@id, 's', @kind, @pattern, @replacement, @scope, @note, @enabled, @order_index, 'now', 'now')`,
  );

  insert.run({
    id: 'r1',
    kind: 'css',
    pattern: '.a {\n  margin: 0;\n}',
    replacement: null,
    scope: null,
    note: 'logo 字樣',
    enabled: 1,
    order_index: 0,
  });
  insert.run({
    id: 'r2',
    kind: 'text-rewrite',
    pattern: '^(\\d{2,4})\\s+(.+)$',
    replacement: '$2[$1]',
    scope: '.thumbnail_270 h2',
    note: null,
    enabled: 0,
    order_index: 5,
  });

  assert.equal(migrate(db), SCHEMA_VERSION);

  const rows = db
    .prepare('SELECT * FROM site_rules ORDER BY order_index')
    .all()
    .map((row) => ({ ...row, created_at: undefined, updated_at: undefined }));

  assert.deepEqual(rows, [
    {
      id: 'r1',
      site_id: 's',
      kind: 'css',
      pattern: '.a {\n  margin: 0;\n}',
      replacement: null,
      scope: null,
      note: 'logo 字樣',
      enabled: 1,
      order_index: 0,
      created_at: undefined,
      updated_at: undefined,
    },
    {
      id: 'r2',
      site_id: 's',
      kind: 'text-rewrite',
      pattern: '^(\\d{2,4})\\s+(.+)$',
      replacement: '$2[$1]',
      scope: '.thumbnail_270 h2',
      note: null,
      enabled: 0,
      order_index: 5,
      created_at: undefined,
      updated_at: undefined,
    },
  ]);
});

test('重建完 index 還在（規則是每個請求重讀的，少了 index 就是每次全表掃）', () => {
  const names = upTo(7)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'site_rules'")
    .all()
    .map((row) => row.name);

  assert.ok(names.includes('idx_site_rules_site'), names.join(','));
});

test('重建完舊表沒留下來（不然下一次 migrate 會撞到同名 index）', () => {
  const tables = upTo(7)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

  assert.equal(tables.includes('site_rules_v6'), false, tables.join(','));
});

test('重建完 CASCADE 還在（刪站要連帶刪規則）', () => {
  const store = createStore(openDatabase(':memory:'));
  store.sites.create({ id: 'demo', name: 'demo', target_origin: 'https://x.test' });
  store.siteRules.create('demo', { kind: 'no-translate', pattern: 'is 100% free' });

  assert.equal(store.siteRules.listBySite('demo').length, 1);
  store.sites.remove('demo');
  assert.equal(store.siteRules.listBySite('demo').length, 0);
});

test('store 層存得起來、讀回來還是 no-translate（含 scope）', () => {
  const store = createStore(openDatabase(':memory:'));
  store.sites.create({ id: 'demo', name: 'demo', target_origin: 'https://x.test' });

  const created = store.siteRules.create('demo', {
    kind: 'no-translate',
    pattern: '*',
    scope: '.ad',
    note: '廣告區不翻',
  });

  assert.equal(created.kind, 'no-translate');
  assert.equal(created.scope, '.ad');
  assert.equal(store.siteRules.listBySite('demo')[0].pattern, '*');
});
