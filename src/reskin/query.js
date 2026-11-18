'use strict';

/**
 * 在 `dom.js` 的樹上跑選擇器。
 *
 * 選擇器的**文法與比對一行都沒有自己寫** —— 整個沿用 `rules/scope.js`：
 *
 *   tag / .class / #id / *  ＋  後代（空白）與子（>）組合子  ＋  逗號分隔
 *
 * 差別只有「比對釘在哪一節」：`scope` 問的是「這段文字在不在某個東西裡面」
 * （祖先鏈上任何一節符合就算），抽取問的是「**這個元素**符合嗎」
 * （鏈的最後一節就是候選元素）。所以這裡呼叫 `matchesSuffix` 而不是
 * `matchesScope`，其餘完全共用。
 *
 * 好處是使用者只要學一套語法，而且 `:has()` / `[attr]` / `+` 這些
 * **一律拒絕而不是忽略**的紀律也一起繼承了 —— 忽略的後果是「設定看起來
 * 存好了但抽到的是別的東西」，那比編不過難查得多。
 */

const { parseSelector, matchesSuffix } = require('../rules/scope.js');
const { isElement } = require('./dom.js');
const { decodeEntities } = require('../translate/entities.js');
const { normalizeSpace } = require('../translate/rules.js');

/**
 * 選擇器字串 → 可執行的形狀。
 * @returns {{ ok: true, value: Array }|{ ok: false, error: string }}
 */
function compileSelector(selector) {
  if (typeof selector !== 'string' || selector.trim().length === 0) {
    return { ok: false, error: '選擇器不能是空的' };
  }
  if (selector.length > 200) {
    return { ok: false, error: '選擇器最長 200 個字' };
  }

  const parsed = selector.split(',').map((part) => parseSelector(part));
  if (parsed.some((part) => part === null)) {
    return {
      ok: false,
      error: '只支援 tag / .class / #id / * 與後代（空白）、子（>）組合子',
    };
  }

  return { ok: true, value: parsed };
}

/** 這個元素（鏈的最後一節）符合嗎 */
function matchesChain(chain, compiled) {
  return compiled.some((compounds) =>
    matchesSuffix(chain, chain.length - 1, compounds, compounds.length - 1),
  );
}

/**
 * 從 `from` 底下找出所有符合的元素（**不含 `from` 自己**，同 `querySelectorAll`）。
 *
 * 祖先鏈從 `from` 的子層開始算，所以 `.card img` 在「以某張卡片為根」的查詢裡
 * 不會因為卡片本身不在鏈上而配不起來 —— 而這也意味著**每一項的欄位選擇器是
 * 相對於那一項的容器**（規格 §3.1 的 `item` + `fields` 就是這個語意）。
 *
 * ⛔ `limit` 是**候選**上限，不是結果上限 —— 呼叫端的 `when` 是在這之後才
 * 篩的。所以這個數字要給得大方（它只是「別在壞掉的頁面上走到天荒地老」的
 * 防線），真正的結果上限由 `extract.js` 在篩完之後算。
 * 第一版把它設成 50 當結果上限，於是「分類列」只抓到 4 個標籤：頁面前 50 個
 * `<a>` 裡剛好只有 4 個是標籤連結，後面的全部沒被看過。
 *
 * @param {object} from `dom.js` 的節點
 * @param {Array} compiled `compileSelector().value`
 * @param {{ limit?: number }} [options]
 * @returns {Array<object>} 文件順序
 */
function queryAll(from, compiled, { limit = 5000 } = {}) {
  const found = [];

  const walk = (node, chain) => {
    if (found.length >= limit) return;

    for (const child of node.children) {
      if (!isElement(child)) continue;

      const next = [...chain, child];
      if (matchesChain(next, compiled)) {
        found.push(child);
        if (found.length >= limit) return;
      }
      walk(child, next);
    }
  };

  walk(from, []);
  return found;
}

/**
 * 遞迴的文字內容，**照文件順序**。
 *
 * 文字節點就在 `children` 裡（`dom.js` 有為什麼），所以這支是一個單純的
 * 依序串接 —— 不要改成「先取自己的文字再接子元素」，那會把
 * `<strong>Views:</strong> 11,249` 散成 `11,249Views:`。
 */
function textOf(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.text;

  return node.children.reduce((acc, child) => acc + textOf(child), '');
}

/**
 * 一個元素身上的值。
 *
 * `text` 走跟翻譯層同一套正規化（entity 還原 + 壓白空白）—— 抽出來的字會進
 * 我們自己產生的 HTML，而那份 HTML 之後還要再被翻譯層切段，所以在這裡就
 * 處理成乾淨文字最省事。其餘的 `attr` 一律是屬性原值（entity 也要還原：
 * `href="/a?b&amp;c"` 的真值是 `&`）。
 *
 * @param {object} node
 * @param {string} attr `'text'` 或屬性名
 * @returns {string} 抽不到就是空字串（**不是 null** —— 呼叫端只關心「有沒有值」）
 */
function valueOf(node, attr) {
  if (!node) return '';
  if (attr === 'text') return normalizeSpace(decodeEntities(textOf(node)));

  const raw = node.attrs[attr];
  return typeof raw === 'string' ? decodeEntities(raw).trim() : '';
}

module.exports = { compileSelector, queryAll, matchesChain, textOf, valueOf };
