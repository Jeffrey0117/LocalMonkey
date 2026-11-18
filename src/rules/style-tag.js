'use strict';

/**
 * 把一份 CSS 注入頁面。
 *
 * **插在 `</head>` 之前**，有兩個原因：
 *
 * 1. 零閃爍：`<head>` 裡的樣式會擋住 render，所以 body 的元素從來不會有
 *    「先出現再被藏起來」的那一瞬間（規格 §1 要的 document-start 效果）。
 * 2. 贏得過站內的 `!important`：兩條都是 `!important` 時**後面的勝**，
 *    插在 head 開頭就會輸給站台自己的樣式表。
 *
 * 退路：沒有 `</head>` → `<head>` 開頭 → 整份文件最前面。
 */

const LM_STYLE_ID = 'lm-site-rules';

const HEAD_CLOSE_PATTERN = /<\/head\s*>/i;
const HEAD_OPEN_PATTERN = /<head\b[^>]*>/i;

/**
 * @param {string} html
 * @param {string|null} css
 */
function injectStyleTag(html, css) {
  if (typeof html !== 'string') return html;
  if (typeof css !== 'string' || css.trim().length === 0) return html;

  const tag = `<style id="${LM_STYLE_ID}">\n${css}\n</style>`;

  const closing = HEAD_CLOSE_PATTERN.exec(html);
  if (closing) {
    return `${html.slice(0, closing.index)}${tag}${html.slice(closing.index)}`;
  }

  const opening = HEAD_OPEN_PATTERN.exec(html);
  if (opening) {
    const at = opening.index + opening[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }

  return `${tag}${html}`;
}

module.exports = { injectStyleTag, LM_STYLE_ID };
