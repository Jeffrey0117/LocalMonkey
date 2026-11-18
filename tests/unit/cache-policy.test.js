'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withHtmlCachePolicy, CACHE_HEADERS } = require('../../src/lib/cache-policy.js');

/**
 * 代理回的 HTML 是**我們改造過的**（注入了 script、改寫了路徑與 `<base>`），
 * 所以絕對不能沿用上游的快取指示 —— 不然使用者在後台改完腳本、打開代理網址，
 * 看到的是昨天那份 HTML（連 script tag 都還是舊的那組）。
 *
 * 非 HTML（CSS / JS / 圖片）要維持上游的快取，那是效能的來源。
 */

const names = (pairs) => pairs.map(([name]) => name);
const find = (pairs, name) => pairs.find(([key]) => key === name)?.[1];

test('HTML：上游的快取 header 全部丟掉', () => {
  const pairs = withHtmlCachePolicy([
    ['content-type', 'text/html; charset=utf-8'],
    ['cache-control', 'max-age=86400'],
    ['expires', 'Tue, 17 Nov 2026 23:31:26 GMT'],
    ['etag', 'W/"abc"'],
    ['last-modified', 'Mon, 16 Nov 2026 23:31:26 GMT'],
    ['age', '4356'],
    ['pragma', 'public'],
  ]);

  for (const header of CACHE_HEADERS) {
    if (header === 'cache-control') continue; // 這個是被換掉不是被拿掉
    assert.equal(names(pairs).includes(header), false, `${header} 應該被丟掉`);
  }
});

test('HTML：自己設 Cache-Control: no-store', () => {
  const pairs = withHtmlCachePolicy([['cache-control', 'max-age=86400']]);

  assert.equal(find(pairs, 'cache-control'), 'no-store');
  assert.equal(names(pairs).filter((name) => name === 'cache-control').length, 1, '不准有兩條');
});

test('HTML：上游完全沒有快取 header 時也要補上 no-store', () => {
  const pairs = withHtmlCachePolicy([['content-type', 'text/html']]);
  assert.equal(find(pairs, 'cache-control'), 'no-store');
});

test('⛔ 其他 header 原樣保留（這條擋的是過度修正）', () => {
  const pairs = withHtmlCachePolicy([
    ['content-type', 'text/html; charset=utf-8'],
    ['cache-control', 'max-age=86400'],
    ['x-custom', 'keep-me'],
    ['vary', 'accept-encoding'],
    ['location', '/somewhere'],
  ]);

  assert.equal(find(pairs, 'content-type'), 'text/html; charset=utf-8');
  assert.equal(find(pairs, 'x-custom'), 'keep-me');
  assert.equal(find(pairs, 'vary'), 'accept-encoding');
  assert.equal(find(pairs, 'location'), '/somewhere');
});

test('大小寫不拘（上游可能回 Cache-Control / ETag）', () => {
  const pairs = withHtmlCachePolicy([
    ['Cache-Control', 'max-age=86400'],
    ['ETag', 'W/"abc"'],
  ]);

  assert.equal(names(pairs).some((name) => name.toLowerCase() === 'etag'), false);
  assert.equal(
    pairs.filter(([name]) => name.toLowerCase() === 'cache-control').length,
    1,
    '原本那條要被換掉，不是多加一條',
  );
  assert.equal(find(pairs, 'cache-control'), 'no-store');
});

test('⛔ 不可以就地改掉傳進來的陣列', () => {
  const input = [
    ['cache-control', 'max-age=86400'],
    ['etag', 'W/"abc"'],
  ];
  const before = JSON.stringify(input);

  withHtmlCachePolicy(input);

  assert.equal(JSON.stringify(input), before, '要回新陣列');
});

test('空輸入也給得出 no-store（防呆）', () => {
  assert.deepEqual(withHtmlCachePolicy([]), [['cache-control', 'no-store']]);
  assert.deepEqual(withHtmlCachePolicy(), [['cache-control', 'no-store']]);
});

/* ------------------------------ 開發模式（§8.2） ------------------------------ */

/**
 * ⛔ `?v=` 只救得了「HTML 裡有引用那條路徑」的資源。被**外部 CSS 檔**的
 * `background-image: url()` 引用的圖拿不到版本號 —— 那個網址在 CSS 檔裡，
 * 而 CSS 檔自己也被快取著。開發模式就是那個邊界的解法：全部 revalidate。
 */
const { withDevModeCachePolicy } = require('../../src/lib/cache-policy.js');

test('開發模式：cache-control 換成 no-cache', () => {
  const pairs = withDevModeCachePolicy([
    ['content-type', 'image/png'],
    ['cache-control', 'max-age=604800'],
  ]);

  assert.equal(find(pairs, 'cache-control'), 'no-cache');
  assert.equal(names(pairs).filter((name) => name === 'cache-control').length, 1);
});

test('⛔ 開發模式保留 ETag / Last-Modified（revalidate 很便宜，304 不傳 body）', () => {
  const pairs = withDevModeCachePolicy([
    ['etag', 'W/"abc"'],
    ['last-modified', 'Mon, 16 Nov 2026 23:31:26 GMT'],
  ]);

  assert.equal(find(pairs, 'etag'), 'W/"abc"');
  assert.equal(find(pairs, 'last-modified'), 'Mon, 16 Nov 2026 23:31:26 GMT');
});

test('開發模式丟掉舊式的 expires / age / pragma（它們會讓瀏覽器自己算出「還能用」）', () => {
  const pairs = withDevModeCachePolicy([
    ['expires', 'Tue, 17 Nov 2026 23:31:26 GMT'],
    ['age', '4356'],
    ['pragma', 'public'],
    ['x-custom', 'keep-me'],
  ]);

  for (const header of ['expires', 'age', 'pragma']) {
    assert.equal(names(pairs).includes(header), false, `${header} 應該被丟掉`);
  }
  assert.equal(find(pairs, 'x-custom'), 'keep-me');
});

test('開發模式上游完全沒有快取 header 時也要補上 no-cache', () => {
  assert.equal(find(withDevModeCachePolicy([['content-type', 'image/png']]), 'cache-control'), 'no-cache');
});
