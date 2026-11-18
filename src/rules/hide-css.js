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

const { activeHideRules } = require('./compile.js');

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

module.exports = { buildHideCss, DECLARATION };
