'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScope, matchesScope } = require('../../src/rules/scope.js');
const { segmentHtml } = require('../../src/translate/segment.js');

/** 一段文字的祖先鏈（最外層在前） */
function chainOf(html, text) {
  const segment = segmentHtml(html, { ancestors: true }).find((item) => item.raw.includes(text));
  assert.ok(segment, `找不到「${text}」這一段`);
  return segment.ancestors;
}

test('#id 比對到祖先就算在範圍內', () => {
  const html = '<div id="footer"><a href="/about">About</a> - x</div>';
  const scope = parseScope('#footer');

  assert.equal(scope.ok, true);
  assert.equal(matchesScope(chainOf(html, 'About'), scope.value), true);
  assert.equal(matchesScope(chainOf(html, '- x'), scope.value), true);
});

test('.class 比對；不在範圍內的段不算', () => {
  const html = '<div class="thumbnail_270"><h2>634 Lantern River</h2></div><h2>620+ Templates</h2>';
  const scope = parseScope('.thumbnail_270 h2');

  assert.equal(matchesScope(chainOf(html, '634'), scope.value), true);
  assert.equal(matchesScope(chainOf(html, '620+'), scope.value), false);
});

test('後代選擇器可以跨好幾層', () => {
  const html = '<div class="a"><div><section><p>deep</p></section></div></div>';
  assert.equal(matchesScope(chainOf(html, 'deep'), parseScope('.a p').value), true);
});

test('子選擇器 > 只認直接父子', () => {
  const html = '<div class="a"><div><p>deep</p></div></div><div class="a"><p>shallow</p></div>';

  const scope = parseScope('.a > p').value;
  assert.equal(matchesScope(chainOf(html, 'deep'), scope), false);
  assert.equal(matchesScope(chainOf(html, 'shallow'), scope), true);
});

test('逗號是「或」', () => {
  const html = '<div id="footer">a</div>';
  assert.equal(matchesScope(chainOf(html, 'a'), parseScope('#nope, #footer').value), true);
});

test('多個 class 寫在一起要全部符合', () => {
  const html = '<div class="card big"><p>both</p></div><div class="card"><p>one</p></div>';

  const scope = parseScope('.card.big p').value;
  assert.equal(matchesScope(chainOf(html, 'both'), scope), true);
  assert.equal(matchesScope(chainOf(html, 'one'), scope), false);
});

test('tag 與 * 都認得', () => {
  const html = '<main><p>x</p></main>';
  assert.equal(matchesScope(chainOf(html, 'x'), parseScope('main p').value), true);
  assert.equal(matchesScope(chainOf(html, 'x'), parseScope('*').value), true);
});

test('屬性段的祖先鏈含它自己所在的元素', () => {
  const html = '<div class="templatemo-logo"><img alt="templatemo logo"></div>';
  const segment = segmentHtml(html, { ancestors: true })[0];

  assert.equal(segment.kind, 'attribute');
  assert.equal(matchesScope(segment.ancestors, parseScope('.templatemo-logo img').value), true);
});

test('⛔ 認不出來的語法一律拒絕，不要猜 —— 猜錯＝規則套在整站', () => {
  for (const selector of ['p + p', 'p ~ p', 'a:hover', '[data-x]', 'p::before', '   ', 'a > > b']) {
    assert.equal(parseScope(selector).ok, false, selector);
  }
});

test('沒有 scope（null / 空字串）代表全站，matchesScope 一律 true', () => {
  assert.equal(matchesScope([{ tag: 'p', id: null, classes: [] }], null), true);
});
