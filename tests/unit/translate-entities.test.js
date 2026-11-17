'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decodeEntities, encodeEntities } = require('../../src/translate/entities.js');

/**
 * 規格 §3：**先還原再翻、翻完再編碼**。
 * 不然 `&amp;` 會被當成文字翻掉、`&nbsp;` 會消失。
 *
 * U+00A0（不換行空白）一律用 `String.fromCharCode(160)` 取得 ——
 * 在原始碼裡寫那個字元的字面值是看不見的坑（CLAUDE.md 地雷 13），
 * 而 ` ` 的轉義經過 shell / heredoc 又很容易被吃掉。
 */

const NBSP = String.fromCharCode(160);

test('decode：規格點名的六個 entity 都還原', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(decodeEntities('a &lt;b&gt; c'), 'a <b> c');
  assert.equal(decodeEntities('say &quot;hi&quot;'), 'say "hi"');
  assert.equal(decodeEntities('it&#39;s'), "it's");
  assert.equal(decodeEntities('it&apos;s'), "it's");
  assert.equal(decodeEntities('a&nbsp;b'), `a${NBSP}b`);
});

test('decode：大小寫與 &#x27; 的寫法也認', () => {
  assert.equal(decodeEntities('&AMP;&NBSP;'), `&${NBSP}`);
  assert.equal(decodeEntities('it&#x27;s'), "it's");
  assert.equal(decodeEntities('a&#X27;b'), "a'b");
});

test('⛔ decode：不認識的 entity 原樣留著（規格：其餘保持原樣不動）', () => {
  assert.equal(decodeEntities('&copy; 2026 &mdash; x'), '&copy; 2026 &mdash; x');
  assert.equal(decodeEntities('&notanentity'), '&notanentity');
});

test('encode：會被當成標記的字元跳脫回去', () => {
  assert.equal(encodeEntities('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(encodeEntities('a <b> c'), 'a &lt;b&gt; c');
  assert.equal(encodeEntities(`a${NBSP}b`), 'a&nbsp;b');
});

test('⛔ encode 不准把已經是 entity 的 `&` 再跳脫一次（&copy; → &amp;copy; 是看得見的壞掉）', () => {
  assert.equal(encodeEntities('&copy; 2026'), '&copy; 2026');
  assert.equal(encodeEntities('&amp;'), '&amp;');
  assert.equal(encodeEntities('&#169;'), '&#169;');
  assert.equal(encodeEntities('&#x27;'), '&#x27;');

  // 但孤零零的 & 還是要跳脫
  assert.equal(encodeEntities('A & B'), 'A &amp; B');
  assert.equal(encodeEntities('tom&jerry'), 'tom&amp;jerry');
});

test('encode：屬性模式要連引號一起跳脫（值是放在引號裡面的）', () => {
  assert.equal(encodeEntities('say "hi"', { attribute: true }), 'say &quot;hi&quot;');
  assert.equal(encodeEntities("it's", { attribute: true }), 'it&#39;s');

  // 文字節點模式不必動引號（HTML 裡的裸引號是合法的）
  assert.equal(encodeEntities('say "hi"'), 'say "hi"');
});

test('decode → encode 來回不會累積跳脫（翻譯沒動到的字元要原樣回去）', () => {
  for (const original of ['Tom &amp; Jerry', 'a &lt;b&gt; c', '&copy; 2026', 'a&nbsp;b']) {
    assert.equal(encodeEntities(decodeEntities(original)), original, original);
  }
});
