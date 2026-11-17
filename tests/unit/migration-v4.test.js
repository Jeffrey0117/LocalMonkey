'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate, MIGRATIONS, SCHEMA_VERSION } = require('../../src/db/migrations.js');
const { openDatabase } = require('../../src/db/index.js');

/** v4：伺服器端翻譯層（SPEC-translate §2）。 */

function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).reduce(
    (acc, column) => ({ ...acc, [column.name]: column }),
    {},
  );
}

function tablesOf(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

test('SCHEMA_VERSION 走到 4，而且舊的 migration 一條都沒被改動', () => {
  assert.equal(SCHEMA_VERSION, 4);
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4],
  );
});

test('三張新表都建起來了', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  for (const table of ['translations', 'translate_queue', 'crawl_jobs']) {
    assert.ok(tablesOf(db).includes(table), `少了 ${table}`);
  }
});

test('translations 的欄位照規格 §2', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const columns = columnsOf(db, 'translations');

  assert.equal(columns.hash.pk, 1, 'hash 要是 primary key');
  for (const name of [
    'source_text',
    'target_lang',
    'model',
    'translated',
    'origin',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns[name], `translations 少了 ${name}`);
    assert.equal(columns[name].notnull, 1, `${name} 應該是 NOT NULL`);
  }
});

test('translate_queue 的欄位照規格 §2（site_id 可以是 null，只為了 UI 分組）', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const columns = columnsOf(db, 'translate_queue');

  assert.equal(columns.hash.pk, 1);
  assert.equal(columns.site_id.notnull, 0);
  assert.equal(columns.attempts.notnull, 1);
  assert.equal(columns.attempts.dflt_value, '0');
  assert.equal(columns.last_error.notnull, 0);
});

test('⛔ translate_queue.site_id 刻意不是外鍵（刪掉網站不該連帶砍掉待翻的段）', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  assert.deepEqual(db.pragma('foreign_key_list(translate_queue)'), []);
});

test('crawl_jobs 的欄位照規格 §2，進度欄位預設 0', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const columns = columnsOf(db, 'crawl_jobs');

  assert.equal(columns.id.pk, 1);
  for (const name of ['pages_done', 'pages_found', 'segments_new']) {
    assert.equal(columns[name].dflt_value, '0', `${name} 要預設 0`);
  }
  for (const name of ['site_id', 'status', 'start_path', 'max_pages', 'max_depth']) {
    assert.equal(columns[name].notnull, 1, `${name} 應該是 NOT NULL`);
  }
});

test('sites 多了四個翻譯欄位，而且有規格寫的預設值', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const columns = columnsOf(db, 'sites');

  assert.equal(columns.translate_enabled.dflt_value, '0', '預設不翻');
  assert.equal(columns.translate_lang.dflt_value, "'zh-TW'");
  assert.equal(columns.translate_model.notnull, 0, 'NULL = 用全域預設');
  assert.equal(columns.glossary.notnull, 0);
});

test('origin 只收 machine / manual（CHECK 擋住打錯字）', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const insert = db.prepare(
    `INSERT INTO translations
       (hash, source_text, target_lang, model, translated, origin, created_at, updated_at)
     VALUES (?, ?, 'zh-TW', 'm', '譯', ?, 'now', 'now')`,
  );

  assert.doesNotThrow(() => insert.run('h1', 'a', 'machine'));
  assert.doesNotThrow(() => insert.run('h2', 'b', 'manual'));
  assert.throws(() => insert.run('h3', 'c', 'robot'), /CHECK/);
});

test('crawl_jobs.status 只收規格列的五種', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const insert = db.prepare(
    `INSERT INTO crawl_jobs
       (id, site_id, status, start_path, max_pages, max_depth, created_at, updated_at)
     VALUES (?, 'demo', ?, '/', 50, 3, 'now', 'now')`,
  );

  for (const status of ['running', 'paused', 'done', 'failed', 'cancelled']) {
    assert.doesNotThrow(() => insert.run(`job-${status}`, status), status);
  }
  assert.throws(() => insert.run('job-bad', 'exploded'), /CHECK/);
});

/* ---------------------------- 升級既有資料 ---------------------------- */

/** 一個停在 v3 的資料庫（＝使用者現在那台機器） */
function v3Database(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());

  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS.slice(0, 3)) migration.up(db);
  db.pragma('user_version = 3');

  return db;
}

test('⛔ 從 v3 升上來：既有的網站與腳本原封不動，翻譯欄位拿到預設值', (t) => {
  const db = v3Database(t);
  const now = '2026-11-01T00:00:00.000Z';

  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, auto_created, created_at, updated_at)
     VALUES ('templatemo-com', 'templatemo', 'https://templatemo.com', 1, 1, ?, ?)`,
  ).run(now, now);

  db.prepare(
    `INSERT INTO scripts (id, name, source, metadata, created_at, updated_at, delivery_token)
     VALUES ('scr_x', '我的腳本', 'alert(1)', '{}', ?, ?, 'tok')`,
  ).run(now, now);

  assert.equal(migrate(db), 4);

  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get('templatemo-com');
  assert.equal(site.name, 'templatemo');
  assert.equal(site.target_origin, 'https://templatemo.com');
  assert.equal(site.translate_enabled, 0);
  assert.equal(site.translate_lang, 'zh-TW');
  assert.equal(site.translate_model, null);
  assert.equal(site.glossary, null);

  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get('scr_x');
  assert.equal(script.source, 'alert(1)');
  assert.equal(script.delivery_token, 'tok', '投遞 token 不准被動到（裝置還靠它更新）');
});

test('重複跑 migrate 不會出事，也不會清掉翻譯快取', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  db.prepare(
    `INSERT INTO translations
       (hash, source_text, target_lang, model, translated, origin, created_at, updated_at)
     VALUES ('h', 'Contact', 'zh-TW', 'qwen2.5:latest', '聯絡我們', 'manual', 'now', 'now')`,
  ).run();

  assert.equal(migrate(db), 4);
  assert.equal(migrate(db), 4);

  const row = db.prepare('SELECT * FROM translations WHERE hash = ?').get('h');
  assert.equal(row.translated, '聯絡我們');
  assert.equal(row.origin, 'manual');
});
