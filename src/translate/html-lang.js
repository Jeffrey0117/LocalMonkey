'use strict';

/**
 * 翻完之後把 `<html lang>` 改成目標語言。
 *
 * ⛔ 為什麼這不是吹毛求疵：`lang` 決定瀏覽器怎麼挑 CJK 字體。一份內容已經是
 * 繁體中文、卻還宣告 `lang="en"` 的文件，瀏覽器會用預設的 CJK 回退字體 ——
 * 常常挑到日文字形（同一個漢字在日文與中文的寫法不一樣），看起來就是「字怪怪的」。
 * 螢幕閱讀器也會用英文發音去念中文。
 *
 * 規格 §3 的「不准碰」清單是 `href` / `src` / `class` / `id` / `data-*`，
 * `lang` 不在裡面 —— 而且這一步只在**真的翻了東西**之後才做。
 */

const { attributePattern, findQuotedAttribute, replaceAttribute } = require('../lib/attribute.js');

const HTML_TAG = /<html\b[^>]*>/i;
const LANG = attributePattern('lang');

/**
 * @param {string} html
 * @param {string} targetLang 例如 `zh-TW`
 * @returns {string} 改過的 HTML（沒有 `<html>` 標籤就原樣回去）
 */
function rewriteHtmlLang(html, targetLang) {
  if (typeof html !== 'string' || typeof targetLang !== 'string' || targetLang.length === 0) {
    return html;
  }

  const matched = HTML_TAG.exec(html);
  if (!matched) return html;

  const tag = matched[0];
  const attribute = findQuotedAttribute(tag, LANG);

  // 本來就沒宣告 lang 的文件不補 —— 那是在改一份我們沒把握的東西，
  // 而且沒宣告時瀏覽器的行為跟宣告錯的不一樣（前者會自己偵測）
  if (!attribute) return html;
  if (attribute.value === targetLang) return html;

  const rewritten = replaceAttribute(tag, attribute, targetLang);

  return `${html.slice(0, matched.index)}${rewritten}${html.slice(matched.index + tag.length)}`;
}

module.exports = { rewriteHtmlLang };
