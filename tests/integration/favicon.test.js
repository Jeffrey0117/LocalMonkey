'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream, TINY_PNG } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

/**
 * 站點 favicon（SPEC-dashboard §2.1）。
 *
 * 刻意**不用** google.com/s2/favicons 之類的第三方服務 —— 那等於把
 * 「使用者代理了哪些網站」洩漏出去。自己抓、走既有的 SSRF 防護與大小上限、
 * 存進內容定址的 assets 表。
 */

async function arrange(t, { handler, appOptions = {}, siteOptions = {} } = {}) {
  const upstream = await startUpstream(
    handler ??
      ((req, res) => {
        if (req.url === '/favicon.ico') {
          res.writeHead(200, { 'content-type': 'image/x-icon' });
          res.end(TINY_PNG);
          return;
        }
        res.writeHead(404).end('nope');
      }),
  );

  const app = await startApp(appOptions);

  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const seeded = seedSite(app.store, { targetOrigin: upstream.origin, ...siteOptions });
  return { upstream, app, ...seeded };
}

const favicon = (app, siteId = 'demo') =>
  rawRequest({ port: app.port, path: `/__lm/favicon/${siteId}` });

test('抓得到 /favicon.ico → 回那張圖，而且存進 assets（內容定址）', async (t) => {
  const { app } = await arrange(t);

  const response = await favicon(app);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^image\//);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.body.length, TINY_PNG.length);
  assert.ok(response.body.equals(TINY_PNG), '送出去的要是上游那份 bytes');

  // 內容定址：同一份內容在 assets 裡只有一列
  const stored = app.store.assets.findByUrl(`${app.store.sites.get('demo').target_origin}/favicon.ico`);
  assert.ok(stored, 'favicon 要存進 assets');
  assert.equal(stored.bytes, TINY_PNG.length);
});

test('第二次請求不會再打上游（快取，不要每次開列表都重抓）', async (t) => {
  const { app, upstream } = await arrange(t);

  await favicon(app);
  const afterFirst = upstream.received.length;
  await favicon(app);
  await favicon(app);

  assert.equal(upstream.received.length, afterFirst, `多打了 ${upstream.received.length - afterFirst} 次`);
});

test('/favicon.ico 失敗 → 退到 /apple-touch-icon.png', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      if (req.url === '/apple-touch-icon.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
        return;
      }
      res.writeHead(404).end('nope');
    },
  });

  const response = await favicon(app);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^image\/png/);
});

test('都抓不到 → 回內建佔位 SVG，而且是 200 不是 404（不要破圖、不要噴 console）', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => res.writeHead(404).end('nope'),
  });

  const response = await favicon(app);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^image\/svg\+xml/);
  assert.ok(response.text.includes('<svg'));
});

test('不存在的 siteId → 一樣回佔位圖（不洩漏「這個站存不存在」）', async (t) => {
  const { app } = await arrange(t);

  const response = await favicon(app, 'no-such-site');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^image\/svg\+xml/);
});

test('上游用 200 回一頁 HTML（假的 404 頁）→ 當失敗，回佔位圖', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>找不到</html>');
    },
  });

  const response = await favicon(app);
  assert.match(response.headers['content-type'], /^image\/svg\+xml/);
});

test('⛔ 上游回 image/svg+xml → 拒收（第三方 SVG 可以內含 script）', async (t) => {
  const { app } = await arrange(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/admin/api/scripts")</script></svg>');
    },
  });

  const response = await favicon(app);

  assert.match(response.headers['content-type'], /^image\/svg\+xml/);
  assert.equal(response.text.includes('fetch('), false, '不准把上游的 SVG 送出去');
});

test('私網位址 → 被 SSRF 擋下來，回佔位圖', async (t) => {
  const { app } = await arrange(t, { appOptions: { config: { allowPrivate: false } } });

  const response = await favicon(app);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^image\/svg\+xml/);
});

test('失敗之後也要快取（不然每開一次列表就對死掉的站打一輪）', async (t) => {
  const { app, upstream } = await arrange(t, {
    handler: (req, res) => res.writeHead(404).end('nope'),
  });

  await favicon(app);
  const afterFirst = upstream.received.length;
  await favicon(app);

  assert.equal(upstream.received.length, afterFirst);
});
