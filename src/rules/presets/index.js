'use strict';

/**
 * 預設規則組。
 *
 * 一組規則就是一串 `site_rules` 的列（見 `templatemo-com.js` 的註解：那是
 * **資料**，不是引擎的一部分）。`applyPreset` 刻意寫成**冪等**的：
 * 同一個 preset 跑兩次不會長出兩份規則 —— 使用者會重跑腳本來「補上新的規則」。
 */

const { TEMPLATEMO_RULES, TEMPLATEMO_LOGO_PATH } = require('./templatemo-com.js');

const PRESETS = Object.freeze({
  'templatemo-com': TEMPLATEMO_RULES,
});

/**
 * 同一條規則＝同樣的 kind + pattern。
 *
 * 用 JSON.stringify 當 key 而不是自己串分隔符：分隔符要嘛會跟 pattern 裡的
 * 字元撞到，要嘛得用看不見的控制字元（CLAUDE.md 地雷 13 點名過的坑）。
 *
 * **刻意不把 scope 算進 key**：修正一條規則的範圍是很常見的事（templatemo 的
 * 卡片標題就從 `.thumbnail_270 h2` 改成多涵蓋詳情頁的 `.tm_silver_360 h2`）。
 * 把 scope 算進 key 的話，重跑 preset 會留下一條舊的、範圍錯的規則繼續生效 ——
 * 而使用者看到的症狀是「改了，但有些頁面沒變」。
 */
function keyOf(rule) {
  return JSON.stringify([rule.kind, rule.pattern]);
}

/** 套用 preset ＝以 preset 為準：replacement / scope / note / enabled 都會被蓋掉 */
function differs(found, rule) {
  return (
    (found.replacement ?? '') !== (rule.replacement ?? '') ||
    (found.scope ?? null) !== (rule.scope ?? null) ||
    (found.note ?? '') !== (rule.note ?? '') ||
    found.enabled !== true
  );
}

/**
 * @param {object} store
 * @param {string} siteId
 * @param {Array<object>} rules
 * @returns {{ created: number, updated: number }}
 */
function applyPreset(store, siteId, rules) {
  const existing = new Map(store.siteRules.listBySite(siteId).map((rule) => [keyOf(rule), rule]));

  return rules.reduce(
    (counts, rule) => {
      const found = existing.get(keyOf(rule));

      if (!found) {
        store.siteRules.create(siteId, rule);
        return { ...counts, created: counts.created + 1 };
      }
      if (!differs(found, rule)) return counts;

      store.siteRules.update(found.id, {
        replacement: rule.replacement ?? '',
        scope: rule.scope ?? null,
        note: rule.note ?? null,
        enabled: true,
      });
      return { ...counts, updated: counts.updated + 1 };
    },
    { created: 0, updated: 0 },
  );
}

module.exports = { PRESETS, applyPreset, TEMPLATEMO_RULES, TEMPLATEMO_LOGO_PATH };
