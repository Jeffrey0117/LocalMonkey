'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream, TINY_PNG } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

/**
 * 代理回的 HTML 不准被瀏覽器快取。
 *
 * 真實事故（2026-11-17）：templatemo 的 HTML 帶 `cache-control: max-age=86400`，
 * 我們原樣沿用 → Chrome 吃自己的快取整整 24 小時。`<base>` 的修正早就上線了、
 * curl 拿到的也是新的，但瀏覽器裡的 `<base href>` 還是舊值。
 *
 * 這不只是驗證時很煩 —— 代理回的 HTML 是**我們改造過的**（注入了 script tag、
 * 改寫了路徑）。使用者在後台改一支腳本存檔，打開代理網址卻看到昨天那份 HTML，
 * 連 script tag 都還是舊的那組。腳本本身是 no-cache 救不了這件事，
 * 因為**承載它的那張 HTML 被快取了**。
 */

const CACHE_HEADERS = {
  'cache-control': 'max-age=86400',
  expires: 'Tue, 17 Nov 2026 23:31:26 GMT',
  etag: 'W/"upstream-etag"',
  'last-modified': 'Mon, 16 Nov 2026 23:31:26 GMT',
  age: '4356',
  pragma: 'public',
};

async function arrange(t, handler) {
  const upstream = await startUpstream(handler);
  const app = await startApp();

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  seedSite(app.store, { targetOrigin: upstream.origin });
  return { app, upstream };
}

function htmlUpstream(req, res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CACHE_HEADERS });
  res.end('<html><head><title>t</title></head><body><p>hi</p></body></html>');
}

test('HTML：上游的快取指示全部不見，而且回 no-store', async (t) => {
  const { app } = await arrange(t, htmlUpstream);

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');

  for (const header of ['expires', 'etag', 'last-modified', 'age', 'pragma']) {
    assert.equal(response.headers[header], undefined, `${header} 不該被轉述`);
  }
});

test('⛔ 非 HTML 的快取原樣保留（這條擋的是過度修正 —— 快取是效能來源）', async (t) => {
  const { app } = await arrange(t, (req, res) => {
    if (req.url.endsWith('.css')) {
      res.writeHead(200, {
        'content-type': 'text/css',
        'cache-control': 'max-age=31536000, immutable',
        etag: 'W/"css-etag"',
        'last-modified': 'Mon, 16 Nov 2026 23:31:26 GMT',
      });
      res.end('body{color:red}');
      return;
    }

    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=604800' });
    res.end(TINY_PNG);
  });

  const css = await rawRequest({ port: app.port, path: '/p/demo/a.css' });
  assert.equal(css.headers['cache-control'], 'max-age=31536000, immutable');
  assert.equal(css.headers.etag, 'W/"css-etag"');
  assert.equal(css.headers['last-modified'], 'Mon, 16 Nov 2026 23:31:26 GMT');

  const png = await rawRequest({ port: app.port, path: '/p/demo/a.png' });
  assert.equal(png.headers['cache-control'], 'max-age=604800');
});

test('HTML 的其他 header 與改寫 / 注入照舊（no-store 不該有副作用）', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-custom': 'keep-me',
      ...CACHE_HEADERS,
    });
    res.end('<html><head><link rel="stylesheet" href="/a.css"></head><body>hi</body></html>');
  });
  const app = await startApp();

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const { scripts } = seedSite(app.store, {
    targetOrigin: upstream.origin,
    scripts: [{ name: '注入', code: 'window.__LM = 1' }],
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-custom'], 'keep-me');
  assert.match(response.headers['content-type'], /text\/html/);
  assert.ok(response.text.includes('href="/p/demo/a.css"'), '路徑改寫照舊');
  assert.ok(response.text.includes(`/__lm/script/${scripts[0].id}.js`), '注入照舊');
  assert.ok(response.setCookie.some((cookie) => cookie.startsWith('lm_site=')), 'cookie 照舊');
});

test('HTML 的錯誤頁（404 也是 HTML）一樣不准被快取', async (t) => {
  const { app } = await arrange(t, (req, res) => {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', ...CACHE_HEADERS });
    res.end('<html><body>找不到</body></html>');
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/nope' });

  assert.equal(response.status, 404);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.etag, undefined);
});

test('XHTML 也算 HTML（content-type 的判斷要跟注入那條一致）', async (t) => {
  const { app } = await arrange(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/xhtml+xml', ...CACHE_HEADERS });
    res.end('<html><body>x</body></html>');
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('304（上游說沒變）不會因為沒有 body 就漏掉 no-store', async (t) => {
  const { app } = await arrange(t, (req, res) => {
    res.writeHead(304, { 'content-type': 'text/html; charset=utf-8', ...CACHE_HEADERS });
    res.end();
  });

  const response = await rawRequest({
    port: app.port,
    path: '/p/demo/',
    headers: { 'if-none-match': 'W/"upstream-etag"' },
  });

  assert.equal(response.status, 304);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.etag, undefined, '不給驗證碼，瀏覽器就沒辦法拿舊的那份出來用');
});
