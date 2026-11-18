'use strict';

/**
 * 「這一段要不要翻」的規則（規格 §3「不翻的段（漏了會出事）」）。
 *
 * 全部是純函式，吃**解碼後的真文字**（不是 latin1 管線字串）。
 *
 * 這個檔案裡所有非 ASCII 字元都寫成 `\uXXXX` 轉義：字面的 U+00A0 /
 * U+2028 在編輯器裡看不見（CLAUDE.md 地雷 13 就是這樣炸的），而 CJK
 * 範圍寫成轉義也比貼一串漢字好校對。
 */

const { isGlossaryTerm } = require('./glossary.js');

const MIN_LENGTH = 2;

/** 一段 1200 字以上的東西通常是 JSON blob 或整篇文章，會把一整批拖垮 */
const MAX_LENGTH = 1200;

/**
 * 中日韓（含注音、諺文）。已經是中文的段再翻一次會被翻壞 —— 規格 §3 點名的規則。
 * JS 的 `\s` 本來就含 U+00A0，所以空白一律用 `\s` 就夠。
 */
const CJK = /[\u3040-\u30ff\u3100-\u312f\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 整段看起來是網址。
 *
 * ⛔ scheme 後面**一定要還有東西**（`\S`）。真實事故（2026-11-18）：第一版寫成
 * `[a-z][a-z0-9+.-]*:`，於是詳情頁的 `Added:` / `Views:` / `Downloads:` / `Tags:`
 * 被認成 URL scheme，**永遠不會進翻譯佇列** —— 而同一行的日期翻好了，所以症狀
 * 長得像「模型漏翻了這幾個字」，完全猜不到是切段規則濾掉的。
 * 真的 scheme 後面必有內容（`http://x`、`mailto:a@b`、`data:image/png`）。
 */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\S|\/\/|www\.)/i;
const PATH_LIKE = /^\/[^\s]*$/;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** entity 參照：算「有沒有真文字」時要先剔掉，不然 `&copy;` 的 `copy` 會被當成字 */
const ENTITY_REFERENCE = /&(?:[a-zA-Z][a-zA-Z0-9]{0,30}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/g;

const REPLACEMENT_CHARACTER = '\ufffd';

/**
 * 把前後空白拆出來。
 *
 * ⛔ 規格 §3：**回填時要保留原本的前後空白**，不然 `</a> <a>` 之間的空白
 * 一消失，整排行內元素就黏在一起 —— 版面垮掉而且沒有任何錯誤訊息。
 *
 * @param {string} raw
 * @returns {{ lead: string, core: string, trail: string }}
 */
function splitEdges(raw) {
  if (typeof raw !== 'string') return { lead: '', core: '', trail: '' };

  const lead = /^\s*/.exec(raw)[0];
  if (lead.length === raw.length) return { lead: raw, core: '', trail: '' };

  const body = raw.slice(lead.length);
  const trail = /\s*$/.exec(body)[0];

  return { lead, core: body.slice(0, body.length - trail.length), trail };
}

/** 連續空白正規化後才比對（規格 §3）—— 同一句話換行位置不同不該算兩段 */
function normalizeSpace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/** 剔掉 entity 參照後還有沒有「字」（任何語言的字母） */
function hasRealLetters(text) {
  return /\p{L}/u.test(text.replace(ENTITY_REFERENCE, ''));
}

/**
 * @param {string} text 解碼 + 正規化後的文字
 * @param {{ glossary?: string[] }} [options]
 */
function isTranslatable(text, { glossary = [] } = {}) {
  if (typeof text !== 'string') return false;

  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH || trimmed.length > MAX_LENGTH) return false;

  // 解碼失敗（頁面宣稱 UTF-8 但其實不是）→ 餵進去就是垃圾，而且會污染快取
  if (trimmed.includes(REPLACEMENT_CHARACTER)) return false;

  if (!hasRealLetters(trimmed)) return false;
  if (CJK.test(trimmed)) return false;

  // 整段看起來是網址 / 路徑 / email 才跳過；句子裡「含有」網址的照翻
  if (!/\s/.test(trimmed)) {
    if (URL_LIKE.test(trimmed)) return false;
    if (EMAIL_LIKE.test(trimmed)) return false;
  }
  if (PATH_LIKE.test(trimmed)) return false;

  if (isGlossaryTerm(trimmed, glossary)) return false;

  return true;
}

module.exports = {
  splitEdges,
  normalizeSpace,
  isTranslatable,
  hasRealLetters,
  MIN_LENGTH,
  MAX_LENGTH,
  CJK,
};
