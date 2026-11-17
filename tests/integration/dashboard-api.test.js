'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../support/app.js');
const { adminJson } = require('../support/app.js');

/**
 * Tampermonkey 風格的儀表板需要的列表欄位（SPEC-dashboard §2 / §3）。
 *
 * 重點是「列表要輕」：帶得出大小與更新時間，但**不帶 source**
 * （一支腳本可能 1MB，列表一次要畫十幾支）。
 */

const SCRIPT = [
  '// ==UserScript==',
  '// @name        儀表板樣本',
  '// @version     2.3.1',
  '// @match       https://www.example.test/*',
  '// @require     https://cdn.example.test/lib.js',
  '// @grant       GM_setValue',
  '// @grant       GM_cookie',
  '// ==/UserScript==',
  "console.info('一些中文註解讓 byte 數大於字元數');",
].join('\n');

const MINIMAL = [
  '// ==UserScript==',
  '// @name        沒版本的腳本',
  '// @match       https://other.example.test/*',
  '// ==/UserScript==',
  'void 0;',
].join('\n');

async function arrange(t) {
  const app = await startApp({
    // @require 會真的去抓；注入假的 fetch 與 lookup，測試才不會打外網
    fetchImpl: async () => new Response('/* lib */', { headers: { 'content-type': 'application/javascript' } }),
  });
  t.after(() => app.close());

  const call = (pathname, init) => adminJson(app.base, app.adminToken, pathname, init);
  const post = (pathname, body) =>
    call(pathname, { method: 'POST', body: JSON.stringify(body) });

  return { app, call, post };
}

test('GET /scripts：帶 size / updatedAt / siteIds / featureFlags，而且還是不帶 source', async (t) => {
  const { call, post } = await arrange(t);
  await post('/admin/api/scripts', { source: SCRIPT });

  const response = await call('/admin/api/scripts');
  const [script] = response.body.scripts;

  assert.equal(response.status, 200);
  assert.equal('source' in script, false, '列表要輕，不准帶 source');

  assert.equal(script.size, Buffer.byteLength(SCRIPT, 'utf8'), 'size 要是 byte 數不是字元數');
  assert.equal(script.updatedAt, script.updated_at);
  assert.deepEqual(script.siteIds, script.site_ids);
  assert.equal(script.version, '2.3.1');

  assert.equal(script.featureFlags.requires, 1);
  assert.equal(script.featureFlags.grants >= 1, true);
  assert.deepEqual(script.featureFlags.unsupportedGrants, ['GM_cookie']);
  assert.equal(script.featureFlags.delivery, true, '每支腳本都有投遞網址');
});

test('size 算的是 UTF-8 byte 數（中文註解的腳本不能短報）', async (t) => {
  const { call, post } = await arrange(t);
  await post('/admin/api/scripts', { source: SCRIPT });

  const [script] = (await call('/admin/api/scripts')).body.scripts;

  assert.ok(script.size > SCRIPT.length, `byte 數要大於字元數：${script.size} vs ${SCRIPT.length}`);
});

test('沒有 @version 的腳本：version 是 null，列表照樣畫得出來', async (t) => {
  const { call, post } = await arrange(t);
  await post('/admin/api/scripts', { source: MINIMAL });

  const [script] = (await call('/admin/api/scripts')).body.scripts;

  assert.equal(script.version, null);
  assert.equal(typeof script.size, 'number');
  assert.equal(script.featureFlags.requires, 0);
  assert.deepEqual(script.featureFlags.unsupportedGrants, []);
});

test('停用的腳本照樣出現在列表裡，只是 enabled 是 false（整列要轉灰）', async (t) => {
  const { call, post } = await arrange(t);
  const created = await post('/admin/api/scripts', { source: SCRIPT });

  await call(`/admin/api/scripts/${created.body.script.id}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: false }),
  });

  const [script] = (await call('/admin/api/scripts')).body.scripts;
  assert.equal(script.enabled, false);
});

test('沒有任何腳本時回空陣列（UI 要靠它顯示空狀態）', async (t) => {
  const { call } = await arrange(t);

  const response = await call('/admin/api/scripts');
  assert.deepEqual(response.body.scripts, []);
});
