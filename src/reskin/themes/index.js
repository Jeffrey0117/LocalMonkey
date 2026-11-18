'use strict';

/**
 * 版型註冊表（SPEC-reskin §6：「目前只有 `shopee`，但要做成可選的」）。
 *
 * 一個版型要提供三件事：`ID`、`LABEL`（控制台的下拉選單用）、`render(data, context)`，
 * 以及一份 `css`（由 `/__lm/reskin/<id>.css` 送出去）。
 * 加第二個版型就是在這裡多一行 —— 抽取層與服務層都不用動。
 */

const shopee = require('./shopee/index.js');

const THEMES = Object.freeze({ [shopee.ID]: shopee });

const DEFAULT_THEME = shopee.ID;

/** 認不出來的版型名一律退回預設，不要讓一個打錯的字串把整頁弄掉 */
function themeFor(id) {
  return THEMES[id] ?? THEMES[DEFAULT_THEME];
}

function isKnownTheme(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(THEMES, id);
}

/** 控制台的下拉選單 */
function listThemes() {
  return Object.values(THEMES).map((theme) => ({ id: theme.ID, label: theme.LABEL }));
}

module.exports = { THEMES, DEFAULT_THEME, themeFor, isKnownTheme, listThemes };
