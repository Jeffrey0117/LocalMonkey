'use strict';

/**
 * `text-replace` 的字面取代（規格 §1：最常見、最安全的那種）。
 *
 * 兩個刻意的行為，都是實測需求逼出來的：
 *
 * 1. **空白寬鬆**：`<h2 class="templatemo-slogan"> 免費 HTML CSS 網站模板</h2>`
 *    —— 原始 HTML 裡的空白可能是換行或連續空白，字面逐字比對會不中。
 *    所以 pattern 裡的每一段空白都當成「一個以上的空白」。
 * 2. **大小寫跟著原文走**（規格 §3.5）：`templatemo` / `TemplateMo` /
 *    `TEMPLATEMO` 都要命中，而且各自保持原本的風格。
 *    但大小寫**完全相同**時替換字原樣用 —— 不然
 *    `免費 HTML CSS 網站模板` 會被判成「全大寫」（CJK 的大小寫是自己）。
 */

function escapeForRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 字面字串 → 正則：空白寬鬆、不分大小寫 */
function literalToRegex(pattern) {
  const source = pattern
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => escapeForRegExp(part))
    .join('\\s+');

  return new RegExp(source, 'gi');
}

function isAllUpper(text) {
  return text === text.toUpperCase() && text !== text.toLowerCase();
}

function capitalize(text) {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** 空白寫法的差異不算「不一樣」 */
function sameIgnoringSpace(a, b) {
  return a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ');
}

/**
 * 命中的這一段應該換成什麼。
 *
 * @param {string} matched 實際命中的原文
 * @param {string} pattern 規則寫的 pattern
 * @param {string} replacement 規則寫的替換字
 */
function styledReplacement(matched, pattern, replacement) {
  // 使用者寫的大小寫就是他要的 —— 原樣用
  if (sameIgnoringSpace(matched, pattern)) return replacement;

  if (isAllUpper(matched)) return replacement.toUpperCase();
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  if (matched[0] === matched[0].toUpperCase()) return capitalize(replacement.toLowerCase());

  return replacement;
}

/**
 * @param {string} text
 * @param {{ pattern: string, replacement: string, matcher: RegExp }} rule
 */
function applyLiteral(text, rule) {
  rule.matcher.lastIndex = 0;
  return text.replace(rule.matcher, (matched) =>
    styledReplacement(matched, rule.pattern, rule.replacement ?? ''),
  );
}

module.exports = { literalToRegex, applyLiteral, styledReplacement, escapeForRegExp };
