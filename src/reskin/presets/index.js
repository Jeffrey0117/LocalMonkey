'use strict';

/**
 * 預設抽取設定（SPEC-reskin §6：控制台要能一鍵套上）。
 *
 * 一組 preset 就是一份 `reskin_config` 的內容 —— **資料**，不是引擎。
 * key 是站的 slug，跟 `rules/presets/index.js` 同一個做法。
 *
 * ⛔ 套用是**整份取代**，不是合併。抽取設定是一個「順序有意義的陣列」
 * （第一個命中的勝出），合併進去只會讓順序變成猜謎 ——
 * 而「有些頁面重繪、有些沒有」是這個功能最難查的症狀。
 */

const { TEMPLATEMO_RESKIN } = require('./templatemo-com.js');

const RESKIN_PRESETS = Object.freeze({
  'templatemo-com': TEMPLATEMO_RESKIN,
});

function hasPreset(siteId) {
  return Object.prototype.hasOwnProperty.call(RESKIN_PRESETS, siteId);
}

/** @returns {Array<object>|null} */
function presetFor(siteId) {
  return hasPreset(siteId) ? RESKIN_PRESETS[siteId] : null;
}

function listPresets() {
  return Object.keys(RESKIN_PRESETS);
}

module.exports = { RESKIN_PRESETS, presetFor, hasPreset, listPresets };
