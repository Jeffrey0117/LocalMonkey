'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  containsSimplified,
  findSimplified,
  SIMPLIFIED_CHARS,
  EXTRA_SIMPLIFIED,
  NOT_SIMPLIFIED,
} = require('../../src/translate/simplified.js');

/**
 * SPEC-rules §5.1：**不要自己手寫字元清單** —— 我手寫的那份漏了「灯」「笼」
 * 「动」，所以第一次掃出 0 段是假的。
 *
 * 對照表是產生出來的（scripts/generate-simplified-chars.ps1 問 Windows 自己的
 * 簡繁轉換表），這裡測的是「真的抓得到實際在快取裡的那幾個字」以及
 * 「不要把正常的繁體誤判成簡體」。
 */

test('⛔ 實測在快取裡的那三個詞一定要抓到（第一版就是漏了這幾個字）', () => {
  for (const word of ['灯笼河', '动感', '幻灯片']) {
    assert.equal(containsSimplified(word), true, word);
  }

  assert.deepEqual(findSimplified('灯笼河'), ['灯', '笼']);
  assert.deepEqual(findSimplified('动感'), ['动']);
  assert.deepEqual(findSimplified('幻灯片'), ['灯']);
});

test('常見簡體字都抓得到', () => {
  for (const character of '发体国术丰个们时过这来说对开关实区医设计') {
    assert.equal(containsSimplified(character), true, character);
  }
});

test('什么 / 怎么 的「么」要抓到（它在兩邊都是合法字，所以靠補充清單）', () => {
  assert.equal(containsSimplified('什么'), true);
  assert.ok(EXTRA_SIMPLIFIED.has('么'));
});

test('⛔ 正常的繁體中文不准被誤判', () => {
  for (const text of [
    '免費 HTML CSS 網站模板',
    '超級齊全的 HTML CSS 網站模板',
    '自2008年起提供免費HTML CSS網站模板',
    '實時預覽',
    '下載',
    '燈河',
    '燈籠',
    '幻燈片',
    '動感',
    '繁體中文測試',
    '裡面有很多字',
    '關於 / 隱私政策 / 聯絡我們',
    'XML 網站地圖',
    '在線計時器',
    'AI 網站提示生成器',
    '響應式佈局與現代設計風格',
  ]) {
    assert.deepEqual(findSimplified(text), [], text);
  }
});

test('⛔ 台 不算簡體 —— 台灣 / 控制台 / 平台 在繁體裡天天用', () => {
  assert.equal(containsSimplified('台灣'), false);
  assert.equal(containsSimplified('控制台'), false);
  assert.ok(NOT_SIMPLIFIED.has('台'));
});

test('英文、數字、標點、空字串都不算', () => {
  for (const text of ['Free Templates', '2026', '---', '', null, undefined, 123]) {
    assert.equal(containsSimplified(text), false, String(text));
  }
});

test('同一個字出現兩次只回一次（UI 要列「有哪些字」）', () => {
  assert.deepEqual(findSimplified('灯灯灯笼'), ['灯', '笼']);
});

test('對照表大到足以當一份「成套的」表（手寫不可能到這個量）', () => {
  assert.ok(SIMPLIFIED_CHARS.size > 2000, `只有 ${SIMPLIFIED_CHARS.size} 個字`);
});

test('排除清單真的從對照表裡被拿掉了', () => {
  for (const character of NOT_SIMPLIFIED) {
    assert.equal(SIMPLIFIED_CHARS.has(character), false, character);
  }
});
