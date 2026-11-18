'use strict';

/**
 * `css` 規則的 CSS 文字：安全檢查 + 非 ASCII 跳脫（SPEC-rules §9）。
 *
 * `hide` 其實是 `css` 的特例（它產生的就是 `選擇器 { display: none !important }`）。
 * 這一型讓使用者寫任意 CSS —— 收掉藏完留下的 margin、用 `::after` 畫一個 logo
 * 字樣、調間距。
 *
 * ⛔ **這是一個 HTML 注入點**：使用者打的字會原樣進我們注入的 `<style>`。
 * `<style>` 的內容對 HTML 分詞器來說是 raw text，唯一的出口是 `</style` ——
 * 擋掉它就擋掉整類攻擊。大小寫與空白的變形都要擋（分詞器不分大小寫，而
 * `</style   >`、`</style/` 都是合法的結束標籤）。
 *
 * 跟 `rules/selector.js` 不一樣的三件事，每一件都有理由：
 *
 * 1. **`{` `}` `;` 要放行** —— CSS 沒有它們就不是 CSS 了。選擇器擋它們是因為
 *    那裡多一個 `}` 就等於多一條規則；這裡使用者本來就有權寫任意規則。
 * 2. **`\` 要放行** —— CSS 的跳脫序列（`content: "\2014"`）是正常寫法。而
 *    `<\/style>` 在 HTML 分詞器眼裡**不是**結束標籤（它看到的是 `<` 接 `\`），
 *    所以放行反斜線不會開出新的洞。
 * 3. **換行要放行**（UI 是 textarea），所以跳脫非 ASCII 時**不能**沿用
 *    `escapeCssNonAscii` —— 它擋的是 `[^\x20-\x7e]`，那個範圍含 `\n` / `\t`，
 *    多行 CSS 會被寫成 `.a {\00000a  margin: 0;}`，整份報廢。
 */

const MAX_CSS_LENGTH = 4000;

/**
 * `</style` 的所有變形。
 *
 * HTML 分詞器只認 `</` 緊接標籤名，所以 `</ style>` 其實出不去 ——
 * 但這裡不猜分詞器的脾氣，看起來像結束標籤的一律拒絕。
 */
const STYLE_CLOSE_PATTERN = /<\s*\/\s*style/i;

/**
 * 非 ASCII → CSS 的 `\XXXXXX`，但保留 tab / CR / LF。
 *
 * 理由同 `rules/selector.js`：注入點是 latin1 管線字串，而且我們不知道目標頁面
 * 宣告的是什麼 charset。把 UTF-8 的 byte 塞進一份宣告 Big5 的頁面 ＝ CSS 變亂碼、
 * 規則靜默失效。固定補到 6 位 hex（位數不足時 CSS 會再吃掉一個空白）。
 */
function escapeCssText(input) {
  return String(input).replace(
    /[^\x09\x0a\x0d\x20-\x7e]/gu,
    (character) => `\\${character.codePointAt(0).toString(16).padStart(6, '0')}`,
  );
}

/**
 * @param {unknown} css
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function safeCssText(css) {
  if (typeof css !== 'string' || css.trim().length === 0) {
    return { ok: false, error: 'CSS 不能是空的' };
  }
  if (css.length > MAX_CSS_LENGTH) {
    return { ok: false, error: `CSS 最長 ${MAX_CSS_LENGTH} 個字` };
  }
  if (css.includes('\0')) {
    return { ok: false, error: 'CSS 不能含 NUL 字元' };
  }
  if (STYLE_CLOSE_PATTERN.test(css)) {
    return {
      ok: false,
      error: 'CSS 不能含 </style —— 那會提前關掉我們注入的 <style>，等於 HTML 注入',
    };
  }

  return { ok: true, value: escapeCssText(css) };
}

module.exports = { safeCssText, escapeCssText, MAX_CSS_LENGTH, STYLE_CLOSE_PATTERN };
