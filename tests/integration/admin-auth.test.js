'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, TEST_ADMIN_TOKEN } = require('../support/app.js');
const { rawRequest } = require('../support/http.js');

async function arrange(t) {
  const app = await startApp();
  t.after(() => app.close());
  return app;
}

test('沒帶 token → 401', async (t) => {
  const app = await arrange(t);

  for (const path of ['/admin', '/admin/api/sites']) {
    const response = await rawRequest({ port: app.port, path });
    assert.equal(response.status, 401, `${path} 應該 401`);
  }
});

test('錯的 token → 401（Bearer 與 cookie 都一樣）', async (t) => {
  const app = await arrange(t);

  const bearer = await rawRequest({
    port: app.port,
    path: '/admin/api/sites',
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(bearer.status, 401);

  const cookie = await rawRequest({
    port: app.port,
    path: '/admin/api/sites',
    headers: { cookie: 'lm_admin=wrong-token' },
  });
  assert.equal(cookie.status, 401);
});

test('長度一樣但內容不同的 token 也要 401（timing-safe 比對不是放行）', async (t) => {
  const app = await arrange(t);
  const sameLengthWrong = 'x'.repeat(TEST_ADMIN_TOKEN.length);

  const response = await rawRequest({
    port: app.port,
    path: '/admin/api/sites',
    headers: { authorization: `Bearer ${sameLengthWrong}` },
  });
  assert.equal(response.status, 401);
});

test('對的 Bearer token → 200', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/admin/api/sites',
    headers: { authorization: `Bearer ${app.adminToken}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { sites: [] });
});

test('對的 cookie → 200', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/admin/api/sites',
    headers: { cookie: `lm_admin=${app.adminToken}` },
  });
  assert.equal(response.status, 200);
});

test('GET /admin?token=<對的> → 設 cookie 後 302 到乾淨的 /admin', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: `/admin?token=${app.adminToken}`,
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin');

  const cookie = response.setCookie.find((value) => value.startsWith('lm_admin='));
  assert.ok(cookie, '要設 lm_admin cookie');
  assert.ok(cookie.includes(app.adminToken));
  assert.ok(/HttpOnly/i.test(cookie));
  assert.ok(/SameSite=Strict/i.test(cookie));
  assert.ok(/Path=\/admin/.test(cookie));
});

test('GET /admin?token=<錯的> → 401 且不設 cookie', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({ port: app.port, path: '/admin?token=nope' });

  assert.equal(response.status, 401);
  assert.equal(
    response.setCookie.some((value) => value.startsWith('lm_admin=')),
    false,
  );
});

test('401 頁面要教使用者去哪拿 token，但不准印出 token', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({ port: app.port, path: '/admin' });

  assert.ok(response.text.includes('admin-token.txt'));
  assert.ok(response.text.includes('LOCALMONKEY_ADMIN_TOKEN'));
  assert.equal(response.text.includes(app.adminToken), false, '絕對不可以把 token 印在頁面上');
});

test('帶對 token 的 /admin 回得到後台頁面', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/admin',
    headers: { cookie: `lm_admin=${app.adminToken}` },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.ok(response.text.includes('LocalMonkey'));
  assert.ok(response.text.includes('/admin/app.js'), '後台 JS 要用外部檔案');
});

test('後台靜態檔也要 token', async (t) => {
  const app = await arrange(t);

  const anonymous = await rawRequest({ port: app.port, path: '/admin/app.js' });
  assert.equal(anonymous.status, 401);

  const authenticated = await rawRequest({
    port: app.port,
    path: '/admin/app.js',
    headers: { cookie: `lm_admin=${app.adminToken}` },
  });
  assert.equal(authenticated.status, 200);
  assert.match(authenticated.headers['content-type'], /javascript/);
});

test('完全不設 CORS header（不然別的網站的 JS 就能當管理員）', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    path: '/admin/api/sites',
    headers: { authorization: `Bearer ${app.adminToken}`, origin: 'http://evil.test' },
  });

  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

test('跨站的寫入一律 403（Origin 不符）', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/admin/api/sites',
    headers: {
      authorization: `Bearer ${app.adminToken}`,
      'content-type': 'application/json',
      origin: 'http://evil.test',
    },
    body: JSON.stringify({ id: 'x', name: 'x', target_origin: 'https://example.com' }),
  });

  assert.equal(response.status, 403);
  assert.equal(app.store.sites.get('x'), null, '不可以真的寫進去');
});

test('跨站的寫入一律 403（Sec-Fetch-Site: cross-site）', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    method: 'DELETE',
    path: '/admin/api/sites/whatever',
    headers: {
      authorization: `Bearer ${app.adminToken}`,
      'sec-fetch-site': 'cross-site',
    },
  });

  assert.equal(response.status, 403);
});

test('同源的寫入可以過', async (t) => {
  const app = await arrange(t);

  const response = await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/admin/api/sites',
    headers: {
      authorization: `Bearer ${app.adminToken}`,
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${app.port}`,
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ id: 'ok-site', name: 'ok', target_origin: 'https://example.com' }),
  });

  assert.equal(response.status, 201);
});

test('沒有 Origin 也沒有 Sec-Fetch-Site 的寫入（curl / 腳本）照樣可以，但還是要 token', async (t) => {
  const app = await arrange(t);

  const withToken = await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/admin/api/sites',
    headers: { authorization: `Bearer ${app.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'cli-site', name: 'cli', target_origin: 'https://example.com' }),
  });
  assert.equal(withToken.status, 201);

  const withoutToken = await rawRequest({
    port: app.port,
    method: 'POST',
    path: '/admin/api/sites',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'nope', name: 'x', target_origin: 'https://example.com' }),
  });
  assert.equal(withoutToken.status, 401);
});

test('代理路徑與腳本投遞不需要後台 token（不然網站根本打不開）', async (t) => {
  const app = await arrange(t);

  const proxied = await rawRequest({ port: app.port, path: '/p/unknown-site/' });
  assert.equal(proxied.status, 404, '是 404 而不是 401');
});
