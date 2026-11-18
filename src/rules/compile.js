'use strict';

/**
 * DB 的一列 → 可以執行的規則（或一條錯誤訊息）。
 *
 * **壞規則不丟例外**，而是帶著 `error` 回去：控制台要把那一列標紅並說明原因
 * （規格 §4），而代理要能照常回應 —— 一條規則寫壞不該讓整個網站打不開。
 */

const { safeCssSelector } = require('./selector.js');
const { parseScope } = require('./scope.js');
const { compileUserRegex } = require('./user-regex.js');
const { literalToRegex } = require('./literal.js');

const RULE_KINDS = Object.freeze(['hide', 'text-replace', 'text-rewrite']);
const TEXT_KINDS = Object.freeze(['text-replace', 'text-rewrite']);
const MAX_REPLACEMENT_LENGTH = 500;

function failed(row, error) {
  return { ...base(row), error };
}

function base(row) {
  return {
    id: row.id,
    kind: row.kind,
    pattern: typeof row.pattern === 'string' ? row.pattern : '',
    replacement: typeof row.replacement === 'string' ? row.replacement : '',
    scope: row.scope ?? null,
    note: row.note ?? null,
    enabled: row.enabled !== false && row.enabled !== 0,
    order_index: Number.isInteger(row.order_index) ? row.order_index : 0,
    matcher: null,
    scopeParsed: null,
    selector: null,
    error: null,
  };
}

function compileHide(row) {
  const selector = safeCssSelector(row.pattern);
  return selector.ok ? { ...base(row), selector: selector.value } : failed(row, selector.error);
}

function compileText(row) {
  const pattern = typeof row.pattern === 'string' ? row.pattern : '';
  if (pattern.length === 0) return failed(row, 'pattern 不能是空的');
  if (pattern.length > 500) return failed(row, 'pattern 最長 500 個字');

  const replacement = typeof row.replacement === 'string' ? row.replacement : '';
  if (replacement.length > MAX_REPLACEMENT_LENGTH) {
    return failed(row, `替換字最長 ${MAX_REPLACEMENT_LENGTH} 個字`);
  }

  const scope = parseScope(row.scope ?? null);
  if (!scope.ok) return failed(row, scope.error);

  if (row.kind === 'text-replace') {
    return { ...base(row), matcher: literalToRegex(pattern), scopeParsed: scope.value };
  }

  const compiled = compileUserRegex(pattern);
  return compiled.ok
    ? { ...base(row), matcher: compiled.value, scopeParsed: scope.value }
    : failed(row, compiled.error);
}

/** @param {object} row `site_rules` 的一列（也接受 API 進來的同形狀物件） */
function compileRule(row) {
  if (!row || typeof row !== 'object') return failed({}, '規則必須是物件');
  if (!RULE_KINDS.includes(row.kind)) {
    return failed(row, `kind 只能是 ${RULE_KINDS.join(' / ')}`);
  }

  return row.kind === 'hide' ? compileHide(row) : compileText(row);
}

/** 照 order_index 排好（同序時用 id，才有穩定的順序） */
function compileRules(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => compileRule(row))
    .sort(
      (left, right) =>
        left.order_index - right.order_index || String(left.id).localeCompare(String(right.id)),
    );
}

/** 真的會被執行的那些：啟用中、編得起來、是文字規則 */
function activeTextRules(compiled) {
  return compiled.filter(
    (rule) => rule.enabled && !rule.error && TEXT_KINDS.includes(rule.kind) && rule.matcher,
  );
}

/** 真的會被注入的那些 hide 選擇器 */
function activeHideRules(compiled) {
  return compiled.filter((rule) => rule.enabled && !rule.error && rule.kind === 'hide');
}

module.exports = {
  compileRule,
  compileRules,
  activeTextRules,
  activeHideRules,
  RULE_KINDS,
  TEXT_KINDS,
  MAX_REPLACEMENT_LENGTH,
};
