'use strict';

/**
 * 改造規則對代理的門面（SPEC-rules §1）。
 *
 * ```
 * 上游 HTML → 網址改寫 → 翻譯回填
 *           → 文字規則（text-replace / text-rewrite）  ← 這裡
 *           → 注入 hide 規則的 CSS                      ← 這裡
 *           → 腳本注入 → 送出
 * ```
 *
 * ⛔ 跟 `translate/service.js` 一樣是**同步**的，而且只查 SQLite。規則層一旦
 * 能 await，就一定有人會在請求路徑上做網路 IO。
 *
 * ⛔ 文字規則**只套在明確宣告 UTF-8 的文件上**，理由跟翻譯層一模一樣
 * （`translate/charset.js` 有完整說明）：HTML 改寫全程走 latin1，而使用者寫的
 * 替換字幾乎都含中文 —— 把 UTF-8 的 byte 插進一份宣告 Big5 的頁面，使用者看到
 * 的是亂碼。`hide` 不受這個限制：選擇器已經被跳脫成純 ASCII，塞進任何編碼的
 * 頁面都一樣。
 */

const { compileRules, activeHideRules } = require('./compile.js');
const { applyTextRules } = require('./apply.js');
const { buildHideCss } = require('./hide-css.js');
const { injectStyleTag } = require('./style-tag.js');
const { isUtf8Document } = require('../translate/charset.js');
const { fromLatin1, toLatin1 } = require('../translate/bytes.js');

/**
 * @param {{ store: object, logger: object }} context
 */
function createSiteRulesService({ store, logger }) {
  /**
   * 每個請求重新讀 + 重新編譯。
   *
   * 看起來浪費，但是刻意的：規則通常不到 20 條，一次 index 命中的 SELECT 加
   * 幾個正則編譯是微秒級；而快取 `RegExp` 物件會帶著 `lastIndex` 跨請求活著，
   * 那種 bug 只在高併發下現形。「改了規則立刻生效」也是這樣來的。
   */
  function rulesFor(siteId) {
    return compileRules(store.siteRules.listBySite(siteId));
  }

  /**
   * @param {string} html latin1 管線字串
   * @param {{ site: object, contentType: string|null, onStats?: (stats: object) => void }} input
   * @returns {string}
   */
  function applyToHtml(html, { site, contentType, onStats }) {
    try {
      const compiled = rulesFor(site.id);
      if (compiled.length === 0) return html;

      const utf8 = isUtf8Document(html, contentType);
      const text = utf8
        ? applyTextRules(html, compiled, { decode: fromLatin1, encode: toLatin1 })
        : { html, applied: 0, hits: {}, skipped: 0, timedOut: [] };

      if (!utf8) logger.debug?.(`${site.id}：沒宣告 UTF-8，跳過文字規則`);
      for (const id of text.timedOut) {
        logger.warn(`${site.id} 的規則 ${id} 超過時間預算，這一份文件剩下的段跳過它`);
      }

      const css = buildHideCss(compiled);

      onStats?.({
        hide: activeHideRules(compiled).length,
        text: text.applied,
        hits: text.hits,
        charsetSkipped: !utf8,
      });

      return injectStyleTag(text.html, css);
    } catch (error) {
      // 規則是加值功能，不准讓頁面開不起來
      logger.error(`套用 ${site.id} 的改造規則時出錯，已退回原文`, error);
      return html;
    }
  }

  /**
   * 控制台的「試一下」（規格 §4）：這組規則在這份 HTML 上命中幾段。
   *
   * 吃的是**真文字**（不是 latin1 管線字串）—— 呼叫端是 admin API，它自己
   * 從上游抓一份頁面下來。`hide` 規則的命中數**不在這裡算**：那要真的 CSS
   * 比對，所以交給瀏覽器（控制台用 DOMParser + querySelectorAll 自己數）。
   *
   * @param {string} html 真文字
   * @param {Array<object>} rows `site_rules` 的列
   */
  function dryRun(html, rows) {
    const compiled = compileRules(rows);
    const result = applyTextRules(html, compiled);

    return {
      rules: compiled.map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        pattern: rule.pattern,
        scope: rule.scope,
        enabled: rule.enabled,
        error: rule.error,
        // hide 的命中數由瀏覽器算（這裡回 null 而不是 0，UI 才分得出「不知道」）
        matched: rule.kind === 'hide' ? null : result.hits[rule.id] ?? 0,
      })),
      applied: result.applied,
      skippedSegments: result.skipped,
      timedOut: result.timedOut,
      css: buildHideCss(compiled),
    };
  }

  /** 控制台列表用：原本的列 + 編譯錯誤（規格 §4：壞掉的那一列要標紅） */
  function listForSite(siteId) {
    const rows = store.siteRules.listBySite(siteId);
    const errors = new Map(compileRules(rows).map((rule) => [rule.id, rule.error]));

    return rows.map((row) => ({ ...row, error: errors.get(row.id) ?? null }));
  }

  return { applyToHtml, dryRun, listForSite, rulesFor };
}

module.exports = { createSiteRulesService };
