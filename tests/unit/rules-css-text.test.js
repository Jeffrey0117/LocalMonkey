'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { safeCssText, MAX_CSS_LENGTH } = require('../../src/rules/css-text.js');

/**
 * `css` 規則（SPEC-rules §9）：使用者寫的 CSS 原樣進我們注入的 `<style>`。
 *
 * ⛔ 所以這是一個 **HTML 注入點**。`<style>` 的內容對 HTML 分詞器來說是 raw
 * text，唯一的出口是 `</style` —— 擋掉它就擋掉了整類攻擊。大小寫與空白的變形
 * 都要擋（分詞器不分大小寫）。
 *
 * 跟選擇器不一樣的是 `\` 要放行：CSS 的跳脫序列（`\201C`、`content: "\2014"`）
 * 是正常寫法，而 `<\/style>` 在 HTML 分詞器眼裡不是結束標籤（它看到的是
 * `<` 後面接 `\`），所以放行反斜線不會開出新的洞。
 */

test('一般的 CSS 原樣通過', () => {
  const css = '.tm-menu { display: none !important; }';
  assert.deepEqual(safeCssText(css), { ok: true, value: css });
});

test('多行 CSS 可以（UI 是 textarea）', () => {
  const css = '.a {\n  margin: 0;\n}\n.b {\n  padding: 0;\n}';
  assert.equal(safeCssText(css).ok, true);
});

test('⛔ 擋掉 </style>', () => {
  const result = safeCssText('.a{color:red}</style><script>alert(1)</script>');
  assert.equal(result.ok, false);
  assert.match(result.error, /style/);
});

test('⛔ 大小寫的變形也要擋', () => {
  for (const variant of ['</STYLE>', '</Style>', '</sTyLe>']) {
    assert.equal(safeCssText(`.a{}${variant}`).ok, false, variant);
  }
});

test('⛔ 含空白的變形也要擋（`</style   >`、`</style/`）', () => {
  for (const variant of ['</style   >', '</style/', '</style\t>', '</style\n>']) {
    assert.equal(safeCssText(`.a{}${variant}`).ok, false, JSON.stringify(variant));
  }
});

test('⛔ `</` 與標籤名之間的空白也要擋（分詞器不吃，但我們不猜）', () => {
  assert.equal(safeCssText('.a{}</ style>').ok, false);
});

test('單純的 `<` 或 `</div>` 不用擋（CSS 的 content 可以放任何字）', () => {
  assert.equal(safeCssText('.a::before{content:"<"}').ok, true);
  assert.equal(safeCssText('.a::before{content:"</div>"}').ok, true);
});

test('反斜線放行（CSS 跳脫是正常寫法）', () => {
  assert.equal(safeCssText('.a::before{content:"\\201C"}').ok, true);
});

test('空的不行', () => {
  assert.equal(safeCssText('').ok, false);
  assert.equal(safeCssText('   \n  ').ok, false);
  assert.equal(safeCssText(null).ok, false);
});

test(`最長 ${MAX_CSS_LENGTH} 個字`, () => {
  assert.equal(safeCssText('a'.repeat(MAX_CSS_LENGTH)).ok, true);
  assert.equal(safeCssText('a'.repeat(MAX_CSS_LENGTH + 1)).ok, false);
});

test('NUL 不行', () => {
  assert.equal(safeCssText('.a{color:red\0}').ok, false);
});

/**
 * ⛔ 注入點是 latin1 管線字串，而且我們不知道目標頁面宣告的是什麼 charset
 * （跟 `rules/selector.js` 同一個理由）。中文要跳脫成 `\00xxxx` 才不會變亂碼。
 */
test('非 ASCII 跳脫成 CSS 的 \\XXXXXX（含 content 裡的中文）', () => {
  const result = safeCssText('.logo::after{content:"預覽"}');

  assert.equal(result.ok, true);
  assert.equal(result.value, '.logo::after{content:"\\009810\\0089bd"}');
  assert.match(result.value, /^[\x20-\x7e\s]*$/, '輸出一定是純 ASCII');
});

/**
 * ⛔ 換行**不准**被當成「非 ASCII」跳脫掉。`rules/selector.js` 的
 * `escapeCssNonAscii` 擋的是 `[^\x20-\x7e]`，那個範圍含 `\n` / `\t` ——
 * 直接拿來用的話多行 CSS 會被寫成 `.a {\00000a  margin: 0;}`，整份 CSS 報廢。
 */
test('⛔ 換行與 tab 原樣保留，不要被跳脫掉', () => {
  const result = safeCssText('.a {\n\tmargin: 0;\n}');
  assert.equal(result.value, '.a {\n\tmargin: 0;\n}');
});
