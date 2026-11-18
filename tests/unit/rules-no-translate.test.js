'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileRule, compileRules, activeNoTranslateRules, RULE_KINDS } = require('../../src/rules/compile.js');
const {
  createNoTranslateFilter,
  collectTranslatable,
  countNoTranslate,
} = require('../../src/rules/no-translate.js');
const { collectSegments } = require('../../src/translate/pipeline.js');

/**
 * SPEC-rules §12：`no-translate` ——「這些段不要翻」。
 *
 * ⛔ 這個型別存在的理由是 §10.3 的那個發現：**`hide` 藏掉的東西照樣會被翻**
 * （翻譯層跑在規則層之前），所以藏 ≠ 省時間。
 */

const rule = (overrides = {}) => ({
  id: 'r1',
  kind: 'no-translate',
  pattern: 'is 100% free',
  replacement: '',
  scope: null,
  note: null,
  enabled: true,
  order_index: 0,
  ...overrides,
});

/** 這組規則擋得掉哪些段？ */
function kept(html, rows) {
  const store = { siteRules: { listBySite: () => rows } };
  return collectTranslatable(html, { store, siteId: 's' });
}

test('no-translate 是合法的 kind', () => {
  assert.ok(RULE_KINDS.includes('no-translate'));
});

/* -------------------------------- 編譯 -------------------------------- */

test('字面 pattern：編得起來、沒有 error、不需要 replacement', () => {
  const compiled = compileRule(rule());

  assert.equal(compiled.error, null);
  assert.ok(compiled.matcher instanceof RegExp);
  assert.equal(compiled.scopeParsed, null);
});

test('/正則/ 形狀的 pattern 走正則，跟 text-rewrite 同一套保護', () => {
  assert.equal(compileRule(rule({ pattern: '/^\\d{2,4} /' })).error, null);

  // 嵌套量詞（指數級回溯）照樣擋 —— 規則層的三道保護不因型別而異
  assert.match(compileRule(rule({ pattern: '/(a+)+$/' })).error, /嵌套量詞/);
});

test('空 pattern 與過長 pattern 編不過（帶著 error 回去，不丟例外）', () => {
  assert.match(compileRule(rule({ pattern: '   ' })).error, /不能是空的/);
  assert.match(compileRule(rule({ pattern: 'x'.repeat(501) })).error, /最長/);
});

test('scope 看不懂就編不過（寧可標紅，也不要悄悄變成全站生效）', () => {
  assert.match(compileRule(rule({ scope: 'p:has(> a)' })).error, /scope 只支援/);
});

/**
 * ⛔ `*` 沒有 scope ＝「這個站一段都不要翻」。那個意思應該用站台設定的
 * `translate_enabled` 表達 —— 一條規則能靜默關掉整站翻譯是很糟的 footgun：
 * 使用者會去查 ollama，而真因是控制台裡的一條規則。
 */
test('⛔ * 一定要配 scope，不然編不過', () => {
  assert.match(compileRule(rule({ pattern: '*' })).error, /限定範圍/);
  assert.equal(compileRule(rule({ pattern: '*', scope: '#tm-dl-box' })).error, null);
});

test('編不過的規則不會進生效清單（壞規則什麼都不做，而不是全部不翻）', () => {
  const compiled = compileRules([
    rule({ id: 'ok' }),
    rule({ id: 'broken', pattern: '/(a|aa)+/' }),
    rule({ id: 'off', enabled: false }),
  ]);

  assert.deepEqual(
    activeNoTranslateRules(compiled).map((item) => item.id),
    ['ok'],
  );
});

/* -------------------------------- 比對 -------------------------------- */

test('命中的段不進翻譯清單，其他段一個都不少', () => {
  const html = '<p>Lumen Eighty is 100% free to download for anyone.</p><p>Hello world</p>';

  const before = collectSegments(html);
  const after = kept(html, [rule()]);

  assert.deepEqual(before.map((item) => item.text), [
    'Lumen Eighty is 100% free to download for anyone.',
    'Hello world',
  ]);
  assert.deepEqual(after.items.map((item) => item.text), ['Hello world']);
  assert.equal(after.skipped, 1);
});

test('字面比對是子字串、空白寬鬆、不分大小寫（沿用 text-replace 那一套）', () => {
  const html = '<p>IS   100%\n  FREE to download for anyone, really</p>';

  assert.equal(kept(html, [rule()]).items.length, 0);
});

/**
 * ⛔ 帶 `g` 旗標的 `RegExp` 的 `test()` 會把 `lastIndex` 往前推 —— 同一條規則
 * 比到第二段時就會從上一次的位置開始找。症狀是「有些段中、有些段不中」而且
 * 毫無規律。這條釘住「每一段都從頭比」。
 */
test('⛔ 同一條規則連續比好幾段，每一段都從頭比（lastIndex 不准殘留）', () => {
  const html = '<p>free stuff</p>'.repeat(4);

  assert.equal(kept(html, [rule({ pattern: 'free' })]).skipped, 4);
});

test('沒有任何 no-translate 規則時，切段結果跟原本一模一樣', () => {
  const html = '<p>Hello world</p><img alt="A cat">';
  const rows = [{ id: 'h', kind: 'hide', pattern: '.x', enabled: true, order_index: 0 }];

  assert.deepEqual(
    kept(html, rows).items.map((item) => item.text),
    collectSegments(html).map((item) => item.text),
  );
  assert.equal(kept(html, rows).skipped, 0);
});

test('停用的規則不生效', () => {
  const html = '<p>Lumen Eighty is 100% free to download</p>';

  assert.equal(kept(html, [rule({ enabled: false })]).items.length, 1);
});

/* -------------------------------- scope -------------------------------- */

test('scope 把規則限制在那個選擇器裡面', () => {
  const html = '<div id="box"><p>Skip this line</p></div><p>Skip this line too</p>';
  const after = kept(html, [rule({ pattern: 'Skip this', scope: '#box' })]);

  assert.deepEqual(after.items.map((item) => item.text), ['Skip this line too']);
});

test('* 配 scope ＝ 範圍內全部不翻（範圍外一段都不動）', () => {
  const html = '<div class="ad"><p>Buy now</p><p>Limited offer</p></div><p>Real content</p>';
  const after = kept(html, [rule({ pattern: '*', scope: '.ad' })]);

  assert.deepEqual(after.items.map((item) => item.text), ['Real content']);
  assert.equal(after.skipped, 2);
});

/**
 * 屬性段（alt / title / placeholder / aria-label）也算 —— 它們一樣會進佇列。
 * 屬性住在那個元素身上，所以元素自己也算祖先鏈的一節。
 */
test('alt / title 這些屬性段也吃得到規則，scope 認得元素自己', () => {
  const html = '<img class="ad-img" alt="Sponsored banner"><img alt="Sponsored banner too">';
  const after = kept(html, [rule({ pattern: 'Sponsored', scope: '.ad-img' })]);

  assert.deepEqual(after.items.map((item) => item.text), ['Sponsored banner too']);
});

/* ------------------------------ 命中數 ------------------------------ */

test('countNoTranslate：每條規則擋了幾段（控制台「試一下」用的）', () => {
  const html = '<p>is 100% free to download</p><div class="ad"><p>Buy now</p></div><p>Keep me</p>';
  const counts = countNoTranslate(
    html,
    compileRules([rule({ id: 'boiler' }), rule({ id: 'ads', pattern: '*', scope: '.ad' })]),
  );

  assert.deepEqual(counts, { boiler: 1, ads: 1 });
});

test('countNoTranslate：一條都沒有時回空物件（不是一堆 0）', () => {
  assert.deepEqual(countNoTranslate('<p>Hello world</p>', compileRules([])), {});
});

/**
 * 「省下的段數」要是**真的省到的工作量**，所以本來就不會被翻的段
 * （太短 / 純數字 / 已經是中文）不准算進去 —— 不然這個數字只是在膨脹。
 */
test('⛔ 本來就不會翻的段不算在「省下」裡面', () => {
  const html = '<p>42</p><p>免費下載</p>';
  const after = kept(html, [rule({ pattern: '*', scope: 'p' })]);

  assert.equal(after.items.length, 0);
  assert.equal(after.skipped, 0, '這兩段本來就被 isTranslatable 濾掉了');
});

/* ------------------------------ 祖先鏈 ------------------------------ */

/**
 * 祖先鏈要多算每個元素的 id 與 class，所以只有真的有 scope 的規則才會要它。
 */
test('沒有 scope 的規則不需要祖先鏈（不白算）', () => {
  assert.equal(createNoTranslateFilter([rule()]).needsAncestors, false);
  assert.equal(createNoTranslateFilter([rule({ scope: '#box' })]).needsAncestors, true);
});

test('一條規則都沒有就回 null（呼叫端才知道可以完全跳過）', () => {
  assert.equal(createNoTranslateFilter([]), null);
  assert.equal(createNoTranslateFilter([rule({ enabled: false })]), null);
});
