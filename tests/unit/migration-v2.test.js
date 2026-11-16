'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate, MIGRATIONS, SCHEMA_VERSION } = require('../../src/db/migrations.js');
const { openDatabase } = require('../../src/db/index.js');

/** 一個「只跑過 v1」的資料庫，用來模擬升級前的機器 */
function v1Database(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());

  db.pragma('foreign_keys = ON');
  MIGRATIONS[0].up(db);
  db.pragma('user_version = 1');

  return db;
}

function seedV1(db) {
  const now = '2026-11-01T00:00:00.000Z';

  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run('shopee', '蝦皮', 'https://shopee.tw', now, now);

  db.prepare(
    `INSERT INTO sites (id, name, target_origin, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run('example', 'Example', 'https://www.example.com', now, now);

  const insertScript = db.prepare(
    `INSERT INTO scripts
       (id, site_id, name, code, enabled, match_glob, run_at, order_index, created_at, updated_at)
     VALUES (@id, @site_id, @name, @code, @enabled, @match_glob, @run_at, @order_index, @created_at, @updated_at)`,
  );

  insertScript.run({
    id: 'scr_aaaaaaaaaaaaaaaa',
    site_id: 'shopee',
    name: '去廣告',
    code: "document.querySelector('.ad')?.remove();",
    enabled: 1,
    match_glob: '/shop/**',
    run_at: 'head-end',
    order_index: 5,
    created_at: now,
    updated_at: now,
  });

  insertScript.run({
    id: 'scr_bbbbbbbbbbbbbbbb',
    site_id: 'example',
    name: '換標題',
    code: "document.title = '換掉了';",
    enabled: 0,
    match_glob: '*',
    run_at: 'body-end',
    order_index: 0,
    created_at: now,
    updated_at: now,
  });

  return { now };
}

test('全新的資料庫會跑到最新版，而且 v2 的表都在', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 2, 'v2 要往上加一版，不是改舊的');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

  for (const expected of ['sites', 'scripts', 'script_sites', 'assets']) {
    assert.ok(tables.includes(expected), `少了 ${expected} 表：${tables.join(', ')}`);
  }
  assert.equal(tables.includes('scripts_v1'), false, '過渡用的舊表要清掉');
});

test('v2 的 scripts 表有 source / metadata，而且沒有 site_id 了', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const columns = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('scripts')
    .map((row) => row.name);

  for (const expected of [
    'id',
    'name',
    'version',
    'description',
    'source',
    'metadata',
    'run_at',
    'enabled',
    'order_index',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(expected), `scripts 少了 ${expected}：${columns.join(', ')}`);
  }

  assert.equal(columns.includes('site_id'), false, '一對多的外鍵要拿掉（改成 script_sites）');
});

test('sites 多了 auto_created 與 from_pattern', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const columns = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('sites')
    .map((row) => row.name);

  assert.ok(columns.includes('auto_created'));
  assert.ok(columns.includes('from_pattern'));
});

test('舊資料庫升級：腳本原文、名稱、啟用狀態、順序、時間都還在', (t) => {
  const db = v1Database(t);
  const { now } = seedV1(db);

  migrate(db);

  const first = db.prepare('SELECT * FROM scripts WHERE id = ?').get('scr_aaaaaaaaaaaaaaaa');
  assert.ok(first, '舊腳本不該在升級後消失');
  assert.equal(first.name, '去廣告');
  assert.equal(first.source, "document.querySelector('.ad')?.remove();");
  assert.equal(first.enabled, 1);
  assert.equal(first.order_index, 5);
  assert.equal(first.created_at, now);

  const second = db.prepare('SELECT * FROM scripts WHERE id = ?').get('scr_bbbbbbbbbbbbbbbb');
  assert.equal(second.source, "document.title = '換掉了';");
  assert.equal(second.enabled, 0, '停用狀態要跟著搬過來');
});

test('舊資料庫升級：match_glob 變成 script_sites 的綁定', (t) => {
  const db = v1Database(t);
  seedV1(db);

  migrate(db);

  const bindings = db
    .prepare('SELECT * FROM script_sites ORDER BY script_id')
    .all();

  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings[0], {
    script_id: 'scr_aaaaaaaaaaaaaaaa',
    site_id: 'shopee',
    path_glob: '/shop/**',
    exclude_glob: null,
  });
  assert.equal(bindings[1].site_id, 'example');
  assert.equal(bindings[1].path_glob, '*');
});

test('舊資料庫升級：head-end → document-start、body-end → document-end', (t) => {
  const db = v1Database(t);
  seedV1(db);

  migrate(db);

  const rows = db.prepare('SELECT id, run_at FROM scripts ORDER BY id').all();
  assert.deepEqual(rows, [
    { id: 'scr_aaaaaaaaaaaaaaaa', run_at: 'document-start' },
    { id: 'scr_bbbbbbbbbbbbbbbb', run_at: 'document-end' },
  ]);
});

test('舊資料庫升級：sites 原樣保留，auto_created 預設 0', (t) => {
  const db = v1Database(t);
  seedV1(db);

  migrate(db);

  const sites = db.prepare('SELECT * FROM sites ORDER BY id').all();
  assert.equal(sites.length, 2);
  assert.equal(sites[0].id, 'example');
  assert.equal(sites[0].enabled, 0);
  assert.equal(sites[0].auto_created, 0);
  assert.equal(sites[0].from_pattern, null);
  assert.equal(sites[1].target_origin, 'https://shopee.tw');
});

test('舊資料庫升級：metadata 是合法 JSON（標成 legacy，下次存檔才會重新解析）', (t) => {
  const db = v1Database(t);
  seedV1(db);

  migrate(db);

  const row = db.prepare('SELECT metadata FROM scripts WHERE id = ?').get('scr_aaaaaaaaaaaaaaaa');
  const metadata = JSON.parse(row.metadata);

  assert.equal(metadata.legacy, true);
  assert.equal(metadata.needsShim, false);
  assert.deepEqual(metadata.grants, []);
});

test('升級後 user_version 到位，重複跑 migrate 不會再動資料', (t) => {
  const db = v1Database(t);
  seedV1(db);

  assert.equal(migrate(db), SCHEMA_VERSION);

  db.prepare('UPDATE scripts SET name = ? WHERE id = ?').run('改過的名字', 'scr_aaaaaaaaaaaaaaaa');
  assert.equal(migrate(db), SCHEMA_VERSION);

  const row = db.prepare('SELECT name FROM scripts WHERE id = ?').get('scr_aaaaaaaaaaaaaaaa');
  assert.equal(row.name, '改過的名字', 'migrate 又跑了一次就把資料蓋回去 = 不是單向 migration');
});

test('升級後外鍵還是活的：刪掉 site 會連帶刪掉 script_sites', (t) => {
  const db = v1Database(t);
  seedV1(db);
  migrate(db);

  db.prepare('DELETE FROM sites WHERE id = ?').run('shopee');

  const bindings = db.prepare('SELECT * FROM script_sites WHERE site_id = ?').all('shopee');
  assert.deepEqual(bindings, []);
});

test('升級後孤兒綁定不會存在（script_sites 的 script_id 也有外鍵）', (t) => {
  const db = v1Database(t);
  seedV1(db);
  migrate(db);

  assert.throws(
    () =>
      db
        .prepare('INSERT INTO script_sites (script_id, site_id, path_glob) VALUES (?, ?, ?)')
        .run('scr_ghost', 'shopee', '*'),
    /FOREIGN KEY/i,
  );
});

test('v1 的孤兒腳本（site 不存在）不會讓整個升級失敗', (t) => {
  const db = v1Database(t);
  seedV1(db);

  // 繞過外鍵塞一筆孤兒，模擬「資料庫被手動改過」的機器
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO scripts
       (id, site_id, name, code, enabled, match_glob, run_at, order_index, created_at, updated_at)
     VALUES ('scr_orphan', 'gone', '孤兒', 'x', 1, '*', 'body-end', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  ).run();
  db.pragma('foreign_keys = ON');

  assert.doesNotThrow(() => migrate(db));

  const orphan = db.prepare('SELECT * FROM scripts WHERE id = ?').get('scr_orphan');
  assert.ok(orphan, '程式碼要保住（只是沒有綁定）');
  assert.deepEqual(db.prepare('SELECT * FROM script_sites WHERE script_id = ?').all('scr_orphan'), []);
});

test('assets 表是內容定址的（sha256 當 PK）', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const columns = db
    .prepare('SELECT name, pk FROM pragma_table_info(?)')
    .all('assets')
    .reduce((acc, row) => ({ ...acc, [row.name]: row.pk }), {});

  assert.equal(columns.sha256, 1, 'sha256 要是 primary key');
  for (const expected of ['url', 'content', 'content_type', 'bytes', 'fetched_at']) {
    assert.ok(expected in columns, `assets 少了 ${expected}`);
  }
});

test('run_at 的 CHECK 收 document-* 三值，也收 v1 的兩個相容值，但擋掉亂寫', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());

  const insert = db.prepare(
    `INSERT INTO scripts (id, name, source, metadata, run_at, created_at, updated_at)
     VALUES (?, 'n', 's', '{}', ?, '2026-01-01', '2026-01-01')`,
  );

  for (const runAt of ['document-start', 'document-end', 'document-idle', 'head-end', 'body-end']) {
    assert.doesNotThrow(() => insert.run(`scr_${runAt}`, runAt), runAt);
  }
  assert.throws(() => insert.run('scr_bad', 'nonsense'), /CHECK/i);
});
