'use strict';

/**
 * 版型註冊表（SPEC-reskin §6：「要做成可選的」）。
 *
 * 一個版型要提供：`ID`、`LABEL`（控制台的下拉選單用）、`render(data, context)`、
 * `renderNextPage(data, context)`（無限載入的下一批），以及一份 `css`
 * （由 `/__lm/reskin/<id>.css` 送出去）。
 * 加第二個版型就是在這裡多一行 —— 抽取層與服務層都不用動。
 */

const mall = require('./mall/index.js');

const THEMES = Object.freeze({ [mall.ID]: mall });

const DEFAULT_THEME = mall.ID;

/**
 * 舊的版型名 → 現在的版型名。
 *
 * ⛔ 存在資料庫裡的值會比程式碼舊。`mall` 以前叫別的名字（它曾經是在模仿
 * 一個電商的配色，而 SPEC-reskin-v2 §1 的整個重點就是別再像人家），
 * 而使用者的 `sites.reskin_theme` 裡躺著那個舊字串。
 * 不收的話：`checkReskinTheme` 會把存站的請求擋成 400（使用者改別的欄位
 * 也一起壞），而控制台的下拉選單會對不上任何一個選項。
 */
const ALIASES = Object.freeze({ shopee: mall.ID });

function canonicalThemeId(id) {
  if (typeof id !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(THEMES, id)) return id;
  return ALIASES[id] ?? null;
}

/** 認不出來的版型名一律退回預設，不要讓一個打錯的字串把整頁弄掉 */
function themeFor(id) {
  return THEMES[canonicalThemeId(id) ?? DEFAULT_THEME];
}

function isKnownTheme(id) {
  return canonicalThemeId(id) !== null;
}

/** 控制台的下拉選單 */
function listThemes() {
  return Object.values(THEMES).map((theme) => ({ id: theme.ID, label: theme.LABEL }));
}

module.exports = { THEMES, DEFAULT_THEME, themeFor, isKnownTheme, canonicalThemeId, listThemes };
