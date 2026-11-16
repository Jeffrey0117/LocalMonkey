'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseMetadataBlock, single, values } = require('../../src/userscript/metadata.js');

const BLOCK = [
  '// ==UserScript==',
  '// @name         範例腳本',
  '// @namespace    http://tampermonkey.net/',
  '// @version      1.2.3',
  '// @match        https://www.example.com/*',
  '// @match        https://seller.example.com/items/*',
  '// @grant        GM_setValue',
  '// ==/UserScript==',
  '',
  "console.log('hi');",
].join('\n');

test('抓出 metadata block 裡的 key/value', () => {
  const parsed = parseMetadataBlock(BLOCK);

  assert.equal(parsed.hasBlock, true);
  assert.equal(single(parsed.raw, 'name'), '範例腳本');
  assert.equal(single(parsed.raw, 'version'), '1.2.3');
  assert.equal(single(parsed.raw, 'namespace'), 'http://tampermonkey.net/');
});

test('同一個 key 出現多次 → 收成陣列，保持宣告順序', () => {
  const parsed = parseMetadataBlock(BLOCK);

  assert.deepEqual(values(parsed.raw, 'match'), [
    'https://www.example.com/*',
    'https://seller.example.com/items/*',
  ]);
});

test('沒有 metadata block → hasBlock false，但不丟錯', () => {
  const parsed = parseMetadataBlock("document.title = 'x';");

  assert.equal(parsed.hasBlock, false);
  assert.deepEqual(parsed.raw, {});
  assert.equal(single(parsed.raw, 'name'), null);
  assert.deepEqual(values(parsed.raw, 'match'), []);
});

test('非字串輸入不會炸', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    const parsed = parseMetadataBlock(input);
    assert.equal(parsed.hasBlock, false);
  }
});

test('CRLF 換行一樣解析得出來', () => {
  const parsed = parseMetadataBlock(BLOCK.replace(/\n/g, '\r\n'));

  assert.equal(parsed.hasBlock, true);
  assert.equal(single(parsed.raw, 'version'), '1.2.3');
  assert.equal(values(parsed.raw, 'match').length, 2);
  assert.equal(single(parsed.raw, 'name'), '範例腳本', 'value 結尾不該殘留 \\r');
});

test('開頭有 BOM 也找得到 block', () => {
  const parsed = parseMetadataBlock(`﻿${BLOCK}`);

  assert.equal(parsed.hasBlock, true);
  assert.equal(single(parsed.raw, 'name'), '範例腳本');
});

test('每行前後的奇怪空白、tab、沒有空格的 //@key 都要吃得下', () => {
  const parsed = parseMetadataBlock(
    [
      '   // ==UserScript==',
      '\t//   @name\t\t有 tab 的名字   ',
      '//@version 9.9',
      '  //  @match   https://a.test/*  ',
      '// ==/UserScript==',
    ].join('\n'),
  );

  assert.equal(parsed.hasBlock, true);
  assert.equal(single(parsed.raw, 'name'), '有 tab 的名字');
  assert.equal(single(parsed.raw, 'version'), '9.9');
  assert.deepEqual(values(parsed.raw, 'match'), ['https://a.test/*']);
});

test('@name:zh-TW 這類 locale 變體：single 取無 locale 的那個', () => {
  const parsed = parseMetadataBlock(
    [
      '// ==UserScript==',
      '// @name:zh-TW  中文名字',
      '// @name        Canonical Name',
      '// @name:ja     にほんご',
      '// ==/UserScript==',
    ].join('\n'),
  );

  assert.equal(single(parsed.raw, 'name'), 'Canonical Name');
  assert.equal(single(parsed.raw, 'name:zh-tw'), '中文名字');
});

test('只有 locale 變體、沒有無 locale 的 @name → single 退回第一個變體', () => {
  const parsed = parseMetadataBlock(
    ['// ==UserScript==', '// @name:zh-TW  只有中文', '// ==/UserScript=='].join('\n'),
  );

  assert.equal(single(parsed.raw, 'name'), '只有中文');
});

test('沒有 value 的 key（@noframes）→ 空字串，但 key 存在', () => {
  const parsed = parseMetadataBlock(
    ['// ==UserScript==', '// @noframes', '// ==/UserScript=='].join('\n'),
  );

  assert.deepEqual(values(parsed.raw, 'noframes'), ['']);
  assert.equal(single(parsed.raw, 'noframes'), '');
});

test('block 結束後出現的 // @match 不算（不是 metadata）', () => {
  const parsed = parseMetadataBlock(
    [
      '// ==UserScript==',
      '// @match https://inside.test/*',
      '// ==/UserScript==',
      '// @match https://outside.test/*',
    ].join('\n'),
  );

  assert.deepEqual(values(parsed.raw, 'match'), ['https://inside.test/*']);
});

test('block 前面有其他註解也找得到', () => {
  const parsed = parseMetadataBlock(
    ['/* 著作權宣告 */', '// 隨手寫的註解', '// ==UserScript==', '// @name x', '// ==/UserScript=='].join(
      '\n',
    ),
  );

  assert.equal(parsed.hasBlock, true);
  assert.equal(single(parsed.raw, 'name'), 'x');
});

test('有兩個 block 時只採用第一個', () => {
  const parsed = parseMetadataBlock(
    [
      '// ==UserScript==',
      '// @name 第一個',
      '// ==/UserScript==',
      '// ==UserScript==',
      '// @name 第二個',
      '// ==/UserScript==',
    ].join('\n'),
  );

  assert.deepEqual(values(parsed.raw, 'name'), ['第一個']);
});

test('沒有結束標記 → 當成沒有 block（寧可走手動路徑也不要半套解析）', () => {
  const parsed = parseMetadataBlock(
    ['// ==UserScript==', '// @name 沒收尾', '', "console.log('x')"].join('\n'),
  );

  assert.equal(parsed.hasBlock, false);
});

test('block 裡的非 @ 註解行被忽略', () => {
  const parsed = parseMetadataBlock(
    [
      '// ==UserScript==',
      '// 這行是給人看的說明',
      '// @name x',
      '// ==/UserScript==',
    ].join('\n'),
  );

  assert.deepEqual(Object.keys(parsed.raw), ['name']);
});

test('key 大小寫不敏感（@Match 等於 @match）', () => {
  const parsed = parseMetadataBlock(
    ['// ==UserScript==', '// @Match https://a.test/*', '// @RUN-AT document-start', '// ==/UserScript=='].join(
      '\n',
    ),
  );

  assert.deepEqual(values(parsed.raw, 'match'), ['https://a.test/*']);
  assert.equal(single(parsed.raw, 'run-at'), 'document-start');
});

test('raw 是不可變的（凍結），呼叫端改不到解析結果', () => {
  const parsed = parseMetadataBlock(BLOCK);

  assert.throws(() => {
    parsed.raw.injected = ['x'];
  }, TypeError);
});

test('@resource 的 value 保留內部空白（name + url）', () => {
  const parsed = parseMetadataBlock(
    ['// ==UserScript==', '// @resource  logo   https://cdn.test/logo.png', '// ==/UserScript=='].join(
      '\n',
    ),
  );

  assert.equal(single(parsed.raw, 'resource'), 'logo   https://cdn.test/logo.png');
});
