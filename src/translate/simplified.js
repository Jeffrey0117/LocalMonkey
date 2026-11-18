'use strict';

/**
 * 「這段文字裡有簡體字嗎」（SPEC-rules §5.1）。
 *
 * 為什麼需要：v4 的 prompt 後來才加上「禁止簡體字」，但**加之前翻的那些還在
 * 快取裡**（實測 142 段裡有 6 段：`灯笼河`、`动感`、`幻灯片`）。翻譯快取是
 * 永久的，所以不掃出來重翻的話它們永遠不會自己好。
 *
 * ⛔ 規格明說**不要自己手寫字元清單** —— 手寫的第一版漏了「灯」「笼」「动」，
 * 於是「掃出 0 段」變成一個假答案。所以主表是**產生出來的**：
 * `scripts/generate-simplified-chars.ps1` 拿 Windows 自己的簡繁轉換表
 * （`Microsoft.VisualBasic.Strings.StrConv`，Office / 檔案總管用的同一份）
 * 掃過整個 CJK 區，把「轉成繁體之後會變成別的字」的碼位寫成資料。
 *
 * 產生出來的表還是要兩份人工清單修邊：
 *
 * - `NOT_SIMPLIFIED`：在繁體裡天天用、但轉換表會把它換掉的字。`台` 是唯一
 *   真正要緊的一個（`台灣` / `控制台` / `平台`）—— 不排除的話幾乎每個站都會
 *   被誤判。
 * - `EXTRA_SIMPLIFIED`：兩邊都是合法字、所以轉換表動不了，但在現代中文裡
 *   出現就代表是簡體的字。`么`（`什么` / `怎么`）是典型。
 *
 * 誤判的代價不對稱：**多重翻一段**只是多花幾秒，**漏掉一段**是使用者看著
 * 簡體字而我們回報「0 段」。所以邊界往「寧可多抓」的方向倒。
 */

const { SIMPLIFIED_CODE_POINTS } = require('./simplified-chars.js');

/** 轉換表會動它，但它在繁體書寫裡是正字 → 不算簡體 */
const NOT_SIMPLIFIED = Object.freeze(new Set(['台']));

/** 轉換表動不了（兩邊都合法），但出現就代表是簡體 */
const EXTRA_SIMPLIFIED = Object.freeze(new Set(['么']));

const SIMPLIFIED_CHARS = Object.freeze(
  new Set([
    ...SIMPLIFIED_CODE_POINTS.map((codePoint) => String.fromCodePoint(codePoint)).filter(
      (character) => !NOT_SIMPLIFIED.has(character),
    ),
    ...EXTRA_SIMPLIFIED,
  ]),
);

/**
 * @param {unknown} text
 * @returns {string[]} 出現過的簡體字（去重、照出現順序）
 */
function findSimplified(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  return [...new Set([...text].filter((character) => SIMPLIFIED_CHARS.has(character)))];
}

/** @param {unknown} text */
function containsSimplified(text) {
  if (typeof text !== 'string') return false;

  for (const character of text) {
    if (SIMPLIFIED_CHARS.has(character)) return true;
  }
  return false;
}

/** 繁體的目標語言（zh-TW / zh-HK / zh-Hant…）。其他語言不該被這套規則管。 */
const TRADITIONAL_LANGS = /^zh-(tw|hk|mo|hant)(-|$)/i;

/**
 * 這個目標語言要不要擋簡體？
 *
 * ⛔ 一定要問這一題：使用者把 `translate_lang` 設成 `zh-CN` 的時候，
 * 簡體字**才是對的答案**。把「禁止簡體」寫死在佇列裡等於把那個設定弄壞。
 *
 * @param {unknown} targetLang
 */
function wantsTraditional(targetLang) {
  return typeof targetLang === 'string' && TRADITIONAL_LANGS.test(targetLang);
}

module.exports = {
  containsSimplified,
  findSimplified,
  wantsTraditional,
  SIMPLIFIED_CHARS,
  NOT_SIMPLIFIED,
  EXTRA_SIMPLIFIED,
};
