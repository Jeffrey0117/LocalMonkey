'use strict';

/**
 * DB 的一列 → 可以執行的規則（或一條錯誤訊息）。
 *
 * **壞規則不丟例外**，而是帶著 `error` 回去：控制台要把那一列標紅並說明原因
 * （規格 §4），而代理要能照常回應 —— 一條規則寫壞不該讓整個網站打不開。
 */

const { safeCssSelector } = require('./selector.js');
const { safeCssText } = require('./css-text.js');
const { parseScope } = require('./scope.js');
const { compileUserRegex, isSlashForm } = require('./user-regex.js');
const { literalToRegex } = require('./literal.js');

/**
 * `hide` 其實是 `css` 的特例（它產生的就是
 * `選擇器 { display: none !important }`），但兩個都留著：`hide` 只要一個選擇器、
 * 不用懂 CSS，而且控制台數得出它命中幾個元素 —— 一段 CSS 沒有「命中數」。
 *
 * `no-translate`（SPEC-rules §12）是**唯一一個不改頁面的型別** —— 它改的是
 * 「哪些段要餵給模型」。`hide` 藏掉的東西照樣會被翻（翻譯層跑在規則層之前），
 * 所以藏 ≠ 省時間，這條才是省時間的那個。
 */
const RULE_KINDS = Object.freeze(['hide', 'css', 'text-replace', 'text-rewrite', 'no-translate']);
const TEXT_KINDS = Object.freeze(['text-replace', 'text-rewrite']);
const MAX_REPLACEMENT_LENGTH = 500;
const MAX_PATTERN_LENGTH = 500;

/**
 * `no-translate` 的「整個範圍都不要翻」寫法。
 *
 * 跟 `lib/glob.js` 的單星號特例同一個道理：`*` 在這裡不是萬用字元比對，
 * 它就是「這個 scope 裡的每一段」。
 */
const MATCH_ALL = '*';

/**
 * `*` 編出來的 matcher：任何字串都中。
 *
 * 寫成一個真的 `RegExp` 而不是在編譯結果上多一個 `matchAll` 旗標 ——
 * 多一個欄位就多一個「忘記看它」的機會，而忘記的後果是整站停翻。
 * 沒有 `g` 旗標，所以 `test()` 不會動 `lastIndex`。
 */
const MATCH_ANY = /^/;

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
    css: null,
    error: null,
  };
}

function compileHide(row) {
  const selector = safeCssSelector(row.pattern);
  return selector.ok ? { ...base(row), selector: selector.value } : failed(row, selector.error);
}

/** `css`：pattern 存的是 **CSS 文字**，不是選擇器（規格 §9） */
function compileCss(row) {
  const css = safeCssText(row.pattern);
  return css.ok ? { ...base(row), css: css.value } : failed(row, css.error);
}

/**
 * `no-translate`：pattern 是**文字比對**（不是選擇器），scope 選用（SPEC-rules §12）。
 *
 * 三種模式，都是沿用既有的編譯器 —— 這個型別沒有自己的語法：
 *
 * | pattern | 怎麼比 | 誰負責 |
 * |---|---|---|
 * | `is 100% free` | 字面子字串，空白寬鬆、不分大小寫 | `literal.js` |
 * | `/^\d+ /` | 正則（跟 `text-rewrite` 同一套保護） | `user-regex.js` |
 * | `*` | 整個 scope 內全部不翻 | `MATCH_ANY` |
 *
 * ⛔ **`*` 一定要配 scope**。沒有 scope 的 `*` ＝「這個站一段都不要翻」，
 * 而那個意思應該用站台設定的 `translate_enabled` 表達。一條規則能靜默關掉
 * 整站的翻譯是很糟的 footgun：使用者會以為是 ollama 壞了。
 */
function compileNoTranslate(row) {
  const raw = typeof row.pattern === 'string' ? row.pattern : '';
  const pattern = raw.trim();

  if (pattern.length === 0) return failed(row, 'pattern 不能是空的');
  if (raw.length > MAX_PATTERN_LENGTH) {
    return failed(row, `pattern 最長 ${MAX_PATTERN_LENGTH} 個字`);
  }

  const scope = parseScope(row.scope ?? null);
  if (!scope.ok) return failed(row, scope.error);

  if (pattern === MATCH_ALL) {
    return scope.value === null
      ? failed(row, '* 要配「限定範圍」才有意義（整站不翻請關掉站台設定裡的翻譯）')
      : { ...base(row), matcher: MATCH_ANY, scopeParsed: scope.value };
  }

  if (!isSlashForm(pattern)) {
    return { ...base(row), matcher: literalToRegex(pattern), scopeParsed: scope.value };
  }

  const compiled = compileUserRegex(pattern);
  return compiled.ok
    ? { ...base(row), matcher: compiled.value, scopeParsed: scope.value }
    : failed(row, compiled.error);
}

function compileText(row) {
  const pattern = typeof row.pattern === 'string' ? row.pattern : '';
  if (pattern.length === 0) return failed(row, 'pattern 不能是空的');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return failed(row, `pattern 最長 ${MAX_PATTERN_LENGTH} 個字`);
  }

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

  if (row.kind === 'hide') return compileHide(row);
  if (row.kind === 'css') return compileCss(row);
  if (row.kind === 'no-translate') return compileNoTranslate(row);
  return compileText(row);
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

/** 真的會被注入的那些 CSS 片段 */
function activeCssRules(compiled) {
  return compiled.filter((rule) => rule.enabled && !rule.error && rule.kind === 'css' && rule.css);
}

/**
 * 真的會被拿去篩段落的那些 `no-translate` 規則。
 *
 * 跟 `activeTextRules` 一樣要求 `matcher` 存在 —— 編不起來的規則**什麼都不做**，
 * 而不是「保守地全部不翻」。壞掉的規則讓整站停翻是最糟的失敗模式（使用者會
 * 去查 ollama，而真因是控制台裡一條標紅的規則）。
 */
function activeNoTranslateRules(compiled) {
  return compiled.filter(
    (rule) => rule.enabled && !rule.error && rule.kind === 'no-translate' && rule.matcher,
  );
}

/** 兩種都會變成注入的 CSS。`order_index` 決定順序 ＝ 決定誰覆蓋誰（後者勝）。 */
function activeStyleRules(compiled) {
  return compiled.filter(
    (rule) => rule.enabled && !rule.error && (rule.kind === 'hide' || (rule.kind === 'css' && rule.css)),
  );
}

module.exports = {
  compileRule,
  compileRules,
  activeTextRules,
  activeHideRules,
  activeCssRules,
  activeStyleRules,
  activeNoTranslateRules,
  RULE_KINDS,
  TEXT_KINDS,
  MATCH_ALL,
  MAX_REPLACEMENT_LENGTH,
  MAX_PATTERN_LENGTH,
};
