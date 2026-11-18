'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileRule, compileRules, activeCssRules, RULE_KINDS } = require('../../src/rules/compile.js');
const { buildRulesCss, buildHideCss } = require('../../src/rules/hide-css.js');
const { validateRuleCreate } = require('../../src/lib/validate-rules.js');

/**
 * `css` 規則型別（SPEC-rules §9）。
 *
 * `hide` 其實是 `css` 的特例 —— 它產生的就是
 * `選擇器 { display: none !important }`。這一型讓使用者寫任意 CSS，因為
 * `display: none` 只藏元素，**容器的高度與 margin 還在**（§9.2 的那片空白）。
 *
 * 兩種都留著：`hide` 只要一個選擇器、不用懂 CSS，而且控制台數得出它命中幾個
 * 元素（`css` 數不出來 —— 一段 CSS 沒有「命中數」這個概念）。
 */

const rule = (overrides) => ({
  id: 'r1',
  kind: 'css',
  pattern: '.a{margin:0}',
  enabled: true,
  order_index: 0,
  ...overrides,
});

test('css 是合法的 kind', () => {
  assert.deepEqual(RULE_KINDS, ['hide', 'css', 'text-replace', 'text-rewrite']);
});

test('編得起來的 css 規則帶著 css 欄位，沒有 error', () => {
  const compiled = compileRule(rule({ pattern: '.tm_banner { display: none !important; }' }));

  assert.equal(compiled.error, null);
  assert.equal(compiled.css, '.tm_banner { display: none !important; }');
  assert.equal(compiled.matcher, null, 'css 不參與文字比對');
  assert.equal(compiled.selector, null, 'css 不是選擇器');
});

test('⛔ 含 </style> 的 css 規則編不起來（帶著 error 回去，不丟例外）', () => {
  const compiled = compileRule(rule({ pattern: '.a{}</style><script>x()</script>' }));

  assert.match(compiled.error, /style/);
  assert.equal(compiled.css, null);
});

test('⛔ 壞掉的 css 規則不准進注入的 CSS', () => {
  const css = buildRulesCss(
    compileRules([
      rule({ id: 'bad', pattern: '.evil{}</style><script>x()</script>' }),
      rule({ id: 'ok', pattern: '.good{margin:0}' }),
    ]),
  );

  assert.equal(css.includes('</style'), false);
  assert.equal(css.includes('.evil'), false);
  assert.match(css, /\.good/);
});

test('非 ASCII 跳脫（注入點是 latin1 管線）', () => {
  const compiled = compileRule(rule({ pattern: '.logo::after{content:"預覽"}' }));

  assert.match(compiled.css, /^[\x20-\x7e\s]*$/);
  assert.match(compiled.css, /\\009810/);
});

test('多行 CSS 的換行要留著（UI 是 textarea）', () => {
  assert.equal(compileRule(rule({ pattern: '.a {\n  margin: 0;\n}' })).css, '.a {\n  margin: 0;\n}');
});

/* ------------------------------ 跟 hide 一起注入 ------------------------------ */

test('hide 與 css 合進同一份 CSS，順序照 order_index', () => {
  const css = buildRulesCss(
    compileRules([
      rule({ id: 'c1', kind: 'css', pattern: '.late{margin:0}', order_index: 2 }),
      rule({ id: 'h1', kind: 'hide', pattern: '.tm-menu', order_index: 1 }),
    ]),
  );

  assert.ok(css.indexOf('.tm-menu') < css.indexOf('.late'), css);
  assert.match(css, /\.tm-menu \{ display: none !important; \}/);
  assert.match(css, /\.late\{margin:0\}/);
});

/**
 * ⛔ 順序不只是美觀：兩條都是 `!important` 時**後面的勝**。使用者會用一條 css
 * 規則去覆蓋前面某條 hide（例如先藏整個容器、再把其中一塊放回來），
 * 所以 order_index 必須真的決定輸出順序。
 */
test('⛔ 後面的 css 規則要能覆蓋前面的 hide（!important 後者勝）', () => {
  const css = buildRulesCss(
    compileRules([
      rule({ id: 'h', kind: 'hide', pattern: '.box', order_index: 0 }),
      rule({ id: 'c', kind: 'css', pattern: '.box .keep{display:block !important}', order_index: 1 }),
    ]),
  );

  assert.ok(css.indexOf('.box {') < css.indexOf('.box .keep'), css);
});

test('停用的 css 規則不進 CSS', () => {
  assert.equal(buildRulesCss(compileRules([rule({ enabled: false })])), null);
});

test('沒有任何可用規則 → null（呼叫端就不要注入空的 style）', () => {
  assert.equal(buildRulesCss([]), null);
});

test('activeCssRules 只回啟用中且編得起來的', () => {
  const compiled = compileRules([
    rule({ id: 'a' }),
    rule({ id: 'b', enabled: false }),
    rule({ id: 'c', pattern: '</style>' }),
    rule({ id: 'd', kind: 'hide', pattern: '.x' }),
  ]);

  assert.deepEqual(
    activeCssRules(compiled).map((item) => item.id),
    ['a'],
  );
});

test('buildHideCss 還是只管 hide（既有呼叫端的語意不變）', () => {
  const css = buildHideCss(
    compileRules([rule({ id: 'c' }), rule({ id: 'h', kind: 'hide', pattern: '.x' })]),
  );

  assert.match(css, /\.x/);
  assert.equal(css.includes('margin'), false);
});

/* --------------------------------- 輸入驗證 --------------------------------- */

/**
 * ⛔ `css` 的 pattern **必須**能含換行（它是一段 CSS，不是一行選擇器），
 * 而其他型別不行 —— 一條含換行的選擇器或正則幾乎都是貼錯了。
 */
test('css 的 pattern 可以含換行，hide 的不行', () => {
  assert.equal(validateRuleCreate({ kind: 'css', pattern: '.a {\n  margin: 0;\n}' }).ok, true);
  assert.equal(validateRuleCreate({ kind: 'hide', pattern: '.a,\n.b' }).ok, false);
});

test('css 的 pattern 上限比其他型別寬（一段 CSS 很容易超過 500 字）', () => {
  const long = `.a{margin:0}`.repeat(60); // 720 字
  assert.equal(validateRuleCreate({ kind: 'css', pattern: long }).ok, true);
  assert.equal(validateRuleCreate({ kind: 'text-replace', pattern: long }).ok, false);
});

test('css 的 pattern 還是有上限', () => {
  const tooLong = 'a'.repeat(4001);
  const result = validateRuleCreate({ kind: 'css', pattern: tooLong });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'pattern');
});

/**
 * ⛔ 驗證層**刻意**讓含 `</style>` 的規則存得起來（跟編不過的正則同一個待遇，
 * 規格 §4）：退回一個 400 的話使用者只看到錯誤、沒有那條半成品可以改。
 * 真正的防線是 `compile.js` —— 它不會把那條 CSS 放進注入的 `<style>`。
 */
test('⛔ 含 </style> 的規則 API 收得下，但編譯時會被標成壞掉', () => {
  const body = { kind: 'css', pattern: '.a{}</style>' };

  assert.equal(validateRuleCreate(body).ok, true, 'API 要收得下（UI 才有東西可以改）');
  assert.match(compileRule({ id: 'x', ...body }).error, /style/);
});
