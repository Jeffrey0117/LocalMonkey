'use strict';

/**
 * 翻譯快取的對外介面（規格 §4 的 `cache.js`）。
 *
 * SQL 放在 `db/translations.js` —— 這個專案所有資料表的讀寫都在 `src/db/`，
 * 翻譯沒有理由當例外。這一層只做兩件事：
 *   1. 把 hash 的算法暴露給需要指名某一段的人（UI 的人工覆寫、重翻）
 *   2. `resolveTexts()`：把 lookup 的結果變成「段 → 譯文字串」的查表函式，
 *      給 `pipeline.renderTranslated` 直接用
 */

const { translationHash } = require('../db/translations.js');

/**
 * @param {object} store
 * @param {{ texts: string[], targetLang: string, model: string }} input
 * @returns {{ resolve: (text: string) => string|null, hits: number, misses: string[] }}
 */
function resolveTexts(store, { texts, targetLang, model }) {
  const found = store.translations.lookup({ texts, targetLang, model });
  const unique = [...new Set(texts)];

  return {
    resolve: (text) => found.get(text)?.translated ?? null,
    hits: found.size,
    misses: unique.filter((text) => !found.has(text)),
  };
}

module.exports = { translationHash, resolveTexts };
