'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, SCHEMA_VERSION } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');
const { DuplicateIdError, NotFoundError } = require('../../src/db/errors.js');

function memoryStore() {
  const db = openDatabase(':memory:');
  return createStore(db);
}

function makeSite(store, overrides = {}) {
  return store.sites.create({
    id: 'demo',
    name: 'Demo',
    target_origin: 'https://example.com',
    enabled: 1,
    ...overrides,
  });
}

test('migration 建好 schema 並記下版本', () => {
  const db = openDatabase(':memory:');
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  const tables = db
    .prepare("select name from sqlite_master where type='table' order by name")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes('sites'));
  assert.ok(tables.includes('scripts'));
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'cascade delete 需要外鍵開著');
});

test('重複執行 migration 不會壞（開第二次同一個檔案）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-db-'));
  const file = path.join(dir, 'lm.db');

  const first = createStore(openDatabase(file));
  makeSite(first);
  first.db.close();

  const second = createStore(openDatabase(file));
  assert.equal(second.sites.list().length, 1);
  assert.equal(second.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  second.db.close();
});

test('site 建立後讀回來，enabled 是 boolean、時間戳是 ISO 字串', () => {
  const store = memoryStore();
  const created = makeSite(store);
  assert.equal(created.id, 'demo');
  assert.equal(created.enabled, true);
  assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(store.sites.get('demo'), created);
});

test('site id 重複 → DuplicateIdError', () => {
  const store = memoryStore();
  makeSite(store);
  assert.throws(() => makeSite(store), DuplicateIdError);
});

test('site 不存在時 get 回 null', () => {
  assert.equal(memoryStore().sites.get('nope'), null);
});

test('site list 依 created_at 再依 id 排序', () => {
  const store = memoryStore();
  makeSite(store, { id: 'b' });
  makeSite(store, { id: 'a' });
  const ids = store.sites.list().map((site) => site.id);
  assert.deepEqual(ids.slice().sort(), ids, `實際順序 ${ids.join(',')}`);
});

test('site 更新只改傳進來的欄位，並更新 updated_at', async () => {
  const store = memoryStore();
  const created = makeSite(store);
  await new Promise((resolve) => setTimeout(resolve, 2));

  const updated = store.sites.update('demo', { name: '新名字', enabled: 0 });
  assert.equal(updated.name, '新名字');
  assert.equal(updated.enabled, false);
  assert.equal(updated.target_origin, created.target_origin, '沒傳的欄位不該被動到');
  assert.equal(updated.created_at, created.created_at);
  assert.notEqual(updated.updated_at, created.updated_at);
});

test('site 更新不存在的 id → NotFoundError', () => {
  assert.throws(() => memoryStore().sites.update('nope', { name: 'x' }), NotFoundError);
});

test('site 刪除回報有沒有刪到', () => {
  const store = memoryStore();
  makeSite(store);
  assert.equal(store.sites.remove('demo'), true);
  assert.equal(store.sites.remove('demo'), false);
  assert.equal(store.sites.get('demo'), null);
});

test('script 建立：套用預設值並產生 id', () => {
  const store = memoryStore();
  makeSite(store);
  const script = store.scripts.create('demo', { name: '改標題', code: 'x' });

  assert.match(script.id, /^scr_[0-9a-f]{16}$/);
  assert.equal(script.site_id, 'demo');
  assert.equal(script.enabled, true);
  assert.equal(script.match_glob, '*');
  assert.equal(script.run_at, 'body-end');
  assert.equal(script.order_index, 0);
  assert.deepEqual(store.scripts.get(script.id), script);
});

test('script 建立：site 不存在 → NotFoundError', () => {
  const store = memoryStore();
  assert.throws(() => store.scripts.create('nope', { name: 'a', code: 'x' }), NotFoundError);
});

test('script 列表依 order_index 再依 created_at 排序', () => {
  const store = memoryStore();
  makeSite(store);
  const third = store.scripts.create('demo', { name: 'c', code: 'x', order_index: 5 });
  const first = store.scripts.create('demo', { name: 'a', code: 'x', order_index: -1 });
  const second = store.scripts.create('demo', { name: 'b', code: 'x', order_index: 0 });

  assert.deepEqual(
    store.scripts.listBySite('demo').map((script) => script.id),
    [first.id, second.id, third.id],
  );
});

test('listActiveForSite 只回啟用的', () => {
  const store = memoryStore();
  makeSite(store);
  const on = store.scripts.create('demo', { name: 'on', code: 'x' });
  store.scripts.create('demo', { name: 'off', code: 'x', enabled: 0 });

  assert.deepEqual(
    store.scripts.listActiveForSite('demo').map((script) => script.id),
    [on.id],
  );
});

test('script 更新與刪除', () => {
  const store = memoryStore();
  makeSite(store);
  const script = store.scripts.create('demo', { name: 'a', code: 'x' });

  const updated = store.scripts.update(script.id, { code: 'y', run_at: 'head-end' });
  assert.equal(updated.code, 'y');
  assert.equal(updated.run_at, 'head-end');
  assert.equal(updated.name, 'a');

  assert.equal(store.scripts.remove(script.id), true);
  assert.equal(store.scripts.remove(script.id), false);
  assert.equal(store.scripts.get(script.id), null);
});

test('刪掉 site 會連帶刪掉它的 scripts（ON DELETE CASCADE）', () => {
  const store = memoryStore();
  makeSite(store);
  const script = store.scripts.create('demo', { name: 'a', code: 'x' });

  store.sites.remove('demo');
  assert.equal(store.scripts.get(script.id), null);
  assert.deepEqual(store.scripts.listBySite('demo'), []);
});

test('scripts 的 run_at 有 DB 層的檢查（擋掉亂寫）', () => {
  const store = memoryStore();
  makeSite(store);
  assert.throws(() => store.scripts.create('demo', { name: 'a', code: 'x', run_at: 'nonsense' }));
});

test('回傳的物件是新的，改它不會影響 DB', () => {
  const store = memoryStore();
  const site = makeSite(store);
  site.name = '被亂改';
  assert.equal(store.sites.get('demo').name, 'Demo');
});
