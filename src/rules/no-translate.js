'use strict';

/**
 * `no-translate`：哪些段**不要餵給模型**（SPEC-rules §12）。
 *
 * ⛔ 為什麼需要一個新型別，而 `hide` 不夠：翻譯層跑在規則層**之前**
 * （SPEC-rules §1 的執行順序，那個順序是為了「改規則立刻生效、不用重翻」），
 * 所以 `hide` 藏掉的東西照樣被切段、照樣進佇列、照樣燒 ollama 的時間。
 * templatemo 的詳情頁有一句名字內嵌的樣板文，600+ 個模板就是 600+ 段
 * **沒有人會看到的**翻譯。
 *
 * ⛔ 為什麼 pattern 是文字比對而不是 CSS 選擇器：伺服器端沒有 DOM。既有的
 * `scope`（`rules/scope.js`）只看得懂「祖先鏈就能判斷」的子集 ——
 * `:has()`、`:nth-of-type()`、`[attr]` 一律拒絕。而那段樣板文的容器是
 * `#tm-dl-box p`，跟 `Tags:` / `Added:` 那幾段**同一個容器**（§10.4 才剛修好
 * 讓它們進佇列）。所以「用選擇器圈出那一段」在這個站上做不到，文字比對才做得到。
 * scope 還是留著當**附加**的收窄條件，用的就是文字規則那一套（同樣的限制）。
 *
 * 這支是規則層伸進翻譯層的唯一一隻手：`translate/service.js`（請求路徑）與
 * `translate/crawl.js`（預先翻譯整站）都走 `collectTranslatable()`。
 * 少接一邊的後果是「頁面上省掉了，但按一次『預先翻譯整站』又全部塞回佇列」。
 */

const { compileRules, activeNoTranslateRules } = require('./compile.js');
const { matchesScope } = require('./scope.js');
const { collectSegments } = require('../translate/pipeline.js');
const { segmentHtml } = require('../translate/segment.js');
const { splitEdges, normalizeSpace, isTranslatable } = require('../translate/rules.js');
const { decodeEntities } = require('../translate/entities.js');

/**
 * 這一段中了這條規則嗎？
 *
 * ⛔ `lastIndex = 0`：`literalToRegex` 與 `compileUserRegex` 給的都是帶 `g`
 * 旗標的 `RegExp`，而 `test()` 會把 `lastIndex` 往前推 —— 同一條規則比到第二段
 * 時就會從上一次的位置開始找，於是「有些段中、有些段不中」而且毫無規律。
 * （`applyLiteral` 也是同一個紀律。）
 */
function matchesRule(rule, text, ancestors) {
  if (!matchesScope(ancestors ?? [], rule.scopeParsed)) return false;

  rule.matcher.lastIndex = 0;
  return rule.matcher.test(text);
}

/**
 * 這個站的 `no-translate` 規則，包成一支判斷函式。
 *
 * 回 `null` 而不是一支「永遠回 false」的函式 —— 呼叫端要靠它決定「這份文件
 * 到底需不需要算祖先鏈」，而絕大多數站是一條規則都沒有的。
 *
 * @param {Array<object>} rows `site_rules` 的列
 * @returns {{ rules: Array<object>, needsAncestors: boolean, skip: (text: string, segment: object) => boolean } | null}
 */
function createNoTranslateFilter(rows) {
  const rules = activeNoTranslateRules(compileRules(rows));
  if (rules.length === 0) return null;

  return {
    rules,
    // 祖先鏈要多算每個元素的 id 與 class，沒有 scope 的規則不需要它
    needsAncestors: rules.some((rule) => rule.scopeParsed !== null),
    skip: (text, segment) =>
      rules.some((rule) => matchesRule(rule, text, segment?.ancestors)),
  };
}

/** @param {object} store @param {string} siteId */
function noTranslateFilterForSite(store, siteId) {
  // 翻譯層的測試常常給一個只有翻譯那幾張表的假 store —— 沒有規則就是沒有規則
  const rows = store?.siteRules?.listBySite?.(siteId) ?? [];
  return createNoTranslateFilter(rows);
}

/**
 * 切段 → 篩掉 `no-translate` 命中的段。**翻譯層的入口就是這支。**
 *
 * `skipped` 是「本來要進佇列、被規則擋下來」的段數 —— 那是這個功能唯一看得到
 * 的產出（`x-lm-translate` 的 `no-translate=14` 與控制台的命中數都是它）。
 * 篩在 `isTranslatable` **之後**，所以這個數字的意思是真的省下來的工作量，
 * 不是「掃過幾段」。
 *
 * @param {string} html
 * @param {{ store: object, siteId: string, glossary?: string[], decode?: (text: string) => string }} context
 * @returns {{ items: Array<object>, skipped: number, rules: Array<object> }}
 */
function collectTranslatable(html, { store, siteId, glossary = [], decode }) {
  const filter = noTranslateFilterForSite(store, siteId);

  const collected = collectSegments(html, {
    glossary,
    ...(decode ? { decode } : {}),
    ancestors: filter?.needsAncestors === true,
  });

  const items = filter ? collected.filter((item) => !filter.skip(item.text, item)) : collected;

  return { items, skipped: collected.length - items.length, rules: filter?.rules ?? [] };
}

/**
 * 控制台「試一下」的命中數：每條規則擋掉了幾段。
 *
 * ⛔ 數的是**還沒翻的**段。呼叫端（`rules/service.js` 的 `dryRun`）拿到的 HTML
 * 已經先過了一次翻譯回填，所以已經是中文的段會被 `isTranslatable` 的 CJK 判斷
 * 濾掉 —— 那正好：`no-translate` 擋下來的段永遠不會變成中文，所以該數到的都數得到。
 * 一段同時中兩條規則時只算給**第一條**（它就是實際生效的那一條）。
 *
 * @param {string} html 真文字（不是 latin1 管線字串）
 * @param {Array<object>} compiled `compileRules()` 的輸出
 */
function countNoTranslate(html, compiled, { glossary = [] } = {}) {
  const rules = activeNoTranslateRules(compiled);
  if (rules.length === 0) return {};

  return segmentHtml(html, { ancestors: true }).reduce((counts, segment) => {
    const { core } = splitEdges(segment.raw);
    if (core.length === 0) return counts;

    const text = normalizeSpace(decodeEntities(core));
    if (!isTranslatable(text, { glossary })) return counts;

    const hit = rules.find((rule) => matchesRule(rule, text, segment.ancestors));
    return hit ? { ...counts, [hit.id]: (counts[hit.id] ?? 0) + 1 } : counts;
  }, {});
}

module.exports = {
  createNoTranslateFilter,
  noTranslateFilterForSite,
  collectTranslatable,
  countNoTranslate,
  matchesRule,
};
