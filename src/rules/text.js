'use strict';

/**
 * 一段文字 → 套完所有文字規則的文字。
 *
 * 規則依序套用，**後面的規則看到的是前面的結果**（規格 §1 的執行順序），
 * 所以把 `634 Lantern River` 先改成 `634 燈河` 再改成 `燈河[634]` 這種
 * 疊加是刻意支援的。
 */

const { matchesScope } = require('./scope.js');
const { applyLiteral } = require('./literal.js');

/** 一份文件裡，單條規則最多可以花的時間 */
const DEFAULT_BUDGET_MS = 50;

/**
 * ⛔ 不餵給使用者的正則的長度上限。回溯的成本跟輸入長度成正比（壞的正則是
 * 指數），而超過這個長度的「一段文字」通常是內嵌的 JSON 或整篇文章 ——
 * 改造規則要處理的是按鈕與標題。
 */
const DEFAULT_MAX_TEXT_LENGTH = 2000;

/** 跨段共用的狀態：哪條規則花了多久、哪條已經超預算被停掉 */
function createRuleState() {
  return { spent: new Map(), timedOut: new Set() };
}

function applyRewrite(text, rule) {
  rule.matcher.lastIndex = 0;
  return text.replace(rule.matcher, rule.replacement ?? '');
}

/**
 * @param {string} text 解碼後的真文字（不是 latin1 管線字串）
 * @param {Array<object>} rules `compileRules` 的輸出（會自己過濾停用與壞掉的）
 * @param {{
 *   ancestors?: Array<object>,
 *   state?: { spent: Map, timedOut: Set },
 *   budgetMs?: number,
 *   maxTextLength?: number,
 * }} [options]
 * @returns {{ text: string, hits: Array<string>, skipped: boolean }}
 */
function applyRulesToText(text, rules, options = {}) {
  const {
    ancestors = [],
    state = createRuleState(),
    budgetMs = DEFAULT_BUDGET_MS,
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
  } = options;

  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', hits: [], skipped: false };
  }
  if (text.length > maxTextLength) return { text, hits: [], skipped: true };

  const hits = [];
  let current = text;

  for (const rule of rules) {
    if (!rule.enabled || rule.error || !rule.matcher) continue;
    if (state.timedOut.has(rule.id)) continue;
    if ((state.spent.get(rule.id) ?? 0) >= budgetMs) {
      state.timedOut.add(rule.id);
      continue;
    }
    if (!matchesScope(ancestors, rule.scopeParsed)) continue;

    const startedAt = performance.now();
    const next = rule.kind === 'text-replace' ? applyLiteral(current, rule) : applyRewrite(current, rule);
    state.spent.set(rule.id, (state.spent.get(rule.id) ?? 0) + (performance.now() - startedAt));

    if (next !== current) {
      hits.push(rule.id);
      current = next;
    }
  }

  return { text: current, hits, skipped: false };
}

module.exports = {
  applyRulesToText,
  createRuleState,
  DEFAULT_BUDGET_MS,
  DEFAULT_MAX_TEXT_LENGTH,
};
