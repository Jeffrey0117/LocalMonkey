'use strict';

/**
 * 背景翻譯佇列（規格 §4 / §5）。
 *
 * **序列化**：ollama 本來就不併行（一顆模型、一張顯卡），所以同時只有一條
 * 在跑。`kick()` 是射後不理（代理的請求路徑在呼叫它，不准 await、不准丟錯），
 * `drain()` 回 promise 給爬蟲與測試用。
 *
 * 失敗處理照規格 §4：**整批丟棄、退回原文、attempts += 1**。
 * `attempts >= MAX_ATTEMPTS` 的段不再重試 —— 標記成翻不動，UI 顯示出來
 * 讓人工處理，不要無限重試一直燒 CPU。
 */

const MAX_ATTEMPTS = 3;

/**
 * @param {{
 *   store: object,
 *   client: { translateBatch: Function, model: string },
 *   logger: object,
 *   batchSize?: number,
 *   maxAttempts?: number,
 * }} context
 */
function createTranslationQueue({ store, client, logger, batchSize = 20, maxAttempts = MAX_ATTEMPTS }) {
  let running = null;
  let stopped = false;

  /** 一批：claim → 翻 → 寫快取 / 記失敗 */
  async function runBatch(rows) {
    const texts = rows.map((row) => row.source_text);

    try {
      const translated = await client.translateBatch(texts, {
        targetLang: rows[0].target_lang,
        glossary: rows[0].glossary ?? [],
      });

      // 寫入前再經過一次「manual 不准被覆蓋」的 SQL（db/translations.js）
      for (const [index, row] of rows.entries()) {
        store.translations.put({
          hash: row.hash,
          source_text: row.source_text,
          target_lang: row.target_lang,
          model: row.model,
          translated: translated[index],
          origin: 'machine',
        });
      }

      store.translateQueue.clear(rows.map((row) => row.hash));
      return { translated: rows.length, failed: 0 };
    } catch (error) {
      // 對齊失敗與連不上都走這裡：一個字都不寫進快取，整批留在佇列
      store.translateQueue.recordFailure(rows, error?.message ?? error);
      logger.warn(`翻譯失敗（${rows.length} 段退回原文）：${error?.message ?? error}`);
      return { translated: 0, failed: rows.length };
    }
  }

  async function loop() {
    const totals = { batches: 0, translated: 0, failed: 0 };

    while (!stopped) {
      const rows = store.translateQueue.claim({ limit: batchSize, maxAttempts });
      if (rows.length === 0) break;

      const result = await runBatch(rows);

      totals.batches += 1;
      totals.translated += result.translated;
      totals.failed += result.failed;

      // 整批失敗又沒有別的段可做時直接收手：這一輪已經把額度用掉了，
      // 繼續跑只會對著同一批失敗的段打轉（attempts 很快就滿，但中間會空轉）
      if (result.failed > 0 && result.failed === rows.length) {
        const next = store.translateQueue.claim({ limit: batchSize, maxAttempts });
        if (next.length === 0 || next[0].hash === rows[0].hash) break;
      }
    }

    return totals;
  }

  /**
   * 把佇列跑到空（或跑到所有剩下的都沒有重試額度）。
   * 同時呼叫兩次只會有一條在跑 —— 第二個拿到同一個 promise。
   */
  function drain() {
    if (running) return running;

    running = loop()
      .catch((error) => {
        // loop 自己已經把每一批的錯誤接掉了，走到這裡是程式有 bug
        logger.error('翻譯佇列掛了', error);
        return { batches: 0, translated: 0, failed: 0 };
      })
      .finally(() => {
        running = null;
      });

    return running;
  }

  /** 射後不理。代理的請求路徑在呼叫這支，**絕對不能丟錯、不能慢**。 */
  function kick() {
    drain().catch(() => {});
  }

  /** 等目前這一輪跑完（測試與關機用）。沒在跑就立刻 resolve。 */
  function idle() {
    return running ?? Promise.resolve({ batches: 0, translated: 0, failed: 0 });
  }

  function stop() {
    stopped = true;
  }

  return { drain, kick, idle, stop, isRunning: () => running !== null, maxAttempts };
}

module.exports = { createTranslationQueue, MAX_ATTEMPTS };
