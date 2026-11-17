'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rewriteBaseHref } = require('../../src/lib/base-tag.js');

/**
 * `<base href>` 是代理的頭號殺手：我們把資源路徑改寫成 `/p/<siteId>/…` 之後，
 * 瀏覽器會拿**原站的 base** 去解析它們，於是實際請求變成
 * `https://原站/p/<siteId>/…` → 全部 404，而且頁面看起來只是「沒有樣式」。
 *
 * curl 驗不出來（它不解析 base），所以這組測試是唯一自動化的防線。
 */

const TARGET = 'https://www.example.com';

function rewrite(html, targetOrigin = TARGET) {
  return rewriteBaseHref(html, { siteId: 'demo', targetOrigin });
}

test('base 指向該站的 origin（有尾斜線）→ 改寫成 /p/<siteId>/', () => {
  const out = rewrite('<head><base href="https://www.example.com/" /></head>');
  assert.ok(out.includes('<base href="/p/demo/" />'), out);
});

test('base 指向該站的 origin（單引號、沒有尾斜線）→ 一樣改寫', () => {
  const out = rewrite("<head><base href='https://www.example.com'></head>");
  assert.ok(out.includes("<base href='/p/demo/'>"), out);
});

test('大寫的 <BASE HREF> 也要吃', () => {
  const out = rewrite('<HEAD><BASE HREF="https://www.example.com/"></HEAD>');
  assert.ok(out.includes('<BASE HREF="/p/demo/">'), out);
});

test('base 指向別的網域 → 原樣保留（那是真的跨網域意圖）', () => {
  const html = '<head><base href="https://other.test/"></head>';
  assert.equal(rewrite(html), html);
});

test('base 是根相對路徑 → 接上代理前綴', () => {
  const out = rewrite('<head><base href="/sub/"></head>');
  assert.ok(out.includes('<base href="/p/demo/sub/">'), out);
});

test('base 指向該站但帶路徑 → 路徑保留在代理前綴後面', () => {
  const out = rewrite('<head><base href="https://www.example.com/assets/v2/"></head>');
  assert.ok(out.includes('<base href="/p/demo/assets/v2/">'), out);
});

test('沒有 <base> 的 HTML 原樣不動（回歸保護）', () => {
  const html = [
    '<!doctype html>',
    '<html><head><title>t</title><link rel="stylesheet" href="/a.css"></head>',
    '<body><p>base 這個字出現在文字裡也不該被動</p></body></html>',
  ].join('\n');

  assert.equal(rewrite(html), html);
});

test('已經改寫過的 base 不會被二次改寫（冪等）', () => {
  const html = '<head><base href="/p/demo/"></head>';
  assert.equal(rewrite(html), html);
});

test('base 的其他屬性原樣保留', () => {
  const out = rewrite('<base href="https://www.example.com/" target="_blank">');
  assert.ok(out.includes('href="/p/demo/"'), out);
  assert.ok(out.includes('target="_blank"'), out);
});

test('同主機但 scheme 不同（http vs https）也要改寫', () => {
  // 不改寫的話瀏覽器照樣離開代理 —— 那不是「跨網域意圖」，只是舊站留著 http
  const out = rewrite('<base href="http://www.example.com/">');
  assert.ok(out.includes('href="/p/demo/"'), out);
});

test('protocol-relative 的 base：同主機改寫，別的主機不動', () => {
  const same = rewrite('<base href="//www.example.com/">');
  assert.ok(same.includes('href="/p/demo/"'), same);

  const other = '<base href="//cdn.other.test/">';
  assert.equal(rewrite(other), other);
});

test('相對路徑的 base（不是根路徑）不動 —— 它本來就會相對於代理路徑解析', () => {
  const html = '<base href="assets/">';
  assert.equal(rewrite(html), html);
});

test('沒有 href、空 href、無法解析的 href 一律不動', () => {
  for (const html of [
    '<base target="_blank">',
    '<base href="">',
    '<base href="javascript:void(0)">',
    '<base href="data:text/html,x">',
  ]) {
    assert.equal(rewrite(html), html, html);
  }
});

test('多個 <base> 都會被處理（瀏覽器只認第一個，但留著錯的那個也是雷）', () => {
  const out = rewrite('<base href="https://www.example.com/"><base href="/x/">');
  assert.ok(out.includes('<base href="/p/demo/">'), out);
  assert.ok(out.includes('<base href="/p/demo/x/">'), out);
});

test('target_origin 壞掉時不要炸，原樣回傳', () => {
  const html = '<base href="https://www.example.com/">';
  assert.equal(rewriteBaseHref(html, { siteId: 'demo', targetOrigin: '這不是 origin' }), html);
  assert.equal(rewriteBaseHref(html, { siteId: 'demo' }), html);
});

test('不是字串就原樣回傳（防呆）', () => {
  assert.equal(rewriteBaseHref(null, { siteId: 'demo', targetOrigin: TARGET }), null);
  assert.equal(rewriteBaseHref(undefined, { siteId: 'demo', targetOrigin: TARGET }), undefined);
});

test('base 的 query 與 fragment 一起帶過去', () => {
  const out = rewrite('<base href="https://www.example.com/x/?v=2">');
  assert.ok(out.includes('href="/p/demo/x/?v=2"'), out);
});
