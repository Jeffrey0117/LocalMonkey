'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchGlob } = require('../../src/lib/glob.js');

test('bare * 當成 match-all（match_glob 的預設值必須匹配任何 path）', () => {
  assert.equal(matchGlob('*', '/'), true);
  assert.equal(matchGlob('*', '/a/b/c.html'), true);
  assert.equal(matchGlob('*', ''), true);
});

test('** 跨越斜線', () => {
  assert.equal(matchGlob('/shop/**', '/shop/a/b/c'), true);
  assert.equal(matchGlob('/shop/**', '/shop/'), true);
  assert.equal(matchGlob('/shop/**', '/other/a'), false);
});

test('單個 * 不跨越斜線', () => {
  assert.equal(matchGlob('/shop/*', '/shop/item'), true);
  assert.equal(matchGlob('/shop/*', '/shop/item/42'), false);
  assert.equal(matchGlob('/*.js', '/app.js'), true);
  assert.equal(matchGlob('/*.js', '/assets/app.js'), false);
});

test('? 匹配單一個非斜線字元', () => {
  assert.equal(matchGlob('/page?.html', '/page1.html'), true);
  assert.equal(matchGlob('/page?.html', '/page12.html'), false);
  assert.equal(matchGlob('/page?.html', '/page/.html'), false);
});

test('regex 特殊字元被當成字面值', () => {
  assert.equal(matchGlob('/a+b(c)', '/a+b(c)'), true);
  assert.equal(matchGlob('/a.b', '/axb'), false);
  assert.equal(matchGlob('/price$', '/price$'), true);
});

test('query string 不參與比對（呼叫端傳 pathname）', () => {
  assert.equal(matchGlob('/search', '/search'), true);
});

test('沒帶開頭斜線的 pattern 也能比對（自動補）', () => {
  assert.equal(matchGlob('shop/**', '/shop/a'), true);
  assert.equal(matchGlob('index.html', '/index.html'), true);
});

test('無效輸入不會爆，回 false', () => {
  assert.equal(matchGlob(undefined, '/a'), false);
  assert.equal(matchGlob('/a', undefined), false);
  assert.equal(matchGlob(null, null), false);
});

test('完整 path 要整段匹配，不是前綴匹配', () => {
  assert.equal(matchGlob('/shop', '/shop/extra'), false);
  assert.equal(matchGlob('/shop', '/shop'), true);
});
