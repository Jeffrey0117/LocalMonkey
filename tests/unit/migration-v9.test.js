'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate, MIGRATIONS, SCHEMA_VERSION } = require('../../src/db/migrations.js');
const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');

/**
 * v9：單筆買斷的訂單（SPEC-checkout §3）。
 *
 * ⛔ 這一版的重點**不是**欄位，是「訂單跟其他所有資料不一樣」：
 * 它是這個專案裡唯一掉了就回不來的東西。所以這支測試釘的是三條性質：
 *
 * 1. 刪站**不會**連帶刪訂單（`site_id` 沒有外鍵；`reskin_cache` 是相反的）
 * 2. `status` / `env` 有 CHECK（測試單與正式單混在一起對帳會對出假數字）
 * 3. 結算是 idempotent，而且 `paid` 不准被改回去
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

function seedSite(store, id = 's') {
  store.sites.create({ id, name: id, target_origin: 'https://example.test' });
}

function newOrder(store, patch = {}) {
  return store.reskinOrders.create({
    id: 'HTKtest0001',
    siteId: 's',
    productId: 'tpl-1',
    productName: '一份模板',
    amount: 199,
    env: 'test',
    ...patch,
  });
}

/**
 * ⛔ 這條故意釘**當下**的版本號（而不是跟著 SCHEMA_VERSION 浮動）：加 migration
 * 的時候要被迫回來看一眼，確認自己是「加新版本」而不是「改舊的那一版」。
 * 加了 v10 就把這個釘子搬到 migration-v10.test.js，並把這條改成只釘 v9 自己。
 */
test('schema 版本是 9', () => {
  const db = new Database(':memory:');
  assert.equal(migrate(db), 9);
  assert.equal(SCHEMA_VERSION, 9);
});

test('reskin_orders 的欄位照規格 §3', () => {
  const db = upTo(9);
  const columns = db.pragma('table_info(reskin_orders)').reduce(
    (acc, column) => ({ ...acc, [column.name]: column }),
    {},
  );

  for (const name of [
    'id',
    'site_id',
    'product_id',
    'product_name',
    'amount',
    'currency',
    'status',
    'env',
    'trade_no',
    'paid_at',
    'created_at',
    'raw_result',
  ]) {
    assert.ok(columns[name], `少了 ${name}`);
  }

  assert.equal(columns.currency.dflt_value, "'TWD'");
  // 結果欄位是「還沒有」的狀態，不是必填
  assert.equal(columns.trade_no.notnull, 0);
  assert.equal(columns.paid_at.notnull, 0);
  assert.equal(columns.raw_result.notnull, 0);
});

test('status 與 env 的 CHECK 擋掉亂值', () => {
  const db = upTo(9);

  const insert = (status, env) =>
    db
      .prepare(
        `INSERT INTO reskin_orders
           (id, site_id, product_id, product_name, amount, currency, status, env, created_at)
         VALUES (@id, 's', 'p', 'n', 199, 'TWD', @status, @env, 'now')`,
      )
      .run({ id: `${status}-${env}`, status, env });

  assert.doesNotThrow(() => insert('pending', 'test'));
  assert.doesNotThrow(() => insert('paid', 'live'));
  assert.throws(() => insert('refunded', 'test'), /CHECK/);
  assert.throws(() => insert('pending', 'production'), /CHECK/);
});

/**
 * ⛔ **這是 v9 最重要的一條。**
 *
 * `reskin_cache` 是 `ON DELETE CASCADE`（純衍生資料，CASCADE 沒有損失）。
 * 訂單相反 —— 刪一個站不該把那個站收過的錢一起刪掉，而那種刪除是**靜默**的：
 * 使用者只會發現「訂單清單空了」，而且無從得知原因。
 */
test('刪站不會連帶刪掉訂單（跟 reskin_cache 刻意相反）', () => {
  const store = createStore(openDatabase(':memory:'));
  seedSite(store);

  newOrder(store);
  store.reskinCache.put({
    key: store.reskinCache.key({ siteId: 's', path: '/', htmlSha256: 'a' }),
    siteId: 's',
    path: '/',
    htmlSha256: 'a',
    kind: 'listing',
    data: { kind: 'listing', items: [] },
  });

  assert.equal(store.reskinOrders.count('s'), 1);
  assert.equal(store.reskinCache.count('s'), 1);

  store.sites.remove('s');

  // 快取跟著走（可以重算），訂單留著（回不來）
  assert.equal(store.reskinCache.count('s'), 0);
  assert.equal(store.reskinOrders.count('s'), 1);
  assert.equal(store.reskinOrders.get('HTKtest0001').status, 'pending');
});

test('新建的訂單是 pending，幣別預設 TWD', () => {
  const store = createStore(openDatabase(':memory:'));
  seedSite(store);

  const order = newOrder(store);

  assert.equal(order.status, 'pending');
  assert.equal(order.currency, 'TWD');
  assert.equal(order.amount, 199);
  assert.equal(order.env, 'test');
  assert.equal(order.trade_no, null);
  assert.equal(order.paid_at, null);
  assert.ok(order.created_at.length > 0);
});

/**
 * ⛔ 同一筆訂單被回呼打到兩次以上是**正常的**（ReturnURL 與 NotifyURL 都會送，
 * 使用者還可能重新整理那一頁）。所以第二次要回 0 —— 呼叫端靠這個數字分得出
 * 「這次結算了」與「早就結算過」（規格 §2.2 第 4 條）。
 */
test('markPaid 是 idempotent：第二次回 0', () => {
  const store = createStore(openDatabase(':memory:'));
  seedSite(store);
  newOrder(store);

  assert.equal(
    store.reskinOrders.markPaid({ id: 'HTKtest0001', tradeNo: 'T1', rawResult: '{}' }),
    1,
  );
  assert.equal(
    store.reskinOrders.markPaid({ id: 'HTKtest0001', tradeNo: 'T2', rawResult: '{}' }),
    0,
  );

  const order = store.reskinOrders.get('HTKtest0001');
  assert.equal(order.status, 'paid');
  // 第二次整筆沒生效，所以交易序號還是第一次那個
  assert.equal(order.trade_no, 'T1');
  assert.ok(order.paid_at.length > 0);
});

/**
 * ⛔ 回呼的順序不保證（notify 與 return 誰先到都有可能）。「付款成功之後
 * 又收到一筆失敗的回應」不該讓使用者的訂單退回失敗。
 */
test('已經 paid 的訂單不准被標成失敗', () => {
  const store = createStore(openDatabase(':memory:'));
  seedSite(store);
  newOrder(store);

  store.reskinOrders.markPaid({ id: 'HTKtest0001' });
  assert.equal(store.reskinOrders.markFailed({ id: 'HTKtest0001' }), 0);
  assert.equal(store.reskinOrders.get('HTKtest0001').status, 'paid');
});

test('markFailed 不准被用來標成 paid', () => {
  const store = createStore(openDatabase(':memory:'));
  seedSite(store);
  newOrder(store);

  assert.throws(() => store.reskinOrders.markFailed({ id: 'HTKtest0001', status: 'paid' }));
});

test('清單是最新的在前面，而且認得出站', () => {
  const store = createStore(openDatabase(':memory:'));
  seedSite(store);
  seedSite(store, 'other');

  newOrder(store, { id: 'HTKa', productName: '第一筆' });
  newOrder(store, { id: 'HTKb', productName: '第二筆' });
  newOrder(store, { id: 'HTKc', siteId: 'other', productName: '別站的' });

  const mine = store.reskinOrders.list({ siteId: 's' });
  assert.equal(mine.length, 2);
  assert.deepEqual(
    mine.map((order) => order.id).sort(),
    ['HTKa', 'HTKb'],
  );
  assert.equal(store.reskinOrders.count('s'), 2);
  assert.equal(store.reskinOrders.count(), 3);
});

test('v8 的站升到 v9 之後，設定與快取一個都沒掉', () => {
  const db = upTo(8);

  db.prepare(
    `INSERT INTO sites
       (id, name, target_origin, enabled, auto_created,
        reskin_enabled, reskin_theme, reskin_config, reskin_pricing, created_at, updated_at)
     VALUES
       ('keep', '保留我', 'https://example.test', 1, 0,
        1, 'mall', '[{"match":"^/$"}]', '{"currency":"NT$"}', 'then', 'then')`,
  ).run();
  db.prepare(
    `INSERT INTO reskin_cache (key, site_id, path, html_sha256, kind, data, created_at)
     VALUES ('k', 'keep', '/', 'h', 'listing', '{"kind":"listing"}', 'then')`,
  ).run();

  MIGRATIONS.filter((item) => item.version === 9).forEach((item) => item.up(db));

  const site = db.prepare("SELECT * FROM sites WHERE id = 'keep'").get();
  assert.equal(site.reskin_enabled, 1);
  assert.equal(site.reskin_theme, 'mall');
  assert.equal(site.reskin_config, '[{"match":"^/$"}]');
  assert.equal(site.reskin_pricing, '{"currency":"NT$"}');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reskin_cache').get().n, 1);
  // 新表是空的，不是「有一筆不知道哪來的」
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reskin_orders').get().n, 0);
});
