'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../src/db/index.js');
const { createStore } = require('../../src/db/store.js');
const { NotFoundError } = require('../../src/db/errors.js');

function memoryStore(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return createStore(db);
}

function makeSites(store) {
  store.sites.create({ id: 'a-test', name: 'A', target_origin: 'https://a.test' });
  store.sites.create({ id: 'b-test', name: 'B', target_origin: 'https://b.test' });
}

const SOURCE = [
  '// ==UserScript==',
  '// @name 兩邊通用',
  '// @match https://a.test/*',
  '// @match https://b.test/*',
  '// ==/UserScript==',
  "console.log('v1');",
].join('\n');

function createScript(store, overrides = {}) {
  return store.userscripts.create({
    name: '兩邊通用',
    version: '1.0',
    description: '說明',
    source: SOURCE,
    metadata: { needsShim: false, grants: [], targets: [] },
    run_at: 'document-start',
    ...overrides,
  });
}

test('userscripts 建立 + 讀回：metadata 是物件、enabled 是布林', (t) => {
  const store = memoryStore(t);
  const script = createScript(store);

  assert.match(script.id, /^scr_[0-9a-f]{16}$/);
  assert.equal(script.name, '兩邊通用');
  assert.equal(script.version, '1.0');
  assert.equal(script.source, SOURCE);
  assert.equal(script.run_at, 'document-start');
  assert.equal(script.enabled, true);
  assert.equal(script.order_index, 0);
  assert.deepEqual(script.metadata, { needsShim: false, grants: [], targets: [] });
  assert.deepEqual(script.sites, []);

  const loaded = store.userscripts.get(script.id);
  assert.deepEqual(loaded, script);
});

test('userscripts.get 不存在 → null', (t) => {
  const store = memoryStore(t);
  assert.equal(store.userscripts.get('scr_nope'), null);
});

test('metadata 欄位被寫成壞 JSON 也不會讓讀取爆掉（代理不能因為這個掛掉）', (t) => {
  const store = memoryStore(t);
  const script = createScript(store);

  store.db.prepare('UPDATE scripts SET metadata = ? WHERE id = ?').run('{壞掉的', script.id);

  const loaded = store.userscripts.get(script.id);
  assert.equal(typeof loaded.metadata, 'object');
  assert.deepEqual(loaded.metadata.grants, []);
  assert.equal(loaded.metadata.needsShim, false);
});

test('setBindings：寫入綁定、exclude 存成陣列、重複的綁定會收斂', (t) => {
  const store = memoryStore(t);
  makeSites(store);
  const script = createScript(store);

  store.userscripts.setBindings(script.id, [
    { site_id: 'a-test', path_glob: '*', exclude_globs: ['/admin/**', '/login'] },
    { site_id: 'b-test', path_glob: '/items/**' },
    { site_id: 'b-test', path_glob: '/items/**' },
  ]);

  const loaded = store.userscripts.get(script.id);
  assert.equal(loaded.sites.length, 2);

  const [first, second] = loaded.sites;
  assert.equal(first.site_id, 'a-test');
  assert.deepEqual(first.exclude_globs, ['/admin/**', '/login']);
  assert.equal(second.site_id, 'b-test');
  assert.deepEqual(second.exclude_globs, []);
});

test('setBindings 是「整批換掉」，不是累加', (t) => {
  const store = memoryStore(t);
  makeSites(store);
  const script = createScript(store);

  store.userscripts.setBindings(script.id, [
    { site_id: 'a-test', path_glob: '*' },
    { site_id: 'b-test', path_glob: '*' },
  ]);
  store.userscripts.setBindings(script.id, [{ site_id: 'b-test', path_glob: '/only/**' }]);

  const loaded = store.userscripts.get(script.id);
  assert.deepEqual(
    loaded.sites.map((binding) => [binding.site_id, binding.path_glob]),
    [['b-test', '/only/**']],
  );
});

test('setBindings 指到不存在的網站 → 丟錯（不要留下壞資料）', (t) => {
  const store = memoryStore(t);
  const script = createScript(store);

  assert.throws(() => store.userscripts.setBindings(script.id, [{ site_id: 'ghost', path_glob: '*' }]));
  assert.deepEqual(store.userscripts.get(script.id).sites, []);
});

test('setBindings 指到不存在的腳本 → NotFoundError', (t) => {
  const store = memoryStore(t);
  makeSites(store);

  assert.throws(
    () => store.userscripts.setBindings('scr_ghost', [{ site_id: 'a-test', path_glob: '*' }]),
    NotFoundError,
  );
});

test('⭐ 一支腳本兩個網站：改一次 source，兩邊讀到的都是新版', (t) => {
  const store = memoryStore(t);
  makeSites(store);
  const script = createScript(store);
  store.userscripts.setBindings(script.id, [
    { site_id: 'a-test', path_glob: '*' },
    { site_id: 'b-test', path_glob: '*' },
  ]);

  store.userscripts.update(script.id, { source: "console.log('v2');" });

  for (const siteId of ['a-test', 'b-test']) {
    const injected = store.userscripts.listForInjection(siteId);
    assert.equal(injected.length, 1, siteId);
    assert.equal(injected[0].id, script.id);
    assert.equal(store.userscripts.get(injected[0].id).source, "console.log('v2');");
  }
});

test('listForInjection：只回啟用的，照 order_index 排序，一個綁定一列', (t) => {
  const store = memoryStore(t);
  makeSites(store);

  const late = createScript(store, { name: '後面', order_index: 10 });
  const early = createScript(store, { name: '前面', order_index: 1 });
  const off = createScript(store, { name: '關掉的', enabled: 0 });

  store.userscripts.setBindings(late.id, [{ site_id: 'a-test', path_glob: '*' }]);
  store.userscripts.setBindings(early.id, [
    { site_id: 'a-test', path_glob: '/x/**' },
    { site_id: 'a-test', path_glob: '/y/**' },
  ]);
  store.userscripts.setBindings(off.id, [{ site_id: 'a-test', path_glob: '*' }]);

  const rows = store.userscripts.listForInjection('a-test');

  assert.deepEqual(
    rows.map((row) => [row.name, row.path_glob]),
    [
      ['前面', '/x/**'],
      ['前面', '/y/**'],
      ['後面', '*'],
    ],
  );
  assert.equal(rows.every((row) => typeof row.metadata === 'object'), true);
});

test('list：不帶 source（列表要輕），但帶得出掛在哪些網站', (t) => {
  const store = memoryStore(t);
  makeSites(store);
  const script = createScript(store);
  store.userscripts.setBindings(script.id, [{ site_id: 'a-test', path_glob: '*' }]);

  const [row] = store.userscripts.list();

  assert.equal('source' in row, false);
  assert.equal(row.name, '兩邊通用');
  assert.deepEqual(row.site_ids, ['a-test']);
});

test('update：只動傳進來的欄位，updated_at 會往前走', (t) => {
  const store = memoryStore(t);
  const script = createScript(store);

  const updated = store.userscripts.update(script.id, { enabled: 0, order_index: 7 });

  assert.equal(updated.enabled, false);
  assert.equal(updated.order_index, 7);
  assert.equal(updated.name, '兩邊通用', '沒傳的欄位不要被清掉');
  assert.equal(updated.source, SOURCE);
  assert.ok(updated.updated_at >= script.updated_at);
});

test('update：metadata 可以整包換掉', (t) => {
  const store = memoryStore(t);
  const script = createScript(store);

  const updated = store.userscripts.update(script.id, {
    metadata: { needsShim: true, grants: ['GM_setValue'] },
  });

  assert.deepEqual(updated.metadata.grants, ['GM_setValue']);
  assert.equal(updated.metadata.needsShim, true);
});

test('update：不存在 → NotFoundError；沒有可更新欄位 → 丟錯', (t) => {
  const store = memoryStore(t);
  const script = createScript(store);

  assert.throws(() => store.userscripts.update('scr_ghost', { enabled: 0 }), NotFoundError);
  assert.throws(() => store.userscripts.update(script.id, {}));
});

test('remove：腳本與它的綁定一起消失', (t) => {
  const store = memoryStore(t);
  makeSites(store);
  const script = createScript(store);
  store.userscripts.setBindings(script.id, [{ site_id: 'a-test', path_glob: '*' }]);

  assert.equal(store.userscripts.remove(script.id), true);
  assert.equal(store.userscripts.remove(script.id), false);
  assert.equal(store.userscripts.get(script.id), null);
  assert.deepEqual(store.userscripts.listForInjection('a-test'), []);
});

test('刪掉網站：只掛在它身上的腳本跟著走，還掛在別處的留下來', (t) => {
  const store = memoryStore(t);
  makeSites(store);

  const onlyA = createScript(store, { name: '只在 A' });
  const both = createScript(store, { name: '兩邊都在' });
  const unbound = createScript(store, { name: '還沒掛上去的' });

  store.userscripts.setBindings(onlyA.id, [{ site_id: 'a-test', path_glob: '*' }]);
  store.userscripts.setBindings(both.id, [
    { site_id: 'a-test', path_glob: '*' },
    { site_id: 'b-test', path_glob: '*' },
  ]);

  store.sites.remove('a-test');

  assert.equal(store.userscripts.get(onlyA.id), null, 'v1 的語意：只掛這個站就一起刪');
  assert.ok(store.userscripts.get(both.id), '還掛在 B 的不准刪');
  assert.deepEqual(store.userscripts.get(both.id).sites.map((b) => b.site_id), ['b-test']);
  assert.ok(
    store.userscripts.get(unbound.id),
    '跟這個站無關、本來就沒綁定的腳本不准被牽連（那是使用者還沒寫好 @match 的腳本）',
  );
});

test('sites.listWithScripts：網站分頁要顯示「掛了哪些腳本」', (t) => {
  const store = memoryStore(t);
  makeSites(store);
  const script = createScript(store, { name: '掛在 A' });
  store.userscripts.setBindings(script.id, [{ site_id: 'a-test', path_glob: '/x/**' }]);

  const sites = store.sites.listWithScripts();
  const siteA = sites.find((site) => site.id === 'a-test');
  const siteB = sites.find((site) => site.id === 'b-test');

  assert.deepEqual(
    siteA.scripts.map((entry) => entry.name),
    ['掛在 A'],
  );
  assert.equal(siteA.scripts[0].enabled, true);
  assert.deepEqual(siteB.scripts, []);
});

test('sites 可以標成自動建立並記下來源 @match', (t) => {
  const store = memoryStore(t);
  const site = store.sites.create({
    id: 'auto-test',
    name: 'auto.test',
    target_origin: 'https://auto.test',
    auto_created: 1,
    from_pattern: 'https://*.auto.test/*',
  });

  assert.equal(site.auto_created, true);
  assert.equal(site.from_pattern, 'https://*.auto.test/*');
  assert.equal(store.sites.get('auto-test').auto_created, true);
});

test('手動建立的網站 auto_created 預設 false', (t) => {
  const store = memoryStore(t);
  makeSites(store);
  assert.equal(store.sites.get('a-test').auto_created, false);
  assert.equal(store.sites.get('a-test').from_pattern, null);
});

/* ---------------- assets（@require / @resource 的伺服器端快取） ---------------- */

test('assets：內容定址，同樣內容存兩次只有一筆', (t) => {
  const store = memoryStore(t);
  const content = Buffer.from('console.log("lib");', 'utf8');

  const first = store.assets.put({ url: 'https://cdn.test/a.js', content, content_type: 'application/javascript' });
  const second = store.assets.put({ url: 'https://cdn.test/a.js', content, content_type: 'application/javascript' });

  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.equal(second.sha256, first.sha256);
  assert.equal(first.bytes, content.length);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
});

test('assets：讀回原始 bytes（binary 不能被改壞）', (t) => {
  const store = memoryStore(t);
  const content = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);

  const saved = store.assets.put({ url: 'https://cdn.test/bin', content, content_type: 'application/octet-stream' });
  const loaded = store.assets.get(saved.sha256);

  assert.ok(Buffer.isBuffer(loaded.content));
  assert.equal(Buffer.compare(loaded.content, content), 0);
  assert.equal(loaded.content_type, 'application/octet-stream');
});

test('assets：找不到 → null；可以用 url 查到已經抓過的', (t) => {
  const store = memoryStore(t);
  assert.equal(store.assets.get('f'.repeat(64)), null);
  assert.equal(store.assets.findByUrl('https://cdn.test/nope.js'), null);

  const saved = store.assets.put({ url: 'https://cdn.test/a.js', content: Buffer.from('x') });
  assert.equal(store.assets.findByUrl('https://cdn.test/a.js').sha256, saved.sha256);
});
