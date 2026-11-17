'use strict';

/**
 * 給模型的 prompt（純函式，方便逐字測）。
 *
 * ⛔ 請求格式是**索引當 key 的 object**（`{"0":"...","1":"..."}`），不是陣列。
 * 規格 §1 的實測：要陣列時模型會回 object 而且整批錯位 —— 第一段的譯文
 * 被拿去當 key。索引 key 實測 10/10 對齊。
 */

const { termsIn } = require('./glossary.js');

const LANGUAGE_NAMES = Object.freeze({
  'zh-TW': '繁體中文',
  'zh-CN': '简体中文',
  'zh-HK': '繁體中文（香港）',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
});

const DEFAULT_LANG = 'zh-TW';

function languageName(targetLang) {
  return LANGUAGE_NAMES[targetLang] ?? targetLang;
}

/** 原文包成索引 key 的 object */
function payloadFor(texts) {
  return texts.reduce((acc, text, index) => ({ ...acc, [index]: text }), {});
}

/**
 * @param {string[]} texts
 * @param {{ targetLang?: string, glossary?: string[] }} [options]
 */
function buildPrompt(texts, { targetLang = DEFAULT_LANG, glossary = [] } = {}) {
  const language = languageName(targetLang ?? DEFAULT_LANG);

  // 只列「這一批真的用到」的術語。全表塞進去的話每批都拖著一串無關指示，
  // 既浪費 context 又會讓模型分心去「保留」根本沒出現的詞。
  const used = [...new Set(texts.flatMap((text) => termsIn(text, glossary)))];
  const keepLine =
    used.length > 0 ? `\n以下專有名詞請原樣保留，不要翻譯：${used.join('、')}\n` : '';

  // JSON.stringify 一律用在原文上：引號、換行、反斜線都不准破壞結構
  const payload = JSON.stringify(payloadFor(texts), null, 1);
  const keys = texts.map((unused, index) => `"${index}"`).join('、');

  return [
    `把下面 JSON 物件裡每一個 value 翻成${language}。`,
    '',
    '規則：',
    `1. 回傳的 JSON 物件要有**一模一樣的 key**（${keys}），一個都不能少、不能多、不能改。`,
    '2. 只翻 value，不要翻 key。',
    '3. 維持原本的大小寫風格與標點；數字、網址、email、程式碼不要動。',
    '4. 這些是網頁 UI 上的字，請用網頁上習慣的說法（簡短、自然）。',
    '5. 只回 JSON，不要加任何說明、註解或 markdown 標記。',
    keepLine,
    '原文：',
    payload,
  ].join('\n');
}

module.exports = { buildPrompt, payloadFor, languageName, LANGUAGE_NAMES, DEFAULT_LANG };
