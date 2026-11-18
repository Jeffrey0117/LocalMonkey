'use strict';

/**
 * `hide` 規則的 CSS 選擇器：安全檢查 + 非 ASCII 跳脫。
 *
 * 選擇器是使用者打進控制台的字串，而它會被拼進我們注入頁面的
 * `<style>` 裡 —— 所以這裡擋的是「拼字串拼出新的 CSS」：
 *
 *   `a} body`              → `a} body{display:none}` ＝多了一條規則（整頁藏起來）
 *   `a</style><script>`    → 直接長出一個 script tag
 *   `a /*`                 → 把我們的 `{display:none}` 註解掉（規則靜默失效）
 *   `@import url(evil)`    → at-rule
 *   `a\7d body`            → 用 CSS escape 把上面那些檢查全部繞過
 *
 * 不做「嘗試修正」—— 看不懂就拒絕，UI 會把那一列標紅。悄悄改掉使用者寫的
 * 選擇器只會讓他以為規則沒生效。
 */

const MAX_SELECTOR_LENGTH = 200;

/** 這些字元在合法的選擇器裡沒有用途，但在 CSS 文字裡很危險 */
const FORBIDDEN_CHARACTERS = Object.freeze([
  ['{', '不能有大括號 {'],
  ['}', '不能有大括號 }'],
  ['<', '不能有角括號 <'],
  ['>', null], // 子選擇器，合法
  ['@', '不能有 @（那是 at-rule，不是選擇器）'],
  ['\\', '不能有反斜線（要輸入非 ASCII 字元直接打就好，我們會自己跳脫）'],
  [';', '不能有分號'],
]);

/**
 * 非 ASCII → CSS 的 `\XXXXXX` 跳脫。
 *
 * ⛔ 注入點是 latin1 管線字串（代理的 HTML 改寫全程走 byte），而且我們**不知道**
 * 目標頁面宣告的是什麼 charset。把 UTF-8 的 byte 直接塞進一份宣告 Big5 的頁面
 * ＝選擇器變亂碼、規則靜默失效。跳脫成 ASCII 之後跟 charset 完全無關。
 *
 * 固定補到 6 位 hex：CSS 的跳脫序列最多吃 6 位，位數不足時會再吃掉**一個空白**
 * —— 那個空白可能正是後代選擇器的組合子。
 */
function escapeCssNonAscii(input) {
  return String(input).replace(/[^\x20-\x7e]/gu, (character) =>
    `\\${character.codePointAt(0).toString(16).padStart(6, '0')}`,
  );
}

/**
 * @param {unknown} selector
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function safeCssSelector(selector) {
  if (typeof selector !== 'string' || selector.trim().length === 0) {
    return { ok: false, error: '選擇器不能是空的' };
  }
  if (selector.length > MAX_SELECTOR_LENGTH) {
    return { ok: false, error: `選擇器最長 ${MAX_SELECTOR_LENGTH} 個字` };
  }
  if (/[\r\n\t\0]/.test(selector)) {
    return { ok: false, error: '選擇器不能含換行、tab 或控制字元' };
  }

  for (const [character, message] of FORBIDDEN_CHARACTERS) {
    if (message && selector.includes(character)) return { ok: false, error: message };
  }

  if (selector.includes('/*') || selector.includes('*/')) {
    return { ok: false, error: '選擇器不能含 CSS 註解（/* 或 */）' };
  }

  return { ok: true, value: escapeCssNonAscii(selector) };
}

module.exports = { safeCssSelector, escapeCssNonAscii, MAX_SELECTOR_LENGTH };
