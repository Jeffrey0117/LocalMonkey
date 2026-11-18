'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate, MIGRATIONS, SCHEMA_VERSION } = require('../../src/db/migrations.js');
const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');

/**
 * v6：`css` 規則型別（SPEC-rules §9）＋ per-site 開發模式（§8.2）。
 *
 * ⛔ `site_rules.kind` 的 CHECK 寫在建表語句裡，SQLite 不能 ALTER 掉 ——
 * 只能重建整張表。所以這一版的風險不是「欄位沒加到」，而是**既有的規則在
 * 重建的過程中掉了**。那是靜默的：使用者的站會突然變回沒改造過的樣子。
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

function seedRules(db) {
  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('s', 's', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();

  const insert = db.prepare(
    `INSERT INTO site_rules
       (id, site_id, kind, pattern, replacement, scope, note, enabled, order_index, created_at, updated_at)
     VALUES (@id, 's', @kind, @pattern, @replacement, @scope, @note, @enabled, @order_index, 'now', 'now')`,
  );

  insert.run({
    id: 'r1',
    kind: 'hide',
    pattern: '.tm-menu',
    replacement: null,
    scope: null,
    note: '藏選單',
    enabled: 1,
    order_index: 0,
  });
  insert.run({
    id: 'r2',
    kind: 'text-replace',
    pattern: 'templatemo',
    replacement: 'templatee',
    scope: '#footer',
    note: null,
    enabled: 0,
    order_index: 3,
  });
}

test('schema 版本是 6', () => {
  const db = new Database(':memory:');
  assert.equal(migrate(db), 6);
  assert.equal(SCHEMA_VERSION, 6);
});

test('sites 多一個 dev_mode，預設關', () => {
  const store = createStore(openDatabase(':memory:'));
  const site = store.sites.create({ id: 'demo', name: 'demo', target_origin: 'https://x.test' });

  assert.equal(site.dev_mode, false);
  assert.equal(store.sites.update('demo', { dev_mode: true }).dev_mode, true);
  assert.equal(store.sites.update('demo', { dev_mode: false }).dev_mode, false);
});

test('dev_mode 只收 0/1（打錯字要在 DB 層就被擋）', () => {
  const db = upTo(6);
  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('s', 's', 'https://example.test', 1, 0, 'now', 'now')`,
  ).run();

  assert.throws(() => db.prepare("UPDATE sites SET dev_mode = 2 WHERE id = 's'").run(), /CHECK/);
});

test('site_rules 現在收 css（而且四種之外還是擋）', () => {
  const db = upTo(6);
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

  for (const kind of ['hide', 'css', 'text-replace', 'text-rewrite']) insert(kind);
  assert.throws(() => insert('delete-element'), /CHECK/);
});

/**
 * ⛔ 這是這一版唯一真正危險的地方（重建表 ＝ 搬資料）。
 * 每一個欄位都要對 —— 掉了 `enabled` 的 0 會讓停用的規則突然生效，
 * 掉了 `order_index` 會讓規則的套用順序變掉（順序本身就是語意）。
 */
test('⛔ v5 的規則在重建表之後一列不少、每個欄位都對', () => {
  const db = upTo(5);
  seedRules(db);

  assert.equal(migrate(db), 6);

  const rows = db.prepare('SELECT * FROM site_rules ORDER BY order_index').all();
  assert.equal(rows.length, 2);

  assert.deepEqual(
    { ...rows[0], created_at: undefined, updated_at: undefined },
    {
      id: 'r1',
      site_id: 's',
      kind: 'hide',
      pattern: '.tm-menu',
      replacement: null,
      scope: null,
      note: '藏選單',
      enabled: 1,
      order_index: 0,
      created_at: undefined,
      updated_at: undefined,
    },
  );
  assert.deepEqual(
    { ...rows[1], created_at: undefined, updated_at: undefined },
    {
      id: 'r2',
      site_id: 's',
      kind: 'text-replace',
      pattern: 'templatemo',
      replacement: 'templatee',
      scope: '#footer',
      note: null,
      enabled: 0,
      order_index: 3,
      created_at: undefined,
      updated_at: undefined,
    },
  );
});

test('重建完 index 還在（規則是每個請求重讀的，少了 index 就是每次全表掃）', () => {
  const names = upTo(6)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'site_rules'")
    .all()
    .map((row) => row.name);

  assert.ok(names.includes('idx_site_rules_site'), names.join(','));
});

test('重建完舊表沒留下來（不然下一次 migrate 會撞到同名 index）', () => {
  const tables = upTo(6)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

  assert.equal(tables.includes('site_rules_v5'), false, tables.join(','));
});

/**
 * ⛔ 地雷 11 的同一類風險：重建表時外鍵的 CASCADE 可能把剛搬好的資料帶走。
 * `site_rules` 沒有任何表反過來指著它，但這條釘住「CASCADE 還活著」。
 */
test('重建完 CASCADE 還在（刪站要連帶刪規則）', () => {
  const store = createStore(openDatabase(':memory:'));
  store.sites.create({ id: 'demo', name: 'demo', target_origin: 'https://x.test' });
  store.siteRules.create('demo', { kind: 'css', pattern: '.a{margin:0}' });

  assert.equal(store.siteRules.listBySite('demo').length, 1);
  store.sites.remove('demo');
  assert.equal(store.siteRules.listBySite('demo').length, 0);
});
