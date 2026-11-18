'use strict';

/**
 * 把文字規則套到一整份 HTML 上。
 *
 * 跟翻譯回填（translate/pipeline.js）同一套路數，但刻意**不共用**那條管線：
 *
 * - 翻譯用的是 `normalizeSpace` 之後的文字（那是快取的 key），而改造規則
 *   **不准**動段落裡的空白 —— 那會改掉頁面上看得到的排版。
 * - 翻譯只處理「值得翻的段」（`isTranslatable`），而改造規則要處理的正是
 *   那些被篩掉的段：footer 裡孤零零的 `-`、`634 Lantern River` 的編號。
 *
 * ⛔ 只改**切段器切出來的文字段**（文字節點 + alt/title/placeholder/aria-label
 * 這幾個給人讀的屬性）。`href` / `src` / `class` / `id` / `data-*` 永遠不在
 * 切段結果裡，所以結構上不可能被改到 —— 有一條回歸測試釘著這件事。
 */

const { segmentHtml } = require('../translate/segment.js');
const { splitEdges } = require('../translate/rules.js');
const { decodeEntities, encodeEntities } = require('../translate/entities.js');
const { applyRulesToText, createRuleState } = require('./text.js');
const { activeTextRules } = require('./compile.js');

const identity = (value) => value;

/**
 * @param {string} html latin1 管線字串時要帶 `decode` / `encode`（見 translate/bytes.js）
 * @param {Array<object>} compiled `compileRules()` 的輸出
 * @param {{
 *   decode?: (text: string) => string,
 *   encode?: (text: string) => string,
 *   budgetMs?: number,
 *   maxTextLength?: number,
 * }} [options]
 * @returns {{ html: string, applied: number, hits: Record<string, number>, skipped: number, timedOut: string[] }}
 */
function applyTextRules(html, compiled, options = {}) {
  const { decode = identity, encode = identity, budgetMs, maxTextLength } = options;
  const rules = activeTextRules(compiled);

  const empty = { html, applied: 0, hits: {}, skipped: 0, timedOut: [] };
  if (typeof html !== 'string' || rules.length === 0) return empty;

  const state = createRuleState();
  const hits = {};
  let skipped = 0;

  const replacements = segmentHtml(html, { ancestors: true }).reduce((acc, segment) => {
    const { lead, core, trail } = splitEdges(segment.raw);
    if (core.length === 0) return acc;

    const text = decodeEntities(decode(core));
    const result = applyRulesToText(text, rules, {
      ancestors: segment.ancestors,
      state,
      ...(budgetMs === undefined ? {} : { budgetMs }),
      ...(maxTextLength === undefined ? {} : { maxTextLength }),
    });

    if (result.skipped) skipped += 1;
    // 沒命中就連 entity 都不要重新編碼 —— 那是零必要的風險
    if (result.text === text) return acc;

    for (const id of result.hits) hits[id] = (hits[id] ?? 0) + 1;

    const encoded = encode(encodeEntities(result.text, { attribute: segment.kind === 'attribute' }));
    return [...acc, { segment, value: `${lead}${encoded}${trail}` }];
  }, []);

  if (replacements.length === 0) {
    return { ...empty, hits, skipped, timedOut: [...state.timedOut] };
  }

  const { parts, at } = replacements.reduce(
    (acc, { segment, value }) => ({
      parts: [...acc.parts, html.slice(acc.at, segment.start), value],
      at: segment.end,
    }),
    { parts: [], at: 0 },
  );

  return {
    html: [...parts, html.slice(at)].join(''),
    applied: replacements.length,
    hits,
    skipped,
    timedOut: [...state.timedOut],
  };
}

module.exports = { applyTextRules };
