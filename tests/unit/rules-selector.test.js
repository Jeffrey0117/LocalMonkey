'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { safeCssSelector, escapeCssNonAscii } = require('../../src/rules/selector.js');

test('一般的選擇器原樣放行', () => {
  for (const selector of [
    '.tm-menu',
    '#footer',
    'a[href*="/download/"]',
    '#footer a[href*="/privacy-policy"]',
    '.thumbnail_270 > h2',
    'div.a, div.b',
    'a:hover',
  ]) {
    const result = safeCssSelector(selector);
    assert.equal(result.ok, true, selector);
    assert.equal(result.value, selector);
  }
});

test('⛔ 大括號會把我們的 { display:none } 關掉 → 一律拒絕', () => {
  const result = safeCssSelector('a} body');
  assert.equal(result.ok, false);
  assert.match(result.error, /\{|\}/);
});

test('⛔ 角括號會長出 </style> → 一律拒絕', () => {
  assert.equal(safeCssSelector('a</style><script>alert(1)</script>').ok, false);
});

test('⛔ CSS 註解可以把後面的宣告整段吃掉 → 拒絕 /* 與 */', () => {
  assert.equal(safeCssSelector('a /*').ok, false);
  assert.equal(safeCssSelector('*/ a').ok, false);
});

test('⛔ @ 會開出 at-rule（@import）→ 拒絕', () => {
  assert.equal(safeCssSelector('@import url(x)').ok, false);
});

test('⛔ 反斜線交給使用者寫就等於繞過上面所有檢查 → 拒絕', () => {
  assert.equal(safeCssSelector('a\\7d body').ok, false);
});

test('空的、太長的、有換行的都拒絕', () => {
  assert.equal(safeCssSelector('').ok, false);
  assert.equal(safeCssSelector('   ').ok, false);
  assert.equal(safeCssSelector('a'.repeat(300)).ok, false);
  assert.equal(safeCssSelector('a\nb').ok, false);
  assert.equal(safeCssSelector(null).ok, false);
});

test('非 ASCII 轉成 CSS escape —— 注入點是 latin1 管線，不能直接塞 UTF-8 byte', () => {
  const result = safeCssSelector('a[title="聯絡我們"]');

  assert.equal(result.ok, true);
  assert.equal(result.value, 'a[title="\\00806f\\007d61\\006211\\005011"]');
  // 整串都是 ASCII，插進任何 charset 的頁面都不會變亂碼
  assert.match(result.value, /^[\x20-\x7e]*$/);
});

test('escape 用固定 6 位 hex —— 少於 6 位時後面接的空白會被 CSS 吃掉', () => {
  assert.equal(escapeCssNonAscii('中 x'), '\\004e2d x');
  assert.equal(escapeCssNonAscii('abc'), 'abc');
});
