'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../support/app.js');
const { startUpstream } = require('../support/upstream.js');
const { rawRequest } = require('../support/http.js');

const PAGE_WITH_OWN_SCRIPT = [
  '<!doctype html>',
  '<html><head><script src="/page.js"></script><title>上游</title></head>',
  '<body><h1>原本的標題</h1></body></html>',
].join('\n');

function html(body) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
}

/** 起一個 app + 任意數量的假上游站 */
async function arrange(t, { pages = [PAGE_WITH_OWN_SCRIPT] } = {}) {
  const upstreams = [];
  for (const page of pages) {
    upstreams.push(await startUpstream(html(page)));
  }

  const app = await startApp();

  t.after(async () => {
    await app.close();
    for (const upstream of upstreams) await upstream.close();
  });

  const sites = upstreams.map((upstream, index) => {
    const id = `site-${index}`;
    app.store.sites.create({
      id,
      name: id,
      target_origin: upstream.origin,
      auto_created: 1,
      from_pattern: `https://${id}.test/*`,
    });
    return id;
  });

  return { app, sites, upstreams };
}

function seedScript(app, { source = "console.log('x');", runAt = 'document-end', metadata = {}, bindings = [] }) {
  const script = app.store.userscripts.create({
    name: '測試腳本',
    source,
    metadata: { needsShim: false, requireAssets: [], ...metadata },
    run_at: runAt,
  });

  if (bindings.length > 0) app.store.userscripts.setBindings(script.id, bindings);
  return script;
}

test('document-start：注入的 script 排在頁面自己的 script 之前', async (t) => {
  const { app, sites } = await arrange(t);
  const script = seedScript(app, {
    runAt: 'document-start',
    bindings: [{ site_id: sites[0], path_glob: '*' }],
  });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/` })).text;
  const injectedAt = body.indexOf(`/__lm/script/${script.id}.js`);
  const pageScriptAt = body.indexOf(`/p/${sites[0]}/page.js`);

  assert.ok(injectedAt > -1, '腳本要注入得到');
  assert.ok(injectedAt < pageScriptAt, `注入點太晚了：${injectedAt} 應該 < ${pageScriptAt}`);
  assert.ok(body.indexOf('<head>') < injectedAt, '要在 <head> 裡面');
  assert.ok(injectedAt < body.indexOf('<title>'), '要是 head 的第一個子元素');
});

test('document-end：注入在 </body> 之前', async (t) => {
  const { app, sites } = await arrange(t);
  const script = seedScript(app, {
    runAt: 'document-end',
    bindings: [{ site_id: sites[0], path_glob: '*' }],
  });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/` })).text;
  const injectedAt = body.indexOf(`/__lm/script/${script.id}.js`);

  assert.ok(injectedAt > body.indexOf('</head>'));
  assert.ok(injectedAt < body.lastIndexOf('</body>'));
});

test('document-idle：投遞的 JS 會等 DOMContentLoaded + idle 才跑', async (t) => {
  const { app, sites } = await arrange(t);
  const script = seedScript(app, {
    source: 'window.__ran = true;',
    runAt: 'document-idle',
    bindings: [{ site_id: sites[0], path_glob: '*' }],
  });

  const delivered = await rawRequest({ port: app.port, path: `/__lm/script/${script.id}.js` });

  assert.equal(delivered.status, 200);
  assert.ok(delivered.text.includes('window.__ran = true;'));
  assert.ok(delivered.text.includes('DOMContentLoaded'));
  assert.ok(delivered.text.includes('requestIdleCallback'));
});

test('@exclude 命中的頁面不注入，其他頁面照注入', async (t) => {
  const { app, sites } = await arrange(t);
  const script = seedScript(app, {
    bindings: [{ site_id: sites[0], path_glob: '*', exclude_globs: ['/admin/**'] }],
  });

  const excluded = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/admin/users` })).text;
  const normal = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/shop` })).text;

  assert.equal(excluded.includes(script.id), false);
  assert.ok(normal.includes(script.id));
});

test('⭐ 一支腳本掛兩個網站：改一次 source，兩個代理網址拿到的都是新版', async (t) => {
  const { app, sites } = await arrange(t, {
    pages: [PAGE_WITH_OWN_SCRIPT, PAGE_WITH_OWN_SCRIPT],
  });

  const script = seedScript(app, {
    source: "console.log('版本一');",
    bindings: [
      { site_id: sites[0], path_glob: '*' },
      { site_id: sites[1], path_glob: '*' },
    ],
  });

  for (const siteId of sites) {
    const body = (await rawRequest({ port: app.port, path: `/p/${siteId}/` })).text;
    assert.ok(body.includes(`/__lm/script/${script.id}.js`), `${siteId} 要注入得到`);
  }

  app.store.userscripts.update(script.id, { source: "console.log('版本二');" });

  const delivered = await rawRequest({ port: app.port, path: `/__lm/script/${script.id}.js` });
  assert.ok(delivered.text.includes("console.log('版本二');"));
  assert.equal(delivered.text.includes('版本一'), false);

  // 兩個站指向同一個 scriptId，所以兩邊下次載入都是新版 —— 這就是 v2 的核心賣點
  for (const siteId of sites) {
    const body = (await rawRequest({ port: app.port, path: `/p/${siteId}/` })).text;
    assert.ok(body.includes(`/__lm/script/${script.id}.js`), `${siteId} 還是同一個 scriptId`);
  }
});

test('同一支腳本在同一個站有兩條 path_glob，頁面只注入一次', async (t) => {
  const { app, sites } = await arrange(t);
  const script = seedScript(app, {
    bindings: [
      { site_id: sites[0], path_glob: '*' },
      { site_id: sites[0], path_glob: '/shop/**' },
    ],
  });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/shop/1` })).text;
  const occurrences = body.split(`/__lm/script/${script.id}.js`).length - 1;

  assert.equal(occurrences, 1, `重複注入了 ${occurrences} 次`);
});

test('@require 的資產：注入在腳本之前，而且投遞得出原始內容', async (t) => {
  const { app, sites } = await arrange(t);
  const asset = app.store.assets.put({
    url: 'https://cdn.test/lib.js',
    content: Buffer.from('window.LIB = 1;', 'utf8'),
    content_type: 'application/javascript',
  });

  const script = seedScript(app, {
    metadata: { requireAssets: [{ url: 'https://cdn.test/lib.js', sha256: asset.sha256 }] },
    bindings: [{ site_id: sites[0], path_glob: '*' }],
  });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/` })).text;
  assert.ok(
    body.indexOf(`/__lm/asset/${asset.sha256}.js`) < body.indexOf(`/__lm/script/${script.id}.js`),
    '@require 要排在使用者腳本之前',
  );

  const delivered = await rawRequest({ port: app.port, path: `/__lm/asset/${asset.sha256}.js` });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.text, 'window.LIB = 1;');
  assert.match(delivered.headers['content-type'], /application\/javascript/);
  assert.match(delivered.headers['cache-control'], /immutable/);
});

test('資產：sha256 不合法或不存在 → 404（不要變成任意檔案探測）', async (t) => {
  const { app } = await arrange(t);

  for (const path of [
    '/__lm/asset/nope.js',
    `/__lm/asset/${'a'.repeat(64)}.js`,
    '/__lm/asset/..%2f..%2fpackage.json',
  ]) {
    const response = await rawRequest({ port: app.port, path });
    assert.equal(response.status, 404, path);
  }
});

test('⛔ 資產不會用上游的 text/html 送出（同源 HTML = 可以代打後台 API）', async (t) => {
  const { app } = await arrange(t);
  const asset = app.store.assets.put({
    url: 'https://cdn.test/evil',
    content: Buffer.from('<script>fetch("/admin/api/sites")</script>', 'utf8'),
    content_type: 'text/html',
  });

  const response = await rawRequest({ port: app.port, path: `/__lm/asset/${asset.sha256}` });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/plain/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('停用的腳本不注入也不投遞', async (t) => {
  const { app, sites } = await arrange(t);
  const script = seedScript(app, { bindings: [{ site_id: sites[0], path_glob: '*' }] });
  app.store.userscripts.update(script.id, { enabled: 0 });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/` })).text;
  assert.equal(body.includes(script.id), false);

  const delivered = await rawRequest({ port: app.port, path: `/__lm/script/${script.id}.js` });
  assert.equal(delivered.status, 404);
});

test('沒有綁定的腳本不會注入到任何網站', async (t) => {
  const { app, sites } = await arrange(t);
  const script = seedScript(app, { bindings: [] });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/` })).text;
  assert.equal(body.includes(script.id), false);
});

/* ---------- 同一個站台掛多支腳本（四支真實腳本都配 www.instagram.com） ---------- */

test('⭐ 多支腳本掛在同一個自動建立的站上，照 order_index 注入', async (t) => {
  const { app, sites } = await arrange(t);

  // 真實情況：ig-comment-scraper / ig-dm-sender / ig-helper / peekly 都配 www.instagram.com
  const third = seedScript(app, {
    source: "console.log('third');",
    bindings: [{ site_id: sites[0], path_glob: '*' }],
  });
  const first = seedScript(app, {
    source: "console.log('first');",
    bindings: [{ site_id: sites[0], path_glob: '*' }],
  });
  const second = seedScript(app, {
    source: "console.log('second');",
    bindings: [{ site_id: sites[0], path_glob: '*' }],
  });

  app.store.userscripts.update(first.id, { order_index: 1 });
  app.store.userscripts.update(second.id, { order_index: 2 });
  app.store.userscripts.update(third.id, { order_index: 3 });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/` })).text;

  assert.ok(body.indexOf(first.id) < body.indexOf(second.id), '1 要在 2 前面');
  assert.ok(body.indexOf(second.id) < body.indexOf(third.id), '2 要在 3 前面');
});

test('同站多腳本：停用其中一支不影響其他支的順序', async (t) => {
  const { app, sites } = await arrange(t);

  const a = seedScript(app, { bindings: [{ site_id: sites[0], path_glob: '*' }] });
  const b = seedScript(app, { bindings: [{ site_id: sites[0], path_glob: '*' }] });
  const c = seedScript(app, { bindings: [{ site_id: sites[0], path_glob: '*' }] });

  app.store.userscripts.update(a.id, { order_index: 1 });
  app.store.userscripts.update(b.id, { order_index: 2, enabled: 0 });
  app.store.userscripts.update(c.id, { order_index: 3 });

  const body = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/` })).text;

  assert.ok(body.includes(a.id));
  assert.equal(body.includes(b.id), false, '停用的不注入');
  assert.ok(body.includes(c.id));
  assert.ok(body.indexOf(a.id) < body.indexOf(c.id));
});

test('同站多腳本：各自的 @exclude 只影響自己', async (t) => {
  const { app, sites } = await arrange(t);

  const everywhere = seedScript(app, { bindings: [{ site_id: sites[0], path_glob: '*' }] });
  const notOnAdmin = seedScript(app, {
    bindings: [{ site_id: sites[0], path_glob: '*', exclude_globs: ['/admin/**'] }],
  });

  const admin = (await rawRequest({ port: app.port, path: `/p/${sites[0]}/admin/x` })).text;

  assert.ok(admin.includes(everywhere.id), '沒排除的照注入');
  assert.equal(admin.includes(notOnAdmin.id), false);
});
