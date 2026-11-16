'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

test('請求 body 超過上限 → 413，而且不會轉到上游', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const app = await startApp({ config: { maxRequestBodyBytes: 64 } });
  t.after(async () => {
    await app.close();
    await upstream.close();
  });
  seedSite(app.store, { targetOrigin: upstream.origin });

  const response = await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/p/demo/upload',
    headers: { 'content-type': 'text/plain' },
    body: 'x'.repeat(5000),
  });

  assert.equal(response.status, 413);
  assert.ok(response.text.includes('LOCALMONKEY_MAX_BODY_BYTES'));
  assert.equal(upstream.received.length, 0, '太大的 body 不該被轉出去');
});

test('後台不存在的頁面 → 404（而不是掉進代理）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const response = await rawRequest({
    port: app.port,
    path: '/admin/nope',
    headers: { cookie: `lm_admin=${app.adminToken}` },
  });

  assert.equal(response.status, 404);
  assert.ok(response.text.includes('後台沒有這個頁面'));
});

test('內部出錯 → 500 錯誤頁，而且不吐堆疊', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>x</body></html>');
  });
  const app = await startApp();
  t.after(async () => {
    await app.close();
    await upstream.close();
  });
  seedSite(app.store, { targetOrigin: upstream.origin });

  // 模擬「注入腳本時 DB 查詢炸掉」這種我們沒預期到的狀況
  app.store.scripts.listActiveForSite = () => {
    throw new Error('資料庫在這個瞬間掛了');
  };

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 500);
  assert.ok(response.text.includes('LocalMonkey 自己出錯了'));
  assert.equal(response.text.includes('資料庫在這個瞬間掛了'), false, '不把內部訊息吐出去');
  assert.equal(/at .*\(.*:\d+:\d+\)/.test(response.text), false);
});

test('上游逾時 → 502（不是一直掛著）', async (t) => {
  const upstream = await startUpstream(() => {
    // 故意不回應
  });
  const app = await startApp({ config: { upstreamTimeoutMs: 150 } });
  t.after(async () => {
    await app.close();
    await upstream.close();
  });
  seedSite(app.store, { targetOrigin: upstream.origin });

  const response = await rawRequest({ port: app.port, path: '/p/demo/slow' });

  assert.equal(response.status, 502);
  assert.ok(response.text.includes('上游網站沒有回應'));
});

test('createApp 沒給 adminToken 就直接拒絕啟動（不准有「沒設就不驗證」模式）', async () => {
  const { createApp } = require('../../src/app.js');

  for (const adminToken of [undefined, '', null]) {
    assert.throws(
      () => createApp({ store: {}, config: {}, adminToken }),
      /adminToken/,
      `adminToken=${JSON.stringify(adminToken)} 應該要被拒絕`,
    );
  }
});
