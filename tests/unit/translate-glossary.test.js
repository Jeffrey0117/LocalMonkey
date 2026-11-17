'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_GLOSSARY,
  normalizeGlossary,
  parseGlossary,
  serializeGlossary,
  containsTerm,
  MAX_TERMS,
} = require('../../src/translate/glossary.js');

/** 規格 §7：術語表「一行一個詞」，預設帶常見的技術詞。 */

test('預設術語表帶得動規格點名的那些詞', () => {
  for (const term of ['HTML', 'CSS', 'JS', 'Bootstrap', 'Tailwind', 'React', 'Vue', 'AI', 'API', 'URL', 'SEO']) {
    assert.ok(DEFAULT_GLOSSARY.includes(term), `預設術語表少了 ${term}`);
  }
});

test('normalizeGlossary：吃陣列也吃「一行一個」的字串', () => {
  assert.deepEqual(normalizeGlossary(['HTML', 'CSS']), ['HTML', 'CSS']);
  assert.deepEqual(normalizeGlossary('HTML\nCSS\r\nBootstrap'), ['HTML', 'CSS', 'Bootstrap']);
  assert.deepEqual(normalizeGlossary('  HTML  \n\n  CSS '), ['HTML', 'CSS']);
});

test('normalizeGlossary：去重（不分大小寫，保留第一次出現的寫法）、丟掉空的', () => {
  assert.deepEqual(normalizeGlossary(['HTML', 'html', 'HTML', '']), ['HTML']);
  assert.deepEqual(normalizeGlossary([null, 42, 'CSS', {}]), ['CSS']);
});

test('normalizeGlossary：有數量與長度上限（這是使用者自由輸入的欄位）', () => {
  const many = Array.from({ length: MAX_TERMS + 50 }, (unused, index) => `term${index}`);
  assert.equal(normalizeGlossary(many).length, MAX_TERMS);

  assert.deepEqual(normalizeGlossary(['x'.repeat(200)]), []);
});

test('parseGlossary / serializeGlossary：DB 欄位是 JSON 陣列', () => {
  assert.equal(serializeGlossary(['HTML', 'CSS']), '["HTML","CSS"]');
  assert.deepEqual(parseGlossary('["HTML","CSS"]'), ['HTML', 'CSS']);
});

test('parseGlossary：壞資料回預設的空陣列，不丟錯（DB 可能被手改過）', () => {
  for (const input of [null, undefined, '', 'not json', '{"a":1}', '42']) {
    assert.deepEqual(parseGlossary(input), [], JSON.stringify(input));
  }
});

test('containsTerm：句子裡有沒有術語（要給模型的保留清單用）', () => {
  const glossary = ['HTML', 'Bootstrap'];

  assert.equal(containsTerm('Built with Bootstrap', glossary), true);
  assert.equal(containsTerm('built with bootstrap', glossary), true);
  assert.equal(containsTerm('Learn CSS', glossary), false);
});

test('⛔ containsTerm 只認完整的詞（不然 AI 會命中 Maintain、API 會命中 Rapid）', () => {
  assert.equal(containsTerm('We maintain things', ['AI']), false);
  assert.equal(containsTerm('Rapid delivery', ['API']), false);
  assert.equal(containsTerm('Powered by AI, obviously', ['AI']), true);
  assert.equal(containsTerm('Use the API.', ['API']), true);
});

test('⛔ 術語裡的正則特殊字元不會變成 pattern（Node.js、C++ 都有）', () => {
  assert.doesNotThrow(() => containsTerm('Runs on Node.js', ['Node.js', 'C++', '(', '[a-z]']));
  assert.equal(containsTerm('Runs on Node.js', ['Node.js']), true);
  assert.equal(containsTerm('Runs on NodeXjs', ['Node.js']), false, '`.` 不准當萬用字元');
});
