'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bustCacheReferences, shortVersion } = require('../../src/lib/cache-bust.js');

/**
 * 內容雜湊 cache busting（SPEC-rules §8.1）。
 *
 * ⛔ 真實事故（2026-11-18 實測）：圖片的回應是照抄上游快取指示的，templatemo
 * 給 `max-age=604800` —— **換了 logo，使用者七天內看不到**，而伺服器端完全看不出
 * 症狀（curl 永遠拿到新的那張）。
 *
 * 解法是把「有覆寫的那條路徑」的引用換成內容定址的網址：
 * `/p/demo/images/logo.png?v=<sha256 前 8 碼>`。換圖 → sha 變 → 網址變 →
 * 瀏覽器根本不會去碰舊快取那一筆。HTML 本身已經是 `no-store`，所以改寫 HTML
 * 是安全的。
 */

const VERSIONS = new Map([['/images/logo.png', 'abcd1234']]);
const bust = (html, versions = VERSIONS) =>
  bustCacheReferences(html, { siteId: 'demo', versions });

test('shortVersion 取 sha256 的前 8 碼（內容定址：內容變了網址就變）', () => {
  assert.equal(shortVersion('abcd1234ef567890'), 'abcd1234');
  assert.equal(shortVersion('ABCD1234EF'), 'abcd1234', '一律小寫，大小寫不同不該變成兩個網址');
  assert.equal(shortVersion(null), null);
  assert.equal(shortVersion('short'), null, '短到不像 sha256 就不要瞎掰一個版本號');
});

test('<img src> 有覆寫就加上 ?v=', () => {
  const html = '<img src="/p/demo/images/logo.png" width="280" />';
  assert.equal(bust(html), '<img src="/p/demo/images/logo.png?v=abcd1234" width="280" />');
});

test('⛔ 沒有覆寫的路徑一個都不動（維持速度：長快取還是要能用）', () => {
  const html =
    '<img src="/p/demo/thumbnails/634.jpg" /><link href="/p/demo/css/app.css" rel="stylesheet" />';
  assert.equal(bust(html), html);
});

test('別的站的前綴不算（同一條路徑在另一個站沒有覆寫）', () => {
  const html = '<img src="/p/other/images/logo.png" />';
  assert.equal(bust(html), html);
});

test('沒有任何覆寫時整份文件原樣回傳', () => {
  const html = '<img src="/p/demo/images/logo.png" />';
  assert.equal(bust(html, new Map()), html);
});

test('srcset 的每一個候選都要處理，描述符原樣保留', () => {
  const html =
    '<img srcset="/p/demo/images/logo.png 1x, /p/demo/images/logo@2x.png 2x" src="/p/demo/images/logo.png" />';
  const versions = new Map([
    ['/images/logo.png', 'aaaaaaaa'],
    ['/images/logo@2x.png', 'bbbbbbbb'],
  ]);

  assert.equal(
    bust(html, versions),
    '<img srcset="/p/demo/images/logo.png?v=aaaaaaaa 1x, /p/demo/images/logo@2x.png?v=bbbbbbbb 2x" src="/p/demo/images/logo.png?v=aaaaaaaa" />',
  );
});

test('<link href> 要處理（favicon / CSS 也可以被覆寫）', () => {
  const versions = new Map([['/favicon.ico', 'ffff0000']]);
  assert.equal(
    bust('<link rel="icon" href="/p/demo/favicon.ico">', versions),
    '<link rel="icon" href="/p/demo/favicon.ico?v=ffff0000">',
  );
});

test('⛔ `<a href>` 不准動 —— 那是導航不是子資源', () => {
  const html = '<a href="/p/demo/images/logo.png">看原圖</a>';
  assert.equal(bust(html), html);
});

test('<source src> 與 poster 要處理', () => {
  const versions = new Map([
    ['/media/clip.webp', '11111111'],
    ['/media/poster.jpg', '22222222'],
  ]);

  assert.equal(
    bust(
      '<video poster="/p/demo/media/poster.jpg"><source src="/p/demo/media/clip.webp" /></video>',
      versions,
    ),
    '<video poster="/p/demo/media/poster.jpg?v=22222222"><source src="/p/demo/media/clip.webp?v=11111111" /></video>',
  );
});

test('inline style 的 url() 要處理（引號有無都要）', () => {
  assert.equal(
    bust('<div style="background-image:url(/p/demo/images/logo.png)"></div>'),
    '<div style="background-image:url(/p/demo/images/logo.png?v=abcd1234)"></div>',
  );
  assert.equal(
    bust(`<div style="background:url('/p/demo/images/logo.png') no-repeat"></div>`),
    `<div style="background:url('/p/demo/images/logo.png?v=abcd1234') no-repeat"></div>`,
  );
});

test('頁面裡的 <style> 區塊的 url() 也算（外部 CSS 檔才是碰不到的那個邊界）', () => {
  assert.equal(
    bust('<style>.logo{background:url("/p/demo/images/logo.png")}</style>'),
    '<style>.logo{background:url("/p/demo/images/logo.png?v=abcd1234")}</style>',
  );
});

/**
 * ⛔ 分隔符用裸的 `&`，不是 `&amp;`。
 *
 * 同一支函式要同時改寫兩種上下文：`src="…"`（屬性值，entity 會被解碼）與
 * `<style>` 裡的 `url(…)`（raw text，entity **不會**被解碼）。寫 `&amp;` 的話
 * CSS 那邊就真的去要一條含 `&amp;` 的網址 → 404，而且症狀只出現在
 * background-image 上。裸的 `&v=` 在兩邊都對（`&v` 不是任何已知 entity）。
 */
test('已經有 query 的話接在後面，不要把原本的參數吃掉', () => {
  assert.equal(
    bust('<img src="/p/demo/images/logo.png?size=small" />'),
    '<img src="/p/demo/images/logo.png?size=small&v=abcd1234" />',
  );
});

test('⛔ 已經有 ?v= 的不要再疊一層（重複改寫要是冪等的）', () => {
  const once = bust('<img src="/p/demo/images/logo.png" />');
  assert.equal(bust(once), once);
});

test('fragment 要留在最後面', () => {
  assert.equal(
    bust('<img src="/p/demo/images/logo.png#frag" />'),
    '<img src="/p/demo/images/logo.png?v=abcd1234#frag" />',
  );
});

test('壞參數不要丟例外（代理路徑上的程式碼不准讓頁面開不起來）', () => {
  assert.equal(bustCacheReferences(null, { siteId: 'demo', versions: VERSIONS }), null);
  assert.equal(bustCacheReferences('<img src="/p/demo/images/logo.png" />', {}),
    '<img src="/p/demo/images/logo.png" />');
});

/**
 * ⛔ 沒被改寫的根絕對路徑也要處理，而這**不是順手**：`lib/html.js` 只改
 * `src` / `href` / `action` / `poster` / `formaction`，**不動 `url()`** ——
 * 所以 `style="background:url(/images/logo.png)"` 在送出去的 HTML 裡還是原樣，
 * 由根路徑 fallback（cookie → siteId）接住。少了這一種，background-image 的
 * logo 就永遠拿不到版本號，而那正是「換圖最常漏掉的地方」。
 */
test('⛔ 沒被改寫的根絕對路徑（url() 裡的）也要加版本號', () => {
  assert.equal(
    bust('<div style="background:url(/images/logo.png)"></div>'),
    '<div style="background:url(/images/logo.png?v=abcd1234)"></div>',
  );
});

test('⛔ 但別的站的代理前綴還是不算（`/p/other/…` 不是這個站的路徑）', () => {
  const html = '<div style="background:url(/p/other/images/logo.png)"></div>';
  assert.equal(bust(html), html);
});

test('protocol-relative 與絕對網址不動（那是跨網域，不經過我們）', () => {
  const html =
    '<img src="//cdn.example.test/images/logo.png" /><img src="https://x.test/images/logo.png" />';
  assert.equal(bust(html), html);
});
