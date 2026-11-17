'use strict';

/**
 * 翻譯層對代理的門面（規格 §5）。
 *
 * ```
 * 代理收到 HTML 且該站 translate_enabled
 *   → segment()
 *   → 批次查 translations 快取   ← 同步 SQLite，很快
 *       命中 → 用（manual 優先於 machine）
 *       沒命中 → 保留原文 + 丟進 translate_queue
 *   → restore() 回填
 *   → 送出
 * ```
 *
 * ⛔ `translateHtml` 是**同步**的，而且刻意沒有 async 版本：
 * 只要它能 await，就一定有人會在請求路徑上等 ollama ——
 * 那是 18 秒的首次載入，而不是零閃爍。背景佇列由 `queue.kick()` 推動
 * （射後不理），翻好之後**下次載入就是中文**。
 */

const { createOllamaClient } = require('./ollama.js');
const { createTranslationQueue } = require('./queue.js');
const { collectSegments, renderTranslated, uniqueTexts } = require('./pipeline.js');
const { resolveTexts } = require('./cache.js');
const { isUtf8Document } = require('./charset.js');
const { fromLatin1, toLatin1 } = require('./bytes.js');
const { DEFAULT_GLOSSARY } = require('./glossary.js');
const { DEFAULT_LANG } = require('./prompt.js');

/**
 * 一個站實際生效的翻譯設定。
 * `translate_model` 是 NULL 時用全域預設（規格 §2）；術語表沒設過時給預設表。
 */
function settingsFor(site, config) {
  return {
    enabled: site.translate_enabled === true,
    targetLang: site.translate_lang || DEFAULT_LANG,
    model: site.translate_model || config.translate.model,
    glossary: site.glossary?.length > 0 ? site.glossary : [...DEFAULT_GLOSSARY],
  };
}

/**
 * @param {{
 *   store: object,
 *   config: object,
 *   logger: object,
 *   fetchImpl?: typeof fetch,
 *   client?: object 測試注入的假 ollama
 * }} context
 */
function createTranslationService({ store, config, logger, fetchImpl, client }) {
  const settings = config.translate ?? {};

  const ollama =
    client ??
    createOllamaClient({
      baseUrl: settings.ollamaUrl,
      model: settings.model,
      keepAlive: settings.keepAlive,
      timeoutMs: settings.timeoutMs,
      batchSize: settings.batchSize,
      fetchImpl,
    });

  const queue = createTranslationQueue({
    store,
    client: ollama,
    logger,
    batchSize: settings.batchSize ?? 20,
  });

  /**
   * 請求路徑。**同步**、只查 SQLite、絕不等 ollama。
   *
   * 任何一步出錯都回原本那份 HTML —— 翻譯是加值功能，不准讓頁面開不起來。
   *
   * @param {string} html latin1 管線字串（代理的 HTML 改寫全程在 latin1 上）
   * @param {{ site: object, contentType: string|null }} input
   * @returns {string} 回填後的 latin1 字串
   */
  function translateHtml(html, { site, contentType }) {
    const active = settingsFor(site, config);
    if (!active.enabled) return html;

    // ⛔ 只有明確宣告 UTF-8 的文件才翻（charset.js 有完整理由）
    if (!isUtf8Document(html, contentType)) {
      logger.debug?.(`${site.id}：沒宣告 UTF-8，跳過翻譯`);
      return html;
    }

    try {
      const items = collectSegments(html, { glossary: active.glossary, decode: fromLatin1 });
      if (items.length === 0) return html;

      const texts = uniqueTexts(items);
      const { resolve, misses } = resolveTexts(store, {
        texts,
        targetLang: active.targetLang,
        model: active.model,
      });

      if (misses.length > 0) {
        store.translateQueue.enqueue({
          texts: misses,
          targetLang: active.targetLang,
          model: active.model,
          siteId: site.id,
        });
        // 射後不理：背景翻完之後「下次載入就是中文」（規格 §5）
        queue.kick();
      }

      return renderTranslated(html, items, resolve, { encode: toLatin1 }).html;
    } catch (error) {
      logger.error(`翻譯 ${site.id} 的 HTML 時出錯，已退回原文`, error);
      return html;
    }
  }

  /** 控制台的「翻譯」分頁狀態（規格 §7） */
  async function status() {
    const health = await ollama.ping();

    return {
      ollama: { ...health, url: ollama.baseUrl ?? settings.ollamaUrl, model: ollama.model },
      queue: store.translateQueue.stats(),
      cache: store.translations.count(),
      defaults: {
        model: settings.model,
        lang: DEFAULT_LANG,
        batchSize: settings.batchSize,
        glossary: [...DEFAULT_GLOSSARY],
      },
    };
  }

  return { translateHtml, status, queue, client: ollama, settingsFor: (site) => settingsFor(site, config) };
}

module.exports = { createTranslationService, settingsFor };
