'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

async function arrange(t) {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`// upstream ${req.url}`);
  });
  const app = await startApp();

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  seedSite(app.store, { targetOrigin: upstream.origin });
  return { upstream, app };
}

test('根路徑 fallback：用 lm_site cookie 認出網站', async (t) => {
  const { app, upstream } = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/assets/app.js?v=2',
    headers: { cookie: 'lm_site=demo' },
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.lastRequest().url, '/assets/app.js?v=2');
});

test('根路徑 fallback：沒有 cookie 時用 Referer', async (t) => {
  const { app, upstream } = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/assets/app.js',
    headers: { referer: `http://127.0.0.1:${app.port}/p/demo/page` },
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.lastRequest().url, '/assets/app.js');
});

test('根路徑 fallback：cookie 優先於 Referer', async (t) => {
  const { app } = await arrange(t);
  const other = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OTHER');
  });
  t.after(() => other.close());
  seedSite(app.store, { id: 'other', targetOrigin: other.origin });

  const response = await rawRequest({
    port: app.port,
    path: '/x.js',
    headers: {
      cookie: 'lm_site=other',
      referer: `http://127.0.0.1:${app.port}/p/demo/page`,
    },
  });

  assert.equal(response.text, 'OTHER');
});

test('根路徑 fallback：兩個都認不出來 → 404 加說明，不是 502', async (t) => {
  const { app } = await arrange(t);

  const response = await rawRequest({ port: app.port, path: '/assets/app.js' });

  assert.equal(response.status, 404);
  assert.ok(response.text.includes('/p/'), '要教使用者正確的用法');
  assert.ok(response.text.includes('lm_site'));
});

test('根路徑 fallback：cookie 指向不存在的網站 → 404', async (t) => {
  const { app } = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/a.js',
    headers: { cookie: 'lm_site=ghost' },
  });

  assert.equal(response.status, 404);
  assert.ok(response.text.includes('ghost'));
});

test('保留路徑不會被 fallback 代理掉', async (t) => {
  const { app } = await arrange(t);
  const headers = { cookie: 'lm_site=demo' };

  const admin = await rawRequest({ port: app.port, path: '/admin', headers });
  assert.equal(admin.status, 401, '/admin 要走後台的認證，不是被代理');

  const adminApi = await rawRequest({ port: app.port, path: '/admin/api/sites', headers });
  assert.equal(adminApi.status, 401);

  const unknownInternal = await rawRequest({ port: app.port, path: '/__lm/nope', headers });
  assert.equal(unknownInternal.status, 404);
  assert.equal(unknownInternal.text.includes('upstream'), false, '不該被轉到上游');
});

test('fallback 也會轉送 POST 的 body', async (t) => {
  const { app, upstream } = await arrange(t);

  await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/api/track',
    headers: { cookie: 'lm_site=demo', 'content-type': 'text/plain' },
    body: 'beacon-payload',
  });

  const received = upstream.lastRequest();
  assert.equal(received.method, 'POST');
  assert.equal(received.body.toString('utf8'), 'beacon-payload');
});
