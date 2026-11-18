'use strict';

/**
 * `hide` 規則 → 一份 CSS（規格 §1）。
 *
 * **為什麼藏而不是從 HTML 刪**：選擇器交給瀏覽器比對才精準（伺服器端沒有
 * DOM，要刪就得用正則，很容易刪錯或刪不乾淨），而且規則寫錯最多是沒生效，
 * 不會把頁面結構弄壞。對按鈕與連結來說，「藏起來」跟「刪掉」在使用者眼中
 * 沒有差別。
 *
 * 選擇器已經在 `rules/selector.js` 過濾與跳脫過（純 ASCII），所以這裡只負責
 * 把它們排成 CSS。
 */

const { activeHideRules, activeStyleRules } = require('./compile.js');

const DECLARATION = '{ display: none !important; }';

/**
 * @param {Array<object>} compiled `compileRules()` 的輸出
 * @returns {string|null} 沒有任何可用規則時回 null（呼叫端就不要注入空 style）
 */
function buildHideCss(compiled) {
  const selectors = activeHideRules(compiled)
    .map((rule) => rule.selector)
    .filter((selector) => typeof selector === 'string' && selector.length > 0);

  if (selectors.length === 0) return null;

  return selectors.map((selector) => `${selector} ${DECLARATION}`).join('\n');
}

/**
 * `hide` ＋ `css` 兩種規則合成一份要注入的 CSS（規格 §9）。
 *
 * ⛔ **順序照 `order_index`，而且那是語意不是美觀**：兩條都帶 `!important` 時
 * 後面的勝。使用者會用一條 `css` 規則去覆蓋前面某條 `hide`（先藏整個容器、
 * 再把其中一塊放回來），所以不能把 hide 全部排在前面再接 css。
 *
 * @param {Array<object>} compiled
 * @returns {string|null}
 */
function buildRulesCss(compiled) {
  const blocks = activeStyleRules(compiled).map((rule) =>
    rule.kind === 'hide' ? `${rule.selector} ${DECLARATION}` : rule.css,
  );

  return blocks.length === 0 ? null : blocks.join('\n');
}

module.exports = { buildHideCss, buildRulesCss, DECLARATION };
