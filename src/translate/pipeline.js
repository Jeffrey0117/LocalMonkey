'use strict';

/**
 * 切段 → 篩選 → 回填。純函式，不碰 DB、不碰網路。
 *
 * `decode` / `encode` 是注入的，因為同一套邏輯要在兩種字串上跑：
 *   - 測試與爬蟲：真的 UTF-8 字串 → identity
 *   - 代理管線：latin1 字串（每個字元是一個 byte）→ `bytes.js` 的那兩支
 */

const { segmentHtml } = require('./segment.js');
const { decodeEntities, encodeEntities } = require('./entities.js');
const { splitEdges, normalizeSpace, isTranslatable } = require('./rules.js');

const identity = (value) => value;

/**
 * 要翻的段，附上回填需要的一切。
 *
 * `text` 是**解碼 + entity 還原 + 空白正規化**之後的樣子 —— 那也是快取的 key，
 * 所以同一句話在不同頁面換行位置不同時仍然命中同一筆。
 *
 * @param {string} html
 * @param {{ glossary?: string[], decode?: (text: string) => string }} [options]
 */
function collectSegments(html, { glossary = [], decode = identity } = {}) {
  return segmentHtml(html).reduce((items, segment) => {
    const { lead, core, trail } = splitEdges(segment.raw);
    if (core.length === 0) return items;

    const text = normalizeSpace(decodeEntities(decode(core)));
    if (!isTranslatable(text, { glossary })) return items;

    return [
      ...items,
      {
        start: segment.start,
        end: segment.end,
        raw: segment.raw,
        kind: segment.kind,
        element: segment.element,
        attribute: segment.attribute ?? null,
        lead,
        trail,
        text,
      },
    ];
  }, []);
}

/** 去重後的原文清單（一頁裡 `Read more` 會出現十次，沒必要翻十次） */
function uniqueTexts(items) {
  return [...new Set(items.map((item) => item.text))];
}

/**
 * 把譯文填回 HTML。
 *
 * - `resolve(text)` 回 null / 空字串 / 非字串 → **保留原文**（模型回垃圾時
 *   不要把版面清掉）
 * - 前後空白原樣放回（規格 §3）
 * - 屬性值用屬性模式重新編碼（譯文裡的引號會把標籤弄斷）
 *
 * @param {string} html
 * @param {Array<object>} items `collectSegments` 的輸出
 * @param {(text: string, item: object) => string|null} resolve
 * @param {{ encode?: (text: string) => string }} [options]
 * @returns {{ html: string, applied: number }}
 */
function renderTranslated(html, items, resolve, { encode = identity } = {}) {
  const replacements = items.reduce((acc, item) => {
    const translated = resolve(item.text, item);
    if (typeof translated !== 'string' || translated.trim().length === 0) return acc;

    const encoded = encode(encodeEntities(translated, { attribute: item.kind === 'attribute' }));
    return [...acc, { item, value: `${item.lead}${encoded}${item.trail}` }];
  }, []);

  if (replacements.length === 0) return { html, applied: 0 };

  const { parts, at } = replacements.reduce(
    (acc, { item, value }) => ({
      parts: [...acc.parts, html.slice(acc.at, item.start), value],
      at: item.end,
    }),
    { parts: [], at: 0 },
  );

  return { html: [...parts, html.slice(at)].join(''), applied: replacements.length };
}

module.exports = { collectSegments, uniqueTexts, renderTranslated };
