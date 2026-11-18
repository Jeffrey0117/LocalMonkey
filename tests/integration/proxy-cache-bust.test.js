'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startApp, seedSite } = require('../support/app.js');
const { startUpstream, TINY_PNG } = require('../support/upstream.js');

/**
 * 「換了資源看不到」整條鏈（SPEC-rules §8）。
 *
 * ⛔ 實測到的現況（2026-11-18）：代理對**非 HTML** 的回應是照抄上游快取指示的
 * （那是效能的唯一來源），而 templatemo 的圖片給 `max-age=604800` ——
 * **換了 logo，使用者七天內看不到**，而且伺服器端完全看不出症狀：`curl` 永遠
 * 拿到新的那張，因為 curl 沒有快取。這是地雷 33 / 46 的第三個變體。
 *
 * 兩層解法，這個檔案兩層都測：
 *   §8.1 內容雜湊 —— HTML 裡的引用點加 `?v=<sha 前 8 碼>`，換圖 → 網址變 →
 *        瀏覽器根本不會碰到舊快取。而那個網址可以長快取（內容定址）。
 *   §8.2 開發模式 —— 碰不到的邊界（只被外部 CSS 檔的 `url()` 引用的圖）靠
 *        per-site 的開關：所有回應都 revalidate。
 */

const UPSTREAM_IMAGE_CACHE = 'max-age=604800';

async function arrange(t, { devMode = false } = {}) {
  const upstream = await startUpstream((req, res) => {
    if (req.url.startsWith('/images/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': UPSTREAM_IMAGE_CACHE });
      res.end(TINY_PNG);
      return;
    }
    if (req.url.startsWith('/css/')) {
      res.writeHead(200, {
        'content-type': 'text/css',
        'cache-control': 'max-age=86400',
        etag: 'W/"css-1"',
        'last-modified': 'Mon, 16 Nov 2026 23:31:26 GMT',
        expires: 'Tue, 17 Nov 2026 23:31:26 GMT',
        age: '120',
      });
      res.end('.logo{background:url(/images/logo.png)}');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<html><head><link rel="stylesheet" href="/css/app.css"></head><body>' +
        '<img src="/images/logo.png" alt="logo">' +
        '<img src="/images/hero.png" alt="hero">' +
        '<div style="background:url(/images/logo.png)"></div>' +
        '<a href="/images/logo.png">原圖</a>' +
        '</body></html>',
    );
  });

  const app = await startApp();
  t.after(async () => {
    await app.close();
    await upstream.close();
  });

  seedSite(app.store, { targetOrigin: upstream.origin });
  if (devMode) app.store.sites.update('demo', { dev_mode: true });

  return { app, upstream };
}

/** 上傳一張覆寫，回它的版本號（sha256 前 8 碼） */
function override(app, path, content) {
  const asset = app.store.assets.put({
    url: `lm://site/demo${path}`,
    content,
    content_type: 'image/png',
  });
  app.store.resourceOverrides.put('demo', { path, sha256: asset.sha256, content_type: 'image/png' });

  return asset.sha256.slice(0, 8);
}

const html = (app, path = '/p/demo/') => fetch(`${app.base}${path}`).then((res) => res.text());

test('有覆寫的圖：HTML 裡的 <img src> 帶上內容雜湊', async (t) => {
  const { app } = await arrange(t);
  const version = override(app, '/images/logo.png', Buffer.from([1, 2, 3, 4]));

  const text = await html(app);
  assert.ok(text.includes(`<img src="/p/demo/images/logo.png?v=${version}" alt="logo">`), text);
});

/**
 * ⛔ 注意這條的路徑形狀：`url()` 裡的網址**沒有** `/p/demo/` 前綴。
 * `lib/html.js` 只改 `src` / `href` / `action` / `poster` / `formaction` 這幾個
 * 屬性，所以 `style="background:url(/images/logo.png)"` 原樣留著、由根路徑
 * fallback（cookie → siteId）接住。cache busting 必須認得這種形狀，不然
 * background-image 的 logo 永遠拿不到版本號 —— 而那正是換圖最常漏掉的地方。
 */
test('inline style 的 url() 也要（換 logo 最常漏掉的就是 background-image）', async (t) => {
  const { app } = await arrange(t);
  const version = override(app, '/images/logo.png', Buffer.from([1, 2, 3, 4]));

  const text = await html(app);
  assert.ok(text.includes(`url(/images/logo.png?v=${version})`), text);
});

test('⛔ 沒有覆寫的圖一個都不動（長快取還是要能用，那是代理的速度來源）', async (t) => {
  const { app } = await arrange(t);
  override(app, '/images/logo.png', Buffer.from([1, 2, 3, 4]));

  assert.ok((await html(app)).includes('<img src="/p/demo/images/hero.png" alt="hero">'));
});

test('⛔ `<a href>` 不動（那是導航不是子資源）', async (t) => {
  const { app } = await arrange(t);
  override(app, '/images/logo.png', Buffer.from([1, 2, 3, 4]));

  assert.ok((await html(app)).includes('<a href="/p/demo/images/logo.png">原圖</a>'));
});

test('沒有任何覆寫的站：HTML 完全不受影響', async (t) => {
  const { app } = await arrange(t);
  assert.ok((await html(app)).includes('<img src="/p/demo/images/logo.png" alt="logo">'));
});

/**
 * 這一條就是「不用按 Ctrl+F5」的機制本身：換圖之後 HTML（`no-store`，所以一定是
 * 新的）會指向一條**新的**網址，而瀏覽器對新網址沒有任何快取。
 */
test('⛔ 換一張圖 → 版本號跟著變（舊網址的快取再也不會被用到）', async (t) => {
  const { app } = await arrange(t);

  const first = override(app, '/images/logo.png', Buffer.from('第一張'));
  assert.ok((await html(app)).includes(`?v=${first}`));

  const second = override(app, '/images/logo.png', Buffer.from('第二張（換過了）'));
  assert.notEqual(second, first);

  const text = await html(app);
  assert.ok(text.includes(`?v=${second}`), '要指向新版本');
  assert.equal(text.includes(`?v=${first}`), false, '舊版本的網址不該還留在頁面上');
});

test('帶對版本號來要那張圖 → 可以長快取（內容定址）', async (t) => {
  const { app } = await arrange(t);
  const version = override(app, '/images/logo.png', Buffer.from([9, 9, 9]));

  const response = await fetch(`${app.base}/p/demo/images/logo.png?v=${version}`);

  assert.equal(response.headers.get('x-lm-resource-override'), '1');
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.equal(response.headers.get('cache-control').includes(UPSTREAM_IMAGE_CACHE), false);
});

test('沒帶版本號（或帶錯）→ no-store，不准讓舊的那張留在瀏覽器裡', async (t) => {
  const { app } = await arrange(t);
  override(app, '/images/logo.png', Buffer.from([9, 9, 9]));

  for (const query of ['', '?v=deadbeef', '?size=small']) {
    const response = await fetch(`${app.base}/p/demo/images/logo.png${query}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', query);
  }
});

/* ------------------------------ 開發模式（§8.2） ------------------------------ */

test('開發模式關著（預設）：非 HTML 原樣沿用上游的快取', async (t) => {
  const { app } = await arrange(t);

  const response = await fetch(`${app.base}/p/demo/css/app.css`);
  assert.equal(response.headers.get('cache-control'), 'max-age=86400');
  assert.equal(response.headers.get('etag'), 'W/"css-1"');
});

/**
 * ⛔ 這個開關存在的理由：被**外部 CSS 檔**的 `background-image: url()` 引用的圖
 * 拿不到 `?v=` —— 那個網址寫在 `app.css` 裡，而 `app.css` 自己也被快取著。
 * 所以 §8.1 救不了它，只能整站 revalidate。
 */
test('開發模式打開：非 HTML 改成 no-cache，但 ETag 留著（304 不傳 body）', async (t) => {
  const { app } = await arrange(t, { devMode: true });

  const response = await fetch(`${app.base}/p/demo/css/app.css`);

  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('etag'), 'W/"css-1"', 'revalidate 要靠它才便宜');
  assert.equal(response.headers.get('last-modified'), 'Mon, 16 Nov 2026 23:31:26 GMT');
  assert.equal(response.headers.get('expires'), null, '舊式的 expires 會讓瀏覽器自己算出「不用問」');
  assert.equal(response.headers.get('age'), null);
});

test('開發模式打開：圖片也一樣（上游的 7 天快取不准生效）', async (t) => {
  const { app } = await arrange(t, { devMode: true });

  const response = await fetch(`${app.base}/p/demo/images/hero.png`);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});

test('開發模式打開：覆寫過的資源連 `?v=` 也不給長快取', async (t) => {
  const { app } = await arrange(t, { devMode: true });
  const version = override(app, '/images/logo.png', Buffer.from([9, 9, 9]));

  const response = await fetch(`${app.base}/p/demo/images/logo.png?v=${version}`);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});

test('⛔ 開發模式打開：HTML 還是 no-store（更強），而且 ETag 照樣要丟掉', async (t) => {
  const { app } = await arrange(t, { devMode: true });

  const response = await fetch(`${app.base}/p/demo/`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
});
