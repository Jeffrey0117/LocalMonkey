'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rewriteMetaRefresh } = require('../../src/lib/meta-refresh.js');

/**
 * `<meta http-equiv="refresh" content="0; url=https://原站/…">` 會在幾秒後
 * 把使用者整個踢出代理（而且注入的腳本跟著消失）。跟 `<base>` 同一類問題：
 * 指向該站的改寫成代理路徑，指向別人的保留。
 */

const TARGET = 'https://www.example.com';

function rewrite(html, targetOrigin = TARGET) {
  return rewriteMetaRefresh(html, { siteId: 'demo', targetOrigin });
}

test('指向該站的絕對網址 → 改寫成代理路徑', () => {
  const out = rewrite('<meta http-equiv="refresh" content="0; url=https://www.example.com/next">');
  assert.ok(out.includes('content="0; url=/p/demo/next"'), out);
});

test('根相對路徑 → 接上代理前綴（沒有空白的 url= 也要吃）', () => {
  const out = rewrite('<meta http-equiv="refresh" content="3;url=/next/page.html">');
  assert.ok(out.includes('content="3;url=/p/demo/next/page.html"'), out);
});

test('指向別的網域 → 原樣保留', () => {
  const html = '<meta http-equiv="refresh" content="0; url=https://other.test/go">';
  assert.equal(rewrite(html), html);
});

test('大小寫不拘、單引號也要吃', () => {
  const out = rewrite("<META HTTP-EQUIV='REFRESH' CONTENT='0; URL=https://www.example.com/x'>");
  assert.ok(out.includes('/p/demo/x'), out);
});

test('content 裡的網址自己又被引號包起來 → 內層引號保留', () => {
  const out = rewrite(`<meta http-equiv="refresh" content="0; url='https://www.example.com/x'">`);
  assert.ok(out.includes(`content="0; url='/p/demo/x'"`), out);
});

test('只有秒數、沒有 url 的 refresh 不動（那是原地重新載入）', () => {
  const html = '<meta http-equiv="refresh" content="30">';
  assert.equal(rewrite(html), html);
});

test('不是 refresh 的 http-equiv 一律不動', () => {
  const html = [
    '<meta http-equiv="content-type" content="text/html; charset=utf-8">',
    '<meta http-equiv="x-ua-compatible" content="ie=edge">',
    '<meta name="description" content="0; url=https://www.example.com/x">',
  ].join('\n');

  assert.equal(rewrite(html), html);
});

test('已經改寫過的不會被二次改寫（冪等）', () => {
  const html = '<meta http-equiv="refresh" content="0; url=/p/demo/next">';
  assert.equal(rewrite(html), html);
});

test('沒有 meta refresh 的 HTML 原樣不動（回歸保護）', () => {
  const html = '<html><head><title>t</title></head><body>refresh 這個字</body></html>';
  assert.equal(rewrite(html), html);
});

test('target_origin 壞掉 / 不是字串時不要炸', () => {
  const html = '<meta http-equiv="refresh" content="0; url=https://www.example.com/x">';
  assert.equal(rewriteMetaRefresh(html, { siteId: 'demo', targetOrigin: 'nope' }), html);
  assert.equal(rewriteMetaRefresh(null, { siteId: 'demo', targetOrigin: TARGET }), null);
});
