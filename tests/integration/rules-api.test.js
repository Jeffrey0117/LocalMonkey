'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, adminHeaders, adminJson } = require('../support/app.js');
const { startUpstream, TINY_PNG } = require('../support/upstream.js');

/** SPEC-rules §4：控制台的規則 API；§3.6：資源覆寫 */

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>templatemo</title></head><body>',
  '<div class="templatemo-logo"><img src="/images/templatemo-logo-new.png" alt="templatemo logo"></div>',
  '<div class="tm-menu"><a href="/links">Links</a></div>',
  '<style>.hero{background:url(/images/hero.jpg)}</style>',
  '</body></html>',
].join('\n');

async function scenario(t, { upstream: handler } = {}) {
  const upstream = await startUpstream(
    handler ??
      ((req, res) => {
        const buffer = Buffer.from(PAGE, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buffer.length });
        res.end(buffer);
      }),
  );
  t.after(() => upstream.close());

  const app = await startApp();
  t.after(() => app.close());

  app.store.sites.create({ id: 'demo', name: 'demo', target_origin: upstream.origin, enabled: 1 });

  const api = (pathname, init) => adminJson(app.base, app.adminToken, pathname, init);

  return { app, upstream, api };
}

/* ---------------------------------- 規則 ---------------------------------- */

test('新增 → 列出 → 更新 → 刪除', async (t) => {
  const { api } = await scenario(t);

  const created = await api('/admin/api/sites/demo/rules', {
    method: 'POST',
    body: JSON.stringify({ kind: 'hide', pattern: '.tm-menu', note: '右上四顆按鈕' }),
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.rule.kind, 'hide');
  assert.equal(created.body.rule.note, '右上四顆按鈕');
  assert.equal(created.body.rule.error, null);

  const listed = await api('/admin/api/sites/demo/rules');
  assert.equal(listed.body.rules.length, 1);

  const updated = await api(`/admin/api/sites/demo/rules/${created.body.rule.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(updated.body.rule.enabled, false);

  const removed = await api(`/admin/api/sites/demo/rules/${created.body.rule.id}`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 204);
  assert.equal((await api('/admin/api/sites/demo/rules')).body.rules.length, 0);
});

test('⛔ 編譯不過的規則存得起來，而且清單會帶著原因（規格 §4：標紅）', async (t) => {
  const { api } = await scenario(t);

  const created = await api('/admin/api/sites/demo/rules', {
    method: 'POST',
    body: JSON.stringify({ kind: 'text-rewrite', pattern: '(unclosed', replacement: 'x' }),
  });

  assert.equal(created.status, 201);
  assert.match(created.body.rule.error, /正則編譯失敗/);

  const listed = await api('/admin/api/sites/demo/rules');
  assert.match(listed.body.rules[0].error, /正則編譯失敗/);
});

test('壞掉的 CSS 選擇器也是「存起來 + 標紅」', async (t) => {
  const { api } = await scenario(t);

  const created = await api('/admin/api/sites/demo/rules', {
    method: 'POST',
    body: JSON.stringify({ kind: 'hide', pattern: 'a} body' }),
  });

  assert.match(created.body.rule.error, /大括號/);
});

test('kind 打錯 / pattern 空的 → 400', async (t) => {
  const { api } = await scenario(t);

  assert.equal(
    (
      await api('/admin/api/sites/demo/rules', {
        method: 'POST',
        body: JSON.stringify({ kind: 'nope', pattern: 'x' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api('/admin/api/sites/demo/rules', {
        method: 'POST',
        body: JSON.stringify({ kind: 'hide', pattern: '' }),
      })
    ).status,
    400,
  );
});

test('不存在的站 / 別的站的規則都是 404', async (t) => {
  const { app, api } = await scenario(t);

  app.store.sites.create({ id: 'other', name: 'other', target_origin: 'https://other.test' });
  const rule = app.store.siteRules.create('other', { kind: 'hide', pattern: '.x' });

  assert.equal((await api('/admin/api/sites/nope/rules')).status, 404);
  assert.equal((await api(`/admin/api/sites/demo/rules/${rule.id}`, { method: 'DELETE' })).status, 404);
});

test('整批重排', async (t) => {
  const { app, api } = await scenario(t);

  const first = app.store.siteRules.create('demo', { kind: 'hide', pattern: '.a' });
  const second = app.store.siteRules.create('demo', { kind: 'hide', pattern: '.b' });

  const reordered = await api('/admin/api/sites/demo/rules/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids: [second.id, first.id] }),
  });

  assert.deepEqual(
    reordered.body.rules.map((rule) => rule.pattern),
    ['.b', '.a'],
  );
});

test('「試一下」回報每條文字規則命中幾段（規格 §4）', async (t) => {
  const { app, api } = await scenario(t);

  const text = app.store.siteRules.create('demo', {
    kind: 'text-replace',
    pattern: 'templatemo',
    replacement: 'templatee',
  });
  const hidden = app.store.siteRules.create('demo', { kind: 'hide', pattern: '.tm-menu' });

  const result = await api('/admin/api/sites/demo/rules/dry-run', {
    method: 'POST',
    body: JSON.stringify({ path: '/' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.charset_ok, true);

  const byId = new Map(result.body.rules.map((rule) => [rule.id, rule]));
  assert.ok(byId.get(text.id).matched >= 2, '<title> 與 alt 都該命中');
  assert.equal(byId.get(hidden.id).matched, null, 'hide 的命中數由瀏覽器算');
  assert.match(result.body.css, /\.tm-menu/);
});

test('「試一下」打到不是 HTML 的路徑 → 400 而不是靜默回 0', async (t) => {
  const { api } = await scenario(t, {
    upstream: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    },
  });

  const result = await api('/admin/api/sites/demo/rules/dry-run', {
    method: 'POST',
    body: JSON.stringify({ path: '/x.json' }),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'not_html');
});

/* -------------------------------- 資源覆寫 -------------------------------- */

async function upload(app, { path, body = TINY_PNG, contentType = 'image/png' }) {
  const response = await fetch(
    `${app.base}/admin/api/sites/demo/resources?path=${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: adminHeaders(app.adminToken, { 'content-type': contentType }),
      body,
    },
  );

  const textBody = await response.text();
  return { status: response.status, body: textBody.length > 0 ? JSON.parse(textBody) : null };
}

test('上傳一張圖 → 代理那條路徑就回新的檔案，而且完全不碰上游', async (t) => {
  const { app, upstream } = await scenario(t);

  const created = await upload(app, { path: '/images/templatemo-logo-new.png' });
  assert.equal(created.status, 201);
  assert.equal(created.body.resource.content_type, 'image/png');

  const before = upstream.received.length;
  const response = await fetch(`${app.base}/p/demo/images/templatemo-logo-new.png`);
  const bytes = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-lm-resource-override'), '1');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(bytes.equals(TINY_PNG));
  assert.equal(upstream.received.length, before, '不准去上游拿');
});

test('query string 不會讓覆寫失效（比對的是路徑）', async (t) => {
  const { app } = await scenario(t);
  await upload(app, { path: '/images/logo.png' });

  const response = await fetch(`${app.base}/p/demo/images/logo.png?v=2`);
  assert.equal(response.headers.get('x-lm-resource-override'), '1');
});

test('停用的覆寫就回去走上游', async (t) => {
  const { app, api } = await scenario(t);

  const created = await upload(app, { path: '/images/logo.png' });
  await api(`/admin/api/sites/demo/resources/${created.body.resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });

  const response = await fetch(`${app.base}/p/demo/images/logo.png`);
  assert.equal(response.headers.get('x-lm-resource-override'), null);
});

test('再上傳一張是「換掉」，不是長出第二列', async (t) => {
  const { app, api } = await scenario(t);

  await upload(app, { path: '/images/logo.png' });
  await upload(app, { path: '/images/logo.png', body: Buffer.concat([TINY_PNG, TINY_PNG]) });

  const listed = await api('/admin/api/sites/demo/resources');
  assert.equal(listed.body.resources.length, 1);
});

test('⛔ SVG 一律拒絕（它可以內嵌 script，而圖是從我們自己的 origin 送出去的）', async (t) => {
  const { app } = await scenario(t);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');

  const declared = await upload(app, { path: '/a.svg', body: svg, contentType: 'image/svg+xml' });
  assert.equal(declared.status, 400);
  assert.match(JSON.stringify(declared.body.details), /SVG/);

  const disguised = await upload(app, { path: '/a.png', body: svg, contentType: 'image/png' });
  assert.equal(disguised.status, 400);
});

test('⛔ 不是點陣圖就拒絕（HTML 改個 content-type 送上來也擋得住）', async (t) => {
  const { app } = await scenario(t);

  const html = Buffer.from('<!doctype html><script>fetch("/admin/api/sites")</script>');
  assert.equal((await upload(app, { path: '/a.png', body: html, contentType: 'image/png' })).status, 400);
});

test('路徑要以 / 開頭、不能有 ..', async (t) => {
  const { app } = await scenario(t);

  assert.equal((await upload(app, { path: 'images/logo.png' })).status, 400);
  assert.equal((await upload(app, { path: '/../secret.png' })).status, 400);
});

test('刪掉覆寫之後又回去走上游', async (t) => {
  const { app, api } = await scenario(t);

  const created = await upload(app, { path: '/images/logo.png' });
  const removed = await api(`/admin/api/sites/demo/resources/${created.body.resource.id}`, {
    method: 'DELETE',
  });

  assert.equal(removed.status, 204);
  assert.equal((await api('/admin/api/sites/demo/resources')).body.resources.length, 0);
});

test('候選圖列得出 img 與 CSS url()（規格 §3.6：不要逼人開 DevTools）', async (t) => {
  const { api } = await scenario(t);

  const result = await api('/admin/api/sites/demo/resource-candidates?path=/');

  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.candidates.map((candidate) => candidate.path),
    ['/images/hero.jpg', '/images/templatemo-logo-new.png'],
  );
});

test('資源覆寫的端點要認證（跟後台其他端點一樣）', async (t) => {
  const { app } = await scenario(t);

  const response = await fetch(`${app.base}/admin/api/sites/demo/resources`);
  assert.equal(response.status, 401);
});
