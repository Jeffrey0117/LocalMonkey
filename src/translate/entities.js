'use strict';

/**
 * HTML entity 的還原與重新編碼。
 *
 * 規格 §3：**先還原再翻、翻完再編碼**。不還原的話 `&amp;` 會被當成文字
 * 翻掉、`&nbsp;` 會整個消失。
 *
 * 刻意只認規格點名的那幾個（加上 `&apos;` 與數值寫法的 `'`）——
 * `&copy;`、`&mdash;` 這些原樣留在文字裡當不透明的符號傳給模型，
 * 比翻成某個字元再猜怎麼編回去安全。
 */

const NBSP = String.fromCharCode(160);

/** 名稱 → 字元。比對不分大小寫（`&AMP;` 瀏覽器也認）。 */
const NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: NBSP,
});

const NAMED_PATTERN = new RegExp(`&(${Object.keys(NAMED).join('|')});`, 'gi');
const APOSTROPHE_PATTERN = /&#(?:39|x27);/gi;

/**
 * ⛔ 判斷「這個 `&` 已經是一個 entity 的開頭了嗎」。
 *
 * `encodeEntities` 少了這道，`&copy;` 會變成 `&amp;copy;` —— 頁面上
 * 直接顯示出 `&copy;` 這五個字，是看得見的壞掉。
 */
const ENTITY_AT_START = /^&(?:[a-zA-Z][a-zA-Z0-9]{0,30};|#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};)/;

function decodeEntities(text) {
  if (typeof text !== 'string') return '';

  return text
    .replace(APOSTROPHE_PATTERN, "'")
    .replace(NAMED_PATTERN, (match, name) => NAMED[name.toLowerCase()] ?? match);
}

/**
 * @param {string} text
 * @param {{ attribute?: boolean }} [options] 屬性值要連引號一起跳脫（值住在引號裡面）
 */
function encodeEntities(text, { attribute = false } = {}) {
  if (typeof text !== 'string') return '';

  // `&` 要先做：之後的 `<` → `&lt;` 自己會引進新的 `&`，不能被再跳脫一次
  const escaped = text
    .replace(/&/g, (match, offset) =>
      ENTITY_AT_START.test(text.slice(offset)) ? match : '&amp;',
    )
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(NBSP)
    .join('&nbsp;');

  return attribute ? escaped.replace(/"/g, '&quot;').replace(/'/g, '&#39;') : escaped;
}

module.exports = { decodeEntities, encodeEntities, NAMED, NBSP };
