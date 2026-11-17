'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  splitEdges,
  normalizeSpace,
  isTranslatable,
  MIN_LENGTH,
} = require('../../src/translate/rules.js');

/** 規格 §3「不翻的段（漏了會出事）」。 */

test('splitEdges：前後空白拆出來，中間原樣', () => {
  assert.deepEqual(splitEdges('\n   Hello world  \t'), {
    lead: '\n   ',
    core: 'Hello world',
    trail: '  \t',
  });
  assert.deepEqual(splitEdges('Hello'), { lead: '', core: 'Hello', trail: '' });
  assert.deepEqual(splitEdges('   '), { lead: '   ', core: '', trail: '' });
  assert.deepEqual(splitEdges(''), { lead: '', core: '', trail: '' });
});

test('splitEdges：不換行空白也算邊緣空白（HTML 裡很常見）', () => {
  const nbsp = String.fromCharCode(160);
  assert.deepEqual(splitEdges(`${nbsp}Read more${nbsp}`), {
    lead: nbsp,
    core: 'Read more',
    trail: nbsp,
  });
});

test('normalizeSpace：連續空白正規化後才比對（規格 §3）', () => {
  assert.equal(normalizeSpace('Hello     world'), 'Hello world');
  assert.equal(normalizeSpace('Hello\n   \tworld'), 'Hello world');
  assert.equal(normalizeSpace('  trimmed  '), 'trimmed');
});

test('一般的句子與 UI 字串要翻', () => {
  for (const text of [
    'Hello world',
    'Contact',
    'Read More',
    'Our Team',
    '620+ Free CSS Templates',
    'Sign up for our newsletter',
  ]) {
    assert.equal(isTranslatable(text), true, text);
  }
});

test('⛔ 太短的不翻（規格：長度 < 2）', () => {
  assert.equal(MIN_LENGTH, 2);
  assert.equal(isTranslatable('A'), false);
  assert.equal(isTranslatable('x'), false);
  assert.equal(isTranslatable(''), false);
  assert.equal(isTranslatable('Hi'), true);
});

test('⛔ 空白、純數字、純符號不翻', () => {
  for (const text of [
    '',
    '   ',
    '123',
    '2026',
    '620+',
    '1,234.56',
    '$49',
    '|',
    '»',
    '· · ·',
    '→',
    '—',
    '()',
    '2026-11-18',
    '12:30',
  ]) {
    assert.equal(isTranslatable(text), false, JSON.stringify(text));
  }
});

test('⛔ URL 與 email 不翻', () => {
  for (const text of [
    'https://templatemo.com/page/3',
    'http://example.com',
    'www.templatemo.com',
    '//cdn.example.com/a.js',
    '/about-us/index.html',
    'mailto:info@example.com',
    'info@example.com',
    'first.last+tag@sub.example.co.uk',
  ]) {
    assert.equal(isTranslatable(text), false, text);
  }

  // 但句子裡「含有」網址的還是要翻（整段看起來是網址才跳過）
  assert.equal(isTranslatable('Visit https://example.com for more'), true);
});

test('⛔ 已經含中日韓字元的不翻（二次翻譯會把中文翻壞）', () => {
  for (const text of [
    '聯絡我們',
    'Hello 世界',
    'ひらがな',
    'カタカナ',
    '한국어',
    'CSS 範本',
    'ㄅㄆㄇ',
  ]) {
    assert.equal(isTranslatable(text), false, text);
  }
});

test('⛔ 術語表裡的整段不翻', () => {
  const glossary = ['Bootstrap', 'Templatemo'];

  assert.equal(isTranslatable('Bootstrap', { glossary }), false);
  assert.equal(isTranslatable('bootstrap', { glossary }), false, '比對不分大小寫');
  assert.equal(isTranslatable('  Templatemo  ', { glossary }), false, '比對前先 trim');

  // 只是「含有」術語的句子照翻（不然整站幾乎都不會翻）
  assert.equal(isTranslatable('Built with Bootstrap 5', { glossary }), true);
});

test('⛔ 只剩 entity 名稱的段不翻（&copy; 餵給模型只會被亂改）', () => {
  assert.equal(isTranslatable('&copy; 2026'), false);
  assert.equal(isTranslatable('&nbsp;'), false);
  assert.equal(isTranslatable('&raquo;'), false);
  assert.equal(isTranslatable('&copy; 2026 Our Company'), true, '還有真文字就要翻');
});

test('⛔ 解碼失敗的段不翻（頁面宣稱 UTF-8 但其實不是 → 餵進去就是垃圾）', () => {
  const replacement = String.fromCharCode(0xfffd);
  assert.equal(isTranslatable(`Hello ${replacement} world`), false);
});

test('⛔ 太長的段不翻（一段 2000 字的 JSON blob 會把一整批拖垮）', () => {
  assert.equal(isTranslatable('word '.repeat(400).trim()), false);
  assert.equal(isTranslatable('word '.repeat(50).trim()), true);
});

test('非字串輸入一律 false', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.equal(isTranslatable(input), false);
  }
});
