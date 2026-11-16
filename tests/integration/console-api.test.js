'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, adminJson } = require('../support/app.js');

/**
 * v2 後台 API（規格 §5）。這一層是「丟腳本進去，站台自己長出來」的入口。
 */

async function arrange(t) {
  const app = await startApp();
  t.after(() => app.close());

  return {
    app,
    call: (path, init) => adminJson(app.base, app.adminToken, path, init),
    post: (path, body) =>
      adminJson(app.base, app.adminToken, path, { method: 'POST', body: JSON.stringify(body) }),
    put: (path, body) =>
      adminJson(app.base, app.adminToken, path, { method: 'PUT', body: JSON.stringify(body) }),
    patch: (path, body) =>
      adminJson(app.base, app.adminToken, path, { method: 'PATCH', body: JSON.stringify(body) }),
    del: (path) => adminJson(app.base, app.adminToken, path, { method: 'DELETE' }),
  };
}

const TWO_MATCH = [
  '// ==UserScript==',
  '// @name        兩個網域都要',
  '// @version     1.0',
  '// @description 測試用',
  '// @match       https://www.example.test/*',
  '// @match       https://seller.example.test/items/*',
  '// @grant       GM_addStyle',
  '// @grant       GM_setValue',
  '// ==/UserScript==',
  "GM_addStyle('body{}');",
].join('\n');

test('POST /scripts：丟一支兩個 @match 的腳本 → 自動建兩個站並掛上去', async (t) => {
  const { post, call } = await arrange(t);

  const response = await post('/admin/api/scripts', { source: TWO_MATCH });

  assert.equal(response.status, 201);
  assert.equal(response.body.script.name, '兩個網域都要');
  assert.equal(response.body.script.version, '1.0');
  assert.equal(response.body.script.run_at, 'document-end');
  assert.equal(response.body.script.metadata.needsShim, true);

  assert.deepEqual(
    response.body.targets.map((target) => [target.status, target.host, target.pathGlob, target.siteId]),
    [
      ['ready', 'www.example.test', '*', 'example-test'],
      ['ready', 'seller.example.test', '/items/**', 'seller-example-test'],
    ],
  );

  const sites = await call('/admin/api/sites');
  assert.deepEqual(
    sites.body.sites.map((site) => [site.id, site.target_origin, site.auto_created]),
    [
      ['example-test', 'https://www.example.test', true],
      ['seller-example-test', 'https://seller.example.test', true],
    ],
  );

  assert.deepEqual(
    response.body.script.sites.map((binding) => binding.site_id),
    ['example-test', 'seller-example-test'],
  );
});

test('POST /userscript/parse：只解析不寫入（給「丟腳本」預覽用）', async (t) => {
  const { post, call } = await arrange(t);

  const response = await post('/admin/api/userscript/parse', { source: TWO_MATCH });

  assert.equal(response.status, 200);
  assert.equal(response.body.parsed.name, '兩個網域都要');
  assert.equal(response.body.parsed.targets.length, 2);
  assert.deepEqual(response.body.parsed.supportedGrants, ['GM_addStyle', 'GM_setValue']);

  assert.deepEqual((await call('/admin/api/scripts')).body.scripts, [], '不准寫進去');
  assert.deepEqual((await call('/admin/api/sites')).body.sites, [], '不准建站');
});

test('POST /userscript/parse：沒有 header 的純 JS 片段也回得出結果', async (t) => {
  const { post } = await arrange(t);

  const response = await post('/admin/api/userscript/parse', {
    source: "document.title = 'x';",
    fallbackName: 'snippet.user.js',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.parsed.hasMetadataBlock, false);
  assert.equal(response.body.parsed.name, 'snippet.user.js');
  assert.ok(response.body.parsed.notices.some((notice) => /header/.test(notice.message)));
});

test('POST /userscript/parse：每個被拒絕的 pattern 都要有原因（UI 要逐列顯示）', async (t) => {
  const { post } = await arrange(t);

  const response = await post('/admin/api/userscript/parse', {
    source: [
      '// ==UserScript==',
      '// @name x',
      '// @match <all_urls>',
      '// @match https://*.shopee.tw/*',
      '// @match https://ok.test/*',
      '// ==/UserScript==',
      'x',
    ].join('\n'),
  });

  assert.deepEqual(
    response.body.parsed.targets.map((target) => target.status),
    ['rejected', 'needs-host', 'ready'],
  );
  assert.ok(response.body.parsed.targets.every((target) => target.status === 'ready' || target.reason));
});

test('GET /scripts：列表不帶 source（要輕），但帶得出掛在哪些站', async (t) => {
  const { post, call } = await arrange(t);
  await post('/admin/api/scripts', { source: TWO_MATCH });

  const response = await call('/admin/api/scripts');

  assert.equal(response.status, 200);
  assert.equal(response.body.scripts.length, 1);
  assert.equal('source' in response.body.scripts[0], false);
  assert.deepEqual(response.body.scripts[0].site_ids, ['example-test', 'seller-example-test']);
});

test('GET /scripts/:id：帶 source、metadata、綁定，也帶 v1 的別名', async (t) => {
  const { post, call } = await arrange(t);
  const created = await post('/admin/api/scripts', { source: TWO_MATCH });

  const response = await call(`/admin/api/scripts/${created.body.script.id}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.script.source, TWO_MATCH);
  assert.equal(response.body.script.code, TWO_MATCH, 'v1 的別名要留著');
  assert.deepEqual(response.body.script.metadata.grants, ['GM_addStyle', 'GM_setValue']);
  assert.equal(response.body.script.sites.length, 2);
});

test('GET /scripts/:id：不存在 → 404', async (t) => {
  const { call } = await arrange(t);

  const response = await call('/admin/api/scripts/scr_ghost');
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'not_found');
});

test('PUT /scripts/:id 帶 source → 重新解析並重算綁定', async (t) => {
  const { post, put, call } = await arrange(t);
  const created = await post('/admin/api/scripts', { source: TWO_MATCH });
  const id = created.body.script.id;

  const updated = await put(`/admin/api/scripts/${id}`, {
    source: [
      '// ==UserScript==',
      '// @name 改名了',
      '// @version 2.0',
      '// @match https://www.example.test/shop/*',
      '// @run-at document-start',
      '// ==/UserScript==',
      'x',
    ].join('\n'),
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.script.name, '改名了');
  assert.equal(updated.body.script.version, '2.0');
  assert.equal(updated.body.script.run_at, 'document-start');
  assert.deepEqual(
    updated.body.script.sites.map((binding) => [binding.site_id, binding.path_glob]),
    [['example-test', '/shop/**']],
  );

  const reread = await call(`/admin/api/scripts/${id}`);
  assert.equal(reread.body.script.metadata.needsShim, false, '@grant 拿掉了，shim 也要跟著關');
});

test('PUT /scripts/:id 只改 enabled / order_index → 綁定與 source 不動', async (t) => {
  const { post, put } = await arrange(t);
  const created = await post('/admin/api/scripts', { source: TWO_MATCH });

  const updated = await put(`/admin/api/scripts/${created.body.script.id}`, {
    enabled: false,
    order_index: 5,
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.script.enabled, false);
  assert.equal(updated.body.script.order_index, 5);
  assert.equal(updated.body.script.source, TWO_MATCH);
  assert.equal(updated.body.script.sites.length, 2);
});

test('PUT /scripts/:id：source 空的 → 400，而且原本的內容不會被清掉', async (t) => {
  const { post, put, call } = await arrange(t);
  const created = await post('/admin/api/scripts', { source: TWO_MATCH });

  const response = await put(`/admin/api/scripts/${created.body.script.id}`, { source: '   ' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'validation_failed');

  const reread = await call(`/admin/api/scripts/${created.body.script.id}`);
  assert.equal(reread.body.script.source, TWO_MATCH);
});

test('POST /scripts：source 空的或不是字串 → 400', async (t) => {
  const { post } = await arrange(t);

  for (const body of [{ source: '' }, { source: '  ' }, { source: 42 }, {}, []]) {
    const response = await post('/admin/api/scripts', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('POST /scripts：全部 @match 都被拒 → 還是存起來，但沒有綁定也有警告', async (t) => {
  const { post, call } = await arrange(t);

  const response = await post('/admin/api/scripts', {
    source: ['// ==UserScript==', '// @name 配全世界', '// @match <all_urls>', '// ==/UserScript==', 'x'].join('\n'),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.body.script.sites, []);
  assert.equal(response.body.targets[0].status, 'rejected');
  assert.ok(response.body.warnings.length > 0);
  assert.deepEqual((await call('/admin/api/sites')).body.sites, [], '不准建站');
});

test('DELETE /scripts/:id → 204，而且站上不再注入它', async (t) => {
  const { post, del, call } = await arrange(t);
  const created = await post('/admin/api/scripts', { source: TWO_MATCH });

  assert.equal((await del(`/admin/api/scripts/${created.body.script.id}`)).status, 204);
  assert.equal((await call(`/admin/api/scripts/${created.body.script.id}`)).status, 404);
  assert.deepEqual((await call('/admin/api/scripts')).body.scripts, []);

  const sites = await call('/admin/api/sites');
  assert.deepEqual(sites.body.sites[0].scripts, [], '站留著，但沒有腳本掛在上面');
});

test('GET /sites：唯讀清單，帶得出「掛了哪些腳本」', async (t) => {
  const { post, call } = await arrange(t);
  await post('/admin/api/scripts', { source: TWO_MATCH });

  const response = await call('/admin/api/sites');
  const site = response.body.sites.find((entry) => entry.id === 'example-test');

  assert.deepEqual(
    site.scripts.map((script) => [script.name, script.enabled]),
    [['兩個網域都要', true]],
  );
  assert.equal(site.from_pattern, 'https://www.example.test/*');
});

test('PATCH /sites/:id：啟用開關與指定具體主機（萬用子網域的用途）', async (t) => {
  const { post, patch, call } = await arrange(t);
  await post('/admin/api/scripts', {
    source: ['// ==UserScript==', '// @name x', '// @match https://*.example.test/*', '// ==/UserScript==', 'x'].join('\n'),
  });

  const off = await patch('/admin/api/sites/example-test', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.site.enabled, false);

  const renamed = await patch('/admin/api/sites/example-test', { name: 'shop 子網域' });
  assert.equal(renamed.body.site.name, 'shop 子網域');

  const site = (await call('/admin/api/sites')).body.sites[0];
  assert.equal(site.enabled, false);
  assert.equal(site.name, 'shop 子網域');
});

test('PATCH /sites/:id：不准改 id', async (t) => {
  const { post, patch } = await arrange(t);
  await post('/admin/api/scripts', { source: TWO_MATCH });

  const response = await patch('/admin/api/sites/example-test', { id: 'something-else' });
  assert.equal(response.status, 400);
});

test('v2 的端點照樣要 token，而且跨站寫入一律 403', async (t) => {
  const { app } = await arrange(t);

  const noToken = await fetch(`${app.base}/admin/api/scripts`);
  assert.equal(noToken.status, 401);
  await noToken.text();

  const crossSite = await fetch(`${app.base}/admin/api/scripts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${app.adminToken}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ source: TWO_MATCH }),
  });
  assert.equal(crossSite.status, 403);
  await crossSite.text();

  const parseNoToken = await fetch(`${app.base}/admin/api/userscript/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: TWO_MATCH }),
  });
  assert.equal(parseNoToken.status, 401);
  await parseNoToken.text();
});

test('v1 的相容路徑還活著：PUT 帶 code / match_glob 照舊有效', async (t) => {
  const { post, put, call } = await arrange(t);
  await post('/admin/api/sites', {
    id: 'legacy',
    name: 'legacy',
    target_origin: 'http://127.0.0.1:3100',
  });
  const created = await post('/admin/api/sites/legacy/scripts', { name: 'a', code: 'x' });

  const updated = await put(`/admin/api/scripts/${created.body.script.id}`, {
    code: 'y',
    match_glob: '/shop/**',
    run_at: 'head-end',
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.script.code, 'y');
  assert.equal(updated.body.script.source, 'y');
  assert.equal(updated.body.script.match_glob, '/shop/**');
  assert.equal(updated.body.script.run_at, 'head-end');

  const listed = (await call('/admin/api/scripts')).body.scripts;
  assert.equal(listed.length, 1, 'v1 建的腳本也出現在 v2 的列表裡');
});
