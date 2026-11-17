'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isAcceptableIconType,
  faviconCandidates,
  PLACEHOLDER_SVG,
  PLACEHOLDER_CONTENT_TYPE,
} = require('../../src/services/favicon.js');

test('只收點陣圖：ico / png / jpeg / gif / webp', () => {
  for (const type of [
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/png; charset=binary',
    'IMAGE/PNG',
  ]) {
    assert.equal(isAcceptableIconType(type), true, type);
  }
});

test('⛔ 第三方的 SVG 一律拒收（SVG 可以內含 script，而它會從我們的 origin 送出去）', () => {
  assert.equal(isAcceptableIconType('image/svg+xml'), false);
  assert.equal(isAcceptableIconType('image/svg+xml; charset=utf-8'), false);
});

test('不是圖片的一律拒收（上游常常用 200 回一頁 HTML 當 404）', () => {
  for (const type of ['text/html', 'application/json', 'text/plain', '', null, undefined]) {
    assert.equal(isAcceptableIconType(type), false, String(type));
  }
});

test('候選網址：先 /favicon.ico 再 /apple-touch-icon.png', () => {
  assert.deepEqual(faviconCandidates('https://www.example.com'), [
    'https://www.example.com/favicon.ico',
    'https://www.example.com/apple-touch-icon.png',
  ]);
});

test('target_origin 壞掉時沒有候選（不要丟錯，列表照樣要畫得出來）', () => {
  assert.deepEqual(faviconCandidates('這不是 origin'), []);
  assert.deepEqual(faviconCandidates(null), []);
});

test('佔位圖是 SVG 而且不含 script（它從我們自己的 origin 送出去）', () => {
  assert.match(PLACEHOLDER_CONTENT_TYPE, /^image\/svg\+xml/);
  assert.match(PLACEHOLDER_SVG, /^<svg/);
  assert.equal(/<script|onload=|href=/i.test(PLACEHOLDER_SVG), false);
});
