'use strict';

/**
 * `scope`：把一條文字規則限制在某個選擇器**裡面**（規格 §3.2）。
 *
 * 為什麼需要：卡片標題的 `634 燈河` → `燈河[634]` 這條規則全站套會把
 * 「2026 年的設計趨勢」這種開頭是數字的句子一起改掉。
 *
 * ⛔ 這裡**不是**完整的 CSS 選擇器引擎，而且刻意不做成完整的。伺服器端沒有
 * DOM（切段器是一台狀態機，見 translate/segment.js），所以只支援「看得懂
 * 祖先鏈就能判斷」的那個子集：
 *
 *   tag / .class / #id / *  ＋  後代（空白）與子（>）組合子  ＋  逗號分隔
 *
 * `p + p`、`:hover`、`[data-x]` 這些**一律拒絕**而不是忽略：忽略等於「規則
 * 悄悄套到全站」，那是比沒生效嚴重得多的錯。`hide` 規則不受這個限制 ——
 * 它的選擇器是交給瀏覽器比對的，完整的 CSS 都可以用。
 */

const COMPOUND = /^(?:\*|[a-zA-Z][\w-]*)?(?:[.#][\w-]+)*$/;

/** `div.card#x` → `{ tag:'div', classes:['card'], id:'x' }` */
function parseCompound(source) {
  if (!COMPOUND.test(source)) return null;

  const tagMatch = /^(\*|[a-zA-Z][\w-]*)/.exec(source);
  const tag = tagMatch && tagMatch[1] !== '*' ? tagMatch[1].toLowerCase() : null;

  const classes = [...source.matchAll(/\.([\w-]+)/g)].map((matched) => matched[1]);
  const ids = [...source.matchAll(/#([\w-]+)/g)].map((matched) => matched[1]);

  if (ids.length > 1) return null;
  if (!tag && classes.length === 0 && ids.length === 0 && source !== '*') return null;

  return { tag, classes, id: ids[0] ?? null };
}

/** `.a > b c` → 一串 compound，每個帶著它**前面**那個組合子 */
function parseSelector(selector) {
  const tokens = selector
    .replace(/\s*>\s*/g, ' > ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  const compounds = [];
  let combinator = null;

  for (const token of tokens) {
    if (token === '>') {
      // 連續兩個組合子（`a > > b`）或開頭就是組合子 → 看不懂
      if (combinator !== null || compounds.length === 0) return null;
      combinator = '>';
      continue;
    }

    const simple = parseCompound(token);
    if (!simple) return null;

    compounds.push({ simple, combinator });
    combinator = null;
  }

  return combinator === null ? compounds : null;
}

/**
 * @param {unknown} scope `null` / 空字串 ＝ 全站
 * @returns {{ ok: true, value: Array|null } | { ok: false, error: string }}
 */
function parseScope(scope) {
  if (scope === null || scope === undefined || scope === '') {
    return { ok: true, value: null };
  }
  if (typeof scope !== 'string' || scope.trim().length === 0) {
    return { ok: false, error: 'scope 必須是字串' };
  }
  if (scope.length > 200) {
    return { ok: false, error: 'scope 最長 200 個字' };
  }

  const selectors = scope.split(',').map((part) => parseSelector(part));
  if (selectors.some((parsed) => parsed === null)) {
    return {
      ok: false,
      error: 'scope 只支援 tag / .class / #id / * 與後代（空白）、子（>）組合子',
    };
  }

  return { ok: true, value: selectors };
}

function matchesCompound(element, simple) {
  if (!element) return false;
  if (simple.tag && element.tag !== simple.tag) return false;
  if (simple.id && element.id !== simple.id) return false;
  return simple.classes.every((name) => element.classes.includes(name));
}

/** compounds[index] 要對上 chain[at]，再往上比對前面的 compound */
function matchesSuffix(chain, at, compounds, index) {
  if (at < 0 || !matchesCompound(chain[at], compounds[index].simple)) return false;
  if (index === 0) return true;

  if (compounds[index].combinator === '>') {
    return matchesSuffix(chain, at - 1, compounds, index - 1);
  }

  for (let above = at - 1; above >= 0; above -= 1) {
    if (matchesSuffix(chain, above, compounds, index - 1)) return true;
  }
  return false;
}

/**
 * 這一段在範圍內嗎？
 *
 * 「在範圍內」＝祖先鏈上**任何一個**元素符合選擇器（不必是最內層那個）——
 * 因為 scope 的語意是「在這個東西裡面」。
 *
 * @param {Array<{tag: string, id: string|null, classes: string[]}>} ancestors 最外層在前
 * @param {Array|null} parsed `parseScope().value`；null ＝ 全站
 */
function matchesScope(ancestors, parsed) {
  if (parsed === null || parsed === undefined) return true;
  if (!Array.isArray(ancestors) || ancestors.length === 0) return false;

  return parsed.some((compounds) =>
    ancestors.some((_, at) => matchesSuffix(ancestors, at, compounds, compounds.length - 1)),
  );
}

module.exports = { parseScope, matchesScope, parseSelector, parseCompound };
