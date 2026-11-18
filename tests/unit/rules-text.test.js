'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileRule, compileRules } = require('../../src/rules/compile.js');
const { applyRulesToText } = require('../../src/rules/text.js');

/** 跑一次規則，回改寫後的文字 */
function run(text, rows, ancestors = [{ tag: 'p', id: null, classes: [] }]) {
  const compiled = compileRules(rows).filter((rule) => rule.enabled && !rule.error);
  return applyRulesToText(text, compiled, { ancestors }).text;
}

const replace = (pattern, replacement, extra = {}) => ({
  id: `r-${pattern}`,
  kind: 'text-replace',
  pattern,
  replacement,
  enabled: true,
  order_index: 0,
  ...extra,
});

const rewrite = (pattern, replacement, extra = {}) => ({
  ...replace(pattern, replacement, extra),
  kind: 'text-rewrite',
});

/* ------------------------------- text-replace ------------------------------ */

test('字面取代：出現幾次就換幾次', () => {
  assert.equal(
    run('templatemo 是 templatemo', [replace('templatemo', 'templatee')]),
    'templatee 是 templatee',
  );
});

test('完全相同的大小寫 → 替換字原樣用', () => {
  assert.equal(
    run('免費 HTML CSS 網站模板', [replace('免費 HTML CSS 網站模板', '超級齊全的 HTML CSS 網站模板')]),
    '超級齊全的 HTML CSS 網站模板',
  );
});

test('大小寫風格要跟著原文走（規格 §3.5）', () => {
  const rules = [replace('templatemo', 'templatee')];

  assert.equal(run('TemplateMo', rules), 'Templatee');
  assert.equal(run('TEMPLATEMO', rules), 'TEMPLATEE');
  assert.equal(run('templatemo', rules), 'templatee');
  assert.equal(run('Free templates by TemplateMo', rules), 'Free templates by Templatee');
});

test('字面比對容忍空白的寫法差異（換行、多個空白都算一個）', () => {
  assert.equal(
    run('免費 HTML\n  CSS 網站模板', [replace('免費 HTML CSS 網站模板', '新文案')]),
    '新文案',
  );
});

test('⛔ 字面 pattern 裡的正則字元是字面的，不是語法', () => {
  assert.equal(run('a.c', [replace('a.c', 'X')]), 'X');
  assert.equal(run('abc', [replace('a.c', 'X')]), 'abc');
});

/* ------------------------------- text-rewrite ------------------------------ */

test('正則改寫 + $1 回填（規格 §3.2 的卡片標題）', () => {
  assert.equal(
    run('634 燈河', [rewrite('^(\\d{2,4})\\s+(.+)$', '$2[$1]')]),
    '燈河[634]',
  );
});

test('沒命中就原樣不動', () => {
  assert.equal(run('燈河', [rewrite('^(\\d{2,4})\\s+(.+)$', '$2[$1]')]), '燈河');
});

test('/正則/旗標 的寫法也吃', () => {
  assert.equal(run('AAA', [rewrite('/a/gi', 'b')]), 'bbb');
  assert.equal(run('AAA', [rewrite('/a/g', 'b')]), 'AAA');
});

test('改寫成空字串是合法的（footer 的孤兒分隔符就是這樣收掉的）', () => {
  assert.equal(run('-', [rewrite('\\s*-\\s*$', '')]), '');
  assert.equal(run('- 自2008年起 -', [rewrite('\\s*-\\s*$', '')]), '- 自2008年起');
});

/* --------------------------------- 範圍 / 順序 ------------------------------ */

test('scope 限定：只對該選擇器內的段生效', () => {
  const rule = rewrite('^(\\d+)\\s+(.+)$', '$2[$1]', { scope: '.thumbnail_270 h2' });
  const inside = [
    { tag: 'div', id: null, classes: ['thumbnail_270'] },
    { tag: 'h2', id: null, classes: [] },
  ];
  const outside = [{ tag: 'h1', id: null, classes: [] }];

  assert.equal(applyRulesToText('634 燈河', compileRules([rule]), { ancestors: inside }).text, '燈河[634]');
  assert.equal(applyRulesToText('634 燈河', compileRules([rule]), { ancestors: outside }).text, '634 燈河');
});

test('照 order_index 依序套用，後面的規則看到的是前面的結果', () => {
  const rules = [
    replace('b', 'c', { id: 'second', order_index: 2 }),
    replace('a', 'b', { id: 'first', order_index: 1 }),
  ];

  assert.equal(run('a', rules), 'c');
});

test('停用的規則不生效', () => {
  assert.equal(run('templatemo', [replace('templatemo', 'templatee', { enabled: false })]), 'templatemo');
});

test('hide 規則不會動到文字', () => {
  assert.equal(
    run('templatemo', [{ id: 'h', kind: 'hide', pattern: '.tm-menu', enabled: true, order_index: 0 }]),
    'templatemo',
  );
});

/* ------------------------------ 壞規則的保護 ------------------------------ */

test('正則編譯失敗 → 該規則帶著 error，不丟例外', () => {
  const compiled = compileRule(rewrite('(unclosed', 'x'));

  assert.equal(typeof compiled.error, 'string');
  assert.equal(compiled.matcher, null);
});

test('一條壞規則不影響其他規則', () => {
  const rules = [rewrite('(unclosed', 'x', { id: 'bad', order_index: 1 }), replace('a', 'b', { order_index: 2 })];
  assert.equal(run('a', rules), 'b');
});

test('⛔ 嵌套量詞會指數級回溯 → 編譯階段就拒絕', () => {
  for (const pattern of ['(a+)+$', '(a*)*b', '(\\s+)+x', '(a|aa)+$']) {
    const compiled = compileRule(rewrite(pattern, 'x'));
    assert.equal(compiled.matcher, null, pattern);
    assert.match(compiled.error, /回溯|量詞/);
  }
});

test('正常的量詞不要被誤殺', () => {
  for (const pattern of ['^(\\d{2,4})\\s+(.+)$', '\\s*-\\s*$', '(foo|bar)', 'a+b*', '(abc)+']) {
    assert.equal(compileRule(rewrite(pattern, 'x')).error, null, pattern);
  }
});

test('太長的 pattern / 空 pattern 都拒絕', () => {
  assert.match(compileRule(replace('x'.repeat(600), 'y')).error, /最長/);
  assert.match(compileRule(replace('', 'y')).error, /不能是空/);
});

test('⛔ 單段太長就不餵給使用者的正則 —— 回溯的成本跟長度成正比', () => {
  const long = 'a'.repeat(5000);
  const result = applyRulesToText(long, compileRules([rewrite('a', 'b')]), {
    ancestors: [],
    maxTextLength: 100,
  });

  assert.equal(result.text, long);
  assert.equal(result.skipped, true);
});

test('超過時間預算就中止該規則，其他規則照跑', () => {
  const compiled = compileRules([rewrite('a', 'b'), replace('c', 'd')]);
  const state = { spent: new Map(), timedOut: new Set() };

  // 預算 0 ＝ 第一次檢查就超了
  const result = applyRulesToText('ac', compiled, { ancestors: [], budgetMs: 0, state });

  assert.equal(result.text, 'ac');
  assert.equal(state.timedOut.size, compiled.length);
});
