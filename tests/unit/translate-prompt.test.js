'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPrompt, payloadFor, LANGUAGE_NAMES } = require('../../src/translate/prompt.js');

/** 規格 §1：請求格式是 `{"0": "原文", "1": "原文", ...}`，索引當 key。 */

test('payloadFor：索引當 key 的 object（不是陣列 —— 陣列實測會整批錯位）', () => {
  assert.deepEqual(payloadFor(['One', 'Two']), { 0: 'One', 1: 'Two' });
  assert.equal(Array.isArray(payloadFor(['One'])), false);
});

test('prompt 裡有原文、目標語言，而且要求同樣的 key', () => {
  const prompt = buildPrompt(['Contact'], { targetLang: 'zh-TW' });

  assert.match(prompt, /"0":\s*"Contact"/);
  assert.match(prompt, /繁體中文/);
  assert.match(prompt, /"0"/);
});

test('目標語言認得 zh-TW / zh-CN / en / ja，不認識的原樣帶進去', () => {
  assert.equal(LANGUAGE_NAMES['zh-TW'], '繁體中文');

  assert.match(buildPrompt(['x'], { targetLang: 'zh-CN' }), /简体中文|简體中文/);
  assert.match(buildPrompt(['x'], { targetLang: 'ja' }), /日本語/);
  assert.match(buildPrompt(['x'], { targetLang: 'xx-YY' }), /xx-YY/);
});

test('預設就是繁體中文（使用者原話：「繁體 對」）', () => {
  assert.match(buildPrompt(['x'], {}), /繁體中文/);
});

test('術語表裡「這一批真的用到」的詞才進 prompt（不然每批都拖一串無關指示）', () => {
  const glossary = ['Bootstrap', 'Tailwind', 'React'];
  const prompt = buildPrompt(['Built with Bootstrap'], { targetLang: 'zh-TW', glossary });

  assert.match(prompt, /Bootstrap/);
  assert.equal(/Tailwind/.test(prompt), false);
  assert.equal(/React/.test(prompt), false);
});

test('沒用到任何術語時 prompt 裡沒有保留清單那一段', () => {
  const prompt = buildPrompt(['Hello world'], { targetLang: 'zh-TW', glossary: ['Bootstrap'] });

  assert.equal(/原樣保留/.test(prompt), false);
});

test('⛔ prompt 裡的原文一律走 JSON.stringify（引號 / 換行 / 反斜線不准破壞結構）', () => {
  const prompt = buildPrompt(['He said "hi"', 'a\\b', 'line1\nline2'], { targetLang: 'zh-TW' });

  // prompt 裡那段 JSON 一定要 parse 得回來
  const start = prompt.indexOf('{');
  const end = prompt.lastIndexOf('}');

  assert.doesNotThrow(() => JSON.parse(prompt.slice(start, end + 1)));
  assert.deepEqual(JSON.parse(prompt.slice(start, end + 1)), {
    0: 'He said "hi"',
    1: 'a\\b',
    2: 'line1\nline2',
  });
});

test('prompt 明確交代「不要加解釋」與「key 要一模一樣」（錯位的主要來源）', () => {
  const prompt = buildPrompt(['x'], { targetLang: 'zh-TW' });

  assert.match(prompt, /不要|禁止/);
  assert.match(prompt, /key/i);
});
