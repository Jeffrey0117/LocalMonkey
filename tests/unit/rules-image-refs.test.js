'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectImageRefs } = require('../../src/rules/image-refs.js');

const refs = (html, origin = 'https://templatemo.com') =>
  collectImageRefs(html, { origin }).map((item) => item.path);

test('<img src> 的根相對路徑', () => {
  assert.deepEqual(refs('<img src="/images/logo.png" width="280">'), ['/images/logo.png']);
});

test('srcset 的每一個候選都算（包含 descriptor 要被切掉）', () => {
  const html = '<img srcset="/a.png 1x, /b.png 2x" src="/a.png">';
  assert.deepEqual(refs(html), ['/a.png', '/b.png']);
});

test('CSS 的 url() 也收 —— 換 logo 時最常漏掉的就是 background-image', () => {
  const html = '<style>.hero{background-image:url("/images/hero.jpg")}</style>' +
    '<div style="background:url(/images/bg.webp) no-repeat"></div>';

  // 次數一樣時照路徑排序
  assert.deepEqual(refs(html), ['/images/bg.webp', '/images/hero.jpg']);
});

test('同站的絕對網址換算成路徑（上游的 HTML 很常這樣寫）', () => {
  const html = '<img src="https://templatemo.com/images/logo.png">';
  assert.deepEqual(refs(html), ['/images/logo.png']);
});

test('別人家的圖不列 —— 覆寫只對「這個站的路徑」有意義', () => {
  const html = '<img src="https://cdn.other.test/x.png"><img src="//cdn.other.test/y.png">';
  assert.deepEqual(refs(html), []);
});

test('data: 與空值跳過', () => {
  assert.deepEqual(refs('<img src="data:image/png;base64,AAA"><img src="">'), []);
});

test('不是圖片副檔名的不列（避免把整站的連結都倒出來）', () => {
  const html = '<img src="/a.png"><a href="/about">x</a><script src="/app.js"></script>';
  assert.deepEqual(refs(html), ['/a.png']);
});

test('去重，而且記下出現幾次（UI 會把最常出現的排前面）', () => {
  const html = '<img src="/a.png"><img src="/a.png"><img src="/b.png">';
  const collected = collectImageRefs(html, { origin: 'https://templatemo.com' });

  assert.deepEqual(collected, [
    { path: '/a.png', count: 2 },
    { path: '/b.png', count: 1 },
  ]);
});

test('query 與 hash 切掉（覆寫比對的是純路徑）', () => {
  assert.deepEqual(refs('<img src="/a.png?v=2#x">'), ['/a.png']);
});

test('SVG 也列得出來（可以用點陣圖換掉它，回應的 content-type 跟著換）', () => {
  assert.deepEqual(refs('<img src="/icons/logo.svg">'), ['/icons/logo.svg']);
});

test('壞輸入不爆', () => {
  assert.deepEqual(collectImageRefs(null, { origin: 'https://x.test' }), []);
  assert.deepEqual(collectImageRefs('<img src="/a.png">', {}), []);
});
