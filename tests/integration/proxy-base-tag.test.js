'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

/**
 * 整條管線版的 `<base>` 回歸測試。
 *
 * 真實案例（templatemo.com）：`<head>` 裡有 `<base href="https://templatemo.com/" />`，
 * 我們把 CSS 路徑正確改寫成 `/p/templatemo-com/x.css`，但瀏覽器拿 base 去解析它，
 * 實際請求變成 `https://templatemo.com/p/templatemo-com/x.css` → 404、整頁沒樣式。
 *
 * curl 看不出來（不解析 base），所以這裡斷言的是**送出去的 HTML 裡 base 指向代理**。
 */

/** 讓假上游回一份「帶 base + 根絕對路徑資源」的頁面 */
function pageWith(baseHref) {
  return [
    '<!doctype html>',
    '<html><head>',
    '<meta charset="utf-8">',
    baseHref === null ? '' : `<base href="${baseHref}" />`,
    '<link rel="stylesheet" href="/tm-style.css">',
    '</head>',
    '<body><h1>上游</h1>',
    '<img src="/img/logo.png">',
    '<script src="/assets/app.js"></script>',
    '</body></html>',
  ].join('\n');
}

async function arrange(t, { baseHref, body, scripts = [] } = {}) {
  // baseHref / body 可以是函式，這樣才拿得到上游自己的 origin
  // （handler 只在請求進來時才跑，那時 upstream 已經 assign 好了）
  const resolve = (value, origin) => (typeof value === 'function' ? value(origin) : value);

  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(resolve(body, upstream.origin) ?? pageWith(resolve(baseHref, upstream.origin)));
  });

  const app = await startApp();

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const seeded = seedSite(app.store, { targetOrigin: upstream.origin, scripts });
  return { upstream, app, ...seeded };
}

test('base 指向該站 → 改寫成 /p/<siteId>/，資源路徑也照舊改寫', async (t) => {
  const { app, upstream, scripts } = await arrange(t, {
    baseHref: (origin) => `${origin}/`,
    scripts: [{ name: '注入', code: 'window.__LM = 1' }],
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.status, 200);
  assert.ok(response.text.includes('<base href="/p/demo/" />'), response.text);
  assert.equal(response.text.includes(upstream.origin), false, '送出去的 HTML 不該再提到上游 origin');

  // 資源路徑照舊改寫，而且沒有被 base 那條規則掃第二次
  assert.ok(response.text.includes('href="/p/demo/tm-style.css"'));
  assert.ok(response.text.includes('src="/p/demo/img/logo.png"'));
  assert.ok(response.text.includes('src="/p/demo/assets/app.js"'));
  assert.ok(response.text.includes(`/__lm/script/${scripts[0].id}.js`), '腳本還是要注入');
});

test('base 沒有尾斜線也要改寫（只差尾斜線也算同一個 origin）', async (t) => {
  const { app } = await arrange(t, { baseHref: (origin) => origin });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });
  assert.ok(response.text.includes('<base href="/p/demo/" />'), response.text);
});

test('base 指向別的網域 → 原樣保留', async (t) => {
  const { app } = await arrange(t, { baseHref: 'https://cdn.other.test/' });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });
  assert.ok(response.text.includes('<base href="https://cdn.other.test/" />'), response.text);
});

test('沒有 base 的頁面：輸出跟以前完全一樣（回歸保護）', async (t) => {
  const { app } = await arrange(t, { baseHref: null });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.equal(response.text.includes('<base'), false);
  assert.ok(response.text.includes('href="/p/demo/tm-style.css"'));
  assert.ok(response.text.includes('src="/p/demo/assets/app.js"'));
});

test('meta refresh：指向該站的改寫成代理路徑，指向別人的保留', async (t) => {
  const { app, upstream } = await arrange(t, {
    body: (origin) =>
      [
        '<html><head>',
        `<meta http-equiv="refresh" content="0; url=${origin}/landing">`,
        '<meta http-equiv="refresh" content="5; url=https://other.test/go">',
        '</head><body>x</body></html>',
      ].join('\n'),
  });

  const response = await rawRequest({ port: app.port, path: '/p/demo/' });

  assert.ok(response.text.includes('content="0; url=/p/demo/landing"'), response.text);
  assert.ok(response.text.includes('url=https://other.test/go'), '外站的 refresh 要保留');
  assert.equal(response.text.includes(upstream.origin), false);
});
